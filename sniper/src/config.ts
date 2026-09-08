import 'dotenv/config';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
  return v;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
};

/**
 * Accepts a base58 secret key (what Phantom's "Export Private Key" gives you)
 * or a JSON byte array (what `solana-keygen` writes).
 */
export function loadKeypair(): Keypair {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      'PRIVATE_KEY is not set. Copy .env.example to .env and paste the private key of a ' +
        'DEDICATED burner wallet — never your main Phantom wallet.',
    );
  }
  try {
    if (raw.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new Error('PRIVATE_KEY could not be parsed as base58 or a JSON byte array.');
  }
}

export interface RpcEndpoint {
  http: string;
  ws: string;
}

export interface Config {
  rpcUrl: string;
  wsUrl: string;
  /** Stream endpoints tried in order; a public RPC can serve HTTP while its WS is dead. */
  streamEndpoints: RpcEndpoint[];
  dryRun: boolean;
  buyAmountSol: number;
  maxSolPerTrade: number;
  dailySpendCapSol: number;
  maxOpenPositions: number;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  takeProfitPct: number;
  partialTakeProfitPct: number;
  partialSellPct: number;
  breakEvenAfterPartial: boolean;
  exitOnCreatorSell: boolean;
  creatorSellMinBps: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldSeconds: number;
  minSolReserve: number;
  requireSocials: boolean;
  blockedNamePatterns: string[];
  maxCreatorLaunchesPerHour: number;
  maxDevBuyPct: number;
  entryMode:
    | 'snipe'
    | 'momentum'
    | 'copy'
    | 'delay'
    | 'graduate'
    | 'consensus'
    | 'trending';
  momentumMinLiquiditySol: number;
  momentumMinBuys: number;
  momentumMaxAgeSeconds: number;
  momentumMinBuyRatio: number;
  graduateMinLiquiditySol: number;
  graduateMinBuys: number;
  graduateMinAgeSeconds: number;
  graduateMaxAgeSeconds: number;
  graduateMinBuyRatio: number;
  delaySeconds: number;
  delayMinLiquiditySol: number;
  consensusMinWallets: number;
  consensusWindowSeconds: number;
  consensusMaxAgeSeconds: number;
  trendingMaxTradeAgeSeconds: number;
  trendingMinUniqueBuyers: number;
  trendingMinBuyRatio: number;
  trendingMaxTopBuyerShare: number;
  trendingMinMarketCapSol: number;
  trendingMaxMarketCapSol: number;
  trendingWarmupSeconds: number;
  trendingRequireSocial: boolean;
  trendingScanIntervalSeconds: number;
  trendingScanPages: number;
  learningEnabled: boolean;
  learningMinTrades: number;
  learningMinScore: number;
  learningPath: string;
  copyMinClosed: number;
  copyMinRealisedSol: number;
  copyMinWinRate: number;
  simulateBeforeSend: boolean;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  maxDailyFeeSol: number;
  walletPath: string;
  recordPath: string;
  recordLaunchesPath: string;
  recordLaunchSeconds: number;
  recordSignalsAtSeconds: number;
  port: number;
  exitPollMs: number;
  dryRunFillDelayMs: number;
  dashboardToken: string;
  bindHost: string;
}

