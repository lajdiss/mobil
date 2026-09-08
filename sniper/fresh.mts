import { HypeClient } from './src/hype.js';
const client = new HypeClient();
const newest = await (await globalThis.fetch(
  'https://frontend-api-v3.pump.fun/coins?limit=6&sort=created_timestamp&order=DESC',
)).json() as any[];
console.log('NEJNOVĚJŠÍ TOKENY PODLE API');
for (const c of newest) {
  const age = (Date.now() - c.created_timestamp) / 1000;
  console.log(`  ${(c.symbol??'?').padEnd(12)} stáří ${age.toFixed(0).padStart(5)}s  replies=${String(c.reply_count).padStart(4)}  tw=${c.twitter?'y':'n'} mcap=${(c.market_cap??0).toFixed(1)}`);
}

// Teď to podstatné: vezmi mint z NAŠEHO streamu a zjisti, za jak dlouho ho API zná.
const fs = await import('node:fs');
const L = fs.readFileSync('data/launches.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const recent = L.slice(-6);
console.log('\nZNÁ API TOKENY Z NAŠEHO STREAMU?');
for (const l of recent) {
  const t0 = Date.now();
  const s = await client.fetch(l.mint);
  const age = (Date.now() - l.launchedAt) / 1000;
  console.log(
    `  ${l.symbol.padEnd(12)} ${age.toFixed(0).padStart(5)}s po launchi -> ` +
    (s ? `ZNÁ (replies=${s.replyCount}, tw=${s.hasTwitter?'y':'n'}, score-relevant)` : 'NEZNÁ') +
    `  [${(Date.now()-t0)}ms]`
  );
}
