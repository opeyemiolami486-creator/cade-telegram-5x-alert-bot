import 'dotenv/config';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const POLL_SECONDS = Math.max(1, Number(process.env.POLL_SECONDS || 60));
const MIN_MULTIPLE = Math.max(1, Number(process.env.MIN_MULTIPLE || 5));
const CADE_HOME = process.env.CADE_HOME || 'https://cade.market/';
const FEE = Number(process.env.CADE_FEE || 0.03);
const MAX_MARKETS = Math.max(1, Number(process.env.MAX_MARKETS || 30));
const ALERT_STAKE = Math.max(0.01, Number(process.env.ALERT_STAKE || 100));
const MIN_SECONDS_LEFT = Math.max(0, Number(process.env.MIN_SECONDS_LEFT || 30));
const ARBITRAGE_STAKE = Math.max(0.01, Number(process.env.ARBITRAGE_STAKE || 100));
const ARBITRAGE_MIN_MULTIPLE = Math.max(1, Number(process.env.ARBITRAGE_MIN_MULTIPLE || 2));
const TRUSTED_MIN_PROFIT = 0.30;
const TRUSTED_MIN_PROBABILITY = 0.70;
const TRUSTED_MIN_SECONDS_LEFT = 30;
const SUBMIT_PREDICTIONS = String(process.env.SUBMIT_PREDICTIONS || 'true').toLowerCase() !== 'false';
const BUILD_VERSION = 'live-credit-predictions-v2';
const BROWSER_HEADLESS = String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true';
const MANUAL_LOGIN_TIMEOUT_MS = Math.max(60_000, Number(process.env.MANUAL_LOGIN_TIMEOUT_MS || 10 * 60 * 1000));

