import {
  PublicKey,
  SystemProgram,
  type AccountMeta,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ATA_PROGRAM,
  FEE_PROGRAM,
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type CurveQuote,
} from './pump.js';

/**
 * pump.fun's AMM, where a token lands after it graduates off the bonding curve.
 *
 * Everything in this file was read off mainnet rather than taken from the published
 * IDL, because the IDL is behind the deployed program in exactly the way pump.fun's
 * own is: it lists 23 accounts for a buy where live transactions pass 26. The three
 * extras are pool_v2 (an undocumented PDA, the sibling of bonding-curve-v2) and the
 * buyback fee recipient with its token account.
 */
export const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Same fee program as the bonding curve, but its own fee_config seed. */
const FEE_CONFIG_SEED = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
  244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
export const SWAP_BUY_EVENT_DISCRIMINATOR = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
export const SWAP_SELL_EVENT_DISCRIMINATOR = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
export const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

const seed = (s: string) => Buffer.from(s);
const derive = (seeds: Buffer[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const swapGlobalConfigPda = () => derive([seed('global_config')], PUMPSWAP_PROGRAM);
export const swapEventAuthorityPda = () => derive([seed('__event_authority')], PUMPSWAP_PROGRAM);
export const swapFeeConfigPda = () => derive([seed('fee_config'), FEE_CONFIG_SEED], FEE_PROGRAM);
export const swapGlobalVolumePda = () =>
  derive([seed('global_volume_accumulator')], PUMPSWAP_PROGRAM);
export const swapUserVolumePda = (user: PublicKey) =>
  derive([seed('user_volume_accumulator'), user.toBuffer()], PUMPSWAP_PROGRAM);
export const coinCreatorVaultAuthorityPda = (coinCreator: PublicKey) =>
  derive([seed('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM);

/**
 * Undocumented, and required: live buys and sells on graduated pools all pass it.
 * The account is uninitialised on chain, the same shape as bonding-curve-v2.
 */
export const poolV2Pda = (baseMint: PublicKey) =>
  derive([seed('pool-v2'), baseMint.toBuffer()], PUMPSWAP_PROGRAM);

/**
 * A graduated pool's address needs no lookup. pump.fun migrates every token with a
 * pool authority derived from the mint and an index of zero, so the whole address is
 * a local computation — which matters, because an RPC round trip on this path costs
 * more than every other stage of the entry combined.
 */
export const migrationAuthorityPda = (baseMint: PublicKey) =>
  derive([seed('pool-authority'), baseMint.toBuffer()], PUMP_PROGRAM);

export function graduatedPoolPda(baseMint: PublicKey, index = 0): PublicKey {
  const indexBytes = Buffer.alloc(2);
  indexBytes.writeUInt16LE(index);
  return derive(
    [
      seed('pool'),
      indexBytes,
      migrationAuthorityPda(baseMint).toBuffer(),
      baseMint.toBuffer(),
      WSOL_MINT.toBuffer(),
    ],
    PUMPSWAP_PROGRAM,
  );
}

export const ataFor = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  derive([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

export interface SwapPool {
  address: PublicKey;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
}

export function decodePool(address: PublicKey, data: Buffer): SwapPool | null {
  if (data.length < 245 || !data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) return null;
  const pk = (offset: number) => new PublicKey(data.subarray(offset, offset + 32));
  return {
    address,
    index: data.readUInt16LE(9),
    creator: pk(11),
    baseMint: pk(43),
    quoteMint: pk(75),
    poolBaseTokenAccount: pk(139),
    poolQuoteTokenAccount: pk(171),
    lpSupply: data.readBigUInt64LE(203),
    coinCreator: pk(211),
    isMayhemMode: data[243] === 1,
    isCashbackCoin: data[244] === 1,
  };
}

export interface SwapGlobalConfig {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  coinCreatorFeeBps: bigint;
  protocolFeeRecipients: PublicKey[];
  reservedFeeRecipient: PublicKey;
  buybackFeeRecipients: PublicKey[];
}

export function decodeSwapGlobalConfig(data: Buffer): SwapGlobalConfig {
  let offset = 8;
  const pk = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const u64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  pk(); // admin
  const lpFeeBps = u64();
  const protocolFeeBps = u64();
  offset += 1; // disable_flags
  const protocolFeeRecipients = Array.from({ length: 8 }, pk);
  const coinCreatorFeeBps = u64();
  pk(); // admin_set_coin_creator_authority
  pk(); // whitelist_pda
  const reservedFeeRecipient = pk();
  offset += 1; // mayhem_mode_enabled
  for (let i = 0; i < 7; i++) pk(); // reserved_fee_recipients
  offset += 1; // is_cashback_enabled
  const buybackFeeRecipients = Array.from({ length: 8 }, pk);
  return {
    lpFeeBps,
    protocolFeeBps,
    coinCreatorFeeBps,
    protocolFeeRecipients,
    reservedFeeRecipient,
    buybackFeeRecipients,
  };
}

/** Total swap fee in basis points — lp plus protocol plus the coin creator's cut. */
export const swapFeeBps = (config: SwapGlobalConfig): number =>
  Number(config.lpFeeBps + config.protocolFeeBps + config.coinCreatorFeeBps);

/**
 * Ordered the opposite way round from the bonding curve's, and deliberately so:
 * ordinary pools reject the reserved recipient outright with
 * InvalidProtocolFeeRecipient, and every live swap sampled from mainnet used an entry
 * from protocol_fee_recipients.
 *
 * The reserved recipient is not a fallback for form's sake, though — mayhem pools
 * require it and reject all eight of the others. It has to be reachable, which is why
 * the caller iterates every candidate rather than capping the rotation.
 */
export function swapFeeRecipientCandidates(config: SwapGlobalConfig): PublicKey[] {
  const seen = new Set<string>();
  return [...config.protocolFeeRecipients, config.reservedFeeRecipient].filter((key) => {
    const id = key.toBase58();
    if (seen.has(id) || key.equals(PublicKey.default)) return false;
    seen.add(id);
    return true;
  });
}

/** A pool priced as a constant product, so the existing quote maths applies unchanged. */
export function poolQuote(baseReserves: bigint, quoteReserves: bigint): CurveQuote {
  return { virtualTokenReserves: baseReserves, virtualQuoteReserves: quoteReserves };
}

export interface SwapTrade {
  pool: PublicKey;
  user: PublicKey;
  isBuy: boolean;
  baseAmount: bigint;
  quoteAmount: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
}

/**
 * Both swap events share their first 184 bytes, and a BuyEvent turns variable-length
 * further along (it carries an `ix_name` string). Reading only the fixed prefix keeps
 * this immune to fields appended later — the same reason the bonding-curve decoder
 * stops early.
 *
 * The reserves in the event are post-trade, which is what a price needs.
 */
export function decodeSwapTradePrefix(data: Buffer, isBuy: boolean): SwapTrade | null {
  if (data.length < 184) return null;
  return {
    isBuy,
    baseAmount: data.readBigUInt64LE(16),
    quoteAmount: data.readBigUInt64LE(64),
    poolBaseReserves: data.readBigUInt64LE(48),
    poolQuoteReserves: data.readBigUInt64LE(56),
    pool: new PublicKey(data.subarray(120, 152)),
    user: new PublicKey(data.subarray(152, 184)),
  };
}

const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});

export interface SwapParams {
  pool: SwapPool;
  user: PublicKey;
  baseTokenProgram: PublicKey;
  protocolFeeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

/**
 * Accounts 0-22 follow the IDL; 23-25 are the undocumented tail found on mainnet.
 * Order matters absolutely — Anchor resolves these positionally.
 */
function swapAccounts(p: SwapParams, includeVolume: boolean): AccountMeta[] {
  const quoteTokenProgram = TOKEN_PROGRAM; // WSOL is always classic SPL
  const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(p.pool.coinCreator);
  const accounts: AccountMeta[] = [
    meta(p.pool.address, true),
    meta(p.user, true, true),
    meta(swapGlobalConfigPda(), false),
    meta(p.pool.baseMint, false),
    meta(p.pool.quoteMint, false),
    meta(ataFor(p.user, p.pool.baseMint, p.baseTokenProgram), true),
    meta(ataFor(p.user, p.pool.quoteMint, quoteTokenProgram), true),
    meta(p.pool.poolBaseTokenAccount, true),
    meta(p.pool.poolQuoteTokenAccount, true),
    meta(p.protocolFeeRecipient, false),
    meta(ataFor(p.protocolFeeRecipient, p.pool.quoteMint, quoteTokenProgram), true),
    meta(p.baseTokenProgram, false),
    meta(quoteTokenProgram, false),
    meta(SystemProgram.programId, false),
    meta(ATA_PROGRAM, false),
    meta(swapEventAuthorityPda(), false),
    meta(PUMPSWAP_PROGRAM, false),
    meta(ataFor(coinCreatorVaultAuthority, p.pool.quoteMint, quoteTokenProgram), true),
    meta(coinCreatorVaultAuthority, false),
  ];
  // Only a buy tracks volume; the sell instruction has no accumulator accounts at all.
  if (includeVolume) {
    accounts.push(meta(swapGlobalVolumePda(), false), meta(swapUserVolumePda(p.user), true));
  }
  accounts.push(
    meta(swapFeeConfigPda(), false),
    meta(FEE_PROGRAM, false),
    meta(poolV2Pda(p.pool.baseMint), true),
    meta(p.buybackFeeRecipient, true),
    meta(ataFor(p.buybackFeeRecipient, p.pool.quoteMint, quoteTokenProgram), true),
  );
  return accounts;
}

/** baseAmountOut is exact; maxQuoteAmountIn is the slippage cap the program enforces. */
export function buildSwapBuyInstruction(
  params: SwapParams,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(25);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(baseAmountOut, 8);
  data.writeBigUInt64LE(maxQuoteAmountIn, 16);
  data[24] = 1; // track_volume: OptionBool
  return {
    programId: PUMPSWAP_PROGRAM,
    keys: swapAccounts(params, true),
    data,
  } as TransactionInstruction;
}

export function buildSwapSellInstruction(
  params: SwapParams,
  baseAmountIn: bigint,
  minQuoteAmountOut: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(baseAmountIn, 8);
  data.writeBigUInt64LE(minQuoteAmountOut, 16);
  return {
    programId: PUMPSWAP_PROGRAM,
    keys: swapAccounts(params, false),
    data,
  } as TransactionInstruction;
}

/**
 * Which token program owns a mint. pump.fun mints are Token-2022 now, but older
 * graduated ones are not.
 *
 * Null for anything else, deliberately. The obvious form of this — Token-2022 if it
 * matches, classic otherwise — treats a failed read, a closed account, or a
 * mis-derived address as classic SPL and builds an instruction against the wrong
 * program. Defaulting is the wrong instinct here: not knowing which program owns a
 * mint is a reason to leave the token alone, not to pick one.
 */
export const tokenProgramFromOwner = (owner: PublicKey): PublicKey | null => {
  if (owner.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
  if (owner.equals(TOKEN_PROGRAM)) return TOKEN_PROGRAM;
  return null;
};

const metaFor = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});

/**
 * The AMM takes its quote side as wrapped SOL, not lamports, so a buy has to fund a
 * WSOL account first and a sell has to unwrap what comes back. Both directions close
 * the account afterwards, which returns the wrapped balance and the rent together —
 * leaving it open would strand SOL in a token account trade after trade.
 */
export function buildSyncNativeInstruction(account: PublicKey): TransactionInstruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [metaFor(account, true)],
    data: Buffer.from([17]), // TokenInstruction::SyncNative
  } as TransactionInstruction;
}

export function buildWrapSolInstructions(
  owner: PublicKey,
  lamports: bigint,
): TransactionInstruction[] {
  const account = ataFor(owner, WSOL_MINT, TOKEN_PROGRAM);
  return [
    {
      programId: ATA_PROGRAM,
      keys: [
        metaFor(owner, true, true),
        metaFor(account, true),
        metaFor(owner, false),
        metaFor(WSOL_MINT, false),
        metaFor(SystemProgram.programId, false),
        metaFor(TOKEN_PROGRAM, false),
      ],
      data: Buffer.from([1]), // CreateIdempotent
    } as TransactionInstruction,
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: account, lamports }),
    buildSyncNativeInstruction(account),
  ];
}

export function buildUnwrapSolInstruction(owner: PublicKey): TransactionInstruction {
  const account = ataFor(owner, WSOL_MINT, TOKEN_PROGRAM);
  return {
    programId: TOKEN_PROGRAM,
    keys: [metaFor(account, true), metaFor(owner, true), metaFor(owner, false, true)],
    data: Buffer.from([9]), // TokenInstruction::CloseAccount
  } as TransactionInstruction;
}
