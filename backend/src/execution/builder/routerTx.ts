/**
 * Router-based transaction building for arbitrage execution
 * 
 * This module provides transaction building that routes swaps through
 * the on-chain arb-router program, with optional flash loan support.
 */

import { PublicKey, TransactionInstruction, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, createCloseAccountInstruction, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import type { ExecutionPlan, DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { getConnection, getBalances } from '../../wallet/wallet.js';
import { executionCache } from '../cache.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { buildWrapSolIxs, buildUnwrapSolIx, isSolMint } from '../accounts.js';
import { getTokenMeta } from '../resolver/tokenMeta.js';
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
import { getSdkQuoteAccountsForPlan, type SdkProvidedAccounts } from './sdkQuoteBuilder.js';
import { 
  GLOBAL_CONFIG_PDA as PUMPSWAP_GLOBAL_CONFIG, 
  PUMP_AMM_EVENT_AUTHORITY_PDA as PUMPSWAP_EVENT_AUTHORITY,
  GLOBAL_VOLUME_ACCUMULATOR_PDA as PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_AMM_FEE_CONFIG_PDA as PUMPSWAP_FEE_CONFIG,
  PUMP_FEE_PROGRAM_ID as PUMPSWAP_FEE_PROGRAM,
  coinCreatorVaultAuthorityPda as derivePumpswapCoinCreatorVault,
  coinCreatorVaultAtaPda as derivePumpswapCoinCreatorVaultAta,
  userVolumeAccumulatorPda as derivePumpswapUserVolumeAccumulator,
  OnlinePumpAmmSdk
} from '@pump-fun/pump-swap-sdk';

// ============================================================================
// Constants
// ============================================================================

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const METEORA_DAMM_V1_PROGRAM = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
const METEORA_DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
// Use the post-graduation AMM program (not bonding curve) for Pumpswap
const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const RAYDIUM_AMM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Tick array derivation constants
const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;

// Base58 character set for validation
const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate that a string is a valid base58-encoded Solana address
 * Returns the validated address or null if invalid
 */
function validateBase58Address(address: string | undefined | null, context?: string): string | null {
  if (!address || typeof address !== 'string') {
    return null;
  }

  // Check length (Solana addresses are 32-44 characters in base58)
  if (address.length < 32 || address.length > 44) {
    if (context) {
      logger.warn('routerTx.validateBase58.invalid_length', {
        cat: 'tx',
        context,
        address: address.slice(0, 20),
        length: address.length,
      });
    }
    return null;
  }

  // Check for valid base58 characters
  if (!BASE58_CHARS.test(address)) {
    if (context) {
      logger.warn('routerTx.validateBase58.invalid_chars', {
        cat: 'tx',
        context,
        address: address.slice(0, 20),
      });
    }
    return null;
  }

  // Final validation by creating PublicKey
  try {
    new PublicKey(address);
    return address;
  } catch {
    if (context) {
      logger.warn('routerTx.validateBase58.pubkey_failed', {
        cat: 'tx',
        context,
        address: address.slice(0, 20),
      });
    }
    return null;
  }
}

/**
 * Derive Raydium CLMM observation state PDA
 * Seeds: ["observation", pool_id]
 */
function deriveRaydiumObservationPda(poolId: PublicKey, programId: PublicKey = RAYDIUM_CLMM_PROGRAM): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), poolId.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Derive Raydium CLMM tick array bitmap extension PDA (exBitmap)
 * This is required for pools with large tick ranges to track initialized tick arrays.
 * Seeds: ["pool_tick_array_bitmap_extension", pool_id]
 * Note: This matches the SDK's getPdaExBitmapAccount function
 */
function deriveRaydiumExBitmapPda(poolId: PublicKey, programId: PublicKey = RAYDIUM_CLMM_PROGRAM): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_tick_array_bitmap_extension'), poolId.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Convert token program label to PublicKey
 * Meteora pools may use spl-token or token-2022 for each side
 */
function tokenProgramLabelToKey(label: 'spl-token' | 'token-2022' | undefined): PublicKey {
  return label === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

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
  /** Enable verbose logging on-chain (for simulation/debugging only) */
  verbose?: boolean;
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
    
    // Calculate minProfit from plan's profitability fields if not explicitly provided
    // For arb cycles, minProfit = initialInput * minProfitBps / 10000
    // This enables router-level profitability enforcement via the execute instruction
    let minProfit = config?.minProfit ?? 0n;
    if (minProfit === 0n && plan.isArbCycle && plan.initialInputRaw && plan.minProfitBps !== undefined) {
      minProfit = (plan.initialInputRaw * BigInt(Math.max(0, plan.minProfitBps))) / 10_000n;
      logger.debug('routerTx.minProfit.calculated', {
        cat: 'tx',
        ctx: {
          isArbCycle: plan.isArbCycle,
          initialInputRaw: plan.initialInputRaw.toString(),
          minProfitBps: plan.minProfitBps,
          calculatedMinProfit: minProfit.toString(),
          traceId: plan.traceId,
        },
      });
    }

    // Extract verbose flag (for simulation logging)
    const verbose = config?.verbose ?? false;

    // SDK Quote mode: use DEX SDKs to get accurate tick/bin arrays
    if (mode === ExecutionMode.SdkQuote) {
      return buildSdkQuoteRouterTx(plan, wallet, programId, minProfit, verbose);
    }

    // Determine if we should use flash loan
    const shouldUseFlashLoan = await shouldUseFlashLoanMode(mode, plan, routerConfig);

    if (shouldUseFlashLoan) {
      return buildFlashLoanArbTx(plan, wallet, programId, routerConfig.vaultOwner!, minProfit, verbose);
    } else {
      return buildDirectRouterTx(plan, wallet, programId, minProfit, verbose);
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
  minProfit: bigint,
  verbose: boolean
): Promise<RouterTxResult> {
  const instructions: TransactionInstruction[] = [];
  
  try {
    // Validate and populate missing accounts for each hop BEFORE building
    for (let i = 0; i < plan.hops.length; i++) {
      const hop = plan.hops[i];
      const dexType = dexNameToType(hop.dex, hop.variant);
      const validation = await validateAndPopulateHopAccounts(hop, dexType);
      
      if (!validation.valid) {
        logger.warn('routerTx.flashLoan.validation.failed', {
          cat: 'tx',
          hopIndex: i,
          pool: hop.poolId,
          dex: hop.dex,
          missingAccounts: validation.missingAccounts,
        });
        
        return {
          usedRouter: false,
          instructions: [],
          usedFlashLoan: false,
          error: `Hop ${i} (${hop.dex}/${hop.poolId.slice(0, 8)}...): missing accounts: ${validation.missingAccounts.join(', ')}`,
        };
      }
      
      if (Object.keys(validation.derivedAccounts).length > 0) {
        logger.debug('routerTx.flashLoan.accounts.derived', {
          cat: 'tx',
          hopIndex: i,
          pool: hop.poolId,
          derived: Object.keys(validation.derivedAccounts),
        });
      }
    }
    
    const vaultOwner = new PublicKey(vaultOwnerStr);
    const inputMint = new PublicKey(plan.hops[0].inputMint);
    const borrowAmount = BigInt(plan.hops[0].amountInRaw.toString());
    
    // Get user's token account (use correct token program for Token-2022 mints)
    const inputTokenProgram = plan.hops[0].inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey, false, inputTokenProgram);

    // ==========================================================================
    // CRITICAL: Create ATAs for all tokens before flash loan instructions
    // The router expects token accounts to exist.
    // ==========================================================================
    const connection = getConnection();
    const atasToCreate: { mint: PublicKey; tokenProgram: PublicKey }[] = [];
    
    // Input/output token ATA (same for arb cycles)
    atasToCreate.push({ mint: inputMint, tokenProgram: inputTokenProgram });
    
    // Intermediate token ATAs for multi-hop routes
    for (let i = 0; i < plan.hops.length - 1; i++) {
      const hop = plan.hops[i];
      
      // Skip if same as input (shouldn't happen in well-formed plan)
      if (hop.outputMint === plan.hops[0].inputMint) {
        continue;
      }
      
      if (isSolMint(hop.outputMint)) {
        // SOL intermediate: need WSOL ATA to receive output and pass to next hop
        atasToCreate.push({ mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID });
      } else {
        const intermediateMint = new PublicKey(hop.outputMint);
        const intermediateTokenProgram = hop.outputTokenProgram === 'token-2022' 
          ? TOKEN_2022_PROGRAM_ID 
          : TOKEN_PROGRAM_ID;
        atasToCreate.push({ mint: intermediateMint, tokenProgram: intermediateTokenProgram });
      }
    }
    
    // Check which ATAs need to be created (batch account info fetch)
    // CRITICAL: Also verify the actual token program from mint accounts to avoid
    // "Provided owner is not allowed" errors when cache has stale token program info
    const ataAddresses = atasToCreate.map(({ mint, tokenProgram }) => 
      getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram)
    );
    
    // Fetch both ATA infos and mint infos in parallel for verification
    const mintAddressesFlash = atasToCreate.map(({ mint }) => mint);
    const [ataInfos, mintInfosFlash] = await Promise.all([
      withRpcLimit(
        () => connection.getMultipleAccountsInfo(ataAddresses),
        Math.ceil(ataAddresses.length / 5),
        { module: 'routerTx', method: 'getMultipleAccountsInfo:flashATAs' }
      ),
      withRpcLimit(
        () => connection.getMultipleAccountsInfo(mintAddressesFlash),
        Math.ceil(mintAddressesFlash.length / 5),
        { module: 'routerTx', method: 'getMultipleAccountsInfo:flashMints' }
      ),
    ]);
    
    let atasCreated = 0;
    for (let i = 0; i < atasToCreate.length; i++) {
      if (!ataInfos[i]) {
        const { mint } = atasToCreate[i];
        
        // CRITICAL: Determine actual token program from mint account owner
        let actualTokenProgram = atasToCreate[i].tokenProgram;
        const mintInfo = mintInfosFlash[i];
        if (mintInfo?.owner) {
          const mintOwner = mintInfo.owner.toBase58();
          if (mintOwner === TOKEN_2022_PROGRAM_ID.toBase58()) {
            actualTokenProgram = TOKEN_2022_PROGRAM_ID;
          } else if (mintOwner === TOKEN_PROGRAM_ID.toBase58()) {
            actualTokenProgram = TOKEN_PROGRAM_ID;
          }
          
          // Log if there's a mismatch between cached and actual token program
          if (!actualTokenProgram.equals(atasToCreate[i].tokenProgram)) {
            logger.warn('routerTx.flashLoan.atas.tokenProgram_mismatch', {
              cat: 'tx',
              mint: mint.toBase58(),
              cached: atasToCreate[i].tokenProgram.toBase58(),
              actual: actualTokenProgram.toBase58(),
            });
          }
        }
        
        // Re-derive ATA with verified token program
        const verifiedAtaAddress = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, actualTokenProgram);
        
        instructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey, // payer
            verifiedAtaAddress, // ata (re-derived with correct token program)
            wallet.publicKey, // owner
            mint,             // mint
            actualTokenProgram // verified token program
          )
        );
        atasCreated++;
      }
    }
    
    if (atasCreated > 0) {
      logger.debug('routerTx.flashLoan.atas.created', {
        cat: 'tx',
        atasCreated,
        totalChecked: atasToCreate.length,
      });
    }

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

    // 2. Execute swaps (using execute instruction for multi-hop, now with validated accounts)
    const { steps, dexAccounts, accountsPerStep, initialBalances } = await buildRouteSteps(plan.hops, wallet.publicKey);
    
    // DIAGNOSTIC: Log the exact values being passed to buildExecuteIx
    logger.debug('routerTx.flashLoan.execute.params', {
      cat: 'tx',
      ctx: {
        user: wallet.publicKey.toBase58(),
        userTokenAccount: userTokenAccount.toBase58(),
        stepsCount: steps.length,
        dexAccountsCount: dexAccounts.length,
      },
    });
    
    const executeIx = buildExecuteIx(
      wallet.publicKey,
      userTokenAccount,
      { steps, accountsPerStep, minProfit, initialBalances, verbose },
      dexAccounts,
      programId
    );
    
    // DIAGNOSTIC: Verify the instruction keys are in correct order
    logger.debug('routerTx.flashLoan.execute.keys', {
      cat: 'tx',
      ctx: {
        keyCount: executeIx.keys.length,
        key0_user: executeIx.keys[0]?.pubkey?.toBase58?.() || 'unknown',
        key0_isSigner: executeIx.keys[0]?.isSigner,
        key1_userToken: executeIx.keys[1]?.pubkey?.toBase58?.() || 'unknown',
        key1_isSigner: executeIx.keys[1]?.isSigner,
      },
    });
    
    instructions.push(executeIx);

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

    logger.debug('routerTx.flashLoan.built', {
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
  minProfit: bigint,
  verbose: boolean
): Promise<RouterTxResult> {
  const instructions: TransactionInstruction[] = [];

  try {
    // Validate and populate missing accounts for each hop BEFORE building
    for (let i = 0; i < plan.hops.length; i++) {
      const hop = plan.hops[i];
      const dexType = dexNameToType(hop.dex, hop.variant);
      const validation = await validateAndPopulateHopAccounts(hop, dexType);
      
      if (!validation.valid) {
        logger.warn('routerTx.direct.validation.failed', {
          cat: 'tx',
          hopIndex: i,
          pool: hop.poolId,
          dex: hop.dex,
          missingAccounts: validation.missingAccounts,
        });
        
        return {
          usedRouter: false,
          instructions: [],
          usedFlashLoan: false,
          error: `Hop ${i} (${hop.dex}/${hop.poolId.slice(0, 8)}...): missing accounts: ${validation.missingAccounts.join(', ')}`,
        };
      }
      
      if (Object.keys(validation.derivedAccounts).length > 0) {
        logger.debug('routerTx.direct.accounts.derived', {
          cat: 'tx',
          hopIndex: i,
          pool: hop.poolId,
          derived: Object.keys(validation.derivedAccounts),
        });
      }
    }
    
    const inputMint = new PublicKey(plan.hops[0].inputMint);
    const outputMint = plan.hops[plan.hops.length - 1].outputMint;
    const inputTokenProgram = plan.hops[0].inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    let userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey, false, inputTokenProgram);
    
    // DIAGNOSTIC: Log wallet and userTokenAccount at initialization
    logger.debug('routerTx.direct.init', {
      cat: 'tx',
      ctx: {
        walletPublicKey: wallet.publicKey.toBase58(),
        inputMint: inputMint.toBase58(),
        userTokenAccount: userTokenAccount.toBase58(),
        inputTokenProgram: inputTokenProgram.toBase58(),
        // Verify they're different
        walletEqualsUserToken: wallet.publicKey.toBase58() === userTokenAccount.toBase58(),
        // Verify wallet doesn't look like a PDA (most PDAs are off-curve)
        walletIsOnCurve: PublicKey.isOnCurve(wallet.publicKey.toBytes()),
      },
    });
    
    // Track if we need to wrap/unwrap SOL
    const inputIsSol = isSolMint(plan.hops[0].inputMint);
    const outputIsSol = isSolMint(outputMint);
    
    // Wrap SOL → WSOL if input is native SOL
    if (inputIsSol) {
      const amountToWrap = Number(plan.hops[0].amountInRaw || 0n);
      if (amountToWrap > 0) {
        const wrapResult = buildWrapSolIxs(wallet.publicKey, wallet.publicKey, amountToWrap);
        instructions.push(...wrapResult.ixs);
        userTokenAccount = wrapResult.wsolAta;
        // Also update the hop's userSourceAta to point to WSOL ATA
        plan.hops[0].userSourceAta = wrapResult.wsolAta.toBase58();
        
        try {
          logger.debug('routerTx.direct.wrapSol', {
            cat: 'tx',
            ctx: { amount: amountToWrap, wsolAta: wrapResult.wsolAta.toBase58() },
          });
        } catch {}
      }
    }
    
    // If output is SOL, ensure last hop's destination is WSOL ATA
    if (outputIsSol) {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
      const lastHop = plan.hops[plan.hops.length - 1];
      lastHop.userDestAta = wsolAta.toBase58();
    }

    // ==========================================================================
    // CRITICAL: Create ATAs for all tokens before router instructions
    // The router expects token accounts to exist. Unlike local builders that
    // handle this inline, we must explicitly create them.
    // ==========================================================================
    const connection = getConnection();
    const atasToCreate: { mint: PublicKey; tokenProgram: PublicKey }[] = [];
    
    // Input token ATA (skip if SOL since we handle WSOL wrapping above)
    if (!inputIsSol) {
      atasToCreate.push({ mint: inputMint, tokenProgram: inputTokenProgram });
    }
    
    // Output token ATA
    const outputMintPubkey = new PublicKey(outputMint);
    const outputTokenProgram = plan.hops[plan.hops.length - 1].outputTokenProgram === 'token-2022' 
      ? TOKEN_2022_PROGRAM_ID 
      : TOKEN_PROGRAM_ID;
    if (!outputIsSol) {
      atasToCreate.push({ mint: outputMintPubkey, tokenProgram: outputTokenProgram });
    }
    
    // Intermediate token ATAs for multi-hop routes
    for (let i = 0; i < plan.hops.length - 1; i++) {
      const hop = plan.hops[i];
      
      if (isSolMint(hop.outputMint)) {
        // SOL intermediate: need WSOL ATA to receive output and pass to next hop
        // Previously this was skipped with "handled as WSOL" but that only applied
        // when inputIsSol was true (first hop input is SOL). For intermediate SOL,
        // we must explicitly create the WSOL ATA.
        atasToCreate.push({ mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID });
      } else {
        const intermediateMint = new PublicKey(hop.outputMint);
        const intermediateTokenProgram = hop.outputTokenProgram === 'token-2022' 
          ? TOKEN_2022_PROGRAM_ID 
          : TOKEN_PROGRAM_ID;
        atasToCreate.push({ mint: intermediateMint, tokenProgram: intermediateTokenProgram });
      }
    }
    
    // Check which ATAs need to be created (batch account info fetch)
    // CRITICAL: Also verify the actual token program from mint accounts to avoid
    // "Provided owner is not allowed" errors when cache has stale token program info
    const ataAddresses = atasToCreate.map(({ mint, tokenProgram }) => 
      getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram)
    );
    
    // Fetch both ATA infos and mint infos in parallel for verification
    const mintAddresses = atasToCreate.map(({ mint }) => mint);
    const [ataInfos, mintInfos] = await Promise.all([
      withRpcLimit(
        () => connection.getMultipleAccountsInfo(ataAddresses),
        Math.ceil(ataAddresses.length / 5),
        { module: 'routerTx', method: 'getMultipleAccountsInfo:directATAs' }
      ),
      withRpcLimit(
        () => connection.getMultipleAccountsInfo(mintAddresses),
        Math.ceil(mintAddresses.length / 5),
        { module: 'routerTx', method: 'getMultipleAccountsInfo:directMints' }
      ),
    ]);
    
    let atasCreated = 0;
    for (let i = 0; i < atasToCreate.length; i++) {
      if (!ataInfos[i]) {
        const { mint } = atasToCreate[i];
        
        // CRITICAL: Determine actual token program from mint account owner
        // This prevents "Provided owner is not allowed" errors when cached token program is wrong
        let actualTokenProgram = atasToCreate[i].tokenProgram;
        const mintInfo = mintInfos[i];
        if (mintInfo?.owner) {
          const mintOwner = mintInfo.owner.toBase58();
          if (mintOwner === TOKEN_2022_PROGRAM_ID.toBase58()) {
            actualTokenProgram = TOKEN_2022_PROGRAM_ID;
          } else if (mintOwner === TOKEN_PROGRAM_ID.toBase58()) {
            actualTokenProgram = TOKEN_PROGRAM_ID;
          }
          
          // Log if there's a mismatch between cached and actual token program
          if (!actualTokenProgram.equals(atasToCreate[i].tokenProgram)) {
            logger.warn('routerTx.direct.atas.tokenProgram_mismatch', {
              cat: 'tx',
              mint: mint.toBase58(),
              cached: atasToCreate[i].tokenProgram.toBase58(),
              actual: actualTokenProgram.toBase58(),
            });
          }
        }
        
        // Re-derive ATA with verified token program
        const verifiedAtaAddress = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, actualTokenProgram);
        
        instructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey, // payer
            verifiedAtaAddress, // ata (re-derived with correct token program)
            wallet.publicKey, // owner
            mint,             // mint
            actualTokenProgram // verified token program
          )
        );
        atasCreated++;
      }
    }
    
    if (atasCreated > 0) {
      logger.debug('routerTx.direct.atas.created', {
        cat: 'tx',
        atasCreated,
        totalChecked: atasToCreate.length,
      });
    }

    // Single-hop optimization: use route_swap so Meteora can include variable bin arrays.
    // (execute slices fixed account counts per step, which can under-provide bin arrays)
    if (plan.hops.length === 1) {
      const hop = plan.hops[0];
      const dexType = dexNameToType(hop.dex, hop.variant);
      const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
      // CRITICAL: Use NATIVE mint ordering for aToB flag
      // On-chain programs (Meteora, Raydium, Orca) use native ordering for direction
      // When native_mint_a is missing, use was_swapped to correct canonical fallback
      let poolMintA: string | undefined;
      if (stat?.native_mint_a) {
        poolMintA = stat.native_mint_a;
      } else {
        // Canonical fallback with wasSwapped correction
        // When was_swapped=true, canonical mint_a is actually native mint_b
        const wasSwapped = stat?.was_swapped === true;
        poolMintA = wasSwapped ? stat?.mint_b : stat?.mint_a;
      }
      const aToB = hop.inputMint === poolMintA;
      
      // Cap amountIn to actual balance to prevent "insufficient funds" errors
      const requestedAmount = BigInt(hop.amountInRaw.toString());
      let amountIn = requestedAmount;
      try {
        const singleHopBalances = await getBalances(wallet.publicKey);
        if (singleHopBalances) {
          const inputMint = hop.inputMint;
          const inputDecimals = hop.inputDecimals ?? 6;
          // Always use token account balance, not native SOL
          // For WSOL swaps, we need the WSOL ATA balance, not wallet lamports
          const uiBalance = singleHopBalances.tokens[inputMint] ?? 0;
          
          if (uiBalance > 0) {
            const actualBalance = BigInt(Math.floor(uiBalance * Math.pow(10, inputDecimals)));
            if (requestedAmount > actualBalance) {
              amountIn = actualBalance;
              logger.debug('routerTx.direct.singleHop.amountCapped', {
                cat: 'tx',
                ctx: {
                  inputMint: inputMint.slice(0, 8) + '...',
                  requestedAmount: requestedAmount.toString(),
                  actualBalance: actualBalance.toString(),
                  cappedAmount: amountIn.toString(),
                },
              });
            }
          }
        }
      } catch (e) {
        logger.warn('routerTx.direct.singleHop.getBalances.failed', {
          cat: 'tx',
          error: String((e as Error)?.message || e),
        });
      }
      
      const minAmountOut = BigInt(hop.minOutRaw.toString());
      // CRITICAL: Pass aToB to ensure account ordering matches the direction flag sent to on-chain program
      const dexAccounts = await extractDexAccounts(hop, dexType, wallet.publicKey, { allowVariableAccounts: true, aToB });
      try {
        // Calculate bin array count: swap variant starts at 15, swap2 at 16
        // We use 15 as base since swap is most common (standard SPL tokens)
        const meteoraBinArrayCount = dexType === DexType.Meteora 
          ? Math.max(0, dexAccounts.length - 15)  // swap: 15 fixed, swap2: 16 fixed
          : undefined;
        logger.debug('routerTx.direct.route_swap.prepared', {
          cat: 'tx',
          ctx: {
            dexType,
            pool: hop.poolId,
            dexAccounts: dexAccounts.length,
            meteoraBinArrays: meteoraBinArrayCount,
            aToB,
          }
        });
      } catch {}
      instructions.push(
        buildRouteSwapIx(
          wallet.publicKey,
          userTokenAccount,
          { dexType, amountIn, minAmountOut, aToB },
          dexAccounts,
          programId
        )
      );
    } else {
      // Multi-hop: execute supports dynamic amount propagation across steps
      const { steps, dexAccounts, accountsPerStep, initialBalances } = await buildRouteSteps(plan.hops, wallet.publicKey);
      
      // DIAGNOSTIC: Log the exact values being passed to buildExecuteIx
      // CRITICAL: Verify wallet.publicKey !== userTokenAccount (they must be different)
      const walletPubkey = wallet.publicKey.toBase58();
      const userTokenPubkey = userTokenAccount.toBase58();
      const areSwapped = walletPubkey === userTokenPubkey;
      
      logger.debug('routerTx.direct.execute.params', {
        cat: 'tx',
        ctx: {
          user: walletPubkey,
          userTokenAccount: userTokenPubkey,
          areSwapped, // CRITICAL: should always be false
          stepsCount: steps.length,
          dexAccountsCount: dexAccounts.length,
          programId: programId.toBase58(),
        },
      });
      
      if (areSwapped) {
        logger.error('routerTx.direct.execute.CRITICAL_BUG', {
          cat: 'tx',
          error: 'wallet.publicKey equals userTokenAccount! This is a bug.',
          user: walletPubkey,
          userTokenAccount: userTokenPubkey,
        });
      }
      
      const executeIx = buildExecuteIx(
        wallet.publicKey,
        userTokenAccount,
        { steps, accountsPerStep, minProfit, initialBalances, verbose },
        dexAccounts,
        programId
      );
      
      // DIAGNOSTIC: Verify the instruction keys are in correct order
      // Expected: key0 = wallet (signer, NOT writable), key1 = userTokenAccount (NOT signer, writable)
      const key0MatchesWallet = executeIx.keys[0]?.pubkey?.toBase58?.() === walletPubkey;
      const key1MatchesToken = executeIx.keys[1]?.pubkey?.toBase58?.() === userTokenPubkey;
      
      logger.debug('routerTx.direct.execute.keys', {
        cat: 'tx',
        ctx: {
          keyCount: executeIx.keys.length,
          key0_value: executeIx.keys[0]?.pubkey?.toBase58?.() || 'unknown',
          key0_isSigner: executeIx.keys[0]?.isSigner,
          key0_isWritable: executeIx.keys[0]?.isWritable,
          key0_matchesWallet: key0MatchesWallet, // Should be true
          key1_value: executeIx.keys[1]?.pubkey?.toBase58?.() || 'unknown',
          key1_isSigner: executeIx.keys[1]?.isSigner,
          key1_isWritable: executeIx.keys[1]?.isWritable,
          key1_matchesToken: key1MatchesToken, // Should be true
          expectedKey0IsSigner: true,
          expectedKey0IsWritable: false,
          expectedKey1IsSigner: false,
          expectedKey1IsWritable: true,
        },
      });
      
      if (!key0MatchesWallet || !key1MatchesToken) {
        logger.error('routerTx.direct.execute.KEYS_MISMATCH', {
          cat: 'tx',
          error: 'Instruction keys do not match expected values!',
          key0: executeIx.keys[0]?.pubkey?.toBase58?.(),
          expectedKey0: walletPubkey,
          key1: executeIx.keys[1]?.pubkey?.toBase58?.(),
          expectedKey1: userTokenPubkey,
        });
      }
      
      instructions.push(executeIx);
    }
    
    // Unwrap WSOL → SOL if output is native SOL
    if (outputIsSol) {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
      // Close the WSOL ATA to unwrap remaining balance back to native SOL
      const closeIx = createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey);
      instructions.push(closeIx);
      
      try {
        logger.debug('routerTx.direct.unwrapSol', {
          cat: 'tx',
          ctx: { wsolAta: wsolAta.toBase58() },
        });
      } catch {}
    }

    logger.debug('routerTx.direct.built', {
      cat: 'tx',
      code: LogCode.TX_BUILD_OK,
      ctx: {
        hops: plan.hops.length,
        steps: plan.hops.length,
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
 * Build router transaction using SDK quote methods for accurate tick/bin arrays.
 *
 * This mode calls DEX SDKs (Orca, Raydium, Meteora) to get validated accounts
 * rather than relying on cached values. This is slower but more accurate.
 *
 * No fallback to cache - fails fast if SDK quote fails.
 */
async function buildSdkQuoteRouterTx(
  plan: ExecutionPlan,
  wallet: { publicKey: PublicKey },
  programId: PublicKey,
  minProfit: bigint,
  verbose: boolean
): Promise<RouterTxResult> {
  const instructions: TransactionInstruction[] = [];

  try {
    logger.debug('routerTx.sdkQuote.start', {
      cat: 'tx',
      ctx: {
        hops: plan.hops.length,
        poolIds: plan.hops.map(h => h.poolId.slice(0, 8) + '...'),
      },
    });

    // Get SDK-provided accounts for all hops (fail fast if any SDK call fails)
    const sdkResult = await getSdkQuoteAccountsForPlan(plan.hops);

    if (!sdkResult.success) {
      logger.error('routerTx.sdkQuote.failed', {
        cat: 'tx',
        error: sdkResult.error,
      });
      return {
        usedRouter: false,
        instructions: [],
        usedFlashLoan: false,
        error: `SDK quote failed: ${sdkResult.error}`,
      };
    }

    // Enrich hops with SDK-provided accounts
    for (let i = 0; i < plan.hops.length; i++) {
      const hop = plan.hops[i];
      const sdkAccounts = sdkResult.results[i].accounts;

      // Apply SDK accounts to hop (these override cache values)
      applysdkAccountsToHop(hop, sdkAccounts);

      logger.debug('routerTx.sdkQuote.hop.enriched', {
        cat: 'tx',
        ctx: {
          hopIndex: i,
          dex: hop.dex,
          poolId: hop.poolId.slice(0, 8) + '...',
          sdkAccountsApplied: Object.keys(sdkAccounts).filter(k => (sdkAccounts as any)[k] !== undefined),
        },
      });
    }

    // Now build the transaction using the SDK-enriched hops
    // Reuse the direct router tx logic with enriched hop data

    // Handle SOL wrapping if input is SOL
    const inputIsSol = isSolMint(plan.hops[0].inputMint);
    const outputIsSol = isSolMint(plan.hops[plan.hops.length - 1].outputMint);

    if (inputIsSol) {
      const wrapAmount = Number(plan.hops[0].amountInRaw);
      const { ixs: wrapIxs, wsolAta } = buildWrapSolIxs(wallet.publicKey, wallet.publicKey, wrapAmount);
      instructions.push(...wrapIxs);
      plan.hops[0].userSourceAta = wsolAta.toBase58();
    }

    // Determine user token account for execute instruction
    const inputTokenProgram = plan.hops[0].inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const inputMint = new PublicKey(plan.hops[0].inputMint);
    const userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey, false, inputTokenProgram);

    // Create ATAs for tokens (matching buildDirectRouterTx logic)
    const connection = getConnection();
    const atasToCreate: { mint: PublicKey; tokenProgram: PublicKey }[] = [];

    // Input token ATA - skip if SOL (buildWrapSolIxs already creates WSOL ATA)
    if (!inputIsSol) {
      atasToCreate.push({ mint: inputMint, tokenProgram: inputTokenProgram });
    }

    // Output token ATA - add for non-SOL outputs (was missing!)
    const outputMint = new PublicKey(plan.hops[plan.hops.length - 1].outputMint);
    const outputTokenProgram = plan.hops[plan.hops.length - 1].outputTokenProgram === 'token-2022'
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    if (!outputIsSol) {
      atasToCreate.push({ mint: outputMint, tokenProgram: outputTokenProgram });
    }

    // Intermediate token ATAs for multi-hop routes
    for (let i = 0; i < plan.hops.length - 1; i++) {
      const hop = plan.hops[i];
      
      // Skip if same as input/output (shouldn't happen in well-formed plan)
      if (hop.outputMint === plan.hops[0].inputMint) {
        continue;
      }
      
      if (isSolMint(hop.outputMint)) {
        // SOL intermediate: need WSOL ATA to receive output and pass to next hop
        atasToCreate.push({ mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID });
      } else {
        const intermediateMint = new PublicKey(hop.outputMint);
        const intermediateTokenProgram = hop.outputTokenProgram === 'token-2022'
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
        atasToCreate.push({ mint: intermediateMint, tokenProgram: intermediateTokenProgram });
      }
    }

    // Check which ATAs need to be created
    const ataAddresses = atasToCreate.map(({ mint, tokenProgram }) =>
      getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram)
    );
    const ataInfos = await withRpcLimit(
      () => connection.getMultipleAccountsInfo(ataAddresses),
      Math.ceil(ataAddresses.length / 5),
      { module: 'routerTx', method: 'getMultipleAccountsInfo:sdkQuoteATAs' }
    );

    let atasCreated = 0;
    for (let i = 0; i < atasToCreate.length; i++) {
      if (!ataInfos[i]) {
        const { mint, tokenProgram } = atasToCreate[i];
        const ataAddress = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram);
        instructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            ataAddress,
            wallet.publicKey,
            mint,
            tokenProgram
          )
        );
        atasCreated++;
      }
    }

    if (atasCreated > 0) {
      logger.debug('routerTx.sdkQuote.atas.created', {
        cat: 'tx',
        atasCreated,
        totalChecked: atasToCreate.length,
      });
    }

    // Build route steps with SDK-enriched accounts
    const { steps, dexAccounts, accountsPerStep, initialBalances } = await buildRouteStepsWithSdkAccounts(
      plan.hops,
      wallet.publicKey,
      sdkResult.results.map(r => r.accounts)
    );

    // Build execute instruction
    const executeIx = buildExecuteIx(
      wallet.publicKey,
      userTokenAccount,
      { steps, accountsPerStep, minProfit, initialBalances, verbose },
      dexAccounts,
      programId
    );
    instructions.push(executeIx);

    // Unwrap WSOL if output is SOL
    if (outputIsSol) {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
      const closeIx = createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey);
      instructions.push(closeIx);
    }

    logger.debug('routerTx.sdkQuote.built', {
      cat: 'tx',
      code: LogCode.TX_BUILD_OK,
      ctx: {
        hops: plan.hops.length,
        steps: plan.hops.length,
        instructionCount: instructions.length,
      },
    });

    return {
      usedRouter: true,
      instructions,
      usedFlashLoan: false,
    };
  } catch (err: any) {
    logCatchError('routerTx.sdkQuote.build', err);
    return {
      usedRouter: false,
      instructions: [],
      usedFlashLoan: false,
      error: err.message,
    };
  }
}

