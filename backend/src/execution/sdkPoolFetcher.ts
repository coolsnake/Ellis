/**
 * SDK-Based Pool Fetcher
 * 
 * Uses each DEX's SDK to fetch validated pool state including initialized tick/bin arrays.
 * This ensures we only cache arrays that actually exist on-chain, preventing swap failures.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { logCatchError } from '../utils/errorHandler.js';

// Try to import Raydium layout directly for better reliability
let RaydiumClmmLayout: any = null;
try {
  const layoutModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js');
  RaydiumClmmLayout = layoutModule.PoolInfoLayout;
} catch {
  // Will fall back to dynamic lookup
}

// Constants
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;

// Raydium tick array bitmap constants
// The bitmap covers tick array indices from -512 to +511 (1024 total)
// It's stored as 16 u64 values (16 * 64 = 1024 bits)
const RAYDIUM_BITMAP_RANGE = 512;
const RAYDIUM_BITMAP_WORDS = 16;

/**
 * Decode Raydium's tickArrayBitmap to find all initialized tick array indices.
 * 
 * The bitmap is an array of 16 u64 values covering indices -512 to +511.
 * Each bit represents whether a tick array at that index is initialized.
 * 
 * Bitmap layout:
 * - Word 0: indices -512 to -449
 * - Word 1: indices -448 to -385
 * - ...
 * - Word 7: indices -64 to -1
 * - Word 8: indices 0 to 63
 * - ...
 * - Word 15: indices 448 to 511
 * 
 * @param bitmap Array of 16 u64 values (as bigints or strings)
 * @returns Array of initialized tick array indices
 */
export function decodeRaydiumTickArrayBitmap(bitmap: (bigint | string | number)[]): number[] {
  if (!bitmap || !Array.isArray(bitmap) || bitmap.length !== RAYDIUM_BITMAP_WORDS) {
    return [];
  }
  
  const initializedIndices: number[] = [];
  
  for (let wordIdx = 0; wordIdx < RAYDIUM_BITMAP_WORDS; wordIdx++) {
    const word = BigInt(bitmap[wordIdx] || 0);
    if (word === 0n) continue; // Skip empty words
    
    // Each word covers 64 tick array indices
    // Word 0 starts at index -512, Word 8 starts at index 0
    const baseIndex = -RAYDIUM_BITMAP_RANGE + (wordIdx * 64);
    
    // Check each bit in the word
    for (let bit = 0; bit < 64; bit++) {
      if ((word >> BigInt(bit)) & 1n) {
        initializedIndices.push(baseIndex + bit);
      }
    }
  }
  
  return initializedIndices;
}

/**
 * Check if a specific tick array index is initialized according to the bitmap.
 * @param bitmap Array of 16 u64 values
 * @param tickArrayIndex The tick array index to check (-512 to +511)
 * @returns true if initialized, false if not or out of range
 */
export function isTickArrayInitializedInBitmap(
  bitmap: (bigint | string | number)[],
  tickArrayIndex: number
): boolean {
  if (!bitmap || !Array.isArray(bitmap) || bitmap.length !== RAYDIUM_BITMAP_WORDS) {
    return false;
  }
  
  // Check if index is within bitmap range
  if (tickArrayIndex < -RAYDIUM_BITMAP_RANGE || tickArrayIndex >= RAYDIUM_BITMAP_RANGE) {
    // Outside bitmap range - need to check exBitmap or on-chain
    return false;
  }
  
  // Convert index to word and bit position
  const adjustedIndex = tickArrayIndex + RAYDIUM_BITMAP_RANGE; // 0-1023
  const wordIdx = Math.floor(adjustedIndex / 64);
  const bitIdx = adjustedIndex % 64;
  
  const word = BigInt(bitmap[wordIdx] || 0);
  return ((word >> BigInt(bitIdx)) & 1n) === 1n;
}

/**
 * Get initialized tick array indices near a specific tick for Raydium.
 * Uses the bitmap for indices within range, returns empty for out-of-range.
 * 
 * @param bitmap The tickArrayBitmap from pool state
 * @param centerTickArrayIndex The tick array index containing current tick
 * @param range How many indices to check on each side
 * @returns Array of initialized tick array indices near the center
 */
export function getInitializedTickArraysNearTick(
  bitmap: (bigint | string | number)[],
  centerTickArrayIndex: number,
  range: number = 5
): number[] {
  const initialized: number[] = [];
  
  for (let offset = -range; offset <= range; offset++) {
    const idx = centerTickArrayIndex + offset;
    if (isTickArrayInitializedInBitmap(bitmap, idx)) {
      initialized.push(idx);
    }
  }
  
  return initialized;
}

export interface ValidatedTickArrays {
  center: string;
  lower: string[];  // Multiple initialized lower arrays
  upper: string[];  // Multiple initialized upper arrays
}

export interface ValidatedBinArrays {
  arrays: Array<{ index: number; address: string }>;
  activeIndex: number;
}

