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
const BUILD_VERSION = '8f2d1b7-otp-fallback-diagnostics';

if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const state = { offset: 0, subscribers: new Set(ALLOWED_CHAT_IDS), sent: new Map(), markets: [], lastScan: null, tradeSessions: new Map() };
const money = n => Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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

async function readMarketsForMint(tokenMint) {
  const data = await fetchText(`${CADE_HOME}api/meme-madness/markets?token_mint=${encodeURIComponent(tokenMint)}`);
  const json = JSON.parse(data);
  const markets = Array.isArray(json.markets) ? json.markets : [];
  return markets.filter(m => m.status === 'open' || m.phase === 'continuous').map(m => {
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
      updatedAt: Date.now()
    };
  });
}

async function scan() {
  const urls = await discoverMarkets();
  const results = [];
  for (const tokenMint of urls) {
    try {
      const markets = await readMarketsForMint(tokenMint);
      for (const market of markets) {
        if (Number.isFinite(market.higher) && Number.isFinite(market.lower)) results.push(market);
      }
    } catch (e) { console.error('market read failed', tokenMint, e.message); }
  }
  state.markets = results;
  state.lastScan = Date.now();
  return results;
}

function marketLine(m, stake = 100) {
  const h = estimate(m, 'higher', stake);
  const l = estimate(m, 'lower', stake);
  return `• <a href="${esc(m.url)}">$${esc(m.symbol)}</a> — H ${pct(h?.probability)} → ${money(h?.totalReturn)} | L ${pct(l?.probability)} → ${money(l?.totalReturn)} | <b>time left: ${timeLeft(m.cutoff)}</b>`;
}