/**
 * Apply SDK-provided accounts to a hop, overriding any cached values
 */
function applysdkAccountsToHop(hop: DirectHop, sdkAccounts: SdkProvidedAccounts): void {
  // Orca accounts
  if (sdkAccounts.tickArray0) {
    (hop as any).tickArray0 = sdkAccounts.tickArray0;
  }
  if (sdkAccounts.tickArray1) {
    (hop as any).tickArray1 = sdkAccounts.tickArray1;
  }
  if (sdkAccounts.tickArray2) {
    (hop as any).tickArray2 = sdkAccounts.tickArray2;
  }
  if (sdkAccounts.oracle) {
    (hop as any).oracle = sdkAccounts.oracle;
  }

  // Raydium CLMM accounts
  if (sdkAccounts.tickArrayLower) {
    hop.tickArrayLower = sdkAccounts.tickArrayLower;
  }
  if (sdkAccounts.tickArrayCenter) {
    hop.tickArrayCenter = sdkAccounts.tickArrayCenter;
  }
  if (sdkAccounts.tickArrayUpper) {
    hop.tickArrayUpper = sdkAccounts.tickArrayUpper;
  }
  if (sdkAccounts.observationState) {
    hop.observationId = sdkAccounts.observationState;
  }
  if (sdkAccounts.exBitmap) {
    (hop as any).exBitmap = sdkAccounts.exBitmap;
  }
  if (sdkAccounts.ammConfig) {
    hop.ammConfig = sdkAccounts.ammConfig;
  }

  // Raydium AMM v4 accounts (Serum/OpenBook market)
  if (sdkAccounts.ammAuthority) {
    (hop as any).ammAuthority = sdkAccounts.ammAuthority;
  }
  if (sdkAccounts.openOrders) {
    (hop as any).openOrders = sdkAccounts.openOrders;
  }
  if (sdkAccounts.targetOrders) {
    (hop as any).targetOrders = sdkAccounts.targetOrders;
  }
  if (sdkAccounts.marketId) {
    (hop as any).market = sdkAccounts.marketId;
  }
  if (sdkAccounts.marketProgramId) {
    (hop as any).serumProgramId = sdkAccounts.marketProgramId;
  }
  if (sdkAccounts.serumBids) {
    (hop as any).serumBids = sdkAccounts.serumBids;
  }
  if (sdkAccounts.serumAsks) {
    (hop as any).serumAsks = sdkAccounts.serumAsks;
  }
  if (sdkAccounts.serumEventQueue) {
    (hop as any).serumEventQueue = sdkAccounts.serumEventQueue;
  }
  if (sdkAccounts.serumCoinVault) {
    (hop as any).serumCoinVault = sdkAccounts.serumCoinVault;
  }
  if (sdkAccounts.serumPcVault) {
    (hop as any).serumPcVault = sdkAccounts.serumPcVault;
  }
  if (sdkAccounts.serumVaultSigner) {
    (hop as any).serumVaultSigner = sdkAccounts.serumVaultSigner;
  }

  // Meteora DLMM accounts
  if (sdkAccounts.binArrays && sdkAccounts.binArrays.length > 0) {
    (hop as any).binArrays = sdkAccounts.binArrays;
    hop.binArrayLower = sdkAccounts.binArrayLower || sdkAccounts.binArrays[0];
    hop.binArrayUpper = sdkAccounts.binArrayUpper || sdkAccounts.binArrays[sdkAccounts.binArrays.length - 1];
  }
  if (sdkAccounts.activeId !== undefined) {
    hop.activeId = sdkAccounts.activeId;
  }
  // Bitmap extension for pools with activeId outside default range
  if (sdkAccounts.bitmapExtension) {
    hop.bitmapExtension = sdkAccounts.bitmapExtension;
  }

  // Meteora DAMM accounts (v1/v2)
  if (sdkAccounts.poolAuthority) {
    (hop as any).poolAuthority = sdkAccounts.poolAuthority;
  }
  if (sdkAccounts.lpMint) {
    (hop as any).lpMint = sdkAccounts.lpMint;
  }
  // Meteora DAMM v1 - Mercurial Vault accounts
  if (sdkAccounts.aVault) {
    (hop as any).aVault = sdkAccounts.aVault;
  }
  if (sdkAccounts.bVault) {
    (hop as any).bVault = sdkAccounts.bVault;
  }
  if (sdkAccounts.aTokenVault) {
    (hop as any).aTokenVault = sdkAccounts.aTokenVault;
  }
  if (sdkAccounts.bTokenVault) {
    (hop as any).bTokenVault = sdkAccounts.bTokenVault;
  }
  if (sdkAccounts.aVaultLpMint) {
    (hop as any).aVaultLpMint = sdkAccounts.aVaultLpMint;
  }
  if (sdkAccounts.bVaultLpMint) {
    (hop as any).bVaultLpMint = sdkAccounts.bVaultLpMint;
  }
  if (sdkAccounts.aVaultLp) {
    (hop as any).aVaultLp = sdkAccounts.aVaultLp;
  }
  if (sdkAccounts.bVaultLp) {
    (hop as any).bVaultLp = sdkAccounts.bVaultLp;
  }
  if (sdkAccounts.protocolTokenAFee) {
    (hop as any).protocolTokenAFee = sdkAccounts.protocolTokenAFee;
  }
  if (sdkAccounts.protocolTokenBFee) {
    (hop as any).protocolTokenBFee = sdkAccounts.protocolTokenBFee;
  }
  if (sdkAccounts.vaultProgram) {
    (hop as any).vaultProgram = sdkAccounts.vaultProgram;
  }
  // Meteora DAMM v1 depeg/remaining accounts
  if (sdkAccounts.depegType) {
    (hop as any).depegType = sdkAccounts.depegType;
  }
  if (sdkAccounts.stakePool) {
    (hop as any).stakePool = sdkAccounts.stakePool;
  }
  if (sdkAccounts.remainingAccounts && sdkAccounts.remainingAccounts.length > 0) {
    (hop as any).remainingAccounts = sdkAccounts.remainingAccounts;
  }

  // PumpSwap accounts
  if (sdkAccounts.globalConfig) {
    (hop as any).globalConfig = sdkAccounts.globalConfig;
  }
  if (sdkAccounts.protocolFeeRecipient) {
    (hop as any).protocolFeeRecipient = sdkAccounts.protocolFeeRecipient;
  }
  if (sdkAccounts.bondingCurve) {
    (hop as any).bondingCurve = sdkAccounts.bondingCurve;
  }
  if (sdkAccounts.associatedBondingCurve) {
    (hop as any).associatedBondingCurve = sdkAccounts.associatedBondingCurve;
  }

  // Common vault accounts
  if (sdkAccounts.vaultA) {
    hop.vaultA = sdkAccounts.vaultA;
  }
  if (sdkAccounts.vaultB) {
    hop.vaultB = sdkAccounts.vaultB;
  }
}

/**
 * Build route steps using SDK-provided accounts
 * Similar to buildRouteSteps but uses SDK accounts for tick/bin arrays
 */
