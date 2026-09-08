import { PublicKey } from '@solana/web3.js';
import type { RpcEndpoint } from './config.js';
import { LogStream, decodeLogEvents } from './logstream.js';
import {
  PUMPSWAP_PROGRAM,
  SWAP_BUY_EVENT_DISCRIMINATOR,
  SWAP_SELL_EVENT_DISCRIMINATOR,
  decodeSwapTradePrefix,
  graduatedPoolPda,
  type SwapTrade,
} from './pumpswap.js';

/** The AMM is quieter per pool than the bonding curve, so it gets a longer budget. */
const STALE_STREAM_MS = 60_000;

export interface GraduateConfig {
  /** Quote-side liquidity the pool must hold, in SOL. */
  minLiquiditySol: number;
  /** Buys observed since graduation — one whale is not interest. */
  minBuys: number;
  /** Time to let the graduation dump play out before entering, in seconds. */
  minAgeSeconds: number;
  /** Past this, the graduation is no longer the reason anything is happening. */
  maxAgeSeconds: number;
  /** Buy share of all swaps; below this the pool is being sold into. */
  minBuyRatio: number;
}

export interface GraduateCandidate {
  mint: PublicKey;
  pool: PublicKey;
  graduatedAt: number;
  buys: number;
  sells: number;
  liquiditySol: number;
  baseReserves: bigint;
  quoteReserves: bigint;
}

/**
 * Watches tokens that made it off the bonding curve.
 *
 * Every entry mode before this one was a race, and eighteen measured rounds said the
 * same thing: the whole edge lives in the first few hundred milliseconds and a public
 * RPC cannot get there. A graduated token is the one setup where that stops being
 * true — the pool already exists, liquidity is real rather than virtual, the swap fee
 * is 30bps against the curve's 100, and nothing about the entry depends on being
 * first. Whether that is enough to be profitable is the open question; this module
 * exists to answer it with the same instrumentation as every other round.
 *
 * Graduation is detected from the bonding curve, not the AMM. The obvious route —
 * CreatePoolEvent — cannot work: create_pool emits through emit_cpi, so the event
 * lives in an inner instruction and never reaches a log subscription. Checked against
 * the migration transaction of a real graduated pool, whose logs carry a swap event
 * and no pool event at all. What is visible is the curve emptying: a pump.fun trade
 * that leaves realTokenReserves at zero has just filled the curve, and the pool
 * address follows from the mint by derivation.
 */
export class GraduateWatcher {
  private readonly stream: LogStream;
  private candidates = new Map<string, GraduateCandidate>();
  /** Pool address -> base mint, so swap events can be attributed without a lookup. */
  private poolToMint = new Map<string, string>();

  readonly counters = { graduations: 0, swaps: 0, entered: 0, poolsSeen: 0 };

  constructor(
    endpoints: RpcEndpoint[],
    private readonly config: GraduateConfig,
    private readonly onReady: (candidate: GraduateCandidate) => void,
    private readonly onSwap: (trade: SwapTrade, baseMint: PublicKey | null) => void,
    onError: (message: string) => void,
  ) {
    this.stream = new LogStream(
      endpoints,
      PUMPSWAP_PROGRAM,
      STALE_STREAM_MS,
      (lines) => this.handleBatch(lines),
      onError,
    );
  }

  start() {
    this.stream.start();
    // Age alone can make a candidate stale, and a pool nobody trades would otherwise
    // sit in the map forever.
    setInterval(() => this.sweep(), 5000).unref();
  }

  async stop() {
    await this.stream.stop();
  }

  health() {
    return { ...this.stream.health(), ...this.counters, watching: this.candidates.size };
  }

  get watching(): number {
    return this.candidates.size;
  }

  /**
   * Called for every pump.fun trade that empties the curve. The migrator creates the
   * pool seconds to minutes later, so the candidate starts with no liquidity reading
   * at all and only becomes eligible once swaps on its pool start arriving — which is
   * also the proof that the pool exists.
   */
  noteCurveComplete(mint: PublicKey) {
    const key = mint.toBase58();
    if (this.candidates.has(key)) return;
    const pool = graduatedPoolPda(mint);
    this.counters.graduations++;
    this.poolToMint.set(pool.toBase58(), key);
    this.candidates.set(key, {
      mint,
      pool,
      graduatedAt: Date.now(),
      buys: 0,
      sells: 0,
      liquiditySol: 0,
      baseReserves: 0n,
      quoteReserves: 0n,
    });
  }

  /** Keeps a pool mapped after its candidate is gone, so a position stays priced. */
  track(pool: PublicKey, baseMint: PublicKey) {
    this.poolToMint.set(pool.toBase58(), baseMint.toBase58());
  }

  untrack(pool: PublicKey) {
    this.poolToMint.delete(pool.toBase58());
  }

  private handleBatch(lines: string[]) {
    for (const data of decodeLogEvents(lines)) {
      const discriminator = data.subarray(0, 8);
      const isBuy = discriminator.equals(SWAP_BUY_EVENT_DISCRIMINATOR);
      if (!isBuy && !discriminator.equals(SWAP_SELL_EVENT_DISCRIMINATOR)) continue;

      const trade = decodeSwapTradePrefix(data, isBuy);
      if (!trade) continue;
      this.counters.swaps++;

      const mintKey = this.poolToMint.get(trade.pool.toBase58());
      this.onSwap(trade, mintKey ? new PublicKey(mintKey) : null);
      if (!mintKey) continue;

      const candidate = this.candidates.get(mintKey);
      if (!candidate) continue;
      if (candidate.buys + candidate.sells === 0) this.counters.poolsSeen++;

      if (isBuy) candidate.buys++;
      else candidate.sells++;
      candidate.baseReserves = trade.poolBaseReserves;
      candidate.quoteReserves = trade.poolQuoteReserves;
      candidate.liquiditySol = Number(trade.poolQuoteReserves) / 1e9;

      this.evaluate(mintKey, candidate);
    }
  }

  /**
   * The minimum age is the whole hypothesis. Entering the moment a pool opens is the
   * same race that failed eighteen times over; waiting lets the graduation dump clear
   * and asks instead whether buyers are still there afterwards.
   */
  private evaluate(key: string, candidate: GraduateCandidate) {
    const ageSeconds = (Date.now() - candidate.graduatedAt) / 1000;
    if (ageSeconds > this.config.maxAgeSeconds) {
      this.candidates.delete(key);
      return;
    }
    if (ageSeconds < this.config.minAgeSeconds) return;

    const swaps = candidate.buys + candidate.sells;
    const buyRatio = swaps > 0 ? candidate.buys / swaps : 0;
    if (
      candidate.liquiditySol >= this.config.minLiquiditySol &&
      candidate.buys >= this.config.minBuys &&
      buyRatio >= this.config.minBuyRatio
    ) {
      this.candidates.delete(key);
      this.counters.entered++;
      this.onReady(candidate);
    }
  }

  private sweep() {
    for (const [key, candidate] of this.candidates) this.evaluate(key, candidate);
    // Pool mappings outlive their candidate so open positions stay priced, but not
    // forever — every graduation adds one.
    if (this.poolToMint.size > 5000) this.poolToMint.clear();
  }
}