if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const state = { offset: 0, subscribers: new Set(ALLOWED_CHAT_IDS), thresholds: new Map(), arbitrage: new Set(), trusted: new Set(), amounts: new Map(), sent: new Map(), calls: new Map(), markets: [], lastScan: null, tradeSessions: new Map() };
const money = n => Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const paperAmount = (chatId, symbol) => state.amounts.get(`${chatId}|${String(symbol).toUpperCase()}`) || state.amounts.get(`${chatId}|*`) || ALERT_STAKE;
const authDialog = page => page.getByRole('dialog');
const visibleOtpField = page => page.locator('input[name="one-time-code"]:visible, input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[type="tel"]:visible').first();
const timeLeft = iso => {
  const seconds = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds <= 0) return 'CLOSED';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s` : `${m}m ${String(s).padStart(2, '0')}s`;
};

function parseAmount(raw) {
  const m = String(raw || '').replace(/[$,\s]/g, '').toUpperCase().match(/^(-?[\d.]+)([KMB])?$/);
  if (!m) return NaN;
  return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
}

function poolFromText(text, label) {
  const m = text.match(new RegExp(label + '[\\s\\n]*\\$?([\\d,.]+\\s*[KMB]?)', 'i'));
  return m ? parseAmount(m[1]) : NaN;
}

function estimate(market, side, stake) {
  const selected = side === 'higher' ? market.higher : market.lower;
  const other = side === 'higher' ? market.lower : market.higher;
  if (!(stake > 0) || !Number.isFinite(selected) || !Number.isFinite(other) || selected + other <= 0) return null;
  const totalReturn = (selected + other + stake) * (1 - FEE) * stake / (selected + stake);
  return { totalReturn, profit: totalReturn - stake, probability: selected / (selected + other), multiple: totalReturn / stake };
}

function hedgeEstimate(market, capital = ARBITRAGE_STAKE) {
  if (!(capital > 0) || !(market.higher >= 0) || !(market.lower >= 0) || market.higher + market.lower <= 0) return null;
  const totalPool = market.higher + market.lower + capital;
  const payout = (selectedStake, selectedPool) => totalPool * (1 - FEE) * selectedStake / (selectedPool + selectedStake);
  let low = 0;
  let high = capital;
  for (let i = 0; i < 60; i += 1) {
    const higherStake = (low + high) / 2;
    if (payout(higherStake, market.higher) < payout(capital - higherStake, market.lower)) low = higherStake;
    else high = higherStake;
  }
  const higherStake = (low + high) / 2;
  const lowerStake = capital - higherStake;
  const higherPayout = payout(higherStake, market.higher);
  const lowerPayout = payout(lowerStake, market.lower);
  const guaranteedReturn = Math.min(higherPayout, lowerPayout);
  return { higherStake, lowerStake, higherPayout, lowerPayout, guaranteedReturn, guaranteedProfit: guaranteedReturn - capital, multiple: guaranteedReturn / capital };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'cade-telegram-readonly/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function discoverMarkets() {
  const html = await fetchText(CADE_HOME);
  const $ = cheerio.load(html);
  const mints = new Set();
  $('a[href*="/meme-madness/market/"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const url = new URL(href, CADE_HOME).href;
    const match = url.match(/\/market\/([^/?#]+)/);
    if (match) mints.add(match[1]);
  });
  return [...mints];
}

async function readMarketsForMint(tokenMint, includeResolved = false) {
  const data = await fetchText(`${CADE_HOME}api/meme-madness/markets?token_mint=${encodeURIComponent(tokenMint)}`);
  const json = JSON.parse(data);
  const markets = Array.isArray(json.markets) ? json.markets : [];
  return markets.filter(m => m.status === 'open' || m.phase === 'continuous' || (includeResolved && m.status === 'resolved' && m.settlement_state === 'settled')).map(m => {
    const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
    const higherRaw = outcomes.find(o => o.index === 0)?.net_stake_raw;
    const lowerRaw = outcomes.find(o => o.index === 1)?.net_stake_raw;
    const symbol = m.resolution_config?.tokenSymbol || tokenMint.slice(0, 6);
    return {
      id: m.id,
      url: `${CADE_HOME}meme-madness/market/${tokenMint}`,
      symbol,
      higher: Number(higherRaw) / 1e6,
      lower: Number(lowerRaw) / 1e6,
      cutoff: m.order_cutoff_at || '',
      close: m.close_at || '',
      status: m.status || m.phase || '',
      winningOutcomeIndex: Number.isInteger(m.winning_outcome_index) ? m.winning_outcome_index : null,
      updatedAt: Date.now()
    };
  });
}

async function scan() {
  const urls = await discoverMarkets();
  const results = [];
  for (const tokenMint of urls) {
    try {
      const markets = await readMarketsForMint(tokenMint, true);
      for (const market of markets) {
        if (market.status === 'resolved') updateResolvedCalls(market);
        if ((market.status === 'open' || market.status === 'continuous') && Number.isFinite(market.higher) && Number.isFinite(market.lower)) results.push(market);
      }
    } catch (e) { console.error('market read failed', tokenMint, e.message); }
  }
  state.markets = results;
  state.lastScan = Date.now();
  return results;
}

function updateResolvedCalls(market) {
  if (!Number.isInteger(market.winningOutcomeIndex)) return;
  for (const call of state.calls.values()) {
    if (call.marketId !== market.id || call.status !== 'pending') continue;
    call.status = call.sideIndex === market.winningOutcomeIndex ? 'won' : 'lost';
    call.resolvedAt = Date.now();
  }
}

function marketLine(m, stake = 100) {
  const h = estimate(m, 'higher', stake);
  const l = estimate(m, 'lower', stake);
  return `• <a href="${esc(m.url)}">$${esc(m.symbol)}</a> — H ${pct(h?.probability)} → ${money(h?.totalReturn)} | L ${pct(l?.probability)} → ${money(l?.totalReturn)} | <b>time left: ${timeLeft(m.cutoff)}</b>`;
}

function alertText(m, side, result, stake = 100, threshold = MIN_MULTIPLE) {
  return `🚨 <b>CADE ${threshold}×+ OPPORTUNITY</b>\n\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — <b>${side.toUpperCase()}</b>\nStake: ${money(stake)}\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nCurrent implied chance: ${pct(result.probability)}\nTime left to place prediction: <b>${timeLeft(m.cutoff)}</b>\nPool: Higher ${money(m.higher)} / Lower ${money(m.lower)}\n\nRead-only estimate; no trade was placed.`;
}

function arbitrageText(m, hedge) {
  return `⚖️ <b>CADE HEDGE OPPORTUNITY</b>\n\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a>\nCombined paper stake: <b>${money(ARBITRAGE_STAKE)}</b>\nHigher stake: ${money(hedge.higherStake)} → payout ${money(hedge.higherPayout)}\nLower stake: ${money(hedge.lowerStake)} → payout ${money(hedge.lowerPayout)}\nModeled minimum payout: <b>${money(hedge.guaranteedReturn)}</b>\nModeled minimum multiple: <b>${hedge.multiple.toFixed(2)}×</b>\nTime left to place prediction: <b>${timeLeft(m.cutoff)}</b>\n\nRead-only hedge estimate; no trades were placed. Actual pools, fees, limits, timing, and account eligibility can change the result.`;
}

function trustedText(m, side, result, stake) {
  return `⭐ <b>TRUSTED-STYLE SIGNAL</b>\n\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — <b>${side.toUpperCase()}</b>\nMaximum configured paper amount: <b>${money(stake)}</b>\nCurrent implied chance: <b>${pct(result.probability)}</b>\nModeled total return: <b>${money(result.totalReturn)}</b>\nModeled profit: <b>${money(result.profit)}</b> (<b>${(result.profit / stake * 100).toFixed(1)}%</b>)\nTime left to order cutoff: <b>${timeLeft(m.cutoff)}</b>\n\nThis is a read-only filter, not a guarantee or financial advice. No trade was placed.`;
}

function resultText(chatId, filter) {
  const allCalls = [...state.calls.values()].filter(call => call.chatIds.has(String(chatId))).sort((a, b) => b.alertedAt - a.alertedAt);
  const calls = filter === 'wins10m'
    ? allCalls.filter(call => call.status === 'won' && Date.now() - call.resolvedAt <= 10 * 60 * 1000)
    : allCalls;
  const won = calls.filter(call => call.status === 'won');
  if (!calls.length) {
    return send(chatId, filter === 'wins10m'
      ? 'No winning alert calls were verified in the last 10 minutes.'
      : 'No alert calls have been recorded for this chat yet. Calls are recorded only while the bot is running, and are verified after Cade settles the market.');
  }
  const lines = calls.slice(0, 20).map(call => {
    const status = call.status === 'won' ? '✅ WON' : call.status === 'lost' ? '❌ LOST' : '⏳ PENDING';
    return `${status} <a href="${esc(call.url)}">$${esc(call.symbol)}</a> — ${call.side.toUpperCase()} — alert ${call.multiple.toFixed(2)}× — ${new Date(call.alertedAt).toLocaleString()}`;
  });
  return send(chatId, `<b>${filter === 'wins10m' ? 'Winning calls from the last 10 minutes' : 'Verified alert results'}</b>\n\nSuccessful settled calls: <b>${won.length}</b>\nTracked calls: <b>${calls.length}</b>\n\n${lines.join('\n')}\n\nThese are paper-call results based on the alert stake. The bot does not confirm that you placed a trade or received a payout.`);
}

async function telegram(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function send(chatId, text) {
  await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

function paperTradeText(m, side, result, stake, tradeId) {
  return `✅ <b>PAPER TRADE SUBMITTED</b>\n\nTrade: <code>${esc(tradeId)}</code>\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — <b>${side.toUpperCase()}</b>\nStake: <b>${money(stake)}</b>\nModeled total return: <b>${money(result.totalReturn)}</b>\nModeled profit: <b>${money(result.profit)}</b>\nCurrent implied chance: ${pct(result.probability)}\nTime left to cutoff: <b>${timeLeft(m.cutoff)}</b>\n\nThis is an in-memory paper trade for testing only. No wallet, broker, or live order was used. Use /result to check it after the market settles.`;
}

async function submitPredictionInBrowser(session) {
  const { page, side, stake, market } = session;
  await page.goto(market.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const amount = page.locator('#market-rail-ticket-amount');
  await amount.waitFor({ state: 'visible', timeout: 15000 });
  await amount.fill(String(stake));
  const sideButton = page.getByRole('button', { name: new RegExp(`(?:predict\\s+)?${side}`, 'i') }).last();
  await sideButton.waitFor({ state: 'visible', timeout: 15000 });
  await sideButton.click({ timeout: 10000 });

  // Credits-mode may show a confirmation dialog after the side is selected.
  const confirm = page.getByRole('button', { name: /^(confirm|submit prediction|place prediction|confirm prediction)$/i }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 10000 });

  await page.waitForTimeout(750);
  const body = await page.locator('body').innerText().catch(() => '');
  const confirmedPosition = await page.locator('[data-testid="market-position-confirmed"]').isVisible().catch(() => false);
  const success = /prediction (?:submitted|placed|confirmed)|successfully (?:predicted|submitted)|predicted\s+\$?[\d,.]+\s+(?:higher|lower)|position (?:created|opened)/i.test(body)
    || confirmedPosition
    || (await amount.inputValue().catch(() => String(stake))) === '0';
  if (!success) {
    const status = body.match(/[^\n]*(?:error|failed|unable|insufficient|prediction|position)[^\n]*/gi)?.slice(-8).join(' | ') || 'no success status was shown';
    throw new Error(`Cade did not confirm the prediction submission: ${status.slice(0, 900)}`);
  }
}

async function submitPaperTrade(chatId, symbol, side, stake) {
  if (!['higher', 'lower'].includes(side) || !(stake > 0) || !Number.isFinite(stake)) return send(chatId, 'Usage: <code>/trade JOHN higher 100</code>');
  const markets = state.markets.length ? state.markets : await scan();
  const market = markets.find(m => m.symbol.toLowerCase() === String(symbol || '').toLowerCase());
  if (!market) return send(chatId, `I cannot find an open market for <b>${esc(symbol || '')}</b>. Send /markets first and use the exact token symbol.`);
  const secondsLeft = (new Date(market.cutoff).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return send(chatId, `The <b>$${esc(market.symbol)}</b> market is already closed for new predictions.`);
  const result = estimate(market, side, stake);
  if (!result) return send(chatId, 'The market pools are not readable right now; no paper trade was submitted.');
  const tradeId = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  state.calls.set(tradeId, {
    key: tradeId,
    tradeId,
    marketId: market.id,
    symbol: market.symbol,
    url: market.url,
    side,
    sideIndex: side === 'higher' ? 0 : 1,
    stake,
    multiple: result.multiple,
    totalReturn: result.totalReturn,
    profit: result.profit,
    probability: result.probability,
    alertedAt: Date.now(),
    chatIds: new Set([String(chatId)]),
    status: 'pending',
    paper: true
  });
  return send(chatId, paperTradeText(market, side, result, stake, tradeId));
}

async function beginTradePreview(chatId, symbol, side, stake) {
  if (!state.markets.length) await scan();
  const market = state.markets.find(m => m.symbol.toLowerCase() === symbol.toLowerCase());
  if (!market) return send(chatId, `I cannot find an open market for <b>${esc(symbol)}</b>. Send /markets first and use the exact token symbol.`);
  if (!['higher', 'lower'].includes(side) || !(stake > 0)) return send(chatId, 'Usage: <code>/trade JOHN higher 100</code>');
  if (state.tradeSessions.has(String(chatId))) await endTradeSession(chatId);
  await send(chatId, `Starting a visible Cade browser for <b>$${esc(market.symbol)} ${side.toUpperCase()}</b>…`);
  let browser;
  try {
    browser = await Promise.race([
      chromium.launch({
        headless: BROWSER_HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chromium launch timed out after 20 seconds; check Railway Playwright installation logs.')), 20000))
    ]);
    await send(chatId, BROWSER_HEADLESS ? 'Headless Chromium started. Loading Cade login…' : 'Chromium opened on your laptop. Complete Cade login manually in that window; do not send your email or OTP in Telegram.');
    const context = await browser.newContext();
    const page = await context.newPage();
    state.tradeSessions.set(String(chatId), { browser, context, page, market, side, stake, createdAt: Date.now(), step: 'manual-login' });
    await page.goto(`${CADE_HOME}login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await send(chatId, `Cade login page is open on the laptop. Log in manually in Chromium, then leave the browser open. I will continue automatically after login (up to ${Math.round(MANUAL_LOGIN_TIMEOUT_MS / 60000)} minutes).`);
    void waitForManualLogin(chatId);
    return;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    state.tradeSessions.delete(String(chatId));
    throw error;
  }
}

