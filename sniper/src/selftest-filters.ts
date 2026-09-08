/**
 * Checks the launch filter against the shapes real launches actually have.
 *
 * This exists because of a filter that rejected 100% of launches in production while
 * looking correct in review. It required the curve's quoteMint to equal WSOL; a curve
 * quoted in native SOL leaves that field unset, so it arrives as the all-zero pubkey
 * and every launch failed. Nothing crashed and nothing logged an error — the bot
 * simply stopped trading, and the only symptom was a counter reading 0 bought.
 *
 * A filter's job is to reject some things and pass others, so a test that only ever
 * feeds it bad input cannot tell the difference between working and rejecting
 * everything.
 */
import { PublicKey } from '@solana/web3.js';
import type { Config } from './config.js';
import type { DetectedToken } from './detector.js';
import { CreatorHistory, evaluate } from './filters.js';
import { WSOL_MINT } from './pumpswap.js';

const config = {
  blockedNamePatterns: [],
  requireSocials: false,
  maxCreatorLaunchesPerHour: 99,
  maxDevBuyPct: 0,
} as unknown as Config;

/** A launch exactly as pump.fun emits one: 30 SOL virtual reserves, quoteMint unset. */
const normalLaunch = (over: Partial<DetectedToken> = {}): DetectedToken =>
  ({
    name: 'Test Coin',
    symbol: 'TEST',
    uri: 'https://ipfs.io/ipfs/whatever',
    mint: new PublicKey(new Uint8Array(32).fill(7)),
    bondingCurve: new PublicKey(new Uint8Array(32).fill(8)),
    user: new PublicKey(new Uint8Array(32).fill(9)),
    creator: new PublicKey(new Uint8Array(32).fill(9)),
    timestamp: 0n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    isMayhemMode: false,
    isCashbackEnabled: false,
    // Native SOL curves leave this unset. This is the line the bug turned on.
    quoteMint: PublicKey.default,
    virtualQuoteReserves: 30_000_000_000n,
    signature: 'sig',
    detectedAt: Date.now(),
    devBuyPct: 0,
    devBuySol: 0,
    ...over,
  }) as DetectedToken;

interface Case {
  name: string;
  token: DetectedToken;
  shouldPass: boolean;
}

const cases: Case[] = [
  { name: 'ordinary launch, native SOL curve', token: normalLaunch(), shouldPass: true },
  {
    name: 'ordinary launch, quoteMint spelled as WSOL',
    token: normalLaunch({ quoteMint: WSOL_MINT }),
    shouldPass: true,
  },
  {
    name: 'curve quoted in another token',
    token: normalLaunch({ quoteMint: new PublicKey(new Uint8Array(32).fill(3)) }),
    shouldPass: false,
  },
  {
    name: 'no quote reserves at all (the NaN case)',
    token: normalLaunch({ virtualQuoteReserves: 0n, virtualSolReserves: 0n }),
    shouldPass: false,
  },
  // Mayhem was rejected for most of this bot's life without ever being tested, and it
  // is 38% of launches. Three live mayhem tokens simulate a clean buy and sell with
  // the ordinary instruction layout, so it must pass.
  { name: 'mayhem mode (trades fine, must pass)', token: normalLaunch({ isMayhemMode: true }), shouldPass: true },
  {
    name: 'cashback token (cannot be sold)',
    token: normalLaunch({ isCashbackEnabled: true }),
    shouldPass: false,
  },
];

let failures = 0;
for (const testCase of cases) {
  const verdict = evaluate(testCase.token, config, new CreatorHistory());
  const ok = verdict.passed === testCase.shouldPass;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${testCase.name.padEnd(42)} ` +
      `expected ${testCase.shouldPass ? 'pass' : 'reject'}, got ${
        verdict.passed ? 'pass' : `reject (${verdict.reason})`
      }`,
  );
}

// The check that would have caught the original bug on its own: a filter that rejects
// every ordinary launch is broken however sensible each individual rule looks.
const ordinary = cases.filter((c) => c.shouldPass);
const passing = ordinary.filter((c) => evaluate(c.token, config, new CreatorHistory()).passed);
console.log(
  `\n${passing.length} of ${ordinary.length} ordinary launches pass the filter.` +
    (passing.length === 0 ? '  <- this is the production failure mode' : ''),
);
process.exit(failures === 0 ? 0 : 1);
