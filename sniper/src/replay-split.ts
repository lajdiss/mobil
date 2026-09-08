/**
 * Splits the recordings in half by time and scores every rule on both halves.
 *
 * A grid search over dozens of configurations will always produce a winner — that is
 * what a grid search does. The only question worth asking of the winner is whether it
 * was the winner for a reason, and the cheapest test is whether it still works on data
 * it was not chosen on. Three apparent finds in earlier live rounds were two noise and
 * one bug; none of them were checked this way first.
 *
 *   npm run replay:split -- data/paths.jsonl
 */
import { readFileSync } from 'node:fs';
import type { RecordedPath } from './recorder.js';
import { rule, simulate, type ExitRule } from './exitrules.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/paths.jsonl';
const all: RecordedPath[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecordedPath)
  .sort((a, b) => a.openedAt - b.openedAt);

const half = Math.floor(all.length / 2);
const first = all.slice(0, half);
const second = all.slice(half);

interface Score {
  n: number;
  winRate: number;
  expectancy: number;
  minusTop3: number | null;
  median: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function score(paths: RecordedPath[], r: ExitRule): Score {
  const pcts = paths.map((p) => simulate(p, r).pct).filter((n) => Number.isFinite(n));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: pcts.length,
    winRate: (pcts.filter((p) => p > 0).length / pcts.length) * 100,
    expectancy: mean(pcts),
    minusTop3: pcts.length > 3 ? mean([...pcts].sort((a, b) => b - a).slice(3)) : null,
    median: median(pcts),
  };
}

const grid: ExitRule[] = [];
for (const tp of [15, 30, 50, 100]) {
  for (const sl of [10, 20, 30, 50]) {
    grid.push(rule(`TP${tp} / SL${sl}`, { takeProfitPct: tp, stopLossPct: sl }));
  }
}
for (const bps of [25, 50, 150]) {
  grid.push(rule(`dev-sell >${bps}bps`, { creatorSellMinBps: bps }));
  grid.push(
    rule(`dev-sell >${bps}bps + partial`, { creatorSellMinBps: bps, partialTakeProfitPct: 25 }),
  );
}
grid.push(rule('trail 20%', { takeProfitPct: 1e6, stopLossPct: 50, trailingStopPct: 20 }));
grid.push(rule('buy and hold', { takeProfitPct: 1e6, stopLossPct: 99.9, maxHoldSeconds: 1e6 }));

console.log(`${all.length} paths, split by time into ${first.length} + ${second.length}\n`);
const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number | null, n: number) => (v === null ? '—' : v.toFixed(2)).padStart(n);

console.log(
  pad('rule', 30) + 'FIRST HALF'.padStart(22) + 'SECOND HALF'.padStart(24) + '   holds?',
);
console.log(pad('', 30) + 'win%'.padStart(8) + 'exp%'.padStart(7) + 'exp-3'.padStart(7) +
  'win%'.padStart(9) + 'exp%'.padStart(7) + 'exp-3'.padStart(7));
console.log('-'.repeat(88));

const rows = grid
  .map((r) => ({ r, a: score(first, r), b: score(second, r) }))
  .sort((x, y) => (y.a.expectancy + y.b.expectancy) - (x.a.expectancy + x.b.expectancy));

for (const { r, a, b } of rows) {
  // Holding means positive in both halves, and still positive in both once each
  // half's three best trades are removed.
  const holds =
    a.expectancy > 0 && b.expectancy > 0 && (a.minusTop3 ?? -1) > 0 && (b.minusTop3 ?? -1) > 0;
  console.log(
    pad(r.label, 30) +
      num(a.winRate, 8) + num(a.expectancy, 7) + num(a.minusTop3, 7) +
      num(b.winRate, 9) + num(b.expectancy, 7) + num(b.minusTop3, 7) +
      (holds ? '   YES' : '   no'),
  );
}

const survivors = rows.filter(
  ({ a, b }) =>
    a.expectancy > 0 && b.expectancy > 0 && (a.minusTop3 ?? -1) > 0 && (b.minusTop3 ?? -1) > 0,
);
console.log(
  survivors.length === 0
    ? '\nNothing held across both halves. A rule that only works on the half it was ' +
        'picked\non is the grid search finding noise, which is what a grid search does.'
    : `\nHeld across both halves: ${survivors.map((s) => s.r.label).join(', ')}`,
);
console.log(
  '\nThis is a weak test, not a strong one: two halves of one recording session share ' +
    'a\nmarket regime. Surviving it is the minimum bar, not evidence of an edge.',
);
