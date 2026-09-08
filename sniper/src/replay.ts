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
  if (process.env.REPLAY_REASONS === rule.label) {
    const by: Record<string, { n: number; sum: number }> = {};
    for (const o of outcomes) {
      const e = (by[o.reason] ??= { n: 0, sum: 0 });
      e.n++;
      e.sum += o.pct;
    }
    console.log(`  [reasons for ${rule.label}]`);
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`    ${k.padEnd(14)} n=${String(v.n).padStart(3)}  mean ${(v.sum / v.n).toFixed(2)}%`);
    }
  }
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
  // The break-even formula assumes every trade ends at the take-profit or the
  // stop-loss. Once most exits are timeouts landing a couple of percent from entry,
  // it describes nothing — a rule can sit far below its "need" and still make money
  // because its losers are small. Expectancy is the arbiter then, not the ratio.
  const atThreshold =
    ((reasons['take-profit'] ?? 0) + (reasons['stop-loss'] ?? 0)) / outcomes.length;

  return {
    rule,
    winRate: (wins / outcomes.length) * 100,
    breakEven,
    breakEvenApplies: atThreshold >= 0.7,
    thresholdSharePct: atThreshold * 100,
    expectancy,
    median: median(pcts),
    best: Math.max(...pcts),
    worst: Math.min(...pcts),
    avgHold: outcomes.reduce((a, o) => a + o.heldSeconds, 0) / outcomes.length,
    reasons,
    // With a fat tail, the mean is one lucky trade away from meaningless. This says
    // how much of the total the three best contributed.
    // The sharpest robustness test there is: drop the three best trades and see what
    // is left. A real edge survives it; a mean carried by outliers collapses.
    expectancyMinusTop3: (() => {
      if (pcts.length <= 3) return null;
      const trimmed = [...pcts].sort((a, b) => b - a).slice(3);
      return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    })(),
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
  // The lower end is deliberately below where the previous sweep bottomed out. TP15
  // won that grid while sitting on its own edge, which usually means the optimum is
  // outside it. The floor is the round trip's fees — roughly 2% on the curve — so a
  // target under that cannot clear costs however often it is hit.
  for (const tp of [4, 6, 8, 10, 15, 30, 50, 100, 200]) {
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
  // Short holds are in because 39% of recorded tokens peaked within five seconds of
  // the entry: if the move is already over, sitting through it is the loss.
  for (const hold of [10, 20, 30, 60, 120, 600]) {
    rules.push(rule(`hold ${hold}s`, { maxHoldSeconds: hold }));
  }
  // The same idea combined with a tight target.
  for (const hold of [15, 30, 60]) {
    rules.push(
      rule(`TP8 / SL15, hold ${hold}s`, {
        takeProfitPct: 8,
        stopLossPct: 15,
        maxHoldSeconds: hold,
      }),
    );
  }
  return rules;
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? 'data/paths.jsonl';
// Ranking by win rate answers "which rule wins most often"; ranking by expectancy
// answers "which rule makes money". They are rarely the same rule, which is the point.
const sortBy = args.includes('--sort=wr') ? 'wr' : 'exp';
const sweepLatency = args.includes('--latency');
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

/**
 * How much the exit's own latency costs.
 *
 * The replay used to fill at the sample that triggered the exit, and a 10% target was
 * booking its take-profits at an average of +27% — the price gaps past the threshold
 * between samples and the fill was taken at the top of the gap. Real exits land a
 * second or two after the rule fires, and this measures what that second is worth.
 *
 * It is the most decision-relevant number the replay produces, because unlike a
 * parameter it cannot be tuned: buying lower latency costs money.
 */
if (sweepLatency) {
  console.log('COST OF EXIT LATENCY — best rule at each delay, same paths\n');
  console.log(
    'delay'.padStart(7) + 'best rule'.padStart(22) + 'win%'.padStart(8) +
      'exp%'.padStart(9) + 'exp-3'.padStart(9) + '  top3',
  );
  console.log('-'.repeat(60));
  for (const delay of [0, 0.5, 1, 1.5, 2, 3, 5]) {
    const scored = buildGrid()
      .map((r) => evaluate(paths, { ...r, executionDelaySeconds: delay }))
      .sort((a, b) => b.expectancy - a.expectancy);
    const best = scored[0];
    console.log(
      `${delay}s`.padStart(7) +
        best.rule.label.padStart(22) +
        best.winRate.toFixed(1).padStart(8) +
        best.expectancy.toFixed(2).padStart(9) +
        (best.expectancyMinusTop3 ?? 0).toFixed(2).padStart(9) +
        (best.top3Share === null ? '     —' : best.top3Share.toFixed(0).padStart(5) + '%'),
    );
  }
  console.log(
    '\nEvery rule sees identical paths; only the moment the sale prices moves. A\n' +
      'strategy that is profitable at 0s and loses at 3s does not have an edge in its\n' +
      'rule — it has one in its infrastructure, and that one has a price.',
  );
  process.exit(0);
}

const results = buildGrid()
  .map((r) => evaluate(paths, r))
  .sort((a, b) => (sortBy === 'wr' ? b.winRate - a.winRate : b.expectancy - a.expectancy));

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n: number, digits = 1) => v.toFixed(digits).padStart(n);

console.log(`ranked by ${sortBy === 'wr' ? 'win rate' : 'expectancy'}\n`);
console.log(
  pad('rule', 32) + 'win%'.padStart(7) + 'need'.padStart(7) + 'exp%'.padStart(8) +
    'exp-3'.padStart(8) + 'med%'.padStart(8) + 'worst'.padStart(8) + 'hold'.padStart(7) + '  top3',
);
console.log('-'.repeat(84));
for (const r of results) {
  console.log(
    pad(r.rule.label, 32) +
      num(r.winRate, 7) +
      (r.breakEvenApplies ? num(r.breakEven, 7) : '    n/a') +
      num(r.expectancy, 8, 2) +
      (r.expectancyMinusTop3 === null ? '       —' : num(r.expectancyMinusTop3, 8, 2)) +
      num(r.median, 8, 2) +
      num(r.worst, 8, 1) +
      num(r.avgHold, 7, 0) +
      (r.top3Share === null ? '     —' : num(r.top3Share, 6, 0) + '%'),
  );
}

// Positive expectancy is what "worth having" means. The win-rate-versus-need test is
// a shortcut that only holds when trades actually end at a threshold.
const cleared = results.filter(
  (r) => r.expectancy > 0 && (!r.breakEvenApplies || r.winRate > r.breakEven),
);
console.log(
  '\nwin% is the share of trades that made money; need is the win rate that rule ' +
    'requires\njust to break even after fees — shown as n/a when fewer than 70% of ' +
    'exits land at\nthe take-profit or stop-loss, because the formula assumes they all do.',
);
console.log(
  cleared.length === 0
    ? '\nNo rule made money on this sample.'
    : `\n${cleared.length} rule(s) made money on this sample: ` +
        cleared
          .map((r) => `${r.rule.label} (${r.expectancy.toFixed(2)}%)`)
          .join(', ') +
        `\nOf those, ${
          cleared.filter((r) => (r.expectancyMinusTop3 ?? -1) > 0).length
        } still make money with their three best trades removed (exp-3 column).` +
        '\nA mean carried by three trades out of eighty is an outlier, not an edge.',
);
