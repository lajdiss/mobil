/**
 * Replays exit rules over recorded price paths.
 *
 * Every live round so far cost hours to evaluate one configuration, and the
 * comparisons were not even paired: a rule that exits faster frees a position slot, so
 * it trades a different set of tokens than the rule it is being compared against. One
 * round measured 31 trades against 12 and called it an A/B.
 *
 * Here every configuration sees the identical trades, and a grid of them runs in
 * seconds. Win rate and expectancy are always printed together, because win rate on
 * its own is a dial: the break-even rate is stopLoss / (takeProfit + stopLoss) plus
 * fees, so a rule can lift win rate well past 60% and still lose money on every pass.
 *
 *   npm run replay -- data/paths.jsonl
 */
import { readFileSync } from 'node:fs';
import type { RecordedPath } from './recorder.js';
import { rule, simulate, type ExitRule } from './exitrules.js';

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function evaluate(paths: RecordedPath[], rule: ExitRule) {
  const outcomes = paths.map((p) => simulate(p, rule));
  if (process.env.REPLAY_DEBUG === rule.label) {
    outcomes.forEach((o, i) =>
      console.log(`  [debug] ${paths[i].symbol}: ${o.pct.toFixed(2)}% via ${o.reason} at ${o.heldSeconds}s`),
    );
  }
  const wins = outcomes.filter((o) => o.pct > 0).length;
  const pcts = outcomes.map((o) => o.pct);
  const expectancy = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const avgFeeBps = paths.reduce((a, p) => a + p.feeBps, 0) / paths.length;
  // w·TP = (1 − w)·SL, with the round trip's fees on top.
  const breakEven =
    ((rule.stopLossPct + (avgFeeBps / 100) * 2) / (rule.takeProfitPct + rule.stopLossPct)) * 100;

  const reasons: Record<string, number> = {};
  for (const o of outcomes) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;

  return {
    rule,
    winRate: (wins / outcomes.length) * 100,
    breakEven,
    expectancy,
    median: median(pcts),
    best: Math.max(...pcts),
    worst: Math.min(...pcts),
    avgHold: outcomes.reduce((a, o) => a + o.heldSeconds, 0) / outcomes.length,
    reasons,
    // With a fat tail, the mean is one lucky trade away from meaningless. This says
    // how much of the total the three best contributed.
    top3Share: (() => {
      const sorted = [...pcts].sort((a, b) => b - a);
      const total = pcts.reduce((a, b) => a + b, 0);
      return total > 0 ? (sorted.slice(0, 3).reduce((a, b) => a + b, 0) / total) * 100 : null;
    })(),
  };
}

function buildGrid(): ExitRule[] {
  const rules: ExitRule[] = [
    rule('buy and hold (no exit)', { takeProfitPct: 1e6, stopLossPct: 99.9, maxHoldSeconds: 1e6 }),
  ];
  for (const tp of [15, 30, 50, 100, 200]) {
    for (const sl of [10, 20, 30, 50]) {
      rules.push(rule(`TP${tp} / SL${sl}`, { takeProfitPct: tp, stopLossPct: sl }));
    }
  }
  for (const trail of [10, 20, 35]) {
    rules.push(rule(`trail ${trail}%`, { takeProfitPct: 1e6, stopLossPct: 50, trailingStopPct: trail }));
  }
  for (const partial of [15, 25, 40]) {
    for (const share of [30, 50, 70]) {
      rules.push(
        rule(`partial ${share}% at +${partial}`, {
          partialTakeProfitPct: partial,
          partialSellPct: share,
        }),
      );
    }
  }
  for (const bps of [25, 50, 150]) {
    rules.push(rule(`dev-sell exit >${bps}bps`, { creatorSellMinBps: bps }));
    rules.push(
      rule(`dev-sell >${bps}bps + partial 50% at +25`, {
        creatorSellMinBps: bps,
        partialTakeProfitPct: 25,
      }),
    );
  }
  for (const hold of [60, 120, 600]) {
    rules.push(rule(`hold ${hold}s`, { maxHoldSeconds: hold }));
  }
  return rules;
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? 'data/paths.jsonl';
// Ranking by win rate answers "which rule wins most often"; ranking by expectancy
// answers "which rule makes money". They are rarely the same rule, which is the point.
const sortBy = args.includes('--sort=wr') ? 'wr' : 'exp';
const paths: RecordedPath[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as RecordedPath);

if (paths.length === 0) {
  console.log(`no recorded paths in ${file}`);
  process.exit(1);
}

const coverage = paths.map((p) => p.samples[p.samples.length - 1].t / 1000);
console.log(`${paths.length} recorded paths from ${file}`);
console.log(
  `each followed for a median of ${median(coverage).toFixed(0)}s ` +
    `(shortest ${Math.min(...coverage).toFixed(0)}s, longest ${Math.max(...coverage).toFixed(0)}s)`,
);
console.log(
  'A rule needing longer than a path was recorded for cannot be judged from it — ' +
    'those show as path-ended.\n',
);

const results = buildGrid()
  .map((r) => evaluate(paths, r))
  .sort((a, b) => (sortBy === 'wr' ? b.winRate - a.winRate : b.expectancy - a.expectancy));

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n: number, digits = 1) => v.toFixed(digits).padStart(n);

console.log(`ranked by ${sortBy === 'wr' ? 'win rate' : 'expectancy'}\n`);
console.log(
  pad('rule', 32) + 'win%'.padStart(7) + 'need'.padStart(7) + 'exp%'.padStart(8) +
    'med%'.padStart(8) + 'worst'.padStart(8) + 'hold'.padStart(7) + '  top3',
);
console.log('-'.repeat(84));
for (const r of results) {
  console.log(
    pad(r.rule.label, 32) +
      num(r.winRate, 7) +
      num(r.breakEven, 7) +
      num(r.expectancy, 8, 2) +
      num(r.median, 8, 2) +
      num(r.worst, 8, 1) +
      num(r.avgHold, 7, 0) +
      (r.top3Share === null ? '     —' : num(r.top3Share, 6, 0) + '%'),
  );
}

const cleared = results.filter((r) => r.winRate > r.breakEven && r.expectancy > 0);
console.log(
  '\nwin% is the share of trades that made money; need is the win rate that rule ' +
    'requires\njust to break even after fees. A rule beating its own "need" is the ' +
    'only kind worth having.',
);
console.log(
  cleared.length === 0
    ? '\nNo rule cleared its own break-even on this sample.'
    : `\n${cleared.length} rule(s) cleared their own break-even: ` +
        cleared.map((r) => r.rule.label).join(', '),
);
