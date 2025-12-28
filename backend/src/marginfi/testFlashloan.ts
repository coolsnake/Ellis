/**
 * MarginFi Flashloan Testing Module
 * 
 * Uses the official MarginFi SDK for reliable flashloan execution.
 * Based on: https://docs.marginfi.com/ts-sdk
 */

import {
  Connection,
  Keypair,
} from '@solana/web3.js';
import { MarginfiClient, MarginfiAccountWrapper, getConfig } from '@mrgnlabs/marginfi-client-v2';
import { Wallet } from '@coral-xyz/anchor';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface FlashloanTestParams {
  connection: Connection;
  wallet: Keypair;
  token: 'SOL' | 'USDC';
  /** Amount in token units (e.g., 0.001 for 0.001 SOL) */
  amount: number;
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
// Main Test Function
// ============================================================================

/**
 * Run a simple flashloan test using the MarginFi SDK
 * 
 * Transaction structure (handled by SDK):
 * 1. lending_account_start_flashloan
 * 2. lending_account_borrow
 * 3. lending_account_repay
 * 4. lending_account_end_flashloan
 */
export async function runFlashloanTest(
  params: FlashloanTestParams,
): Promise<FlashloanTestResult> {
  const { connection, wallet, token, amount, simulateOnly } = params;
  
  try {
    logger.info('marginfi.flashloan.test.start', {
      cat: 'marginfi',
      token,
      amount,
      simulateOnly,
      wallet: wallet.publicKey.toBase58(),
    });
    
    // Create an Anchor-compatible wallet
    const anchorWallet = new Wallet(wallet);
    
    // Initialize the MarginFi client with production config for mainnet
    const config = getConfig("production");
    const client = await MarginfiClient.fetch(config, anchorWallet, connection);
    
    logger.info('marginfi.flashloan.client.initialized', {
      cat: 'marginfi',
      environment: client.config.environment,
    });
    
    // Get or create MarginFi account
    let marginfiAccount: MarginfiAccountWrapper;
    const existingAccounts = await client.getMarginfiAccountsForAuthority();
    
    if (existingAccounts.length === 0) {
      logger.info('marginfi.flashloan.account.creating', { cat: 'marginfi' });
      marginfiAccount = await client.createMarginfiAccount();
      logger.info('marginfi.flashloan.account.created', {
        cat: 'marginfi',
        address: marginfiAccount.address.toBase58(),
      });
    } else {
      marginfiAccount = existingAccounts[0];
      logger.info('marginfi.flashloan.account.found', {
        cat: 'marginfi',
        address: marginfiAccount.address.toBase58(),
      });
    }
    
    // Get the bank
    const bank = client.getBankByTokenSymbol(token);
    if (!bank) {
      throw new Error(`${token} bank not found`);
    }
    
    logger.info('marginfi.flashloan.bank.found', {
      cat: 'marginfi',
      bank: bank.address.toBase58(),
      mint: bank.mint.toBase58(),
    });
    
    // Build flashloan instructions using SDK
    // The SDK handles all the account lookups (liquidity vault, vault authority, etc.)
    const borrowIx = await marginfiAccount.makeBorrowIx(amount, bank.address);
    const repayIx = await marginfiAccount.makeRepayIx(amount, bank.address, true);
    
    logger.info('marginfi.flashloan.instructions.built', {
      cat: 'marginfi',
      borrowIxCount: borrowIx.instructions.length,
      repayIxCount: repayIx.instructions.length,
    });
    
    // Build the flashloan transaction
    // This wraps borrow/repay in start_flashloan and end_flashloan instructions
    const flashLoanTx = await marginfiAccount.buildFlashLoanTx({
      ixs: [...borrowIx.instructions, ...repayIx.instructions],
      signers: [],
    });
    
    logger.info('marginfi.flashloan.tx.built', {
      cat: 'marginfi',
    });
    
    if (simulateOnly) {
      logger.info('marginfi.flashloan.simulating', { cat: 'marginfi' });
      
      const simulation = await connection.simulateTransaction(flashLoanTx);
      
      if (simulation.value.err) {
        logger.error('marginfi.flashloan.simulation.failed', {
          cat: 'marginfi',
          error: JSON.stringify(simulation.value.err),
          logs: simulation.value.logs,
        });
        
        return {
          success: false,
          simulated: true,
          error: `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
          logs: simulation.value.logs || undefined,
          marginfiAccount: marginfiAccount.address.toBase58(),
          bank: bank.address.toBase58(),
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
        marginfiAccount: marginfiAccount.address.toBase58(),
        bank: bank.address.toBase58(),
        amount: amount.toString(),
      };
    } else {
      logger.info('marginfi.flashloan.executing', { cat: 'marginfi' });
      
      // Use the SDK's processTransaction for proper handling
      const signature = await client.processTransaction(flashLoanTx);
      
      logger.info('marginfi.flashloan.success', {
        cat: 'marginfi',
        signature,
      });
      
      return {
        success: true,
        simulated: false,
        signature,
        marginfiAccount: marginfiAccount.address.toBase58(),
        bank: bank.address.toBase58(),
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
 * Get the recommended test amount for a token (in token units)
 */
export function getRecommendedTestAmount(token: 'SOL' | 'USDC'): number {
  return token === 'SOL' ? 0.001 : 0.001;
}

/**
 * Format amount for display
 */
export function formatTestAmount(token: 'SOL' | 'USDC', amount: number): string {
  return `${amount} ${token}`;
}

/**
 * Check if the user has a MarginFi account and sufficient balance
 */
export async function checkFlashloanPrerequisites(
  connection: Connection,
  walletPublicKey: any, // PublicKey
  token: 'SOL' | 'USDC',
  amount: number,
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
    // For now, we'll do a simpler check since we can't fully initialize the SDK
    // without a signing wallet. Just check balances.
    
    const decimals = token === 'SOL' ? 9 : 6;
    const rawAmount = BigInt(Math.floor(amount * (10 ** decimals)));
    
    let tokenBalance = 0n;
    
    if (token === 'SOL') {
      // Check native SOL balance
      const balance = await connection.getBalance(walletPublicKey);
      tokenBalance = BigInt(balance);
    } else {
      // For USDC, check token account
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const { PublicKey } = await import('@solana/web3.js');
      
      const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const userTokenAccount = getAssociatedTokenAddressSync(usdcMint, walletPublicKey, true);
      
      try {
        const accountInfo = await connection.getTokenAccountBalance(userTokenAccount);
        tokenBalance = BigInt(accountInfo.value.amount);
      } catch {
        tokenBalance = 0n;
      }
    }
    
    const hasEnoughBalance = tokenBalance >= rawAmount;
    const balanceFormatted = Number(tokenBalance) / (10 ** decimals);
    
    // Note: We can't easily check for MarginFi account without full SDK init
    // The SDK will create one if needed during the flashloan test
    return {
      ready: hasEnoughBalance,
      hasMarginfiAccount: false, // Will be checked/created during test
      willCreateAccount: true, // SDK will create if needed
      hasTokenBalance: hasEnoughBalance,
      marginfiAccount: undefined,
      tokenBalance: `${balanceFormatted} ${token}`,
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
