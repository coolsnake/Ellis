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

  // Serialize min_profit as signed i64 (two's complement for negative values)
  const minProfitBn = new BN(params.minProfit.toString());
  const minProfitBuffer = Buffer.alloc(8);
  if (minProfitBn.isNeg()) {
    // Two's complement for negative numbers
    minProfitBn.toTwos(64).toArrayLike(Buffer, 'le', 8).copy(minProfitBuffer);
  } else {
    minProfitBn.toArrayLike(Buffer, 'le', 8).copy(minProfitBuffer);
  }

  const data = Buffer.concat([
    DISCRIMINATORS.execute,
    stepsVec,
    minProfitBuffer,
  ]);

  const keys = [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // Add all DEX accounts as remaining accounts
    ...allDexAccounts.map((pubkey) => ({
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
 * Get the number of accounts needed for a DEX swap
 * These must match the on-chain ACCOUNTS_NEEDED constants in arb-router
 */
export function getAccountsNeededForDex(dexType: DexType): number {
  switch (dexType) {
    case DexType.Raydium:
      return 17; // Raydium CLMM
    case DexType.Meteora:
      return 16; // Meteora DLMM
    case DexType.Orca:
      return 15; // Orca Whirlpool
    case DexType.PumpSwap:
      return 12; // PumpSwap
    default:
      return 12;
  }
}

/**
 * Map string DEX name to DexType enum
 */
export function dexNameToType(dex: string, variant?: string): DexType {
  const dexLower = dex.toLowerCase();
  
  if (dexLower === 'raydium' && variant === 'clmm') return DexType.Raydium;
  if (dexLower === 'raydium') return DexType.Raydium;
  if (dexLower === 'meteora') return DexType.Meteora;
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


