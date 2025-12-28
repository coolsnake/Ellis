/**
 * MarginFi Flashloan Testing Module
 * 
 * Provides functionality to test MarginFi flashloans on mainnet with small amounts.
 * This is a simple borrow-repay cycle without any intermediate operations.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from '../utils/logger.js';
import {
  MARGINFI_PROGRAM_ID,
  MARGINFI_GROUP_ID,
  MARGINFI_BANKS,
  BANK_LIQUIDITY_VAULT_AUTHORITIES,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  buildBorrowInstruction,
  buildRepayInstruction,
  deriveMarginfiAccountPda,
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
  getMarginfiAccount,
  buildInitializeAccountPdaInstruction,
} from './flashloan.js';

// ============================================================================
// Types
// ============================================================================

export interface FlashloanTestParams {
  connection: Connection;
  wallet: Keypair;
  token: 'SOL' | 'USDC';
  /** Amount in raw units (lamports for SOL, smallest unit for USDC) */
  amount: bigint;
  /** If true, only simulate the transaction */
  simulateOnly: boolean;
}

export interface FlashloanTestResult {
  success: boolean;
  simulated: boolean;
  signature?: string;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  marginfiAccount?: string;
  bank?: string;
  amount?: string;
}

// ============================================================================
// Token Configuration
// ============================================================================

const TOKEN_CONFIG = {
  SOL: {
    mint: NATIVE_MINT,
    decimals: 9,
    bank: MARGINFI_BANKS.SOL,
  },
  USDC: {
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    decimals: 6,
    bank: MARGINFI_BANKS.USDC,
  },
} as const;

// ============================================================================
// Instruction Builders (Direct IDL-based)
// ============================================================================

/**
 * Build lending_account_start_flashloan instruction
 * 
 * Based on MarginFi IDL:
 * - Accounts: marginfi_account (writable), signer, ixs_sysvar
 * - Args: end_index (u64) - index of end_flashloan instruction in the transaction
 */