export interface ValidatedPoolState {
  poolId: string;
  dex: 'orca' | 'raydium' | 'meteora';
  // Common
  programId: string;
  // CLMM specific
  currentTick?: number;
  tickSpacing?: number;
  sqrtPriceX64?: string;
  liquidity?: string;
  // DLMM specific
  activeId?: number;
  binStep?: number;
  // Raydium-specific accounts
  ammConfig?: string;
  observationState?: string;
  // Validated arrays
  tickArrays?: ValidatedTickArrays;
  binArrays?: ValidatedBinArrays;
  // Metadata
  lastFetched: number;
  fetchDurationMs: number;
}

/**
 * Derive Orca tick array PDA
 */
function deriveOrcaTickArrayPda(
  poolId: PublicKey,
  startTickIndex: number
): PublicKey {
  // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return pda;
}

/**
 * Derive Raydium tick array PDA
 */
function deriveRaydiumTickArrayPda(
  poolId: PublicKey,
  startTickIndex: number,
  programId: PublicKey = RAYDIUM_CLMM_PROGRAM
): PublicKey {
  const startTickBuffer = Buffer.alloc(4);
  startTickBuffer.writeInt32LE(startTickIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
    programId
  );
  return pda;
}

/**
 * Helper function to search for Orca tick arrays in a given range
 */
async function searchOrcaTickArrays(
  connection: Connection,
  poolPk: PublicKey,
  centerIdx: number,
  ticksInArray: number,
  range: number
): Promise<Array<{ offset: number; address: string; pda: PublicKey }>> {
  const tickArrayPdas: Array<{ offset: number; pda: PublicKey; startTick: number }> = [];
  
  for (let i = -range; i <= range; i++) {
    const startTick = (centerIdx + i) * ticksInArray;
    const pda = deriveOrcaTickArrayPda(poolPk, startTick);
    tickArrayPdas.push({ offset: i, pda, startTick });
  }
  
  // Batch check which tick arrays exist
  const pdaKeys = tickArrayPdas.map(p => p.pda);
  const accountInfos = await connection.getMultipleAccountsInfo(pdaKeys);
  
  const existingArrays: Array<{ offset: number; address: string; pda: PublicKey }> = [];
  
  for (let i = 0; i < tickArrayPdas.length; i++) {
    const info = accountInfos[i];
    if (info && info.owner.equals(ORCA_WHIRLPOOL_PROGRAM) && info.data.length > 0) {
      const { offset, pda } = tickArrayPdas[i];
      existingArrays.push({ offset, address: pda.toBase58(), pda });
    }
  }
  
  return existingArrays;
}

/**
 * Fetch Orca Whirlpool state using SDK
 * Returns validated tick arrays that actually exist on-chain
 * 
 * Uses adaptive search range based on tick spacing:
 * - Smaller tick spacing = wider search (pools with tickSpacing=1 need more coverage)
 * - Falls back to extended search if no tick arrays found in initial range
 */
