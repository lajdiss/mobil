import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig, loadKeypair, type Config } from './config.js';
import { Detector, type DetectedToken } from './detector.js';
import { Executor } from './executor.js';
import { CreatorHistory, evaluate } from './filters.js';
import { KeywordMemory } from './learning.js';
import { MomentumTracker } from './momentum.js';
import { PositionManager, type Position } from './positions.js';
import { Metrics } from './metrics.js';
import { WalletTracker } from './wallets.js';
import { startServer, type DashboardState } from './server.js';

const config = loadConfig();
const wallet = loadKeypair();
const connection = new Connection(config.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.wsUrl,
});

const metrics = new Metrics();
const executor = new Executor(connection, wallet, config, metrics);
const history = new CreatorHistory();
const memory = new KeywordMemory(config.learningPath);
const wallets = new WalletTracker(config.walletPath);

/**
 * Copy mode follows buys on tokens whose launch we saw, so their name, creator and
 * token program are already known. Capped and trimmed: launches arrive all day.
 */
const recentTokens = new Map<string, DetectedToken>();
function rememberToken(token: DetectedToken) {
  recentTokens.set(token.mint.toBase58(), token);
  if (recentTokens.size > 3000) {
    for (const key of recentTokens.keys()) {
      recentTokens.delete(key);
      if (recentTokens.size <= 2000) break;
    }
  }
}

interface FeedEntry {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  at: number;
  verdict: 'sniped' | 'skipped' | 'error';
  reason?: string;
}

const feed: FeedEntry[] = [];
const logs: string[] = [];
const stats = { detected: 0, passed: 0, bought: 0, errors: 0, missed: 0 };

let armed = false;
let balanceSol = 0;
let spentTodaySol = 0;
let spendDay = new Date().toDateString();
let consecutiveLosses = 0;
let cooldownUntil = 0;
let feesTodaySol = 0;

/** Priority fee plus signature, per transaction, at the configured settings. */
function estimatedFeeSol(): number {
  const priority = (config.priorityFeeMicroLamports * config.computeUnitLimit) / 1e6 / 1e9;
  return priority + 0.000005;
}

function log(message: string) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  logs.unshift(line);
  if (logs.length > 200) logs.pop();
  console.log(line);
}

function pushFeed(entry: FeedEntry) {
  feed.unshift(entry);
  if (feed.length > 100) feed.pop();
}

function rolloverSpendCap() {
  const today = new Date().toDateString();
  if (today !== spendDay) {
    spendDay = today;
    spentTodaySol = 0;
    feesTodaySol = 0;
    log('daily caps reset');
  }
}

const positions = new PositionManager(
  executor,
  config,
  (position) => {
    if (position.status !== 'closed' || position.exitSol === undefined) return;
    if (recorded.has(position.mint)) return;
    recorded.add(position.mint);

    const pnlPct = ((position.exitSol - position.entrySol) / position.entrySol) * 100;
    if (config.learningEnabled) memory.record(position.name, position.symbol, pnlPct);

    // A streak of losses is usually the market turning, not a setting to tweak.
    if (pnlPct > 0) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (config.maxConsecutiveLosses > 0 && consecutiveLosses >= config.maxConsecutiveLosses) {
        cooldownUntil = Date.now() + config.cooldownMinutes * 60_000;
        log(`${consecutiveLosses} losses in a row — pausing entries for ${config.cooldownMinutes} min`);
        consecutiveLosses = 0;
      }
    }
  },
  log,
);
const recorded = new Set<string>();

