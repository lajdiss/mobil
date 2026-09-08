const get = async (q: string) =>
  (await (await globalThis.fetch(`https://frontend-api-v3.pump.fun/coins?${q}`)).json()) as any[];

const byReply = await get('limit=50&sort=last_reply&order=DESC&includeNsfw=false');
const byTrade = await get('limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false');

const pool = new Map<string, any>();
for (const c of [...byReply, ...byTrade]) pool.set(c.mint, c);
const now = Date.now();

const rows = [...pool.values()].map((c) => ({
  sym: (c.symbol ?? '?').slice(0, 12),
  ageMin: (now - c.created_timestamp) / 60000,
  tradeAgoS: (now - c.last_trade_timestamp) / 1000,
  replyAgoS: c.last_reply ? (now - c.last_reply) / 1000 : null,
  replies: c.reply_count ?? 0,
  mcap: c.market_cap ?? 0,
  complete: c.complete,
  soc: (c.twitter ? 'T' : '-') + (c.telegram ? 'g' : '-') + (c.website ? 'w' : '-'),
  live: c.is_currently_live,
  banned: c.is_banned,
}));

console.log(`pool: ${rows.length} unikátních tokenů ze dvou seznamů\n`);
const alive = rows.filter((r) => r.tradeAgoS < 120 && !r.banned);
console.log(`obchodované za poslední 2 min: ${alive.length}`);
const withCallouts = alive.filter((r) => r.replyAgoS !== null && r.replyAgoS < 600 && r.replies >= 10);
console.log(`z toho s callouty (>=10 komentů, poslední <10 min): ${withCallouts.length}`);
const onCurve = withCallouts.filter((r) => !r.complete);
console.log(`z toho ještě na křivce (neabsolvovaly): ${onCurve.length}\n`);

console.log('sym          stáří    posl.obch  posl.koment  komentů   mcap   soc  live  curve');
for (const r of withCallouts.sort((a, b) => (a.replyAgoS ?? 1e9) - (b.replyAgoS ?? 1e9)).slice(0, 15)) {
  console.log(
    r.sym.padEnd(13) +
      (r.ageMin < 60 ? r.ageMin.toFixed(0) + 'm' : (r.ageMin / 60).toFixed(0) + 'h').padStart(6) +
      (r.tradeAgoS.toFixed(0) + 's').padStart(11) +
      ((r.replyAgoS ?? 0).toFixed(0) + 's').padStart(13) +
      String(r.replies).padStart(9) +
      r.mcap.toFixed(0).padStart(7) +
      r.soc.padStart(6) +
      (r.live ? '  yes' : '   no') +
      (r.complete ? '    no' : '   YES'),
  );
}