function buildStartFlashloanIx(
  marginfiAccount: PublicKey,
  signer: PublicKey,
  endIndex: number,
): TransactionInstruction {
  // Discriminator for lending_account_start_flashloan
  // This is typically sha256("global:lending_account_start_flashloan")[0..8]
  // We'll compute it properly
  const discriminator = computeDiscriminator('lending_account_start_flashloan');
  
  const data = Buffer.alloc(8 + 8);
  discriminator.copy(data, 0);
  new BN(endIndex).toArrayLike(Buffer, 'le', 8).copy(data, 8);
  
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys: [
      { pubkey: marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build lending_account_end_flashloan instruction
 * 
 * Based on MarginFi IDL:
 * - Accounts: marginfi_account (writable), signer, remaining accounts (banks)
 * - Args: none
 */
function buildEndFlashloanIx(
  marginfiAccount: PublicKey,
  signer: PublicKey,
  banks: PublicKey[],
): TransactionInstruction {
  const discriminator = computeDiscriminator('lending_account_end_flashloan');
  
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys: [
      { pubkey: marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      ...banks.map(bank => ({ pubkey: bank, isSigner: false, isWritable: false })),
    ],
    data: discriminator,
  });
}

/**
 * Compute Anchor instruction discriminator
 * sha256("global:<instruction_name>")[0..8]
 */
function computeDiscriminator(instructionName: string): Buffer {
  // In Node.js, we can use the crypto module
  const crypto = require('crypto');
  const preimage = `global:${instructionName}`;
  const hash = crypto.createHash('sha256').update(preimage).digest();
  return Buffer.from(hash.subarray(0, 8));
}

/**
 * Build lending_account_borrow instruction
 */
function buildBorrowIx(
  marginfiGroup: PublicKey,
  marginfiAccount: PublicKey,
  signer: PublicKey,
  bank: PublicKey,
  destinationTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const [liquidityVault] = deriveLiquidityVault(bank);
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(bank);
  
  const discriminator = computeDiscriminator('lending_account_borrow');
  
  const data = Buffer.alloc(8 + 8);
  discriminator.copy(data, 0);
  new BN(amount.toString()).toArrayLike(Buffer, 'le', 8).copy(data, 8);
  
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys: [
      { pubkey: marginfiGroup, isSigner: false, isWritable: false },
      { pubkey: marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: bank, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: liquidityVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: liquidityVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build lending_account_repay instruction
 */
function buildRepayIx(
  marginfiGroup: PublicKey,
  marginfiAccount: PublicKey,
  signer: PublicKey,
  bank: PublicKey,
  sourceTokenAccount: PublicKey,
  amount: bigint,
  repayAll: boolean,
): TransactionInstruction {
  const [liquidityVault] = deriveLiquidityVault(bank);
  
  const discriminator = computeDiscriminator('lending_account_repay');
  
  // Data: discriminator (8) + amount (8) + repay_all (1)
  const data = Buffer.alloc(8 + 8 + 1);
  discriminator.copy(data, 0);
  new BN(amount.toString()).toArrayLike(Buffer, 'le', 8).copy(data, 8);
  data.writeUInt8(repayAll ? 1 : 0, 16);
  
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM_ID,
    keys: [
      { pubkey: marginfiGroup, isSigner: false, isWritable: false },
      { pubkey: marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: bank, isSigner: false, isWritable: true },
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: liquidityVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ============================================================================
// Main Test Function
// ============================================================================

/**
 * Run a simple flashloan test: borrow -> immediately repay
 * 
 * Transaction structure:
 * 1. ComputeBudget instructions
 * 2. Create ATA if needed
 * 3. lending_account_start_flashloan
 * 4. lending_account_borrow
 * 5. lending_account_repay
 * 6. lending_account_end_flashloan
 */
export async function runFlashloanTest(
  params: FlashloanTestParams,
): Promise<FlashloanTestResult> {
  const { connection, wallet, token, amount, simulateOnly } = params;
  
  try {
    logger.info('marginfi.flashloan.test.start', {
      cat: 'marginfi',
      token,
      amount: amount.toString(),
      simulateOnly,
      wallet: wallet.publicKey.toBase58(),
    });
    
    const config = TOKEN_CONFIG[token];
    const bank = config.bank;
    
    // Check if user has a MarginFi account, create one if not
    let marginfiAccount = await getMarginfiAccount(connection, wallet.publicKey);
    let needsAccountCreation = false;
    
    if (!marginfiAccount) {
      logger.info('marginfi.flashloan.account.not_found', {
        cat: 'marginfi',
        message: 'No MarginFi account found, will create one',
      });
      
      // Derive the PDA for the new account
      const [accountPda] = deriveMarginfiAccountPda(
        MARGINFI_GROUP_ID,
        wallet.publicKey,
        0, // accountIndex
        0, // thirdPartyId
      );
      marginfiAccount = accountPda;
      needsAccountCreation = true;
    } else {
      logger.info('marginfi.flashloan.account.found', {
        cat: 'marginfi',
        marginfiAccount: marginfiAccount.toBase58(),
      });
    }
    
    // Get or create user's token account
    const userTokenAccount = getAssociatedTokenAddressSync(
      config.mint,
      wallet.publicKey,
      true, // allowOwnerOffCurve
    );
    
    // Build transaction
    const tx = new Transaction();
    
    // 1. Compute budget
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    
    // 2. Check if ATA exists, create if needed
    const ataInfo = await connection.getAccountInfo(userTokenAccount);
    if (!ataInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey, // payer
          userTokenAccount,
          wallet.publicKey, // owner
          config.mint,
        ),
      );
    }
    
    // 3. Create MarginFi account if needed
    if (needsAccountCreation) {
      const { instruction: initAccountIx } = buildInitializeAccountPdaInstruction(
        MARGINFI_GROUP_ID,
        wallet.publicKey,
        wallet.publicKey, // feePayer = wallet
        0, // accountIndex
        0, // thirdPartyId
      );
      tx.add(initAccountIx);
      
      logger.info('marginfi.flashloan.account.creating', {
        cat: 'marginfi',
        marginfiAccount: marginfiAccount.toBase58(),
      });
    }
    
    // For SOL, we need to handle wrapped SOL
    if (token === 'SOL') {
      // Transfer SOL to the wSOL account and sync
      // This is needed because we need tokens to repay
      // For a real flashloan, we'd earn profit from the operations
      // For testing, we're just borrowing and repaying, so we need initial balance
      const lamportsToWrap = amount + 10000n; // Extra for rent
      
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userTokenAccount,
          lamports: lamportsToWrap,
        }),
      );
      tx.add(createSyncNativeInstruction(userTokenAccount));
    }
    
    // Calculate instruction indices
    // After compute budget (2) + optional ATA (1) + optional account init (1) + optional SOL wrap (2)
    const baseIndex = 2 + (ataInfo ? 0 : 1) + (needsAccountCreation ? 1 : 0) + (token === 'SOL' ? 2 : 0);
    const startFlashloanIndex = baseIndex;
    const borrowIndex = baseIndex + 1;
    const repayIndex = baseIndex + 2;
    const endFlashloanIndex = baseIndex + 3;
    
    // 3. Start flashloan (points to end_flashloan index)
    tx.add(buildStartFlashloanIx(marginfiAccount, wallet.publicKey, endFlashloanIndex));
    
    // 4. Borrow
    tx.add(buildBorrowIx(
      MARGINFI_GROUP_ID,
      marginfiAccount,
      wallet.publicKey,
      bank,
      userTokenAccount,
      amount,
    ));
    
    // 5. Repay (repay_all = true to handle any interest accrued)
    tx.add(buildRepayIx(
      MARGINFI_GROUP_ID,
      marginfiAccount,
      wallet.publicKey,
      bank,
      userTokenAccount,
      amount,
      true, // repay_all
    ));
    
    // 6. End flashloan
    tx.add(buildEndFlashloanIx(marginfiAccount, wallet.publicKey, [bank]));
    
    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    
    if (simulateOnly) {
      // Simulate
      logger.info('marginfi.flashloan.simulating', { cat: 'marginfi' });
      
      const simulation = await connection.simulateTransaction(tx, [wallet]);
      
      if (simulation.value.err) {
        return {
          success: false,
          simulated: true,
          error: `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
          logs: simulation.value.logs || undefined,
          marginfiAccount: marginfiAccount.toBase58(),
          bank: bank.toBase58(),
          amount: amount.toString(),
        };
      }
      
      logger.info('marginfi.flashloan.simulation.success', {
        cat: 'marginfi',
        unitsConsumed: simulation.value.unitsConsumed,
      });
      
      return {
        success: true,
        simulated: true,
        logs: simulation.value.logs || undefined,
        unitsConsumed: simulation.value.unitsConsumed,
        marginfiAccount: marginfiAccount.toBase58(),
        bank: bank.toBase58(),
        amount: amount.toString(),
      };
    } else {
      // Execute
      logger.info('marginfi.flashloan.executing', { cat: 'marginfi' });
      
      tx.sign(wallet);
      
      const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      
      logger.info('marginfi.flashloan.success', {
        cat: 'marginfi',
        signature,
      });
      
      return {
        success: true,
        simulated: false,
        signature,
        marginfiAccount: marginfiAccount.toBase58(),
        bank: bank.toBase58(),
        amount: amount.toString(),
      };
    }
  } catch (err: any) {
    logger.error('marginfi.flashloan.error', {
      cat: 'marginfi',
      error: err.message,
      stack: err.stack,
    });
    
    return {
      success: false,
      simulated: simulateOnly,
      error: err.message,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the recommended test amount for a token
 */
export function getRecommendedTestAmount(token: 'SOL' | 'USDC'): bigint {
  if (token === 'SOL') {
    return 1_000_000n; // 0.001 SOL
  } else {
    return 1_000n; // 0.001 USDC
  }
}

/**
 * Format amount for display
 */
export function formatTestAmount(token: 'SOL' | 'USDC', amount: bigint): string {
  const decimals = TOKEN_CONFIG[token].decimals;
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  if (fractionalPart === 0n) {
    return `${wholePart} ${token}`;
  }
  
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${wholePart}.${fractionalStr} ${token}`;
}

/**
 * Check if the user has a MarginFi account and sufficient balance
 */
export async function checkFlashloanPrerequisites(
  connection: Connection,
  wallet: PublicKey,
  token: 'SOL' | 'USDC',
  amount: bigint,
): Promise<{
  ready: boolean;
  hasMarginfiAccount: boolean;
  willCreateAccount: boolean;
  hasTokenBalance: boolean;
  marginfiAccount?: string;
  tokenBalance?: string;
  error?: string;
}> {
  try {
    // Check MarginFi account
    let marginfiAccount = await getMarginfiAccount(connection, wallet);
    let willCreateAccount = false;
    
    if (!marginfiAccount) {
      // We'll auto-create the account, derive the PDA to show it
      const [accountPda] = deriveMarginfiAccountPda(
        MARGINFI_GROUP_ID,
        wallet,
        0, // accountIndex
        0, // thirdPartyId
      );
      marginfiAccount = accountPda;
      willCreateAccount = true;
    }
    
    // Check token balance
    const config = TOKEN_CONFIG[token];
    const userTokenAccount = getAssociatedTokenAddressSync(config.mint, wallet, true);
    
    let tokenBalance = 0n;
    
    if (token === 'SOL') {
      // For SOL, check native balance
      const balance = await connection.getBalance(wallet);
      tokenBalance = BigInt(balance);
    } else {
      // For other tokens, check token account
      try {
        const accountInfo = await connection.getTokenAccountBalance(userTokenAccount);
        tokenBalance = BigInt(accountInfo.value.amount);
      } catch {
        tokenBalance = 0n;
      }
    }
    
    const hasEnoughBalance = tokenBalance >= amount;
    
    return {
      ready: hasEnoughBalance,
      hasMarginfiAccount: !willCreateAccount,
      willCreateAccount,
      hasTokenBalance: hasEnoughBalance,
      marginfiAccount: marginfiAccount.toBase58(),
      tokenBalance: formatTestAmount(token, tokenBalance),
      error: hasEnoughBalance ? undefined : `Insufficient ${token} balance for repayment`,
    };
  } catch (err: any) {
    return {
      ready: false,
      hasMarginfiAccount: false,
      willCreateAccount: false,
      hasTokenBalance: false,
      error: err.message,
    };
  }
}

