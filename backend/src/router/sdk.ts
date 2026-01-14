/**
 * SDK for interacting with the arb-router on-chain program
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Connection,
  AccountInfo,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import {
  ARB_ROUTER_PROGRAM_ID,
  VAULT_SEED,
  CONFIG_SEED,
  FLASH_LOAN_FEE_BPS,
  BPS_DENOMINATOR,
  DexType,
  VaultAccount,
  RouteStep,
  ExecuteParams,
  SwapParams,
} from './types.js';

// ============================================================================
// Anchor Instruction Discriminators
// ============================================================================

/**
 * Anchor uses sha256("global:<function_name>")[0..8] as discriminators
 * These are precomputed for performance
 */
export const DISCRIMINATORS = {
  vaultInit: Buffer.from([122, 77, 201, 111, 70, 97, 114, 22]),        // vault_init from IDL
  vaultDeposit: Buffer.from([231, 150, 41, 113, 180, 104, 162, 120]), // vault_deposit from IDL
  vaultWithdraw: Buffer.from([98, 28, 187, 98, 87, 69, 46, 64]),      // vault_withdraw from IDL
  vaultClose: Buffer.from([81, 73, 155, 182, 37, 130, 252, 91]),       // vault_close from IDL
  flashBorrow: Buffer.from([166, 221, 220, 25, 61, 73, 127, 240]),    // flash_borrow from IDL
  flashRepay: Buffer.from([182, 143, 19, 23, 39, 221, 184, 78]),      // flash_repay from IDL
  routeSwap: Buffer.from([114, 150, 13, 192, 140, 252, 221, 31]),     // route_swap from IDL (THIS WAS THE ISSUE!)
  execute: Buffer.from([130, 221, 242, 154, 13, 193, 189, 29]),       // execute from IDL
} as const;

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive the vault PDA for a given owner and mint
 */
export function deriveVaultPda(
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.toBuffer(), mint.toBuffer()],
    programId
  );
}

/**
 * Derive the config PDA
 */
export function deriveConfigPda(
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

// ============================================================================
// Account Deserialization
// ============================================================================

/**
 * Deserialize a Vault account from raw account data
 */
export function deserializeVault(data: Buffer): VaultAccount {
  // Skip 8-byte discriminator
  let offset = 8;

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const mint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const tokenAccount = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const tokenProgram = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const balance = BigInt(new BN(data.subarray(offset, offset + 8), 'le').toString());
  offset += 8;

  const borrowedAmount = BigInt(new BN(data.subarray(offset, offset + 8), 'le').toString());
  offset += 8;

  const flashLoanActive = data[offset] === 1;
  offset += 1;

  const bump = data[offset];

  return {
    owner,
    mint,
    tokenAccount,
    tokenProgram,
    balance,
    borrowedAmount,
    flashLoanActive,
    bump,
  };
}

/**
 * Fetch and deserialize a vault account
 */
export async function fetchVault(
  connection: Connection,
  vaultAddress: PublicKey
): Promise<VaultAccount | null> {
  const accountInfo = await connection.getAccountInfo(vaultAddress);
  if (!accountInfo || !accountInfo.data) {
    return null;
  }
  return deserializeVault(accountInfo.data);
}

/**
 * Fetch all vaults for a given owner
 */
export async function fetchVaultsForOwner(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): Promise<Array<{ address: PublicKey; vault: VaultAccount }>> {
  // Get all program accounts with the vault discriminator
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: 160 }, // Vault size (8 + 32*4 + 8*2 + 1 + 1 + 6 = 160)
      { memcmp: { offset: 8, bytes: owner.toBase58() } }, // Owner at offset 8
    ],
  });

  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    vault: deserializeVault(account.data),
  }));
}

// ============================================================================
// Instruction Builders
// ============================================================================

/**
 * Build vault_init instruction
 */
export function buildVaultInitIx(
  owner: PublicKey,
  mint: PublicKey,
  vaultTokenAccount: PublicKey,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(owner, mint, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.vaultInit,
  });
}

/**
 * Build vault_deposit instruction
 */