function canBuy(mint: string): string | null {
  rolloverSpendCap();
  if (!armed) return 'not armed';
  // Positions are keyed by mint, so buying the same one twice would overwrite the
  // first record and silently erase it from the results.
  if (positions.has(mint)) return 'already traded this token';
  if (positions.openCount() >= config.maxOpenPositions) return 'max open positions reached';
  if (spentTodaySol + config.buyAmountSol > config.dailySpendCapSol) return 'daily spend cap reached';
  if (Date.now() < cooldownUntil) {
    const left = Math.ceil((cooldownUntil - Date.now()) / 60_000);
    return `cooling down after ${consecutiveLosses} losses (${left} min left)`;
  }
  // Two transactions per position: the entry and the exit.
  if (config.maxDailyFeeSol > 0 && feesTodaySol + estimatedFeeSol() * 2 > config.maxDailyFeeSol) {
    return 'daily fee budget reached';
  }
  // Dry run exists to evaluate the strategy before funding anything, so the wallet
  // balance must not gate it.
  if (!config.dryRun && balanceSol - config.buyAmountSol < config.minSolReserve) {
    return 'wallet reserve too low';
  }
  return null;
}

const momentum = new MomentumTracker(
  {
    minLiquiditySol: config.momentumMinLiquiditySol,
    minBuys: config.momentumMinBuys,
    maxAgeSeconds: config.momentumMaxAgeSeconds,
    minBuyRatio: config.momentumMinBuyRatio,
  },
  (token, liquiditySol, buys) => {
    log(`${token.symbol} qualified: ${liquiditySol.toFixed(2)} SOL liquidity, ${buys} buys`);
    void enterPosition(token);
  },
);

async function handleToken(token: DetectedToken) {
  stats.detected++;
  const mintKey = token.mint.toBase58();
  metrics.start(mintKey);
  history.record(token.creator.toBase58());

  const verdict = evaluate(token, config, history);
  metrics.mark(mintKey, 'filter');
  if (!verdict.passed) {
    metrics.finish(mintKey, 'rejected', verdict.reason);
    pushFeed({
      mint: token.mint.toBase58(),
      name: token.name,
      symbol: token.symbol,
      creator: token.creator.toBase58(),
      at: Date.now(),
      verdict: 'skipped',
      reason: verdict.reason,
    });
    return;
  }
  if (config.learningEnabled) {
    const score = memory.score(token.name, token.symbol, config.learningMinTrades);
    if (score !== null && score < config.learningMinScore) {
      pushFeed({
        mint: token.mint.toBase58(),
        name: token.name,
        symbol: token.symbol,
        creator: token.creator.toBase58(),
        at: Date.now(),
        verdict: 'skipped',
        reason: `learned score ${score.toFixed(1)}% below ${config.learningMinScore}%`,
      });
      metrics.finish(mintKey, 'rejected', 'learned score too low');
      return;
    }
  }

  stats.passed++;

  // Neither of these enters at launch — the token has to earn it first.
  if (config.entryMode === 'momentum') {
    momentum.register(token);
    return;
  }
  if (config.entryMode === 'copy') {
    rememberToken(token);
    return;
  }

  await enterPosition(token);
}