async function waitForManualLogin(chatId) {
  const session = state.tradeSessions.get(String(chatId));
  if (!session || session.step !== 'manual-login') return;
  const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (session.page.isClosed()) throw new Error('The Chromium window was closed before Cade login completed.');
      const dialog = session.page.locator('[role="dialog"]');
      const dialogText = await dialog.innerText().catch(() => '');
      const loginUiVisible = await dialog.isVisible().catch(() => false) && /sign in|email|verification|one-time|google/i.test(dialogText);
      if (!loginUiVisible) break;
      await session.page.waitForTimeout(1000);
    }
    if (Date.now() >= deadline) {
      await send(chatId, 'Manual Cade login timed out. Use /cancel and /trade again. No trade was submitted.');
      return endTradeSession(chatId);
    }
    await session.page.goto(session.market.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const result = estimate(session.market, session.side, session.stake);
    session.step = 'preview';
    if (!result) return send(chatId, 'Login completed, but the market data is no longer available. The preview was not submitted.');
    return send(chatId, `<b>TRADE PREVIEW — NOT SUBMITTED</b>\n\nToken: <b>$${esc(session.market.symbol)}</b>\nSide: <b>${session.side.toUpperCase()}</b>\nStake: <b>${money(session.stake)}</b>\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nTime left: <b>${timeLeft(session.market.cutoff)}</b>\n\nManual Cade login completed. The market page is open in the visible Chromium window. This bot will not click final trade or wallet-signing controls.\n\nUse /cancel to close the session.`);
  } catch (error) {
    console.error('manual login error', error);
    await send(chatId, `Manual login could not continue: <code>${esc(error.message || 'unknown error')}</code>`).catch(() => {});
    return endTradeSession(chatId);
  }
}