export function buildVaultDepositIx(
  owner: PublicKey,
  mint: PublicKey,
  userTokenAccount: PublicKey,
  amount: bigint,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(owner, mint, programId);
  
  // We need to fetch the vault to get its token account
  // For now, assume it follows ATA pattern
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  const data = Buffer.concat([
    DISCRIMINATORS.vaultDeposit,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build vault_withdraw instruction
 */
export function buildVaultWithdrawIx(
  owner: PublicKey,
  mint: PublicKey,
  userTokenAccount: PublicKey,
  amount: bigint,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(owner, mint, programId);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  const data = Buffer.concat([
    DISCRIMINATORS.vaultWithdraw,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build vault_close instruction
 */
export function buildVaultCloseIx(
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(owner, mint, programId);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.vaultClose,
  });
}

/**
 * Build flash_borrow instruction
 */
export function buildFlashBorrowIx(
  borrower: PublicKey,
  vaultOwner: PublicKey,
  mint: PublicKey,
  borrowerTokenAccount: PublicKey,
  amount: bigint,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(vaultOwner, mint, programId);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  const data = Buffer.concat([
    DISCRIMINATORS.flashBorrow,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: borrower, isSigner: true, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: borrowerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build flash_repay instruction
 */
export function buildFlashRepayIx(
  borrower: PublicKey,
  vaultOwner: PublicKey,
  mint: PublicKey,
  borrowerTokenAccount: PublicKey,
  amount: bigint,
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  const [vault] = deriveVaultPda(vaultOwner, mint, programId);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  const data = Buffer.concat([
    DISCRIMINATORS.flashRepay,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: borrower, isSigner: true, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: borrowerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build route_swap instruction
 */
export function buildRouteSwapIx(
  user: PublicKey,
  userTokenAccount: PublicKey,
  params: SwapParams,
  dexAccounts: PublicKey[],
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  // Serialize SwapParams (includes a_to_b direction)
  const data = Buffer.concat([
    DISCRIMINATORS.routeSwap,
    Buffer.from([params.dexType]), // DexType enum
    new BN(params.amountIn.toString()).toArrayLike(Buffer, 'le', 8),
    new BN(params.minAmountOut.toString()).toArrayLike(Buffer, 'le', 8),
    Buffer.from([params.aToB ? 1 : 0]), // a_to_b direction flag
  ]);

  const keys = [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // Add DEX accounts as remaining accounts
    ...dexAccounts.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Build execute instruction for multi-hop routes
 */
export function buildExecuteIx(
  user: PublicKey,
  userTokenAccount: PublicKey,
  params: ExecuteParams,
  allDexAccounts: PublicKey[],
  programId: PublicKey = ARB_ROUTER_PROGRAM_ID
): TransactionInstruction {
  // Serialize ExecuteParams (each step includes a_to_b direction)
  const stepsData = params.steps.map((step) =>
    Buffer.concat([
      Buffer.from([step.dexType]),
      new BN(step.amountIn.toString()).toArrayLike(Buffer, 'le', 8),
      new BN(step.minAmountOut.toString()).toArrayLike(Buffer, 'le', 8),
      Buffer.from([step.aToB ? 1 : 0]), // a_to_b direction flag
    ])
  );

  // Vec<RouteStep> is serialized as: length (4 bytes LE) + concatenated steps
  const stepsVec = Buffer.concat([
    new BN(params.steps.length).toArrayLike(Buffer, 'le', 4),
    ...stepsData,
  ]);

  // Serialize accounts_per_step as Vec<u8>: length (4 bytes LE) + u8 values
  // If not provided, serialize as empty Vec (just the length = 0)
  const accountsPerStep = params.accountsPerStep ?? [];
  const accountsPerStepVec = Buffer.concat([
    new BN(accountsPerStep.length).toArrayLike(Buffer, 'le', 4),
    Buffer.from(accountsPerStep.map(n => n & 0xFF)), // Ensure u8 range
  ]);

  // Serialize min_profit as signed i64 (two's complement for negative values)
  const minProfitBn = new BN(params.minProfit.toString());
  const minProfitBuffer = minProfitBn.isNeg()
    ? Buffer.from(minProfitBn.toTwos(64).toArrayLike(Buffer, 'le', 8))
    : Buffer.from(minProfitBn.toArrayLike(Buffer, 'le', 8));

  // Serialize initial_balances as Vec<u64>: length (4 bytes LE) + u64 values
  // These are pre-existing wallet balances to subtract from dynamic amount propagation
  const initialBalances = params.initialBalances ?? [];
  const initialBalancesData = initialBalances.map(bal => 
    new BN(bal.toString()).toArrayLike(Buffer, 'le', 8)
  );
  const initialBalancesVec = Buffer.concat([
    new BN(initialBalances.length).toArrayLike(Buffer, 'le', 4),
    ...initialBalancesData,
  ]);

  // Serialize verbose as bool (1 byte)
  const verboseBuffer = Buffer.from([params.verbose ? 1 : 0]);

  // Match Rust ExecuteParams field order: steps, accounts_per_step, min_profit, initial_balances, verbose
  const data = Buffer.concat([
    DISCRIMINATORS.execute,
    stepsVec,
    accountsPerStepVec,
    minProfitBuffer,
    initialBalancesVec,
    verboseBuffer,
  ]);

  // DIAGNOSTIC: Log the parameters received
  console.log('[SDK] buildExecuteIx called with:', {
    user: user?.toBase58?.() || 'invalid',
    userTokenAccount: userTokenAccount?.toBase58?.() || 'invalid',
    programId: programId?.toBase58?.() || 'invalid',
    dexAccountsCount: allDexAccounts?.length || 0,
  });
  
  // Program accounts that should NOT be marked as writable
  // These are system/DEX programs used for CPI - writing to them would fail
  const READ_ONLY_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
    '11111111111111111111111111111111',              // System Program
    'SysvarRent111111111111111111111111111111111',   // Rent
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',  // Memo
    'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',  // Memo (old)
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
    // DEX Programs (read-only for CPI)
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DAMM v1
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // PumpSwap Bonding Curve
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // Serum/OpenBook
    'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQBh8x', // OpenBook v2
  ]);

  const keys = [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // Add all DEX accounts - only mark writable if NOT a program account
    ...allDexAccounts.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: !READ_ONLY_PROGRAMS.has(pubkey.toBase58()),
    })),
  ];

  // DIAGNOSTIC: Verify keys[0] matches user and keys[1] matches userTokenAccount
  const key0MatchesUser = keys[0]?.pubkey?.equals?.(user) ?? false;
  const key1MatchesUserToken = keys[1]?.pubkey?.equals?.(userTokenAccount) ?? false;
  
  console.log('[SDK] buildExecuteIx keys built:', {
    keys0_pubkey: keys[0]?.pubkey?.toBase58?.() || 'invalid',
    keys0_isSigner: keys[0]?.isSigner,
    keys0_isWritable: keys[0]?.isWritable,
    keys0_matchesUser: key0MatchesUser,
    keys1_pubkey: keys[1]?.pubkey?.toBase58?.() || 'invalid',
    keys1_isSigner: keys[1]?.isSigner,
    keys1_isWritable: keys[1]?.isWritable,
    keys1_matchesUserToken: key1MatchesUserToken,
  });

  // CRITICAL: Verify the keys are in correct order before returning
  if (!key0MatchesUser || !key1MatchesUserToken) {
    console.error('[SDK] CRITICAL: buildExecuteIx keys order is WRONG!', {
      expected_key0: user?.toBase58?.(),
      actual_key0: keys[0]?.pubkey?.toBase58?.(),
      expected_key1: userTokenAccount?.toBase58?.(),
      actual_key1: keys[1]?.pubkey?.toBase58?.(),
    });
  }

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate flash loan fee for a given amount
 */
export function calculateFlashLoanFee(amount: bigint): bigint {
  const fee = (amount * FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;
  // Minimum fee of 1
  return fee > 0n ? fee : 1n;
}

/**
 * Calculate total repay amount (borrowed + fee)
 */
export function calculateRepayAmount(borrowedAmount: bigint): bigint {
  return borrowedAmount + calculateFlashLoanFee(borrowedAmount);
}

/**
 * Get the MINIMUM number of accounts needed for a DEX swap.
 * These must match the on-chain ACCOUNTS_NEEDED constants in arb-router.
 * 
 * NOTE: Account counts can vary based on pool state and token types:
 * 
 * Raydium CLMM:
 * - WITH exBitmap (18 accounts): 17 SDK accounts + 1 program ID (pools with wide tick ranges)
 * - WITHOUT exBitmap (17 accounts): 16 SDK accounts + 1 program ID (most pools)
 * The on-chain router auto-detects based on account count.
 * 
 * Meteora DLMM:
 * - swap (18 accounts): Standard SPL tokens, no Memo, input/output order
 * - swap2 (19 accounts): Token-2022 compatible, includes Memo, X/Y order
 * The on-chain router auto-detects based on account count.
 */
export function getAccountsNeededForDex(dexType: DexType): number {
  switch (dexType) {
    case DexType.Raydium:
      // Raydium CLMM: Return maximum (with exBitmap). Actual count determined by builder based on pool state.
      return 18;
    case DexType.Meteora:
      // Meteora DLMM (NOTE: Must match arb-router/programs/arb-router/src/dex/meteora.rs)
      // swap: 14 fixed + 1 program + 3 bin arrays = 18 (standard SPL tokens)
      // swap2: 15 fixed + 1 program + 3 bin arrays = 19 (Token-2022)
      // Return minimum (swap). The builder passes appropriate count per variant.
      return 18;
    case DexType.Orca:
      return 12; // Orca Whirlpool: 11 swap accounts + 1 program
    case DexType.PumpSwap:
      return 23; // PumpSwap AMM: 23 accounts (matching @pump-fun/pump-swap-sdk IDL v1.0.0)
    case DexType.RaydiumAmm:
      return 19; // Raydium AMM v4: 18 accounts + program
    case DexType.MeteoraDAMM:
      // Meteora DAMM v1: 16 accounts (with Mercurial Vaults), v2: 13 accounts (swap2, no referral)
      // Return max (v1). Builder determines actual count based on variant.
      return 16;
    case DexType.RaydiumCpmm:
      return 14; // Raydium CPMM: 14 accounts
    default:
      return 12;
  }
}

/**
 * Map string DEX name to DexType enum
 * 
 * IMPORTANT: This maps hop.dex + hop.variant to the correct on-chain DexType
 * The variant is critical for distinguishing between:
 * - Raydium CLMM (clmm) vs AMM v4 (amm) vs CPMM (cpmm)
 * - Meteora DLMM (dlmm) vs DAMM v1/v2 (damm_v1, damm_v2)
 */
export function dexNameToType(dex: string, variant?: string): DexType {
  const dexLower = dex.toLowerCase();
  const variantLower = (variant || '').toLowerCase();
  
  // Raydium variants
  if (dexLower === 'raydium') {
    if (variantLower === 'cpmm') return DexType.RaydiumCpmm;
    if (variantLower === 'amm' || variantLower === 'amm_v4') return DexType.RaydiumAmm;
    // Default to CLMM (includes variant === 'clmm' or no variant)
    return DexType.Raydium;
  }
  
  // Meteora DAMM (Dynamic AMM / Balanced pools) - both v1 and v2
  if (dexLower === 'meteora_balanced') {
    return DexType.MeteoraDAMM;
  }
  
  // Meteora variants
  if (dexLower === 'meteora') {
    if (variantLower === 'damm_v1' || variantLower === 'damm_v2' || variantLower === 'damm' || variantLower === 'balanced') {
      return DexType.MeteoraDAMM;
    }
    // Default to DLMM (includes variant === 'dlmm' or no variant)
    return DexType.Meteora;
  }
  
  // Other DEXes
  if (dexLower === 'orca') return DexType.Orca;
  if (dexLower === 'pumpswap') return DexType.PumpSwap;
  
  throw new Error(`Unsupported DEX: ${dex}/${variant}`);
}

/**
 * Check if an account exists
 */
export async function accountExists(
  connection: Connection,
  address: PublicKey
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(address);
  return accountInfo !== null;
}


