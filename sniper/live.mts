const get = async (q: string) =>
  (await (await globalThis.fetch(`https://frontend-api-v3.pump.fun/coins?${q}`)).json()) as any[];
const now = Date.now();
// projdi několik stránek aktivně obchodovaných a spočítej, co je vlastně živé
let all: any[] = [];
for (let off = 0; off < 300; off += 50) {
  all = all.concat(await get(`limit=50&offset=${off}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`));
}
const uniq = new Map(all.map((c) => [c.mint, c]));
const rows = [...uniq.values()];
const recent = rows.filter((c) => now - c.last_trade_timestamp < 120_000);
console.log(`${rows.length} tokenů, ${recent.length} obchodovaných za poslední 2 minuty\n`);

const count = (label: string, f: (c: any) => boolean) =>
  console.log(`  ${label.padEnd(38)} ${recent.filter(f).length}`);
count('livestream právě běží', (c) => c.is_currently_live);
count('má Twitter', (c) => !!c.twitter);
count('má Telegram', (c) => !!c.telegram);
count('má web', (c) => !!c.website);
count('má aspoň jeden social', (c) => !!(c.twitter || c.telegram || c.website));
count('komentář za posledních 24 h', (c) => c.last_reply && now - c.last_reply < 86_400_000);
count('ještě na křivce (complete=false)', (c) => !c.complete);
count('graduované (complete=true)', (c) => c.complete);
count('mcap 20-5000 SOL', (c) => c.market_cap > 20 && c.market_cap < 5000);
count('boost_mode != NONE', (c) => c.boost_mode && c.boost_mode !== 'NONE');
count('verified', (c) => c.verified);

const live = recent.filter((c) => c.is_currently_live);
if (live.length) {
  console.log('\nživé streamy:');
  for (const c of live.slice(0, 8))
    console.log(`  ${(c.symbol ?? '?').padEnd(14)} mcap ${Math.round(c.market_cap)} SOL  stáří ${((now - c.created_timestamp) / 3600000).toFixed(1)}h  curve=${!c.complete}`);
}
