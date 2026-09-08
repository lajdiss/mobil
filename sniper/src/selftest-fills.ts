/**
 * Checks the replay pays for its entry fill.
 *
 * The exit side of this bug was found and fixed once: booking a take-profit at the tick
 * that triggered it turned a +1.98% strategy into a +5.21% one on paper. The entry side
 * survived unnoticed for much longer and was worse — filling at the decision tick made
 * the crowd strategy measure 68% win rate and +11.8% expectancy on launches where a
 * 1.5s fill delay produces 51% and -5.3%. Every conclusion drawn from a replay that
 * enters on a fast-moving price depends on this, so it is asserted rather than assumed.
 */
import { entryPathFromLaunch, REPLAY_ENTRY_DELAY_SECONDS, type RecordedLaunch } from './launches.js';

let failures = 0;
const expect = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} got ${JSON.stringify(got)}`);
};

/**
 * A launch whose price doubles every second between the decision and the fill, so a
 * free fill and a paid one cannot be confused for each other.
 */
const rising: RecordedLaunch = {
  mint: 'M', symbol: 'RISE', name: 'rising', launchedAt: 0, feeBps: 100, devBuyPct: 0,
  creatorSales: [],
  samples: Array.from({ length: 40 }, (_, i) => ({
    t: i * 1000,
    // Quote reserves climbing means each token costs more SOL than the second before.
    vt: String(1_000_000_000_000n),
    vq: String(30_000_000_000n + BigInt(i) * 3_000_000_000n),
  })),
};

const free = entryPathFromLaunch(rising, 10, 0);
const paid = entryPathFromLaunch(rising, 10);
expect('both entries exist', free !== null && paid !== null, true);
expect(
  'the default fill delay is the exit sides 1.5s',
  REPLAY_ENTRY_DELAY_SECONDS,
  1.5,
);
expect(
  'a delayed fill on a rising price costs more than the trigger tick',
  (paid?.entrySol ?? 0) > (free?.entrySol ?? 0),
  true,
);
expect(
  'and it starts the path later, so the move before the fill is not counted',
  (paid?.openedAt ?? 0) > (free?.openedAt ?? 0),
  true,
);

// A recording that ends between the decision and the fill has no fill at all, and must
// not silently fall back to the last price it happens to hold.
const truncated: RecordedLaunch = { ...rising, samples: rising.samples.slice(0, 11) };
expect('a recording ending before the fill returns null', entryPathFromLaunch(truncated, 10), null);

console.log(
  failures === 0
    ? '\nAll good. A fill at the trigger price is a measurement of a bot that does not exist.'
    : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
