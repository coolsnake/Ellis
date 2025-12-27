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
import { getTokenMeta } from '../execution/resolver/tokenMeta.js';

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

export interface BinArrayInfo {
  index: number;  // The bin array index (e.g., -95, -94)
  address: string;
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
  binArrays: BinArrayInfo[];  // Array of bin array PDAs with their indices
  bitmapExtension?: string; // Optional - use program ID if not present
}

export interface OrcaWhirlpoolPoolState {
  programId: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  oracle: string;
  tickCurrentIndex: number;
  tickSpacing: number;
  tokenProgram: string;
  tickArrays: {
    lower: string;
    center: string;
    upper: string;
  };
}

// Union type for pool states
export type PoolState = RaydiumClmmPoolState | MeteoraDlmmPoolState | OrcaWhirlpoolPoolState;

// Type guard to check if pool is Raydium
function isRaydiumPool(pool: PoolState): pool is RaydiumClmmPoolState {
  return 'ammConfig' in pool && 'tickArrays' in pool;
}

// Type guard to check if pool is Meteora
function isMeteoraDlmmPool(pool: PoolState): pool is MeteoraDlmmPoolState {
  return 'tokenXMint' in pool && 'binArrays' in pool && Array.isArray((pool as any).binArrays);
}

// Type guard to check if pool is Orca Whirlpool
function isOrcaWhirlpool(pool: PoolState): pool is OrcaWhirlpoolPoolState {
  return 'mintA' in pool && 'mintB' in pool && 'tickArrays' in pool && !('ammConfig' in pool) && !('tokenXMint' in pool);
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
    
    if (dex === 'orca' && (variant === 'whirlpool' || !variant)) {
      return await fetchOrcaWhirlpoolPool(connection, poolPubkey);
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
    
    // Try to extract reserves, oracle, and bitmap extension directly from decoded state first
    // The lbPair account stores these addresses directly
    const reserveXFromState = toPublicKeySafe(state.reserveX);
    const reserveYFromState = toPublicKeySafe(state.reserveY);
    const oracleFromState = toPublicKeySafe(state.oracle);
    const bitmapExtFromState = toPublicKeySafe(state.binArrayBitmapExtension);
    
    let reserveX = reserveXFromState?.toBase58() || '';
    let reserveY = reserveYFromState?.toBase58() || '';
    let oracle = oracleFromState?.toBase58() || '';
    let bitmapExtension: string | undefined = bitmapExtFromState?.toBase58();
    
    logger.info('router.test.meteora.sdk_decode', { 
      cat: 'router',
      poolId: poolPubkey.toBase58(),
      // Raw SDK field values (before extraction)
      sdkFields: {
        tokenXMint: state.tokenXMint?.toBase58?.() || String(state.tokenXMint || ''),
        tokenYMint: state.tokenYMint?.toBase58?.() || String(state.tokenYMint || ''),
        reserveX: state.reserveX?.toBase58?.() || String(state.reserveX || ''),
        reserveY: state.reserveY?.toBase58?.() || String(state.reserveY || ''),
      },
      // What we extracted
      extracted: {
        tokenXMint,
        tokenYMint,
        reserveX,
        reserveY,
        oracle,
        bitmapExtension: bitmapExtension || 'not_in_state',
      },
      // Field presence
      hasFields: {
        reserveX: !!reserveXFromState,
        reserveY: !!reserveYFromState,
        oracle: !!oracleFromState,
        bitmapExt: !!bitmapExtFromState,
      },
      // Check for any mismatch between raw SDK and extraction
      extractionValid: {
        reserveXMatch: reserveX === (state.reserveX?.toBase58?.() || ''),
        reserveYMatch: reserveY === (state.reserveY?.toBase58?.() || ''),
        tokenXMintMatch: tokenXMint === (state.tokenXMint?.toBase58?.() || ''),
        tokenYMintMatch: tokenYMint === (state.tokenYMint?.toBase58?.() || ''),
      },
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
    let binArrays: BinArrayInfo[] = [];
    
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
      
      // Derive a wider range of bin arrays around the active bin
      // This ensures we have enough coverage for swaps in either direction:
      // - X -> Y swaps (price moves down): need bin arrays with lower indices (more negative)
      // - Y -> X swaps (price moves up): need bin arrays with higher indices (more positive)
      // Using a range of ±3 gives us 7 bin arrays total, which should cover most swaps
      const BIN_ARRAY_RANGE = 3; // Derive 3 bin arrays on each side of active (7 total)
      const derivedBinArrays: Array<{ index: number; address: string }> = [];
      
      for (let i = currentBinArrayIndex - BIN_ARRAY_RANGE; i <= currentBinArrayIndex + BIN_ARRAY_RANGE; i++) {
        try {
          const address = deriveBinArrayPda(i);
          derivedBinArrays.push({ index: i, address });
        } catch (err: any) {
          // Skip invalid derivations
          logger.debug('router.test.meteora.binarray.derive.skip', { 
            cat: 'router', 
            index: i, 
            error: err.message 
          });
        }
      }
      
      // Check which bin arrays actually exist on-chain
      // Only include initialized bin arrays to avoid errors
      const binArrayPubkeys = derivedBinArrays.map(ba => new PublicKey(ba.address));
      const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayPubkeys);
      
      const existingBinArrays: BinArrayInfo[] = [];
      binArrayInfos.forEach((info, idx) => {
        if (info && info.owner.equals(programId)) {
          existingBinArrays.push(derivedBinArrays[idx]);
        }
      });
      
      binArrays = existingBinArrays;
      
      logger.debug('router.test.meteora.binarrays.derived', { 
        cat: 'router', 
        activeId, 
        currentBinArrayIndex,
        derived: derivedBinArrays.map(ba => ({ index: ba.index, address: ba.address })),
        existing: binArrays.map(ba => ({ index: ba.index, address: ba.address })),
        existingCount: binArrays.length
      });
    } catch (err: any) {
      logger.warn('router.test.meteora.binarray.derive.error', { cat: 'router', error: err.message });
    }
    
    // Bitmap extension: prefer from pool state, fallback to PDA derivation
    // Some pools require an actual bitmap extension for wide price ranges
    if (!bitmapExtension) {
      try {
        const [bitmapExtPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('BitmapExtension'), poolPubkey.toBuffer()],
          programId
        );
        // Check if the bitmap extension account exists on-chain
        const bitmapExtInfo = await connection.getAccountInfo(bitmapExtPda);
        if (bitmapExtInfo && bitmapExtInfo.owner.equals(programId)) {
          bitmapExtension = bitmapExtPda.toBase58();
          logger.info('router.test.meteora.bitmapExt.derived_and_found', { cat: 'router', bitmapExtension });
        } else {
          logger.info('router.test.meteora.bitmapExt.not_found', { cat: 'router', pda: bitmapExtPda.toBase58() });
        }
      } catch (err: any) {
        logger.debug('router.test.meteora.bitmapExt.derive.error', { cat: 'router', error: err.message });
      }
    } else {
      logger.info('router.test.meteora.bitmapExt.from_state', { cat: 'router', bitmapExtension });
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

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

async function fetchOrcaWhirlpoolPool(
  connection: Connection, 
  poolPubkey: PublicKey
): Promise<{ success: boolean; pool?: OrcaWhirlpoolPoolState; error?: string }> {
  const accountInfo = await connection.getAccountInfo(poolPubkey);
  
  if (!accountInfo || !accountInfo.data) {
    return { success: false, error: 'Pool account not found' };
  }

  try {
    // Whirlpool account layout (simplified):
    // 8: discriminator
    // 32: whirlpoolsConfig
    // 1: whirlpoolBump[0]
    // 2: tickSpacing (u16)
    // 2: tickSpacingSeed[0..2]
    // 2: feeRate (u16)
    // 2: protocolFeeRate (u16)
    // 16: liquidity (u128)
    // 16: sqrtPrice (u128)
    // 4: tickCurrentIndex (i32)
    // 8: protocolFeeOwedA (u64)
    // 8: protocolFeeOwedB (u64)
    // 32: tokenMintA
    // 32: tokenVaultA
    // 16: feeGrowthGlobalA (u128)
    // 32: tokenMintB
    // 32: tokenVaultB
    // 16: feeGrowthGlobalB (u128)
    // ...
    
    // Convert to Buffer to ensure we have Buffer methods
    const data = Buffer.from(accountInfo.data);
    let offset = 8; // Skip discriminator
    
    // whirlpoolsConfig (32 bytes)
    offset += 32;
    
    // whirlpoolBump (1 byte)
    offset += 1;
    
    // tickSpacing (2 bytes, u16 LE)
    const tickSpacing = data.readUInt16LE(offset);
    offset += 2;
    
    // tickSpacingSeed (2 bytes)
    offset += 2;
    
    // feeRate (2 bytes)
    offset += 2;
    
    // protocolFeeRate (2 bytes)
    offset += 2;
    
    // liquidity (16 bytes, u128)
    offset += 16;
    
    // sqrtPrice (16 bytes, u128)
    offset += 16;
    
    // tickCurrentIndex (4 bytes, i32 LE)
    const tickCurrentIndex = data.readInt32LE(offset);
    offset += 4;
    
    // protocolFeeOwedA (8 bytes)
    offset += 8;
    
    // protocolFeeOwedB (8 bytes)
    offset += 8;
    
    // tokenMintA (32 bytes)
    const mintA = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // tokenVaultA (32 bytes)
    const vaultA = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // feeGrowthGlobalA (16 bytes, u128)
    offset += 16;
    
    // tokenMintB (32 bytes)
    const mintB = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // tokenVaultB (32 bytes)
    const vaultB = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // Derive oracle PDA: ["oracle", whirlpool.key()]
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('oracle'), poolPubkey.toBuffer()],
      ORCA_WHIRLPOOL_PROGRAM
    );
    
    // Derive tick array PDAs using same formula as Orca SDK
    // getStartTickIndex formula: floor(tickIndex / ticksInArray) * ticksInArray + (offset * ticksInArray)
    const TICK_ARRAY_SIZE = 88;
    const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
    
    // Calculate start tick index for the current tick (offset 0)
    const realIndex = Math.floor(tickCurrentIndex / ticksInArray);
    const startTickLower = (realIndex - 1) * ticksInArray;   // offset -1
    const startTickCenter = realIndex * ticksInArray;         // offset 0
    const startTickUpper = (realIndex + 1) * ticksInArray;   // offset +1
    
    const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
      const startTickBuffer = Buffer.alloc(4);
      startTickBuffer.writeInt32LE(startTickIndex, 0);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('tick_array'), poolPubkey.toBuffer(), startTickBuffer],
        ORCA_WHIRLPOOL_PROGRAM
      );
      return pda;
    };
    
    const tickArrayLower = deriveTickArrayPda(startTickLower);
    const tickArrayCenter = deriveTickArrayPda(startTickCenter);
    const tickArrayUpper = deriveTickArrayPda(startTickUpper);
    
    // Check which tick arrays actually exist on-chain
    const tickArraysToCheck = [tickArrayLower, tickArrayCenter, tickArrayUpper];
    const tickArrayInfos = await connection.getMultipleAccountsInfo(tickArraysToCheck);
    
    const tickArrayExists = {
      lower: tickArrayInfos[0] !== null && tickArrayInfos[0].data.length > 0,
      center: tickArrayInfos[1] !== null && tickArrayInfos[1].data.length > 0,
      upper: tickArrayInfos[2] !== null && tickArrayInfos[2].data.length > 0,
    };
    
    logger.info('router.test.orca.tickarrays.derived', {
      cat: 'router',
      tickCurrentIndex,
      tickSpacing,
      ticksInArray,
      realIndex,
      startTickLower,
      startTickCenter,
      startTickUpper,
      lower: tickArrayLower.toBase58(),
      center: tickArrayCenter.toBase58(),
      upper: tickArrayUpper.toBase58(),
      exists: tickArrayExists,
    });
    
    // If center tick array doesn't exist, this pool can't be traded at current tick
    if (!tickArrayExists.center) {
      logger.error('router.test.orca.tickarray.center.missing', {
        cat: 'router',
        poolId: poolPubkey.toBase58(),
        tickCurrentIndex,
        startTickCenter,
        centerAddress: tickArrayCenter.toBase58(),
        error: 'Center tick array not initialized - pool may have no liquidity at current tick',
      });
    }
    
    // Determine token program by checking vault account
    let tokenProgramId = TOKEN_PROGRAM_ID;
    try {
      const vaultInfo = await connection.getAccountInfo(vaultA);
      if (vaultInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        tokenProgramId = TOKEN_2022_PROGRAM_ID;
      }
    } catch {}

    const pool: OrcaWhirlpoolPoolState = {
      programId: accountInfo.owner.toBase58(),
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      oracle: oraclePda.toBase58(),
      tickCurrentIndex,
      tickSpacing,
      tokenProgram: tokenProgramId.toBase58(),
      tickArrays: {
        lower: tickArrayLower.toBase58(),
        center: tickArrayCenter.toBase58(),
        upper: tickArrayUpper.toBase58(),
      },
    };

    logger.info('router.test.pool.decoded', { 
      cat: 'router', 
      poolId: poolPubkey.toBase58(), 
      pool, 
      dex: 'orca_whirlpool',
      tickCurrentIndex,
      tickSpacing,
    });

    return { success: true, pool };
  } catch (err: any) {
    logger.error('router.test.orca.pool.decode.error', { cat: 'router', error: err.message, stack: err.stack });
    return { success: false, error: `Failed to decode Orca pool: ${err.message}` };
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

    // Determine mints for first hop (handle Raydium, Meteora, and Orca)
    let poolMintA: string;
    let poolMintB: string;
    
    if (isRaydiumPool(pool)) {
      poolMintA = pool.mintA;
      poolMintB = pool.mintB;
    } else if (isMeteoraDlmmPool(pool)) {
      poolMintA = pool.tokenXMint;
      poolMintB = pool.tokenYMint;
    } else if (isOrcaWhirlpool(pool)) {
      poolMintA = pool.mintA;
      poolMintB = pool.mintB;
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
        } else if (isOrcaWhirlpool(secondPool)) {
          secondPoolMintA = secondPool.mintA;
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
    
    // Detect token programs for mints using cached token meta (handles Token-2022)
    const [inMeta, outMeta] = await Promise.all([
      getTokenMeta(inMint.toBase58()),
      getTokenMeta(outMint.toBase58()),
    ]);
    
    const inMintTokenProgram = inMeta.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const outMintTokenProgram = outMeta.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    
    // Ensure user has ATAs (use correct token program for each mint)
    const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey, false, inMintTokenProgram);
    const userOutAta = getAssociatedTokenAddressSync(outMint, wallet.publicKey, false, outMintTokenProgram);
    
    // For multi-hop, also ensure intermediate token account exists
    let intermediateAta: PublicKey | undefined;
    if (hops === 2 && routerProgramId) {
      const intermediateMint = outMint; // For round-trip, intermediate is the output of first hop
      const intermediateMeta = await getTokenMeta(intermediateMint.toBase58());
      const intermediateMintTokenProgram = intermediateMeta.program === 'token-2022' 
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
      } else if (isOrcaWhirlpool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'orca_whirlpool',
          mintA: pool.mintA,
          mintB: pool.mintB,
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
          oracle: pool.oracle,
          tickCurrentIndex: String(pool.tickCurrentIndex),
          tickSpacing: String(pool.tickSpacing),
          tickArrayLower: pool.tickArrays.lower,
          tickArrayCenter: pool.tickArrays.center,
          tickArrayUpper: pool.tickArrays.upper,
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
      } else if (isOrcaWhirlpool(pool)) {
        poolAccounts = {
          pool: poolId,
          dex: 'orca_whirlpool',
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
          oracle: pool.oracle,
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
 * 15. Meteora DLMM Program (for CPI invoke)
 * 16. Bin Array Lower (remaining account)
 * 17. Bin Array Upper (remaining account)
 * 
 * For Orca Whirlpool, the router expects 12 accounts:
 * 0. Token Program
 * 1. Token Authority (signer)
 * 2. Whirlpool
 * 3. Token Owner Account A
 * 4. Token Vault A
 * 5. Token Owner Account B
 * 6. Token Vault B
 * 7. Tick Array 0 (lower)
 * 8. Tick Array 1 (center)
 * 9. Tick Array 2 (upper)
 * 10. Oracle
 * 11. Whirlpool Program (for CPI)
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
    
    const isAtoB = inputMint.toBase58() === pool.mintA;
    logger.info('router.test.dex_accounts.raydium', { 
      cat: 'router',
      poolId: poolPubkey.toBase58(),
      poolState: {
        mintA: pool.mintA,
        mintB: pool.mintB,
        vaultA: pool.vaultA,
        vaultB: pool.vaultB,
        ammConfig: pool.ammConfig,
      },
      swapInfo: {
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        isAtoB,
      },
      accountCount: accounts.length,
      tickArrays: pool.tickArrays,
    });
    
    return accounts;
  }
  
  if (dexType === DexType.Meteora && isMeteoraDlmmPool(pool)) {
    return buildMeteoraDexAccountsForRouter(payer, pool, poolPubkey, inputMint, outputMint);
  }
  
  if (dexType === DexType.Orca && isOrcaWhirlpool(pool)) {
    return buildOrcaDexAccountsForRouter(payer, pool, poolPubkey, inputMint, outputMint);
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
 * Based on Meteora CPI example (dlmm::cpi::accounts::Swap):
 * #1-14: Fixed accounts (0-13 in our 0-indexed array)
 * #15: Meteora Program (included for CPI invoke)
 * #16+: Bin arrays (remaining accounts)
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
  
  // Fixed accounts (indices 0-14) - matches Meteora CPI accounts::Swap2 order
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
    MEMO_PROGRAM_ID,                                               // 13: Memo Program
    deriveMeteoraDlmmEventAuthority(),                             // 14: Event Authority (PDA)
  ];
  
  // Bin arrays (remaining accounts) - order based on swap direction
  // For X -> Y swaps (selling X): order by increasing bin array index
  // For Y -> X swaps (buying X): order by decreasing bin array index
  const sortedBinArrays = [...pool.binArrays]
    .filter((ba: BinArrayInfo) => ba && ba.address !== '')
    .sort((a, b) => isXtoY ? a.index - b.index : b.index - a.index);
  
  const binArrayAccounts: PublicKey[] = sortedBinArrays
    .map((ba: BinArrayInfo) => new PublicKey(ba.address));
  
  // Structure: [fixed accounts (15), program (1), bin arrays (N)]
  // Program is included for CPI invoke
  const accounts: PublicKey[] = [
    ...fixedAccounts,                                              // 0-14: Fixed accounts
    METEORA_DLMM_PROGRAM,                                          // 15: Meteora DLMM Program
    ...binArrayAccounts,                                           // 16+: Bin arrays
  ];
  
  // Log with detailed account comparison for debugging
  logger.info('router.test.dex_accounts.meteora', { 
    cat: 'router',
    poolId: poolPubkey.toBase58(),
    // Pool state (from SDK decode)
    poolState: {
      tokenXMint: pool.tokenXMint,
      tokenYMint: pool.tokenYMint,
      reserveX: pool.reserveX,
      reserveY: pool.reserveY,
      oracle: pool.oracle,
    },
    // What we're actually sending
    actualAccounts: {
      idx0_LBPair: accounts[0].toBase58(),
      idx1_BitmapExt: accounts[1].toBase58(),
      idx2_ReserveX: accounts[2].toBase58(),
      idx3_ReserveY: accounts[3].toBase58(),
      idx4_UserTokenIn: accounts[4].toBase58(),
      idx5_UserTokenOut: accounts[5].toBase58(),
      idx6_TokenXMint: accounts[6].toBase58(),
      idx7_TokenYMint: accounts[7].toBase58(),
      idx8_Oracle: accounts[8].toBase58(),
    },
    // Swap direction info
    swapInfo: {
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      isXtoY,
    },
    // Verify reserves match pool state (should all be true)
    verification: {
      reserveXMatches: accounts[2].toBase58() === pool.reserveX,
      reserveYMatches: accounts[3].toBase58() === pool.reserveY,
      tokenXMintMatches: accounts[6].toBase58() === pool.tokenXMint,
      tokenYMintMatches: accounts[7].toBase58() === pool.tokenYMint,
    },
    binArrayCount: binArrayAccounts.length,
    binArrays: sortedBinArrays.map(ba => ({ index: ba.index, address: ba.address.slice(0, 8) })),
  });
  
  return accounts;
}

/**
 * Build Orca Whirlpool accounts in the order expected by the on-chain router
 * 
 * Uses standard swap layout (matches working local builder - 12 accounts):
 * 0. Token Program
 * 1. Token Authority (signer)
 * 2. Whirlpool
 * 3. Token Owner Account A
 * 4. Token Vault A
 * 5. Token Owner Account B
 * 6. Token Vault B
 * 7. Tick Array 0 (current tick)
 * 8. Tick Array 1 (next in swap direction)
 * 9. Tick Array 2 (next-next in swap direction)
 * 10. Oracle
 * 11. Whirlpool Program (for CPI)
 */
async function buildOrcaDexAccountsForRouter(
  payer: PublicKey,
  pool: OrcaWhirlpoolPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  _outputMint: PublicKey
): Promise<PublicKey[]> {
  // Determine swap direction (A -> B or B -> A)
  const isAtoB = inputMint.toBase58() === pool.mintA;
  
  // Get user token accounts
  // For Orca Whirlpool, accounts must be ordered as Token A, Token B (not source, dest)
  // Use per-mint token programs (Token A and Token B may use different programs)
  const [metaA, metaB] = await Promise.all([
    getTokenMeta(pool.mintA),
    getTokenMeta(pool.mintB),
  ]);
  const tokenProgramA = metaA.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenProgramB = metaB.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const userTokenA = getAssociatedTokenAddressSync(new PublicKey(pool.mintA), payer, false, tokenProgramA);
  const userTokenB = getAssociatedTokenAddressSync(new PublicKey(pool.mintB), payer, false, tokenProgramB);
  
  // CRITICAL: Derive tick arrays in direction-specific order
  // Orca Whirlpool swap expects:
  // - tick_array_0: Contains the current tick
  // - tick_array_1: Next tick array in swap direction
  // - tick_array_2: Next-next tick array in swap direction
  // A->B: tick decreases, so offsets [0, -1, -2]
  // B->A: tick increases, so offsets [0, +1, +2]
  const TICK_ARRAY_SIZE = 88;
  const ticksInArray = TICK_ARRAY_SIZE * pool.tickSpacing;
  const realIndex = Math.floor(pool.tickCurrentIndex / ticksInArray);
  
  const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32LE(startTickIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolPubkey.toBuffer(), startTickBuffer],
      ORCA_WHIRLPOOL_PROGRAM
    );
    return pda;
  };
  
  const idx0 = realIndex;
  const idx1 = realIndex + (isAtoB ? -1 : 1);
  const idx2 = realIndex + (isAtoB ? -2 : 2);
  
  const tickArray0 = deriveTickArrayPda(idx0 * ticksInArray);
  const tickArray1 = deriveTickArrayPda(idx1 * ticksInArray);
  const tickArray2 = deriveTickArrayPda(idx2 * ticksInArray);
  
  logger.info('router.test.orca.tickarrays', {
    cat: 'router',
    isAtoB,
    tickCurrentIndex: pool.tickCurrentIndex,
    tickSpacing: pool.tickSpacing,
    realIndex,
    indices: [idx0, idx1, idx2],
    tickArray0: tickArray0.toBase58(),
    tickArray1: tickArray1.toBase58(),
    tickArray2: tickArray2.toBase58(),
  });
  
  // Standard swap account layout (matches working local builder - 12 accounts)
  // Note: Position 0 is the token program used by the pool's vaults
  const accounts: PublicKey[] = [
    new PublicKey(pool.tokenProgram),                             // 0: Token Program (pool's vault program)
    payer,                                                         // 1: Token Authority (signer)
    poolPubkey,                                                    // 2: Whirlpool
    userTokenA,                                                    // 3: Token Owner Account A
    new PublicKey(pool.vaultA),                                   // 4: Token Vault A
    userTokenB,                                                    // 5: Token Owner Account B
    new PublicKey(pool.vaultB),                                   // 6: Token Vault B
    tickArray0,                                                    // 7: Tick Array 0 (current tick)
    tickArray1,                                                    // 8: Tick Array 1 (next in swap direction)
    tickArray2,                                                    // 9: Tick Array 2 (next-next in swap direction)
    new PublicKey(pool.oracle),                                   // 10: Oracle
    ORCA_WHIRLPOOL_PROGRAM,                                        // 11: Whirlpool Program (for CPI)
  ];
  
  logger.info('router.test.dex_accounts.orca', { 
    cat: 'router',
    poolId: poolPubkey.toBase58(),
    poolState: {
      mintA: pool.mintA,
      mintB: pool.mintB,
      vaultA: pool.vaultA,
      vaultB: pool.vaultB,
      oracle: pool.oracle,
      tickCurrentIndex: pool.tickCurrentIndex,
      tickSpacing: pool.tickSpacing,
    },
    actualAccounts: {
      idx0_TokenProgram: accounts[0].toBase58(),
      idx1_TokenAuthority: accounts[1].toBase58(),
      idx2_Whirlpool: accounts[2].toBase58(),
      idx3_TokenOwnerA: accounts[3].toBase58(),
      idx4_TokenVaultA: accounts[4].toBase58(),
      idx5_TokenOwnerB: accounts[5].toBase58(),
      idx6_TokenVaultB: accounts[6].toBase58(),
      idx7_TickArray0: accounts[7].toBase58(),
      idx8_TickArray1: accounts[8].toBase58(),
      idx9_TickArray2: accounts[9].toBase58(),
      idx10_Oracle: accounts[10].toBase58(),
      idx11_WhirlpoolProgram: accounts[11].toBase58(),
    },
    swapInfo: {
      inputMint: inputMint.toBase58(),
      outputMint: _outputMint.toBase58(),
      isAtoB,
    },
    verification: {
      vaultAMatches: accounts[4].toBase58() === pool.vaultA,
      vaultBMatches: accounts[6].toBase58() === pool.vaultB,
      oracleMatches: accounts[10].toBase58() === pool.oracle,
    },
    tokenPrograms: {
      mintA: metaA.program,
      mintB: metaB.program,
      poolVaults: pool.tokenProgram,
    },
    accountCount: accounts.length,
  });
  
  return accounts;
}