export function loadConfig(): Config {
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const wsUrl = process.env.WS_URL || rpcUrl.replace(/^http/, 'ws');
  const dashboardToken = (process.env.DASHBOARD_TOKEN || '').trim();

  const toEndpoint = (http: string): RpcEndpoint => ({
    http: http.trim(),
    ws: http.trim().replace(/^http/, 'ws'),
  });
  const fallbacks = (process.env.RPC_FALLBACK_URLS || 'https://api.mainnet-beta.solana.com')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const streamEndpoints = [rpcUrl, ...fallbacks]
    .filter((u, i, all) => all.indexOf(u) === i)
    .map(toEndpoint);

  if (dashboardToken && dashboardToken.length < 16) {
    throw new Error(
      'DASHBOARD_TOKEN must be at least 16 characters — it is the only thing standing ' +
        'between your network and the ARM button.',
    );
  }

  const cfg: Config = {
    rpcUrl,
    wsUrl,
    streamEndpoints,
    // Live trading is opt-in on purpose: a typo in a filter should not cost real SOL.
    dryRun: bool('DRY_RUN', true),
    buyAmountSol: num('BUY_AMOUNT_SOL', 0.01),
    maxSolPerTrade: num('MAX_SOL_PER_TRADE', 0.05),
    dailySpendCapSol: num('DAILY_SPEND_CAP_SOL', 0.5),
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
    slippageBps: num('SLIPPAGE_BPS', 1500),
    priorityFeeMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 500_000),
    computeUnitLimit: num('COMPUTE_UNIT_LIMIT', 250_000),
    takeProfitPct: num('TAKE_PROFIT_PCT', 50),
    // Scaling out is the one honest way to raise win rate: banking part of the
    // position at a near target turns trades that would have round-tripped back to a
    // loss into small wins, while the remainder keeps the tail. 0 disables it.
    partialTakeProfitPct: num('PARTIAL_TAKE_PROFIT_PCT', 0),
    partialSellPct: Math.min(95, Math.max(5, num('PARTIAL_SELL_PCT', 50))),
    // After banking a partial, the rest rides with the stop at entry. A position that
    // has already returned part of its cost should not be allowed to become a loss.
    breakEvenAfterPartial: bool('BREAK_EVEN_AFTER_PARTIAL', true),
    // The creator dumping their own supply is the clearest rug signal there is, and it
    // arrives free in the same event stream that prices the position.
    exitOnCreatorSell: bool('EXIT_ON_CREATOR_SELL', true),
    // How big a creator's sale has to be, as a share of the pool, before it counts as
    // a dump rather than pocket money. 50bps of liquidity is roughly where a sale
    // starts to move the price at all.
    creatorSellMinBps: num('CREATOR_SELL_MIN_BPS', 50),
    stopLossPct: num('STOP_LOSS_PCT', 30),
    trailingStopPct: num('TRAILING_STOP_PCT', 0),
    maxHoldSeconds: num('MAX_HOLD_SECONDS', 300),
    minSolReserve: num('MIN_SOL_RESERVE', 0.02),
    requireSocials: bool('REQUIRE_SOCIALS', false),
    blockedNamePatterns: (process.env.BLOCKED_NAME_PATTERNS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxCreatorLaunchesPerHour: num('MAX_CREATOR_LAUNCHES_PER_HOUR', 1),
    // A creator holding a large slice of their own supply is the classic setup for
    // dumping it on whoever snipes the launch. 0 disables the check.
    maxDevBuyPct: num('MAX_DEV_BUY_PCT', 0),
    // 'snipe' races the launch; 'delay' buys the same launches a fixed time later;
    // 'momentum' waits for a token to prove itself first, which trades away the launch
    // pop for independence from latency; 'graduate' leaves the bonding curve entirely
    // and trades the AMM pool a token lands in after it graduates.
    entryMode: ((): Config['entryMode'] => {
      const mode = process.env.ENTRY_MODE || 'snipe';
      const known = ['momentum', 'copy', 'delay', 'graduate', 'consensus', 'trending'] as const;
      return (known as readonly string[]).includes(mode) ? (mode as Config['entryMode']) : 'snipe';
    })(),
    momentumMinLiquiditySol: num('MOMENTUM_MIN_LIQUIDITY_SOL', 5),
    momentumMinBuys: num('MOMENTUM_MIN_BUYS', 8),
    momentumMaxAgeSeconds: num('MOMENTUM_MAX_AGE_SECONDS', 120),
    momentumMinBuyRatio: num('MOMENTUM_MIN_BUY_RATIO', 0.6),
    // A graduated pool opens with real liquidity — roughly 85 SOL — so the bar here
    // is about the pool still being healthy, not about it being large.
    graduateMinLiquiditySol: num('GRADUATE_MIN_LIQUIDITY_SOL', 60),
    graduateMinBuys: num('GRADUATE_MIN_BUYS', 15),
    // The whole point of this mode: wait out the graduation dump instead of racing
    // into it. Entering at zero seconds would be the same losing race as a snipe.
    graduateMinAgeSeconds: num('GRADUATE_MIN_AGE_SECONDS', 60),
    graduateMaxAgeSeconds: num('GRADUATE_MAX_AGE_SECONDS', 900),
    graduateMinBuyRatio: num('GRADUATE_MIN_BUY_RATIO', 0.55),
    // Delay mode buys every launch that passes the filters, a fixed time after it
    // happened. Nothing about the token has to qualify — the wait is the only
    // variable, which is what makes it a clean test of whether the launch pop is
    // worth anything once the race is conceded.
    delaySeconds: num('DELAY_SECONDS', 30),
    // Off by default on purpose: a liquidity floor would quietly turn this into
    // momentum mode and stop it measuring the delay on its own.
    delayMinLiquiditySol: num('DELAY_MIN_LIQUIDITY_SOL', 0),
    // Copy mode follows the first proven wallet and measured out as noise twice over.
    // This asks for agreement instead: several wallets with a record, buying the same
    // token close together. Three is the smallest number that is not a coincidence.
    consensusMinWallets: Math.max(2, num('CONSENSUS_MIN_WALLETS', 3)),
    consensusWindowSeconds: num('CONSENSUS_WINDOW_SECONDS', 45),
    consensusMaxAgeSeconds: num('CONSENSUS_MAX_AGE_SECONDS', 300),
    // Trending mode ignores the launch entirely and picks from tokens that are alive
    // now, whatever their age. Attention is measured as distinct buyers from the event
    // streams — pump.fun's own comment counts are months stale on every token sampled,
    // so they describe history rather than interest.
    trendingMaxTradeAgeSeconds: num('TRENDING_MAX_TRADE_AGE_SECONDS', 60),
    trendingMinUniqueBuyers: num('TRENDING_MIN_UNIQUE_BUYERS', 12),
    trendingMinBuyRatio: num('TRENDING_MIN_BUY_RATIO', 0.55),
    // One wallet doing most of the buying is a whale, not a crowd.
    trendingMaxTopBuyerShare: num('TRENDING_MAX_TOP_BUYER_SHARE', 0.5),
    trendingMinMarketCapSol: num('TRENDING_MIN_MARKET_CAP_SOL', 30),
    trendingMaxMarketCapSol: num('TRENDING_MAX_MARKET_CAP_SOL', 5000),
    // Below this the buyer count measures how long we have been watching, not interest.
    trendingWarmupSeconds: num('TRENDING_WARMUP_SECONDS', 45),
    trendingRequireSocial: bool('TRENDING_REQUIRE_SOCIAL', false),
    trendingScanIntervalSeconds: num('TRENDING_SCAN_INTERVAL_SECONDS', 20),
    trendingScanPages: num('TRENDING_SCAN_PAGES', 4),
    // Learning records outcomes from the first trade, but only starts rejecting
    // candidates once there is enough history for a score to mean anything.
    learningEnabled: bool('LEARNING_ENABLED', true),
    learningMinTrades: num('LEARNING_MIN_TRADES', 200),
    learningMinScore: num('LEARNING_MIN_SCORE', -100),
    learningPath: process.env.LEARNING_PATH || 'data/keyword-memory.json',
    // What a wallet must have shown on the curve before the bot follows its buys.
    copyMinClosed: num('COPY_MIN_CLOSED', 10),
    copyMinRealisedSol: num('COPY_MIN_REALISED_SOL', 1),
    copyMinWinRate: num('COPY_MIN_WIN_RATE', 0.5),
    // Simulating before sending catches a doomed transaction locally, but costs a full
    // RPC round trip on the entry path — measured at 44ms median, 195ms at p95. On by
    // default: a wasted fee is cheaper than a silent on-chain failure.
    simulateBeforeSend: bool('SIMULATE_BEFORE_SEND', true),
    // A losing streak is usually the market, not the settings. Stop rather than
    // keep paying to find out.
    maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 0),
    cooldownMinutes: num('COOLDOWN_MINUTES', 30),
    maxDailyFeeSol: num('MAX_DAILY_FEE_SOL', 0),
    walletPath: process.env.WALLET_PATH || 'data/wallet-stats.json',
    // When set, every position's price path is written here for offline replay. Run
    // the recording with the exits switched off — a wide take-profit and a long hold —
    // or the path stops where this run's own rules decided and no replay can recover
    // the part that was never observed.
    recordPath: process.env.RECORD_PATH || '',
    // Records every launch's price from the launch event itself, taking no positions.
    // This is what makes the entry delay a replayable parameter: paths that start at
    // the entry contain no record of what the price did before it.
    recordLaunchesPath: process.env.RECORD_LAUNCHES_PATH || '',
    recordLaunchSeconds: num('RECORD_LAUNCH_SECONDS', 300),
    // When to snapshot the selection signals for a recorded launch. Has to be a fixed
    // offset, or the replay is comparing readings taken at different points in a
    // token's life and calling the difference a signal.
    recordSignalsAtSeconds: num('RECORD_SIGNALS_AT_SECONDS', 45),
    port: num('PORT', 8787),
    // Backstop for the account stream; a position nobody is watching has no stop-loss.
    exitPollMs: Math.max(500, num('EXIT_POLL_MS', 2000)),
    // Dry run would otherwise fill at the launch price, which is the one price a real
    // transaction on a public RPC never gets. This models the delay before it lands.
    dryRunFillDelayMs: num('DRY_RUN_FILL_DELAY_MS', 1500),
    dashboardToken,
    // Without a token the dashboard has no access control, so it stays bound to
    // loopback. Setting a token is what opens it to the rest of the network.
    bindHost: dashboardToken ? '0.0.0.0' : '127.0.0.1',
  };

  if (cfg.buyAmountSol > cfg.maxSolPerTrade) {
    throw new Error(
      `BUY_AMOUNT_SOL (${cfg.buyAmountSol}) exceeds MAX_SOL_PER_TRADE (${cfg.maxSolPerTrade}).`,
    );
  }
  if (cfg.stopLossPct <= 0 || cfg.stopLossPct >= 100) {
    throw new Error('STOP_LOSS_PCT must be between 0 and 100.');
  }
  return cfg;
}
