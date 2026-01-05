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

// ============================================================================
// Constants
// ============================================================================

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const PUMPSWAP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

// Tick array derivation constants
const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;

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
 * Seeds: ["exaccount", pool_id] (NOT "tick_array_bitmap_extension")
 */
function deriveRaydiumExBitmapPda(poolId: PublicKey, programId: PublicKey = RAYDIUM_CLMM_PROGRAM): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('exaccount'), poolId.toBuffer()],
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
        logger.info('routerTx.flashLoan.accounts.derived', {
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
      const intermediateMint = new PublicKey(hop.outputMint);
      const intermediateTokenProgram = hop.outputTokenProgram === 'token-2022' 
        ? TOKEN_2022_PROGRAM_ID 
        : TOKEN_PROGRAM_ID;
      
      // Skip if same as input (shouldn't happen in well-formed plan)
      if (hop.outputMint !== plan.hops[0].inputMint) {
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
      logger.info('routerTx.flashLoan.atas.created', {
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
    logger.info('routerTx.flashLoan.execute.params', {
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
      { steps, accountsPerStep, minProfit, initialBalances },
      dexAccounts,
      programId
    );
    
    // DIAGNOSTIC: Verify the instruction keys are in correct order
    logger.info('routerTx.flashLoan.execute.keys', {
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
        logger.info('routerTx.direct.accounts.derived', {
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
    logger.info('routerTx.direct.init', {
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
          logger.info('routerTx.direct.wrapSol', {
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
      const intermediateMint = new PublicKey(hop.outputMint);
      const intermediateTokenProgram = hop.outputTokenProgram === 'token-2022' 
        ? TOKEN_2022_PROGRAM_ID 
        : TOKEN_PROGRAM_ID;
      
      // Skip if it's SOL (handled as WSOL)
      if (!isSolMint(hop.outputMint)) {
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
      logger.info('routerTx.direct.atas.created', {
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
      const poolMintA = stat?.native_mint_a || stat?.mint_a;
      const aToB = hop.inputMint === poolMintA;
      const amountIn = BigInt(hop.amountInRaw.toString());
      const minAmountOut = BigInt(hop.minOutRaw.toString());
      const dexAccounts = await extractDexAccounts(hop, dexType, wallet.publicKey, { allowVariableAccounts: true });
      try {
        // Calculate bin array count: swap variant starts at 15, swap2 at 16
        // We use 15 as base since swap is most common (standard SPL tokens)
        const meteoraBinArrayCount = dexType === DexType.Meteora 
          ? Math.max(0, dexAccounts.length - 15)  // swap: 15 fixed, swap2: 16 fixed
          : undefined;
        logger.info('routerTx.direct.route_swap.prepared', {
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
      
      logger.info('routerTx.direct.execute.params', {
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
        { steps, accountsPerStep, minProfit, initialBalances },
        dexAccounts,
        programId
      );
      
      // DIAGNOSTIC: Verify the instruction keys are in correct order
      // Expected: key0 = wallet (signer, NOT writable), key1 = userTokenAccount (NOT signer, writable)
      const key0MatchesWallet = executeIx.keys[0]?.pubkey?.toBase58?.() === walletPubkey;
      const key1MatchesToken = executeIx.keys[1]?.pubkey?.toBase58?.() === userTokenPubkey;
      
      logger.info('routerTx.direct.execute.keys', {
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
        logger.info('routerTx.direct.unwrapSol', {
          cat: 'tx',
          ctx: { wsolAta: wsolAta.toBase58() },
        });
      } catch {}
    }

    logger.info('routerTx.direct.built', {
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

    // First hop: use specified amount
    // Subsequent hops: use 0 to trigger dynamic amount propagation
    // The on-chain router will read the actual token account balance
    const amountIn = i === 0 
      ? BigInt(hop.amountInRaw.toString()) 
      : 0n;

    // Compute swap direction from pool's native mint ordering
    // aToB = true means swapping mint A -> mint B
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    const poolMintA = stat?.native_mint_a || stat?.mint_a;
    const aToB = hop.inputMint === poolMintA;

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
      const uiBalance = inputMint === SOL_MINT 
        ? walletBalances.sol 
        : (walletBalances.tokens[inputMint] ?? 0);
      
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

    // Collect DEX accounts for this hop - pass wallet for signer account positions
    const hopAccounts = await extractDexAccounts(hop, dexType, wallet);
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
  opts?: { allowVariableAccounts?: boolean }
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
    const nativeMintA = stat?.native_mint_a;  // On-chain token_mint_0
    const nativeMintB = stat?.native_mint_b;  // On-chain token_mint_1
    const nativeAccountA = stat?.native_account_a;  // On-chain vault for token_mint_0
    const nativeAccountB = stat?.native_account_b;  // On-chain vault for token_mint_1
    
    // Direction flag uses NATIVE ordering (matches on-chain a_to_b interpretation)
    // Fallback to canonical only if native is unavailable
    const isAtoB = nativeMintA 
      ? (hop.inputMint === nativeMintA) 
      : (hop.inputMint === poolMintA);

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
        // - swap_v2: Token-2022 tokens (requires Token-2022 Program, Memo Program, Mints)
        // - swap: Standard SPL tokens (optimized, 11-12 accounts)
        //   - With exBitmap: 12 accounts
        //   - Without exBitmap: 11 accounts
        const hasToken2022 = hop.inputTokenProgram === 'token-2022' || hop.outputTokenProgram === 'token-2022';
        const raydiumNeedsSwapV2 = hasToken2022;
        
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
        
        // Derive observation state PDA if not cached
        const observationState = hop.observationId 
          ? new PublicKey(hop.observationId)
          : deriveRaydiumObservationPda(poolId, programIdKey);
        
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
        logger.info('routerTx.raydium.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          // Swap variant selection
          swapVariant: raydiumNeedsSwapV2 ? 'swap_v2' : 'swap',
          swapVariantReason: hasToken2022 ? 'token2022' : (hasExBitmap ? 'spl_with_exbitmap' : 'spl_no_exbitmap'),
          inputTokenProgram: hop.inputTokenProgram || 'spl-token',
          outputTokenProgram: hop.outputTokenProgram || 'spl-token',
          ammConfig: ammConfig.toBase58(),
          ammConfigSource: ammConfigAddr ? 'cache' : 'fallback',
          observation: observationState.toBase58(),
          observationSource: hop.observationId ? 'cache' : 'derived',
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
          isAtoBSource: nativeMintA ? 'native' : 'canonical_fallback',
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
          const rayTickArray0 = hop.tickArrayCenter;
          const rayTickArray1 = isAtoB ? hop.tickArrayLower : hop.tickArrayUpper;
          const rayTickArray2 = isAtoB ? hop.tickArrayUpper : hop.tickArrayLower;
          
          // Validate tick arrays exist before building instruction
          // swap needs only center tick array; swap_v2 needs all 3
          if (!rayTickArray0) {
            throw new Error(
              `RAYDIUM_CLMM_TICK_ARRAYS_MISSING: Pool ${hop.poolId} missing center tick array. ` +
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
          logger.info('routerTx.raydium.finalAccounts', {
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
        //   0-14: 15 fixed accounts (includes Memo at 13), user tokens in X/Y order
        //   15: Program, 16+: BinArrays
        //
        // On-chain router auto-detects based on Memo Program at index 13.
        const meteoraEventAuthority = deriveMeteoraDlmmEventAuthority();
        
        // Get token programs from hop (set by resolver from pool cache)
        // CRITICAL: token_program_a/b are in CANONICAL order, but Meteora needs NATIVE X/Y order
        // When was_swapped is true, native X = canonical B and native Y = canonical A
        const wasSwapped = (stat as any)?.was_swapped === 'true' || (stat as any)?.was_swapped === true;
        const canonicalProgramA = tokenProgramLabelToKey((hop as any).tokenProgramA);
        const canonicalProgramB = tokenProgramLabelToKey((hop as any).tokenProgramB);
        const tokenXProgram = wasSwapped ? canonicalProgramB : canonicalProgramA;
        const tokenYProgram = wasSwapped ? canonicalProgramA : canonicalProgramB;
        
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
        const reserveX = hop.reserveX || meteoraNativeReserveX || meteoraNativeAccountA || canonicalVaultX || hop.poolId;
        const reserveY = hop.reserveY || meteoraNativeReserveY || meteoraNativeAccountB || canonicalVaultY || hop.poolId;
        
        // Token X/Y mints must also be native ordering
        // CRITICAL: When native_mint_a/b are not available, use was_swapped to correct the canonical fallback
        // When wasSwapped is true: native X = canonical B, native Y = canonical A
        // This matches the token program logic above (lines 1169-1170)
        const tokenXMint = meteoraNativeMintA || (wasSwapped ? poolMintB : poolMintA);
        const tokenYMint = meteoraNativeMintB || (wasSwapped ? poolMintA : poolMintB);
        
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
        const isXtoY = hop.inputMint === tokenXMint;
        
        // CRITICAL: Meteora expects user token accounts in X/Y order, NOT input/output order!
        // The program infers swap direction from amounts and which account has funds.
        // isXtoY = true: User sends X, receives Y → userTokenX = source, userTokenY = dest
        // isXtoY = false: User sends Y, receives X → userTokenX = dest, userTokenY = source
        const userTokenX = isXtoY ? userSourceAta : userDestAta;
        const userTokenY = isXtoY ? userDestAta : userSourceAta;
        
        // Get activeId from cache for directional bin array derivation
        const meteoraPoolIdStr = hop.poolId.replace(/[#-]rev$/, '');
        const hotCache = executionCache.getHot(meteoraPoolIdStr) as any;
        const activeId = hop.activeId ?? hotCache?.activeId;
        
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
        const knownBinArrayActive = (hop as any).binArrayActive ? new PublicKey((hop as any).binArrayActive) : null;
        const knownBinArrayLower = hop.binArrayLower ? new PublicKey(hop.binArrayLower) : null;
        const knownBinArrayLower2 = (hop as any).binArrayLower2 ? new PublicKey((hop as any).binArrayLower2) : null;
        const knownBinArrayUpper = hop.binArrayUpper ? new PublicKey(hop.binArrayUpper) : null;
        const knownBinArrayUpper2 = (hop as any).binArrayUpper2 ? new PublicKey((hop as any).binArrayUpper2) : null;
        
        // Get binStep from hop or static cache to determine how many bin arrays needed
        // Pools with smaller binStep need more bin arrays as each covers a smaller price range
        // binStep 2 = ~0.02% per bin, binStep 15 = ~0.15% per bin (7.5x difference)
        const binStep = (hop as any).binStep ?? (stat as any)?.bin_step ?? hotCache?.binStep;
        const binStepNum = typeof binStep === 'string' ? parseInt(binStep, 10) : (binStep ?? 10);
        
        // Use 5 bin arrays for fine-grained pools (binStep <= 5), 3 for others
        // This prevents error 3005 "Not enough account keys" when swap traverses multiple bin arrays
        const neededBinArrayCount = binStepNum <= 5 ? 5 : 3;
        
        let directionalBinArrays: PublicKey[] = [];
        
        // Build N directional bin arrays based on activeId and swap direction
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
        
        // Log the accounts being used for debugging with verification
        logger.info('routerTx.meteora.accounts', {
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
          // User tokens in X/Y native order, includes Memo Program
          accounts.push(
            poolId,                                                              // 0: LB Pair
            hop.bitmapExtension 
              ? new PublicKey(hop.bitmapExtension) 
              : programIdKey,                                                    // 1: Bitmap Extension (use program ID as placeholder)
            new PublicKey(reserveX),                                             // 2: Reserve X (native, paired with tokenXMint)
            new PublicKey(reserveY),                                             // 3: Reserve Y (native, paired with tokenYMint)
            userTokenX,                                                          // 4: User Token X (X/Y order for swap2!)
            userTokenY,                                                          // 5: User Token Y (X/Y order for swap2!)
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
        
        // CRITICAL: Orca swap direction MUST use NATIVE mint ordering (tokenMintA/tokenMintB)
        // The on-chain program uses native A/B to determine swap direction
        // nativeMintA/B were already extracted above for all DEX types
        const isAtoBOrca = nativeMintA ? (hop.inputMint === nativeMintA) : isAtoB;
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
        const knownCenter = hop.tickArrayCenter || '';
        const knownLower = hop.tickArrayLower || '';
        const knownUpper = hop.tickArrayUpper || '';
        
        // Default: use known-good arrays in directional order
        // tickArray0 = center (contains current tick)
        // tickArray1 = next in direction (lower for A→B, upper for B→A)
        // tickArray2 = duplicate of tickArray1 (safe fallback - third array may not exist)
        let tickArray0 = knownCenter;
        let tickArray1 = isAtoBOrca ? knownLower : knownUpper;
        let tickArray2 = tickArray1;  // Safe: duplicate the second array
        
        // Try to derive proper tick arrays, but validate and fallback
        try {
          const hot = executionCache.getHot(poolIdStr);
          const tickSpacing = (hop.tickSpacing ?? (hot as any)?.tickSpacing);
          const currentTick = (hot as any)?.currentTickIndex;
          if (Number.isFinite(tickSpacing) && Number(tickSpacing) > 0 && Number.isFinite(currentTick)) {
            const derived = deriveOrcaTickArraysForSwap(poolId, Number(currentTick), Number(tickSpacing), !!isAtoBOrca);
            tickArray0 = derived.tickArray0.toBase58();
            tickArray1 = derived.tickArray1.toBase58();
            // For tickArray2: only use derived if it matches a known-good array
            // Otherwise, duplicate tickArray1 to avoid using an uninitialized array
            const derivedArray2 = derived.tickArray2.toBase58();
            if (derivedArray2 === knownCenter || derivedArray2 === knownLower || derivedArray2 === knownUpper) {
              tickArray2 = derivedArray2;  // Derived matches a known-good array
            } else {
              tickArray2 = tickArray1;  // Safe fallback: duplicate tickArray1
            }
          }
        } catch { /* ignore */ }
        
        // Get mint pubkeys for swapV2
        const orcaMintA = nativeMintA ? new PublicKey(nativeMintA) : inputMint;
        const orcaMintB = nativeMintB ? new PublicKey(nativeMintB) : outputMint;
        
        // Log the accounts being used for debugging with native mint verification
        logger.info('routerTx.orca.accounts', {
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
          isAtoBSource: nativeMintA ? 'native_mint_a' : 'canonical_fallback',
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
        // PumpSwap: 12 accounts
        // 0: GlobalConfig, 1: FeeRecipient, 2: Mint, 3: BondingCurve, 4: BCTokenAccount,
        // 5: AssociatedBC, 6: UserToken, 7: User, 8: System, 9: Token, 10: Rent, 11: Program
        const globalConfig = derivePumpswapGlobalConfig();
        const isBuying = hop.inputMint === SOL_MINT; // SOL -> Token = buy
        const pumpMint = isBuying ? outputMint : inputMint; // The pump.fun token mint
        const associatedBC = derivePumpswapAssociatedBondingCurve(poolId, pumpMint);
        
        // CRITICAL: Use CANONICAL account ordering for BC Token Account
        const pumpVault = poolAccountA || hop.vaultA || hop.poolId;
        
        // Log the accounts being used for debugging
        logger.info('routerTx.pumpswap.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          globalConfig: globalConfig.toBase58(),
          protocolFeeRecipient: (hop as any).protocolFeeRecipient || 'missing',
          pumpMint: pumpMint.toBase58(),
          associatedBC: associatedBC.toBase58(),
          canonicalAccountA: poolAccountA || 'missing',
          hopVaultA: hop.vaultA || 'missing',
          selectedVault: pumpVault,
          isBuying,
          userTokenAccount: (isBuying ? userDestAta : userSourceAta).toBase58(),
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
        });
        
        accounts.push(
          globalConfig,                                                        // 0: Global Config
          (hop as any).protocolFeeRecipient 
            ? new PublicKey((hop as any).protocolFeeRecipient) 
            : programIdKey,                                                    // 1: Fee Recipient
          pumpMint,                                                            // 2: Mint (pump.fun token)
          poolId,                                                              // 3: Bonding Curve
          new PublicKey(pumpVault),                                            // 4: BC Token Account (canonical A)
          associatedBC,                                                        // 5: Associated Bonding Curve
          isBuying ? userDestAta : userSourceAta,                             // 6: User Token Account
          wallet,                                                              // 7: User (signer)
          SystemProgram.programId,                                             // 8: System Program
          TOKEN_PROGRAM_ID,                                                    // 9: Token Program
          SYSVAR_RENT_PUBKEY,                                                  // 10: Rent
          programIdKey,                                                        // 11: PumpSwap Program
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
 * Derive PumpSwap Global Config PDA
 */
function derivePumpswapGlobalConfig(): PublicKey {
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMPSWAP_PROGRAM
  );
  return globalConfig;
}

/**
 * Derive PumpSwap Associated Bonding Curve (ATA for bonding curve)
 */
function derivePumpswapAssociatedBondingCurve(bondingCurve: PublicKey, mint: PublicKey): PublicKey {
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const [assocBC] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return assocBC;
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


