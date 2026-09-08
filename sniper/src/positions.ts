import { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import { Executor, lamportsToSol } from './executor.js';
import { solForTokens, type CurveQuote, type TradeUpdate } from './pump.js';
import { poolQuote, type SwapPool, type SwapTrade } from './pumpswap.js';

export type PositionStatus = 'open' | 'closing' | 'closed' | 'failed';
export type ExitReason = 'take-profit' | 'stop-loss' | 'trailing-stop' | 'timeout' | 'manual';

/** Which market the position lives in — the bonding curve, or the AMM after it. */
export type Venue = 'pump' | 'pumpswap';

export interface Position {
  mint: string;
  venue: Venue;
  name: string;
  symbol: string;
  creator: string;
  tokenProgram: string;
  tokenAmount: bigint;
  entrySol: number;
  currentSol: number;
  peakSol: number;
  pnlPct: number;
  openedAt: number;
  status: PositionStatus;
  exitReason?: ExitReason;
  exitSol?: number;
  buySignature?: string;
  sellSignature?: string;
  error?: string;
  /** PnL at the moment the exit rule fired. */
  triggerPnlPct?: number;
  /** How far past the stop-loss threshold the exit actually landed. */
  overshootPct?: number;
  /** Where the price update that triggered the exit came from. */
  triggerSource?: 'stream' | 'poll';
  lastSeenAt?: number;
  sellAttempts?: number;
  /** Recent PnL samples, for the sparkline — the shape matters more than the number. */
  history: number[];
  /** How far the bonding curve has filled toward graduation, 0-100. */
  progressPct: number;
  marketCapSol: number;
}

/** Tokens left in the curve at launch; what remains measures progress to graduation. */
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

/** Keeps the sparkline cheap and the state payload small. */
const HISTORY_SAMPLES = 40;

/** A failed exit is retried rather than abandoned, but not forever. */
const MAX_SELL_ATTEMPTS = 4;

export interface Performance {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Win rate needed just to break even at the current take-profit and stop-loss. */
  breakEvenPct: number;
  netSol: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  /**
   * Average and median result per trade. With most exits landing on a timeout rather
   * than on either threshold, win rate against break-even stops describing anything —
   * these do.
   */
  expectancyPct: number | null;
  medianPct: number | null;
  /** Share of all profit coming from the three best trades. */
  top3SharePct: number | null;
  /** True when the TP/SL break-even comparison actually applies to this exit mix. */
  breakEvenApplies: boolean;
  /** Stop-loss exits, and how far past the threshold they actually landed. */
  stopLossExits: number;
  avgOvershootPct: number | null;
  worstOvershootPct: number | null;
  /** Stop-losses that gapped straight through the threshold rather than crossing it. */
  gapExits: number;
}

export class PositionManager {
  private positions = new Map<string, Position>();
  /**
   * AMM positions need the pool and its token program to be sold, and neither belongs
   * in the dashboard payload. Kept alongside rather than inside the position.
   */
  private swapPools = new Map<string, { pool: SwapPool; baseTokenProgram: PublicKey }>();
  private timeoutTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly executor: Executor,
    private readonly config: Config,
    private readonly onChange: (position: Position) => void,
    private readonly onLog: (message: string) => void,
  ) {}

  has(mint: string): boolean {
    return this.positions.has(mint);
  }

  list(): Position[] {
    return [...this.positions.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  openCount(): number {
    return this.list().filter((p) => p.status === 'open' || p.status === 'closing').length;
  }

  performance(): Performance {
    const closed = this.list().filter(
      (p): p is Position & { exitSol: number } => p.status === 'closed' && p.exitSol !== undefined,
    );
    const results = closed.map((p) => ({
      pct: p.entrySol > 0 ? ((p.exitSol - p.entrySol) / p.entrySol) * 100 : 0,
      sol: p.exitSol - p.entrySol,
    }));
    const wins = results.filter((r) => r.pct > 0);
    const losses = results.filter((r) => r.pct <= 0);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const overshoots = closed
      .filter((p) => p.exitReason === 'stop-loss' && p.overshootPct !== undefined)
      .map((p) => p.overshootPct as number);

    const median = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const totalSol = results.reduce((a, r) => a + r.sol, 0);
    const top3 = [...results].sort((a, b) => b.sol - a.sol).slice(0, 3);
    const top3Share =
      results.length >= 3 && totalSol > 0
        ? (top3.reduce((a, r) => a + r.sol, 0) / totalSol) * 100
        : null;
    const thresholdExits = closed.filter(
      (p) => p.exitReason === 'take-profit' || p.exitReason === 'stop-loss',
    ).length;

    const { takeProfitPct, stopLossPct } = this.config;
    // Both sides of the round trip, read from the program rather than assumed.
    const roundTripFeePct = (this.executor.feeBps / 100) * 2;
    // w·(TP − fee) = (1 − w)·(SL + fee)  ->  w = (SL + fee) / (TP + SL)
    const breakEven = ((stopLossPct + roundTripFeePct) / (takeProfitPct + stopLossPct)) * 100;

    return {
      closed: results.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: results.length ? (wins.length / results.length) * 100 : null,
      breakEvenPct: breakEven,
      netSol: results.reduce((a, r) => a + r.sol, 0),
      avgWinPct: wins.length ? mean(wins.map((r) => r.pct)) : null,
      avgLossPct: losses.length ? mean(losses.map((r) => r.pct)) : null,
      bestPct: results.length ? Math.max(...results.map((r) => r.pct)) : null,
      worstPct: results.length ? Math.min(...results.map((r) => r.pct)) : null,
      expectancyPct: results.length ? mean(results.map((r) => r.pct)) : null,
      medianPct: results.length ? median(results.map((r) => r.pct)) : null,
      top3SharePct: top3Share,
      // The break-even formula assumes every trade ends at take-profit or stop-loss.
      // Once a meaningful share exits on a timeout instead, it describes nothing.
      breakEvenApplies: results.length > 0 && thresholdExits / results.length >= 0.7,
      stopLossExits: overshoots.length,
      avgOvershootPct: overshoots.length ? mean(overshoots) : null,
      worstOvershootPct: overshoots.length ? Math.min(...overshoots) : null,
      // More than 5 points past the threshold means the price never traded through it.
      gapExits: overshoots.filter((o) => o < -5).length,
    };
  }

  /** Called with the pool before adding an AMM position, so the exit can sell it. */
  registerSwapPool(mint: string, pool: SwapPool, baseTokenProgram: PublicKey) {
    this.swapPools.set(mint, { pool, baseTokenProgram });
  }

  add(position: Position) {
    this.positions.set(position.mint, position);
    this.onChange(position);

    if (this.config.maxHoldSeconds > 0) {
      const timer = setTimeout(() => {
        void this.close(position.mint, 'timeout');
      }, this.config.maxHoldSeconds * 1000);
      this.timeoutTimers.set(position.mint, timer);
    }
  }

  /** Fed from the shared log stream; most trades are for tokens we do not hold. */
  onTrade(trade: TradeUpdate) {
    const mint = trade.mint.toBase58();
    if (!this.positions.has(mint)) return;
    this.applyCurve(mint, trade, 'stream');
  }

  /** The AMM's own event stream, carrying post-trade reserves for a graduated pool. */
  onSwapTrade(trade: SwapTrade, baseMint: PublicKey | null) {
    if (!baseMint) return;
    const mint = baseMint.toBase58();
    if (!this.positions.has(mint)) return;
    this.applyCurve(mint, poolQuote(trade.poolBaseReserves, trade.poolQuoteReserves), 'stream');
  }

  private applyCurve(mint: string, curve: CurveQuote, source: 'stream' | 'poll') {
    const position = this.positions.get(mint);
    if (!position || position.status !== 'open') return;

    position.currentSol = lamportsToSol(solForTokens(curve, position.tokenAmount));
    position.peakSol = Math.max(position.peakSol, position.currentSol);
    position.pnlPct =
      position.entrySol > 0 ? ((position.currentSol - position.entrySol) / position.entrySol) * 100 : 0;
    position.lastSeenAt = Date.now();

    position.history.push(position.pnlPct);
    if (position.history.length > HISTORY_SAMPLES) position.history.shift();

    if (curve.realTokenReserves !== undefined) {
      const sold = INITIAL_REAL_TOKEN_RESERVES - curve.realTokenReserves;
      position.progressPct = Math.min(
        100,
        Math.max(0, Number((sold * 1000n) / INITIAL_REAL_TOKEN_RESERVES) / 10),
      );
    }
    // Price per token times supply, in SOL — easier to read than raw reserves.
    if (curve.virtualTokenReserves > 0n) {
      const supply = 1_000_000_000; // pump.fun mints a fixed 1B supply
      position.marketCapSol =
        (Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves)) * supply;
    }
    this.onChange(position);

    const exit = this.checkExit(position);
    if (exit) {
      position.triggerPnlPct = position.pnlPct;
      position.triggerSource = source;
      // Hand the curve we just read to the sell, so exiting costs no extra round trip.
      void this.close(mint, exit, curve);
    }
  }

  /**
   * The account stream is the fast path, but a dropped subscription or a quiet public
   * RPC would leave a position unwatched — and an unwatched position has no stop-loss
   * at all. Polling every open position in one batched request is the safety net.
   */
  startExitPolling(intervalMs: number) {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  stopExitPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce() {
    if (this.polling) return;
    const open = this.list().filter((p) => p.status === 'open');
    if (open.length === 0) return;

    this.polling = true;
    try {
      const onCurve = open.filter((p) => p.venue === 'pump');
      if (onCurve.length > 0) {
        const curves = await this.executor.getBondingCurves(
          onCurve.map((p) => new PublicKey(p.mint)),
        );
        for (const [mint, curve] of curves) this.applyCurve(mint, curve, 'poll');
      }
      // AMM pools have no batched read: the reserves live in two token accounts per
      // pool rather than one account per mint, so these are polled one at a time.
      for (const position of open.filter((p) => p.venue === 'pumpswap')) {
        const state = await this.executor
          .getSwapPool(new PublicKey(position.mint))
          .catch(() => null);
        if (state) this.applyCurve(position.mint, state.quote, 'poll');
      }
    } catch {
      // A failed poll is not fatal; the stream may still be delivering.
    } finally {
      this.polling = false;
    }
  }

  private checkExit(position: Position): ExitReason | null {
    if (position.pnlPct >= this.config.takeProfitPct) return 'take-profit';
    if (position.pnlPct <= -this.config.stopLossPct) return 'stop-loss';

    if (this.config.trailingStopPct > 0 && position.peakSol > position.entrySol) {
      const dropFromPeak = ((position.peakSol - position.currentSol) / position.peakSol) * 100;
      if (dropFromPeak >= this.config.trailingStopPct) return 'trailing-stop';
    }
    return null;
  }

  async close(mint: string, reason: ExitReason, knownCurve?: CurveQuote) {
    const position = this.positions.get(mint);
    if (!position || position.status !== 'open') return;

    position.status = 'closing';
    position.exitReason = reason;
    this.onChange(position);
    this.onLog(`selling ${position.symbol} (${reason}) at ${position.pnlPct.toFixed(1)}%`);

    const timer = this.timeoutTimers.get(mint);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(mint);
    }

    try {
      const { result, solOut, rentReclaimed } = await this.sellPosition(position, knownCurve);
      position.status = 'closed';
      position.exitSol = solOut;

      const exitPct =
        position.entrySol > 0 ? ((solOut - position.entrySol) / position.entrySol) * 100 : 0;
      if (reason === 'stop-loss') {
        // Negative means the exit landed further underwater than the stop-loss allowed.
        position.overshootPct = exitPct + this.config.stopLossPct;
      }
      position.sellSignature = result?.signature;
      this.onLog(
        `closed ${position.symbol}: ${solOut.toFixed(4)} SOL out vs ${position.entrySol.toFixed(4)} in` +
          (rentReclaimed ? ' (rent reclaimed)' : ''),
      );
    } catch (err) {
      position.error = (err as Error).message;
      position.sellAttempts = (position.sellAttempts ?? 0) + 1;

      // Abandoning a position because one sell failed is the worst outcome there is:
      // it means holding a token the exit rules already decided to get out of. Go back
      // to open so the stream, the poll and this retry can all try again.
      if (position.sellAttempts < MAX_SELL_ATTEMPTS) {
        position.status = 'open';
        this.onLog(
          `sell failed for ${position.symbol} (attempt ${position.sellAttempts}): ${position.error} — retrying`,
        );
        this.onChange(position);
        const backoffMs = 1000 * 2 ** (position.sellAttempts - 1);
        setTimeout(() => void this.close(mint, reason), backoffMs);
        return;
      }

      position.status = 'failed';
      this.onLog(
        `sell failed for ${position.symbol} after ${position.sellAttempts} attempts: ${position.error}`,
      );
    }

    this.onChange(position);
  }

  /**
   * The two venues take different instructions and price from different accounts, so
   * the exit picks by venue rather than assuming the bonding curve.
   */
  private async sellPosition(position: Position, knownCurve?: CurveQuote) {
    if (position.venue === 'pumpswap') {
      const state = this.swapPools.get(position.mint);
      if (!state) throw new Error('pool for this position is not known — cannot sell');
      // Without a current price there is no safe minimum output, so read one rather
      // than sell blind.
      const quote =
        knownCurve ?? (await this.executor.getSwapPool(new PublicKey(position.mint)))?.quote;
      if (!quote) throw new Error('could not read the pool to price the exit');
      return this.executor.sellSwap(
        state.pool,
        state.baseTokenProgram,
        quote,
        position.tokenAmount,
      );
    }
    return this.executor.sell(
      new PublicKey(position.mint),
      new PublicKey(position.creator),
      new PublicKey(position.tokenProgram),
      position.tokenAmount,
      knownCurve,
    );
  }

  /** Panic path: closing one at a time would leave the last positions waiting. */
  async closeAll(reason: ExitReason = 'manual') {
    const open = this.list().filter((p) => p.status === 'open');
    await Promise.allSettled(open.map((position) => this.close(position.mint, reason)));
  }
}
