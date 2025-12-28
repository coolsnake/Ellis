/**
 * MarginFi Flashloan Integration
 * 
 * This module provides helpers to build MarginFi flashloan transactions.
 * 
 * IMPORTANT: MarginFi's start_flashloan and end_flashloan MUST be top-level 
 * instructions (they cannot be called via CPI). However, the borrow and repay
 * operations within a flashloan CAN be called via CPI.
 * 
 * Transaction structure for flashloans:
 * 1. lending_account_start_flashloan (top-level, sets ACCOUNT_IN_FLASHLOAN flag)
 * 2. lending_account_borrow (top-level or CPI)
 * 3. [Your operations - swaps, arbitrage, etc.]
 * 4. lending_account_repay (top-level or CPI)
 * 5. lending_account_end_flashloan (top-level, validates account health)
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';

// ============================================================================
// Constants
// ============================================================================

/** MarginFi V2 Program ID (mainnet) */
export const MARGINFI_PROGRAM_ID = new PublicKey('MFv2hWf31Z9kbCa1snEPYcT1Z2Fr6zcZRadkZ8Jr9cs');

/** MarginFi Group ID (mainnet - main group) */
export const MARGINFI_GROUP_ID = new PublicKey('4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8');

/** Known MarginFi Banks (mainnet) */
export const MARGINFI_BANKS = {
  SOL: new PublicKey('CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh'),
  USDC: new PublicKey('2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB'),
} as const;

/** Bank Liquidity Vault Authorities (for deriving liquidity vaults) */
export const BANK_LIQUIDITY_VAULT_AUTHORITIES = {
  SOL: new PublicKey('DD3AeAssFvjqTvRTrRAtpfjkBF8FpVKnFuwnMLN9haXD'),
  USDC: new PublicKey('3uxNepDbmkDNq6JhRja5Z8QwbTrfmkKP8AKZV5chYDGG'),
} as const;

/** Instruction Sysvar */
export const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey('Sysvar1nstructions1111111111111111111111111');

// ============================================================================
// Instruction Discriminators (from MarginFi IDL)
// ============================================================================

/**
 * These discriminators are taken directly from the MarginFi IDL.
 * They are the first 8 bytes that identify each instruction.
 */
const INSTRUCTION_DISCRIMINATORS = {
  // From IDL: "discriminator": [43, 78, 61, 255, 148, 52, 249, 154]
  marginfi_account_initialize: Buffer.from([43, 78, 61, 255, 148, 52, 249, 154]),
  
  // From IDL: "discriminator": [87, 177, 91, 80, 218, 119, 245, 31]
  marginfi_account_initialize_pda: Buffer.from([87, 177, 91, 80, 218, 119, 245, 31]),
  
  // From IDL: "discriminator": [171, 94, 235, 103, 82, 64, 212, 140]
  lending_account_deposit: Buffer.from([171, 94, 235, 103, 82, 64, 212, 140]),
  
  // From IDL: "discriminator": [4, 126, 116, 53, 48, 5, 212, 31]
  lending_account_borrow: Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]),
  
  // From IDL: "discriminator": [79, 209, 172, 177, 222, 51, 173, 151]
  lending_account_repay: Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]),
  
  // From IDL: "discriminator": [36, 72, 74, 19, 210, 210, 192, 192]
  lending_account_withdraw: Buffer.from([36, 72, 74, 19, 210, 210, 192, 192]),
  
  // From IDL: "discriminator": [14, 131, 33, 220, 81, 186, 180, 107]
  lending_account_start_flashloan: Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]),
  
  // From IDL: "discriminator": [105, 124, 201, 106, 153, 2, 8, 156]
  lending_account_end_flashloan: Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]),
} as const;

// ============================================================================
// Types
// ============================================================================

export interface MarginfiAccountInfo {
  address: PublicKey;
  group: PublicKey;
  authority: PublicKey;
  balances: MarginfiBalance[];
}

export interface MarginfiBalance {
  bankPk: PublicKey;
  active: boolean;
  assetShares: BN;
  liabilityShares: BN;
}

export interface BankInfo {
  address: PublicKey;
  mint: PublicKey;
  liquidityVault: PublicKey;
  liquidityVaultAuthority: PublicKey;
  totalAssetShares: BN;
  totalLiabilityShares: BN;
  decimals: number;
}

export interface FlashloanParams {
  /** The user's MarginFi account */
  marginfiAccount: PublicKey;
  /** The bank to borrow from */
  bank: PublicKey;
  /** Amount to borrow (in raw token units) */
  amount: bigint;
  /** Token mint */
  mint: PublicKey;
  /** User's wallet (signer) */
  userWallet: PublicKey;
  /** User's token account to receive borrowed tokens */
  userTokenAccount: PublicKey;
}

export interface FlashloanInstructions {
  /** Start flashloan instruction (must be first) */
  startFlashloan: TransactionInstruction;
  /** Borrow instruction */
  borrow: TransactionInstruction;
  /** Repay instruction */
  repay: TransactionInstruction;
  /** End flashloan instruction (must be last) */
  endFlashloan: TransactionInstruction;
}

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive MarginFi account PDA
 */
