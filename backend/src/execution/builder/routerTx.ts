/**
 * Router-based transaction building for arbitrage execution
 * 
 * This module provides transaction building that routes swaps through
 * the on-chain arb-router program, with optional flash loan support.
 */

import { PublicKey, TransactionInstruction, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import type { ExecutionPlan, DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { getConnection } from '../../wallet/wallet.js';
import {
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildRouteSwapIx,
  buildExecuteIx,
  deriveVaultPda,
  fetchVault,
  calculateRepayAmount,
  dexNameToType,
  getAccountsNeededForDex,
  DexType,
  ExecutionMode,
  RouteStep,
} from '../../router/index.js';
import { loadRouterConfig, isFlashLoanAvailable } from '../../server/routerConfigStore.js';

// ============================================================================
// Types
// ============================================================================

export interface RouterTxConfig {
  /** Execution mode (flash_loan, direct, auto) */
  mode: ExecutionMode;
  /** Program ID to use */
  programId: PublicKey;
  /** Vault owner for flash loans */
  vaultOwner?: PublicKey;
  /** Minimum profit required (in base units) */
  minProfit?: bigint;
}

export interface RouterTxResult {
  /** Whether router mode was used */
  usedRouter: boolean;
  /** Instructions to execute */
  instructions: TransactionInstruction[];
  /** Whether flash loan was used */
  usedFlashLoan: boolean;
  /** Borrowed amount (if flash loan) */
  borrowedAmount?: bigint;
  /** Expected repay amount (if flash loan) */
  repayAmount?: bigint;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Router Transaction Building
// ============================================================================

/**
 * Build a router-based arbitrage transaction
 * 
 * This wraps an execution plan with flash_borrow/flash_repay if configured,
 * or builds route_swap instructions for direct execution through the router.
 */
export async function buildRouterTransaction(
  plan: ExecutionPlan,
  wallet: { publicKey: PublicKey; secretKey?: Uint8Array },
  config?: Partial<RouterTxConfig>
): Promise<RouterTxResult> {
  const startMs = Date.now();
  
  try {
    // Load router config
    const routerConfig = await loadRouterConfig();
    
    if (!routerConfig.enabled || !routerConfig.programId) {
      return {
        usedRouter: false,
        instructions: [],
        usedFlashLoan: false,
        error: 'Router not enabled or not deployed',
      };
    }

    const programId = new PublicKey(routerConfig.programId);
    const mode = config?.mode ?? routerConfig.executionMode ?? ExecutionMode.Auto;
    const minProfit = config?.minProfit ?? 0n;

    // Determine if we should use flash loan
    const shouldUseFlashLoan = await shouldUseFlashLoanMode(mode, plan, routerConfig);

    if (shouldUseFlashLoan) {
      return buildFlashLoanArbTx(plan, wallet, programId, routerConfig.vaultOwner!, minProfit);
    } else {
      return buildDirectRouterTx(plan, wallet, programId, minProfit);
    }
  } catch (err: any) {
    logCatchError('routerTx.build', err);
    return {
      usedRouter: false,
      instructions: [],
      usedFlashLoan: false,
      error: err.message,
    };
  } finally {
    const elapsed = Date.now() - startMs;
    logger.debug('routerTx.build.timing', {
      cat: 'tx',
      elapsed,
      hops: plan.hops.length,
    });
  }
}

/**
 * Determine if flash loan mode should be used
 */
async function shouldUseFlashLoanMode(
  mode: ExecutionMode,
  plan: ExecutionPlan,
  routerConfig: { vaultOwner: string | null; executionMode: ExecutionMode }
): Promise<boolean> {
  // Direct mode never uses flash loans
  if (mode === ExecutionMode.Direct) {
    return false;
  }

  // Flash loan mode always uses flash loans if available
  if (mode === ExecutionMode.FlashLoan) {
    if (!routerConfig.vaultOwner) {
      logger.warn('routerTx.flashLoan.noVaultOwner', { cat: 'tx' });
      return false;
    }
    return true;
  }

  // Auto mode: check if flash loan is available and beneficial
  if (mode === ExecutionMode.Auto) {
    if (!routerConfig.vaultOwner) {
      return false;
    }

    // Check if this is a cycle (arb) - input mint should equal output mint
    const inputMint = plan.hops[0]?.inputMint;
    const outputMint = plan.hops[plan.hops.length - 1]?.outputMint;
    
    if (inputMint !== outputMint) {
      // Not a cycle, flash loan doesn't make sense
      return false;
    }

    // Check if vault has sufficient funds
    try {
      const connection = getConnection();
      const vaultOwner = new PublicKey(routerConfig.vaultOwner);
      const mint = new PublicKey(inputMint);
      const [vaultAddress] = deriveVaultPda(vaultOwner, mint);
      
      const vault = await fetchVault(connection, vaultAddress);
      if (!vault) {
        return false;
      }

      const requiredAmount = BigInt(plan.hops[0]?.amountInRaw?.toString() ?? '0');
      const availableBalance = vault.balance - vault.borrowedAmount;
      
      return availableBalance >= requiredAmount;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Build a flash loan arbitrage transaction
 */
async function buildFlashLoanArbTx(
  plan: ExecutionPlan,
  wallet: { publicKey: PublicKey },
  programId: PublicKey,
  vaultOwnerStr: string,
  minProfit: bigint
): Promise<RouterTxResult> {
  const instructions: TransactionInstruction[] = [];
  
  try {
    const vaultOwner = new PublicKey(vaultOwnerStr);
    const inputMint = new PublicKey(plan.hops[0].inputMint);
    const borrowAmount = BigInt(plan.hops[0].amountInRaw.toString());
    
    // Get user's token account
    const userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey);

    // 1. Flash borrow
    instructions.push(
      buildFlashBorrowIx(
        wallet.publicKey,
        vaultOwner,
        inputMint,
        userTokenAccount,
        borrowAmount,
        programId
      )
    );

    // 2. Execute swaps (using execute instruction for multi-hop)
    const { steps, dexAccounts } = buildRouteSteps(plan.hops);
    
    instructions.push(
      buildExecuteIx(
        wallet.publicKey,
        userTokenAccount,
        { steps, minProfit },
        dexAccounts,
        programId
      )
    );

    // 3. Flash repay
    const repayAmount = calculateRepayAmount(borrowAmount);
    instructions.push(
      buildFlashRepayIx(
        wallet.publicKey,
        vaultOwner,
        inputMint,
        userTokenAccount,
        repayAmount,
        programId
      )
    );

    logger.info('routerTx.flashLoan.built', {
      cat: 'tx',
      code: LogCode.TX_BUILD_OK,
      ctx: {
        hops: plan.hops.length,
        borrowAmount: borrowAmount.toString(),
        repayAmount: repayAmount.toString(),
      },
    });

    return {
      usedRouter: true,
      instructions,
      usedFlashLoan: true,
      borrowedAmount: borrowAmount,
      repayAmount,
    };
  } catch (err: any) {
    logCatchError('routerTx.flashLoan.build', err);
    return {
      usedRouter: false,
      instructions: [],
      usedFlashLoan: false,
      error: err.message,
    };
  }
}

/**
 * Build direct router transaction (no flash loan)
 */
async function buildDirectRouterTx(
  plan: ExecutionPlan,
  wallet: { publicKey: PublicKey },
  programId: PublicKey,
  minProfit: bigint
): Promise<RouterTxResult> {
  const instructions: TransactionInstruction[] = [];

  try {
    const inputMint = new PublicKey(plan.hops[0].inputMint);
    const userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey);

    // Build route steps and execute
    const { steps, dexAccounts } = buildRouteSteps(plan.hops);

    instructions.push(
      buildExecuteIx(
        wallet.publicKey,
        userTokenAccount,
        { steps, minProfit },
        dexAccounts,
        programId
      )
    );

    logger.info('routerTx.direct.built', {
      cat: 'tx',
      code: LogCode.TX_BUILD_OK,
      ctx: {
        hops: plan.hops.length,
        steps: steps.length,
      },
    });

    return {
      usedRouter: true,
      instructions,
      usedFlashLoan: false,
    };
  } catch (err: any) {
    logCatchError('routerTx.direct.build', err);
    return {
      usedRouter: false,
      instructions: [],
      usedFlashLoan: false,
      error: err.message,
    };
  }
}

/**
 * Build route steps from execution plan hops
 */
function buildRouteSteps(hops: DirectHop[]): {
  steps: RouteStep[];
  dexAccounts: PublicKey[];
} {
  const steps: RouteStep[] = [];
  const dexAccounts: PublicKey[] = [];

  for (const hop of hops) {
    const dexType = dexNameToType(hop.dex, hop.variant);

    steps.push({
      dexType,
      amountIn: BigInt(hop.amountInRaw.toString()),
      minAmountOut: BigInt(hop.minOutRaw.toString()),
    });

    // Collect DEX accounts for this hop
    const hopAccounts = extractDexAccounts(hop, dexType);
    dexAccounts.push(...hopAccounts);
  }

  return { steps, dexAccounts };
}

/**
 * Extract DEX-specific accounts from a hop
 */
function extractDexAccounts(hop: DirectHop, dexType: DexType): PublicKey[] {
  const accounts: PublicKey[] = [];

  try {
    // Common accounts
    const poolId = new PublicKey(hop.poolId);
    const programIdKey = new PublicKey(hop.programId);
    const inputMint = new PublicKey(hop.inputMint);
    const outputMint = new PublicKey(hop.outputMint);

    switch (dexType) {
      case DexType.Raydium:
        // Raydium CLMM accounts
        accounts.push(
          programIdKey,
          poolId,
          hop.ammConfig ? new PublicKey(hop.ammConfig) : poolId,
          hop.vaultA ? new PublicKey(hop.vaultA) : poolId,
          hop.vaultB ? new PublicKey(hop.vaultB) : poolId,
          hop.observationId ? new PublicKey(hop.observationId) : poolId,
          hop.tickArrayLower ? new PublicKey(hop.tickArrayLower) : poolId,
          hop.tickArrayCenter ? new PublicKey(hop.tickArrayCenter) : poolId,
          hop.tickArrayUpper ? new PublicKey(hop.tickArrayUpper) : poolId,
          inputMint,
          outputMint,
          new PublicKey(hop.userSourceAta),
          new PublicKey(hop.userDestAta),
          TOKEN_PROGRAM_ID,
          // Additional accounts for Raydium
          poolId, // owner
          poolId, // ex_bitmap_account (placeholder)
          poolId, // oracle (placeholder)
        );
        break;

      case DexType.Meteora:
        // Meteora DLMM accounts
        accounts.push(
          programIdKey,
          poolId,
          hop.reserveX ? new PublicKey(hop.reserveX) : poolId,
          hop.reserveY ? new PublicKey(hop.reserveY) : poolId,
          inputMint,
          outputMint,
          new PublicKey(hop.userSourceAta),
          new PublicKey(hop.userDestAta),
          hop.binArrayLower ? new PublicKey(hop.binArrayLower) : poolId,
          hop.binArrayUpper ? new PublicKey(hop.binArrayUpper) : poolId,
          hop.bitmapExtension ? new PublicKey(hop.bitmapExtension) : programIdKey,
          TOKEN_PROGRAM_ID,
          poolId, // oracle
          poolId, // host_fee_in
          poolId, // event_authority
        );
        break;

      case DexType.Orca:
        // Orca Whirlpool accounts
        accounts.push(
          programIdKey,
          poolId,
          hop.vaultA ? new PublicKey(hop.vaultA) : poolId,
          hop.vaultB ? new PublicKey(hop.vaultB) : poolId,
          hop.tickArrayLower ? new PublicKey(hop.tickArrayLower) : poolId,
          hop.tickArrayCenter ? new PublicKey(hop.tickArrayCenter) : poolId,
          hop.tickArrayUpper ? new PublicKey(hop.tickArrayUpper) : poolId,
          new PublicKey(hop.userSourceAta),
          new PublicKey(hop.userDestAta),
          TOKEN_PROGRAM_ID,
          hop.oracle ? new PublicKey(hop.oracle) : poolId,
        );
        break;

      case DexType.PumpSwap:
        // PumpSwap accounts
        accounts.push(
          programIdKey,
          poolId,
          hop.vaultA ? new PublicKey(hop.vaultA) : poolId,
          hop.vaultB ? new PublicKey(hop.vaultB) : poolId,
          inputMint,
          outputMint,
          new PublicKey(hop.userSourceAta),
          new PublicKey(hop.userDestAta),
          TOKEN_PROGRAM_ID,
          poolId, // fee_account
        );
        break;
    }
  } catch (err: any) {
    logger.error('routerTx.extractAccounts.error', {
      cat: 'tx',
      error: err.message,
      dex: hop.dex,
      poolId: hop.poolId,
    });
  }

  // Ensure we have the expected number of accounts
  const expected = getAccountsNeededForDex(dexType);
  while (accounts.length < expected) {
    // Pad with pool ID as placeholder
    accounts.push(new PublicKey(hop.poolId));
  }

  return accounts.slice(0, expected);
}

/**
 * Check if router execution is available for a plan
 */
export async function isRouterAvailableForPlan(plan: ExecutionPlan): Promise<{
  available: boolean;
  flashLoanAvailable: boolean;
  reason?: string;
}> {
  try {
    const config = await loadRouterConfig();

    if (!config.enabled) {
      return { available: false, flashLoanAvailable: false, reason: 'Router not enabled' };
    }

    if (!config.programId) {
      return { available: false, flashLoanAvailable: false, reason: 'Router not deployed' };
    }

    // Check flash loan availability
    const flashLoanAvail = await isFlashLoanAvailable();

    return {
      available: true,
      flashLoanAvailable: flashLoanAvail,
    };
  } catch (err: any) {
    return {
      available: false,
      flashLoanAvailable: false,
      reason: err.message,
    };
  }
}


