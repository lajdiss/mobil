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

export interface Config {
  rpcUrl: string;
  wsUrl: string;
  dryRun: boolean;
  buyAmountSol: number;
  maxSolPerTrade: number;
  dailySpendCapSol: number;
  maxOpenPositions: number;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldSeconds: number;
  minSolReserve: number;
  requireSocials: boolean;
  blockedNamePatterns: string[];
  maxCreatorLaunchesPerHour: number;
  maxDevBuyPct: number;
  entryMode: 'snipe' | 'momentum';
  momentumMinLiquiditySol: number;
  momentumMinBuys: number;
  momentumMaxAgeSeconds: number;
  momentumMinBuyRatio: number;
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

  if (dashboardToken && dashboardToken.length < 16) {
    throw new Error(
      'DASHBOARD_TOKEN must be at least 16 characters — it is the only thing standing ' +
        'between your network and the ARM button.',
    );
  }

  const cfg: Config = {
    rpcUrl,
    wsUrl,
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
    // 'snipe' races the launch; 'momentum' waits for a token to prove itself first,
    // which trades away the launch pop for independence from latency.
    entryMode: (process.env.ENTRY_MODE || 'snipe') === 'momentum' ? 'momentum' : 'snipe',
    momentumMinLiquiditySol: num('MOMENTUM_MIN_LIQUIDITY_SOL', 5),
    momentumMinBuys: num('MOMENTUM_MIN_BUYS', 8),
    momentumMaxAgeSeconds: num('MOMENTUM_MAX_AGE_SECONDS', 120),
    momentumMinBuyRatio: num('MOMENTUM_MIN_BUY_RATIO', 0.6),
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