async function submitEmail(chatId, email) {
  const session = state.tradeSessions.get(String(chatId));
  if (!session || session.step !== 'email') return send(chatId, 'Start with <code>/trade SYMBOL higher 100</code>.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(chatId, 'That email format is not valid. Try <code>/email you@example.com</code>.');
  await send(chatId, 'Submitting the email to Cade/Privy and waiting for the login response…');
  const emailField = session.page.locator('[role="dialog"] input[autocomplete="email"]:visible, [role="dialog"] input[type="email"]:visible').last();
  await emailField.waitFor({ state: 'visible', timeout: 10000 });
  await emailField.fill(email);
  const submitButton = session.page.locator('[role="dialog"] button').filter({ hasText: /EMAIL ME A CODE|CONTINUE|SEND CODE/i }).last();
  await submitButton.waitFor({ state: 'visible', timeout: 10000 });
  await submitButton.click({ timeout: 10000 });
  const otpField = visibleOtpField(session.page);
  await Promise.race([
    otpField.waitFor({ state: 'visible', timeout: 15000 }),
    session.page.getByText(/CHECK YOUR EMAIL|VERIFICATION CODE/i).last().waitFor({ state: 'visible', timeout: 30000 })
  ]).catch(() => {});
  const visibleText = await session.page.locator('body').innerText();
  if (/captcha|verify you are human|robot|turnstile|recaptcha/i.test(visibleText)) {
    return send(chatId, 'Cade/Privy is requiring a CAPTCHA in the headless browser, so the OTP was not confirmed as sent. This cannot be safely bypassed. Use a manual Cade login/browser handoff, or try again later if the CAPTCHA is not shown.');
  }
  if (/invalid email|error|failed|try again|unable/i.test(visibleText) && !/check your email|enter.*code|verification code/i.test(visibleText)) {
    return send(chatId, 'Cade/Privy returned a login error and no OTP screen appeared. Check the email address and Railway logs, then try /cancel followed by /trade again.');
  }
  const codeVisible = await otpField.isVisible().catch(() => false);
  if (!codeVisible && !/check your email|enter.*code|verification code|code sent/i.test(visibleText)) {
    const authState = visibleText.match(/(?:SIGN IN|SIGN IN WITH EMAIL|EMAIL ADDRESS|EMAIL ME A CODE|CHECK YOUR EMAIL|VERIFICATION CODE|INVALID EMAIL|ERROR|FAILED|CAPTCHA|VERIFY YOU ARE HUMAN)[^\n]*/gi)?.slice(-6).join(' | ') || 'no recognizable Privy status text';
    return send(chatId, `Cade did not show its OTP entry screen after 30 seconds (build ${BUILD_VERSION}). Privy state: <code>${esc(authState.slice(0, 700))}</code>\n\nUse /cancel and /trade again. If this repeats, send me the Privy state above.`);
  }
  session.step = 'otp';
  return send(chatId, 'OTP requested. Send it with <code>/otp 123456</code>. Do not send your password, wallet seed phrase, or private key.');
}

async function resendOtp(chatId) {
  const session = state.tradeSessions.get(String(chatId));
  if (!session || session.step !== 'otp') return send(chatId, 'No active OTP screen. Start with /trade, then /email.');
  const resend = session.page.getByRole('button', { name: /RESEND|SEND AGAIN/i }).first();
  if (!(await resend.isVisible().catch(() => false))) return send(chatId, 'Cade has not enabled resend yet. Wait a few seconds, then try /resend again.');
  await resend.click({ timeout: 10000 });
  return send(chatId, 'Resend requested from Cade/Privy. Check inbox and spam/junk folders for the new code.');
}

async function submitOtp(chatId, otp) {
  const session = state.tradeSessions.get(String(chatId));
  if (!session || session.step !== 'otp') return send(chatId, 'No login session is waiting for an OTP. Start with /trade.');
  if (!/^\d{4,8}$/.test(otp)) return send(chatId, 'OTP should contain only 4–8 digits.');
  const field = visibleOtpField(session.page);
  await field.waitFor({ state: 'visible', timeout: 10000 });
  await field.fill(otp);
  await field.press('Enter').catch(() => {});
  await session.page.waitForTimeout(1000);
  await session.page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]')];
    return !fields.some(field => {
      const style = getComputedStyle(field);
      return style.display !== 'none' && style.visibility !== 'hidden' && field.getClientRects().length > 0;
    });
  }, { timeout: 15000 }).catch(() => {});
  const loginText = await session.page.locator('body').innerText().catch(() => '');
  if (/invalid|incorrect|expired|try again/i.test(loginText) && await field.isVisible().catch(() => false)) {
    return send(chatId, 'Cade rejected that OTP. Check the latest code in your inbox and try <code>/otp 123456</code> again, or use /resend.');
  }
  await session.page.goto(session.market.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const result = estimate(session.market, session.side, session.stake);
  session.step = 'preview';
  if (!result) return send(chatId, 'Login completed, but the market data is no longer available. The preview was not submitted.');
  if (!SUBMIT_PREDICTIONS) return send(chatId, `<b>TRADE PREVIEW — NOT SUBMITTED</b>\n\nToken: <b>$${esc(session.market.symbol)}</b>\nSide: <b>${session.side.toUpperCase()}</b>\nStake: <b>${money(session.stake)}</b>\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nTime left: <b>${timeLeft(session.market.cutoff)}</b>\n\nSubmission is disabled because <code>SUBMIT_PREDICTIONS=false</code>.`);
  try {
    await submitPredictionInBrowser(session);
    const tradeId = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    state.calls.set(tradeId, { key: tradeId, tradeId, marketId: session.market.id, symbol: session.market.symbol, url: session.market.url, side: session.side, sideIndex: session.side === 'higher' ? 0 : 1, stake: session.stake, multiple: result.multiple, totalReturn: result.totalReturn, profit: result.profit, probability: result.probability, alertedAt: Date.now(), chatIds: new Set([String(chatId)]), status: 'pending', paper: true, submitted: true });
    session.step = 'submitted';
    return send(chatId, `<b>PREDICTION SUBMITTED</b>\n\nTrade: <code>${esc(tradeId)}</code>\nToken: <b>$${esc(session.market.symbol)}</b>\nSide: <b>${session.side.toUpperCase()}</b>\nStake: <b>${money(session.stake)}</b>\nModeled total return: <b>${money(result.totalReturn)}</b>\nModeled profit: <b>${money(result.profit)}</b>\n\nCade confirmed the paper prediction in the authenticated browser session. Use /result after settlement.`);
  } catch (error) {
    console.error('prediction submission failed', error);
    return send(chatId, `Login succeeded, but Cade did not confirm the prediction. No result was recorded.\n\n<code>${esc(error.message)}</code>\n\nUse /cancel and try /trade again while the market is still open.`);
  }
}

