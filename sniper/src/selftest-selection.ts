/**
 * Checks that the entry queue picks the busiest candidate rather than the first.
 *
 * This exists because the bug it fixes was invisible from the outside: with an
 * activity floor that half of all launches clear, entering on the first qualifying
 * token looks exactly like entering on a good one — the bot reports a filter, a
 * threshold and a purchase, and quietly buys the median every time.
 */
import { PublicKey } from '@solana/web3.js';
import { AttentionTracker } from './attention.js';
import { EntryQueue } from './selection.js';
import type { TradeUpdate } from './pump.js';

const mintOf = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const trade = (mint: PublicKey, buyer: number): TradeUpdate => ({
  mint,
  user: new PublicKey(new Uint8Array(32).fill(buyer)),
  isBuy: true,
  solAmount: 10_000_000n,
  tokenAmount: 1_000_000n,
  virtualTokenReserves: 1_000_000_000n,
  virtualQuoteReserves: 1_000_000_000_000n,
});

const attention = new AttentionTracker();
const released: string[] = [];
let slots = 1;

const queue = new EntryQueue<string>(
  { windowSeconds: 60, maxAgeSeconds: 300, perRound: 1 },
  attention,
  20,
  (token) => released.push(token),
  () => released.length < slots,
);

// Three candidates arriving in order of increasing activity: the quiet one first,
// which is exactly the order that makes first-come entry pick wrong.
const quiet = mintOf(1);
const middling = mintOf(2);
const busy = mintOf(3);
for (const [mint, trades] of [
  [quiet, 6],
  [middling, 20],
  [busy, 90],
] as const) {
  attention.register(mint.toBase58());
  for (let i = 0; i < trades; i++) attention.onTrade(trade(mint, (i % 40) + 1));
  queue.add(mint.toBase58(), mint.toBase58());
}

let failures = 0;
const expect = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got ${JSON.stringify(got)}`);
};

// One round, one slot: the busiest must go, not the one that arrived first.
(queue as unknown as { round: () => void }).round();
expect('one slot goes to the busiest, not the first', released, [busy.toBase58()]);

// Freeing slots lets the rest through in order of activity, not arrival.
slots = 3;
(queue as unknown as { round: () => void }).round();
(queue as unknown as { round: () => void }).round();
expect(
  'the rest follow by activity, not arrival order',
  released,
  [busy.toBase58(), middling.toBase58(), quiet.toBase58()],
);

// With no slots free nothing is released and nothing is lost.
slots = 0;
released.length = 0;
const later = mintOf(9);
attention.register(later.toBase58());
for (let i = 0; i < 30; i++) attention.onTrade(trade(later, i + 1));
queue.add(later.toBase58(), later.toBase58());
(queue as unknown as { round: () => void }).round();
expect('no free slot releases nothing', released, []);
expect('and the candidate is still waiting', queue.size, 1);

console.log(
  failures === 0
    ? '\nAll good. Arrival order must never decide which token gets the slot — that is\n' +
        'the difference between a floor and a selector.'
    : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
