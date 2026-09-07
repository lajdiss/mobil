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
  port: number;
}

export function loadConfig(): Config {
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const wsUrl = process.env.WS_URL || rpcUrl.replace(/^http/, 'ws');

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
    port: num('PORT', 8787),
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
