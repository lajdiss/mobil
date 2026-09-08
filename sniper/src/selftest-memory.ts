/**
 * Checks the outcome memory refuses to speak too early, and shrinks hard when it does.
 *
 * Both properties exist because of the same repeated failure in this project: three
 * lucky trades in a bucket look exactly like an edge, and every grid search here that
 * ignored sample size found noise. A memory that scores from its fourth trade would
 * automate that mistake instead of correcting it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeMemory } from './memory.js';

let failures = 0;
const expect = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} got ${JSON.stringify(got)}`);
};
const near = (name: string, got: number | null, want: number, tolerance: number) => {
  const ok = got !== null && Math.abs(got - want) <= tolerance;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} got ${got}`);
};

const dir = mkdtempSync(join(tmpdir(), 'memory-'));
const path = join(dir, 'outcomes.json');
const config = { minTrades: 20, shrinkageStrength: 12 };
const memory = new OutcomeMemory(path, config);

// Cold: a handful of trades, all in one bucket, all winners. Exactly the shape that
// fools a grid search — and the memory must still say nothing.
for (let i = 0; i < 5; i++) memory.record({ tradeRate: 3.0 }, 40);
expect('cold memory is not warm', memory.warm, false);
expect('and scores nothing at all', memory.score({ tradeRate: 3.0 }), null);

// Enough trades to be warm, mostly losers, so the global mean is clearly negative.
for (let i = 0; i < 30; i++) memory.record({ tradeRate: 0.2 }, -10);
expect('enough trades makes it warm', memory.warm, true);

const globalMean = memory.stats().globalPct ?? 0;
near('the global mean is what was recorded', globalMean, (5 * 40 + 30 * -10) / 35, 0.01);

// The five-trade bucket's own mean is +40, but with k=12 it must sit much nearer the
// global mean than its own: (5*40 + globalMean*12) / 17.
const thin = memory.score({ tradeRate: 3.0 });
near('a 5-trade bucket is pulled toward the global mean', thin, (5 * 40 + globalMean * 12) / 17, 0.01);
expect('which keeps it far below its own +40 average', thin !== null && thin < 20, true);

// A bucket with plenty of evidence is allowed to be mostly itself.
for (let i = 0; i < 80; i++) memory.record({ runUpPct: 5 }, 25);
const thick = memory.score({ runUpPct: 5 });
const globalAfter = memory.stats().globalPct ?? 0;
near('an 85-trade bucket is mostly its own average', thick, (80 * 25 + globalAfter * 12) / 92, 0.01);
expect('and it outranks the thin bucket', (thick ?? 0) > (memory.score({ tradeRate: 3.0 }) ?? 0), true);

// Unknown conditions fall back to the global mean rather than to optimism.
near('unseen conditions score the global mean', memory.score({ tradeRate: 1.2 }), globalAfter, 0.01);

// Reload: the counts are the whole asset, and losing them on restart would mean the
// bot begins every run knowing nothing, which is the thing this replaces.
memory.save();
const reloaded = new OutcomeMemory(path, config);
expect('a reload keeps the trade count', reloaded.stats().trades, memory.stats().trades);
near('and the same score', reloaded.score({ runUpPct: 5 }), thick ?? 0, 0.0001);

// A NaN outcome must not silently poison every average that follows.
reloaded.record({ tradeRate: 3.0 }, Number.NaN);
expect('a NaN outcome is refused', reloaded.stats().trades, memory.stats().trades);

console.log(
  failures === 0
    ? '\nAll good. The memory stays quiet while cold and distrusts thin buckets when warm —\n' +
        'without both, it is just a faster way to chase three lucky trades.'
    : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
