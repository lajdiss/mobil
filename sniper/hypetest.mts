import { HypeClient, hypeScore, judgeHype } from './src/hype.js';
const client = new HypeClient();

// Vezmi pár čerstvě obchodovaných tokenů přímo z pump.fun
const list = await (await globalThis.fetch(
  'https://frontend-api-v3.pump.fun/coins?limit=8&sort=last_trade_timestamp&order=DESC',
)).json() as any[];

console.log('symbol      replies  r/min  age    soc  live  KotH  mcap    ath     score  verdict');
for (const c of list) {
  const s = await client.fetch(c.mint);
  if (!s) { console.log(`${(c.symbol??'?').padEnd(11)} <no data>`); continue; }
  const v = judgeHype(s, { minReplies: 5, minRepliesPerMinute: 0, requireSocial: true, maxDrawdownFromAthPct: 0, minScore: 0 });
  console.log(
    (s.mint.slice(0,4)+' '+(c.symbol??'?')).padEnd(12) +
    String(s.replyCount).padStart(6) +
    s.repliesPerMinute.toFixed(2).padStart(8) +
    (s.ageSeconds/3600).toFixed(1).padStart(7)+'h' +
    ((s.hasTwitter?'T':'-')+(s.hasTelegram?'g':'-')+(s.hasWebsite?'w':'-')).padStart(6) +
    (s.isCurrentlyLive?'  yes':'   no') +
    (s.reachedKingOfTheHill?'   yes':'    no') +
    s.marketCapSol.toFixed(0).padStart(8) +
    s.athMarketCapSol.toFixed(0).padStart(8) +
    String(hypeScore(s)).padStart(7) + '  ' + (v.passed?'PASS':'skip: '+v.reason)
  );
}
console.log('\ncache/health:', JSON.stringify(client.health()));

// fail-closed test
const bogus = await client.fetch('NotARealMint1111111111111111111111111111111');
console.log('neexistující mint ->', bogus, '(musí být null)');
console.log('judgeHype(null) ->', JSON.stringify(judgeHype(null, { minReplies:0, minRepliesPerMinute:0, requireSocial:false, maxDrawdownFromAthPct:0, minScore:0 })));