async function endTradeSession(chatId) {
  const session = state.tradeSessions.get(String(chatId));
  if (!session) return;
  state.tradeSessions.delete(String(chatId));
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

function authorized(chatId) {
  return ALLOWED_CHAT_IDS.size === 0 || ALLOWED_CHAT_IDS.has(String(chatId));
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId || !authorized(chatId)) return;
  const input = (message.text || '').trim();
  if (!input) return;
  const [rawCommand, a, b] = input.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command === '/start') return send(chatId, '<b>Cade market monitor</b>\n\nCommands:\n/markets — current markets and estimates\n/estimate higher 100 — estimate a $100 HIGHER prediction\n/estimate lower 100 — estimate a $100 LOWER prediction\n/opportunity 2x — alert this chat at 2×+ estimated return\n/trusted on — higher-probability side with ≥70% chance, ≥30% modeled profit, and ≥30s to cutoff\n/amount JOHN 250 — use $250 paper amount for JOHN\n/arbitrage on — enable two-sided hedge alerts\n/status — scanner status\n/result — verified results for alert calls\n/alerts — enable automatic alerts\n/stop — disable automatic alerts');
  if (command === '/trade') return beginTradePreview(chatId, String(a || '').toUpperCase(), String(b || '').toLowerCase(), Number(input.split(/\s+/)[3]));
  if (command === '/email') return send(chatId, 'Enter your Cade email directly in the visible Chromium window, not in Telegram.');
  if (command === '/resend') return resendOtp(chatId);
  if (command === '/otp') return send(chatId, 'Enter the Cade OTP directly in the visible Chromium window, not in Telegram.');
  if (command === '/cancel') { await endTradeSession(chatId); return send(chatId, 'Visible Cade browser session closed. No trade was submitted.'); }
  if (command === '/opportunity') {
    const raw = String(a || '').toLowerCase().replace(/×/g, 'x');
    const match = raw.match(/^(\d+(?:\.\d+)?)x?$/);
    const threshold = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 1000) return send(chatId, 'Usage: <code>/opportunity 2x</code> (choose a multiple from 1x to 1000x).');
    state.thresholds.set(String(chatId), threshold);
    state.subscribers.add(String(chatId));
    return send(chatId, `Opportunity filter set to <b>${threshold}×+</b>. Automatic alerts enabled for this chat.`);
  }
  if (command === '/arbitrage') {
    const mode = String(a || '').toLowerCase();
    if (mode === 'on') { state.arbitrage.add(String(chatId)); return send(chatId, `Two-sided hedge alerts enabled. I will alert only when a modeled ${money(ARBITRAGE_STAKE)} combined split produces at least ${ARBITRAGE_MIN_MULTIPLE}× minimum payout in either outcome.`); }
    if (mode === 'off') { state.arbitrage.delete(String(chatId)); return send(chatId, 'Two-sided hedge alerts disabled for this chat.'); }
    return send(chatId, `Two-sided hedge alerts are <b>${state.arbitrage.has(String(chatId)) ? 'ON' : 'OFF'}</b>. Use <code>/arbitrage on</code> or <code>/arbitrage off</code>.`);
  }
  if (command === '/trusted') {
    const mode = String(a || '').toLowerCase();
    if (mode === 'on') { state.trusted.add(String(chatId)); state.subscribers.add(String(chatId)); return send(chatId, 'Trusted-style signals enabled. I will choose the higher-implied-probability side only when chance is at least 70%, modeled profit is at least 30%, and at least 30 seconds remain before the order cutoff.'); }
    if (mode === 'off') { state.trusted.delete(String(chatId)); return send(chatId, 'Trusted-style signals disabled for this chat.'); }
    return send(chatId, `Trusted-style signals are <b>${state.trusted.has(String(chatId)) ? 'ON' : 'OFF'}</b>. Use <code>/trusted on</code> or <code>/trusted off</code>.`);
  }
  if (command === '/amount') {
    const symbol = String(a || '').toUpperCase();
    const amount = Number(b);
    if (b == null && Number.isFinite(Number(a))) {
      if (Number(a) <= 0 || Number(a) > 1_000_000) return send(chatId, 'Amount must be between $0.01 and $1,000,000. Example: <code>/amount 1500</code>.');
      state.amounts.set(`${chatId}|*`, Number(a));
      return send(chatId, `Default paper amount for <b>all tokens</b> set to <b>${money(Number(a))}</b>. A token-specific amount can override it with <code>/amount JOHN 250</code>.`);
    }
    if (!symbol) return send(chatId, 'Usage: <code>/amount JOHN 250</code>. This sets the paper amount used for JOHN signals.');
    if (b == null) {
      const saved = state.amounts.get(`${chatId}|${symbol}`);
      return send(chatId, saved ? `Paper amount for <b>$${esc(symbol)}</b>: <b>${money(saved)}</b>.` : `No custom amount is set for <b>$${esc(symbol)}</b>; using ${money(ALERT_STAKE)}.`);
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return send(chatId, 'Amount must be between $0.01 and $1,000,000. Example: <code>/amount JOHN 250</code>.');
    state.amounts.set(`${chatId}|${symbol}`, amount);
    return send(chatId, `Paper amount for <b>$${esc(symbol)}</b> set to <b>${money(amount)}</b>. Trusted signals will use this amount.`);
  }
  if (command === '/alerts') { state.subscribers.add(String(chatId)); if (!state.thresholds.has(String(chatId))) state.thresholds.set(String(chatId), MIN_MULTIPLE); return send(chatId, `Automatic alerts enabled at your <b>${state.thresholds.get(String(chatId))}×+</b> opportunity threshold.`); }
  if (command === '/stop') { state.subscribers.delete(String(chatId)); return send(chatId, 'Automatic alerts disabled for this chat. Send /alerts to enable them again.'); }
  if (command === '/status') return send(chatId, `Build: ${BUILD_VERSION}\nScanner: ${state.lastScan ? `last scan ${new Date(state.lastScan).toLocaleTimeString()}` : 'not scanned yet'}\nMarkets read: ${state.markets.length}\nYour opportunity threshold: ${state.thresholds.get(String(chatId)) || MIN_MULTIPLE}×+\nTrusted-style signals: ${state.trusted.has(String(chatId)) ? 'ON (≥70% chance + ≥30% modeled profit + 30s cutoff buffer)' : 'OFF'}\nTwo-sided hedge alerts: ${state.arbitrage.has(String(chatId)) ? 'ON' : 'OFF'}\nDefault hedge minimum: ${ARBITRAGE_MIN_MULTIPLE}×\nFee used: ${(FEE * 100).toFixed(2)}%`);
  if (command === '/result') return resultText(chatId, String(a || '').toLowerCase() === 'wins10m' ? 'wins10m' : undefined);

  if (command === '/markets') {
    const markets = state.markets.length ? state.markets : await scan();
    if (!markets.length) return send(chatId, 'No readable public Cade markets found right now.');
    return send(chatId, `<b>Current Cade markets</b>\nUsing each token's configured paper amount (default ${money(ALERT_STAKE)}):\n\n${markets.map(m => marketLine(m, paperAmount(chatId, m.symbol))).join('\n')}`);
  }

  if (command === '/estimate') {
    const side = String(a || '').toLowerCase();
    const stake = Number(b);
    if (!['higher', 'lower'].includes(side) || !(stake > 0)) return send(chatId, 'Usage: <code>/estimate higher 100</code> or <code>/estimate lower 100</code>');
    const markets = state.markets.length ? state.markets : await scan();
    const lines = markets.map(m => { const r = estimate(m, side, stake); return r ? { m, r } : null; }).filter(Boolean);
    if (!lines.length) return send(chatId, 'No readable public markets are available for that estimate.');
    return send(chatId, `<b>${side.toUpperCase()} estimates for ${money(stake)}</b>\n\n${lines.map(({m,r}) => `<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — return <b>${money(r.totalReturn)}</b>, profit ${money(r.profit)}, implied chance ${pct(r.probability)}, time left <b>${timeLeft(m.cutoff)}</b>`).join('\n')}`);
  }
  return send(chatId, 'Unknown command. Try /markets, /estimate higher 100, /alerts, or /status.');
}

