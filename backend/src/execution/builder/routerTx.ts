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
    const { steps, dexAccounts } = buildRouteSteps(plan.hops, wallet.publicKey);
    
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
    const { steps, dexAccounts } = buildRouteSteps(plan.hops, wallet.publicKey);

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
 * 
 * For dynamic amount propagation:
 * - First hop uses the specified amountInRaw
 * - Subsequent hops use amountIn=0, which tells the on-chain router to
 *   read the actual balance from the input token account (output of previous swap)
 */
function buildRouteSteps(hops: DirectHop[], wallet: PublicKey): {
  steps: RouteStep[];
  dexAccounts: PublicKey[];
} {
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
    const hopAccounts = extractDexAccounts(hop, dexType, wallet);
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
function extractDexAccounts(hop: DirectHop, dexType: DexType, wallet: PublicKey): PublicKey[] {
  const accounts: PublicKey[] = [];

  try {
    const poolId = new PublicKey(hop.poolId.replace(/[#-]rev$/, ''));
    const programIdKey = new PublicKey(hop.programId);
    const inputMint = new PublicKey(hop.inputMint);
    const outputMint = new PublicKey(hop.outputMint);
    const userSourceAta = new PublicKey(hop.userSourceAta);
    const userDestAta = new PublicKey(hop.userDestAta);

    // Get pool's native mint ordering from cache for direction determination
    const stat = executionCache.getStatic(hop.poolId.replace(/[#-]rev$/, ''));
    const poolMintA = stat?.native_mint_a || stat?.mint_a;
    const poolMintB = stat?.native_mint_b || stat?.mint_b;
    const isAtoB = hop.inputMint === poolMintA;

    switch (dexType) {
      case DexType.Raydium:
        // Raydium CLMM: 17 accounts
        // 0: Payer, 1: AmmConfig, 2: Pool, 3: UserInputToken, 4: UserOutputToken,
        // 5: InputVault, 6: OutputVault, 7: Observation, 8: TokenProgram,
        // 9-11: TickArrays, 12: Oracle, 13-14: Mints, 15: Memo, 16: Program
        accounts.push(
          wallet,                                                              // 0: Payer (signer)
          hop.ammConfig ? new PublicKey(hop.ammConfig) : poolId,              // 1: AMM Config
          poolId,                                                              // 2: Pool State
          userSourceAta,                                                       // 3: Input Token Account (user)
          userDestAta,                                                         // 4: Output Token Account (user)
          new PublicKey(isAtoB ? (hop.vaultA || hop.poolId) : (hop.vaultB || hop.poolId)), // 5: Input Vault
          new PublicKey(isAtoB ? (hop.vaultB || hop.poolId) : (hop.vaultA || hop.poolId)), // 6: Output Vault
          hop.observationId ? new PublicKey(hop.observationId) : poolId,      // 7: Observation State
          TOKEN_PROGRAM_ID,                                                    // 8: Token Program
          hop.tickArrayLower ? new PublicKey(hop.tickArrayLower) : poolId,    // 9: Tick Array Lower
          hop.tickArrayCenter ? new PublicKey(hop.tickArrayCenter) : poolId,  // 10: Tick Array Current
          hop.tickArrayUpper ? new PublicKey(hop.tickArrayUpper) : poolId,    // 11: Tick Array Upper
          hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 12: Oracle
          inputMint,                                                           // 13: Input Token Mint
          outputMint,                                                          // 14: Output Token Mint
          MEMO_PROGRAM_ID,                                                     // 15: Memo Program
          programIdKey,                                                        // 16: Raydium CLMM Program
        );
        break;

      case DexType.Meteora:
        // Meteora DLMM: 17+ accounts (15 fixed + 1 program + bin arrays)
        // Must match arb-router/programs/arb-router/src/dex/meteora.rs expected order:
        // 0: LBPair, 1: BitmapExt, 2-3: Reserves, 4-5: UserTokens, 6-7: Mints,
        // 8: Oracle, 9: HostFee, 10: User, 11: TokenXProgram, 12: TokenYProgram,
        // 13: Memo, 14: EventAuth, 15: Program, 16+: BinArrays
        const meteoraEventAuthority = deriveMeteoraDlmmEventAuthority();
        
        // Get token programs from hop (set by resolver from pool cache)
        const tokenXProgram = tokenProgramLabelToKey((hop as any).tokenProgramA);
        const tokenYProgram = tokenProgramLabelToKey((hop as any).tokenProgramB);
        
        accounts.push(
          poolId,                                                              // 0: LB Pair
          hop.bitmapExtension 
            ? new PublicKey(hop.bitmapExtension) 
            : programIdKey,                                                    // 1: Bitmap Extension (use program ID as placeholder)
          hop.reserveX ? new PublicKey(hop.reserveX) : new PublicKey(hop.vaultA || hop.poolId), // 2: Reserve X
          hop.reserveY ? new PublicKey(hop.reserveY) : new PublicKey(hop.vaultB || hop.poolId), // 3: Reserve Y
          userSourceAta,                                                       // 4: User Token In
          userDestAta,                                                         // 5: User Token Out
          poolMintA ? new PublicKey(poolMintA) : inputMint,                   // 6: Token X Mint
          poolMintB ? new PublicKey(poolMintB) : outputMint,                  // 7: Token Y Mint
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
        break;

      case DexType.Orca:
        // Orca Whirlpool: 15 accounts
        // 0: TokenProgram, 1: User, 2: Whirlpool, 3: UserTokenA, 4: VaultA,
        // 5: UserTokenB, 6: VaultB, 7-9: TickArrays, 10: Oracle, 11-12: Mints, 13: Memo, 14: Program
        const userTokenA = isAtoB ? userSourceAta : userDestAta;
        const userTokenB = isAtoB ? userDestAta : userSourceAta;
        accounts.push(
          TOKEN_PROGRAM_ID,                                                    // 0: Token Program
          wallet,                                                              // 1: Token Authority (signer)
          poolId,                                                              // 2: Whirlpool
          userTokenA,                                                          // 3: Token Owner Account A
          hop.vaultA ? new PublicKey(hop.vaultA) : poolId,                    // 4: Token Vault A
          userTokenB,                                                          // 5: Token Owner Account B
          hop.vaultB ? new PublicKey(hop.vaultB) : poolId,                    // 6: Token Vault B
          hop.tickArrayLower ? new PublicKey(hop.tickArrayLower) : poolId,    // 7: Tick Array 0
          hop.tickArrayCenter ? new PublicKey(hop.tickArrayCenter) : poolId,  // 8: Tick Array 1
          hop.tickArrayUpper ? new PublicKey(hop.tickArrayUpper) : poolId,    // 9: Tick Array 2
          hop.oracle ? new PublicKey(hop.oracle) : poolId,                    // 10: Oracle
          poolMintA ? new PublicKey(poolMintA) : inputMint,                   // 11: Token Mint A
          poolMintB ? new PublicKey(poolMintB) : outputMint,                  // 12: Token Mint B
          MEMO_PROGRAM_ID,                                                     // 13: Memo Program
          programIdKey,                                                        // 14: Whirlpool Program
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
        accounts.push(
          globalConfig,                                                        // 0: Global Config
          (hop as any).protocolFeeRecipient 
            ? new PublicKey((hop as any).protocolFeeRecipient) 
            : programIdKey,                                                    // 1: Fee Recipient
          pumpMint,                                                            // 2: Mint (pump.fun token)
          poolId,                                                              // 3: Bonding Curve
          hop.vaultA ? new PublicKey(hop.vaultA) : poolId,                    // 4: BC Token Account
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

  // Ensure we have the expected number of accounts
  const expected = getAccountsNeededForDex(dexType);
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


