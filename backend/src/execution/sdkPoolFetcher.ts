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
 * Fetch Orca Whirlpool state using SDK
 * Returns validated tick arrays that actually exist on-chain
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
    
    // Calculate tick array indices
    const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(currentTick / ticksInArray);
    
    // Derive tick arrays for range [-5, +5] around center
    const RANGE = 5;
    const tickArrayPdas: Array<{ offset: number; pda: PublicKey; startTick: number }> = [];
    
    for (let i = -RANGE; i <= RANGE; i++) {
      const startTick = (centerIdx + i) * ticksInArray;
      const pda = deriveOrcaTickArrayPda(poolPk, startTick);
      tickArrayPdas.push({ offset: i, pda, startTick });
    }
    
    // Batch check which tick arrays exist
    const pdaKeys = tickArrayPdas.map(p => p.pda);
    const accountInfos = await connection.getMultipleAccountsInfo(pdaKeys);
    
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (let i = 0; i < tickArrayPdas.length; i++) {
      const info = accountInfos[i];
      if (info && info.owner.equals(ORCA_WHIRLPOOL_PROGRAM) && info.data.length > 0) {
        const { offset, pda } = tickArrayPdas[i];
        const addr = pda.toBase58();
        
        if (offset === 0) {
          center = addr;
        } else if (offset < 0) {
          lower.push(addr);
        } else {
          upper.push(addr);
        }
      }
    }
    
    const fetchDurationMs = Date.now() - startTime;
    
    if (!center) {
      logger.warn('orca.sdk.fetch.no_center_tick_array', {
        cat: 'cache',
        ctx: { pool: poolId, currentTick, tickSpacing, centerIdx }
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
 * Fetch Raydium CLMM pool state
 * Uses tickArrayBitmap from pool state to determine which tick arrays are initialized
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
    
    if (tickSpacing <= 0) {
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
    
    // Derive tick arrays for range
    const RANGE = 5;
    const tickArrayPdas: Array<{ offset: number; pda: PublicKey }> = [];
    
    for (let i = -RANGE; i <= RANGE; i++) {
      const startTick = centerStart + (i * delta);
      const pda = deriveRaydiumTickArrayPda(poolPk, startTick, program);
      tickArrayPdas.push({ offset: i, pda });
    }
    
    // Batch check existence
    const pdaKeys = tickArrayPdas.map(p => p.pda);
    const infos = await connection.getMultipleAccountsInfo(pdaKeys);
    
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (let i = 0; i < tickArrayPdas.length; i++) {
      const info = infos[i];
      if (info && info.owner.equals(program) && info.data.length > 0) {
        const { offset, pda } = tickArrayPdas[i];
        const addr = pda.toBase58();
        
        if (offset === 0) {
          center = addr;
        } else if (offset < 0) {
          lower.push(addr);
        } else {
          upper.push(addr);
        }
      }
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
  
  let data = accountData;
  if (!data) {
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) return null;
    data = Buffer.from(accountInfo.data);
  } else {
    data = Buffer.from(data);
  }
  
  if (data.length < 280) {
    logger.debug('raydium.manual.insufficient_data', { 
      cat: 'cache', 
      ctx: { pool: poolId, dataLen: data.length } 
    });
    return null;
  }
  
  try {
    // Extract fields from known offsets
    const tickSpacing = data.readUInt16LE(235);
    const tickCurrent = data.readInt32LE(269);
    
    if (tickSpacing <= 0 || tickSpacing > 1000) {
      logger.debug('raydium.manual.invalid_tick_spacing', { 
        cat: 'cache', 
        ctx: { pool: poolId, tickSpacing, tickCurrent } 
      });
      return null;
    }
    
    // Calculate tick array indices
    const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(tickCurrent / ticksInArray);
    const centerStart = centerIdx * ticksInArray;
    const delta = ticksInArray;
    
    // Derive tick arrays for range [-5, +5]
    const RANGE = 5;
    const tickArrayPdas: Array<{ offset: number; pda: PublicKey }> = [];
    
    for (let i = -RANGE; i <= RANGE; i++) {
      const startTick = centerStart + (i * delta);
      const pda = deriveRaydiumTickArrayPda(poolPk, startTick, program);
      tickArrayPdas.push({ offset: i, pda });
    }
    
    // Batch check existence
    const pdaKeys = tickArrayPdas.map(p => p.pda);
    const infos = await connection.getMultipleAccountsInfo(pdaKeys);
    
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    
    for (let i = 0; i < tickArrayPdas.length; i++) {
      const info = infos[i];
      if (info && info.owner.equals(program) && info.data.length > 0) {
        const { offset, pda } = tickArrayPdas[i];
        const addr = pda.toBase58();
        
        if (offset === 0) {
          center = addr;
        } else if (offset < 0) {
          lower.push(addr);
        } else {
          upper.push(addr);
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