async function buildRouteStepsWithSdkAccounts(
  hops: DirectHop[],
  wallet: PublicKey,
  sdkAccountsList: SdkProvidedAccounts[]
): Promise<{
  steps: RouteStep[];
  dexAccounts: PublicKey[];
  accountsPerStep: number[];
  initialBalances: bigint[];
}> {
  const steps: RouteStep[] = [];
  const dexAccounts: PublicKey[] = [];
  const accountsPerStep: number[] = [];
  const initialBalances: bigint[] = [];

  // Fetch cached wallet balances
  let walletBalances: { sol: number; tokens: Record<string, number> } | null = null;
  try {
    walletBalances = await getBalances(wallet);
  } catch (e) {
    logger.warn('routerTx.buildRouteStepsWithSdk.getBalances.failed', {
      cat: 'tx',
      error: String((e as Error)?.message || e),
    });
  }

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const sdkAccounts = sdkAccountsList[i];
    const dexType = dexNameToType(hop.dex, hop.variant);

    // First hop: use specified amount, but cap to actual balance to avoid "insufficient funds"
    // Subsequent hops: use 0 for dynamic propagation
    let amountIn = 0n;
    if (i === 0) {
      const requestedAmount = BigInt(hop.amountInRaw.toString());
      
      // Get actual balance and cap to it (prevents rounding/timing issues)
      if (walletBalances) {
        const inputMint = hop.inputMint;
        const inputDecimals = hop.inputDecimals ?? 6;
        // Always use token account balance, not native SOL
        // For WSOL swaps, we need the WSOL ATA balance, not wallet lamports
        const uiBalance = walletBalances.tokens[inputMint] ?? 0;
        
        if (uiBalance > 0) {
          const actualBalance = BigInt(Math.floor(uiBalance * Math.pow(10, inputDecimals)));
          // Cap to actual balance to prevent "insufficient funds" errors
          amountIn = requestedAmount > actualBalance ? actualBalance : requestedAmount;
          
          if (amountIn < requestedAmount) {
            logger.debug('routerTx.buildRouteStepsWithSdk.amountCapped', {
              cat: 'tx',
              ctx: {
                hopIndex: i,
                inputMint: inputMint.slice(0, 8) + '...',
                requestedAmount: requestedAmount.toString(),
                actualBalance: actualBalance.toString(),
                cappedAmount: amountIn.toString(),
              },
            });
          }
        } else {
          amountIn = requestedAmount;
        }
      } else {
        amountIn = requestedAmount;
      }
    }

    // Compute swap direction from pool's native mint ordering
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    
    // CRITICAL: Use NATIVE mint ordering for aToB flag
    // When native_mint_a is missing, use was_swapped to correct canonical fallback
    let poolMintA: string | undefined;
    if (stat?.native_mint_a) {
      poolMintA = stat.native_mint_a;
    } else {
      // Canonical fallback with wasSwapped correction
      // When was_swapped=true, canonical mint_a is actually native mint_b
      const wasSwapped = stat?.was_swapped === true;
      poolMintA = wasSwapped ? stat?.mint_b : stat?.mint_a;
    }
    
    // CRITICAL: PumpSwap has specific direction semantics:
    // aToB = true → Buy (SOL → Token), aToB = false → Sell (Token → SOL)
    // This differs from generic mint A/B ordering used by other DEXes
    const aToB = dexType === DexType.PumpSwap
      ? hop.inputMint === SOL_MINT  // PumpSwap: true = buying with SOL
      : hop.inputMint === poolMintA; // Other DEXes: use pool mint ordering

    steps.push({
      dexType,
      amountIn,
      minAmountOut: BigInt(hop.minOutRaw.toString()),
      aToB,
    });

    // Compute initial balance for dynamic amount propagation
    let initialBalance = 0n;
    if (i > 0 && walletBalances) {
      const inputMint = hop.inputMint;
      const inputDecimals = hop.inputDecimals ?? 6;
      // Always use token account balance, not native SOL
      // For WSOL swaps, we need the WSOL ATA balance, not wallet lamports
      const uiBalance = walletBalances.tokens[inputMint] ?? 0;

      if (uiBalance > 0) {
        initialBalance = BigInt(Math.floor(uiBalance * Math.pow(10, inputDecimals)));
      }
    }
    initialBalances.push(initialBalance);

    // Extract DEX accounts using SDK-provided values
    // CRITICAL: Pass aToB to ensure account ordering matches the direction flag sent to on-chain program
    const hopAccounts = await extractDexAccountsWithSdk(hop, dexType, wallet, sdkAccounts, aToB);
    dexAccounts.push(...hopAccounts);
    accountsPerStep.push(hopAccounts.length);

    logger.debug('routerTx.buildRouteStepsWithSdk.step', {
      cat: 'tx',
      ctx: {
        hopIndex: i,
        dex: hop.dex,
        amountIn: amountIn.toString(),
        accountCount: hopAccounts.length,
        aToB,
        usedSdkAccounts: Object.keys(sdkAccounts).filter(k => (sdkAccounts as any)[k] !== undefined).length,
      },
    });
  }

  return { steps, dexAccounts, accountsPerStep, initialBalances };
}

/**
 * Extract DEX accounts, preferring SDK-provided values over cache
 * This is a wrapper around extractDexAccounts that applies SDK overrides first
 */
async function extractDexAccountsWithSdk(
  hop: DirectHop,
  dexType: DexType,
  wallet: PublicKey,
  sdkAccounts: SdkProvidedAccounts,
  aToB: boolean
): Promise<PublicKey[]> {
  // Apply SDK accounts to hop before extraction
  applysdkAccountsToHop(hop, sdkAccounts);

  // Use the standard extractDexAccounts which will now use the SDK-provided values
  // CRITICAL: Pass aToB to ensure account ordering matches the direction flag sent to on-chain program
  return extractDexAccounts(hop, dexType, wallet, { aToB });
}

/**
 * Build route steps from execution plan hops
 *
 * For dynamic amount propagation:
 * - First hop uses the specified amountInRaw
 * - Subsequent hops use amountIn=0, which tells the on-chain router to
 *   read the actual balance from the input token account (output of previous swap)
 * 
 * Returns accountsPerStep to enable variable account counts per hop.
 * This is essential for Meteora pools that may need more bin arrays.
 * 
 * Also returns initialBalances - pre-existing wallet balances for intermediate tokens.
 * These are subtracted on-chain to avoid accidentally swapping at-rest funds.
 */
async function buildRouteSteps(hops: DirectHop[], wallet: PublicKey): Promise<{
  steps: RouteStep[];
  dexAccounts: PublicKey[];
  accountsPerStep: number[];
  initialBalances: bigint[];
}> {
  const steps: RouteStep[] = [];
  const dexAccounts: PublicKey[] = [];
  const accountsPerStep: number[] = [];
  const initialBalances: bigint[] = [];

  // Fetch cached wallet balances (no RPC call if cache is fresh)
  // This is used to subtract pre-existing balances from dynamic amount propagation
  let walletBalances: { sol: number; tokens: Record<string, number> } | null = null;
  try {
    walletBalances = await getBalances(wallet);
  } catch (e) {
    logger.warn('routerTx.buildRouteSteps.getBalances.failed', {
      cat: 'tx',
      error: String((e as Error)?.message || e),
    });
  }

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const dexType = dexNameToType(hop.dex, hop.variant);

    // First hop: use specified amount, but cap to actual balance to avoid "insufficient funds"
    // Subsequent hops: use 0 to trigger dynamic amount propagation
    // The on-chain router will read the actual token account balance
    let amountIn = 0n;
    if (i === 0) {
      const requestedAmount = BigInt(hop.amountInRaw.toString());
      
      // Get actual balance and cap to it (prevents rounding/timing issues)
      if (walletBalances) {
        const inputMint = hop.inputMint;
        const inputDecimals = hop.inputDecimals ?? 6;
        // Always use token account balance, not native SOL
        // For WSOL swaps, we need the WSOL ATA balance, not wallet lamports
        const uiBalance = walletBalances.tokens[inputMint] ?? 0;
        
        if (uiBalance > 0) {
          const actualBalance = BigInt(Math.floor(uiBalance * Math.pow(10, inputDecimals)));
          // Cap to actual balance to prevent "insufficient funds" errors
          amountIn = requestedAmount > actualBalance ? actualBalance : requestedAmount;
          
          if (amountIn < requestedAmount) {
            logger.debug('routerTx.buildStep.amountCapped', {
              cat: 'tx',
              ctx: {
                hopIndex: i,
                inputMint: inputMint.slice(0, 8) + '...',
                requestedAmount: requestedAmount.toString(),
                actualBalance: actualBalance.toString(),
                cappedAmount: amountIn.toString(),
              },
            });
          }
        } else {
          amountIn = requestedAmount;
        }
      } else {
        amountIn = requestedAmount;
      }
    }

    // Compute swap direction from pool's native mint ordering
    // aToB = true means swapping mint A -> mint B
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    
    // CRITICAL: Use NATIVE mint ordering for aToB flag
    // When native_mint_a is missing, use was_swapped to correct canonical fallback
    let poolMintA: string | undefined;
    if (stat?.native_mint_a) {
      poolMintA = stat.native_mint_a;
    } else {
      // Canonical fallback with wasSwapped correction
      // When was_swapped=true, canonical mint_a is actually native mint_b
      const wasSwapped = stat?.was_swapped === true;
      poolMintA = wasSwapped ? stat?.mint_b : stat?.mint_a;
    }
    
    // CRITICAL: PumpSwap has specific direction semantics:
    // aToB = true → Buy (SOL → Token), aToB = false → Sell (Token → SOL)
    // This differs from generic mint A/B ordering used by other DEXes
    const aToB = dexType === DexType.PumpSwap
      ? hop.inputMint === SOL_MINT  // PumpSwap: true = buying with SOL
      : hop.inputMint === poolMintA; // Other DEXes: use pool mint ordering

    steps.push({
      dexType,
      amountIn,
      minAmountOut: BigInt(hop.minOutRaw.toString()),
      aToB,
    });

    // Compute initial balance for this hop's input token
    // For hop 0, we use explicit amountIn so initial_balance doesn't matter (set to 0)
    // For hop 1+, we need the pre-existing wallet balance of the input token
    // to subtract from the on-chain balance reading
    let initialBalance = 0n;
    if (i > 0 && walletBalances) {
      const inputMint = hop.inputMint;
      const inputDecimals = hop.inputDecimals ?? 6;
      
      // Get UI balance and convert to raw amount
      // Always use token account balance, not native SOL
      // For WSOL swaps, we need the WSOL ATA balance, not wallet lamports
      const uiBalance = walletBalances.tokens[inputMint] ?? 0;
      
      if (uiBalance > 0) {
        initialBalance = BigInt(Math.floor(uiBalance * Math.pow(10, inputDecimals)));
        logger.debug('routerTx.buildStep.initialBalance', {
          cat: 'tx',
          ctx: {
            hopIndex: i,
            inputMint: inputMint.slice(0, 8) + '...',
            uiBalance,
            initialBalance: initialBalance.toString(),
            decimals: inputDecimals,
          },
        });
      }
    }
    initialBalances.push(initialBalance);

    // Collect DEX accounts for this hop - pass wallet and aToB for consistent direction
    // CRITICAL: Pass aToB to ensure account ordering matches the direction flag sent to on-chain program
    const hopAccounts = await extractDexAccounts(hop, dexType, wallet, { aToB });
    dexAccounts.push(...hopAccounts);
    
    // Track actual account count for this hop (enables variable bin arrays for Meteora)
    accountsPerStep.push(hopAccounts.length);

    logger.debug('routerTx.buildStep', {
      cat: 'tx',
      ctx: {
        hopIndex: i,
        dex: hop.dex,
        amountIn: amountIn.toString(),
        minAmountOut: hop.minOutRaw.toString(),
        isDynamic: i > 0,
        accountCount: hopAccounts.length,
        aToB,
        initialBalance: initialBalance.toString(),
      },
    });
  }

  return { steps, dexAccounts, accountsPerStep, initialBalances };
}

/**
 * Extract DEX-specific accounts from a hop in the exact order expected by the router
 */