export async function fetchOrcaPoolViaSdk(
  connection: Connection,
  poolId: string
): Promise<ValidatedPoolState | null> {
  const startTime = Date.now();
  const poolPk = new PublicKey(poolId);
  
  try {
    // Fetch pool account directly
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    
    // Decode pool state manually (same layout as in testSwap.ts)
    const data = Buffer.from(accountInfo.data);
    let offset = 8; // Skip discriminator
    
    // Skip whirlpoolsConfig, whirlpoolBump
    offset += 32 + 1;
    
    // tickSpacing (2 bytes, u16 LE)
    const tickSpacing = data.readUInt16LE(offset);
    offset += 2 + 2 + 2 + 2; // Skip tickSpacingSeed, feeRate, protocolFeeRate
    
    // liquidity (16 bytes)
    const liquidityBuf = data.subarray(offset, offset + 16);
    const liquidity = Buffer.from(liquidityBuf).reverse().toString('hex');
    offset += 16;
    
    // sqrtPrice (16 bytes)
    const sqrtPriceBuf = data.subarray(offset, offset + 16);
    const sqrtPriceX64 = Buffer.from(sqrtPriceBuf).reverse().toString('hex');
    offset += 16;
    
    // tickCurrentIndex (4 bytes, i32 LE)
    const currentTick = data.readInt32LE(offset);
    
    // Validate tick spacing before proceeding
    if (tickSpacing <= 0 || tickSpacing > 1000) {
      logger.debug('orca.sdk.fetch.invalid_tick_spacing', {
        cat: 'cache',
        ctx: { pool: poolId, tickSpacing, currentTick }
      });
      return null;
    }
    
    // Calculate tick array indices
    const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(currentTick / ticksInArray);
    
    // SUGGESTION 1: Use adaptive range based on tick spacing
    // Smaller tick spacing means each array covers fewer ticks, so we need wider search
    // tickSpacing=1: each array covers 88 ticks, search ±15 (covers ±1320 ticks)
    // tickSpacing=8: each array covers 704 ticks, search ±8 (covers ±5632 ticks)
    // tickSpacing=64+: each array covers 5632+ ticks, search ±5 (covers ±28160+ ticks)
    const INITIAL_RANGE = tickSpacing <= 2 ? 15 : tickSpacing <= 8 ? 10 : 5;
    
    // Search for tick arrays in initial range
    let existingArrays = await searchOrcaTickArrays(
      connection, poolPk, centerIdx, ticksInArray, INITIAL_RANGE
    );
    
    // SUGGESTION 2: If no tick arrays found, try extended search
    // This catches pools where liquidity is concentrated far from current tick
    if (existingArrays.length === 0) {
      const EXTENDED_RANGE = tickSpacing <= 2 ? 50 : tickSpacing <= 8 ? 30 : 15;
      
      logger.debug('orca.sdk.fetch.extended_search', {
        cat: 'cache',
        ctx: { 
          pool: poolId.slice(0, 8) + '…', 
          currentTick, 
          tickSpacing, 
          centerIdx,
          initialRange: INITIAL_RANGE,
          extendedRange: EXTENDED_RANGE 
        }
      });
      
      existingArrays = await searchOrcaTickArrays(
        connection, poolPk, centerIdx, ticksInArray, EXTENDED_RANGE
      );
      
      if (existingArrays.length > 0) {
        logger.info('orca.sdk.fetch.found_in_extended', {
          cat: 'cache',
          ctx: { 
            pool: poolId.slice(0, 8) + '…', 
            currentTick, 
            tickSpacing,
            arraysFound: existingArrays.length,
            nearestOffset: existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]?.offset
          }
        });
      }
    }
    
    // Categorize arrays into lower, center, upper
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (const arr of existingArrays) {
      if (arr.offset === 0) {
        center = arr.address;
      } else if (arr.offset < 0) {
        lower.push(arr.address);
      } else {
        upper.push(arr.address);
      }
    }
    
    const fetchDurationMs = Date.now() - startTime;
    
    // If center doesn't exist but we have other arrays, pick the nearest one as center
    // This handles pools with concentrated liquidity where tick has drifted into uninitialized range
    if (!center && existingArrays.length > 0) {
      // Sort by absolute offset (closest to center first)
      existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      const nearest = existingArrays[0];
      center = nearest.address;
      
      // Recategorize: the nearest becomes center, others become lower/upper relative to it
      lower.length = 0;
      upper.length = 0;
      for (const arr of existingArrays) {
        if (arr.address === center) continue;
        if (arr.offset < nearest.offset) {
          lower.push(arr.address);
        } else {
          upper.push(arr.address);
        }
      }
      
      logger.debug('orca.sdk.fetch.center_from_nearest', {
        cat: 'cache',
        ctx: { 
          pool: poolId.slice(0, 8), 
          currentTick, 
          tickSpacing,
          originalCenterIdx: centerIdx,
          nearestOffset: nearest.offset,
          totalArrays: existingArrays.length,
        }
      });
    } else if (!center && existingArrays.length === 0) {
      // Log at debug level - these are typically empty pools or pools with liquidity far outside any reasonable range
      // Not actionable, so don't spam warn logs
      logger.debug('orca.sdk.fetch.no_tick_arrays', {
        cat: 'cache',
        ctx: { pool: poolId, currentTick, tickSpacing, centerIdx, searchedRange: tickSpacing <= 2 ? 50 : tickSpacing <= 8 ? 30 : 15 }
      });
    }
    
    logger.debug('orca.sdk.fetch.complete', {
      cat: 'cache',
      ctx: {
        pool: poolId.slice(0, 8) + '...',
        currentTick,
        tickSpacing,
        tickArraysFound: { lower: lower.length, center: !!center, upper: upper.length },
        durationMs: fetchDurationMs
      }
    });
    
    // Return tick arrays if we found any (center is guaranteed if any exist now)
    return {
      poolId,
      dex: 'orca',
      programId: ORCA_WHIRLPOOL_PROGRAM.toBase58(),
      currentTick,
      tickSpacing,
      sqrtPriceX64,
      liquidity,
      tickArrays: center ? { center, lower, upper } : undefined,
      lastFetched: Date.now(),
      fetchDurationMs,
    };
  } catch (e) {
    logCatchError('sdkPoolFetcher.orca', e);
    return null;
  }
}

/**
 * Fetch Meteora DLMM pool state using SDK
 * Returns validated bin arrays that actually exist on-chain
 */
