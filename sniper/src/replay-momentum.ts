/**
 * Tests whether a crowd arriving fast predicts a crowd that keeps arriving.
 *
 * The premise is intuitive: the more people buy a token in a short time, the further
 * it runs, so catch it while the crowd is still forming. The catch is that measuring
 * a crowd means the crowd has already arrived — by the time the buying is visible, it
 * is behind you. The question is not whether many people bought, it is whether the
 * buying continues after the moment you could have noticed it.
 *
 * That is a different claim from the one already measured here. The buyer count at a
 * fixed offset separated win rates (32% against 21%) and died on the outlier test.
 * This measures the derivative instead: how fast the rate of trading is changing just
 * before the entry, and whether that carries any information the level does not.
 *
 * Trades are counted from the recording's samples, which exist only because somebody
 * traded. The recorder collapses anything closer than 250ms, so the measured rate
 * saturates at 4/s — a genuinely frantic token and a merely busy one look the same at
 * the top end, which blunts this test rather than flattering it.
 *
 *   npm run replay:momentum -- data/launches.jsonl
 */
import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './launches.js';
import { rule, simulate } from './exitrules.js';

const EXIT = rule('TP10 / SL50', { takeProfitPct: 10, stopLossPct: 50, maxHoldSeconds: 180 });
const WINDOW = 20; // seconds of history the features look back over

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? 'data/launches.jsonl';
const splitHalves = args.includes('--split');
const allLaunches: RecordedLaunch[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecordedLaunch)
  .sort((a, b) => a.launchedAt - b.launchedAt);
let launches = allLaunches;

const solForTokens = (vt: bigint, vq: bigint, tokens: bigint) =>
  tokens <= 0n ? 0n : (tokens * vq) / (vt + tokens);

interface Row {
  symbol: string;
  /** Trades per second over the window ending at the entry. */
  rate: number;
  /** Second half of the window against the first — above 1 means accelerating. */
  acceleration: number;
  /** How far the price already moved over the window, in percent. */
  runUpPct: number;
  outcome: number;
}

