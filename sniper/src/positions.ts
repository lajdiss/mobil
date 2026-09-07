import { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import { CurveWatcher } from './detector.js';
import { Executor, lamportsToSol } from './executor.js';
import {
  bondingCurvePda,
  decodeBondingCurve,
  solForTokens,
  type BondingCurve,
} from './pump.js';

export type PositionStatus = 'open' | 'closing' | 'closed' | 'failed';
export type ExitReason = 'take-profit' | 'stop-loss' | 'trailing-stop' | 'timeout' | 'manual';

export interface Position {
  mint: string;
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
}

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
  /** Stop-loss exits, and how far past the threshold they actually landed. */
  stopLossExits: number;
  avgOvershootPct: number | null;
  worstOvershootPct: number | null;
  /** Stop-losses that gapped straight through the threshold rather than crossing it. */
  gapExits: number;
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private timeoutTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly executor: Executor,
    private readonly watcher: CurveWatcher,
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
      stopLossExits: overshoots.length,
      avgOvershootPct: overshoots.length ? mean(overshoots) : null,
      worstOvershootPct: overshoots.length ? Math.min(...overshoots) : null,
      // More than 5 points past the threshold means the price never traded through it.
      gapExits: overshoots.filter((o) => o < -5).length,
    };
  }

  add(position: Position) {
    this.positions.set(position.mint, position);
    this.onChange(position);

    const mint = new PublicKey(position.mint);
    this.watcher.watch(bondingCurvePda(mint), (data) => {
      this.updateFromCurve(position.mint, data, 'stream');
    });

    if (this.config.maxHoldSeconds > 0) {
      const timer = setTimeout(() => {
        void this.close(position.mint, 'timeout');
      }, this.config.maxHoldSeconds * 1000);
      this.timeoutTimers.set(position.mint, timer);
    }
  }

  private updateFromCurve(mint: string, data: Buffer, source: 'stream' | 'poll') {
    let curve;
    try {
      curve = decodeBondingCurve(data);
    } catch {
      return;
    }
    this.applyCurve(mint, curve, source);
  }

  private applyCurve(mint: string, curve: BondingCurve, source: 'stream' | 'poll') {
    const position = this.positions.get(mint);
    if (!position || position.status !== 'open') return;

    position.currentSol = lamportsToSol(solForTokens(curve, position.tokenAmount));
    position.peakSol = Math.max(position.peakSol, position.currentSol);
    position.pnlPct =
      position.entrySol > 0 ? ((position.currentSol - position.entrySol) / position.entrySol) * 100 : 0;
    position.lastSeenAt = Date.now();
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
      const curves = await this.executor.getBondingCurves(open.map((p) => new PublicKey(p.mint)));
      for (const [mint, curve] of curves) this.applyCurve(mint, curve, 'poll');
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

  async close(mint: string, reason: ExitReason, knownCurve?: BondingCurve) {
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
      const { result, solOut, rentReclaimed } = await this.executor.sell(
        new PublicKey(position.mint),
        new PublicKey(position.creator),
        new PublicKey(position.tokenProgram),
        position.tokenAmount,
        knownCurve,
      );
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
    await this.watcher.unwatch(bondingCurvePda(new PublicKey(position.mint)));
  }

  /** Panic path: closing one at a time would leave the last positions waiting. */
  async closeAll(reason: ExitReason = 'manual') {
    const open = this.list().filter((p) => p.status === 'open');
    await Promise.allSettled(open.map((position) => this.close(position.mint, reason)));
  }
}
