/**
 * Checks the crowd window against sequences with known answers.
 *
 * The two figures it produces decide entries, and both are easy to get subtly wrong:
 * a rate that counts the wrong window, or a run-up whose sign is inverted because the
 * price of a holding moves opposite to the token reserves. Neither would crash.
 */
import { PublicKey } from '@solana/web3.js';
import { AttentionTracker } from './attention.js';
import type { TradeUpdate } from './pump.js';

const MINT = new PublicKey(new Uint8Array(32).fill(7));
const wallet = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

/** A trade on a pool holding `quoteSol` against a fixed token side. */
const trade = (quoteSol: number, isBuy = true, buyer = 1): TradeUpdate => ({
  mint: MINT,
  user: wallet(buyer),
  isBuy,
  solAmount: 10_000_000n,
  tokenAmount: 1_000_000n,
  virtualTokenReserves: 1_000_000_000n,
  virtualQuoteReserves: BigInt(Math.round(quoteSol * 1e9)),
});

let failures = 0;
const check = (name: string, got: number, want: number, tolerance: number) => {
  const ok = Math.abs(got - want) <= tolerance;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got ${got.toFixed(2)}, expected ~${want}`,
  );
};

// --- rate ---------------------------------------------------------------------------
{
  const tracker = new AttentionTracker();
  const t0 = Date.now();
  tracker.register(MINT.toBase58(), t0);
  // 20 trades, all inside the last 10 seconds.
  for (let i = 0; i < 20; i++) tracker.onTrade(trade(1000));
  const crowd = tracker.crowd(MINT.toBase58(), 10, t0 + 10_000);
  check('20 trades in a 10s window -> 2 trades/s', crowd?.tradeRate ?? -1, 2, 0.01);
}

// --- run-up sign --------------------------------------------------------------------
{
  const tracker = new AttentionTracker();
  const t0 = Date.now();
  tracker.register(MINT.toBase58(), t0);
  // Quote reserves rising means the pool holds more SOL against the same tokens, so a
  // holding is worth more: a positive run-up.
  for (const sol of [1000, 1100, 1200, 1300, 1500]) tracker.onTrade(trade(sol));
  const up = tracker.crowd(MINT.toBase58(), 60, t0 + 1000);
  check('price 1000 -> 1500 reads as +50%', up?.runUpPct ?? 0, 50, 0.1);

  const falling = new AttentionTracker();
  falling.register(MINT.toBase58(), t0);
  for (const sol of [1000, 900, 800, 700, 500]) falling.onTrade(trade(sol));
  const down = falling.crowd(MINT.toBase58(), 60, t0 + 1000);
  check('price 1000 -> 500 reads as -50%', down?.runUpPct ?? 0, -50, 0.1);
}

// --- fails closed -------------------------------------------------------------------
{
  const tracker = new AttentionTracker();
  tracker.register(MINT.toBase58());
  for (let i = 0; i < 3; i++) tracker.onTrade(trade(1000));
  const thin = tracker.crowd(MINT.toBase58(), 20);
  const ok = thin === null;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${'three trades is too few to judge -> null'.padEnd(46)} ` +
      `got ${thin === null ? 'null' : JSON.stringify(thin)}`,
  );

  const unknown = tracker.crowd('a-mint-nobody-registered', 20);
  const ok2 = unknown === null;
  if (!ok2) failures++;
  console.log(
    `${ok2 ? 'PASS' : 'FAIL'}  ${'unregistered mint -> null, not zero'.padEnd(46)} ` +
      `got ${unknown === null ? 'null' : JSON.stringify(unknown)}`,
  );
}

console.log(
  failures === 0
    ? '\nAll good. A null reading has to mean "not known", never "quiet" — the entry\n' +
        'gate treats them differently and only one of them is safe to trade on.'
    : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