export function deriveMarginfiAccountPda(
  group: PublicKey,
  authority: PublicKey,
  accountIndex: number = 0,
  thirdPartyId: number = 0,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('marginfi_account'),
      group.toBuffer(),
      authority.toBuffer(),
      new BN(accountIndex).toArrayLike(Buffer, 'le', 2),
      new BN(thirdPartyId).toArrayLike(Buffer, 'le', 2),
    ],
    MARGINFI_PROGRAM_ID,
  );
}

/**
 * Derive liquidity vault for a bank
 */
export function deriveLiquidityVault(bank: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_vault'), bank.toBuffer()],
    MARGINFI_PROGRAM_ID,
  );
}

/**
 * Derive liquidity vault authority for a bank
 */
export function deriveLiquidityVaultAuthority(bank: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_vault_auth'), bank.toBuffer()],
    MARGINFI_PROGRAM_ID,
  );
}

// ============================================================================
// Instruction Builders
// ============================================================================

/**
 * Build the lending_account_start_flashloan instruction
 * 
 * This instruction sets the ACCOUNT_IN_FLASHLOAN flag on the marginfi account,
 * which disables health checks until end_flashloan is called.
 */
export function buildStartFlashloanInstruction(
  marginfiAccount: PublicKey,
  marginfiGroup: PublicKey,
  signer: PublicKey,
): TransactionInstruction {
  // Accounts for start_flashloan:
  // 1. marginfi_account (writable) - The user's MarginFi account
  // 2. signer - Must be the account authority
  // 3. ixs_sysvar - Instructions sysvar (for validating end_flashloan exists)
  
  const keys: AccountMeta[] = [
    { pubkey: marginfiAccount, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];

  // The instruction data is just the discriminator for start_flashloan
  // We need to find the actual discriminator from the IDL
  // For now, using a placeholder that will need to be updated
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATORS.lending_account_start_flashloan,
    new BN(0).toArrayLike(Buffer, 'le', 8), // end_index - index of end_flashloan in tx
  ]);

  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the lending_account_borrow instruction
 */