export async function fetchMeteoraPoolViaSdk(
  connection: Connection,
  poolId: string
): Promise<ValidatedPoolState | null> {
  const startTime = Date.now();
  const poolPk = new PublicKey(poolId);
  
  try {
    // Import Meteora SDK
    const meteoraModule = await import('@meteora-ag/dlmm');
    const DLMM = (meteoraModule as any).default || (meteoraModule as any).DLMM || meteoraModule;
    
    // Check if DLMM.create exists
    const createFn = DLMM?.create || DLMM?.DLMM?.create;
    if (!createFn) {
      // Fallback: decode manually
      return await fetchMeteoraPoolManual(connection, poolId);
    }
    
    try {
      // Use SDK to create pool instance - this fetches all pool data including bin arrays
      const dlmmPool = await createFn(connection, poolPk);
      
      // Get active bin
      const activeBin = await dlmmPool.getActiveBin();
      const activeId = activeBin?.binId ?? dlmmPool.lbPair?.activeId;
      const binStep = dlmmPool.lbPair?.binStep;
      
      // Get bin arrays - SDK returns only initialized ones
      let validatedArrays: Array<{ index: number; address: string }> = [];
      
      try {
        const binArrays = await dlmmPool.getBinArrays();
        if (Array.isArray(binArrays)) {
          validatedArrays = binArrays.map((ba: any) => ({
            index: typeof ba.account?.index?.toNumber === 'function' 
              ? ba.account.index.toNumber() 
              : Number(ba.account?.index ?? ba.index ?? 0),
            address: typeof ba.publicKey?.toBase58 === 'function'
              ? ba.publicKey.toBase58()
              : String(ba.publicKey || ba.address),
          }));
        }
      } catch (e) {
        // Fallback: derive and check bin arrays manually
        validatedArrays = await deriveBinArraysWithValidation(connection, poolPk, activeId, DLMM);
      }
      
      // Calculate active index
      const BIN_ARRAY_SIZE = 70;
      const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
      
      const fetchDurationMs = Date.now() - startTime;
      
      logger.debug('meteora.sdk.fetch.complete', {
        cat: 'cache',
        ctx: {
          pool: poolId.slice(0, 8) + '...',
          activeId,
          binStep,
          binArraysFound: validatedArrays.length,
          durationMs: fetchDurationMs
        }
      });
      
      return {
        poolId,
        dex: 'meteora',
        programId: METEORA_DLMM_PROGRAM.toBase58(),
        activeId,
        binStep,
        binArrays: validatedArrays.length > 0 ? { arrays: validatedArrays, activeIndex } : undefined,
        lastFetched: Date.now(),
        fetchDurationMs,
      };
    } catch (sdkError) {
      // SDK create failed, fallback to manual decode
      logger.debug('meteora.sdk.create.fallback', {
        cat: 'cache',
        ctx: { pool: poolId, error: String((sdkError as any)?.message || sdkError) }
      });
      return await fetchMeteoraPoolManual(connection, poolId);
    }
  } catch (e) {
    logCatchError('sdkPoolFetcher.meteora', e);
    return null;
  }
}

/**
 * Derive bin arrays and validate they exist on-chain
 */
async function deriveBinArraysWithValidation(
  connection: Connection,
  poolPk: PublicKey,
  activeId: number,
  DLMM: any
): Promise<Array<{ index: number; address: string }>> {
  const BIN_ARRAY_SIZE = 70;
  const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
  const RANGE = 5;
  
  const binIdToBinArrayIndex = DLMM?.binIdToBinArrayIndex;
  const deriveBinArray = DLMM?.deriveBinArray;
  
  if (!deriveBinArray) {
    // Pure manual derivation
    return await deriveBinArraysManual(connection, poolPk, activeIndex, RANGE);
  }
  
  const BN = (await import('bn.js').catch(() => null) as any)?.default;
  if (!BN) {
    return await deriveBinArraysManual(connection, poolPk, activeIndex, RANGE);
  }
  
  const arrays: Array<{ index: number; pda: PublicKey }> = [];
  
  for (let i = activeIndex - RANGE; i <= activeIndex + RANGE; i++) {
    try {
      const binArrayPda = deriveBinArray(poolPk, new BN(i), METEORA_DLMM_PROGRAM);
      const pda = Array.isArray(binArrayPda) ? binArrayPda[0] : binArrayPda;
      if (pda) {
        arrays.push({ index: i, pda });
      }
    } catch {}
  }
  
  // Batch check existence
  const pdaKeys = arrays.map(a => a.pda);
  const infos = await connection.getMultipleAccountsInfo(pdaKeys);
  
  const validated: Array<{ index: number; address: string }> = [];
  for (let i = 0; i < arrays.length; i++) {
    const info = infos[i];
    if (info && info.owner.equals(METEORA_DLMM_PROGRAM)) {
      validated.push({
        index: arrays[i].index,
        address: arrays[i].pda.toBase58(),
      });
    }
  }
  
  return validated;
}

/**
 * Manual bin array derivation when SDK is unavailable
 */
async function deriveBinArraysManual(
  connection: Connection,
  poolPk: PublicKey,
  activeIndex: number,
  range: number
): Promise<Array<{ index: number; address: string }>> {
  const BN = (await import('bn.js').catch(() => null) as any)?.default;
  if (!BN) return [];
  
  const arrays: Array<{ index: number; pda: PublicKey }> = [];
  
  for (let i = activeIndex - range; i <= activeIndex + range; i++) {
    try {
      const idxBn = new BN(i);
      const seed = idxBn.isNeg()
        ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
        : idxBn.toArrayLike(Buffer, 'le', 8);
      
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bin_array'), poolPk.toBuffer(), seed],
        METEORA_DLMM_PROGRAM
      );
      arrays.push({ index: i, pda });
    } catch {}
  }
  
  // Batch check
  const pdaKeys = arrays.map(a => a.pda);
  const infos = await connection.getMultipleAccountsInfo(pdaKeys);
  
  const validated: Array<{ index: number; address: string }> = [];
  for (let i = 0; i < arrays.length; i++) {
    if (infos[i] && infos[i]!.owner.equals(METEORA_DLMM_PROGRAM)) {
      validated.push({ index: arrays[i].index, address: arrays[i].pda.toBase58() });
    }
  }
  
  return validated;
}

