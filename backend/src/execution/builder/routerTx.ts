/**
 * Router-based transaction building for arbitrage execution
 * 
 * This module provides transaction building that routes swaps through
 * the on-chain arb-router program, with optional flash loan support.
 */

import { PublicKey, TransactionInstruction, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import type { ExecutionPlan, DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { getConnection } from '../../wallet/wallet.js';
import { executionCache } from '../cache.js';
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

    // 2. Execute swaps (using execute instruction for multi-hop, now with validated accounts)
    const { steps, dexAccounts } = await buildRouteSteps(plan.hops, wallet.publicKey);
    
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
    const userTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey);

    // Single-hop optimization: use route_swap so Meteora can include variable bin arrays.
    // (execute slices fixed account counts per step, which can under-provide bin arrays)
    if (plan.hops.length === 1) {
      const hop = plan.hops[0];
      const dexType = dexNameToType(hop.dex, hop.variant);
      const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
      const poolMintA = stat?.mint_a;
      const aToB = hop.inputMint === poolMintA;
      const amountIn = BigInt(hop.amountInRaw.toString());
      const minAmountOut = BigInt(hop.minOutRaw.toString());
      const dexAccounts = await extractDexAccounts(hop, dexType, wallet.publicKey, { allowVariableAccounts: true });
      try {
        logger.info('routerTx.direct.route_swap.prepared', {
          cat: 'tx',
          ctx: {
            dexType,
            pool: hop.poolId,
            dexAccounts: dexAccounts.length,
            // For Meteora, bin arrays are the "remaining accounts" after index 15 (program) => start at 16
            meteoraBinArrays: dexType === DexType.Meteora ? Math.max(0, dexAccounts.length - 16) : undefined,
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
      const { steps, dexAccounts } = await buildRouteSteps(plan.hops, wallet.publicKey);
      instructions.push(
        buildExecuteIx(
          wallet.publicKey,
          userTokenAccount,
          { steps, minProfit },
          dexAccounts,
          programId
        )
      );
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
 */
async function buildRouteSteps(hops: DirectHop[], wallet: PublicKey): Promise<{
  steps: RouteStep[];
  dexAccounts: PublicKey[];
}> {
  const steps: RouteStep[] = [];
  const dexAccounts: PublicKey[] = [];

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

    // Collect DEX accounts for this hop - pass wallet for signer account positions
    const hopAccounts = await extractDexAccounts(hop, dexType, wallet);
    dexAccounts.push(...hopAccounts);

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
      },
    });
  }

  return { steps, dexAccounts };
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

    // Get pool's CANONICAL mint ordering from cache for direction determination
    // CRITICAL: Use canonical mint_a/account_a which are PAIRED correctly after canonicalization
    // Do NOT use native_mint_a with native_account_a because they may come from different sources
    // (native_mint_a might be sorted alphabetically while native_account_a is true on-chain order)
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    const poolMintA = stat?.mint_a;  // Canonical mint A
    const poolMintB = stat?.mint_b;  // Canonical mint B
    const poolAccountA = stat?.account_a;  // Canonical account A (paired with mint_a)
    const poolAccountB = stat?.account_b;  // Canonical account B (paired with mint_b)
    const isAtoB = hop.inputMint === poolMintA;

    switch (dexType) {
      case DexType.Raydium:
        // Raydium CLMM: 18 accounts (matches arb-router/src/dex/raydium.rs)
        // 0: Payer, 1: AmmConfig, 2: Pool, 3: UserInputToken, 4: UserOutputToken,
        // 5: InputVault, 6: OutputVault, 7: Observation, 8: TokenProgram, 9: Token2022Program,
        // 10: MemoProgram, 11: InputMint, 12: OutputMint, 13: Oracle/exBitmap,
        // 14: TickArrayCenter, 15: TickArrayLower, 16: TickArrayUpper, 17: RaydiumProgram
        
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
        
        // Derive exBitmap (tick array bitmap extension) PDA - REQUIRED for pools with wide tick ranges
        // Get from cache first (stat.ex_bitmap), otherwise derive
        const exBitmapAddr = (hop as any).exBitmap || stat?.ex_bitmap;
        const exBitmapPda = exBitmapAddr 
          ? new PublicKey(exBitmapAddr)
          : deriveRaydiumExBitmapPda(poolId, programIdKey);
        
        // CRITICAL: Use CANONICAL account ordering (properly paired with canonical mints)
        // hop.vaultA/B come from resolver's native_account_a/b which may NOT match native_mint_a/b
        // poolAccountA/B are canonical and properly paired with poolMintA/poolMintB
        const inputVault = isAtoB 
          ? (poolAccountA || hop.vaultA || hop.poolId)
          : (poolAccountB || hop.vaultB || hop.poolId);
        const outputVault = isAtoB
          ? (poolAccountB || hop.vaultB || hop.poolId)
          : (poolAccountA || hop.vaultA || hop.poolId);
        
        // Log the accounts being used for debugging
        logger.info('routerTx.raydium.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          ammConfig: ammConfig.toBase58(),
          ammConfigSource: ammConfigAddr ? 'cache' : 'fallback',
          observation: observationState.toBase58(),
          observationSource: hop.observationId ? 'cache' : 'derived',
          exBitmap: exBitmapPda.toBase58(),
          exBitmapSource: exBitmapAddr ? 'cache' : 'derived',
          // Show canonical vs hop vaults for debugging
          canonicalAccountA: poolAccountA || 'missing',
          canonicalAccountB: poolAccountB || 'missing',
          hopVaultA: hop.vaultA || 'missing',
          hopVaultB: hop.vaultB || 'missing',
          selectedInputVault: inputVault,
          selectedOutputVault: outputVault,
          tickArrayCenter: hop.tickArrayCenter || 'missing',
          tickArrayLower: hop.tickArrayLower || 'missing',
          tickArrayUpper: hop.tickArrayUpper || 'missing',
          isAtoB,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          canonicalMintA: poolMintA || 'missing',
          canonicalMintB: poolMintB || 'missing',
        });
        
        accounts.push(
          wallet,                                                              // 0: Payer (signer)
          ammConfig,                                                           // 1: AMM Config (from cache or placeholder)
          poolId,                                                              // 2: Pool State
          userSourceAta,                                                       // 3: Input Token Account (user)
          userDestAta,                                                         // 4: Output Token Account (user)
          new PublicKey(inputVault),                                           // 5: Input Vault (from canonical pairing)
          new PublicKey(outputVault),                                          // 6: Output Vault (from canonical pairing)
          observationState,                                                    // 7: Observation State (derived PDA)
          TOKEN_PROGRAM_ID,                                                    // 8: Token Program
          TOKEN_2022_PROGRAM_ID,                                               // 9: Token-2022 Program
          MEMO_PROGRAM_ID,                                                     // 10: Memo Program
          inputMint,                                                           // 11: Input Token Mint
          outputMint,                                                          // 12: Output Token Mint
          exBitmapPda,                                                         // 13: Tick Array Bitmap Extension (exBitmap)
          hop.tickArrayCenter ? new PublicKey(hop.tickArrayCenter) : poolId,  // 14: Tick Array Center
          hop.tickArrayLower ? new PublicKey(hop.tickArrayLower) : poolId,    // 15: Tick Array Lower
          hop.tickArrayUpper ? new PublicKey(hop.tickArrayUpper) : poolId,    // 16: Tick Array Upper
          programIdKey,                                                        // 17: Raydium CLMM Program
        );
        break;

      case DexType.Meteora:
        // Meteora DLMM: minimum accounts is fixed (15 fixed + 1 program) + N bin arrays.
        // Must match arb-router/programs/arb-router/src/dex/meteora.rs expected order:
        // 0: LBPair, 1: BitmapExt, 2-3: Reserves, 4-5: UserTokens, 6-7: Mints,
        // 8: Oracle, 9: HostFee, 10: User, 11: TokenXProgram, 12: TokenYProgram,
        // 13: MemoProgram, 14: EventAuth, 15: Program, 16+: BinArrays
        const meteoraEventAuthority = deriveMeteoraDlmmEventAuthority();
        
        // Get token programs from hop (set by resolver from pool cache)
        const tokenXProgram = tokenProgramLabelToKey((hop as any).tokenProgramA);
        const tokenYProgram = tokenProgramLabelToKey((hop as any).tokenProgramB);
        
        // CRITICAL: Use CANONICAL account ordering (properly paired with canonical mints)
        // Meteora expects reserves in X/Y order which corresponds to canonical A/B
        const reserveX = hop.reserveX || poolAccountA || hop.vaultA || hop.poolId;
        const reserveY = hop.reserveY || poolAccountB || hop.vaultB || hop.poolId;
        
        // Log the accounts being used for debugging
        logger.info('routerTx.meteora.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          bitmapExtension: hop.bitmapExtension || 'missing',
          reserveX,
          reserveY,
          canonicalAccountA: poolAccountA || 'missing',
          canonicalAccountB: poolAccountB || 'missing',
          hopVaultA: hop.vaultA || 'missing',
          hopVaultB: hop.vaultB || 'missing',
          oracle: hop.oracle || 'missing',
          binArrayLower: hop.binArrayLower || 'missing',
          binArrayUpper: hop.binArrayUpper || 'missing',
          tokenXProgram: tokenXProgram.toBase58(),
          tokenYProgram: tokenYProgram.toBase58(),
          eventAuthority: meteoraEventAuthority.toBase58(),
          isAtoB,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          canonicalMintA: poolMintA || 'missing',
          canonicalMintB: poolMintB || 'missing',
        });
        
        accounts.push(
          poolId,                                                              // 0: LB Pair
          hop.bitmapExtension 
            ? new PublicKey(hop.bitmapExtension) 
            : programIdKey,                                                    // 1: Bitmap Extension (use program ID as placeholder)
          new PublicKey(reserveX),                                             // 2: Reserve X (canonical A)
          new PublicKey(reserveY),                                             // 3: Reserve Y (canonical B)
          userSourceAta,                                                       // 4: User Token In
          userDestAta,                                                         // 5: User Token Out
          poolMintA ? new PublicKey(poolMintA) : inputMint,                   // 6: Token X Mint (canonical A)
          poolMintB ? new PublicKey(poolMintB) : outputMint,                  // 7: Token Y Mint (canonical B)
          hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 8: Oracle (from pool data)
          programIdKey,                                                        // 9: Host Fee In (use program as placeholder)
          wallet,                                                              // 10: User (signer)
          tokenXProgram,                                                       // 11: Token X Program
          tokenYProgram,                                                       // 12: Token Y Program
          MEMO_PROGRAM_ID,                                                     // 13: Memo Program
          meteoraEventAuthority,                                               // 14: Event Authority (PDA)
          programIdKey,                                                        // 15: Meteora DLMM Program
          hop.binArrayLower ? new PublicKey(hop.binArrayLower) : poolId,      // 16: Bin Array Lower (remaining account)
          hop.binArrayUpper ? new PublicKey(hop.binArrayUpper) : poolId,      // 17: Bin Array Upper (remaining account)
        );

        // Meteora frequently needs MORE than 2 bin array accounts.
        // For multi-hop `execute` we must include a fixed MIN amount per hop; for single-hop `route_swap`
        // we can optionally include even more. We source candidates from hot cache (refresh/WS).
        try {
          const expectedForMeteora = getAccountsNeededForDex(DexType.Meteora);
          const minBinArrays = Math.max(2, expectedForMeteora - 16);
          const maxBinArrays = opts?.allowVariableAccounts ? Math.max(minBinArrays, 16) : minBinArrays;

          const poolIdStr = hop.poolId.replace(/[#-]rev$/, '');
          const hot = executionCache.getHot(poolIdStr) as any;
          const arrays = hot?.binArrays?.arrays;

          const already = new Set(accounts.map((a) => a.toBase58()));
          const candidates: PublicKey[] = [];

          if (Array.isArray(arrays) && arrays.length > 0) {
            const dirSorted = arrays
              .map((x: any) => ({ index: Number(x?.index), address: String(x?.address || '') }))
              .filter((x: any) => Number.isFinite(x.index) && x.address)
              .sort((a: any, b: any) => (isAtoB ? (a.index - b.index) : (b.index - a.index)));

            for (const it of dirSorted) {
              try {
                const pk = new PublicKey(it.address);
                const b58 = pk.toBase58();
                if (already.has(b58)) continue;
                candidates.push(pk);
                already.add(b58);
              } catch {}
            }
          }

          if (candidates.length > 0) {
            // Validate existence + owner in one batch
            const conn = getConnection();
            const infos = await conn.getMultipleAccountsInfo(candidates);
            for (let i = 0; i < candidates.length; i++) {
              const info = infos?.[i];
              if (!info || !info.owner.equals(METEORA_DLMM_PROGRAM)) continue;
              accounts.push(candidates[i]);
              const binCount = Math.max(0, accounts.length - 16);
              if (binCount >= maxBinArrays) break;
            }
          }

          // Pad with a valid bin array pubkey if we still don't have enough.
          // This keeps account slicing stable for `execute` and avoids placeholder poolId keys.
          while (Math.max(0, accounts.length - 16) < minBinArrays) {
            const pad = accounts.length > 16 ? accounts[accounts.length - 1] : poolId;
            accounts.push(pad);
          }
        } catch {}
        break;

      case DexType.Orca:
        // Orca Whirlpool: 12 accounts (matches arb-router/src/dex/orca.rs)
        // 0: TokenProgram, 1: TokenAuthority(signer), 2: Whirlpool, 3: TokenOwnerAccountA,
        // 4: TokenVaultA, 5: TokenOwnerAccountB, 6: TokenVaultB, 7-9: TickArrays, 10: Oracle, 11: Program
        // Orca swap direction MUST be based on the pool's NATIVE mint ordering (tokenMintA/tokenMintB),
        // matching the `aToB` bit passed in the on-chain execute step.
        const nativeMintA = stat?.native_mint_a || stat?.mint_a;
        const isAtoBOrca = nativeMintA ? (hop.inputMint === nativeMintA) : isAtoB;
        const userTokenA = isAtoBOrca ? userSourceAta : userDestAta;
        const userTokenB = isAtoBOrca ? userDestAta : userSourceAta;
        
        // CRITICAL: Use CANONICAL account ordering (properly paired with canonical mints)
        // Orca expects vaults in A/B order which corresponds to canonical A/B
        const orcaVaultA = poolAccountA || hop.vaultA || hop.poolId;
        const orcaVaultB = poolAccountB || hop.vaultB || hop.poolId;
        
        // CRITICAL: Orca Whirlpool swap expects tick arrays in a direction-specific SEQUENCE:
        // tick_array_0 contains current tick, then two sequential arrays in swap direction.
        const poolIdStr = hop.poolId.replace(/[#-]rev$/, '');
        let tickArray0 = hop.tickArrayLower || '';
        let tickArray1 = hop.tickArrayCenter || '';
        let tickArray2 = hop.tickArrayUpper || '';
        try {
          const hot = executionCache.getHot(poolIdStr);
          const tickSpacing = (hop.tickSpacing ?? (hot as any)?.tickSpacing);
          const currentTick = (hot as any)?.currentTickIndex;
          if (Number.isFinite(tickSpacing) && Number(tickSpacing) > 0 && Number.isFinite(currentTick)) {
            const derived = deriveOrcaTickArraysForSwap(poolId, Number(currentTick), Number(tickSpacing), !!isAtoBOrca);
            tickArray0 = derived.tickArray0.toBase58();
            tickArray1 = derived.tickArray1.toBase58();
            tickArray2 = derived.tickArray2.toBase58();
          }
        } catch { /* ignore */ }
        
        // Log the accounts being used for debugging
        logger.info('routerTx.orca.accounts', {
          cat: 'tx',
          poolId: hop.poolId,
          canonicalAccountA: poolAccountA || 'missing',
          canonicalAccountB: poolAccountB || 'missing',
          hopVaultA: hop.vaultA || 'missing',
          hopVaultB: hop.vaultB || 'missing',
          selectedVaultA: orcaVaultA,
          selectedVaultB: orcaVaultB,
          tickArray0: tickArray0 || 'missing',
          tickArray1: tickArray1 || 'missing',
          tickArray2: tickArray2 || 'missing',
          oracle: hop.oracle || 'missing',
          userTokenA: userTokenA.toBase58(),
          userTokenB: userTokenB.toBase58(),
          isAtoB: isAtoBOrca,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          canonicalMintA: poolMintA || 'missing',
          canonicalMintB: poolMintB || 'missing',
        });
        
        accounts.push(
          TOKEN_PROGRAM_ID,                                                    // 0: Token Program
          wallet,                                                              // 1: Token Authority (signer)
          poolId,                                                              // 2: Whirlpool
          userTokenA,                                                          // 3: Token Owner Account A
          new PublicKey(orcaVaultA),                                           // 4: Token Vault A (canonical A)
          userTokenB,                                                          // 5: Token Owner Account B
          new PublicKey(orcaVaultB),                                           // 6: Token Vault B (canonical B)
          tickArray0 ? new PublicKey(tickArray0) : poolId,                    // 7: Tick Array 0
          tickArray1 ? new PublicKey(tickArray1) : poolId,                    // 8: Tick Array 1
          tickArray2 ? new PublicKey(tickArray2) : poolId,                    // 9: Tick Array 2
          hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 10: Oracle
          programIdKey,                                                        // 11: Whirlpool Program
        );
        break;

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
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32LE(startTickIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
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
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32LE(startTickIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
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
 * Derive Meteora DLMM bin array PDAs from active bin ID and bin step
 */
function deriveMeteoraBinArrays(
  poolId: PublicKey,
  activeId: number,
  binStep: number
): { lower: PublicKey; upper: PublicKey; active: PublicKey; activeIndex: number } {
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
        // Check and derive tick arrays
        if (!hop.tickArrayLower || !hop.tickArrayCenter || !hop.tickArrayUpper) {
          const tickSpacing = hop.tickSpacing || stat?.tickSpacing || stat?.tick_spacing;
          const currentTick = hot?.currentTickIndex;
          
          if (tickSpacing && currentTick !== undefined) {
            const programId = hop.programId ? new PublicKey(hop.programId) : RAYDIUM_CLMM_PROGRAM;
            const derived = deriveRaydiumTickArrays(poolPk, currentTick, tickSpacing, programId);
            
            if (!hop.tickArrayLower) {
              hop.tickArrayLower = derived.lower.toBase58();
              derivedAccounts.tickArrayLower = hop.tickArrayLower;
            }
            if (!hop.tickArrayCenter) {
              hop.tickArrayCenter = derived.center.toBase58();
              derivedAccounts.tickArrayCenter = hop.tickArrayCenter;
            }
            if (!hop.tickArrayUpper) {
              hop.tickArrayUpper = derived.upper.toBase58();
              derivedAccounts.tickArrayUpper = hop.tickArrayUpper;
            }
            
            logger.debug('routerTx.raydium.tickArrays.derived', {
              cat: 'tx',
              pool: poolId,
              currentTick,
              tickSpacing,
            });
          } else {
            if (!hop.tickArrayLower) missingAccounts.push('tickArrayLower');
            if (!hop.tickArrayCenter) missingAccounts.push('tickArrayCenter');
            if (!hop.tickArrayUpper) missingAccounts.push('tickArrayUpper');
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
        // Check and derive tick arrays
        {
          const tickSpacing = hop.tickSpacing || stat?.tickSpacing || stat?.tick_spacing;
          const currentTick = hot?.currentTickIndex;

          // IMPORTANT: Orca Whirlpool swap validates tick array sequence. We derive the
          // direction-specific sequence [0, dir1, dir2] and OVERWRITE any pre-filled values.
          if (tickSpacing && currentTick !== undefined) {
            // Direction must match Whirlpool native ordering (tokenMintA/tokenMintB)
            const mintA = String((stat as any)?.native_mint_a || (stat as any)?.mint_a || '');
            const mintB = String((stat as any)?.native_mint_b || (stat as any)?.mint_b || '');
            const aToB = (mintA ? hop.inputMint === mintA : false) && (mintB ? hop.outputMint === mintB : true);
            const bToA = (mintA ? hop.outputMint === mintA : false) && (mintB ? hop.inputMint === mintB : false);
            const isAtoB = aToB || !bToA; // default A->B if uncertain

            const derived = deriveOrcaTickArraysForSwap(poolPk, currentTick, tickSpacing, isAtoB);
            hop.tickArrayLower = derived.tickArray0.toBase58();
            hop.tickArrayCenter = derived.tickArray1.toBase58();
            hop.tickArrayUpper = derived.tickArray2.toBase58();
            derivedAccounts.tickArrayLower = hop.tickArrayLower;
            derivedAccounts.tickArrayCenter = hop.tickArrayCenter;
            derivedAccounts.tickArrayUpper = hop.tickArrayUpper;

            logger.debug('routerTx.orca.tickArrays.derived', {
              cat: 'tx',
              pool: poolId,
              currentTick,
              tickSpacing,
              isAtoB,
            });
          } else {
            if (!hop.tickArrayLower) missingAccounts.push('tickArrayLower');
            if (!hop.tickArrayCenter) missingAccounts.push('tickArrayCenter');
            if (!hop.tickArrayUpper) missingAccounts.push('tickArrayUpper');
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

          // If cache provides an 'active' PDA, use it; else fall back.
          const cachedActive = cachedBinArrays?.active || cachedBinArrays?.lower;
          const cachedLower = cachedBinArrays?.lower;
          const cachedUpper = cachedBinArrays?.upper;

          // Start with cache values if present
          // Note: These are just candidates; we will validate below when possible.
          if (!hop.binArrayLower && cachedLower) {
            hop.binArrayLower = String(cachedLower);
            derivedAccounts.binArrayLower = hop.binArrayLower;
          }
          if (!hop.binArrayUpper && cachedUpper) {
            hop.binArrayUpper = String(cachedUpper);
            derivedAccounts.binArrayUpper = hop.binArrayUpper;
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
              const infos = await conn.getMultipleAccountsInfo([pkA, pkB]);
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