async function pollTelegram() {
  try {
    const updates = await telegram('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) {
      state.offset = update.update_id + 1;
      if (!update.message) continue;
      try { await handleMessage(update.message); }
      catch (e) {
        console.error('message handler error', e);
        if (update.message.chat?.id) await send(update.message.chat.id, `The command failed: <code>${esc(e.message || 'unknown error')}</code>\nCheck Railway logs for details.`).catch(() => {});
      }
    }
  } catch (e) { console.error('telegram polling error', e.message); }
  setImmediate(pollTelegram);
}

async function alertLoop() {
  try {
    const markets = await scan();
    for (const m of markets) {
      for (const side of ['higher', 'lower']) {
        const secondsLeft = (new Date(m.cutoff).getTime() - Date.now()) / 1000;
        if (!Number.isFinite(secondsLeft) || secondsLeft <= MIN_SECONDS_LEFT) continue;
        const recipients = new Map();
        for (const chatId of state.subscribers) {
          const threshold = state.thresholds.get(String(chatId)) || MIN_MULTIPLE;
          const stake = paperAmount(chatId, m.symbol);
          const result = estimate(m, side, stake);
          if (!result) continue;
          if (result.multiple > threshold) {
            const groupKey = `${threshold}|${stake}`;
            if (!recipients.has(groupKey)) recipients.set(groupKey, { threshold, stake, chatIds: new Set() });
            recipients.get(groupKey).chatIds.add(String(chatId));
          }
        }
        for (const { threshold, stake, chatIds } of recipients.values()) {
          const result = estimate(m, side, stake);
          const key = `${m.url}|${side}|${threshold}|${Math.round(stake * 100)}|${Math.round(m.higher)}|${Math.round(m.lower)}`;
          if (state.sent.has(key)) continue;
          state.sent.set(key, Date.now());
          state.calls.set(key, {
            key,
            marketId: m.id,
            symbol: m.symbol,
            url: m.url,
            side,
            sideIndex: side === 'higher' ? 0 : 1,
            stake,
            threshold,
            multiple: result.multiple,
            totalReturn: result.totalReturn,
            profit: result.profit,
            probability: result.probability,
            alertedAt: Date.now(),
            chatIds,
            status: 'pending'
          });
          for (const chatId of chatIds) await send(chatId, alertText(m, side, result, stake, threshold));
        }
      }
      const hedge = hedgeEstimate(m, ARBITRAGE_STAKE);
      if (hedge && hedge.multiple >= ARBITRAGE_MIN_MULTIPLE) {
        for (const chatId of state.arbitrage) {
          const key = `${m.url}|hedge|${chatId}|${Math.round(m.higher)}|${Math.round(m.lower)}`;
          if (state.sent.has(key)) continue;
          state.sent.set(key, Date.now());
          await send(chatId, arbitrageText(m, hedge));
        }
      }
      if (state.trusted.size) {
        const trustedSecondsToCutoff = (new Date(m.cutoff).getTime() - Date.now()) / 1000;
        if (!Number.isFinite(trustedSecondsToCutoff) || trustedSecondsToCutoff < TRUSTED_MIN_SECONDS_LEFT) continue;
        const trustedSide = m.higher >= m.lower ? 'higher' : 'lower';
        for (const chatId of state.trusted) {
          const stake = paperAmount(chatId, m.symbol);
          const trustedResult = estimate(m, trustedSide, stake);
          if (!trustedResult || trustedResult.probability < TRUSTED_MIN_PROBABILITY || trustedResult.profit / stake < TRUSTED_MIN_PROFIT) continue;
          const key = `${m.url}|trusted|${chatId}|${Math.round(stake * 100)}|${Math.round(m.higher)}|${Math.round(m.lower)}`;
          if (state.sent.has(key)) continue;
          state.sent.set(key, Date.now());
          state.calls.set(key, {
            key,
            marketId: m.id,
            symbol: m.symbol,
            url: m.url,
            side: trustedSide,
            sideIndex: trustedSide === 'higher' ? 0 : 1,
            stake,
            threshold: 1 + TRUSTED_MIN_PROFIT,
            multiple: trustedResult.multiple,
            totalReturn: trustedResult.totalReturn,
            profit: trustedResult.profit,
            probability: trustedResult.probability,
            alertedAt: Date.now(),
            chatIds: new Set([String(chatId)]),
            status: 'pending'
          });
          await send(chatId, trustedText(m, trustedSide, trustedResult, stake));
        }
      }
    }
    // Keep memory bounded while retaining enough state to prevent repeat spam.
    for (const [key, time] of state.sent) if (Date.now() - time > 6 * 60 * 60 * 1000) state.sent.delete(key);
    for (const [key, call] of state.calls) if (Date.now() - call.alertedAt > 7 * 24 * 60 * 60 * 1000) state.calls.delete(key);
  } catch (e) { console.error('scan error', e.message); }
  setTimeout(alertLoop, POLL_SECONDS * 1000);
}

await telegram('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
console.log(`Cade Telegram monitor started; polling every ${POLL_SECONDS}s; threshold ${MIN_MULTIPLE}x`);
pollTelegram();
alertLoop();
