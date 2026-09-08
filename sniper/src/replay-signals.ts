/**
 * Tests whether the selection signals predict anything.
 *
 * Trending mode rests entirely on one claim: that a token being bought by many
 * different wallets does better than one being bought by few. That is a plausible
 * claim and it has never been measured. Everything else in this project that looked
 * plausible — momentum, copy trading, wallet consensus, comment counts — measured out
 * as noise or as dead data, so the claim gets the same treatment before it is trusted.
 *
 * Signals are read from the launch recordings, taken at a fixed offset after each
 * launch. The outcome is what a real exit rule earned entering at that same moment,
 * with the execution latency charged, because an outcome measured at the peak is a
 * ceiling and not something any rule can capture.
 *
 *   npm run replay:signals -- data/launches.jsonl
 */
import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './launches.js';
import { rule, simulate } from './exitrules.js';

const EXIT = rule('TP10 / SL50', { takeProfitPct: 10, stopLossPct: 50, maxHoldSeconds: 180 });

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/launches.jsonl';
const launches: RecordedLaunch[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecordedLaunch)
  .filter((l) => (l.signalSeries?.length ?? 0) > 0 || l.signals !== undefined);

if (launches.length === 0) {
  console.log(`no launches with recorded signals in ${file}`);
  process.exit(1);
}

interface Row {
  symbol: string;
  signals: NonNullable<RecordedLaunch['signals']>;
  outcome: number;
}

/** Rows for one offset: read the crowd there, and buy there. */
function rowsAt(offsetSeconds: number): Row[] {
  const out: Row[] = [];
  for (const launch of launches) {
    const series = launch.signalSeries ?? (launch.signals ? [launch.signals] : []);
    const signals = series.find((s) => s.atSeconds === offsetSeconds);
    if (!signals) continue;
    // Enter where the signal was read. A reading taken at 45 seconds cannot inform a
    // purchase made at 5.
    const path = entryPathFromLaunch(launch, offsetSeconds);
    if (!path) continue;
    const outcome = simulate(path, EXIT);
    if (!Number.isFinite(outcome.pct)) continue;
    out.push({ symbol: launch.symbol, signals, outcome: outcome.pct });
  }
  return out;
}

const offsets = [
  ...new Set(
    launches.flatMap((l) => (l.signalSeries ?? (l.signals ? [l.signals] : [])).map((s) => s.atSeconds)),
  ),
].sort((a, b) => a - b);

console.log(
  `${launches.length} launches carry signals at offsets: ${offsets.join('s, ')}s\n` +
    `scored under ${EXIT.label}, exit latency ${EXIT.executionDelaySeconds}s\n`,
);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;
const minusTop3 = (xs: number[]) =>
  xs.length > 3 ? mean([...xs].sort((a, b) => b - a).slice(3)) : NaN;

function report(rows: Row[], name: string, value: (r: Row) => number | boolean | undefined) {
  const scored = rows.filter((r) => value(r) !== undefined);
  if (scored.length < 20) {
    console.log(`${name.padEnd(22)} only ${scored.length} launches carry it`);
    return;
  }
  const numeric = scored.map((r) => Number(value(r)));
  const cut = median(numeric);
  const low = scored.filter((r) => Number(value(r)) <= cut).map((r) => r.outcome);
  const high = scored.filter((r) => Number(value(r)) > cut).map((r) => r.outcome);
  if (low.length < 6 || high.length < 6) {
    console.log(`${name.padEnd(22)} no spread to split on (median ${cut.toFixed(2)})`);
    return;
  }
  const fmt = (xs: number[]) =>
    `n=${String(xs.length).padStart(3)} win ${winRate(xs).toFixed(0).padStart(3)}% ` +
    `exp ${mean(xs).toFixed(2).padStart(7)}% exp-3 ${minusTop3(xs).toFixed(2).padStart(7)}%`;
  console.log(
    `${name.padEnd(22)}cut ${cut.toFixed(2).padStart(7)}  LOW  ${fmt(low)}   HIGH ${fmt(high)}`,
  );
}

let commentsSeen = 0;
let scoredTotal = 0;

for (const offset of offsets) {
  const rows = rowsAt(offset);
  scoredTotal += rows.length;
  commentsSeen += rows.filter((r) => (r.signals.replyCount ?? 0) > 0).length;
  console.log(`${'='.repeat(96)}\nREAD AND BUY AT +${offset}s`);
  if (rows.length < 20) {
    console.log(`  only ${rows.length} launches reach this offset — too few to judge\n`);
    continue;
  }
  const all = rows.map((r) => r.outcome);
  console.log(
    `  baseline (no filter)   n=${String(all.length).padStart(3)} win ${winRate(all).toFixed(0).padStart(3)}% ` +
      `exp ${mean(all).toFixed(2).padStart(7)}% exp-3 ${minusTop3(all).toFixed(2).padStart(7)}% ` +
      `median ${median(all).toFixed(2)}%`,
  );
  // buyersPerMinute is uniqueBuyers divided by a constant when the offset is fixed,
  // so it is the same variable and reporting both twice says nothing new.
  report(rows, 'unique buyers', (r) => r.signals.uniqueBuyers);
  report(rows, 'buy ratio', (r) => r.signals.buyRatio);
  report(rows, 'net SOL flow', (r) => r.signals.netSolFlow);
  report(rows, 'top buyer share', (r) => r.signals.topBuyerShare);
  report(rows, 'hype score', (r) => r.signals.hypeScore);
  console.log('');
}

console.log(
  `Comment counts: ${commentsSeen} of ${scoredTotal} readings found a single comment.\n` +
    `That is why callouts are not a filter here.`,
);
console.log(
  '\nA signal earns a place only if its HIGH bucket beats the baseline by more than the\n' +
    'two buckets differ by chance, and survives its three best trades being removed.',
);