/**
 * Fallback manual Meteora pool fetch when SDK unavailable
 */
async function fetchMeteoraPoolManual(
  connection: Connection,
  poolId: string
): Promise<ValidatedPoolState | null> {
  const startTime = Date.now();
  const poolPk = new PublicKey(poolId);
  
  try {
    // Fetch and decode pool account
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) return null;
    
    // Import SDK just for decoding
    const meteoraModule = await import('@meteora-ag/dlmm');
    const createProgram = (meteoraModule as any).createProgram;
    if (!createProgram) return null;
    
    const program = createProgram(connection);
    const state = program.coder.accounts.decode('lbPair', accountInfo.data);
    if (!state) return null;
    
    const activeId = Number(state.activeId ?? 0);
    const binStep = Number(state.binStep ?? 0);
    
    // Derive and validate bin arrays
    const BIN_ARRAY_SIZE = 70;
    const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
    
    const validatedArrays = await deriveBinArraysManual(connection, poolPk, activeIndex, 5);
    
    const fetchDurationMs = Date.now() - startTime;
    
    return {
      poolId,
      dex: 'meteora',
      programId: METEORA_DLMM_PROGRAM.toBase58(),
      activeId,
      binStep,
      binArrays: validatedArrays.length > 0 ? { arrays: validatedArrays, activeIndex } : undefined,
      lastFetched: Date.now(),
      fetchDurationMs,
    };
  } catch (e) {
    logCatchError('sdkPoolFetcher.meteora.manual', e);
    return null;
  }
}

/**
 * Helper function to search for Raydium tick arrays in a given range
 */
async function searchRaydiumTickArrays(
  connection: Connection,
  poolPk: PublicKey,
  centerStart: number,
  delta: number,
  range: number,
  program: PublicKey
): Promise<Array<{ offset: number; address: string; pda: PublicKey }>> {
  const tickArrayPdas: Array<{ offset: number; pda: PublicKey }> = [];
  
  for (let i = -range; i <= range; i++) {
    const startTick = centerStart + (i * delta);
    const pda = deriveRaydiumTickArrayPda(poolPk, startTick, program);
    tickArrayPdas.push({ offset: i, pda });
  }
  
  // Batch check existence
  const pdaKeys = tickArrayPdas.map(p => p.pda);
  const infos = await connection.getMultipleAccountsInfo(pdaKeys);
  
  const existingArrays: Array<{ offset: number; address: string; pda: PublicKey }> = [];
  
  for (let i = 0; i < tickArrayPdas.length; i++) {
    const info = infos[i];
    if (info && info.owner.equals(program) && info.data.length > 0) {
      const { offset, pda } = tickArrayPdas[i];
      existingArrays.push({ offset, address: pda.toBase58(), pda });
    }
  }
  
  return existingArrays;
}

/**
 * Fetch Raydium CLMM pool state
 * Uses tickArrayBitmap from pool state to determine which tick arrays are initialized
 * 
 * Uses adaptive search range based on tick spacing:
 * - Smaller tick spacing = wider search
 * - Falls back to extended search if no tick arrays found in initial range
 */
