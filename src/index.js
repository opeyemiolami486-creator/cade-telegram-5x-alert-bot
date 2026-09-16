import 'dotenv/config';
import * as cheerio from 'cheerio';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const POLL_SECONDS = Math.max(1, Number(process.env.POLL_SECONDS || 60));
const MIN_MULTIPLE = Math.max(1, Number(process.env.MIN_MULTIPLE || 5));
const CADE_HOME = process.env.CADE_HOME || 'https://cade.market/';
const FEE = Number(process.env.CADE_FEE || 0.03);
const MAX_MARKETS = Math.max(1, Number(process.env.MAX_MARKETS || 30));
const ALERT_STAKE = Math.max(0.01, Number(process.env.ALERT_STAKE || 100));

if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const state = { offset: 0, subscribers: new Set(ALLOWED_CHAT_IDS), sent: new Map(), markets: [], lastScan: null };
const money = n => Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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
  return `• <a href="${esc(m.url)}">$${esc(m.symbol)}</a> — H ${pct(h?.probability)} → ${money(h?.totalReturn)} | L ${pct(l?.probability)} → ${money(l?.totalReturn)}`;
}

function alertText(m, side, result, stake = 100) {
  return `🚨 <b>CADE ${MIN_MULTIPLE}×+ OPPORTUNITY</b>\n\n<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — <b>${side.toUpperCase()}</b>\nStake: ${money(stake)}\nEstimated total return: <b>${money(result.totalReturn)}</b>\nEstimated profit: <b>${money(result.profit)}</b>\nCurrent implied chance: ${pct(result.probability)}\nPool: Higher ${money(m.higher)} / Lower ${money(m.lower)}\n\nRead-only estimate; no trade was placed.`;
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

function authorized(chatId) {
  return ALLOWED_CHAT_IDS.size === 0 || ALLOWED_CHAT_IDS.has(String(chatId));
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId || !authorized(chatId)) return;
  const input = (message.text || '').trim();
  if (!input) return;
  state.subscribers.add(String(chatId));
  const [command, a, b] = input.split(/\s+/);

  if (/^\/start/i.test(command)) return send(chatId, '<b>Cade market monitor</b>\n\nCommands:\n/markets — current markets and estimates\n/estimate higher 100 — estimate a $100 HIGHER prediction\n/estimate lower 100 — estimate a $100 LOWER prediction\n/status — scanner status\n/alerts — enable automatic 5×+ alerts\n/stop — disable automatic alerts');
  if (/^\/alerts/i.test(command)) { state.subscribers.add(String(chatId)); return send(chatId, `Automatic alerts enabled. I will notify you when a visible market estimates at least ${MIN_MULTIPLE}× total return.`); }
  if (/^\/stop/i.test(command)) { state.subscribers.delete(String(chatId)); return send(chatId, 'Automatic alerts disabled for this chat.'); }
  if (/^\/status/i.test(command)) return send(chatId, `Scanner: ${state.lastScan ? `last scan ${new Date(state.lastScan).toLocaleTimeString()}` : 'not scanned yet'}\nMarkets read: ${state.markets.length}\nAlert threshold: ${MIN_MULTIPLE}× total return\nFee used: ${(FEE * 100).toFixed(2)}%`);

  if (/^\/markets/i.test(command)) {
    const markets = state.markets.length ? state.markets : await scan();
    if (!markets.length) return send(chatId, 'No readable public Cade markets found right now.');
    const stake = 100;
    return send(chatId, `<b>Current Cade markets</b>\nAssuming ${money(stake)} stake:\n\n${markets.map(m => marketLine(m, stake)).join('\n')}`);
  }

  if (/^\/estimate/i.test(command)) {
    const side = String(a || '').toLowerCase();
    const stake = Number(b);
    if (!['higher', 'lower'].includes(side) || !(stake > 0)) return send(chatId, 'Usage: <code>/estimate higher 100</code> or <code>/estimate lower 100</code>');
    const markets = state.markets.length ? state.markets : await scan();
    const lines = markets.map(m => { const r = estimate(m, side, stake); return r ? { m, r } : null; }).filter(Boolean);
    if (!lines.length) return send(chatId, 'No readable public markets are available for that estimate.');
    return send(chatId, `<b>${side.toUpperCase()} estimates for ${money(stake)}</b>\n\n${lines.map(({m,r}) => `<a href="${esc(m.url)}">$${esc(m.symbol)}</a> — return <b>${money(r.totalReturn)}</b>, profit ${money(r.profit)}, implied chance ${pct(r.probability)}`).join('\n')}`);
  }
  return send(chatId, 'Unknown command. Try /markets, /estimate higher 100, /alerts, or /status.');
}

async function pollTelegram() {
  try {
    const updates = await telegram('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) { state.offset = update.update_id + 1; if (update.message) await handleMessage(update.message); }
  } catch (e) { console.error('telegram polling error', e.message); }
  setImmediate(pollTelegram);
}

async function alertLoop() {
  try {
    const markets = await scan();
    for (const m of markets) {
      for (const side of ['higher', 'lower']) {
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