async function extractDexAccounts(
  hop: DirectHop,
  dexType: DexType,
  wallet: PublicKey,
  opts?: { allowVariableAccounts?: boolean; aToB?: boolean }
): Promise<PublicKey[]> {
  const accounts: PublicKey[] = [];

  try {
    const poolId = new PublicKey(hop.poolId.replace(/[#-]rev$/, ''));
    const programIdKey = new PublicKey(hop.programId);
    const inputMint = new PublicKey(hop.inputMint);
    const outputMint = new PublicKey(hop.outputMint);
    
    // Derive ATAs if not set (resolver doesn't have wallet access)
    const inputTokenProgram = hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const outputTokenProgram = hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    
    const userSourceAta = hop.userSourceAta 
      ? new PublicKey(hop.userSourceAta)
      : getAssociatedTokenAddressSync(inputMint, wallet, true, inputTokenProgram);
    const userDestAta = hop.userDestAta
      ? new PublicKey(hop.userDestAta)
      : getAssociatedTokenAddressSync(outputMint, wallet, true, outputTokenProgram);

    // Get pool's mint and account ordering from cache
    // CRITICAL: Use NATIVE ordering for direction (isAtoB) because on-chain programs use native order
    // Native = original on-chain order (token_mint_0/token_mint_1)
    // Canonical = alphabetically sorted (mint_a/mint_b) - may be swapped from native
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    const poolMintA = stat?.mint_a;  // Canonical mint A
    const poolMintB = stat?.mint_b;  // Canonical mint B
    const poolAccountA = stat?.account_a;  // Canonical account A (paired with mint_a)
    const poolAccountB = stat?.account_b;  // Canonical account B (paired with mint_b)
    
    // NATIVE ordering - critical for on-chain direction flag
    let nativeMintA = stat?.native_mint_a;  // On-chain token_mint_0
    let nativeMintB = stat?.native_mint_b;  // On-chain token_mint_1
    const nativeAccountA = stat?.native_account_a;  // On-chain vault for token_mint_0
    const nativeAccountB = stat?.native_account_b;  // On-chain vault for token_mint_1
    
    // FALLBACK: If native_mint_a is missing but we have rawAccountData, derive it
    // This handles the case where pools were loaded from persistence or lazy mode without native_mint_a
    if (!nativeMintA && stat?.rawAccountData && hop.dex?.toLowerCase() === 'orca') {
      try {
        const rawData = stat.rawAccountData;
        // Orca Whirlpool account layout: tokenMintA is at offset 101 (32 bytes)
        // tokenMintB is at offset 133 (32 bytes)
        if (rawData.length >= 165) {
          const mintABytes = rawData.slice(101, 133);
          const mintBBytes = rawData.slice(133, 165);
          nativeMintA = new PublicKey(mintABytes).toBase58();
          nativeMintB = new PublicKey(mintBBytes).toBase58();
          
          // Update the execution cache with derived native mints for future use
          executionCache.setStatic(hop.poolId.replace(/[#-]rev$/, ''), {
            ...stat,
            native_mint_a: nativeMintA,
            native_mint_b: nativeMintB,
          });
          
          logger.info('routerTx.orca.native_mint.derived_from_raw', {
            cat: 'tx',
            poolId: hop.poolId?.slice(0, 8) + '...',
            nativeMintA: nativeMintA?.slice(0, 8) + '...',
            nativeMintB: nativeMintB?.slice(0, 8) + '...',
          });
        }
      } catch (e) {
        logger.warn('routerTx.orca.native_mint.derivation_failed', {
          cat: 'tx',
          poolId: hop.poolId?.slice(0, 8) + '...',
          error: String((e as Error)?.message || e),
        });
      }
    }
    
    // Direction flag uses NATIVE ordering (matches on-chain a_to_b interpretation)
    // CRITICAL: Use passed aToB if available to ensure consistency with on-chain instruction
    // This prevents mismatch between direction flag and account ordering if cache changes
    let isAtoB: boolean;
    let isAtoBDeterminedBy = 'unknown';

    if (opts?.aToB !== undefined) {
      isAtoB = opts.aToB;
      isAtoBDeterminedBy = 'opts.aToB';
    } else if (nativeMintA) {
      isAtoB = hop.inputMint === nativeMintA;
      isAtoBDeterminedBy = 'native_mint_a';
    } else {
      // FALLBACK: Use canonical ordering - but this may be WRONG if pool was_swapped
      // When was_swapped=true, canonical mint_a != native mint_a, so direction would be inverted
      const wasSwapped = (stat as any)?.was_swapped === true;
      const canonicalIsAtoB = hop.inputMint === poolMintA;

      // If pool was swapped during canonicalization, invert the direction
      // Because canonical mint_a = native mint_b when was_swapped=true
      isAtoB = wasSwapped ? !canonicalIsAtoB : canonicalIsAtoB;
      isAtoBDeterminedBy = wasSwapped ? 'canonical_inverted_for_swap' : 'canonical_fallback';

      // Log ERROR for Orca pools using canonical fallback (high risk of InvalidTickArraySequence)
      if (hop.dex?.toLowerCase() === 'orca') {
        logger.error('routerTx.orca.direction.canonical_fallback', {
          cat: 'tx',
          poolId: hop.poolId?.slice(0, 8) + '...',
          inputMint: hop.inputMint?.slice(0, 8) + '...',
          outputMint: hop.outputMint?.slice(0, 8) + '...',
          canonicalMintA: poolMintA?.slice(0, 8) + '...',
          canonicalMintB: poolMintB?.slice(0, 8) + '...',
          wasSwapped,
          canonicalIsAtoB,
          finalIsAtoB: isAtoB,
          hasRawAccountData: !!stat?.rawAccountData,
          rawAccountDataLen: stat?.rawAccountData?.length,
          statKeys: stat ? Object.keys(stat).join(',') : 'null',
          hint: 'CRITICAL: native_mint_a missing - direction may be WRONG causing InvalidTickArraySequence. ' +
                'Check if pool was loaded from persistence without native_mint_a or WS update pending.',
        });
        
        // STRICT MODE: Fail early rather than submit a likely-to-fail transaction
        // This prevents wasting compute and transaction fees on InvalidTickArraySequence errors
        // The canonical fallback is unreliable when was_swapped might be incorrect or missing
        throw new Error(
          `ORCA_DIRECTION_UNRELIABLE: Pool ${hop.poolId?.slice(0, 12)}... is missing native_mint_a. ` +
          `Cannot reliably determine swap direction. Pool needs WS update or revalidation. ` +
          `(wasSwapped=${wasSwapped}, hasRawData=${!!stat?.rawAccountData})`
        );
      }
    }

    // Get hot cache for additional pool state (tick arrays, exBitmap, etc.)
    const hot = executionCache.getHot(hop.poolId.replace(/[#-]rev$/, ''));
    
    switch (dexType) {
      case DexType.Raydium:
        // Raydium CLMM: Two instruction variants based on token type
        //
        // swap (standard SPL tokens - 12-13 accounts):
        //   0: Payer, 1: AmmConfig, 2: Pool, 3: UserInput, 4: UserOutput,
        //   5: InputVault, 6: OutputVault, 7: Observation, 8: TokenProgram,
        //   [9: exBitmap], 9-11/10-12: TickArrays, last: Program
        //
        // swap_v2 (Token-2022 compatible - 17-18 accounts):
        //   0: Payer, 1: AmmConfig, 2: Pool, 3: UserInput, 4: UserOutput,
        //   5: InputVault, 6: OutputVault, 7: Observation, 8: TokenProgram, 9: Token2022Program,
        //   10: MemoProgram, 11: InputMint, 12: OutputMint,
        //   [13: exBitmap], 13-15/14-16: TickArrays, last: Program
        //
        // On-chain router auto-detects based on account count (>=17 = swap_v2)
        
        // Check if exBitmap (tick array bitmap extension) exists in cache
        // This must be checked BEFORE deciding which instruction to use
        const exBitmapFromCacheEarly = (hot as any)?.exBitmap || (hop as any).exBitmap || stat?.ex_bitmap;
        const hasExBitmapEarly = !!exBitmapFromCacheEarly && exBitmapFromCacheEarly !== 'none';
        
        // Detect which instruction variant to use:
        // - swap_v2: Token-2022 tokens (required for Token-2022 support, 17-18 accounts)
        // - swap: Standard SPL tokens (optimized, 11-12 accounts)
        //   - With exBitmap: 12 accounts
        //   - Without exBitmap: 11 accounts
        const hasToken2022 = hop.inputTokenProgram === 'token-2022' || hop.outputTokenProgram === 'token-2022';

        // ALWAYS use swap_v2 for Raydium CLMM swaps
        // swap_v2 provides 3 tick arrays instead of 1, making it robust against tick drift
        // between quote time and execution time. The slight overhead (6 extra accounts) is
        // worth the reliability improvement over the single-tick-array swap instruction.
        // This prevents InvalidFirstTickArrayAccount (6028) and NotEnoughTickArrayAccount (6027) errors.
        const raydiumNeedsSwapV2 = true;
        
        // Get ammConfig from hop or cache - CRITICAL: cannot be derived, must come from pool data
        const ammConfigAddr = hop.ammConfig || stat?.amm_config;
        if (!ammConfigAddr) {
          logger.warn('routerTx.raydium.ammConfig_missing', {
            cat: 'tx',
            poolId: hop.poolId,
            note: 'ammConfig not in cache - will use poolId as placeholder (may fail)',
          });
        }
        const ammConfig = ammConfigAddr ? new PublicKey(ammConfigAddr) : poolId;
        
        // Observation state - MUST be from cache (validated to exist on-chain)
        // DO NOT derive PDAs as they may not exist on-chain, causing swap failures
        const cachedObservation = hop.observationId || stat?.observation_state;
        if (!cachedObservation) {
          throw new Error(
            `RAYDIUM_CLMM_OBSERVATION_MISSING: Pool ${hop.poolId} missing validated observation_state. ` +
            `Run /arb/pools/revalidate?dex=raydium to validate pool accounts.`
          );
        }
        const observationState = new PublicKey(cachedObservation);
        
        // Use the early exBitmap check results for consistency
        const exBitmapFromCache = exBitmapFromCacheEarly;
        const hasExBitmap = hasExBitmapEarly;
        const exBitmapPda = hasExBitmap 
          ? new PublicKey(exBitmapFromCache)
          : deriveRaydiumExBitmapPda(poolId, programIdKey); // Derived but won't be used if doesn't exist
        
        // CRITICAL: Use NATIVE account ordering for vault selection
        // Raydium CLMM passes input_vault and output_vault based on swap direction
        // native_account_a is paired with native_mint_a (token_vault_0 with token_mint_0)
        // Select vault based on which native mint matches input/output
        // MUST use same fallback logic as isAtoB direction check!
        const inputIsNativeA = nativeMintA 
          ? (hop.inputMint === nativeMintA)
          : (hop.inputMint === poolMintA);  // Fall back to canonical if native missing
        const outputIsNativeA = nativeMintA
          ? (hop.outputMint === nativeMintA)
          : (hop.outputMint === poolMintA);  // Fall back to canonical if native missing
        
        const inputVault = inputIsNativeA
          ? (nativeAccountA || hop.vaultA || poolAccountA || hop.poolId)
          : (nativeAccountB || hop.vaultB || poolAccountB || hop.poolId);
        const outputVault = outputIsNativeA
          ? (nativeAccountA || hop.vaultA || poolAccountA || hop.poolId)
          : (nativeAccountB || hop.vaultB || poolAccountB || hop.poolId);
        
        // Log the accounts being used for debugging
        logger.debug('routerTx.raydium.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          // Swap variant selection
          swapVariant: raydiumNeedsSwapV2 ? 'swap_v2' : 'swap',
          swapVariantReason: hasToken2022 ? 'token2022' : (hasExBitmapEarly ? 'spl_with_exbitmap' : 'spl_no_exbitmap'),
          inputTokenProgram: hop.inputTokenProgram || 'spl-token',
          outputTokenProgram: hop.outputTokenProgram || 'spl-token',
          ammConfig: ammConfig.toBase58(),
          ammConfigSource: ammConfigAddr ? 'cache' : 'fallback',
          observation: observationState.toBase58(),
          observationSource: 'cache',
          exBitmap: hasExBitmap ? exBitmapPda.toBase58() : 'not_included',
          exBitmapExists: hasExBitmap,
          exBitmapSource: exBitmapFromCache ? 'cache' : 'none',
          // Native ordering (used for direction and vaults)
          nativeMintA: nativeMintA || 'missing',
          nativeMintB: nativeMintB || 'missing',
          nativeAccountA: nativeAccountA || 'missing',
          nativeAccountB: nativeAccountB || 'missing',
          // Vault selection logic
          inputIsNativeA,
          outputIsNativeA,
          selectedInputVaultSource: inputIsNativeA ? 'vaultA' : 'vaultB',
          selectedOutputVaultSource: outputIsNativeA ? 'vaultA' : 'vaultB',
          vaultSelectionUsedFallback: !nativeMintA,
          // Canonical ordering (may be swapped)
          canonicalMintA: poolMintA || 'missing',
          canonicalMintB: poolMintB || 'missing',
          canonicalAccountA: poolAccountA || 'missing',
          canonicalAccountB: poolAccountB || 'missing',
          wasSwapped: (stat as any)?.was_swapped ?? 'unknown',
          // Hop fallback values
          hopVaultA: hop.vaultA || 'missing',
          hopVaultB: hop.vaultB || 'missing',
          // Selected vaults
          selectedInputVault: inputVault,
          selectedOutputVault: outputVault,
          // Tick arrays (stored in hop)
          tickArrayCenter: hop.tickArrayCenter || 'missing',
          tickArrayLower: hop.tickArrayLower || 'missing',
          tickArrayUpper: hop.tickArrayUpper || 'missing',
          // Direction (using native ordering)
          isAtoB,
          // Directional tick arrays (will be used in instruction)
          directionalTickArrays: {
            array0: hop.tickArrayCenter || 'missing',
            array1: (isAtoB ? hop.tickArrayLower : hop.tickArrayUpper) || 'missing',
            array2: (isAtoB ? hop.tickArrayUpper : hop.tickArrayLower) || 'missing',
            direction: isAtoB ? 'A→B (down)' : 'B→A (up)',
          },
          isAtoBSource: isAtoBDeterminedBy,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
        });
        
        // Account layout depends on instruction variant:
        // swap (SPL-only, 11-12 accounts):
        //   - WITH exBitmap (12 accounts): 0-8 fixed, 9 tickArray, 10 exBitmap, 11 program
        //   - WITHOUT exBitmap (11 accounts): 0-8 fixed, 9 tickArray, 10 program
        // swap_v2 (Token-2022, 17-18 accounts):
        //   - WITH exBitmap (18 accounts): 0-12 fixed, 13 exBitmap, 14-16 tickArrays, 17 program
        //   - WITHOUT exBitmap (17 accounts): 0-12 fixed, 13-15 tickArrays, 16 program
        {
          // Validate tick array addresses are valid base58 before use
          const rayTickArray0 = validateBase58Address(hop.tickArrayCenter, `raydium.tickArrayCenter.${hop.poolId.slice(0, 8)}`);
          const rawArray1 = isAtoB ? hop.tickArrayLower : hop.tickArrayUpper;
          const rawArray2 = isAtoB ? hop.tickArrayUpper : hop.tickArrayLower;
          const rayTickArray1 = validateBase58Address(rawArray1, `raydium.tickArray1.${hop.poolId.slice(0, 8)}`);
          const rayTickArray2 = validateBase58Address(rawArray2, `raydium.tickArray2.${hop.poolId.slice(0, 8)}`);

          // Validate tick arrays exist and are valid base58 before building instruction
          // swap needs only center tick array; swap_v2 needs all 3
          if (!rayTickArray0) {
            throw new Error(
              `RAYDIUM_CLMM_TICK_ARRAYS_INVALID: Pool ${hop.poolId} has invalid/missing center tick array. ` +
              `Raw value: "${hop.tickArrayCenter?.slice(0, 30) ?? 'undefined'}". ` +
              `Pool needs validation. The reactive cacheValidator should populate these automatically.`
            );
          }
          
          if (raydiumNeedsSwapV2) {
            // =================================================================
            // swap_v2: Token-2022 compatible (17-18 accounts)
            // Requires 3 tick arrays
            // =================================================================
            const missingTickArrays: string[] = [];
            if (!rayTickArray1) missingTickArrays.push(isAtoB ? 'lower' : 'upper');
            if (!rayTickArray2) missingTickArrays.push(isAtoB ? 'upper' : 'lower');
            
            if (missingTickArrays.length > 0) {
              throw new Error(
                `RAYDIUM_CLMM_TICK_ARRAYS_MISSING: Pool ${hop.poolId} missing tick arrays [${missingTickArrays.join(', ')}]. ` +
                `Pool needs validation for swap_v2.`
              );
            }
            
            // Check for duplicate tick arrays - causes "already mutably borrowed" panic
            const duplicateArrays: string[] = [];
            if (rayTickArray0 === rayTickArray1) duplicateArrays.push('center===array1');
            if (rayTickArray0 === rayTickArray2) duplicateArrays.push('center===array2');
            if (rayTickArray1 === rayTickArray2) duplicateArrays.push('array1===array2');
            
            if (duplicateArrays.length > 0) {
              logger.warn('routerTx.raydium.duplicate_tick_arrays', {
                cat: 'tx',
                poolId: hop.poolId,
                duplicates: duplicateArrays,
                isAtoB,
                hint: 'Pool has duplicate tick arrays (at boundary?). Skipping to avoid BorrowError.',
              });
              throw new Error(
                `RAYDIUM_CLMM_DUPLICATE_TICK_ARRAYS: Pool ${hop.poolId} has duplicate tick arrays [${duplicateArrays.join(', ')}]. ` +
                `This causes BorrowError on-chain.`
              );
            }
            
            // Fixed accounts (0-12)
            accounts.push(
              wallet,                                                              // 0: Payer (signer)
              ammConfig,                                                           // 1: AMM Config
              poolId,                                                              // 2: Pool State
              userSourceAta,                                                       // 3: Input Token Account (user)
              userDestAta,                                                         // 4: Output Token Account (user)
              new PublicKey(inputVault),                                           // 5: Input Vault
              new PublicKey(outputVault),                                          // 6: Output Vault
              observationState,                                                    // 7: Observation State
              TOKEN_PROGRAM_ID,                                                    // 8: Token Program
              TOKEN_2022_PROGRAM_ID,                                               // 9: Token-2022 Program
              MEMO_PROGRAM_ID,                                                     // 10: Memo Program
              inputMint,                                                           // 11: Input Token Mint
              outputMint,                                                          // 12: Output Token Mint
            );
            
            // Remaining accounts depend on whether exBitmap exists
            if (hasExBitmap) {
              // WITH exBitmap: 18 accounts total
              accounts.push(
                exBitmapPda,                                                       // 13: Tick Array Bitmap Extension
                new PublicKey(rayTickArray0),                                      // 14: Tick Array 0 (center)
                new PublicKey(rayTickArray1),                                      // 15: Tick Array 1
                new PublicKey(rayTickArray2),                                      // 16: Tick Array 2
                programIdKey,                                                      // 17: Raydium CLMM Program
              );
            } else {
              // WITHOUT exBitmap: 17 accounts total
              accounts.push(
                new PublicKey(rayTickArray0),                                      // 13: Tick Array 0 (center)
                new PublicKey(rayTickArray1),                                      // 14: Tick Array 1
                new PublicKey(rayTickArray2),                                      // 15: Tick Array 2
                programIdKey,                                                      // 16: Raydium CLMM Program
              );
            }
          } else {
            // =================================================================
            // swap: Standard SPL tokens only (11-12 accounts)
            // - With exBitmap: 12 accounts (0-8 fixed, 9 tickArray, 10 exBitmap, 11 program)
            // - Without exBitmap: 11 accounts (0-8 fixed, 9 tickArray, 10 program)
            // =================================================================
            
            // Fixed accounts (0-8) - no Token2022, Memo, or Mints
            accounts.push(
              wallet,                                                              // 0: Payer (signer)
              ammConfig,                                                           // 1: AMM Config
              poolId,                                                              // 2: Pool State
              userSourceAta,                                                       // 3: Input Token Account (user)
              userDestAta,                                                         // 4: Output Token Account (user)
              new PublicKey(inputVault),                                           // 5: Input Vault
              new PublicKey(outputVault),                                          // 6: Output Vault
              observationState,                                                    // 7: Observation State
              TOKEN_PROGRAM_ID,                                                    // 8: Token Program
              new PublicKey(rayTickArray0),                                        // 9: Tick Array (center) - only 1 needed!
            );
            
            // Add exBitmap if it exists, otherwise skip it
            if (hasExBitmap) {
              accounts.push(exBitmapPda);                                          // 10: Tick Array Bitmap Extension (optional)
            }
            
            accounts.push(programIdKey);                                           // 10/11: Raydium CLMM Program
          }
          
          // Debug logging to verify account positions
          logger.debug('routerTx.raydium.finalAccounts', {
            cat: 'tx',
            poolId: hop.poolId,
            totalAccounts: accounts.length,
            hasExBitmap,
            useSwapV2: raydiumNeedsSwapV2,
            inputTokenProgram: hop.inputTokenProgram || 'spl-token',
            outputTokenProgram: hop.outputTokenProgram || 'spl-token',
            // Log the last few accounts to verify program ID position
            accountLast3: accounts.slice(-3).map(a => a?.toBase58?.()?.slice(0, 8) + '…'),
            expectedProgramId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          });
        }
        // CRITICAL: Return early for Raydium to avoid padding by getAccountsNeededForDex
        // Variable accounts based on instruction variant
        return accounts;

      case DexType.Meteora:
        // Meteora DLMM: Supports two swap variants based on token type:
        //
        // swap (standard SPL tokens - 18 accounts):
        //   0-13: 14 fixed accounts (no Memo), user tokens in INPUT/OUTPUT order
        //   14: Program, 15+: BinArrays
        //
        // swap2 (Token-2022 compatible - 19 accounts):
        //   0-14: 15 fixed accounts (includes Memo at 13), user tokens in INPUT/OUTPUT order
        //   15: Program, 16+: BinArrays
        //
        // BOTH variants use INPUT/OUTPUT order for user token accounts (indices 4-5).
        // On-chain router auto-detects based on Memo Program at index 13.
        const meteoraEventAuthority = deriveMeteoraDlmmEventAuthority();
        
        // Get token programs from hop (set by resolver from pool cache)
        // CRITICAL: token_program_a/b are in CANONICAL order, but Meteora needs NATIVE X/Y order
        // When was_swapped is true, native X = canonical B and native Y = canonical A
        const wasSwapped = (stat as any)?.was_swapped === 'true' || (stat as any)?.was_swapped === true;
        const canonicalProgramA = tokenProgramLabelToKey((hop as any).tokenProgramA);
        const canonicalProgramB = tokenProgramLabelToKey((hop as any).tokenProgramB);
        let tokenXProgram = wasSwapped ? canonicalProgramB : canonicalProgramA;
        let tokenYProgram = wasSwapped ? canonicalProgramA : canonicalProgramB;
        
        // Detect if we need swap2 (Token-2022) or can use swap (standard SPL)
        const isToken2022X = tokenXProgram.equals(TOKEN_2022_PROGRAM_ID);
        const isToken2022Y = tokenYProgram.equals(TOKEN_2022_PROGRAM_ID);
        const needsSwap2 = isToken2022X || isToken2022Y;
        
        // CRITICAL: Meteora expects NATIVE reserves (reserveX/reserveY paired with tokenXMint/tokenYMint)
        // NOT canonical ordering! The on-chain lbPair has_one constraint validates against native reserves.
        // For Meteora DLMM, the pool cache has reserve_x/reserve_y which are the native reserves.
        // native_account_a/native_account_b may not be set for Meteora, so use reserve_x/reserve_y directly.
        const meteoraNativeReserveX = (stat as any)?.reserve_x;  // Native reserveX from lbPair
        const meteoraNativeReserveY = (stat as any)?.reserve_y;  // Native reserveY from lbPair
        const meteoraNativeAccountA = stat?.native_account_a || meteoraNativeReserveX;
        const meteoraNativeAccountB = stat?.native_account_b || meteoraNativeReserveY;
        const meteoraNativeMintA = stat?.native_mint_a;
        const meteoraNativeMintB = stat?.native_mint_b;
        
        // reserveX pairs with tokenXMint (native ordering, not canonical)
        // CRITICAL: When native reserves are not available, use was_swapped to correct the canonical fallback
        // When wasSwapped is true: native X = canonical B, native Y = canonical A
        const canonicalVaultX = wasSwapped ? hop.vaultB : hop.vaultA;
        const canonicalVaultY = wasSwapped ? hop.vaultA : hop.vaultB;
        let reserveX = hop.reserveX || meteoraNativeReserveX || meteoraNativeAccountA || canonicalVaultX || hop.poolId;
        let reserveY = hop.reserveY || meteoraNativeReserveY || meteoraNativeAccountB || canonicalVaultY || hop.poolId;
        
        // Token X/Y mints must also be native ordering
        // CRITICAL: When native_mint_a/b are not available, use was_swapped to correct the canonical fallback
        // When wasSwapped is true: native X = canonical B, native Y = canonical A
        // This matches the token program logic above (lines 1169-1170)
        let tokenXMint = meteoraNativeMintA || (wasSwapped ? poolMintB : poolMintA);
        let tokenYMint = meteoraNativeMintB || (wasSwapped ? poolMintA : poolMintB);
        
        // Warn if we're using canonical fallback (native ordering is preferred)
        if (!meteoraNativeMintA || !meteoraNativeMintB) {
          logger.warn('routerTx.meteora.native_mints_missing', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              wasSwapped,
              fallbackMintX: tokenXMint || 'unknown',
              fallbackMintY: tokenYMint || 'unknown',
              hasCacheNativeA: !!meteoraNativeMintA,
              hasCacheNativeB: !!meteoraNativeMintB,
              canonicalMintA: poolMintA || 'unknown',
              canonicalMintB: poolMintB || 'unknown',
            },
          });
        }
        
        // Recalculate isAtoB using native mint ordering for Meteora
        // X->Y means inputMint matches tokenXMint (native mint A)
        let isXtoY = hop.inputMint === tokenXMint;
        
        // User token accounts for logging (X/Y native order)
        // isXtoY = true: User sends X, receives Y → userTokenX = source, userTokenY = dest
        // isXtoY = false: User sends Y, receives X → userTokenX = dest, userTokenY = source
        const userTokenX = isXtoY ? userSourceAta : userDestAta;
        const userTokenY = isXtoY ? userDestAta : userSourceAta;
        
        // Get activeId from cache for directional bin array derivation
        const meteoraPoolIdStr = hop.poolId.replace(/[#-]rev$/, '');
        const hotCache = executionCache.getHot(meteoraPoolIdStr) as any;
        const activeId = hop.activeId ?? hotCache?.activeId;
        
        // Derive bitmap extension PDA if needed but not provided
        // The bitmap extension is required when activeId is outside the default internal bitmap range
        // Default range is ±512 * BIN_ARRAY_SIZE (70) = ±35,840
        const BIN_ARRAY_SIZE = 70;
        const DEFAULT_BITMAP_RANGE = 512 * BIN_ARRAY_SIZE; // 35,840
        
        if (!hop.bitmapExtension && typeof activeId === 'number' && Math.abs(activeId) > DEFAULT_BITMAP_RANGE) {
          try {
            // Derive bitmap extension PDA: seeds = ["bitmap", lb_pair]
            const meteoraPoolPk = new PublicKey(meteoraPoolIdStr);
            const [bitmapPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('bitmap'), meteoraPoolPk.toBuffer()],
              programIdKey
            );
            hop.bitmapExtension = bitmapPda.toBase58();
            
            logger.debug('routerTx.meteora.bitmapExtension.derived', {
              cat: 'tx',
              ctx: {
                poolId: meteoraPoolIdStr.slice(0, 8) + '...',
                activeId,
                threshold: DEFAULT_BITMAP_RANGE,
                bitmapExtension: hop.bitmapExtension.slice(0, 8) + '...',
              },
            });
          } catch (e) {
            logger.warn('routerTx.meteora.bitmapExtension.derivation_failed', {
              cat: 'tx',
              ctx: {
                poolId: meteoraPoolIdStr.slice(0, 8) + '...',
                activeId,
                error: (e as Error).message,
              },
            });
          }
        }
        
        // Derive 3 directional bin arrays based on swap direction
        // X→Y (isXtoY): active, active-1, active-2 (price goes DOWN → lower direction)
        // Y→X (!isXtoY): active, active+1, active+2 (price goes UP → upper direction)
        //
        // CRITICAL: The FIRST bin array MUST contain the active bin!
        // Meteora swap2 starts from the active bin and traverses in the swap direction.
        // The cache's binArrayLower/binArrayUpper are NEIGHBORS of the active array, not the active itself!
        // We must derive the active bin array and put it first.
        
        // Collect all 5 known-good bin arrays from the cache (validated to exist on-chain)
        // - active: bin array containing the active bin (activeIndex)
        // - lower: bin array at activeIndex - 1
        // - lower2: bin array at activeIndex - 2
        // - upper: bin array at activeIndex + 1
        // - upper2: bin array at activeIndex + 2
        // Validate base58 addresses before creating PublicKey to prevent "Non-base58 character" errors
        const validatedActive = validateBase58Address((hop as any).binArrayActive, `meteora.binArrayActive.${hop.poolId.slice(0, 8)}`);
        const validatedLower = validateBase58Address(hop.binArrayLower, `meteora.binArrayLower.${hop.poolId.slice(0, 8)}`);
        const validatedLower2 = validateBase58Address((hop as any).binArrayLower2, `meteora.binArrayLower2.${hop.poolId.slice(0, 8)}`);
        const validatedUpper = validateBase58Address(hop.binArrayUpper, `meteora.binArrayUpper.${hop.poolId.slice(0, 8)}`);
        const validatedUpper2 = validateBase58Address((hop as any).binArrayUpper2, `meteora.binArrayUpper2.${hop.poolId.slice(0, 8)}`);

        const knownBinArrayActive = validatedActive ? new PublicKey(validatedActive) : null;
        const knownBinArrayLower = validatedLower ? new PublicKey(validatedLower) : null;
        const knownBinArrayLower2 = validatedLower2 ? new PublicKey(validatedLower2) : null;
        const knownBinArrayUpper = validatedUpper ? new PublicKey(validatedUpper) : null;
        const knownBinArrayUpper2 = validatedUpper2 ? new PublicKey(validatedUpper2) : null;
        
        // Get binStep from hop or static cache to determine how many bin arrays needed
        // Pools with smaller binStep need more bin arrays as each covers a smaller price range
        // binStep 2 = ~0.02% per bin, binStep 15 = ~0.15% per bin (7.5x difference)
        const binStep = (hop as any).binStep ?? (stat as any)?.bin_step ?? hotCache?.binStep;
        const binStepNum = typeof binStep === 'string' ? parseInt(binStep, 10) : (binStep ?? 10);
        
        // Use 5 bin arrays for fine-grained pools (binStep <= 5), 3 for others
        // This prevents error 3005 "Not enough account keys" when swap traverses multiple bin arrays
        const neededBinArrayCount = binStepNum <= 5 ? 5 : 3;

        let directionalBinArrays: PublicKey[] = [];

        // PRIORITY 1: Use SDK-provided bin arrays directly if available (SDK Quote mode)
        // The SDK returns validated bin arrays sorted by index (low to high)
        // We use activeId to find the active bin array and select directionally from there
        const sdkBinArrays = (hop as any).binArrays as string[] | undefined;
        if (sdkBinArrays && sdkBinArrays.length > 0) {
          // Validate all SDK-provided addresses before directional selection
          const validatedArrays: PublicKey[] = [];
          for (const addr of sdkBinArrays) {
            const validated = validateBase58Address(addr, `meteora.sdkBinArray.${hop.poolId.slice(0, 8)}`);
            if (validated) {
              validatedArrays.push(new PublicKey(validated));
            }
          }

          if (validatedArrays.length > 0) {
            // Calculate the active bin array index from activeId
            // Each bin array contains BIN_ARRAY_SIZE (70) bins
            const BIN_ARRAY_SIZE = 70;
            const sdkActiveId = hop.activeId ?? activeId;
            let activeArrayIndex = -1;

            if (typeof sdkActiveId === 'number' && Number.isFinite(sdkActiveId)) {
              // activeId tells us which bin is active; activeIndex = floor(activeId / 70)
              const activeBinArrayIdx = Math.floor(sdkActiveId / BIN_ARRAY_SIZE);

              // Derive the PDA for the active bin array to find it in the SDK list
              const meteoraPoolIdClean = hop.poolId.replace(/[#-]rev$/, '');
              const idxBn = new BN(activeBinArrayIdx);
              const seed = idxBn.isNeg()
                ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
                : idxBn.toArrayLike(Buffer, 'le', 8);
              const [activeBinArrayPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bin_array'), new PublicKey(meteoraPoolIdClean).toBuffer(), seed],
                new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') // METEORA_DLMM_PROGRAM
              );
              const activeBinArrayAddr = activeBinArrayPda.toBase58();

              // Find the active bin array's position in the SDK list
              for (let i = 0; i < validatedArrays.length; i++) {
                if (validatedArrays[i].toBase58() === activeBinArrayAddr) {
                  activeArrayIndex = i;
                  break;
                }
              }

              logger.debug('routerTx.meteora.binArrays.activeIdLookup', {
                cat: 'tx',
                poolId: hop.poolId.slice(0, 8),
                activeId: sdkActiveId,
                activeBinArrayIdx,
                activeBinArrayPda: activeBinArrayAddr.slice(0, 8),
                foundAtIndex: activeArrayIndex,
                sdkArrayCount: validatedArrays.length,
              });
            }

            // If we found the active array, select directionally from there
            // Otherwise fall back to midpoint heuristic
            const startIndex = activeArrayIndex >= 0 ? activeArrayIndex : Math.floor(validatedArrays.length / 2);

            if (isXtoY) {
              // X→Y: price goes DOWN → need active array first, then lower indices
              // Take from startIndex going DOWN (active, active-1, active-2, ...)
              directionalBinArrays = [];
              for (let i = startIndex; i >= 0 && directionalBinArrays.length < neededBinArrayCount; i--) {
                directionalBinArrays.push(validatedArrays[i]);
              }
            } else {
              // Y→X: price goes UP → need active array first, then higher indices
              // Take from startIndex going UP (active, active+1, active+2, ...)
              directionalBinArrays = [];
              for (let i = startIndex; i < validatedArrays.length && directionalBinArrays.length < neededBinArrayCount; i++) {
                directionalBinArrays.push(validatedArrays[i]);
              }
            }

            // Ensure we have enough arrays (pad with what we have if needed)
            while (directionalBinArrays.length < neededBinArrayCount && validatedArrays.length > 0) {
              // Pad with the last array we have (safe fallback)
              directionalBinArrays.push(directionalBinArrays[directionalBinArrays.length - 1] || validatedArrays[0]);
            }

            logger.debug('routerTx.meteora.binArrays.fromSdk', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId.slice(0, 8) + '...',
                sdkArrayCount: sdkBinArrays.length,
                validCount: validatedArrays.length,
                selectedCount: directionalBinArrays.length,
                binStep: binStepNum,
                isXtoY,
                activeArrayIndex,
                startIndex,
                arrays: directionalBinArrays.map(a => a.toBase58().slice(0, 8)),
              },
            });
          } else {
            logger.warn('routerTx.meteora.binArrays.sdkAllInvalid', {
              cat: 'tx',
              poolId: hop.poolId.slice(0, 8),
              sdkArrayCount: sdkBinArrays.length,
              sampleAddr: sdkBinArrays[0]?.slice(0, 20),
            });
          }
        }

        // PRIORITY 2: Build N directional bin arrays based on activeId and swap direction (cache-based)
        // Only used if SDK arrays weren't available
        if (directionalBinArrays.length === 0) {
          // CRITICAL: Meteora swap2 traverses bin arrays starting from the active bin.
          // We MUST include the active bin array first, then arrays in the swap direction:
          // - X→Y: price goes DOWN → need arrays at activeIndex, activeIndex-1, activeIndex-2, ...
          // - Y→X: price goes UP → need arrays at activeIndex, activeIndex+1, activeIndex+2, ...
          //
          // IMPORTANT: Derived PDAs might not exist on-chain (no liquidity deposited there).
          // Error 3007 = "AccountOwnedByWrongProgram" means the PDA is owned by System Program (uninitialized).
          // We ONLY use derived arrays if they match known-good cached arrays.
          // Otherwise, we fall back to cached arrays which are verified to exist.

          const hasKnownArrays = knownBinArrayActive || knownBinArrayLower || knownBinArrayUpper;

          if (typeof activeId === 'number' && Number.isFinite(activeId) && hasKnownArrays) {
          const BIN_ARRAY_SIZE = 70;
          const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
          
          // Derive directional bin arrays (use neededBinArrayCount for fine-grained pools)
          const derived = deriveMeteoraBinArraysDirectional(poolId, activeId, isXtoY, neededBinArrayCount);
          
          // Build a set of ALL known-good arrays (from cache: active + ±2 neighbors)
          const knownActiveStr = knownBinArrayActive?.toBase58();
          const knownLowerStr = knownBinArrayLower?.toBase58();
          const knownLower2Str = knownBinArrayLower2?.toBase58();
          const knownUpperStr = knownBinArrayUpper?.toBase58();
          const knownUpper2Str = knownBinArrayUpper2?.toBase58();
          const derivedStrs = derived.arrays.map(a => a.toBase58());
          
          // Create a set of all known-good array addresses for quick lookup
          const knownGoodSet = new Set<string>();
          if (knownActiveStr) knownGoodSet.add(knownActiveStr);
          if (knownLowerStr) knownGoodSet.add(knownLowerStr);
          if (knownLower2Str) knownGoodSet.add(knownLower2Str);
          if (knownUpperStr) knownGoodSet.add(knownUpperStr);
          if (knownUpper2Str) knownGoodSet.add(knownUpper2Str);
          
          // Check which derived arrays match any known-good cached array
          const derivedMatches = derivedStrs.map(d => knownGoodSet.has(d));
          
          // Build the final array using known-good arrays
          // For each position, use derived if it matches known-good, else fallback
          directionalBinArrays = [];
          
          // Build ordered list of fallback arrays based on direction
          const orderedFallbacks = isXtoY
            ? [knownBinArrayActive, knownBinArrayLower, knownBinArrayLower2, knownBinArrayUpper, knownBinArrayUpper2]
            : [knownBinArrayActive, knownBinArrayUpper, knownBinArrayUpper2, knownBinArrayLower, knownBinArrayLower2];
          const validFallbacks = orderedFallbacks.filter((arr): arr is PublicKey => arr !== null);
          
          for (let i = 0; i < neededBinArrayCount; i++) {
            if (derivedMatches[i]) {
              // This derived array matches a known-good one, safe to use
              directionalBinArrays.push(derived.arrays[i]);
            } else {
              // Fallback: use known-good arrays, cycling through if needed
              const fallbackIdx = Math.min(i, validFallbacks.length - 1);
              directionalBinArrays.push(validFallbacks[fallbackIdx] || derived.arrays[i]);
            }
          }
          
          // Log for debugging
          logger.debug('routerTx.meteora.binArraysBuilt', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              activeId,
              activeIndex,
              binStep: binStepNum,
              neededBinArrayCount,
              isXtoY,
              derivedMatches,
              knownGoodCount: knownGoodSet.size,
              final: directionalBinArrays.map((a, i) => `${i}:${a.toBase58().slice(0, 8)}`),
              knownActive: knownActiveStr?.slice(0, 8),
              knownLower: knownLowerStr?.slice(0, 8),
              knownLower2: knownLower2Str?.slice(0, 8),
              knownUpper: knownUpperStr?.slice(0, 8),
              knownUpper2: knownUpper2Str?.slice(0, 8),
            }
          });
        } else if (knownBinArrayActive || knownBinArrayLower || knownBinArrayUpper) {
          // NO activeId available - use only known-good cached arrays
          // Use whichever arrays we have, duplicating if necessary
          const primary = knownBinArrayActive || knownBinArrayLower || knownBinArrayUpper!;
          const secondary = knownBinArrayUpper || knownBinArrayLower || knownBinArrayActive!;
          const tertiary = knownBinArrayLower2 || knownBinArrayUpper2 || secondary;
          
          if (isXtoY) {
            // X→Y: prefer lower direction - build array with needed count
            directionalBinArrays = [primary];
            while (directionalBinArrays.length < neededBinArrayCount) {
              directionalBinArrays.push(directionalBinArrays.length === 1 ? primary : tertiary);
            }
          } else {
            // Y→X: prefer upper direction - build array with needed count
            directionalBinArrays = [primary];
            while (directionalBinArrays.length < neededBinArrayCount) {
              directionalBinArrays.push(directionalBinArrays.length === 1 ? secondary : tertiary);
            }
          }
          logger.warn('routerTx.meteora.noActiveId', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              binStep: binStepNum,
              neededBinArrayCount,
              isXtoY,
              hasLower: !!knownBinArrayLower,
              hasUpper: !!knownBinArrayUpper,
              knownLower: knownBinArrayLower?.toBase58().slice(0, 8),
              knownUpper: knownBinArrayUpper?.toBase58().slice(0, 8),
            }
          });
        } else {
          // LAST RESORT: use whatever we have
          const fallbackArrays: PublicKey[] = [];
          if (knownBinArrayLower) fallbackArrays.push(knownBinArrayLower);
          if (knownBinArrayUpper) fallbackArrays.push(knownBinArrayUpper);
          if (knownBinArrayLower2) fallbackArrays.push(knownBinArrayLower2);
          if (knownBinArrayUpper2) fallbackArrays.push(knownBinArrayUpper2);
          // Pad if needed to reach neededBinArrayCount
          while (fallbackArrays.length < neededBinArrayCount) {
            fallbackArrays.push(fallbackArrays.length > 0 ? fallbackArrays[fallbackArrays.length - 1] : poolId);
          }
          directionalBinArrays = fallbackArrays.slice(0, neededBinArrayCount);
          logger.warn('routerTx.meteora.fallbackBinArrays', {
            cat: 'tx',
            ctx: { poolId: hop.poolId, count: directionalBinArrays.length, binStep: binStepNum }
          });
          }
        } // End of: if (directionalBinArrays.length === 0)

        // Log the accounts being used for debugging with verification
        logger.debug('routerTx.meteora.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          // Instruction variant
          variant: needsSwap2 ? 'swap2' : 'swap',
          isToken2022X,
          isToken2022Y,
          // Native ordering (what Meteora expects)
          native: {
            reserveX,
            reserveY,
            tokenXMint: tokenXMint || 'missing',
            tokenYMint: tokenYMint || 'missing',
            // Cache fields used for resolution
            cacheReserveX: meteoraNativeReserveX || 'missing',
            cacheReserveY: meteoraNativeReserveY || 'missing',
            mintA: meteoraNativeMintA || 'missing',
            mintB: meteoraNativeMintB || 'missing',
          },
          // Canonical ordering (may be swapped)
          canonical: {
            accountA: poolAccountA || 'missing',
            accountB: poolAccountB || 'missing',
            mintA: poolMintA || 'missing',
            mintB: poolMintB || 'missing',
          },
          // Check if canonical was swapped from native
          wasSwapped: (stat as any)?.was_swapped ?? 'unknown',
          // Hop fallback values
          hop: {
            vaultA: hop.vaultA || 'missing',
            vaultB: hop.vaultB || 'missing',
            reserveX: hop.reserveX || 'missing',
            reserveY: hop.reserveY || 'missing',
          },
          // Bin array source tracking
          binArrays: {
            binStep: binStepNum,
            count: directionalBinArrays.length,
            knownLower: hop.binArrayLower?.slice(0, 8) || 'missing',
            knownUpper: hop.binArrayUpper?.slice(0, 8) || 'missing',
            usedDerivedActive: typeof activeId === 'number' && Number.isFinite(activeId),
            directional: directionalBinArrays.map(pk => pk.toBase58().slice(0, 8)),
          },
          // Other fields
          bitmapExtension: hop.bitmapExtension || 'missing',
          oracle: hop.oracle || 'missing',
          activeId: activeId ?? 'missing',
          isXtoY,
          isAtoBCanonical: isAtoB, // For comparison - canonical direction
          // User token accounts
          userTokenX: userTokenX.toBase58(),
          userTokenY: userTokenY.toBase58(),
          userSourceAta: userSourceAta.toBase58(),
          userDestAta: userDestAta.toBase58(),
          tokenXProgram: tokenXProgram.toBase58(),
          tokenYProgram: tokenYProgram.toBase58(),
          eventAuthority: meteoraEventAuthority.toBase58(),
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
        });
        
        if (needsSwap2) {
          // swap2: Token-2022 compatible (19 accounts)
          // CRITICAL: User tokens are in INPUT/OUTPUT order (userTokenIn, userTokenOut), NOT X/Y order!
          // This matches the Meteora DLMM SDK's swap2 account layout.
          accounts.push(
            poolId,                                                              // 0: LB Pair
            hop.bitmapExtension 
              ? new PublicKey(hop.bitmapExtension) 
              : programIdKey,                                                    // 1: Bitmap Extension (use program ID as placeholder)
            new PublicKey(reserveX),                                             // 2: Reserve X (native, paired with tokenXMint)
            new PublicKey(reserveY),                                             // 3: Reserve Y (native, paired with tokenYMint)
            userSourceAta,                                                       // 4: User Token In (INPUT/OUTPUT order for swap2!)
            userDestAta,                                                         // 5: User Token Out (INPUT/OUTPUT order for swap2!)
            tokenXMint ? new PublicKey(tokenXMint) : inputMint,                 // 6: Token X Mint (native)
            tokenYMint ? new PublicKey(tokenYMint) : outputMint,                // 7: Token Y Mint (native)
            hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 8: Oracle (from pool data)
            programIdKey,                                                        // 9: Host Fee In (use program as placeholder)
            wallet,                                                              // 10: User (signer)
            tokenXProgram,                                                       // 11: Token X Program
            tokenYProgram,                                                       // 12: Token Y Program
            MEMO_PROGRAM_ID,                                                     // 13: Memo Program (REQUIRED for swap2!)
            meteoraEventAuthority,                                               // 14: Event Authority (PDA)
            programIdKey,                                                        // 15: Meteora DLMM Program
          );
          // Bin arrays at indices 16-18
        } else {
          // swap: Standard SPL tokens (18 accounts)
          // User tokens in INPUT/OUTPUT order, no Memo Program
          accounts.push(
            poolId,                                                              // 0: LB Pair
            hop.bitmapExtension 
              ? new PublicKey(hop.bitmapExtension) 
              : programIdKey,                                                    // 1: Bitmap Extension (use program ID as placeholder)
            new PublicKey(reserveX),                                             // 2: Reserve X (native, paired with tokenXMint)
            new PublicKey(reserveY),                                             // 3: Reserve Y (native, paired with tokenYMint)
            userSourceAta,                                                       // 4: User Token In (INPUT/OUTPUT order for swap!)
            userDestAta,                                                         // 5: User Token Out (INPUT/OUTPUT order for swap!)
            tokenXMint ? new PublicKey(tokenXMint) : inputMint,                 // 6: Token X Mint (native)
            tokenYMint ? new PublicKey(tokenYMint) : outputMint,                // 7: Token Y Mint (native)
            hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 8: Oracle (from pool data)
            programIdKey,                                                        // 9: Host Fee In (use program as placeholder)
            wallet,                                                              // 10: User (signer)
            tokenXProgram,                                                       // 11: Token X Program
            tokenYProgram,                                                       // 12: Token Y Program
            meteoraEventAuthority,                                               // 13: Event Authority (NO Memo for swap!)
            programIdKey,                                                        // 14: Meteora DLMM Program
          );
          // Bin arrays at indices 15-17
        }
        
        // Add 3 directional bin arrays
        // CRITICAL: Only use bin arrays we KNOW exist on-chain
        // The knownBinArrayLower/Upper are from pool cache and verified to exist
        // Derived bin arrays might not exist if the pool has sparse liquidity
        accounts.push(...directionalBinArrays);
        
        // NOTE: We intentionally only use 3 bin arrays (the directional set).
        // Previously we added up to 8 bin arrays from cache, but this caused errors:
        // - Error 3007: Derived PDAs might not exist on-chain (owned by System Program)
        // - Error 3005: Meteora tries to read ALL passed bin arrays, failing if any are bad
        // Jupiter and other successful swaps use 2-3 bin arrays typically.
        
        // CRITICAL: Return early for Meteora to avoid truncation by getAccountsNeededForDex
        // which only returns 18 (swap), but swap2 needs 19 accounts
        return accounts;

      case DexType.Orca:
        // Orca Whirlpool supports two swap variants:
        //
        // swap (standard SPL tokens - 12 accounts):
        //   0: TokenProgram, 1: TokenAuthority(signer), 2: Whirlpool, 3: TokenOwnerAccountA,
        //   4: TokenVaultA, 5: TokenOwnerAccountB, 6: TokenVaultB, 7-9: TickArrays, 10: Oracle, 11: Program
        //
        // swapV2 (Token-2022 compatible - 15 accounts):
        //   0: TokenProgramA, 1: TokenProgramB, 2: MemoProgram, 3: TokenAuthority(signer),
        //   4: Whirlpool, 5: TokenMintA, 6: TokenMintB, 7: TokenOwnerAccountA,
        //   8: TokenVaultA, 9: TokenOwnerAccountB, 10: TokenVaultB, 11-13: TickArrays, 14: Oracle
        //   (15: Program for CPI)
        //
        // On-chain router auto-detects based on account count (12 vs 15+).
        
        // CRITICAL: Orca swap direction MUST match the aToB flag passed to on-chain program
        // Use isAtoB directly (which uses passed opts.aToB if available) to ensure consistency
        // This prevents mismatch between direction flag and account ordering
        const isAtoBOrca = isAtoB;
        const userTokenA = isAtoBOrca ? userSourceAta : userDestAta;
        const userTokenB = isAtoBOrca ? userDestAta : userSourceAta;
        
        // Detect if we need swapV2 (Token-2022) or can use swap (standard SPL)
        // Check token programs for both mints
        let orcaTokenProgramA = TOKEN_PROGRAM_ID;
        let orcaTokenProgramB = TOKEN_PROGRAM_ID;
        let orcaNeedsSwapV2 = false;
        
        try {
          const mintAStr = nativeMintA || hop.inputMint;
          const mintBStr = nativeMintB || hop.outputMint;
          
          const [metaA, metaB] = await Promise.all([
            getTokenMeta(mintAStr),
            getTokenMeta(mintBStr),
          ]);
          
          if (metaA.program === 'token-2022') {
            orcaTokenProgramA = TOKEN_2022_PROGRAM_ID;
            orcaNeedsSwapV2 = true;
          }
          if (metaB.program === 'token-2022') {
            orcaTokenProgramB = TOKEN_2022_PROGRAM_ID;
            orcaNeedsSwapV2 = true;
          }
        } catch {
          // Fallback: check static cache for token program info
          const tokenProgramA = (stat as any)?.token_program_a;
          const tokenProgramB = (stat as any)?.token_program_b;
          if (tokenProgramA === 'token-2022') {
            orcaTokenProgramA = TOKEN_2022_PROGRAM_ID;
            orcaNeedsSwapV2 = true;
          }
          if (tokenProgramB === 'token-2022') {
            orcaTokenProgramB = TOKEN_2022_PROGRAM_ID;
            orcaNeedsSwapV2 = true;
          }
        }
        
        // CRITICAL: Use NATIVE account ordering for vaults
        // Orca expects vaults in A/B order matching the on-chain native order
        // native_account_a is paired with native_mint_a (token_vault_a with token_mint_a)
        const orcaVaultA = nativeAccountA || hop.vaultA || poolAccountA || hop.poolId;
        const orcaVaultB = nativeAccountB || hop.vaultB || poolAccountB || hop.poolId;
        
        // CRITICAL: Orca Whirlpool swap expects tick arrays in a direction-specific SEQUENCE:
        // tick_array_0 contains current tick, then two sequential arrays in swap direction.
        // A->B (going down): [center, lower, even_lower] = [realIndex, realIndex-1, realIndex-2]
        // B->A (going up): [center, upper, even_upper] = [realIndex, realIndex+1, realIndex+2]
        //
        // CRITICAL: Derived tick arrays may NOT exist on-chain for thin liquidity pools!
        // The resolver only stores lower/center/upper from the pool cache (known to exist).
        // The third array (even_lower or even_upper) is derived and may not be initialized.
        // Use known-good arrays and duplicate the second one for safety.
        const poolIdStr = hop.poolId.replace(/[#-]rev$/, '');

        // Known-good tick arrays from resolver (confirmed to exist via pool cache)
        // Validate base58 format before use to prevent "Non-base58 character" errors
        const knownCenter = validateBase58Address(hop.tickArrayCenter, `orca.tickArrayCenter.${poolIdStr.slice(0, 8)}`) || '';
        const knownLower = validateBase58Address(hop.tickArrayLower, `orca.tickArrayLower.${poolIdStr.slice(0, 8)}`) || '';
        const knownUpper = validateBase58Address(hop.tickArrayUpper, `orca.tickArrayUpper.${poolIdStr.slice(0, 8)}`) || '';

        // Tick array selection strategy (in priority order):
        // 1. PRIORITY 0: Use SDK-provided tick arrays (freshest, already direction-aware from quote)
        // 2. PRIORITY 1: Derive tick arrays from current tick (accurate if currentTickIndex available)
        // 3. PRIORITY 2: Use cached arrays with directional ordering (fallback, may be stale)
        //
        // CRITICAL: SDK tick arrays are the BEST source because:
        // - They were just computed by the Orca SDK for THIS specific swap
        // - They are already direction-aware (the SDK knows aToB)
        // - They reflect the current on-chain state at quote time
        //
        // For aToB = true (A→B): ticks traverse downward, need [center, lower, even_lower]
        // For aToB = false (B→A): ticks traverse upward, need [center, upper, even_upper]
        
        let tickArray0 = '';
        let tickArray1 = '';
        let tickArray2 = '';
        let tickArraySource = 'none';

        // PRIORITY 0: Use SDK-provided tick arrays if available
        // These are the freshest and most accurate - computed by SDK for this exact swap
        const sdkTickArray0 = validateBase58Address((hop as any).tickArray0, `orca.sdk.tickArray0.${poolIdStr.slice(0, 8)}`);
        const sdkTickArray1 = validateBase58Address((hop as any).tickArray1, `orca.sdk.tickArray1.${poolIdStr.slice(0, 8)}`);
        const sdkTickArray2 = validateBase58Address((hop as any).tickArray2, `orca.sdk.tickArray2.${poolIdStr.slice(0, 8)}`);

        if (sdkTickArray0 && sdkTickArray1) {
          // SDK provided valid tick arrays - use them directly
          tickArray0 = sdkTickArray0;
          tickArray1 = sdkTickArray1;
          tickArray2 = sdkTickArray2 || sdkTickArray1; // Fallback to array1 if array2 missing
          tickArraySource = sdkTickArray2 ? 'sdk' : 'sdk_dup2';
          
          logger.debug('routerTx.orca.tickArrays.using_sdk', {
            cat: 'tx',
            poolId: poolIdStr.slice(0, 8) + '...',
            arrays: [sdkTickArray0.slice(0, 8), sdkTickArray1.slice(0, 8), (sdkTickArray2 || sdkTickArray1).slice(0, 8)],
            source: tickArraySource,
          });
        }
        
        // PRIORITY 1: If no SDK arrays, try to derive from current tick index
        if (!tickArray0) {
          try {
            const hot = executionCache.getHot(poolIdStr);
            const tickSpacing = (hop.tickSpacing ?? (hot as any)?.tickSpacing);
            const currentTick = (hot as any)?.currentTickIndex;
            if (Number.isFinite(tickSpacing) && Number(tickSpacing) > 0 && Number.isFinite(currentTick)) {
              const derived = deriveOrcaTickArraysForSwap(poolId, Number(currentTick), Number(tickSpacing), !!isAtoBOrca);
              const derivedArray0 = derived.tickArray0.toBase58();
              const derivedArray1 = derived.tickArray1.toBase58();
              const derivedArray2 = derived.tickArray2.toBase58();
              
              // Use derived arrays directly - they're based on current tick position
              tickArray0 = derivedArray0;
              tickArray1 = derivedArray1;
              tickArray2 = derivedArray1; // Duplicate array1 (third array may not exist on thin pools)
              tickArraySource = 'derived';
              
              logger.debug('routerTx.orca.tickArrays.derived', {
                cat: 'tx',
                poolId: poolIdStr.slice(0, 8) + '...',
                currentTick,
                tickSpacing,
                isAtoB: isAtoBOrca,
                arrays: [derivedArray0.slice(0, 8), derivedArray1.slice(0, 8), derivedArray1.slice(0, 8)],
              });
            }
          } catch { /* derivation failed, fall back to cache-based */ }
        }

        // PRIORITY 2: Fall back to cache-based arrays with directional ordering
        if (!tickArray0) {
          // tickArray0 = center (contains current tick - may be stale but validated)
          // tickArray1 = next in direction (lower for A→B, upper for B→A)
          // tickArray2 = duplicate of tickArray1 (safe fallback)
          tickArray0 = knownCenter;
          tickArray1 = isAtoBOrca ? knownLower : knownUpper;
          tickArray2 = tickArray1;  // Safe: duplicate the second array
          tickArraySource = 'cache_directional';
          
          // Log warning when using cache fallback - SDK arrays should normally be available
          const hot = executionCache.getHot(poolIdStr);
          logger.warn('routerTx.orca.tickArrays.cache_fallback', {
            cat: 'tx',
            poolId: poolIdStr.slice(0, 8) + '...',
            hasHotCache: !!hot,
            hasCurrentTickIndex: hot?.currentTickIndex !== undefined,
            currentTickIndex: hot?.currentTickIndex,
            hasTickSpacing: !!hot?.tickSpacing,
            tickSpacing: hot?.tickSpacing,
            hopTickSpacing: hop.tickSpacing,
            hasSdkArrays: !!(sdkTickArray0 || sdkTickArray1),
            hint: 'Using cache_directional fallback - tick arrays may be stale if price moved',
          });
        }

        logger.debug('routerTx.orca.tickArrays.directional', {
          cat: 'tx',
          poolId: poolIdStr.slice(0, 8),
          arrays: [tickArray0.slice(0, 8), tickArray1.slice(0, 8), tickArray2.slice(0, 8)],
          isAtoB: isAtoBOrca,
          source: tickArraySource,
          known: { center: knownCenter.slice(0, 8), lower: knownLower.slice(0, 8), upper: knownUpper.slice(0, 8) },
        });
        
        // Get mint pubkeys for swapV2
        const orcaMintA = nativeMintA ? new PublicKey(nativeMintA) : inputMint;
        const orcaMintB = nativeMintB ? new PublicKey(nativeMintB) : outputMint;
        
        // Log the accounts being used for debugging with native mint verification
        logger.debug('routerTx.orca.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          // Instruction variant
          variant: orcaNeedsSwapV2 ? 'swapV2' : 'swap',
          tokenProgramA: orcaTokenProgramA.toBase58().slice(0, 8) + '...',
          tokenProgramB: orcaTokenProgramB.toBase58().slice(0, 8) + '...',
          // Native ordering (used for direction and vaults)
          native: {
            mintA: nativeMintA || 'missing',
            mintB: nativeMintB || 'missing',
            accountA: nativeAccountA || 'missing',
            accountB: nativeAccountB || 'missing',
          },
          // Canonical ordering (may be swapped)
          canonical: {
            mintA: poolMintA || 'missing',
            mintB: poolMintB || 'missing',
            accountA: poolAccountA || 'missing',
            accountB: poolAccountB || 'missing',
          },
          wasSwapped: (stat as any)?.was_swapped ?? 'unknown',
          hopVaultA: hop.vaultA || 'missing',
          hopVaultB: hop.vaultB || 'missing',
          selectedVaultA: orcaVaultA,
          selectedVaultB: orcaVaultB,
          tickArrays: {
            source: tickArraySource,
            known: {
              center: knownCenter?.slice(0, 8) || 'missing',
              lower: knownLower?.slice(0, 8) || 'missing',
              upper: knownUpper?.slice(0, 8) || 'missing',
            },
            used: [
              tickArray0?.slice(0, 8) || 'missing',
              tickArray1?.slice(0, 8) || 'missing',
              tickArray2?.slice(0, 8) || 'missing',
            ],
            array2IsDuplicate: tickArray2 === tickArray1,
          },
          oracle: hop.oracle || 'missing',
          userTokenA: userTokenA.toBase58(),
          userTokenB: userTokenB.toBase58(),
          isAtoB: isAtoBOrca,
          isAtoBSource: isAtoBDeterminedBy,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
        });
        
        // CRITICAL: Validate tick arrays exist before building instruction
        {
          const missingTickArrays: string[] = [];
          if (!tickArray0) missingTickArrays.push('center (array0)');
          if (!tickArray1) missingTickArrays.push(isAtoBOrca ? 'lower (array1)' : 'upper (array1)');
          // tickArray2 can be a duplicate of tickArray1, so only fail if tickArray1 is also missing
          if (!tickArray2 && !tickArray1) missingTickArrays.push('array2');
          
          if (missingTickArrays.length > 0) {
            throw new Error(
              `ORCA_TICK_ARRAYS_MISSING: Pool ${hop.poolId} missing tick arrays [${missingTickArrays.join(', ')}]. ` +
              `Pool needs validation. The reactive cacheValidator should populate these automatically.`
            );
          }
          
          // CRITICAL: Check for duplicate tick arrays - causes "already mutably borrowed" panic
          // Orca tries to borrow all tick arrays. If center === array1, this causes BorrowError.
          // Note: array2 can equal array1 safely (we use fallback), but center must be unique.
          if (tickArray0 === tickArray1) {
            logger.warn('routerTx.orca.duplicate_tick_arrays', {
              cat: 'tx',
              poolId: hop.poolId,
              center: tickArray0?.slice(0, 8) + '…',
              array1: tickArray1?.slice(0, 8) + '…',
              isAtoB: isAtoBOrca,
              hint: 'Center and array1 are same (pool at boundary?). Skipping to avoid BorrowError.',
            });
            throw new Error(
              `ORCA_DUPLICATE_TICK_ARRAYS: Pool ${hop.poolId} has center === array1. ` +
              `This causes BorrowError on-chain. Pool may be at tick array boundary.`
            );
          }
        }
        
        if (orcaNeedsSwapV2) {
          // swapV2: Token-2022 compatible (15 accounts)
          // Account layout matches Orca SDK's swapV2Ix
          accounts.push(
            orcaTokenProgramA,                                                 // 0: Token Program A
            orcaTokenProgramB,                                                 // 1: Token Program B
            MEMO_PROGRAM_ID,                                                   // 2: Memo Program (REQUIRED!)
            wallet,                                                            // 3: Token Authority (signer)
            poolId,                                                            // 4: Whirlpool
            orcaMintA,                                                         // 5: Token Mint A
            orcaMintB,                                                         // 6: Token Mint B
            userTokenA,                                                        // 7: Token Owner Account A
            new PublicKey(orcaVaultA),                                         // 8: Token Vault A (native)
            userTokenB,                                                        // 9: Token Owner Account B
            new PublicKey(orcaVaultB),                                         // 10: Token Vault B (native)
            new PublicKey(tickArray0),                                         // 11: Tick Array 0
            new PublicKey(tickArray1),                                         // 12: Tick Array 1
            new PublicKey(tickArray2 || tickArray1),                           // 13: Tick Array 2 (fallback to array1)
            hop.oracle ? new PublicKey(hop.oracle) : poolId,                   // 14: Oracle (can fallback - separate account)
            programIdKey,                                                      // 15: Whirlpool Program (for CPI)
          );
        } else {
          // swap: Standard SPL tokens (12 accounts)
          accounts.push(
            TOKEN_PROGRAM_ID,                                                  // 0: Token Program
            wallet,                                                            // 1: Token Authority (signer)
            poolId,                                                            // 2: Whirlpool
            userTokenA,                                                        // 3: Token Owner Account A
            new PublicKey(orcaVaultA),                                         // 4: Token Vault A (native)
            userTokenB,                                                        // 5: Token Owner Account B
            new PublicKey(orcaVaultB),                                         // 6: Token Vault B (native)
            new PublicKey(tickArray0),                                         // 7: Tick Array 0
            new PublicKey(tickArray1),                                         // 8: Tick Array 1
            new PublicKey(tickArray2 || tickArray1),                           // 9: Tick Array 2 (fallback to array1)
            hop.oracle ? new PublicKey(hop.oracle) : poolId,                   // 10: Oracle (can fallback - separate account)
            programIdKey,                                                      // 11: Whirlpool Program
          );
        }
        // CRITICAL: Return early for Orca to avoid truncation by getAccountsNeededForDex
        // which only returns 12 (swap), but swapV2 needs 16 accounts
        return accounts;

      case DexType.PumpSwap:
        // PumpSwap AMM: 23 accounts (matching official @pump-fun/pump-swap-sdk IDL)
        // Account order:
        // 0: pool, 1: user, 2: global_config, 3: base_mint, 4: quote_mint,
        // 5: user_base_token_account, 6: user_quote_token_account,
        // 7: pool_base_token_account, 8: pool_quote_token_account,
        // 9: protocol_fee_recipient, 10: protocol_fee_recipient_token_account,
        // 11: base_token_program, 12: quote_token_program, 13: system_program,
        // 14: associated_token_program, 15: event_authority, 16: program,
        // 17: coin_creator_vault_ata, 18: coin_creator_vault_authority,
        // 19: global_volume_accumulator, 20: user_volume_accumulator,
        // 21: fee_config, 22: fee_program
        
        // Get pool data from cache - CRITICAL: Use native (on-chain) order, NOT canonical order!
        // PumpSwap pools have fixed base/quote ordering that may differ from canonical alphabetical order
        // native_mint_a/native_mint_b contain the on-chain order, mint_a/mint_b are canonicalized
        const pumpBaseMint = stat?.onchain_base_mint || stat?.native_mint_a || hop.inputMint;
        const pumpQuoteMint = stat?.onchain_quote_mint || stat?.native_mint_b || hop.outputMint;
        const pumpPoolBaseVault = stat?.onchain_base_vault || stat?.native_account_a || hop.vaultA;
        const pumpPoolQuoteVault = stat?.onchain_quote_vault || stat?.native_account_b || hop.vaultB;
        // Check multiple field names for coinCreator from cache
        let pumpCoinCreator = stat?.creator || (stat as any)?.onchain_creator || (stat as any)?.coin_creator || stat?.metadata_creator || (hop as any).coinCreator;
        
        // Determine token programs
        const pumpBaseTokenProgram = hop.inputMint === pumpBaseMint
          ? (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)
          : (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
        const pumpQuoteTokenProgram = hop.inputMint === pumpQuoteMint
          ? (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)
          : (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
        
        // User token accounts (base and quote ATAs)
        const pumpUserBaseAta = getAssociatedTokenAddressSync(
          new PublicKey(pumpBaseMint),
          wallet,
          true,
          pumpBaseTokenProgram
        );
        const pumpUserQuoteAta = getAssociatedTokenAddressSync(
          new PublicKey(pumpQuoteMint),
          wallet,
          true,
          pumpQuoteTokenProgram
        );
        
        // Initialize SDK for PumpSwap account fetching
        const connection = await getConnection();
        const pumpSdk = new OnlinePumpAmmSdk(connection);
        
        // Fetch globalConfig to get valid protocol fee recipients
        let pumpProtocolFeeRecipient: PublicKey;
        try {
          const globalConfigData = await withRpcLimit(
            () => pumpSdk.fetchGlobalConfigAccount(),
            1,
            { module: 'routerTx', method: 'pumpswap.fetchGlobalConfig' }
          );
          
          if (globalConfigData.protocolFeeRecipients && globalConfigData.protocolFeeRecipients.length > 0) {
            // Pick a random valid fee recipient from globalConfig
            pumpProtocolFeeRecipient = globalConfigData.protocolFeeRecipients[
              Math.floor(Math.random() * globalConfigData.protocolFeeRecipients.length)
            ];
            logger.debug('routerTx.pumpswap.protocolFeeRecipient.fetched', {
              cat: 'tx',
              recipient: pumpProtocolFeeRecipient.toBase58(),
              totalRecipients: globalConfigData.protocolFeeRecipients.length,
              source: 'globalConfig',
            });
          } else {
            throw new Error('No protocol fee recipients in globalConfig');
          }
        } catch (configErr) {
          // Fallback to cached/hop value if fetch fails
          logger.warn('routerTx.pumpswap.globalConfig.fetchFailed', {
            cat: 'tx',
            error: (configErr as Error).message,
            poolId: hop.poolId,
          });
          pumpProtocolFeeRecipient = (hop as any).protocolFeeRecipient
            ? new PublicKey((hop as any).protocolFeeRecipient)
            : stat?.protocol_fee_recipient
              ? new PublicKey(stat.protocol_fee_recipient)
              : new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'); // Known valid fallback
        }
        
        // Protocol fee recipient's quote token account (ATA)
        const pumpProtocolFeeRecipientAta = getAssociatedTokenAddressSync(
          new PublicKey(pumpQuoteMint),
          pumpProtocolFeeRecipient,
          true,
          pumpQuoteTokenProgram
        );
        
        // Use SDK's pre-computed PDAs for global_config and event_authority
        const pumpGlobalConfig = (hop as any).globalConfig 
          ? new PublicKey((hop as any).globalConfig)
          : PUMPSWAP_GLOBAL_CONFIG;
        const pumpEventAuthority = PUMPSWAP_EVENT_AUTHORITY;
        
        // Coin creator vault derivation using SDK functions
        // CRITICAL: coinCreator must come from pool.coin_creator, NOT from poolId!
        let pumpCoinCreatorVaultAuthority: PublicKey;
        let pumpCoinCreatorVaultAta: PublicKey;
        
        // If coinCreator not in cache, fetch it from the pool account using SDK
        if (!pumpCoinCreator || pumpCoinCreator === SystemProgram.programId.toBase58()) {
          try {
            // Use SDK to fetch and decode pool account - this properly extracts coinCreator
            const poolData = await withRpcLimit(
              () => pumpSdk.fetchPool(poolId),
              1,
              { module: 'routerTx', method: 'pumpswap.fetchPool' }
            );
            
            if (poolData && poolData.coinCreator) {
              pumpCoinCreator = poolData.coinCreator.toBase58();
              
              logger.debug('routerTx.pumpswap.coinCreator.fetched', {
                cat: 'tx',
                poolId: hop.poolId,
                coinCreator: pumpCoinCreator,
                source: 'sdk',
              });
            }
          } catch (fetchErr) {
            logger.warn('routerTx.pumpswap.coinCreator.fetchFailed', {
              cat: 'tx',
              error: (fetchErr as Error).message,
              poolId: hop.poolId,
            });
          }
        }
        
        // Always derive PDAs from coinCreator, even if it's System Program (default/no creator)
        // The SDK always derives PDAs - we can't pass System Program directly as writable
        const coinCreatorPubkey = pumpCoinCreator 
          ? new PublicKey(pumpCoinCreator) 
          : SystemProgram.programId;
        
        if (coinCreatorPubkey.equals(SystemProgram.programId)) {
          logger.debug('routerTx.pumpswap.coinCreator.systemProgram', {
            cat: 'tx',
            poolId: hop.poolId,
            msg: 'Pool has no coinCreator set (System Program), deriving PDAs from System Program seed',
          });
        }
        
        // Derive vault authority PDA from coinCreator (even if System Program)
        pumpCoinCreatorVaultAuthority = derivePumpswapCoinCreatorVault(coinCreatorPubkey);
        pumpCoinCreatorVaultAta = derivePumpswapCoinCreatorVaultAta(
          pumpCoinCreatorVaultAuthority,
          new PublicKey(pumpQuoteMint),
          pumpQuoteTokenProgram
        );
        
        // Derive user volume accumulator PDA (for volume tracking rewards)
        const pumpUserVolumeAccumulator = derivePumpswapUserVolumeAccumulator(wallet);
        
        // Determine if this is a buy or sell operation
        // Buy: inputMint == SOL (quote), needs 23 accounts (SOL -> Token)
        // Sell: inputMint == Token (base), needs 21 accounts (Token -> SOL)
        // CRITICAL: Don't rely on pumpQuoteMint fallback which may be incorrect
        // PumpSwap quoteMint is ALWAYS WSOL, so check directly against SOL mint
        const isPumpswapBuy = hop.inputMint === SOL_MINT;
        
        // Log accounts for debugging
        logger.debug('routerTx.pumpswap.accounts.v3', {
          cat: 'tx',
          poolId: hop.poolId,
          baseMint: pumpBaseMint,
          quoteMint: pumpQuoteMint,
          poolBaseVault: pumpPoolBaseVault,
          poolQuoteVault: pumpPoolQuoteVault,
          userBaseAta: pumpUserBaseAta.toBase58(),
          userQuoteAta: pumpUserQuoteAta.toBase58(),
          protocolFeeRecipient: pumpProtocolFeeRecipient.toBase58(),
          coinCreator: pumpCoinCreator || 'missing',
          coinCreatorVaultAuthority: pumpCoinCreatorVaultAuthority.toBase58(),
          globalConfig: pumpGlobalConfig.toBase58(),
          eventAuthority: pumpEventAuthority.toBase58(),
          globalVolumeAccumulator: PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR.toBase58(),
          userVolumeAccumulator: pumpUserVolumeAccumulator.toBase58(),
          feeConfig: PUMPSWAP_FEE_CONFIG.toBase58(),
          feeProgram: PUMPSWAP_FEE_PROGRAM.toBase58(),
          isPumpswapBuy,
        });
        
        // Push accounts in order matching SDK IDL
        // Buy: 23 accounts (includes volume accumulators at positions 19-20)
        // Sell: 21 accounts (no volume accumulators, fee_config at 19, fee_program at 20)
        accounts.push(
          poolId,                                                              // 0: pool
          wallet,                                                              // 1: user (signer)
          pumpGlobalConfig,                                                    // 2: global_config
          new PublicKey(pumpBaseMint),                                         // 3: base_mint
          new PublicKey(pumpQuoteMint),                                        // 4: quote_mint
          pumpUserBaseAta,                                                     // 5: user_base_token_account
          pumpUserQuoteAta,                                                    // 6: user_quote_token_account
          new PublicKey(pumpPoolBaseVault),                                    // 7: pool_base_token_account
          new PublicKey(pumpPoolQuoteVault),                                   // 8: pool_quote_token_account
          pumpProtocolFeeRecipient,                                            // 9: protocol_fee_recipient
          pumpProtocolFeeRecipientAta,                                         // 10: protocol_fee_recipient_token_account
          pumpBaseTokenProgram,                                                // 11: base_token_program
          pumpQuoteTokenProgram,                                               // 12: quote_token_program
          SystemProgram.programId,                                             // 13: system_program
          ASSOCIATED_TOKEN_PROGRAM_ID,                                         // 14: associated_token_program
          pumpEventAuthority,                                                  // 15: event_authority
          PUMPSWAP_PROGRAM,                                                    // 16: program
          pumpCoinCreatorVaultAta,                                             // 17: coin_creator_vault_ata
          pumpCoinCreatorVaultAuthority,                                       // 18: coin_creator_vault_authority
        );
        
        if (isPumpswapBuy) {
          // Buy instruction: 23 accounts (includes volume accumulators)
          accounts.push(
            PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR,                                // 19: global_volume_accumulator
            pumpUserVolumeAccumulator,                                         // 20: user_volume_accumulator
            PUMPSWAP_FEE_CONFIG,                                               // 21: fee_config
            PUMPSWAP_FEE_PROGRAM,                                              // 22: fee_program
          );
        } else {
          // Sell instruction: 21 accounts (no volume accumulators)
          accounts.push(
            PUMPSWAP_FEE_CONFIG,                                               // 19: fee_config
            PUMPSWAP_FEE_PROGRAM,                                              // 20: fee_program
          );
        }
        break;

      case DexType.RaydiumAmm:
        // Raydium AMM v4: 18 accounts
        // 0: TokenProgram, 1: AMM, 2: Authority, 3: OpenOrders, 4: TargetOrders,
        // 5: CoinVault, 6: PCVault, 7: SerumProgram, 8: Market, 9: Bids, 10: Asks,
        // 11: EventQ, 12: SerumCoinVault, 13: SerumPCVault, 14: VaultSigner,
        // 15: UserSource, 16: UserDest, 17: User, 18: Program
        const raydiumAmmAuthority = (hop as any).ammAuthority || stat?.authority || stat?.amm_authority;
        const openOrders = (hop as any).openOrders || stat?.open_orders || stat?.amm_open_orders;
        const targetOrders = (hop as any).targetOrders || stat?.target_orders || stat?.amm_target_orders;
        const serumProgramId = hop.serumProgramId || stat?.market_program_id;
        const serumMarket = hop.market || stat?.market_id || stat?.market;
        
        // Serum market accounts (if available in cache or hop)
        const serumBids = (hop as any).serumBids || stat?.serum_bids;
        const serumAsks = (hop as any).serumAsks || stat?.serum_asks;
        const serumEventQueue = (hop as any).serumEventQueue || stat?.serum_event_queue;
        const serumCoinVault = (hop as any).serumCoinVault || stat?.serum_coin_vault;
        const serumPcVault = (hop as any).serumPcVault || stat?.serum_pc_vault;
        const serumVaultSigner = (hop as any).serumVaultSigner || stat?.serum_vault_signer;
        
        logger.debug('routerTx.raydiumAmm.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          authority: raydiumAmmAuthority,
          openOrders,
          targetOrders,
          serumMarket,
          hasSerumAccounts: !!(serumBids && serumAsks && serumEventQueue),
        });

        accounts.push(
          TOKEN_PROGRAM_ID,                                                    // 0: Token Program
          poolId,                                                              // 1: AMM ID
          raydiumAmmAuthority ? new PublicKey(raydiumAmmAuthority) : poolId,  // 2: AMM Authority
          openOrders ? new PublicKey(openOrders) : poolId,                    // 3: Open Orders
          targetOrders ? new PublicKey(targetOrders) : poolId,                // 4: Target Orders
          new PublicKey(hop.vaultA || poolAccountA),                          // 5: Coin Vault
          new PublicKey(hop.vaultB || poolAccountB),                          // 6: PC Vault
          serumProgramId ? new PublicKey(serumProgramId) : programIdKey,      // 7: Serum Program
          serumMarket ? new PublicKey(serumMarket) : poolId,                  // 8: Serum Market
          serumBids ? new PublicKey(serumBids) : poolId,                      // 9: Serum Bids
          serumAsks ? new PublicKey(serumAsks) : poolId,                      // 10: Serum Asks
          serumEventQueue ? new PublicKey(serumEventQueue) : poolId,          // 11: Event Queue
          serumCoinVault ? new PublicKey(serumCoinVault) : poolId,            // 12: Serum Coin Vault
          serumPcVault ? new PublicKey(serumPcVault) : poolId,                // 13: Serum PC Vault
          serumVaultSigner ? new PublicKey(serumVaultSigner) : poolId,        // 14: Vault Signer
          userSourceAta,                                                       // 15: User Source
          userDestAta,                                                         // 16: User Dest
          wallet,                                                              // 17: User (signer)
          programIdKey,                                                        // 18: Program
        );
        break;

      case DexType.MeteoraDAMM:
        // Meteora DAMM v1 uses Mercurial Vaults ("vault of vaults" architecture)
        // v1: 16 accounts total, v2: 14 accounts (swap2 layout from SDK)
        // CRITICAL: Mints and Vaults must be in POOL CANONICAL ORDER (A/B), not swap direction!
        const isV2 = hop.variant === 'damm_v2';
        
        if (isV2) {
          // v2 (CP-AMM) swap2 account layout (14 accounts) - matches @meteora-ag/cp-amm-sdk
          // Fixed pool authority from SDK IDL
          const METEORA_CPAMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
          
          // CRITICAL: Use NATIVE ordering for DAMM v2 - the on-chain program validates against
          // pool's stored order using has_one constraints, NOT canonical order.
          // When was_swapped=true, canonical order is reversed from native on-chain order.
          const wasSwapped = stat?.was_swapped === true;
          
          // Prefer native fields, fallback to canonical (with swap correction if needed)
          const dammV2MintA = stat?.native_mint_a 
            ? new PublicKey(stat.native_mint_a) 
            : (poolMintA ? new PublicKey(poolMintA) : inputMint);
          const dammV2MintB = stat?.native_mint_b 
            ? new PublicKey(stat.native_mint_b) 
            : (poolMintB ? new PublicKey(poolMintB) : outputMint);
          const dammV2VaultA = stat?.native_account_a || hop.vaultA || poolAccountA;
          const dammV2VaultB = stat?.native_account_b || hop.vaultB || poolAccountB;
          
          // Determine token programs for each token (support Token-2022)
          // Token programs must also be in NATIVE order to match vault mints
          // When was_swapped=true, canonical token_program_a corresponds to native token_program_b
          // If token_program not cached, detect from mint owner via getTokenMeta
          let tokenProgramA: PublicKey;
          let tokenProgramB: PublicKey;
          
          // Get cached token programs (respecting native ordering)
          const cachedProgramA = wasSwapped ? stat?.token_program_b : stat?.token_program_a;
          const cachedProgramB = wasSwapped ? stat?.token_program_a : stat?.token_program_b;
          
          if (cachedProgramA) {
            tokenProgramA = tokenProgramLabelToKey(cachedProgramA);
          } else {
            // Detect from mint owner - getTokenMeta checks if mint is owned by Token-2022 program
            const mintAStr = dammV2MintA.toBase58();
            const metaA = await getTokenMeta(mintAStr);
            tokenProgramA = metaA.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            logger.debug('routerTx.meteoraDamm.v2.tokenProgramA.detected', {
              cat: 'tx',
              mint: mintAStr.slice(0, 8) + '...',
              program: metaA.program,
            });
          }
          
          if (cachedProgramB) {
            tokenProgramB = tokenProgramLabelToKey(cachedProgramB);
          } else {
            // Detect from mint owner - getTokenMeta checks if mint is owned by Token-2022 program
            const mintBStr = dammV2MintB.toBase58();
            const metaB = await getTokenMeta(mintBStr);
            tokenProgramB = metaB.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            logger.debug('routerTx.meteoraDamm.v2.tokenProgramB.detected', {
              cat: 'tx',
              mint: mintBStr.slice(0, 8) + '...',
              program: metaB.program,
            });
          }
          
          // Derive Event Authority PDA: seeds = ["__event_authority"]
          const [eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            programIdKey
          );
          
          logger.debug('routerTx.meteoraDamm.v2.accounts', {
            cat: 'tx',
            poolId: hop.poolId,
            variant: 'damm_v2',
            wasSwapped,
            nativeMintA: stat?.native_mint_a || 'missing',
            nativeMintB: stat?.native_mint_b || 'missing',
            nativeAccountA: stat?.native_account_a || 'missing',
            nativeAccountB: stat?.native_account_b || 'missing',
            vaultA: dammV2VaultA || 'missing',
            vaultB: dammV2VaultB || 'missing',
            eventAuthority: eventAuthority.toBase58(),
          });
          
          accounts.push(
            METEORA_CPAMM_POOL_AUTHORITY,                                     // 0: Pool Authority (fixed global)
            poolId,                                                            // 1: Pool
            userSourceAta,                                                     // 2: Input Token Account
            userDestAta,                                                       // 3: Output Token Account
            new PublicKey(dammV2VaultA),                                      // 4: Token A Vault (NATIVE order)
            new PublicKey(dammV2VaultB),                                      // 5: Token B Vault (NATIVE order)
            dammV2MintA,                                                       // 6: Token A Mint (NATIVE order)
            dammV2MintB,                                                       // 7: Token B Mint (NATIVE order)
            wallet,                                                            // 8: Payer (signer)
            tokenProgramA,                                                     // 9: Token A Program (NATIVE order)
            tokenProgramB,                                                     // 10: Token B Program (NATIVE order)
            programIdKey,                                                      // 11: Referral Token Account (program ID = "None" sentinel)
            eventAuthority,                                                    // 12: Event Authority (PDA)
            programIdKey,                                                      // 13: Program (for CPI)
          );
        } else {
          // v1 (Dynamic AMM) account layout - 16 accounts with Mercurial Vault architecture
          // Matches the Meteora Dynamic AMM IDL swap instruction:
          // 0:  pool
          // 1:  userSourceToken
          // 2:  userDestinationToken
          // 3:  aVault (Mercurial Vault account)
          // 4:  bVault (Mercurial Vault account)
          // 5:  aTokenVault (SPL Token account inside aVault)
          // 6:  bTokenVault (SPL Token account inside bVault)
          // 7:  aVaultLpMint (LP token mint of vault A)
          // 8:  bVaultLpMint (LP token mint of vault B)
          // 9:  aVaultLp (Pool's LP token account for vault A)
          // 10: bVaultLp (Pool's LP token account for vault B)
          // 11: protocolTokenFee (direction-dependent)
          // 12: user (signer)
          // 13: vaultProgram (Mercurial Vault program)
          // 14: tokenProgram
          // 15: DAMM Program (for CPI)
          
          // Get SDK-provided accounts (from getMeteoraDammV1SdkQuote)
          const aVault = (hop as any).aVault;
          const bVault = (hop as any).bVault;
          const aTokenVault = (hop as any).aTokenVault;
          const bTokenVault = (hop as any).bTokenVault;
          const aVaultLpMint = (hop as any).aVaultLpMint;
          const bVaultLpMint = (hop as any).bVaultLpMint;
          const aVaultLp = (hop as any).aVaultLp;
          const bVaultLp = (hop as any).bVaultLp;
          const protocolTokenAFee = (hop as any).protocolTokenAFee;
          const protocolTokenBFee = (hop as any).protocolTokenBFee;
          const vaultProgram = (hop as any).vaultProgram || '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
          
          // Select protocol fee based on swap direction (INPUT token's fee account)
          // A→B swap: input is A → use protocolTokenAFee
          // B→A swap: input is B → use protocolTokenBFee
          const isAtoB = opts?.aToB ?? (hop.inputMint === poolMintA);
          const protocolTokenFee = isAtoB ? protocolTokenAFee : protocolTokenBFee;
          
          // Verify we have all required accounts
          const missingAccounts: string[] = [];
          if (!aVault) missingAccounts.push('aVault');
          if (!bVault) missingAccounts.push('bVault');
          if (!aTokenVault) missingAccounts.push('aTokenVault');
          if (!bTokenVault) missingAccounts.push('bTokenVault');
          if (!aVaultLpMint) missingAccounts.push('aVaultLpMint');
          if (!bVaultLpMint) missingAccounts.push('bVaultLpMint');
          if (!aVaultLp) missingAccounts.push('aVaultLp');
          if (!bVaultLp) missingAccounts.push('bVaultLp');
          if (!protocolTokenFee) missingAccounts.push('protocolTokenFee');
          
          // Get remaining accounts for depeg/stable pools
          const remainingAccounts = (hop as any).remainingAccounts as string[] | undefined;
          
          logger.debug('routerTx.meteoraDamm.v1.accounts', {
            cat: 'tx',
            poolId: hop.poolId,
            variant: 'damm_v1',
            isAtoB,
            inputMint: hop.inputMint,
            outputMint: hop.outputMint,
            aVault: aVault || 'missing',
            bVault: bVault || 'missing',
            aTokenVault: aTokenVault || 'missing',
            bTokenVault: bTokenVault || 'missing',
            aVaultLpMint: aVaultLpMint || 'missing',
            bVaultLpMint: bVaultLpMint || 'missing',
            aVaultLp: aVaultLp || 'missing',
            bVaultLp: bVaultLp || 'missing',
            protocolTokenFee: protocolTokenFee || 'missing',
            vaultProgram,
            missingCount: missingAccounts.length,
            missing: missingAccounts.length > 0 ? missingAccounts : undefined,
            remainingAccountsCount: remainingAccounts?.length || 0,
            remainingAccounts: remainingAccounts,
          });
          
          if (missingAccounts.length > 0) {
            throw new Error(`Meteora DAMM v1: Missing required accounts: ${missingAccounts.join(', ')}. SDK quote may have failed.`);
          }
          
          // Account order MUST match Meteora Dynamic AMM IDL swap instruction
          // See: @meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/idl.d.ts lines 687-807
          accounts.push(
            poolId,                                                            // 0: pool
            userSourceAta,                                                     // 1: userSourceToken
            userDestAta,                                                       // 2: userDestinationToken
            new PublicKey(aVault),                                            // 3: aVault (Mercurial Vault)
            new PublicKey(bVault),                                            // 4: bVault (Mercurial Vault)
            new PublicKey(aTokenVault),                                       // 5: aTokenVault (SPL Token in vault)
            new PublicKey(bTokenVault),                                       // 6: bTokenVault (SPL Token in vault)
            new PublicKey(aVaultLpMint),                                      // 7: aVaultLpMint
            new PublicKey(bVaultLpMint),                                      // 8: bVaultLpMint
            new PublicKey(aVaultLp),                                          // 9: aVaultLp (Pool's LP for vault A)
            new PublicKey(bVaultLp),                                          // 10: bVaultLp (Pool's LP for vault B)
            new PublicKey(protocolTokenFee),                                  // 11: protocolTokenFee
            wallet,                                                            // 12: user (signer)
            new PublicKey(vaultProgram),                                      // 13: vaultProgram
            TOKEN_PROGRAM_ID,                                                  // 14: tokenProgram
            programIdKey,                                                      // 15: DAMM Program (CPI target)
          );
          
          // Add remaining accounts for depeg/stable pools (after the program ID)
          // These are required for stable swap pools with depeg types (marinade, lido, splStake)
          if (remainingAccounts && remainingAccounts.length > 0) {
            for (const acc of remainingAccounts) {
              accounts.push(new PublicKey(acc));
            }
            logger.debug('routerTx.meteoraDamm.v1.remainingAccounts.added', {
              cat: 'tx',
              poolId: hop.poolId.slice(0, 8) + '...',
              count: remainingAccounts.length,
              totalAccounts: accounts.length,
            });
          }
        }
        break;

      case DexType.RaydiumCpmm:
        // Raydium CPMM: 14 accounts
        // 0: Payer (signer), 1: Authority (PDA), 2: AmmConfig, 3: PoolState,
        // 4: UserInputAta, 5: UserOutputAta, 6: InputVault, 7: OutputVault,
        // 8: InputTokenProgram, 9: OutputTokenProgram, 10: InputMint, 11: OutputMint,
        // 12: ObservationState, 13: CPMM Program
        const cpmmAmmConfig = (hop as any).ammConfig || stat?.amm_config;
        const cpmmObservation = hop.observationId || (hop as any).observation_key || stat?.observation_key;
        
        // Derive CPMM authority PDA
        const cpmmAuthority = PublicKey.findProgramAddressSync(
          [Buffer.from('vault_and_lp_mint_auth_seed')],
          programIdKey
        )[0];
        
        // Determine input/output token programs
        const cpmmInputTokenProgram = (hop as any).tokenProgramIn === 'token-2022' 
          ? TOKEN_2022_PROGRAM_ID 
          : TOKEN_PROGRAM_ID;
        const cpmmOutputTokenProgram = (hop as any).tokenProgramOut === 'token-2022'
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
        
        logger.debug('routerTx.raydiumCpmm.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          ammConfig: cpmmAmmConfig,
          observation: cpmmObservation,
          authority: cpmmAuthority.toBase58(),
          vaultA: hop.vaultA,
          vaultB: hop.vaultB,
        });

        if (!cpmmAmmConfig) {
          logger.warn('routerTx.raydiumCpmm.missing_amm_config', {
            cat: 'tx',
            poolId: hop.poolId,
          });
        }
        if (!cpmmObservation) {
          logger.warn('routerTx.raydiumCpmm.missing_observation', {
            cat: 'tx',
            poolId: hop.poolId,
          });
        }

        // CRITICAL: Direction-aware vault selection (same pattern as CLMM)
        // Raydium CPMM passes input_vault and output_vault based on swap direction
        // native_account_a is paired with native_mint_a, native_account_b with native_mint_b
        // Select vault based on which native mint matches input/output
        const cpmmInputIsNativeA = nativeMintA
          ? (hop.inputMint === nativeMintA)
          : (hop.inputMint === poolMintA);
        const cpmmOutputIsNativeA = nativeMintA
          ? (hop.outputMint === nativeMintA)
          : (hop.outputMint === poolMintA);

        const cpmmInputVault = cpmmInputIsNativeA
          ? (nativeAccountA || hop.vaultA || poolAccountA || hop.poolId)
          : (nativeAccountB || hop.vaultB || poolAccountB || hop.poolId);
        const cpmmOutputVault = cpmmOutputIsNativeA
          ? (nativeAccountA || hop.vaultA || poolAccountA || hop.poolId)
          : (nativeAccountB || hop.vaultB || poolAccountB || hop.poolId);

        logger.debug('routerTx.raydiumCpmm.vaultSelection', {
          cat: 'tx',
          poolId: hop.poolId,
          inputMint: hop.inputMint.slice(0, 8) + '...',
          outputMint: hop.outputMint.slice(0, 8) + '...',
          cpmmInputIsNativeA,
          cpmmOutputIsNativeA,
          cpmmInputVault,
          cpmmOutputVault,
          nativeMintA: nativeMintA || 'missing',
          nativeAccountA: nativeAccountA || 'missing',
          nativeAccountB: nativeAccountB || 'missing',
        });

        accounts.push(
          wallet,                                                              // 0: Payer (signer)
          cpmmAuthority,                                                       // 1: Authority (PDA)
          new PublicKey(cpmmAmmConfig || poolId),                             // 2: AMM Config
          poolId,                                                              // 3: Pool State
          userSourceAta,                                                       // 4: User Input Token Account
          userDestAta,                                                         // 5: User Output Token Account
          new PublicKey(cpmmInputVault),                                       // 6: Input Vault (direction-aware)
          new PublicKey(cpmmOutputVault),                                      // 7: Output Vault (direction-aware)
          cpmmInputTokenProgram,                                               // 8: Input Token Program
          cpmmOutputTokenProgram,                                              // 9: Output Token Program
          inputMint,                                                           // 10: Input Mint
          outputMint,                                                          // 11: Output Mint
          new PublicKey(cpmmObservation || poolId),                           // 12: Observation State
          programIdKey,                                                        // 13: CPMM Program
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

  // Ensure we have the expected number of accounts for fixed-size DEXes.
  // NOTE: Meteora DLMM can be variable-length (bin arrays), which is supported by `route_swap`.
  // In that mode, we only enforce MIN size (pad) but do not truncate.
  const expected = getAccountsNeededForDex(dexType);
  if (dexType === DexType.Meteora && opts?.allowVariableAccounts) {
    while (accounts.length < expected) {
      // Prefer padding with a valid bin array if we have one, otherwise fall back to pool ID.
      // Bin arrays start at index 16 (after 16 fixed accounts: 0-15)
      const pad = accounts.length > 16 ? accounts[accounts.length - 1] : new PublicKey(hop.poolId.replace(/[#-]rev$/, ''));
      accounts.push(pad);
    }
    return accounts;
  }

  // CRITICAL: For MeteoraDAMM, don't pad - the on-chain router detects v1 vs v2 by account count
  // v1 = 16 accounts (Mercurial Vaults), v2 = 14 accounts (CP-AMM swap2)
  if (dexType === DexType.MeteoraDAMM) {
    return accounts;
  }

  while (accounts.length < expected) {
    // Pad with pool ID as placeholder
    accounts.push(new PublicKey(hop.poolId.replace(/[#-]rev$/, '')));
  }

  return accounts.slice(0, expected);
}

// ============================================================================
// PDA Derivation Helpers
// ============================================================================

/**
 * Derive Meteora DLMM Event Authority PDA
 */
function deriveMeteoraDlmmEventAuthority(): PublicKey {
  const [eventAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    METEORA_DLMM_PROGRAM
  );
  return eventAuth;
}

/**
 * Derive PumpSwap Associated Bonding Curve (ATA for bonding curve)
 * CRITICAL: Must use the correct token program based on whether mint is Token-2022 or SPL
 * @param bondingCurve The bonding curve (pool) address
 * @param mint The pump.fun token mint
 * @param tokenProgram Optional token program override (defaults to SPL Token)
 */
function derivePumpswapAssociatedBondingCurve(
  bondingCurve: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const [assocBC] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return assocBC;
}

/**
 * Derive Meteora DAMM Pool Authority PDA
 * v1 uses "vault_and_lp_mint_auth_pda", v2 uses "pool_authority"
 */
function deriveMeteoraDAMMPoolAuthority(pool: PublicKey, programId: PublicKey, isV2: boolean): PublicKey {
  const seed = isV2 ? 'pool_authority' : 'vault_and_lp_mint_auth_pda';
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from(seed), pool.toBuffer()],
    programId
  );
  return authority;
}

/**
 * Derive Raydium AMM v4 Authority PDA
 * Seeds: [AMM_ID bytes, "amm authority"]
 */
function deriveRaydiumAmmAuthority(ammId: PublicKey, programId: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [ammId.toBuffer(), Buffer.from('amm authority')],
    programId
  );
  return authority;
}

// ============================================================================
// Tick/Bin Array Derivation Helpers
// ============================================================================

/**
 * Derive Orca Whirlpool tick array PDAs from current tick and tick spacing
 */
function deriveOrcaTickArrays(
  poolId: PublicKey,
  currentTickIndex: number,
  tickSpacing: number
): { lower: PublicKey; center: PublicKey; upper: PublicKey } {
  const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const realIndex = Math.floor(currentTickIndex / ticksInArray);
  
  const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
    // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
      ORCA_WHIRLPOOL_PROGRAM
    );
    return pda;
  };
  
  return {
    lower: deriveTickArrayPda((realIndex - 1) * ticksInArray),
    center: deriveTickArrayPda(realIndex * ticksInArray),
    upper: deriveTickArrayPda((realIndex + 1) * ticksInArray),
  };
}

/**
 * Derive Orca Whirlpool tick arrays in the EXACT order expected by the Whirlpool swap instruction.
 *
 * Whirlpool swap expects:
 * - tick_array_0: the array containing the current tick
 * - tick_array_1: the next array in the swap direction
 * - tick_array_2: the next-next array in the swap direction
 *
 * A->B traverses ticks downward: offsets [0, -1, -2]
 * B->A traverses ticks upward:   offsets [0, +1, +2]
 */
function deriveOrcaTickArraysForSwap(
  poolId: PublicKey,
  currentTickIndex: number,
  tickSpacing: number,
  aToB: boolean
): { tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey } {
  const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const realIndex = Math.floor(currentTickIndex / ticksInArray);

  const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
    // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
      ORCA_WHIRLPOOL_PROGRAM
    );
    return pda;
  };

  const idx0 = realIndex;
  const idx1 = realIndex + (aToB ? -1 : 1);
  const idx2 = realIndex + (aToB ? -2 : 2);

  return {
    tickArray0: deriveTickArrayPda(idx0 * ticksInArray),
    tickArray1: deriveTickArrayPda(idx1 * ticksInArray),
    tickArray2: deriveTickArrayPda(idx2 * ticksInArray),
  };
}

/**
 * Derive Raydium CLMM tick array PDAs from current tick and tick spacing
 */
function deriveRaydiumTickArrays(
  poolId: PublicKey,
  currentTickIndex: number,
  tickSpacing: number,
  programId: PublicKey = RAYDIUM_CLMM_PROGRAM
): { lower: PublicKey; center: PublicKey; upper: PublicKey } {
  const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
  const realIndex = Math.floor(currentTickIndex / ticksInArray);
  
  const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32LE(startTickIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
      programId
    );
    return pda;
  };
  
  return {
    lower: deriveTickArrayPda((realIndex - 1) * ticksInArray),
    center: deriveTickArrayPda(realIndex * ticksInArray),
    upper: deriveTickArrayPda((realIndex + 1) * ticksInArray),
  };
}

/**
 * Derive Meteora DLMM bin array PDAs from active bin ID
 * Returns N directional bin arrays based on swap direction:
 * - X→Y (isAtoB=true): active, active-1, active-2, ... (lower direction, price goes down)
 * - Y→X (isAtoB=false): active, active+1, active+2, ... (upper direction, price goes up)
 * 
 * @param count Number of bin arrays to derive (default: 3, use 5 for small binStep pools)
 */
function deriveMeteoraBinArraysDirectional(
  poolId: PublicKey,
  activeId: number,
  isAtoB: boolean,
  count: number = 3
): { arrays: PublicKey[]; activeIndex: number } {
  // Derive bin array PDAs from active bin ID.
  // IMPORTANT: we must match the DLMM SDK PDA derivation for negative indexes.
  // This implementation uses a signed 64-bit two's complement seed (8 bytes LE),
  // consistent with other codepaths in this repo (pool derivation + testSwap).
  const BIN_ARRAY_SIZE = 70;
  const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);

  const deriveBinArrayPda = (index: number): PublicKey => {
    // Seed is an i64 LE (two's complement for negative values)
    const idxBn = new BN(index);
    const seed = idxBn.isNeg()
      ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
      : idxBn.toArrayLike(Buffer, 'le', 8);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bin_array'), poolId.toBuffer(), Buffer.from(seed)],
      METEORA_DLMM_PROGRAM
    );
    return pda;
  };

  // Directional selection: N consecutive bin arrays in swap direction
  // X→Y: price goes DOWN → need lower bin arrays (lower indices)
  // Y→X: price goes UP → need upper bin arrays (higher indices)
  const arrays: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    if (isAtoB) {
      // X→Y: active, active-1, active-2, ...
      arrays.push(deriveBinArrayPda(activeIndex - i));
    } else {
      // Y→X: active, active+1, active+2, ...
      arrays.push(deriveBinArrayPda(activeIndex + i));
    }
  }

  return { arrays, activeIndex };
}