async function enterPosition(token: DetectedToken) {
  const mintKey = token.mint.toBase58();
  const blocker = canBuy(mintKey);
  if (blocker) {
    metrics.finish(mintKey, 'rejected', blocker);
    pushFeed({
      mint: token.mint.toBase58(),
      name: token.name,
      symbol: token.symbol,
      creator: token.creator.toBase58(),
      at: Date.now(),
      verdict: 'skipped',
      reason: blocker,
    });
    return;
  }

  try {
    log(`buying ${token.symbol} (${token.name}) for ${config.buyAmountSol} SOL`);

    // Live: the launch event already carries the reserves, so the entry path needs no
    // read at all. Dry run: filling at the launch price flatters exactly the tokens
    // that run, since those are the ones faster bots got into first. Wait, then price
    // off the chain, so simulated entries resemble ones a real transaction could get.
    let entryQuote = {
      virtualTokenReserves: token.virtualTokenReserves,
      virtualQuoteReserves: token.virtualQuoteReserves || token.virtualSolReserves,
      realTokenReserves: token.realTokenReserves,
    };
    // Momentum entries happen well after the launch, so the reserves in the create
    // event are long stale. Falling back to them is not a degraded price, it is a
    // fictional one: the token qualified precisely because it went up, so a stale
    // quote books a cheap entry against a real exit and invents a win. Measured once —
    // five such trades reported +451% to +474% and turned a losing round into a
    // passing one. Without a current price there is no trade.
    if (config.entryMode === 'momentum') {
      const now = await executor.getBondingCurve(token.mint).catch(() => null);
      if (!now) {
        stats.errors++;
        log(`skipping ${token.symbol}: could not read the current price`);
        return;
      }
      entryQuote = now;
      metrics.mark(mintKey, 'quote');
    } else if (config.dryRun && config.dryRunFillDelayMs > 0) {
      await new Promise((r) => setTimeout(r, config.dryRunFillDelayMs));
      const settled = await executor.getBondingCurve(token.mint).catch(() => null);
      if (settled) entryQuote = settled;
    }

    metrics.mark(mintKey, 'build');
    const { result, tokenAmount, solSpent } = await executor.buy(
      token.mint,
      token.creator,
      token.tokenProgram,
      config.buyAmountSol,
      entryQuote,
    );

    metrics.mark(mintKey, 'submit');
    spentTodaySol += solSpent;
    feesTodaySol += estimatedFeeSol();
    stats.bought++;

    const position: Position = {
      mint: token.mint.toBase58(),
      name: token.name,
      symbol: token.symbol,
      creator: token.creator.toBase58(),
      tokenProgram: token.tokenProgram.toBase58(),
      tokenAmount,
      entrySol: solSpent,
      currentSol: solSpent,
      peakSol: solSpent,
      pnlPct: 0,
      openedAt: Date.now(),
      status: 'open',
      buySignature: result?.signature,
      history: [0],
      progressPct: 0,
      marketCapSol: 0,
    };
    positions.add(position);

    pushFeed({
      mint: position.mint,
      name: token.name,
      symbol: token.symbol,
      creator: position.creator,
      at: Date.now(),
      verdict: 'sniped',
    });
    metrics.finish(mintKey, 'bought');
    log(
      config.dryRun
        ? `DRY RUN: would have bought ${token.symbol}`
        : `bought ${token.symbol} — ${result?.signature}`,
    );
  } catch (err) {
    stats.errors++;
    const reason = (err as Error).message;
    metrics.finish(mintKey, 'failed', reason.slice(0, 60));
    log(`buy failed for ${token.symbol}: ${reason}`);
    pushFeed({
      mint: token.mint.toBase58(),
      name: token.name,
      symbol: token.symbol,
      creator: token.creator.toBase58(),
      at: Date.now(),
      verdict: 'error',
      reason,
    });
  }
}

const detector = new Detector(
  config.streamEndpoints,
  (token) => void handleToken(token),
  (trade) => {
    positions.onTrade(trade);
    if (config.entryMode === 'momentum') momentum.onTrade(trade);
    if (config.entryMode === 'copy') {
      wallets.record(trade);
      // Follow a buy only from a wallet with a record, and only into a launch we saw.
      if (!trade.isBuy) return;
      const mint = trade.mint.toBase58();
      const token = recentTokens.get(mint);
      if (!token || positions.has(mint)) return;
      if (
        !wallets.isProven(
          trade.user.toBase58(),
          config.copyMinClosed,
          config.copyMinRealisedSol,
          config.copyMinWinRate,
        )
      ) {
        return;
      }
      const stat = wallets.stat(trade.user.toBase58());
      log(
        `following ${trade.user.toBase58().slice(0, 8)} into ${token.symbol} ` +
          `(${stat?.realisedSol.toFixed(2)} SOL over ${stat?.closed} trades)`,
      );
      void enterPosition(token);
    }
  },
  (message) => log(message),
);

const mutableConfig = config as Config & Record<string, unknown>;