export async function fetchRaydiumPoolViaSdk(
  connection: Connection,
  poolId: string,
  programId?: string
): Promise<ValidatedPoolState | null> {
  const startTime = Date.now();
  const poolPk = new PublicKey(poolId);
  const program = programId ? new PublicKey(programId) : RAYDIUM_CLMM_PROGRAM;
  
  try {
    // Fetch pool account
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) {
      logger.debug('raydium.sdk.fetch.no_account', { cat: 'cache', ctx: { pool: poolId } });
      return null;
    }
    
    // Try pre-imported layout first, then dynamic lookup
    let layout = RaydiumClmmLayout;
    
    if (!layout?.decode) {
      // Use Raydium SDK with comprehensive fallback pattern
      const sdk = await import('@raydium-io/raydium-sdk-v2');
      layout = (sdk as any)?.PoolInfoLayout ||
               (sdk as any)?.Clmm?.PoolInfoLayout ||
               (sdk as any)?.Clmm?.PoolStateLayout ||
               (sdk as any)?.CLMM?.POOL_STATE_LAYOUT ||
               (sdk as any)?.PoolStateLayout;
    }
    
    if (!layout?.decode) {
      // Manual decode fallback using known offsets
      logger.debug('raydium.sdk.fetch.manual_fallback', { cat: 'cache', ctx: { pool: poolId } });
      return await fetchRaydiumPoolManual(connection, poolId, program, accountInfo.data);
    }
    
    let state: any;
    try {
      state = layout.decode(accountInfo.data);
    } catch (decodeErr) {
      logger.debug('raydium.sdk.fetch.decode_error', { 
        cat: 'cache', 
        ctx: { pool: poolId, error: String((decodeErr as any)?.message || decodeErr) } 
      });
      return await fetchRaydiumPoolManual(connection, poolId, program, accountInfo.data);
    }
    
    const tickCurrent = Number(state.tickCurrent ?? state.tick_current ?? 0);
    const tickSpacing = Number(state.tickSpacing ?? state.tick_spacing ?? 0);
    const sqrtPriceX64 = String(state.sqrtPriceX64 ?? '0');
    const liquidity = String(state.liquidity ?? '0');
    
    // Extract tick array bitmap if available (array of 16 u64 values)
    const tickArrayBitmap = state.tickArrayBitmap ?? state.tick_array_bitmap;
    const hasBitmap = Array.isArray(tickArrayBitmap) && tickArrayBitmap.length === 16;
    
    if (tickSpacing <= 0 || tickSpacing > 1000) {
      logger.debug('raydium.sdk.fetch.invalid_tick_spacing', { 
        cat: 'cache', 
        ctx: { pool: poolId, tickSpacing } 
      });
      return null;
    }
    
    // Calculate tick array indices
    const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(tickCurrent / ticksInArray);
    const centerStart = centerIdx * ticksInArray;
    const delta = ticksInArray;
    
    let existingArrays: Array<{ offset: number; address: string; pda: PublicKey }> = [];
    
    // OPTIMIZATION: Use bitmap to know exactly which tick arrays are initialized
    // This avoids unnecessary RPC calls to check non-existent tick arrays
    if (hasBitmap) {
      // Get initialized tick array indices from bitmap
      const SEARCH_RANGE = 20; // Check ±20 tick array indices around center
      const initializedIndices = getInitializedTickArraysNearTick(tickArrayBitmap, centerIdx, SEARCH_RANGE);
      
      if (initializedIndices.length > 0) {
        // Only derive and verify PDAs for tick arrays that the bitmap says exist
        const tickArrayPdas: Array<{ offset: number; pda: PublicKey; tickArrayIdx: number }> = [];
        
        for (const tickArrayIdx of initializedIndices) {
          const startTick = tickArrayIdx * ticksInArray;
          const pda = deriveRaydiumTickArrayPda(poolPk, startTick, program);
          tickArrayPdas.push({ offset: tickArrayIdx - centerIdx, pda, tickArrayIdx });
        }
        
        // Still verify on-chain (bitmap could be stale) but only for known-initialized arrays
        const pdaKeys = tickArrayPdas.map(p => p.pda);
        const infos = await connection.getMultipleAccountsInfo(pdaKeys);
        
        for (let i = 0; i < tickArrayPdas.length; i++) {
          const info = infos[i];
          if (info && info.owner.equals(program) && info.data.length > 0) {
            const { offset, pda } = tickArrayPdas[i];
            existingArrays.push({ offset, address: pda.toBase58(), pda });
          }
        }
        
        logger.debug('raydium.sdk.fetch.bitmap_search', {
          cat: 'cache',
          ctx: { 
            pool: poolId.slice(0, 8) + '…', 
            tickCurrent, 
            tickSpacing,
            centerIdx,
            bitmapInitialized: initializedIndices.length,
            verifiedOnChain: existingArrays.length
          }
        });
      } else {
        // Bitmap says no tick arrays are initialized in range
        // Check if center is outside bitmap range (±512), if so fall back to RPC search
        if (Math.abs(centerIdx) >= RAYDIUM_BITMAP_RANGE) {
          logger.debug('raydium.sdk.fetch.center_outside_bitmap', {
            cat: 'cache',
            ctx: { pool: poolId.slice(0, 8) + '…', centerIdx, bitmapRange: RAYDIUM_BITMAP_RANGE }
          });
          // Fall through to RPC-based search below
        } else {
          logger.debug('raydium.sdk.fetch.bitmap_empty', {
            cat: 'cache',
            ctx: { pool: poolId.slice(0, 8) + '…', centerIdx, searchRange: SEARCH_RANGE }
          });
        }
      }
    }
    
    // Fall back to RPC-based search if bitmap not available or yielded no results
    if (existingArrays.length === 0 && (!hasBitmap || Math.abs(centerIdx) >= RAYDIUM_BITMAP_RANGE)) {
      // Adaptive range based on tick spacing (Raydium arrays are 60 ticks vs Orca's 88)
      const INITIAL_RANGE = tickSpacing <= 2 ? 12 : tickSpacing <= 10 ? 8 : 5;
      
      // Search for tick arrays in initial range
      existingArrays = await searchRaydiumTickArrays(
        connection, poolPk, centerStart, delta, INITIAL_RANGE, program
      );
      
      // If no tick arrays found, try extended search
      if (existingArrays.length === 0) {
        const EXTENDED_RANGE = tickSpacing <= 2 ? 40 : tickSpacing <= 10 ? 25 : 12;
        
        logger.debug('raydium.sdk.fetch.extended_search', {
          cat: 'cache',
          ctx: { 
            pool: poolId.slice(0, 8) + '…', 
            tickCurrent, 
            tickSpacing, 
            centerIdx,
            initialRange: INITIAL_RANGE,
            extendedRange: EXTENDED_RANGE 
          }
        });
        
        existingArrays = await searchRaydiumTickArrays(
          connection, poolPk, centerStart, delta, EXTENDED_RANGE, program
        );
        
        if (existingArrays.length > 0) {
          logger.info('raydium.sdk.fetch.found_in_extended', {
            cat: 'cache',
            ctx: { 
              pool: poolId.slice(0, 8) + '…', 
              tickCurrent, 
              tickSpacing,
              arraysFound: existingArrays.length,
              nearestOffset: existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]?.offset
            }
          });
        }
      }
    }
    
    // Categorize arrays into lower, center, upper
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (const arr of existingArrays) {
      if (arr.offset === 0) {
        center = arr.address;
      } else if (arr.offset < 0) {
        lower.push(arr.address);
      } else {
        upper.push(arr.address);
      }
    }
    
    // If center doesn't exist but we have other arrays, pick the nearest one as center
    if (!center && existingArrays.length > 0) {
      existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      const nearest = existingArrays[0];
      center = nearest.address;
      
      // Recategorize relative to the new center
      lower.length = 0;
      upper.length = 0;
      for (const arr of existingArrays) {
        if (arr.address === center) continue;
        if (arr.offset < nearest.offset) {
          lower.push(arr.address);
        } else {
          upper.push(arr.address);
        }
      }
      
      logger.debug('raydium.sdk.fetch.center_from_nearest', {
        cat: 'cache',
        ctx: { 
          pool: poolId.slice(0, 8), 
          tickCurrent, 
          tickSpacing,
          originalCenterIdx: centerIdx,
          nearestOffset: nearest.offset,
          totalArrays: existingArrays.length,
        }
      });
    } else if (!center && existingArrays.length === 0) {
      // Log at debug level - these are typically empty pools or pools with liquidity far outside any reasonable range
      // Not actionable, so don't spam warn logs
      logger.debug('raydium.sdk.fetch.no_tick_arrays', {
        cat: 'cache',
        ctx: { pool: poolId, tickCurrent, tickSpacing, centerIdx, searchedRange: tickSpacing <= 2 ? 40 : tickSpacing <= 10 ? 25 : 12 }
      });
    }
    
    const fetchDurationMs = Date.now() - startTime;
    
    logger.debug('raydium.sdk.fetch.complete', {
      cat: 'cache',
      ctx: {
        pool: poolId.slice(0, 8) + '...',
        tickCurrent,
        tickSpacing,
        tickArraysFound: { lower: lower.length, center: !!center, upper: upper.length },
        durationMs: fetchDurationMs
      }
    });
    
    return {
      poolId,
      dex: 'raydium',
      programId: program.toBase58(),
      currentTick: tickCurrent,
      tickSpacing,
      sqrtPriceX64,
      liquidity,
      tickArrays: center ? { center, lower, upper } : undefined,
      lastFetched: Date.now(),
      fetchDurationMs,
    };
  } catch (e) {
    logCatchError('sdkPoolFetcher.raydium', e);
    return null;
  }
}

