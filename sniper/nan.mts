import { readFileSync } from 'node:fs';
import type { RecordedLaunch } from './src/launches.js';
import { rule, simulate } from './src/exitrules.js';
const solForTokens=(vt:bigint,vq:bigint,t:bigint)=> t<=0n?0n:(t*vq)/(vt+t);
const tokensForSol=(vt:bigint,vq:bigint,s:bigint)=> s<=0n?0n:(s*vt)/(vq+s);
const BUY=50_000_000n;
const rows:RecordedLaunch[]=readFileSync('data/launches.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const r=rule('TP50 / SL30',{takeProfitPct:50,stopLossPct:30});
for (const delay of [2,5]) {
  for (const l of rows) {
    const i=l.samples.findIndex(s=>s.t>=delay*1000);
    if(i===-1) continue;
    const after=l.samples.slice(i);
    if(after.length<2) continue;
    const vt=BigInt(after[0].vt), vq=BigInt(after[0].vq);
    const tokens=tokensForSol(vt,vq,BUY);
    const cost=Number(solForTokens(vt,vq,tokens))*((1e4+l.feeBps)/1e4);
    const path={mint:l.mint,symbol:l.symbol,venue:'pump',openedAt:0,entrySol:cost/1e9,
      entryTokens:tokens.toString(),feeBps:l.feeBps,
      samples:after.map(s=>({t:s.t-after[0].t,vt:s.vt,vq:s.vq})),creatorSales:[]};
    const o=simulate(path as never,r);
    if(!Number.isFinite(o.pct)) {
      console.log(`delay=${delay}s ${l.symbol}: pct=${o.pct} entrySol=${path.entrySol} tokens=${tokens} vt=${vt} vq=${vq} samples=${after.length}`);
      console.log('  first 3 samples:', JSON.stringify(after.slice(0,3)));
    }
  }
}
console.log('scan done');