const getState = (): DashboardState => ({
  wallet: wallet.publicKey.toBase58(),
  balanceSol,
  dryRun: config.dryRun,
  armed,
  spentTodaySol,
  config: {
    buyAmountSol: config.buyAmountSol,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    trailingStopPct: config.trailingStopPct,
    maxHoldSeconds: config.maxHoldSeconds,
    slippageBps: config.slippageBps,
    priorityFeeMicroLamports: config.priorityFeeMicroLamports,
    maxOpenPositions: config.maxOpenPositions,
    dailySpendCapSol: config.dailySpendCapSol,
  },
  positions: positions.list().map((p) => ({ ...p, tokenAmount: p.tokenAmount.toString() })),
  performance: positions.performance(),
  learning: memory.stats(),
  metrics: metrics.snapshot(),
  risk: {
    consecutiveLosses,
    cooldownMsLeft: Math.max(0, cooldownUntil - Date.now()),
    feesTodaySol,
    maxDailyFeeSol: config.maxDailyFeeSol,
  },
  wallets: {
    ...wallets.summary(config.copyMinClosed, config.copyMinRealisedSol, config.copyMinWinRate),
    top: wallets.leaderboard(config.copyMinClosed, 6),
  },
  feed,
  logs,
  stats: { ...stats, missed: detector.counters.undecodable },
  stream: detector.health(),
});

const EDITABLE_NUMERIC = new Set([
  'buyAmountSol',
  'takeProfitPct',
  'stopLossPct',
  'trailingStopPct',
  'maxHoldSeconds',
  'slippageBps',
  'priorityFeeMicroLamports',
  'maxOpenPositions',
  'dailySpendCapSol',
]);

startServer({ port: config.port, host: config.bindHost, token: config.dashboardToken }, {
  getState,
  setArmed: (value) => {
    armed = value;
    log(armed ? 'ARMED — sniping enabled' : 'disarmed — sniping paused');
  },
  updateConfig: (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE_NUMERIC.has(key)) throw new Error(`field "${key}" is not editable`);
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) throw new Error(`invalid value for ${key}`);
      if (key === 'buyAmountSol' && num > config.maxSolPerTrade) {
        throw new Error(`buyAmountSol cannot exceed MAX_SOL_PER_TRADE (${config.maxSolPerTrade})`);
      }
      mutableConfig[key] = num;
    }
    log(`config updated: ${Object.keys(patch).join(', ')}`);
  },
  closePosition: (mint) => positions.close(mint, 'manual'),
  panicSell: async () => {
    log('PANIC — disarming and selling every open position');
    await positions.closeAll('manual');
  },
});

async function refreshBalance() {
  try {
    balanceSol = await executor.getBalanceSol();
  } catch (err) {
    log(`balance check failed: ${(err as Error).message}`);
  }
}

async function main() {
  console.log('');
  console.log('  pump.fun sniper');
  console.log('  wallet: ', wallet.publicKey.toBase58());
  console.log('  rpc:    ', config.rpcUrl);
  console.log('  mode:   ', config.dryRun ? 'DRY RUN (no real transactions)' : 'LIVE TRADING');
  const entryDescription = {
    momentum: `momentum (wait for ${config.momentumMinLiquiditySol} SOL liquidity and ${config.momentumMinBuys} buys)`,
    copy: `copy (follow wallets with ${config.copyMinRealisedSol}+ SOL over ${config.copyMinClosed}+ trades)`,
    snipe: 'snipe (buy at launch)',
  }[config.entryMode];
  console.log('  entry:  ', entryDescription);
  if (!config.dryRun) {
    console.log('');
    console.log('  !! LIVE MODE — this wallet will spend real SOL.');
    console.log('  !! Only the burner wallet key belongs in .env.');
  }

  await refreshBalance();
  console.log('  balance:', balanceSol.toFixed(4), 'SOL');
  log(`started in ${config.dryRun ? 'dry-run' : 'live'} mode — press ARM in the dashboard to begin`);

  detector.start();
  positions.startExitPolling(config.exitPollMs);
  setInterval(() => void refreshBalance(), 30_000);
  setInterval(() => void executor.refreshBlockhash(), 10_000);
  if (config.entryMode === 'copy') setInterval(() => wallets.save(), 60_000);
}

const shutdown = async () => {
  log('shutting down — open positions are left untouched');
  await detector.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