/**
 * Manual Raydium pool fetch fallback using known pool state offsets
 * 
 * Raydium CLMM PoolState layout (partial):
 * - Discriminator: 8 bytes (offset 0)
 * - bump: 1 byte (offset 8) 
 * - ammConfig: 32 bytes (offset 9)
 * - owner: 32 bytes (offset 41)
 * - tokenMint0: 32 bytes (offset 73)
 * - tokenMint1: 32 bytes (offset 105)
 * - tokenVault0: 32 bytes (offset 137)
 * - tokenVault1: 32 bytes (offset 169)
 * - observationKey: 32 bytes (offset 201)
 * - mintDecimals0: 1 byte (offset 233)
 * - mintDecimals1: 1 byte (offset 234)
 * - tickSpacing: 2 bytes u16 LE (offset 235)
 * - liquidity: 16 bytes u128 LE (offset 237)
 * - sqrtPriceX64: 16 bytes u128 LE (offset 253)
 * - tickCurrent: 4 bytes i32 LE (offset 269)
 */
async function fetchRaydiumPoolManual(
  connection: Connection,
  poolId: string,
  program: PublicKey,
  accountData?: Buffer
): Promise<ValidatedPoolState | null> {
  const startTime = Date.now();
  const poolPk = new PublicKey(poolId);
  
  let rawData: Uint8Array;
  if (!accountData) {
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) return null;
    rawData = accountInfo.data;
  } else {
    rawData = accountData;
  }
  
  if (rawData.length < 280) {
    logger.debug('raydium.manual.insufficient_data', { 
      cat: 'cache', 
      ctx: { pool: poolId, dataLen: rawData.length } 
    });
    return null;
  }
  
  try {
    // Extract fields from known offsets using DataView for cross-platform compatibility
    const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    const tickSpacing = view.getUint16(235, true);  // true = little endian
    const tickCurrent = view.getInt32(269, true);   // true = little endian
    
    if (tickSpacing <= 0 || tickSpacing > 1000) {
      logger.debug('raydium.manual.invalid_tick_spacing', { 
        cat: 'cache', 
        ctx: { pool: poolId, tickSpacing, tickCurrent } 
      });
      return null;
    }
    
    // Extract ammConfig (32-byte pubkey at offset 8, after discriminator)
    // Raydium CLMM layout: discriminator(8) + ammConfig(32) + poolCreator(32) + ...
    let ammConfig: string | undefined;
    let observationState: string | undefined;
    
    try {
      // Use derivation helper for accurate extraction
      const { deriveRaydiumClmmCacheFields } = await import('../server/pools.derivation.js');
      const derived = await deriveRaydiumClmmCacheFields(poolId, rawData as Buffer);
      if (derived?.ammConfig) ammConfig = derived.ammConfig;
      if (derived?.observationState) observationState = derived.observationState;
    } catch {
      // Fallback: extract ammConfig manually from offset 8 (after 8-byte discriminator)
      if (rawData.length >= 40) {
        const ammConfigBytes = rawData.slice(8, 40);
        ammConfig = new PublicKey(ammConfigBytes).toBase58();
      }
    }
    
    // Calculate tick array indices
    const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(tickCurrent / ticksInArray);
    const centerStart = centerIdx * ticksInArray;
    const delta = ticksInArray;
    
    // Adaptive range based on tick spacing
    const INITIAL_RANGE = tickSpacing <= 2 ? 12 : tickSpacing <= 10 ? 8 : 5;
    
    // Search for tick arrays in initial range
    let existingArrays = await searchRaydiumTickArrays(
      connection, poolPk, centerStart, delta, INITIAL_RANGE, program
    );
    
    // If no tick arrays found, try extended search
    if (existingArrays.length === 0) {
      const EXTENDED_RANGE = tickSpacing <= 2 ? 40 : tickSpacing <= 10 ? 25 : 12;
      existingArrays = await searchRaydiumTickArrays(
        connection, poolPk, centerStart, delta, EXTENDED_RANGE, program
      );
    }
    
    // Categorize arrays into lower, center, upper
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (const arr of existingArrays) {
      if (arr.offset === 0) {
        center = arr.address;
      } else if (arr.offset < 0) {
        lower.push(arr.address);
      } else {
        upper.push(arr.address);
      }
    }
    
    // If center doesn't exist but we have other arrays, pick the nearest one as center
    if (!center && existingArrays.length > 0) {
      existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      const nearest = existingArrays[0];
      center = nearest.address;
      
      // Recategorize relative to the new center
      lower.length = 0;
      upper.length = 0;
      for (const arr of existingArrays) {
        if (arr.address === center) continue;
        if (arr.offset < nearest.offset) {
          lower.push(arr.address);
        } else {
          upper.push(arr.address);
        }
      }
    }
    
    const fetchDurationMs = Date.now() - startTime;
    
    logger.debug('raydium.manual.fetch.complete', {
      cat: 'cache',
      ctx: {
        pool: poolId.slice(0, 8) + '...',
        tickCurrent,
        tickSpacing,
        tickArraysFound: { lower: lower.length, center: !!center, upper: upper.length },
        durationMs: fetchDurationMs
      }
    });
    
    return {
      poolId,
      dex: 'raydium',
      programId: program.toBase58(),
      currentTick: tickCurrent,
      tickSpacing,
      ammConfig,
      observationState,
      tickArrays: center ? { center, lower, upper } : undefined,
      lastFetched: Date.now(),
      fetchDurationMs,
    };
  } catch (e) {
    logCatchError('sdkPoolFetcher.raydium.manual', e);
    return null;
  }
}

