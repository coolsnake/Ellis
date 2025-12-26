/**
 * Test swap utilities for router integration testing
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from '../utils/logger.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../execution/raydiumTickArrays.js';
import { buildRouteSwapIx, dexNameToType, buildExecuteIx } from './sdk.js';
import { DexType, RouteStep } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Note: When using the on-chain router, we build DEX accounts manually.
// When calling DEX directly, we use the Raydium SDK for correct account ordering.

// ============================================================================
// Types
// ============================================================================

export interface TestSwapParams {
  connection: Connection;
  wallet: Keypair;
  poolId: string;
  dex: string;
  variant?: string;
  inputMint?: string;
  outputMint?: string;
  amountIn: bigint;
  minAmountOut: bigint;
  simulateOnly: boolean;
  /** Router program ID - if provided, swap goes through the on-chain router */
  routerProgramId?: string;
  // Multi-hop parameters
  hops?: number; // 1 or 2
  secondPoolId?: string;
  secondDex?: string;
  secondVariant?: string;
}

export interface TestSwapResult {
  success: boolean;
  simulated: boolean;
  signature?: string;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  poolAccounts?: Record<string, string>;
}

export interface RaydiumClmmPoolState {
  programId: string;
  ammConfig: string;
  vaultA: string;
  vaultB: string;
  mintA: string;
  mintB: string;
  observationId: string;
  tickCurrent: number;
  tickSpacing: number;
  tokenProgram: string; // Token program ID used by the vaults
  tickArrays: {
    lower: string;
    center: string;
    upper: string;
  };
}

export interface MeteoraDlmmPoolState {
  programId: string;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  oracle: string;
  activeId: number;
  binStep: number;
  tokenProgram: string;
  binArrays: string[];  // Array of bin array PDAs (typically 3: lower, current, upper)
  bitmapExtension?: string; // Optional - use program ID if not present
}

// Union type for pool states
export type PoolState = RaydiumClmmPoolState | MeteoraDlmmPoolState;

// Type guard to check if pool is Raydium
function isRaydiumPool(pool: PoolState): pool is RaydiumClmmPoolState {
  return 'ammConfig' in pool && 'tickArrays' in pool;
}

// Type guard to check if pool is Meteora
function isMeteoraDlmmPool(pool: PoolState): pool is MeteoraDlmmPoolState {
  return 'tokenXMint' in pool && 'binArrays' in pool && Array.isArray((pool as any).binArrays);
}

// ============================================================================
// Pool Account Fetching
// ============================================================================

