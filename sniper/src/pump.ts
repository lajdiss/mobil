import {
  PublicKey,
  SystemProgram,
  type AccountMeta,
  type TransactionInstruction,
} from '@solana/web3.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Second seed of the fee program's fee_config PDA, taken from the on-chain IDL.
const FEE_CONFIG_SEED = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
  81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
export const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
export const TRADE_EVENT_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
export const ANCHOR_CPI_EVENT_PREFIX = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

const seed = (s: string) => Buffer.from(s);
const derive = (seeds: Buffer[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const globalPda = () => derive([seed('global')], PUMP_PROGRAM);
export const eventAuthorityPda = () => derive([seed('__event_authority')], PUMP_PROGRAM);
export const bondingCurvePda = (mint: PublicKey) =>
  derive([seed('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);

/**
 * Undocumented in the published IDL: the program rejects a buy without it
 * (error 6074 InvalidBondingCurveV2). Seed confirmed against mainnet transactions.
 */
export const bondingCurveV2Pda = (mint: PublicKey) =>
  derive([seed('bonding-curve-v2'), mint.toBuffer()], PUMP_PROGRAM);

export const creatorVaultPda = (creator: PublicKey) =>
  derive([seed('creator-vault'), creator.toBuffer()], PUMP_PROGRAM);
export const globalVolumeAccumulatorPda = () =>
  derive([seed('global_volume_accumulator')], PUMP_PROGRAM);
export const userVolumeAccumulatorPda = (user: PublicKey) =>
  derive([seed('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM);
export const feeConfigPda = () => derive([seed('fee_config'), FEE_CONFIG_SEED], FEE_PROGRAM);

export const associatedTokenAddress = (
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
) => derive([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
}

class Reader {
  private offset = 8; // skip anchor discriminator
  constructor(private readonly data: Buffer) {}
  u64() {
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64() {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  bool() {
    const v = this.data[this.offset] === 1;
    this.offset += 1;
    return v;
  }
  pubkey() {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  string() {
    const len = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    const v = this.data.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return v;
  }
  skip(n: number) {
    this.offset += n;
  }
}

export function decodeBondingCurve(data: Buffer): BondingCurve {
  const r = new Reader(data);
  return {
    virtualTokenReserves: r.u64(),
    virtualQuoteReserves: r.u64(),
    realTokenReserves: r.u64(),
    realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    complete: r.bool(),
    creator: r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackCoin: r.bool(),
    quoteMint: r.pubkey(),
  };
}

export interface GlobalState {
  feeRecipients: PublicKey[];
  reservedFeeRecipient: PublicKey;
  buybackFeeRecipients: PublicKey[];
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
}

export function decodeGlobal(data: Buffer): GlobalState {
  const r = new Reader(data);
  r.bool(); // initialized
  r.pubkey(); // authority
  r.pubkey(); // fee_recipient (legacy single)
  r.skip(8 * 4); // initial reserves and total supply
  const feeBasisPoints = r.u64();
  r.pubkey(); // withdraw_authority
  r.bool(); // enable_migrate
  r.u64(); // pool_migration_fee
  const creatorFeeBasisPoints = r.u64();
  const feeRecipients = Array.from({ length: 7 }, () => r.pubkey());
  r.pubkey(); // set_creator_authority
  r.pubkey(); // admin_set_creator_authority
  r.bool(); // create_v2_enabled
  r.pubkey(); // whitelist_pda
  const reservedFeeRecipient = r.pubkey();
  r.bool(); // mayhem_mode_enabled
  for (let i = 0; i < 7; i++) r.pubkey(); // reserved_fee_recipients
  r.bool(); // is_cashback_enabled
  const buybackFeeRecipients = Array.from({ length: 8 }, () => r.pubkey());
  return {
    feeRecipients,
    reservedFeeRecipient,
    buybackFeeRecipients,
    feeBasisPoints,
    creatorFeeBasisPoints,
  };
}

/**
 * Live traffic currently routes fees to reserved_fee_recipient; several entries in
 * the fee_recipients array are stale and rejected with NotAuthorized (error 6000).
 * Ordered so the working one is tried first, with the rest as fallbacks in case
 * pump.fun rotates them again.
 */
export function feeRecipientCandidates(global: GlobalState): PublicKey[] {
  const seen = new Set<string>();
  return [global.reservedFeeRecipient, ...global.feeRecipients].filter((key) => {
    const id = key.toBase58();
    if (seen.has(id) || key.equals(PublicKey.default)) return false;
    seen.add(id);
    return true;
  });
}

export interface CreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: PublicKey;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: PublicKey;
  virtualQuoteReserves: bigint;
}

export function decodeCreateEvent(data: Buffer): CreateEvent {
  const r = new Reader(data);
  return {
    name: r.string(),
    symbol: r.string(),
    uri: r.string(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    user: r.pubkey(),
    creator: r.pubkey(),
    timestamp: r.i64(),
    virtualTokenReserves: r.u64(),
    virtualSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    tokenProgram: r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackEnabled: r.bool(),
    quoteMint: r.pubkey(),
    virtualQuoteReserves: r.u64(),
  };
}

/** Just enough of a curve to price a position. */
export interface CurveQuote {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves?: bigint;
}

export interface TradeUpdate extends CurveQuote {
  mint: PublicKey;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  user: PublicKey;
}

/**
 * Reads only the fixed-offset head of a TradeEvent. Everything after the reserves is
 * variable-length (a string and a vector), and none of it is needed to price a
 * position — decoding just the prefix is both faster and immune to trailing changes.
 */
export function decodeTradeEventPrefix(data: Buffer): TradeUpdate | null {
  // 8 disc + 32 mint + 8 sol + 8 token + 1 isBuy + 32 user + 8 ts + 8 + 8 + 8 + 8
  if (data.length < 129) return null;
  return {
    mint: new PublicKey(data.subarray(8, 40)),
    solAmount: data.readBigUInt64LE(40),
    tokenAmount: data.readBigUInt64LE(48),
    isBuy: data[56] === 1,
    user: new PublicKey(data.subarray(57, 89)),
    virtualQuoteReserves: data.readBigUInt64LE(97),
    virtualTokenReserves: data.readBigUInt64LE(105),
    realTokenReserves: data.readBigUInt64LE(121),
  };
}

const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});

export interface TradeParams {
  mint: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

/**
 * Account order verified against successful mainnet transactions. The published
 * IDL lists only the first 16 accounts; the two trailing ones are required.
 */
export function buildBuyInstruction(
  p: TradeParams,
  tokenAmount: bigint,
  maxSolCost: bigint,
): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const keys: AccountMeta[] = [
    meta(globalPda(), false),
    meta(p.feeRecipient, true),
    meta(p.mint, false),
    meta(curve, true),
    meta(associatedTokenAddress(curve, p.mint, p.tokenProgram), true),
    meta(associatedTokenAddress(p.user, p.mint, p.tokenProgram), true),
    meta(p.user, true, true),
    meta(SystemProgram.programId, false),
    meta(p.tokenProgram, false),
    meta(creatorVaultPda(p.creator), true),
    meta(eventAuthorityPda(), false),
    meta(PUMP_PROGRAM, false),
    meta(globalVolumeAccumulatorPda(), false),
    meta(userVolumeAccumulatorPda(p.user), true),
    meta(feeConfigPda(), false),
    meta(FEE_PROGRAM, false),
    meta(bondingCurveV2Pda(p.mint), true),
    meta(p.buybackFeeRecipient, true),
  ];
  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);
  return { programId: PUMP_PROGRAM, keys, data };
}

/** Same trailing accounts as buy; note creator_vault and token_program are swapped. */
export function buildSellInstruction(
  p: TradeParams,
  tokenAmount: bigint,
  minSolOutput: bigint,
): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const keys: AccountMeta[] = [
    meta(globalPda(), false),
    meta(p.feeRecipient, true),
    meta(p.mint, false),
    meta(curve, true),
    meta(associatedTokenAddress(curve, p.mint, p.tokenProgram), true),
    meta(associatedTokenAddress(p.user, p.mint, p.tokenProgram), true),
    meta(p.user, true, true),
    meta(SystemProgram.programId, false),
    meta(creatorVaultPda(p.creator), true),
    meta(p.tokenProgram, false),
    meta(eventAuthorityPda(), false),
    meta(PUMP_PROGRAM, false),
    meta(feeConfigPda(), false),
    meta(FEE_PROGRAM, false),
    meta(bondingCurveV2Pda(p.mint), true),
    meta(p.buybackFeeRecipient, true),
  ];
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minSolOutput, 16);
  return { programId: PUMP_PROGRAM, keys, data };
}

export function createAtaIdempotentInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return {
    programId: ATA_PROGRAM,
    keys: [
      meta(payer, true, true),
      meta(associatedTokenAddress(owner, mint, tokenProgram), true),
      meta(owner, false),
      meta(mint, false),
      meta(SystemProgram.programId, false),
      meta(tokenProgram, false),
    ],
    data: Buffer.from([1]), // CreateIdempotent
  };
}

/**
 * Reclaims the ~0.0019 SOL of rent locked in an emptied token account. Without this
 * every sniped token permanently costs that much, which at any real snipe rate adds
 * up to far more than the trading fees. The account must already be at zero balance.
 */
export function buildCloseAccountInstruction(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  const account = associatedTokenAddress(owner, mint, tokenProgram);
  return {
    programId: tokenProgram,
    keys: [meta(account, true), meta(owner, true), meta(owner, false, true)],
    data: Buffer.from([9]), // TokenInstruction::CloseAccount
  };
}

/** Constant-product quote: SOL in -> tokens out, ignoring fees. */
export function tokensForSol(curve: CurveQuote, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const out = (solIn * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + solIn);
  const available = curve.realTokenReserves;
  return available !== undefined && out > available ? available : out;
}

/** Constant-product quote: tokens in -> SOL out, ignoring fees. */
export function solForTokens(curve: CurveQuote, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  return (tokensIn * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokensIn);
}

/**
 * Inverse of tokensForSol: what buying this many tokens costs. The buy instruction
 * takes an exact token amount, so this is what the wallet actually pays — not the
 * amount that was asked for.
 */
export function solCostForTokens(curve: CurveQuote, tokensOut: bigint): bigint {
  if (tokensOut <= 0n) return 0n;
  if (tokensOut >= curve.virtualTokenReserves) return 0n;
  return (tokensOut * curve.virtualQuoteReserves) / (curve.virtualTokenReserves - tokensOut);
}

export const pickRandom = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