/**
 * Batch fetch multiple pools with validated arrays
 */
export async function batchFetchPoolsViaSdk(
  connection: Connection,
  pools: Array<{ id: string; dex: 'orca' | 'raydium' | 'meteora'; programId?: string }>,
  options?: { concurrency?: number }
): Promise<Map<string, ValidatedPoolState>> {
  const results = new Map<string, ValidatedPoolState>();
  const concurrency = options?.concurrency ?? 5;
  
  // Process in batches
  for (let i = 0; i < pools.length; i += concurrency) {
    const batch = pools.slice(i, i + concurrency);
    
    const batchResults = await Promise.all(
      batch.map(async (pool) => {
        try {
          let result: ValidatedPoolState | null = null;
          
          switch (pool.dex) {
            case 'orca':
              result = await fetchOrcaPoolViaSdk(connection, pool.id);
              break;
            case 'meteora':
              result = await fetchMeteoraPoolViaSdk(connection, pool.id);
              break;
            case 'raydium':
              result = await fetchRaydiumPoolViaSdk(connection, pool.id, pool.programId);
              break;
          }
          
          return { id: pool.id, result };
        } catch {
          return { id: pool.id, result: null };
        }
      })
    );
    
    for (const { id, result } of batchResults) {
      if (result) {
        results.set(id, result);
      }
    }
  }
  
  return results;
}