export async function fetchPoolAccounts(params: {
  connection: Connection;
  poolId: string;
  dex: string;
  variant?: string;
}): Promise<{ success: boolean; pool?: PoolState; error?: string }> {
  const { connection, poolId, dex, variant } = params;

  try {
    const poolPubkey = new PublicKey(poolId);
    
    if (dex === 'raydium' && variant === 'clmm') {
      return await fetchRaydiumClmmPool(connection, poolPubkey);
    }
    
    if (dex === 'meteora' && variant === 'dlmm') {
      return await fetchMeteoraDlmmPool(connection, poolPubkey);
    }
    
    return { success: false, error: `Unsupported DEX: ${dex}/${variant}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fetchRaydiumClmmPool(
  connection: Connection, 
  poolPubkey: PublicKey
): Promise<{ success: boolean; pool?: RaydiumClmmPoolState; error?: string }> {
  const accountInfo = await connection.getAccountInfo(poolPubkey);
  
  if (!accountInfo || !accountInfo.data) {
    return { success: false, error: 'Pool account not found' };
  }

  try {
    const sdk = await import('@raydium-io/raydium-sdk-v2');
    const layout = (sdk as any).PoolInfoLayout || 
                   (sdk as any).Clmm?.PoolInfoLayout ||
                   (sdk as any).CLMM?.POOL_STATE_LAYOUT;
    
    if (!layout?.decode) {
      return { success: false, error: 'Raydium SDK layout not found' };
    }

    const state = layout.decode(accountInfo.data);
    
    // Get the program ID from the account owner (works for both devnet and mainnet)
    const programId = accountInfo.owner;
    
    const tickCurrent = Number(state.tickCurrent ?? state.tick_current);
    const tickSpacing = Number(state.tickSpacing ?? state.tick_spacing);
    
    // Derive tick arrays using the pool's program ID
    const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
    const delta = 60 * Math.max(1, tickSpacing);
    
    const [lower, center, upper] = await Promise.all([
      deriveTickArrayPda(programId, poolPubkey, centerStart - delta),
      deriveTickArrayPda(programId, poolPubkey, centerStart),
      deriveTickArrayPda(programId, poolPubkey, centerStart + delta),
    ]);

    // Determine token program by checking vault account owners
    const vaultA = new PublicKey(state.vaultA || state.tokenVault0 || state.tokenVaultA);
    const vaultB = new PublicKey(state.vaultB || state.tokenVault1 || state.tokenVaultB);
    
    const [vaultAInfo, vaultBInfo] = await Promise.all([
      connection.getAccountInfo(vaultA),
      connection.getAccountInfo(vaultB),
    ]);
    
    // Check which token program owns the vaults (use vaultA as primary, fallback to vaultB)
    let tokenProgramId = TOKEN_PROGRAM_ID;
    if (vaultAInfo) {
      const owner = vaultAInfo.owner.toBase58();
      if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
        tokenProgramId = TOKEN_2022_PROGRAM_ID;
      }
    } else if (vaultBInfo) {
      const owner = vaultBInfo.owner.toBase58();
      if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
        tokenProgramId = TOKEN_2022_PROGRAM_ID;
      }
    }

    const pool: RaydiumClmmPoolState = {
      programId: accountInfo.owner.toBase58(),
      ammConfig: new PublicKey(state.ammConfig || state.amm_config).toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      mintA: new PublicKey(state.mintA || state.tokenMint0 || state.mint0).toBase58(),
      mintB: new PublicKey(state.mintB || state.tokenMint1 || state.mint1).toBase58(),
      observationId: new PublicKey(state.observationId || state.observation_id || state.observationAccount).toBase58(),
      tickCurrent,
      tickSpacing,
      tokenProgram: tokenProgramId.toBase58(),
      tickArrays: {
        lower: lower.toBase58(),
        center: center.toBase58(),
        upper: upper.toBase58(),
      },
    };

    logger.info('router.test.pool.decoded', { cat: 'router', poolId: poolPubkey.toBase58(), pool });

    return { success: true, pool };
  } catch (err: any) {
    logger.error('router.test.pool.decode.error', { cat: 'router', error: err.message });
    return { success: false, error: `Failed to decode pool: ${err.message}` };
  }
}

// Helper to safely convert to PublicKey
function toPublicKeySafe(val: any): PublicKey | null {
  try {
    if (!val) return null;
    if (val instanceof PublicKey) return val;
    if (typeof val?.toBase58 === 'function') return val as PublicKey;
    if (typeof val === 'string' && val.length >= 32 && val.length <= 44) {
      return new PublicKey(val);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchMeteoraDlmmPool(
  connection: Connection, 
  poolPubkey: PublicKey
): Promise<{ success: boolean; pool?: MeteoraDlmmPoolState; error?: string }> {
  const accountInfo = await connection.getAccountInfo(poolPubkey);
  
  if (!accountInfo || !accountInfo.data) {
    return { success: false, error: 'Pool account not found' };
  }

  try {
    // Import Meteora SDK for decoding pool state
    const meteoraModule = await import('@meteora-ag/dlmm');
    const createProgram = (meteoraModule as any).createProgram;
    
    // Create program to decode pool state
    const program = createProgram(connection);
    if (!program?.coder?.accounts?.decode) {
      return { success: false, error: 'Meteora SDK program not available' };
    }
    
    const state = program.coder.accounts.decode('lbPair', accountInfo.data);
    if (!state) {
      return { success: false, error: 'Failed to decode Meteora pool state' };
    }
    
    // Extract mint PublicKeys directly (they're already PublicKey objects from SDK)
    const tokenXMintPk = toPublicKeySafe(state.tokenXMint);
    const tokenYMintPk = toPublicKeySafe(state.tokenYMint);
    
    if (!tokenXMintPk || !tokenYMintPk) {
      return { success: false, error: 'Failed to extract token mints from Meteora pool state' };
    }
    
    const tokenXMint = tokenXMintPk.toBase58();
    const tokenYMint = tokenYMintPk.toBase58();
    const activeId = Number(state.activeId ?? state.active_id);
    const binStep = Number(state.binStep ?? state.bin_step);
    
    const programId = accountInfo.owner;
    
    // Try to extract reserves and oracle directly from decoded state first
    // The lbPair account stores these addresses directly
    const reserveXFromState = toPublicKeySafe(state.reserveX);
    const reserveYFromState = toPublicKeySafe(state.reserveY);
    const oracleFromState = toPublicKeySafe(state.oracle);
    
    let reserveX = reserveXFromState?.toBase58() || '';
    let reserveY = reserveYFromState?.toBase58() || '';
    let oracle = oracleFromState?.toBase58() || '';
    
    logger.info('router.test.meteora.state_fields', { 
      cat: 'router', 
      hasReserveX: !!reserveXFromState, 
      hasReserveY: !!reserveYFromState,
      hasOracle: !!oracleFromState,
      reserveX,
      reserveY,
      oracle
    });
    
    // Fallback to PDA derivation only if not found in state
    if (!reserveX) {
      try {
        const [reserveXPda] = PublicKey.findProgramAddressSync(
          [poolPubkey.toBuffer(), tokenXMintPk.toBuffer()],
          programId
        );
        reserveX = reserveXPda.toBase58();
        logger.info('router.test.meteora.reserveX.derived', { cat: 'router', reserveX });
      } catch (e: any) {
        logger.warn('router.test.meteora.reserveX.derive.error', { cat: 'router', error: e.message });
      }
    }
    
    if (!reserveY) {
      try {
        const [reserveYPda] = PublicKey.findProgramAddressSync(
          [poolPubkey.toBuffer(), tokenYMintPk.toBuffer()],
          programId
        );
        reserveY = reserveYPda.toBase58();
        logger.info('router.test.meteora.reserveY.derived', { cat: 'router', reserveY });
      } catch (e: any) {
        logger.warn('router.test.meteora.reserveY.derive.error', { cat: 'router', error: e.message });
      }
    }
    
    if (!oracle) {
      try {
        const [oraclePda] = PublicKey.findProgramAddressSync(
          [Buffer.from('oracle'), poolPubkey.toBuffer()],
          programId
        );
        oracle = oraclePda.toBase58();
        logger.info('router.test.meteora.oracle.derived', { cat: 'router', oracle });
      } catch (e: any) {
        logger.warn('router.test.meteora.oracle.derive.error', { cat: 'router', error: e.message });
      }
    }
    
    // Derive bin arrays using direct PDA derivation
    // Meteora DLMM uses BIN_ARRAY_SIZE = 70
    // binArrayIndex = floor(binId / 70)
    const BIN_ARRAY_SIZE = 70;
    let binArrays: string[] = [];
    
    try {
      // Calculate the bin array index for the active bin
      // For negative numbers, we need floor division (towards negative infinity)
      const currentBinArrayIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
      
      // Derive bin array PDAs for current and adjacent indices
      const deriveBinArrayPda = (idx: number): string => {
        const idxBn = new BN(idx);
        const seed = idxBn.isNeg()
          ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
          : idxBn.toArrayLike(Buffer, 'le', 8);
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('bin_array'), poolPubkey.toBuffer(), Buffer.from(seed)],
          programId
        );
        return pda.toBase58();
      };
      
      // For swaps, we need the current bin array and potentially adjacent ones
      // The direction determines which adjacent bin arrays we need
      // For now, derive current + one on each side (3 total)
      binArrays = [
        deriveBinArrayPda(currentBinArrayIndex - 1),  // Lower adjacent
        deriveBinArrayPda(currentBinArrayIndex),       // Current
        deriveBinArrayPda(currentBinArrayIndex + 1),   // Upper adjacent
      ];
      
      logger.debug('router.test.meteora.binarrays.derived', { 
        cat: 'router', 
        activeId, 
        currentBinArrayIndex,
        binArrays 
      });
    } catch (err: any) {
      logger.warn('router.test.meteora.binarray.derive.error', { cat: 'router', error: err.message });
    }
    
    // Derive bitmap extension PDA and check if it exists
    let bitmapExtension: string | undefined;
    try {
      const [bitmapExtPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('BitmapExtension'), poolPubkey.toBuffer()],
        programId
      );
      // Check if the bitmap extension account exists on-chain
      const bitmapExtInfo = await connection.getAccountInfo(bitmapExtPda);
      if (bitmapExtInfo && bitmapExtInfo.owner.equals(programId)) {
        bitmapExtension = bitmapExtPda.toBase58();
        logger.info('router.test.meteora.bitmapExt.found', { cat: 'router', bitmapExtension });
      } else {
        logger.info('router.test.meteora.bitmapExt.not_found', { cat: 'router', pda: bitmapExtPda.toBase58() });
      }
    } catch (err: any) {
      logger.debug('router.test.meteora.bitmapExt.derive.error', { cat: 'router', error: err.message });
    }
    
    // Determine token program
    let tokenProgramId = TOKEN_PROGRAM_ID;
    if (reserveX) {
      try {
        const reserveInfo = await connection.getAccountInfo(new PublicKey(reserveX));
        if (reserveInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          tokenProgramId = TOKEN_2022_PROGRAM_ID;
        }
      } catch {}
    }

    const pool: MeteoraDlmmPoolState = {
      programId: accountInfo.owner.toBase58(),
      tokenXMint,
      tokenYMint,
      reserveX,
      reserveY,
      oracle,
      activeId,
      binStep,
      tokenProgram: tokenProgramId.toBase58(),
      binArrays,  // Array of bin array PDAs
      bitmapExtension,
    };

    logger.info('router.test.pool.decoded', { cat: 'router', poolId: poolPubkey.toBase58(), pool, dex: 'meteora_dlmm' });

    return { success: true, pool };
  } catch (err: any) {
    logger.error('router.test.meteora.pool.decode.error', { cat: 'router', error: err.message, stack: err.stack });
    return { success: false, error: `Failed to decode Meteora pool: ${err.message}` };
  }
}

// ============================================================================
// Swap Testing
// ============================================================================

export async function runSwapTest(params: TestSwapParams): Promise<TestSwapResult> {
  const { 
    connection, 
    wallet, 
    poolId, 
    dex, 
    variant, 
    inputMint, 
    outputMint, 
    amountIn, 
    minAmountOut,
    simulateOnly,
    routerProgramId,
    hops = 1,
    secondPoolId,
    secondDex,
    secondVariant,
  } = params;

  try {
    // Fetch first pool
    const poolResult = await fetchPoolAccounts({ connection, poolId, dex, variant });
    if (!poolResult.success || !poolResult.pool) {
      return { success: false, simulated: false, error: poolResult.error || 'Failed to fetch pool' };
    }
    const pool = poolResult.pool;

    // Determine mints for first hop (handle both Raydium and Meteora)
    let poolMintA: string;
    let poolMintB: string;
    
    if (isRaydiumPool(pool)) {
      poolMintA = pool.mintA;
      poolMintB = pool.mintB;
    } else if (isMeteoraDlmmPool(pool)) {
      poolMintA = pool.tokenXMint;
      poolMintB = pool.tokenYMint;
    } else {
      return { success: false, simulated: false, error: 'Unknown pool type' };
    }
    
    const inMint = inputMint ? new PublicKey(inputMint) : new PublicKey(poolMintA);
    const outMint = outputMint ? new PublicKey(outputMint) : new PublicKey(poolMintB);
    const isAtoB = inMint.toBase58() === poolMintA;

    let swapIxs: TransactionInstruction[] = [];

    if (routerProgramId) {
      const routerProgram = new PublicKey(routerProgramId);
      const dexType = dexNameToType(dex, variant);

      if (hops === 1) {
        // Single hop: use route_swap
        const dexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          outMint,
          dexType
        );

        const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey);
        const routerSwapIx = buildRouteSwapIx(
          wallet.publicKey,
          userInAta,
          {
            dexType,
            amountIn,
            minAmountOut,
            aToB: isAtoB,
          },
          dexAccounts,
          routerProgram
        );
        swapIxs = [routerSwapIx];
      } else if (hops === 2 && secondPoolId) {
        // Two hops: use execute instruction
        const secondPoolResult = await fetchPoolAccounts({ 
          connection, 
          poolId: secondPoolId, 
          dex: secondDex || dex, 
          variant: secondVariant || variant 
        });
        
        if (!secondPoolResult.success || !secondPoolResult.pool) {
          return { success: false, simulated: false, error: 'Failed to fetch second pool' };
        }
        const secondPool = secondPoolResult.pool;

        // Determine second pool mints
        let secondPoolMintA: string;
        if (isRaydiumPool(secondPool)) {
          secondPoolMintA = secondPool.mintA;
        } else if (isMeteoraDlmmPool(secondPool)) {
          secondPoolMintA = secondPool.tokenXMint;
        } else {
          return { success: false, simulated: false, error: 'Unknown second pool type' };
        }

        // Determine intermediate mint (output of first hop = input of second hop)
        const intermediateMint = outMint;
        const finalMint = inMint; // For round trip: SOL -> USDC -> SOL
        
        // Build steps for execute instruction
        
        const firstStep: RouteStep = {
          dexType: dexType,
          amountIn: amountIn, // Use specified amount for first hop
          minAmountOut: minAmountOut,
          aToB: isAtoB,
        };

        const secondIsAtoB = intermediateMint.toBase58() === secondPoolMintA;
        const secondDexType = dexNameToType(secondDex || dex, secondVariant || variant);
        
        const secondStep: RouteStep = {
          dexType: secondDexType,
          amountIn: 0n, // 0 = use all from previous step (amount propagation)
          minAmountOut: 1n, // Minimum output for second hop
          aToB: secondIsAtoB,
        };

        // Build DEX accounts for both hops
        const firstDexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          intermediateMint,
          dexType
        );

        const secondDexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          secondPool,
          new PublicKey(secondPoolId),
          intermediateMint,
          finalMint,
          secondDexType
        );

        // Verify token accounts are correct
        const userIntermediateAta = getAssociatedTokenAddressSync(intermediateMint, wallet.publicKey);
        const userFinalAta = getAssociatedTokenAddressSync(finalMint, wallet.publicKey);
        
        logger.info('router.test.multi_hop.accounts', {
          cat: 'router',
          firstStep: {
            inputMint: inMint.toBase58(),
            outputMint: intermediateMint.toBase58(),
            inputAta: getAssociatedTokenAddressSync(inMint, wallet.publicKey).toBase58(),
            outputAta: userIntermediateAta.toBase58(),
            dexAccountAtIndex3: firstDexAccounts[3]?.toBase58(),
          },
          secondStep: {
            inputMint: intermediateMint.toBase58(),
            outputMint: finalMint.toBase58(),
            inputAta: userIntermediateAta.toBase58(),
            outputAta: userFinalAta.toBase58(),
            dexAccountAtIndex3: secondDexAccounts[3]?.toBase58(),
            expectedToMatch: userIntermediateAta.toBase58(),
          },
        });

        // Combine all DEX accounts - each step needs its own complete set including program ID
        const allDexAccounts = [
          ...firstDexAccounts,  // All 18 accounts for first hop
          ...secondDexAccounts, // All 18 accounts for second hop
        ];

        const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey);
        const executeIx = buildExecuteIx(
          wallet.publicKey,
          userInAta,
          {
            steps: [firstStep, secondStep],
            minProfit: -1000000000n, // Allow large loss for testing (fees will cause loss in round-trip swaps)
          },
          allDexAccounts,
          routerProgram
        );
        swapIxs = [executeIx];
      } else {
        return { success: false, simulated: false, error: 'Invalid hops configuration' };
      }
    } else {
      // Direct mode (not using router) - single hop only for now
      if (hops !== 1) {
        return { success: false, simulated: false, error: 'Multi-hop only supported with router' };
      }
      
      if (dex === 'raydium' && variant === 'clmm' && isRaydiumPool(pool)) {
        swapIxs = await buildRaydiumClmmSwapIxWithSdk(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          outMint,
          amountIn,
          minAmountOut
        );
        
        if (!swapIxs.length) {
          return { success: false, simulated: false, error: 'SDK failed to generate swap instructions' };
        }
      } else {
        return { success: false, simulated: false, error: `Unsupported DEX for direct mode: ${dex}/${variant}` };
      }
    }

    // Build transaction with setup instructions
    const tx = new Transaction();
    
    // Detect token programs for mints (needed for ATA creation)
    const [inMintInfo, outMintInfo] = await Promise.all([
      connection.getAccountInfo(inMint),
      connection.getAccountInfo(outMint),
    ]);
    
    const inMintTokenProgram = inMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) 
      ? TOKEN_2022_PROGRAM_ID 
      : TOKEN_PROGRAM_ID;
    const outMintTokenProgram = outMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    
    // Ensure user has ATAs (use correct token program for each mint)
    const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey, false, inMintTokenProgram);
    const userOutAta = getAssociatedTokenAddressSync(outMint, wallet.publicKey, false, outMintTokenProgram);
    
    // For multi-hop, also ensure intermediate token account exists
    let intermediateAta: PublicKey | undefined;
    if (hops === 2 && routerProgramId) {
      const intermediateMint = outMint; // For round-trip, intermediate is the output of first hop
      const intermediateMintInfo = await connection.getAccountInfo(intermediateMint);
      const intermediateMintTokenProgram = intermediateMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) 
        ? TOKEN_2022_PROGRAM_ID 
        : TOKEN_PROGRAM_ID;
      intermediateAta = getAssociatedTokenAddressSync(intermediateMint, wallet.publicKey, false, intermediateMintTokenProgram);
      
      const intermediateAtaInfo = await connection.getAccountInfo(intermediateAta);
      if (!intermediateAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          wallet.publicKey, intermediateAta, wallet.publicKey, intermediateMint, intermediateMintTokenProgram
        ));
      }
    }

    const [inAtaInfo, outAtaInfo] = await Promise.all([
      connection.getAccountInfo(userInAta),
      connection.getAccountInfo(userOutAta),
    ]);
    
    if (!inAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userInAta, wallet.publicKey, inMint, inMintTokenProgram
      ));
    }
    
    // If input is SOL, always wrap the required amount (even if account exists)
    if (inMint.equals(NATIVE_MINT)) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userInAta,
          lamports: Number(amountIn) + 10000, // Add extra for fees
        }),
        createSyncNativeInstruction(userInAta, inMintTokenProgram)
      );
    }
    
    if (!outAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userOutAta, wallet.publicKey, outMint, outMintTokenProgram
      ));
    }
    
    // Add swap instructions from SDK
    for (const ix of swapIxs) {
      tx.add(ix);
    }
    
    // Set recent blockhash and fee payer
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;

    if (simulateOnly) {
      // Simulate transaction
      const simulation = await connection.simulateTransaction(tx, [wallet]);
      
      // Build pool accounts based on pool type
      let poolAccounts: Record<string, string>;
      if (isRaydiumPool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'raydium_clmm',
          ammConfig: pool.ammConfig,
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
          mintA: pool.mintA,
          mintB: pool.mintB,
          observation: pool.observationId,
          tickArrayLower: pool.tickArrays.lower,
          tickArrayCenter: pool.tickArrays.center,
          tickArrayUpper: pool.tickArrays.upper,
        };
      } else if (isMeteoraDlmmPool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'meteora_dlmm',
          tokenXMint: pool.tokenXMint,
          tokenYMint: pool.tokenYMint,
          reserveX: pool.reserveX,
          reserveY: pool.reserveY,
          oracle: pool.oracle,
          activeId: String(pool.activeId),
          binStep: String(pool.binStep),
          binArrays: JSON.stringify(pool.binArrays),
        };
      } else {
        poolAccounts = { pool: poolId };
      }
      
      return {
        success: !simulation.value.err,
        simulated: true,
        error: simulation.value.err ? JSON.stringify(simulation.value.err) : undefined,
        logs: simulation.value.logs || [],
        unitsConsumed: simulation.value.unitsConsumed,
        poolAccounts,
      };
    } else {
      // Execute transaction
      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );
      
      // Build pool accounts based on pool type
      let poolAccounts: Record<string, string>;
      if (isRaydiumPool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'raydium_clmm',
          ammConfig: pool.ammConfig,
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
        };
      } else if (isMeteoraDlmmPool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'meteora_dlmm',
          reserveX: pool.reserveX,
          reserveY: pool.reserveY,
        };
      } else {
        poolAccounts = { pool: poolId };
      }
      
      return {
        success: true,
        simulated: false,
        signature,
        poolAccounts,
      };
    }
  } catch (err: any) {
    logger.error('router.test.swap.error', { cat: 'router', error: err.message, stack: err.stack });
    return { 
      success: false, 
      simulated: params.simulateOnly, 
      error: err.message,
      logs: err.logs || [],
    };
  }
}

async function buildRaydiumClmmSwapIxWithSdk(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<TransactionInstruction[]> {
  const isAtoB = inputMint.toBase58() === pool.mintA;
  
  const userInAta = getAssociatedTokenAddressSync(inputMint, payer);
  const userOutAta = getAssociatedTokenAddressSync(outputMint, payer);
  
  // Use Raydium SDK to build swap instruction with correct account order
  // The SDK handles different program versions (devnet vs mainnet) automatically
  const sdk = await import('@raydium-io/raydium-sdk-v2');
  const { ClmmInstrument } = sdk;
  
  const amountInBn = new BN(amountIn.toString());
  const minOutBn = new BN(minAmountOut.toString());
  
  // Construct pool info for SDK
  const mintAInfo = {
    address: pool.mintA,
    decimals: 9, // SOL decimals (will be ignored for swap calculation)
    programId: pool.tokenProgram,
  };
  const mintBInfo = {
    address: pool.mintB,
    decimals: 6, // USDC decimals (will be ignored for swap calculation)
    programId: pool.tokenProgram,
  };
  
  const poolInfo = {
    id: poolPubkey.toBase58(),
    programId: pool.programId,
    mintA: mintAInfo,
    mintB: mintBInfo,
    config: {
      id: pool.ammConfig,
      index: 0,
      protocolFeeRate: 0,
      tradeFeeRate: 0,
      tickSpacing: pool.tickSpacing,
      fundFeeRate: 0,
      defaultRange: 0,
      defaultRangePoint: [],
    },
  };
  
  const poolKeys = {
    id: poolPubkey.toBase58(),
    programId: pool.programId,
    mintA: mintAInfo,
    mintB: mintBInfo,
    vault: {
      A: pool.vaultA,
      B: pool.vaultB,
    },
    observationId: pool.observationId,
    config: poolInfo.config,
    rewardInfos: [],
  };
  
  const ownerInfo = {
    wallet: payer,
    tokenAccountA: isAtoB ? userInAta : userOutAta,
    tokenAccountB: isAtoB ? userOutAta : userInAta,
  };
  
  // Get tick array PDAs - ORDER MATTERS based on swap direction
  // A→B: price moves down (tick decreases), need arrays in descending order
  // B→A: price moves up (tick increases), need arrays in ascending order
  const tickArrayKeys = isAtoB
    ? [
        new PublicKey(pool.tickArrays.center),
        new PublicKey(pool.tickArrays.lower),
        new PublicKey(pool.tickArrays.upper),
      ]
    : [
        new PublicKey(pool.tickArrays.center),
        new PublicKey(pool.tickArrays.upper),
        new PublicKey(pool.tickArrays.lower),
      ];
  
  const observationId = new PublicKey(pool.observationId);
  
  // Use SDK to generate instructions with correct account order
  // The SDK knows the correct structure for each program version
  const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
    poolInfo,
    poolKeys,
    observationId,
    ownerInfo,
    inputMint,
    amountIn: amountInBn,
    amountOutMin: minOutBn,
    sqrtPriceLimitX64: new BN(0),
    remainingAccounts: tickArrayKeys,
  });
  
  const ixs = Array.isArray(res?.instructions) 
    ? res.instructions 
    : (res?.innerTransaction?.instructions || []);
  
  logger.info('router.test.sdk.instructions', { 
    cat: 'router', 
    poolId: poolPubkey.toBase58(),
    instructionCount: ixs.length,
    programId: pool.programId,
  });
  
  return ixs;
}

async function getRaydiumSdkAccountOrder(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<PublicKey[]> {
  // Generate instruction using SDK to see the correct order
  const sdkIxs = await buildRaydiumClmmSwapIxWithSdk(
    payer,
    pool,
    poolPubkey,
    inputMint,
    outputMint,
    amountIn,
    minAmountOut
  );
  
  if (!sdkIxs || sdkIxs.length === 0) {
    throw new Error('Failed to generate SDK instruction');
  }
  
  // Get the swap instruction (usually the first one)
  const swapIx = sdkIxs.find(ix => 
    ix.programId.toBase58() === pool.programId
  ) || sdkIxs[0];
  
  // Extract account order (excluding the program ID)
  const accountOrder = swapIx.keys.map(key => key.pubkey);
  
  logger.info('router.test.sdk.account_order', {
    cat: 'router',
    accountCount: accountOrder.length,
    accounts: accountOrder.map((acc, idx) => ({
      index: idx,
      address: acc.toBase58(),
      isSigner: swapIx.keys[idx].isSigner,
      isWritable: swapIx.keys[idx].isWritable,
    })),
  });
  
  return accountOrder;
}

/**
 * Build DEX accounts in the order expected by the on-chain arb-router
 * 
 * For Raydium CLMM, the router expects 18 accounts (17 + program ID):
 * 0. Payer (signer)
 * 1. AMM Config
 * 2. Pool State
 * 3. Input Token Account (user)
 * 4. Output Token Account (user)
 * 5. Input Vault
 * 6. Output Vault
 * 7. Observation State
 * 8. Token Program
 * 9. Token-2022 Program
 * 10. Memo Program
 * 11. Input Token Mint
 * 12. Output Token Mint
 * 13. Oracle/exBitmap
 * 14. Tick Array Center
 * 15. Tick Array Lower
 * 16. Tick Array Upper
 * 17. Raydium CLMM Program
 * 
 * For Meteora DLMM, the router expects 18 accounts:
 * 0. LB Pair
 * 1. Bitmap Extension (optional, use program ID as placeholder)
 * 2. Reserve X (token vault)
 * 3. Reserve Y (token vault)
 * 4. User Token In
 * 5. User Token Out
 * 6. Token X Mint
 * 7. Token Y Mint
 * 8. Oracle
 * 9. Host Fee In (program ID as placeholder)
 * 10. User (signer)
 * 11. Token X Program
 * 12. Token Y Program
 * 13. Memo Program
 * 14. Event Authority
 * 15. Bin Array Lower (remaining account)
 * 16. Bin Array Upper (remaining account)
 * 17. Meteora DLMM Program (for CPI invoke, must be last)
 */
async function buildDexAccountsForRouter(
  payer: PublicKey,
  pool: PoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  dexType: DexType
): Promise<PublicKey[]> {
  if (dexType === DexType.Raydium && isRaydiumPool(pool)) {
    // Use SDK to get the correct account order
    const sdkAccountOrder = await getRaydiumSdkAccountOrder(
      payer,
      pool,
      poolPubkey,
      inputMint,
      outputMint,
      BigInt(1000000),
      BigInt(900000)
    );
    
    // Add the Raydium program ID as the last account (needed for CPI)
    const dexProgramId = new PublicKey(pool.programId);
    const accounts = [...sdkAccountOrder, dexProgramId];
    
    logger.info('router.test.dex_accounts', { 
      cat: 'router', 
      accountCount: accounts.length,
      dexType: 'raydium_clmm',
      isAtoB: inputMint.toBase58() === pool.mintA,
    });
    
    return accounts;
  }
  
  if (dexType === DexType.Meteora && isMeteoraDlmmPool(pool)) {
    return buildMeteoraDexAccountsForRouter(payer, pool, poolPubkey, inputMint, outputMint);
  }
  
  throw new Error(`DEX type ${dexType} not supported for router test`);
}

/**
 * Derive Meteora DLMM Event Authority PDA
 */
function deriveMeteoraDlmmEventAuthority(): PublicKey {
  const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    METEORA_DLMM_PROGRAM
  );
  return eventAuthority;
}

/**
 * Build Meteora DLMM accounts in the order expected by the on-chain router
 * 
 * Based on successful swap transaction analysis:
 * #1-15: Fixed accounts (0-14 in our 0-indexed array)
 * #16: Meteora Program (included for CPI invoke)
 * #17+: Bin arrays (remaining accounts)
 */
async function buildMeteoraDexAccountsForRouter(
  payer: PublicKey,
  pool: MeteoraDlmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey
): Promise<PublicKey[]> {
  const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  
  // Determine swap direction (X -> Y or Y -> X)
  const isXtoY = inputMint.toBase58() === pool.tokenXMint;
  
  // Get user token accounts
  const userTokenIn = getAssociatedTokenAddressSync(inputMint, payer);
  const userTokenOut = getAssociatedTokenAddressSync(outputMint, payer);
  
  // Helper to safely convert to PublicKey with fallback
  const toPkOrFallback = (val: string | undefined, fallback: PublicKey): PublicKey => {
    if (!val || val === '') return fallback;
    try {
      return new PublicKey(val);
    } catch {
      return fallback;
    }
  };
  
  const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  
  // Fixed accounts (indices 0-14)
  const fixedAccounts: PublicKey[] = [
    poolPubkey,                                                    // 0: LB Pair
    pool.bitmapExtension 
      ? new PublicKey(pool.bitmapExtension) 
      : METEORA_DLMM_PROGRAM,                                      // 1: Bitmap Extension (use program ID as fallback)
    toPkOrFallback(pool.reserveX, poolPubkey),                     // 2: Reserve X
    toPkOrFallback(pool.reserveY, poolPubkey),                     // 3: Reserve Y
    userTokenIn,                                                   // 4: User Token In
    userTokenOut,                                                  // 5: User Token Out
    new PublicKey(pool.tokenXMint),                                // 6: Token X Mint
    new PublicKey(pool.tokenYMint),                                // 7: Token Y Mint
    toPkOrFallback(pool.oracle, poolPubkey),                       // 8: Oracle
    METEORA_DLMM_PROGRAM,                                          // 9: Host Fee In (program ID as placeholder)
    payer,                                                         // 10: User (signer)
    new PublicKey(pool.tokenProgram),                              // 11: Token X Program
    new PublicKey(pool.tokenProgram),                              // 12: Token Y Program
    MEMO_PROGRAM,                                                  // 13: Memo Program
    deriveMeteoraDlmmEventAuthority(),                             // 14: Event Authority (PDA)
  ];
  
  // Bin arrays (remaining accounts) - use all available bin arrays
  const binArrayAccounts: PublicKey[] = pool.binArrays
    .filter((ba: string) => ba && ba !== '')
    .map((ba: string) => new PublicKey(ba));
  
  // Structure: [fixed accounts (15), program (1), bin arrays (N)]
  // Program is included for CPI invoke
  const accounts: PublicKey[] = [
    ...fixedAccounts,                                              // 0-14: Fixed accounts
    METEORA_DLMM_PROGRAM,                                          // 15: Meteora DLMM Program
    ...binArrayAccounts,                                           // 16+: Bin arrays
  ];
  
  logger.info('router.test.dex_accounts', { 
    cat: 'router', 
    accountCount: accounts.length,
    fixedCount: fixedAccounts.length,
    binArrayCount: binArrayAccounts.length,
    dexType: 'meteora_dlmm',
    isXtoY,
    accounts: accounts.map((acc, i) => ({ index: i, address: acc.toBase58() })),
  });
  
  return accounts;
}