export function buildBorrowInstruction(
  marginfiAccount: PublicKey,
  marginfiGroup: PublicKey,
  signer: PublicKey,
  bank: PublicKey,
  destinationTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  // Derive bank PDAs
  const [liquidityVault] = deriveLiquidityVault(bank);
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(bank);

  // Accounts for lending_account_borrow:
  // 1. marginfi_group
  // 2. marginfi_account (writable)
  // 3. signer (authority)
  // 4. bank (writable)
  // 5. destination_token_account (writable) - user's token account
  // 6. bank_liquidity_vault_authority
  // 7. bank_liquidity_vault (writable)
  // 8. token_program

  const keys: AccountMeta[] = [
    { pubkey: marginfiGroup, isSigner: false, isWritable: false },
    { pubkey: marginfiAccount, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: false },
    { pubkey: bank, isSigner: false, isWritable: true },
    { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
    { pubkey: liquidityVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: liquidityVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  // Instruction data: discriminator + amount (u64)
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATORS.lending_account_borrow,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
  ]);

  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the lending_account_repay instruction
 */
export function buildRepayInstruction(
  marginfiAccount: PublicKey,
  marginfiGroup: PublicKey,
  signer: PublicKey,
  bank: PublicKey,
  sourceTokenAccount: PublicKey,
  amount: bigint,
  repayAll: boolean = false,
): TransactionInstruction {
  // Derive bank PDAs
  const [liquidityVault] = deriveLiquidityVault(bank);

  // Accounts for lending_account_repay:
  // 1. marginfi_group
  // 2. marginfi_account (writable)
  // 3. signer (authority)
  // 4. bank (writable)
  // 5. signer_token_account (writable) - source of tokens
  // 6. bank_liquidity_vault (writable)
  // 7. token_program

  const keys: AccountMeta[] = [
    { pubkey: marginfiGroup, isSigner: false, isWritable: false },
    { pubkey: marginfiAccount, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: false },
    { pubkey: bank, isSigner: false, isWritable: true },
    { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
    { pubkey: liquidityVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  // Instruction data: discriminator + amount (u64) + repay_all (bool)
  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATORS.lending_account_repay,
    new BN(amount.toString()).toArrayLike(Buffer, 'le', 8),
    Buffer.from([repayAll ? 1 : 0]),
  ]);

  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the lending_account_end_flashloan instruction
 * 
 * This instruction validates that the account is healthy after all operations
 * and clears the ACCOUNT_IN_FLASHLOAN flag.
 */
export function buildEndFlashloanInstruction(
  marginfiAccount: PublicKey,
  marginfiGroup: PublicKey,
  signer: PublicKey,
  banks: PublicKey[],
): TransactionInstruction {
  // Accounts for end_flashloan:
  // 1. marginfi_account (writable)
  // 2. signer
  // 3+ remaining_accounts: all banks that were touched during the flashloan

  const keys: AccountMeta[] = [
    { pubkey: marginfiAccount, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: false },
    // Add all banks as remaining accounts
    ...banks.map((bank) => ({
      pubkey: bank,
      isSigner: false,
      isWritable: false,
    })),
  ];

  // The instruction data is just the discriminator
  const data = INSTRUCTION_DISCRIMINATORS.lending_account_end_flashloan;

  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build all instructions needed for a simple borrow-repay flashloan test
 */
export function buildFlashloanTestInstructions(
  params: FlashloanParams,
  marginfiGroup: PublicKey = MARGINFI_GROUP_ID,
): FlashloanInstructions {
  return {
    startFlashloan: buildStartFlashloanInstruction(
      params.marginfiAccount,
      marginfiGroup,
      params.userWallet,
    ),
    borrow: buildBorrowInstruction(
      params.marginfiAccount,
      marginfiGroup,
      params.userWallet,
      params.bank,
      params.userTokenAccount,
      params.amount,
    ),
    repay: buildRepayInstruction(
      params.marginfiAccount,
      marginfiGroup,
      params.userWallet,
      params.bank,
      params.userTokenAccount,
      params.amount,
      true, // repay_all to ensure full repayment
    ),
    endFlashloan: buildEndFlashloanInstruction(
      params.marginfiAccount,
      marginfiGroup,
      params.userWallet,
      [params.bank],
    ),
  };
}

// ============================================================================
// Account Fetching
// ============================================================================

/**
 * Check if a MarginFi account exists for a user
 */
export async function getMarginfiAccount(
  connection: Connection,
  authority: PublicKey,
  group: PublicKey = MARGINFI_GROUP_ID,
  accountIndex: number = 0,
): Promise<PublicKey | null> {
  const [accountPda] = deriveMarginfiAccountPda(group, authority, accountIndex);
  
  const accountInfo = await connection.getAccountInfo(accountPda);
  if (!accountInfo) {
    return null;
  }
  
  return accountPda;
}

/**
 * Build instruction to initialize a MarginFi account (keypair version)
 * Note: The account must be a fresh keypair that signs the transaction.
 */
export function buildInitializeAccountInstruction(
  marginfiGroup: PublicKey,
  marginfiAccount: PublicKey,
  authority: PublicKey,
  feePayer: PublicKey,
): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: marginfiGroup, isSigner: false, isWritable: false },
    { pubkey: marginfiAccount, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: feePayer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data: INSTRUCTION_DISCRIMINATORS.marginfi_account_initialize,
  });
}

/**
 * Build instruction to initialize a MarginFi account using PDA
 * This is the preferred method for programmatic account creation.
 * 
 * @param marginfiGroup - The MarginFi group
 * @param authority - The account authority (owner), must sign
 * @param feePayer - Pays for account creation, must sign
 * @param accountIndex - Index to allow multiple accounts per authority (default 0)
 * @param thirdPartyId - Optional third-party tagging (default 0)
 */
export function buildInitializeAccountPdaInstruction(
  marginfiGroup: PublicKey,
  authority: PublicKey,
  feePayer: PublicKey,
  accountIndex: number = 0,
  thirdPartyId: number = 0,
): { instruction: TransactionInstruction; marginfiAccountPda: PublicKey } {
  // Derive the PDA for the marginfi account
  const [marginfiAccountPda] = deriveMarginfiAccountPda(
    marginfiGroup,
    authority,
    accountIndex,
    thirdPartyId,
  );

  const keys: AccountMeta[] = [
    { pubkey: marginfiGroup, isSigner: false, isWritable: false },
    { pubkey: marginfiAccountPda, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: feePayer, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // Instruction data: discriminator + account_index (u16) + third_party_id (Option<u16>)
  // For Option<u16> with Some(value): 1 byte (Some tag) + 2 bytes (value)
  // For Option<u16> with None: 1 byte (None tag)
  const data = Buffer.alloc(8 + 2 + 1 + 2); // discriminator + u16 + option tag + u16
  INSTRUCTION_DISCRIMINATORS.marginfi_account_initialize_pda.copy(data, 0);
  data.writeUInt16LE(accountIndex, 8);
  data.writeUInt8(1, 10); // Some tag for third_party_id
  data.writeUInt16LE(thirdPartyId, 11);

  const instruction = new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys,
    data,
  });

  return { instruction, marginfiAccountPda };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get bank info for a known token
 */
export function getBankForToken(token: 'SOL' | 'USDC'): {
  bank: PublicKey;
  liquidityVaultAuthority: PublicKey;
} {
  return {
    bank: MARGINFI_BANKS[token],
    liquidityVaultAuthority: BANK_LIQUIDITY_VAULT_AUTHORITIES[token],
  };
}

/**
 * Format amount for display
 */
export function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  if (fractionalPart === 0n) {
    return wholePart.toString();
  }
  
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  return `${wholePart}.${fractionalStr}`;
}

