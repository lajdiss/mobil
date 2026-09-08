/**
 * The ceiling on win rate has nothing to do with exit rules: a trade can only be a
 * win if the price traded above the entry at some point. This measures that directly —
 * with perfect foresight, selling every path at its own peak.
 */
import { readFileSync } from 'node:fs';
const rows = readFileSync('data/paths.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const solForTokens=(vt:bigint,vq:bigint,t:bigint)=> t<=0n?0n:(t*vq)/(vt+t);

const stats = rows.map((p:any)=>{
  const tokens=BigInt(p.entryTokens);
  const fee=(1e4-p.feeBps)/1e4;
  const series=p.samples.map((s:any)=>({
    t:s.t/1000,
    pnl:(((Number(solForTokens(BigInt(s.vt),BigInt(s.vq),tokens))/1e9)*fee - p.entrySol)/p.entrySol)*100,
  }));
  const peak=series.reduce((a:any,b:any)=>b.pnl>a.pnl?b:a, series[0]);
  return { sym:p.symbol, peak:peak.pnl, peakAt:peak.t, first:series[0].pnl, last:series[series.length-1].pnl, span:series[series.length-1].t };
});

const pct=(n:number)=>(n/stats.length*100).toFixed(1)+'%';
console.log(`${stats.length} paths\n`);
console.log('PERFECT-FORESIGHT CEILING — sell every path at its own peak');
for (const bar of [0,1,2,5,10,25,50,100]) {
  const n=stats.filter(s=>s.peak>=bar).length;
  console.log(`  ever traded >= +${String(bar).padStart(3)}% : ${String(n).padStart(3)} of ${stats.length}  (${pct(n)})`);
}
const peaks=stats.map(s=>s.peak).sort((a,b)=>a-b);
const med=peaks[Math.floor(peaks.length/2)];
console.log(`  median peak: ${med.toFixed(2)}%   best peak: ${peaks[peaks.length-1].toFixed(1)}%`);

console.log('\nWHEN THE PEAK HAPPENS (seconds after our entry)');
const early=stats.filter(s=>s.peakAt<=5).length;
console.log(`  peak within  5s of entry: ${early} (${pct(early)})   <- already over when we bought`);
for (const w of [15,30,60,120]) {
  const n=stats.filter(s=>s.peakAt<=w).length;
  console.log(`  peak within ${String(w).padStart(3)}s of entry: ${String(n).padStart(3)} (${pct(n)})`);
}

console.log('\nFIRST SAMPLE vs LAST SAMPLE (did it go anywhere at all?)');
const down=stats.filter(s=>s.last<s.first).length;
console.log(`  ended below where we bought: ${down} of ${stats.length} (${pct(down)})`);
const medLast=stats.map(s=>s.last).sort((a,b)=>a-b)[Math.floor(stats.length/2)];
console.log(`  median final pnl: ${medLast.toFixed(2)}%`);

console.log('\nThe three that ever made money:');
stats.filter(s=>s.peak>0).sort((a,b)=>b.peak-a.peak).slice(0,6)
  .forEach(s=>console.log(`  ${s.sym.padEnd(12)} peak ${s.peak.toFixed(1)}% at ${s.peakAt.toFixed(0)}s, ended ${s.last.toFixed(1)}%`));