function rowsAt(entrySeconds: number): Row[] {
  const out: Row[] = [];
  for (const launch of launches) {
    const path = entryPathFromLaunch(launch, entrySeconds);
    if (!path) continue;
    const result = simulate(path, EXIT);
    if (!Number.isFinite(result.pct)) continue;

    const entryMs = entrySeconds * 1000;
    const windowMs = WINDOW * 1000;
    const inWindow = launch.samples.filter((s) => s.t > entryMs - windowMs && s.t <= entryMs);
    if (inWindow.length < 4) continue;
    // Recordings made before samples carried a trade count fall back to one each,
    // which is what the old files effectively assumed.
    const count = (s: { n?: number }) => s.n ?? 1;
    const total = inWindow.reduce((a, s) => a + count(s), 0);
    const firstHalf = inWindow
      .filter((s) => s.t <= entryMs - windowMs / 2)
      .reduce((a, s) => a + count(s), 0);
    const secondHalf = total - firstHalf;

    // Price move over the window, priced the same way the entry is.
    const start = inWindow[0];
    const end = inWindow[inWindow.length - 1];
    const unit = 10n ** 6n;
    const before = Number(solForTokens(BigInt(start.vt), BigInt(start.vq), unit));
    const after = Number(solForTokens(BigInt(end.vt), BigInt(end.vq), unit));

    out.push({
      symbol: launch.symbol,
      rate: total / WINDOW,
      // +1 on both sides so a quiet first half does not produce infinity.
      acceleration: (secondHalf + 1) / (firstHalf + 1),
      runUpPct: before > 0 ? ((after - before) / before) * 100 : 0,
      outcome: result.pct,
    });
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;
const minusTop3 = (xs: number[]) =>
  xs.length > 3 ? mean([...xs].sort((a, b) => b - a).slice(3)) : NaN;

/** Thirds rather than halves: the interesting claim is about the extreme, not the median. */
function report(rows: Row[], name: string, value: (r: Row) => number) {
  const sorted = [...rows].sort((a, b) => value(a) - value(b));
  const third = Math.floor(sorted.length / 3);
  if (third < 8) {
    console.log(`  ${name.padEnd(20)} too few to split into thirds`);
    return;
  }
  const buckets: [string, Row[]][] = [
    ['bottom', sorted.slice(0, third)],
    ['middle', sorted.slice(third, sorted.length - third)],
    ['TOP   ', sorted.slice(sorted.length - third)],
  ];
  console.log(`  ${name}`);
  for (const [label, bucket] of buckets) {
    const xs = bucket.map((r) => r.outcome);
    const range = `${value(bucket[0]).toFixed(2)}..${value(bucket[bucket.length - 1]).toFixed(2)}`;
    console.log(
      `    ${label}  ${range.padEnd(16)} n=${String(xs.length).padStart(3)} ` +
        `win ${winRate(xs).toFixed(0).padStart(3)}%  exp ${mean(xs).toFixed(2).padStart(7)}%  ` +
        `exp-3 ${minusTop3(xs).toFixed(2).padStart(7)}%  med ${median(xs).toFixed(2).padStart(6)}%`,
    );
  }
}

/**
 * The combination looks strong at +45s and collapses at +60s, which is the shape a
 * lucky slice makes. Every previous candidate in this project died here.
 */
if (splitHalves) {
  const half = Math.floor(allLaunches.length / 2);
  const halves = [allLaunches.slice(0, half), allLaunches.slice(half)];
  console.log(
    `${allLaunches.length} launches split by time into ${halves[0].length} + ${halves[1].length}\n` +
      `heavily traded (top third by rate) and not already run up\n`,
  );
  console.log(
    '  entry  run-up' + 'FIRST HALF'.padStart(26) + 'SECOND HALF'.padStart(28) + '   holds?',
  );
  console.log(
    '                ' + 'n'.padStart(5) + 'win%'.padStart(6) + 'exp%'.padStart(8) + 'exp-3'.padStart(8) +
      'n'.padStart(7) + 'win%'.padStart(6) + 'exp%'.padStart(8) + 'exp-3'.padStart(8),
  );
  console.log('  ' + '-'.repeat(84));
  for (const entry of [30, 45, 60]) {
    for (const maxRunUp of [Infinity, 25, 0]) {
      const scored = halves.map((h) => {
        launches = h;
        const rows = rowsAt(entry);
        if (rows.length < 20) return null;
        // The rate threshold is taken inside each half, so neither half is judged
        // against the other's distribution.
        const rates = rows.map((r) => r.rate).sort((a, b) => a - b);
        const cut = rates[Math.floor(rates.length * (2 / 3))];
        const kept = rows.filter((r) => r.rate >= cut && r.runUpPct <= maxRunUp).map((r) => r.outcome);
        return kept.length >= 10 ? kept : null;
      });
      launches = allLaunches;
      const label = `  ${entry}s   <=${maxRunUp === Infinity ? 'any' : maxRunUp + '%'}`.padEnd(16);
      const [a, b] = scored;
      if (!a || !b) {
        console.log(label + '  (too few in one half)');
        continue;
      }
      const holds = mean(a) > 0 && mean(b) > 0 && minusTop3(a) > 0 && minusTop3(b) > 0;
      console.log(
        label +
          String(a.length).padStart(5) + winRate(a).toFixed(0).padStart(6) +
          mean(a).toFixed(2).padStart(8) + minusTop3(a).toFixed(2).padStart(8) +
          String(b.length).padStart(7) + winRate(b).toFixed(0).padStart(6) +
          mean(b).toFixed(2).padStart(8) + minusTop3(b).toFixed(2).padStart(8) +
          (holds ? '   HOLDS' : mean(a) > 0 === mean(b) > 0 ? '   same sign' : '   flips'),
      );
    }
  }
  console.log(
    '\nHOLDS means positive expectancy in both halves AND positive with each half\'s\n' +
      'three best trades removed. Nothing in this project has managed that yet.',
  );
  process.exit(0);
}

console.log(
  `${launches.length} recorded launches, ${EXIT.label}, exit latency ` +
    `${EXIT.executionDelaySeconds}s, features over the ${WINDOW}s before entry\n`,
);

for (const entry of [20, 30, 45, 60]) {
  const rows = rowsAt(entry);
  if (rows.length < 30) {
    console.log(`ENTER AT +${entry}s — only ${rows.length} launches, skipping\n`);
    continue;
  }
  const all = rows.map((r) => r.outcome);
  console.log(`${'='.repeat(92)}\nENTER AT +${entry}s`);
  console.log(
    `  baseline             n=${String(all.length).padStart(3)} ` +
      `win ${winRate(all).toFixed(0).padStart(3)}%  exp ${mean(all).toFixed(2).padStart(7)}%  ` +
      `exp-3 ${minusTop3(all).toFixed(2).padStart(7)}%  med ${median(all).toFixed(2).padStart(6)}%`,
  );
  report(rows, 'trade rate (trades/s)', (r) => r.rate);
  report(rows, 'acceleration (2nd half / 1st)', (r) => r.acceleration);
  report(rows, 'run-up already banked (%)', (r) => r.runUpPct);
  console.log('');
}

/**
 * The two features separately point in opposite directions, which is the interesting
 * part: heavy trading is good and an existing run-up is bad. Taken together they say
 * to buy the crowd that is arriving, not the one that already arrived and bid the
 * price up — so this checks whether the combination is better than either alone.
 */
console.log(`${'='.repeat(92)}\nCOMBINED — heavily traded AND not already run up`);
for (const entry of [30, 45, 60]) {
  const rows = rowsAt(entry);
  if (rows.length < 40) continue;
  const rates = rows.map((r) => r.rate).sort((a, b) => a - b);
  const rateCut = rates[Math.floor(rates.length * (2 / 3))];

  console.log(`\n  entering at +${entry}s, trade rate >= ${rateCut.toFixed(2)}/s`);
  for (const maxRunUp of [Infinity, 25, 10, 0]) {
    const kept = rows
      .filter((r) => r.rate >= rateCut && r.runUpPct <= maxRunUp)
      .map((r) => r.outcome);
    if (kept.length < 12) {
      console.log(`    run-up <= ${maxRunUp === Infinity ? 'any' : maxRunUp + '%'}: only ${kept.length} left`);
      continue;
    }
    console.log(
      `    run-up <= ${(maxRunUp === Infinity ? 'any' : maxRunUp + '%').padEnd(4)}  ` +
        `n=${String(kept.length).padStart(3)} win ${winRate(kept).toFixed(0).padStart(3)}%  ` +
        `exp ${mean(kept).toFixed(2).padStart(7)}%  exp-3 ${minusTop3(kept).toFixed(2).padStart(7)}%  ` +
        `med ${median(kept).toFixed(2).padStart(6)}%`,
    );
  }
}

console.log(
  '\nIf catching a forming crowd worked, the TOP bucket would beat the baseline and\n' +
    'keep beating it once its three best trades are removed. If the run-up bucket is\n' +
    'the one that loses, the crowd was the exit rather than the entry.',
);
