import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './src/launches.js';
import { rule, simulate } from './src/exitrules.js';

const EXIT = rule('TP10 / SL50', { takeProfitPct: 10, stopLossPct: 50, maxHoldSeconds: 180 });
const AT = 45;

const launches: RecordedLaunch[] = readFileSync('data/launches.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecordedLaunch);

// Aktivita se dá změřit i bez signals — z hustoty vzorků, protože vzorek vzniká
// jen když někdo obchoduje.
const rows = launches.map((l) => {
  const path = entryPathFromLaunch(l, AT);
  if (!path) return null;
  const o = simulate(path, EXIT);
  if (!Number.isFinite(o.pct)) return null;
  const before = l.samples.filter((s) => s.t <= AT * 1000).length;
  const sig = (l.signalSeries ?? (l.signals ? [l.signals] : [])).find((s) => s.atSeconds === AT);
  return { sym: l.symbol, tradesBefore: before, buyers: sig?.uniqueBuyers ?? null, pct: o.pct };
}).filter((r): r is NonNullable<typeof r> => r !== null);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs: number[]) => { const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const win = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;
const m3 = (xs: number[]) => xs.length > 3 ? mean([...xs].sort((a,b)=>b-a).slice(3)) : NaN;

console.log(`${rows.length} launchů, vstup na +${AT}s, ${EXIT.label}\n`);
console.log('ROZLOŽENÍ AKTIVITY (počet obchodů v prvních 45 s)');
const counts = rows.map((r) => r.tradesBefore).sort((a, b) => a - b);
console.log(`  min ${counts[0]}  p25 ${counts[Math.floor(counts.length*0.25)]}  medián ${med(counts)}  p75 ${counts[Math.floor(counts.length*0.75)]}  max ${counts[counts.length-1]}`);

console.log('\nTVRDÝ PRÁH NA AKTIVITU — obchoduj jen tokeny nad hranicí');
console.log('  práh   zbyde   podíl    WR     exp     exp-3   medián');
for (const t of [0, 3, 5, 8, 12, 20, 30, 50]) {
  const kept = rows.filter((r) => r.tradesBefore >= t).map((r) => r.pct);
  if (kept.length < 15) { console.log(`  >=${String(t).padStart(3)}   ${String(kept.length).padStart(4)}   (moc málo)`); continue; }
  console.log(
    `  >=${String(t).padStart(3)}   ${String(kept.length).padStart(4)}   ${((kept.length/rows.length)*100).toFixed(0).padStart(3)}%  ` +
    `${win(kept).toFixed(0).padStart(4)}%  ${mean(kept).toFixed(2).padStart(6)}%  ${m3(kept).toFixed(2).padStart(6)}%  ${med(kept).toFixed(2).padStart(6)}%`
  );
}

const withBuyers = rows.filter((r) => r.buyers !== null);
if (withBuyers.length >= 20) {
  console.log('\nTVRDÝ PRÁH NA RŮZNÉ KUPUJÍCÍ');
  console.log('  práh   zbyde   podíl    WR     exp     exp-3   medián');
  for (const t of [0, 3, 5, 8, 12, 20]) {
    const kept = withBuyers.filter((r) => (r.buyers as number) >= t).map((r) => r.pct);
    if (kept.length < 15) { console.log(`  >=${String(t).padStart(3)}   ${String(kept.length).padStart(4)}   (moc málo)`); continue; }
    console.log(
      `  >=${String(t).padStart(3)}   ${String(kept.length).padStart(4)}   ${((kept.length/withBuyers.length)*100).toFixed(0).padStart(3)}%  ` +
      `${win(kept).toFixed(0).padStart(4)}%  ${mean(kept).toFixed(2).padStart(6)}%  ${m3(kept).toFixed(2).padStart(6)}%  ${med(kept).toFixed(2).padStart(6)}%`
    );
  }
}
