import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig, loadKeypair, type Config } from './config.js';
import { CurveWatcher, Detector, type DetectedToken } from './detector.js';
import { Executor } from './executor.js';
import { CreatorHistory, evaluate } from './filters.js';
import { PositionManager, type Position } from './positions.js';
import { startServer, type DashboardState } from './server.js';

const config = loadConfig();
const wallet = loadKeypair();
const connection = new Connection(config.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.wsUrl,
});

const executor = new Executor(connection, wallet, config);
const watcher = new CurveWatcher(connection);
const history = new CreatorHistory();

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
const stats = { detected: 0, passed: 0, bought: 0, errors: 0 };

let armed = false;
let balanceSol = 0;
let spentTodaySol = 0;
let spendDay = new Date().toDateString();

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
    log('daily spend cap reset');
  }
}

const positions = new PositionManager(
  executor,
  watcher,
  config,
  () => {},
  log,
);

function canBuy(): string | null {
  rolloverSpendCap();
  if (!armed) return 'not armed';
  if (positions.openCount() >= config.maxOpenPositions) return 'max open positions reached';
  if (spentTodaySol + config.buyAmountSol > config.dailySpendCapSol) return 'daily spend cap reached';
  if (balanceSol - config.buyAmountSol < config.minSolReserve) return 'wallet reserve too low';
  return null;
}

async function handleToken(token: DetectedToken) {
  stats.detected++;
  history.record(token.creator.toBase58());

  const verdict = evaluate(token, config, history);
  if (!verdict.passed) {
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
  stats.passed++;

  const blocker = canBuy();
  if (blocker) {
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
    const { result, tokenAmount, solSpent } = await executor.buy(
      token.mint,
      token.creator,
      token.tokenProgram,
      config.buyAmountSol,
    );

    spentTodaySol += solSpent;
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
    log(
      config.dryRun
        ? `DRY RUN: would have bought ${token.symbol}`
        : `bought ${token.symbol} — ${result?.signature}`,
    );
  } catch (err) {
    stats.errors++;
    const reason = (err as Error).message;
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
  connection,
  (token) => void handleToken(token),
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
  feed,
  logs,
  stats,
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
  if (!config.dryRun) {
    console.log('');
    console.log('  !! LIVE MODE — this wallet will spend real SOL.');
    console.log('  !! Only the burner wallet key belongs in .env.');
  }

  await refreshBalance();
  console.log('  balance:', balanceSol.toFixed(4), 'SOL');
  log(`started in ${config.dryRun ? 'dry-run' : 'live'} mode — press ARM in the dashboard to begin`);

  detector.start();
  setInterval(() => void refreshBalance(), 30_000);
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