function alertText(m, side, result, stake = 100) {
  return `🚨 <b>CADE ${MIN_MULTIPLE}×+ OPPORTUNITY</b>\n\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — <b>${side.toUpperCase()}</b>\nStake: ${money(stake)}\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nCurrent implied chance: ${pct(result.probability)}\nTime left to place prediction: <b>${timeLeft(m.cutoff)}</b>\nPool: Higher ${money(m.higher)} / Lower ${money(m.lower)}\n\nRead-only estimate; no trade was placed.`;
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

async function beginTradePreview(chatId, symbol, side, stake) {
  if (!state.markets.length) await scan();
  const market = state.markets.find(m => m.symbol.toLowerCase() === symbol.toLowerCase());
  if (!market) return send(chatId, `I cannot find an open market for <b>${esc(symbol)}</b>. Send /markets first and use the exact token symbol.`);
  if (!['higher', 'lower'].includes(side) || !(stake > 0)) return send(chatId, 'Usage: <code>/trade JOHN higher 100</code>');
  if (state.tradeSessions.has(String(chatId))) await endTradeSession(chatId);
  await send(chatId, `Starting a headless Cade browser for <b>$${esc(market.symbol)} ${side.toUpperCase()}</b>…`);
  let browser;
  try {
    browser = await Promise.race([
      chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chromium launch timed out after 20 seconds; check Railway Playwright installation logs.')), 20000))
    ]);
    await send(chatId, 'Headless Chromium started on Railway. Loading Cade login…');
    const context = await browser.newContext();
    const page = await context.newPage();
    state.tradeSessions.set(String(chatId), { browser, context, page, market, side, stake, createdAt: Date.now(), step: 'email' });
    await page.goto(`${CADE_HOME}login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await send(chatId, 'Cade login page loaded. Opening email login…');
    const emailButton = page.getByRole('button', { name: /SIGN IN WITH EMAIL/i });
    try {
      await emailButton.waitFor({ state: 'visible', timeout: 15000 });
    } catch (firstError) {
      console.warn('Cade login modal did not hydrate on first load; retrying once', firstError.message);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await emailButton.waitFor({ state: 'visible', timeout: 15000 });
    }
    await emailButton.click({ timeout: 10000 });
    return send(chatId, `Headless Cade browser ready for <b>$${esc(market.symbol)} ${side.toUpperCase()}</b> with <b>${money(stake)}</b>.\n\nSend your email with:\n<code>/email you@example.com</code>\n\nYour OTP will be used only in this temporary browser session and will not be saved.`);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    state.tradeSessions.delete(String(chatId));
    throw error;
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
  return send(chatId, `<b>TRADE PREVIEW — NOT SUBMITTED</b>\n\nToken: <b>$${esc(session.market.symbol)}</b>\nSide: <b>${session.side.toUpperCase()}</b>\nStake: <b>${money(session.stake)}</b>\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nTime left: <b>${timeLeft(session.market.cutoff)}</b>\n\nThe browser is logged in and the market page is open headlessly, but this bot will not click the final trade or wallet-signing controls. This protects you from accidental real-money orders.\n\nUse /cancel to close the session.`);
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

  if (command === '/start') return send(chatId, '<b>Cade market monitor</b>\n\nCommands:\n/markets — current markets and estimates\n/estimate higher 100 — estimate a $100 HIGHER prediction\n/estimate lower 100 — estimate a $100 LOWER prediction\n/status — scanner status\n/alerts — enable automatic 5×+ alerts\n/stop — disable automatic alerts');
  if (command === '/trade') return beginTradePreview(chatId, a, String(b || '').toLowerCase(), Number(input.split(/\s+/)[3]));
  if (command === '/email') return submitEmail(chatId, a || '');
  if (command === '/resend') return resendOtp(chatId);
  if (command === '/otp') return submitOtp(chatId, a || '');
  if (command === '/cancel') { await endTradeSession(chatId); return send(chatId, 'Headless Cade session closed. No trade was submitted.'); }
  if (command === '/alerts') { state.subscribers.add(String(chatId)); return send(chatId, `Automatic alerts enabled. I will notify you when a visible market estimates at least ${MIN_MULTIPLE}× total return.`); }
  if (command === '/stop') { state.subscribers.delete(String(chatId)); return send(chatId, 'Automatic alerts disabled for this chat. Send /alerts to enable them again.'); }
  if (command === '/status') return send(chatId, `Build: ${BUILD_VERSION}\nScanner: ${state.lastScan ? `last scan ${new Date(state.lastScan).toLocaleTimeString()}` : 'not scanned yet'}\nMarkets read: ${state.markets.length}\nAlert threshold: ${MIN_MULTIPLE}× total return\nFee used: ${(FEE * 100).toFixed(2)}%`);

  if (command === '/markets') {
    const markets = state.markets.length ? state.markets : await scan();
    if (!markets.length) return send(chatId, 'No readable public Cade markets found right now.');
    const stake = 100;
    return send(chatId, `<b>Current Cade markets</b>\nAssuming ${money(stake)} stake:\n\n${markets.map(m => marketLine(m, stake)).join('\n')}`);
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
        const result = estimate(m, side, ALERT_STAKE);
        if (!result || result.multiple <= MIN_MULTIPLE) continue;
        const key = `${m.url}|${side}|${Math.round(m.higher)}|${Math.round(m.lower)}`;
        if (state.sent.has(key)) continue;
        state.sent.set(key, Date.now());
        for (const chatId of state.subscribers) await send(chatId, alertText(m, side, result, ALERT_STAKE));
      }
    }
    // Keep memory bounded while retaining enough state to prevent repeat spam.
    for (const [key, time] of state.sent) if (Date.now() - time > 6 * 60 * 60 * 1000) state.sent.delete(key);
  } catch (e) { console.error('scan error', e.message); }
  setTimeout(alertLoop, POLL_SECONDS * 1000);
}

await telegram('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
console.log(`Cade Telegram monitor started; polling every ${POLL_SECONDS}s; threshold ${MIN_MULTIPLE}x`);
pollTelegram();
alertLoop();
