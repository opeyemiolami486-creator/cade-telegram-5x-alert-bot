const home = 'https://cade.market/';
const page = await fetch(home, { headers: { 'user-agent': 'cade-telegram-smoke-test/1.0' } });
if (!page.ok) throw new Error(`Cade home HTTP ${page.status}`);
const html = await page.text();
const mints = [...new Set([...html.matchAll(/\/meme-madness\/market\/([^/?"']+)/g)].map(m => m[1]))].slice(0, 5);
console.log(`Cade home: OK; discovered ${mints.length} token mint(s)`);
if (!mints.length) process.exit(2);
let readable = 0;
for (const mint of mints) {
  const response = await fetch(`${home}api/meme-madness/markets?token_mint=${encodeURIComponent(mint)}`, { headers: { 'user-agent': 'cade-telegram-smoke-test/1.0' } });
  if (!response.ok) throw new Error(`API HTTP ${response.status} for ${mint}`);
  const json = await response.json();
  const open = (json.markets || []).filter(m => m.status === 'open' || m.phase === 'continuous');
  for (const market of open.slice(0, 2)) {
    const up = market.outcomes?.find(o => o.index === 0);
    const down = market.outcomes?.find(o => o.index === 1);
    console.log(`OK ${market.resolution_config?.tokenSymbol || mint.slice(0, 6)} ${market.status} | HIGHER raw ${up?.net_stake_raw ?? 'missing'} | LOWER raw ${down?.net_stake_raw ?? 'missing'}`);
    if (up?.net_stake_raw != null && down?.net_stake_raw != null) readable++;
  }
}
if (!readable) throw new Error('No open markets with readable outcome pools were found');
console.log(`Readable live market(s): ${readable}`);
