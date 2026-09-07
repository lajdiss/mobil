import { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import { CurveWatcher } from './detector.js';
import { Executor, lamportsToSol } from './executor.js';
import { bondingCurvePda, decodeBondingCurve, solForTokens } from './pump.js';

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
}

/** pump.fun takes roughly 1% on each side, so a round trip costs about this much. */
const ROUND_TRIP_FEE_PCT = 2;

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
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private timeoutTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly executor: Executor,
    private readonly watcher: CurveWatcher,
    private readonly config: Config,
    private readonly onChange: (position: Position) => void,
    private readonly onLog: (message: string) => void,
  ) {}

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

    const { takeProfitPct, stopLossPct } = this.config;
    // w·(TP − fee) = (1 − w)·(SL + fee)  ->  w = (SL + fee) / (TP + SL)
    const breakEven = ((stopLossPct + ROUND_TRIP_FEE_PCT) / (takeProfitPct + stopLossPct)) * 100;

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
    };
  }

  add(position: Position) {
    this.positions.set(position.mint, position);
    this.onChange(position);

    const mint = new PublicKey(position.mint);
    this.watcher.watch(bondingCurvePda(mint), (data) => {
      this.updateFromCurve(position.mint, data);
    });

    if (this.config.maxHoldSeconds > 0) {
      const timer = setTimeout(() => {
        void this.close(position.mint, 'timeout');
      }, this.config.maxHoldSeconds * 1000);
      this.timeoutTimers.set(position.mint, timer);
    }
  }

  private updateFromCurve(mint: string, data: Buffer) {
    const position = this.positions.get(mint);
    if (!position || position.status !== 'open') return;

    let curve;
    try {
      curve = decodeBondingCurve(data);
    } catch {
      return;
    }

    position.currentSol = lamportsToSol(solForTokens(curve, position.tokenAmount));
    position.peakSol = Math.max(position.peakSol, position.currentSol);
    position.pnlPct =
      position.entrySol > 0 ? ((position.currentSol - position.entrySol) / position.entrySol) * 100 : 0;
    this.onChange(position);

    const exit = this.checkExit(position);
    if (exit) void this.close(mint, exit);
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

  async close(mint: string, reason: ExitReason) {
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
      );
      position.status = 'closed';
      position.exitSol = solOut;
      position.sellSignature = result?.signature;
      this.onLog(
        `closed ${position.symbol}: ${solOut.toFixed(4)} SOL out vs ${position.entrySol.toFixed(4)} in` +
          (rentReclaimed ? ' (rent reclaimed)' : ''),
      );
    } catch (err) {
      position.status = 'failed';
      position.error = (err as Error).message;
      this.onLog(`sell failed for ${position.symbol}: ${position.error}`);
    }

    this.onChange(position);
    await this.watcher.unwatch(bondingCurvePda(new PublicKey(position.mint)));
  }

  async closeAll(reason: ExitReason = 'manual') {
    const open = this.list().filter((p) => p.status === 'open');
    for (const position of open) {
      await this.close(position.mint, reason);
    }
  }
}
