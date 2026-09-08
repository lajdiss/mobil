/**
 * Runs one identical price path twice — once all-or-nothing, once scaling out — so the
 * difference is attributable to the exit rule and nothing else.
 *
 * The path is the common one: a token pops, gives it all back, then keeps falling.
 * That is the shape a stop-loss turns into a full loss, and the shape a partial exit
 * is supposed to rescue.
 */
import { PublicKey } from '@solana/web3.js';
import { PositionManager, type Position } from './positions.js';
import type { Config } from './config.js';
import { poolQuote } from './pumpswap.js';

const MINT = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const CREATOR = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const TOKENS = 10n ** 6n;

const quoteAt = (sol: number) => poolQuote(1000n * 10n ** 6n, BigInt(Math.round(sol * 1e9)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(partialPct: number) {
  let priceQuote = quoteAt(1000);
  const sells: number[] = [];
  const logs: string[] = [];

  const executor = {
    feeBps: 100,
    async sell(_m: PublicKey, _c: PublicKey, _t: PublicKey, amount: bigint) {
      const q = priceQuote;
      const out = (amount * q.virtualQuoteReserves) / (q.virtualTokenReserves + amount);
      const solOut = Number(out) / 1e9;
      sells.push(solOut);
      return { result: null, solOut, rentReclaimed: false };
    },
    async getBondingCurves() {
      return new Map();
    },
  } as never;

  const config = {
    takeProfitPct: 100,
    stopLossPct: 30,
    trailingStopPct: 0,
    maxHoldSeconds: 99999,
    partialTakeProfitPct: partialPct,
    partialSellPct: 50,
    breakEvenAfterPartial: true,
    exitOnCreatorSell: true,
    dryRun: true,
  } as unknown as Config;

  const pm = new PositionManager(executor, config, () => {}, (m) => logs.push(m));
  const entrySol =
    Number((TOKENS * priceQuote.virtualQuoteReserves) / (priceQuote.virtualTokenReserves + TOKENS)) / 1e9;

  const position: Position = {
    mint: MINT, venue: 'pump', name: 'test', symbol: 'TEST', creator: CREATOR,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    tokenAmount: TOKENS, initialTokenAmount: TOKENS, realisedSol: 0, partialsTaken: 0,
    stopAtBreakEven: false, entrySol, currentSol: entrySol, peakSol: entrySol, pnlPct: 0,
    openedAt: Date.now(), status: 'open', history: [0], progressPct: 0, marketCapSol: 0,
  };
  pm.add(position);

  const apply = (sol: number) => {
    priceQuote = quoteAt(sol);
    (pm as unknown as { applyCurve: (m: string, c: unknown, s: string) => void }).applyCurve(
      MINT, priceQuote, 'poll',
    );
  };

  // pop to +60%, give it all back, then keep falling to -50% of the entry price
  for (const price of [1600, 1400, 1000, 800, 500]) {
    apply(price);
    await wait(30);
  }

  // The paths end while the scaled position is still open — that is the point, not a
  // problem, so both are closed at the same price and compared on realised SOL.
  if (position.status === 'open') await pm.close(MINT, 'manual');
  await wait(30);

  return { position, entrySol, sells, logs, perf: pm.performance() };
}

const plain = await run(0);
const scaled = await run(40);

const show = (label: string, r: Awaited<ReturnType<typeof run>>) => {
  const p = r.position;
  const pct = p.exitSol !== undefined ? ((p.exitSol - r.entrySol) / r.entrySol) * 100 : NaN;
  console.log(`\n${label}`);
  console.log('  exit reason  ', p.exitReason);
  console.log('  partials     ', p.partialsTaken, p.realisedSol > 0 ? `(banked ${p.realisedSol.toFixed(4)} SOL)` : '');
  console.log('  SOL out      ', p.exitSol?.toFixed(4), 'vs', r.entrySol.toFixed(4), 'in');
  console.log('  result       ', pct.toFixed(2) + '%');
  console.log('  win rate     ', r.perf.winRatePct?.toFixed(0) + '%');
  return pct;
};

const a = show('all-or-nothing (TP100 / SL30)', plain);
const b = show('scaled out (50% banked at +40%, then break-even stop)', scaled);

console.log('\ndifference on the identical path:', (b - a).toFixed(2), 'points');
const ok =
  plain.position.exitReason === 'stop-loss' &&
  scaled.position.partialsTaken === 1 &&
  scaled.position.tokenAmount === TOKENS / 2n &&
  b > a;
console.log(ok ? '\nPASS' : '\nFAIL');

// --- creator sell ------------------------------------------------------------------

/**
 * The creator dumping their own supply arrives in the same stream that prices the
 * position, several samples before the stop-loss would notice the damage. This checks
 * the bot acts on the seller's identity rather than waiting for the price.
 */
async function creatorSellScenario(exitOnCreatorSell: boolean, sellSol: number) {
  let priceQuote = quoteAt(1000);
  const executor = {
    feeBps: 100,
    async sell(_m: PublicKey, _c: PublicKey, _t: PublicKey, amount: bigint) {
      const out =
        (amount * priceQuote.virtualQuoteReserves) / (priceQuote.virtualTokenReserves + amount);
      return { result: null, solOut: Number(out) / 1e9, rentReclaimed: false };
    },
    async getBondingCurves() {
      return new Map();
    },
  } as never;

  const config = {
    takeProfitPct: 100, stopLossPct: 30, trailingStopPct: 0, maxHoldSeconds: 99999,
    partialTakeProfitPct: 0, partialSellPct: 50, breakEvenAfterPartial: true,
    exitOnCreatorSell, creatorSellMinBps: 50, dryRun: true,
  } as unknown as Config;

  const pm = new PositionManager(executor, config, () => {}, () => {});
  const entrySol =
    Number((TOKENS * priceQuote.virtualQuoteReserves) / (priceQuote.virtualTokenReserves + TOKENS)) /
    1e9;
  pm.add({
    mint: MINT, venue: 'pump', name: 'test', symbol: 'TEST', creator: CREATOR,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    tokenAmount: TOKENS, initialTokenAmount: TOKENS, realisedSol: 0, partialsTaken: 0,
    stopAtBreakEven: false, entrySol, currentSol: entrySol, peakSol: entrySol, pnlPct: 0,
    openedAt: Date.now(), status: 'open', history: [0], progressPct: 0, marketCapSol: 0,
  });

  // The creator sells while the price is still barely moved — which is exactly when
  // the information is worth something.
  priceQuote = quoteAt(950);
  pm.onTrade({
    mint: new PublicKey(MINT),
    user: new PublicKey(CREATOR),
    isBuy: false,
    solAmount: BigInt(Math.round(sellSol * 1e9)),
    tokenAmount: 0n,
    virtualTokenReserves: priceQuote.virtualTokenReserves,
    virtualQuoteReserves: priceQuote.virtualQuoteReserves,
  });
  await wait(40);

  const position = pm.list()[0];
  const pct =
    position.exitSol !== undefined ? ((position.exitSol - entrySol) / entrySol) * 100 : NaN;
  return { position, pct };
}

// 50 SOL out of a 950 SOL pool is 526bps — a dump. 1 SOL is 10bps — pocket money.
const ignored = await creatorSellScenario(false, 50);
const acted = await creatorSellScenario(true, 50);
const dust = await creatorSellScenario(true, 1);

console.log('\ncreator sells while the price is barely moved:');
console.log('  rule off, 50 SOL dump ->', ignored.position.status, ignored.position.exitReason ?? '(still holding)');
console.log('  rule on,  50 SOL dump ->', acted.position.status, acted.position.exitReason, acted.pct.toFixed(2) + '%');
console.log('  rule on,  1 SOL trim  ->', dust.position.status, dust.position.exitReason ?? '(still holding, correctly)');

const devOk =
  ignored.position.status === 'open' &&
  acted.position.status === 'closed' &&
  acted.position.exitReason === 'dev-sold' &&
  // A creator taking a little off the table is not a rug; exiting on it would give up
  // good positions for nothing.
  dust.position.status === 'open';
console.log(devOk ? 'PASS' : 'FAIL');

process.exit(ok && devOk ? 0 : 1);