/**
 * Derive Meteora DLMM bin array PDAs from active bin ID and bin step (legacy bidirectional)
 */
function deriveMeteoraBinArrays(
  poolId: PublicKey,
  activeId: number,
  binStep: number
): { lower: PublicKey; upper: PublicKey; active: PublicKey; activeIndex: number } {
  const BIN_ARRAY_SIZE = 70;
  const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);

  const deriveBinArrayPda = (index: number): PublicKey => {
    const idxBn = new BN(index);
    const seed = idxBn.isNeg()
      ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
      : idxBn.toArrayLike(Buffer, 'le', 8);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bin_array'), poolId.toBuffer(), Buffer.from(seed)],
      METEORA_DLMM_PROGRAM
    );
    return pda;
  };

  const active = deriveBinArrayPda(activeIndex);
  const lower = deriveBinArrayPda(activeIndex - 1);
  const upper = deriveBinArrayPda(activeIndex + 1);

  return { lower, upper, active, activeIndex };
}

/**
 * Derive Orca Whirlpool oracle PDA
 */
function deriveOrcaOracle(poolId: PublicKey): PublicKey {
  const [oracle] = PublicKey.findProgramAddressSync(
    [Buffer.from('oracle'), poolId.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return oracle;
}

// ============================================================================
// Hop Validation and Account Population
// ============================================================================

interface HopValidationResult {
  valid: boolean;
  missingAccounts: string[];
  derivedAccounts: Record<string, string>;
}

/**
 * Validate and populate missing accounts for a hop before building router transaction
 * This ensures all required accounts are present, deriving them if possible
 */
async function validateAndPopulateHopAccounts(hop: DirectHop, dexType: DexType): Promise<HopValidationResult> {
  const missingAccounts: string[] = [];
  const derivedAccounts: Record<string, string> = {};
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  
  // Get cached data
  const stat = executionCache.getStatic(poolId);
  const hot = executionCache.getHot(poolId);
  
  try {
    const poolPk = new PublicKey(poolId);
    
    switch (dexType) {
      case DexType.Raydium:
        // CRITICAL: Do NOT blindly derive tick arrays - derived PDAs may not exist on-chain!
        // Tick arrays must come from validated sources (pool fetch, websocket, cacheValidator).
        // If missing, flag them as missing rather than using potentially invalid addresses.
        if (!hop.tickArrayLower || !hop.tickArrayCenter || !hop.tickArrayUpper) {
          // Try to get from static cache (may have been stored during pool loading)
          if (stat?.tickArrayLower && !hop.tickArrayLower) {
            hop.tickArrayLower = stat.tickArrayLower;
            derivedAccounts.tickArrayLower = hop.tickArrayLower;
          }
          if (stat?.tickArrayCenter && !hop.tickArrayCenter) {
            hop.tickArrayCenter = stat.tickArrayCenter;
            derivedAccounts.tickArrayCenter = hop.tickArrayCenter;
          }
          if (stat?.tickArrayUpper && !hop.tickArrayUpper) {
            hop.tickArrayUpper = stat.tickArrayUpper;
            derivedAccounts.tickArrayUpper = hop.tickArrayUpper;
          }
          
          // Still missing? Flag as missing (don't blindly derive)
          if (!hop.tickArrayLower) missingAccounts.push('tickArrayLower');
          if (!hop.tickArrayCenter) missingAccounts.push('tickArrayCenter');
          if (!hop.tickArrayUpper) missingAccounts.push('tickArrayUpper');
          
          if (missingAccounts.length > 0) {
            logger.warn('routerTx.raydium.tickArrays.missing', {
              cat: 'tx',
              pool: poolId,
              missing: missingAccounts.filter(a => a.includes('tickArray')),
              hint: 'Pool needs tick array validation. Call /arb/pools/revalidate or set REVALIDATE_ON_LOAD=true',
            });
          }
        }
        
        // Check AMM config
        if (!hop.ammConfig) {
          if (stat?.amm_config) {
            hop.ammConfig = stat.amm_config;
            derivedAccounts.ammConfig = hop.ammConfig;
          } else {
            missingAccounts.push('ammConfig');
          }
        }
        
        // Check observation state
        if (!hop.observationId) {
          if (stat?.observation_state) {
            hop.observationId = stat.observation_state;
            derivedAccounts.observationId = hop.observationId;
          }
          // observationId is optional, some pools may not have it
        }
        break;
        
      case DexType.Orca:
        // CRITICAL: Do NOT blindly derive tick arrays - derived PDAs may not exist on-chain!
        // Tick arrays must come from validated sources (pool fetch, websocket, cacheValidator).
        // If missing, try to get from static cache, otherwise flag as missing.
        {
          if (!hop.tickArrayLower || !hop.tickArrayCenter || !hop.tickArrayUpper) {
            // Try to get from static cache (may have been stored during pool loading)
            if (stat?.tickArrayLower && !hop.tickArrayLower) {
              hop.tickArrayLower = stat.tickArrayLower;
              derivedAccounts.tickArrayLower = hop.tickArrayLower;
            }
            if (stat?.tickArrayCenter && !hop.tickArrayCenter) {
              hop.tickArrayCenter = stat.tickArrayCenter;
              derivedAccounts.tickArrayCenter = hop.tickArrayCenter;
            }
            if (stat?.tickArrayUpper && !hop.tickArrayUpper) {
              hop.tickArrayUpper = stat.tickArrayUpper;
              derivedAccounts.tickArrayUpper = hop.tickArrayUpper;
            }
            
            // Still missing? Flag as missing (don't blindly derive)
            if (!hop.tickArrayLower) missingAccounts.push('tickArrayLower');
            if (!hop.tickArrayCenter) missingAccounts.push('tickArrayCenter');
            if (!hop.tickArrayUpper) missingAccounts.push('tickArrayUpper');
            
            if (missingAccounts.some(a => a.includes('tickArray'))) {
              logger.warn('routerTx.orca.tickArrays.missing', {
                cat: 'tx',
                pool: poolId,
                missing: missingAccounts.filter(a => a.includes('tickArray')),
                hint: 'Pool needs tick array validation. Call /arb/pools/revalidate or set REVALIDATE_ON_LOAD=true',
              });
            }
          }
        }
        
        // Derive oracle if missing
        if (!hop.oracle) {
          hop.oracle = deriveOrcaOracle(poolPk).toBase58();
          derivedAccounts.oracle = hop.oracle;
        }
        break;
        
      case DexType.Meteora:
        // Check and derive bin arrays
        {
          // Always prefer hot-cache bin arrays (populated during refresh / WS) when available.
          // Then, if we still don't have enough, derive a safe pair and validate existence.
          const cachedBinArrays: any = hot?.binArrays as any;

          // Determine direction using native (tokenX/tokenY) mints when available.
          const nativeMintX = stat?.native_mint_a;
          const nativeMintY = stat?.native_mint_b;
          const isXtoY = !!nativeMintX && !!nativeMintY && hop.inputMint === nativeMintX && hop.outputMint === nativeMintY;
          const isYtoX = !!nativeMintX && !!nativeMintY && hop.inputMint === nativeMintY && hop.outputMint === nativeMintX;

          // Choose which adjacent bin array is likely needed; if unknown, default to "up".
          const delta = isXtoY ? -1 : 1;

          const activeId = (hop.activeId ?? hot?.activeId);
          const binStep = (hop.binStep ?? stat?.binStep);

          // Extract all 5 bin arrays from cache:
          // - active: bin array containing the active bin (activeIndex)
          // - lower: bin array at activeIndex - 1
          // - lower2: bin array at activeIndex - 2
          // - upper: bin array at activeIndex + 1
          // - upper2: bin array at activeIndex + 2
          const cachedActive = cachedBinArrays?.active;
          const cachedLower = cachedBinArrays?.lower;
          const cachedLower2 = cachedBinArrays?.lower2;
          const cachedUpper = cachedBinArrays?.upper;
          const cachedUpper2 = cachedBinArrays?.upper2;

          // Start with cache values if present
          // Note: These are just candidates; we will validate below when possible.
          if (cachedActive) {
            (hop as any).binArrayActive = String(cachedActive);
          }
          if (!hop.binArrayLower && cachedLower) {
            hop.binArrayLower = String(cachedLower);
            derivedAccounts.binArrayLower = hop.binArrayLower;
          }
          if (!hop.binArrayUpper && cachedUpper) {
            hop.binArrayUpper = String(cachedUpper);
            derivedAccounts.binArrayUpper = hop.binArrayUpper;
          }
          // Also cache the ±2 arrays for boundary cases
          if (cachedLower2) {
            (hop as any).binArrayLower2 = String(cachedLower2);
          }
          if (cachedUpper2) {
            (hop as any).binArrayUpper2 = String(cachedUpper2);
          }

          // If still missing, derive from activeId
          if ((!hop.binArrayLower || !hop.binArrayUpper) && typeof activeId === 'number' && Number.isFinite(activeId)) {
            const derived = deriveMeteoraBinArrays(poolPk, activeId, Number(binStep || 0));

            // Candidate pair: active + neighbor in direction (ordered for remaining accounts)
            const neighborIndex = derived.activeIndex + delta;
            const neighbor = delta < 0 ? derived.lower : derived.upper;
            const active = derived.active;

            const ordered = delta < 0
              ? [neighbor, active]   // X->Y: increasing index (lower then active)
              : [neighbor, active];  // Y->X: decreasing would be neighbor (higher) then active; we still pass neighbor first

            const [first, second] = ordered;
            if (!hop.binArrayLower) {
              hop.binArrayLower = first.toBase58();
              derivedAccounts.binArrayLower = hop.binArrayLower;
            }
            if (!hop.binArrayUpper) {
              hop.binArrayUpper = second.toBase58();
              derivedAccounts.binArrayUpper = hop.binArrayUpper;
            }

            logger.warn('routerTx.meteora.binArrays.derived_not_cached', {
              cat: 'tx',
              pool: poolId,
              activeId,
              binStep,
              neighborIndex,
              note: 'Bin arrays derived because cache was missing/incomplete; will validate existence before build when possible.',
            });
          }

          // Validate existence/owner for the chosen pair (cheap: 2 accounts).
          // If the second one is missing, duplicate the first to avoid Anchor 3007 (System-owned PDA).
          if (hop.binArrayLower && hop.binArrayUpper) {
            try {
              const conn = getConnection();
              const pkA = new PublicKey(hop.binArrayLower);
              const pkB = new PublicKey(hop.binArrayUpper);
              const infos = await withRpcLimit(
                () => conn.getMultipleAccountsInfo([pkA, pkB]),
                1,
                { module: 'routerTx', method: 'getMultipleAccountsInfo:meteoraBinArrayVerify' }
              );
              const okA = !!infos?.[0] && infos[0].owner.equals(METEORA_DLMM_PROGRAM);
              const okB = !!infos?.[1] && infos[1].owner.equals(METEORA_DLMM_PROGRAM);
              if (!okA) {
                // Cannot proceed without at least one valid bin array
                missingAccounts.push('binArrayLower');
              } else if (!okB) {
                hop.binArrayUpper = hop.binArrayLower;
                derivedAccounts.binArrayUpper = hop.binArrayUpper;
              }
            } catch {
              // If RPC fails, don't block; builder may still succeed if accounts exist.
            }
          } else {
            if (!hop.binArrayLower) missingAccounts.push('binArrayLower');
            if (!hop.binArrayUpper) missingAccounts.push('binArrayUpper');
          }
        }
        
        // Ensure token programs are set (default to SPL Token)
        if (!(hop as any).tokenProgramA) {
          (hop as any).tokenProgramA = stat?.token_program_a || 'spl-token';
        }
        if (!(hop as any).tokenProgramB) {
          (hop as any).tokenProgramB = stat?.token_program_b || 'spl-token';
        }
        break;
        
      case DexType.PumpSwap:
        // Check protocol fee recipient
        if (!(hop as any).protocolFeeRecipient) {
          if (stat?.protocol_fee_recipient) {
            (hop as any).protocolFeeRecipient = stat.protocol_fee_recipient;
            derivedAccounts.protocolFeeRecipient = stat.protocol_fee_recipient;
          }
          // protocolFeeRecipient will fall back to program ID in extractDexAccounts
        }
        break;
        
      case DexType.RaydiumCpmm:
        // Check CPMM-specific accounts
        if (!hop.ammConfig) {
          const ammConfig = stat?.amm_config;
          if (ammConfig) {
            hop.ammConfig = ammConfig;
            derivedAccounts.ammConfig = ammConfig;
          } else {
            missingAccounts.push('ammConfig');
          }
        }
        if (!hop.observationId) {
          const obsKey = stat?.observation_key;
          if (obsKey) {
            hop.observationId = obsKey;
            derivedAccounts.observationId = obsKey;
          } else {
            missingAccounts.push('observationId');
          }
        }
        // Check token programs - MUST respect swap direction (aToB)
        // When aToB=true: input=mintA, output=mintB
        // When aToB=false (reverse/#rev): input=mintB, output=mintA
        if (!(hop as any).tokenProgramIn) {
          if (hop.aToB !== false) {
            (hop as any).tokenProgramIn = stat?.token_program_a || 'spl-token';
          } else {
            (hop as any).tokenProgramIn = stat?.token_program_b || 'spl-token';
          }
        }
        if (!(hop as any).tokenProgramOut) {
          if (hop.aToB !== false) {
            (hop as any).tokenProgramOut = stat?.token_program_b || 'spl-token';
          } else {
            (hop as any).tokenProgramOut = stat?.token_program_a || 'spl-token';
          }
        }
        break;
    }
    
    // Common: Check vaults
    if (!hop.vaultA) {
      const vaultA = stat?.native_account_a || stat?.account_a || stat?.vaults?.a || stat?.vault_a;
      if (vaultA) {
        hop.vaultA = vaultA;
        derivedAccounts.vaultA = vaultA;
      } else {
        missingAccounts.push('vaultA');
      }
    }
    if (!hop.vaultB) {
      const vaultB = stat?.native_account_b || stat?.account_b || stat?.vaults?.b || stat?.vault_b;
      if (vaultB) {
        hop.vaultB = vaultB;
        derivedAccounts.vaultB = vaultB;
      } else {
        missingAccounts.push('vaultB');
      }
    }
    
  } catch (err: any) {
    logger.error('routerTx.validateHop.error', {
      cat: 'tx',
      pool: poolId,
      dex: hop.dex,
      error: err.message,
    });
    missingAccounts.push(`validation_error: ${err.message}`);
  }
  
  return {
    valid: missingAccounts.length === 0,
    missingAccounts,
    derivedAccounts,
  };
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


