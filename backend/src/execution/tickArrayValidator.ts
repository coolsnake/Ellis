/**
 * Background Tick Array Validator
 * 
 * This module provides async validation of tick arrays for CLMM pools.
 * When tick crosses an array boundary, the cache invalidates tick arrays
 * and queues the pool for validation. This validator:
 * 
 * 1. Monitors for pools needing validation
 * 2. Derives tick array PDAs based on current tick
 * 3. Validates existence on-chain (batch RPC calls)
 * 4. Updates cache with only existing tick arrays
 * 
 * This ensures we never use stale or non-existent tick arrays while
 * avoiding latency at transaction build time.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { executionCache } from './cache.js';
import { logger } from '../utils/logger.js';
import { logCatchError } from '../utils/errorHandler.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { getConnection } from '../wallet/wallet.js';

// Program IDs
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Tick array sizes
const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;
const METEORA_BIN_ARRAY_SIZE = 70;

// Validation queue - pools waiting to be validated
const validationQueue: Map<string, { addedAt: number; priority: number }> = new Map();

// Track validation loop state
let isRunning = false;
let validationLoopInterval: NodeJS.Timeout | null = null;

// RPC context for rate limiting
const RPC_MODULE = 'tickArrayValidator';

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive Orca tick array PDA
 * CRITICAL: Orca SDK encodes startTick as ASCII string, not binary
 */
function deriveOrcaTickArrayPda(poolId: PublicKey, startTickIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return pda;
}

/**
 * Derive Raydium tick array PDA
 */
async function deriveRaydiumTickArrayPda(
  programId: PublicKey,
  poolId: PublicKey,
  startIndex: number
): Promise<PublicKey> {
  try {
    const mod: any = await import('@raydium-io/raydium-sdk-v2');
    const getPda = (mod as any)?.getPdaTickArrayAddress ||
                   (mod as any)?.CLMM?.getPdaTickArrayAddress ||
                   (mod as any)?.Clmm?.getPdaTickArrayAddress;
    if (getPda) {
      const res = await getPda(programId, poolId, startIndex);
      return (res?.publicKey || res) as PublicKey;
    }
  } catch {}
  
  // Fallback: manual derivation
  const startIndexBuffer = Buffer.alloc(4);
  startIndexBuffer.writeInt32LE(startIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), startIndexBuffer],
    programId
  );
  return pda;
}

/**
 * Derive Meteora bin array PDA
 */
function deriveMeteoraBinArrayPda(poolId: PublicKey, binArrayIndex: number): PublicKey {
  const indexBuffer = Buffer.alloc(8);
  indexBuffer.writeBigInt64LE(BigInt(binArrayIndex), 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), poolId.toBuffer(), indexBuffer],
    METEORA_DLMM_PROGRAM
  );
  return pda;
}

/**
 * Calculate tick array start index from tick
 */
function getTickArrayStartIndex(tick: number, tickSpacing: number, arraySize: number): number {
  const ticksInArray = arraySize * tickSpacing;
  return Math.floor(tick / ticksInArray) * ticksInArray;
}

// ============================================================================
// Validation Logic
// ============================================================================

/**
 * Validate tick arrays for an Orca pool
 */
async function validateOrcaTickArrays(
  connection: Connection,
  poolId: string,
  currentTick: number,
  tickSpacing: number
): Promise<{ center?: string; lower?: string[]; upper?: string[] }> {
  const poolPk = new PublicKey(poolId);
  const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const centerStart = getTickArrayStartIndex(currentTick, tickSpacing, ORCA_TICK_ARRAY_SIZE);
  
  // Derive PDAs for center and ±3 arrays (covers most swap ranges)
  const RANGE = 3;
  const pdas: Array<{ type: 'lower' | 'center' | 'upper'; offset: number; pda: PublicKey; startTick: number }> = [];
  
  // Center
  pdas.push({ type: 'center', offset: 0, pda: deriveOrcaTickArrayPda(poolPk, centerStart), startTick: centerStart });
  
  // Lower
  for (let i = 1; i <= RANGE; i++) {
    const startTick = centerStart - (ticksInArray * i);
    pdas.push({ type: 'lower', offset: -i, pda: deriveOrcaTickArrayPda(poolPk, startTick), startTick });
  }
  
  // Upper
  for (let i = 1; i <= RANGE; i++) {
    const startTick = centerStart + (ticksInArray * i);
    pdas.push({ type: 'upper', offset: i, pda: deriveOrcaTickArrayPda(poolPk, startTick), startTick });
  }
  
  // Batch check existence
  const pdaKeys = pdas.map(p => p.pda);
  const infos = await withRpcLimit(
    () => connection.getMultipleAccountsInfo(pdaKeys),
    Math.ceil(pdaKeys.length / 5),
    { module: RPC_MODULE, method: 'getMultipleAccountsInfo:orca' }
  );
  
  const result: { center?: string; lower: string[]; upper: string[] } = { lower: [], upper: [] };
  
  for (let i = 0; i < pdas.length; i++) {
    const { type, pda } = pdas[i];
    const info = infos[i];
    
    // Only include if account exists and is owned by Orca program
    if (info && info.owner.equals(ORCA_WHIRLPOOL_PROGRAM)) {
      const addr = pda.toBase58();
      if (type === 'center') {
        result.center = addr;
      } else if (type === 'lower') {
        result.lower.push(addr);
      } else {
        result.upper.push(addr);
      }
    }
  }
  
  return result;
}

/**
 * Validate tick arrays for a Raydium CLMM pool
 */
async function validateRaydiumTickArrays(
  connection: Connection,
  poolId: string,
  currentTick: number,
  tickSpacing: number,
  programId?: string
): Promise<{ center?: string; lower?: string[]; upper?: string[] }> {
  const poolPk = new PublicKey(poolId);
  const programPk = programId ? new PublicKey(programId) : RAYDIUM_CLMM_PROGRAM;
  const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
  const centerStart = getTickArrayStartIndex(currentTick, tickSpacing, RAYDIUM_TICK_ARRAY_SIZE);
  
  // Derive PDAs for center and ±3 arrays
  const RANGE = 3;
  const pdas: Array<{ type: 'lower' | 'center' | 'upper'; offset: number; pda: PublicKey }> = [];
  
  // Center
  const centerPda = await deriveRaydiumTickArrayPda(programPk, poolPk, centerStart);
  pdas.push({ type: 'center', offset: 0, pda: centerPda });
  
  // Lower
  for (let i = 1; i <= RANGE; i++) {
    const startIndex = centerStart - (ticksInArray * i);
    const pda = await deriveRaydiumTickArrayPda(programPk, poolPk, startIndex);
    pdas.push({ type: 'lower', offset: -i, pda });
  }
  
  // Upper
  for (let i = 1; i <= RANGE; i++) {
    const startIndex = centerStart + (ticksInArray * i);
    const pda = await deriveRaydiumTickArrayPda(programPk, poolPk, startIndex);
    pdas.push({ type: 'upper', offset: i, pda });
  }
  
  // Batch check existence
  const pdaKeys = pdas.map(p => p.pda);
  const infos = await withRpcLimit(
    () => connection.getMultipleAccountsInfo(pdaKeys),
    Math.ceil(pdaKeys.length / 5),
    { module: RPC_MODULE, method: 'getMultipleAccountsInfo:raydium' }
  );
  
  const result: { center?: string; lower: string[]; upper: string[] } = { lower: [], upper: [] };
  
  for (let i = 0; i < pdas.length; i++) {
    const { type, pda } = pdas[i];
    const info = infos[i];
    
    // Only include if account exists and is owned by Raydium program
    if (info && info.owner.equals(programPk)) {
      const addr = pda.toBase58();
      if (type === 'center') {
        result.center = addr;
      } else if (type === 'lower') {
        result.lower.push(addr);
      } else {
        result.upper.push(addr);
      }
    }
  }
  
  return result;
}

/**
 * Validate bin arrays for a Meteora DLMM pool
 */
async function validateMeteoraBinArrays(
  connection: Connection,
  poolId: string,
  activeId: number
): Promise<{ lower?: string; upper?: string; active?: string; arrays: Array<{ index: number; address: string }> }> {
  const poolPk = new PublicKey(poolId);
  const activeBinArrayIdx = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
  
  // Derive PDAs for active and ±2 arrays
  const RANGE = 2;
  const pdas: Array<{ idx: number; pda: PublicKey }> = [];
  
  for (let i = -RANGE; i <= RANGE; i++) {
    const binArrayIdx = activeBinArrayIdx + i;
    const pda = deriveMeteoraBinArrayPda(poolPk, binArrayIdx);
    pdas.push({ idx: binArrayIdx, pda });
  }
  
  // Batch check existence
  const pdaKeys = pdas.map(p => p.pda);
  const infos = await withRpcLimit(
    () => connection.getMultipleAccountsInfo(pdaKeys),
    Math.ceil(pdaKeys.length / 5),
    { module: RPC_MODULE, method: 'getMultipleAccountsInfo:meteora' }
  );
  
  const result: { lower?: string; upper?: string; active?: string; arrays: Array<{ index: number; address: string }> } = { arrays: [] };
  
  for (let i = 0; i < pdas.length; i++) {
    const { idx, pda } = pdas[i];
    const info = infos[i];
    
    if (info && info.owner.equals(METEORA_DLMM_PROGRAM)) {
      const addr = pda.toBase58();
      result.arrays.push({ index: idx, address: addr });
      
      if (idx === activeBinArrayIdx) {
        result.active = addr;
      } else if (idx === activeBinArrayIdx - 1) {
        result.lower = addr;
      } else if (idx === activeBinArrayIdx + 1) {
        result.upper = addr;
      }
    }
  }
  
  return result;
}

// ============================================================================
// Validation Worker
// ============================================================================

/**
 * Process a single pool validation
 */
async function validatePool(
  connection: Connection,
  poolId: string
): Promise<boolean> {
  try {
    const hot = executionCache.getHot(poolId);
    const stat = executionCache.getStatic(poolId);
    
    if (!hot) {
      logger.debug('tickArrayValidator.skip.no_hot', { poolId: poolId.slice(0, 8), cat: 'cache' });
      return false;
    }
    
    const dex = stat?.dex;
    const tickSpacing = hot.tickSpacing || stat?.tickSpacing || stat?.tick_spacing;
    const currentTick = hot.currentTickIndex;
    const activeId = hot.activeId;
    const programId = stat?.programId;
    
    // Validate tick arrays for Orca/Raydium CLMM
    if (hot.needsTickArrayValidation && currentTick !== undefined && tickSpacing) {
      let validated: { center?: string; lower?: string[]; upper?: string[] } | null = null;
      
      if (dex === 'orca') {
        validated = await validateOrcaTickArrays(connection, poolId, currentTick, tickSpacing);
      } else if (dex === 'raydium') {
        validated = await validateRaydiumTickArrays(connection, poolId, currentTick, tickSpacing, programId);
      }
      
      if (validated) {
        // Store validated arrays
        executionCache.setValidatedTickArrays(poolId, {
          center: validated.center,
          lower: validated.lower && validated.lower.length > 0 
            ? (validated.lower.length === 1 ? validated.lower[0] : validated.lower)
            : undefined,
          upper: validated.upper && validated.upper.length > 0
            ? (validated.upper.length === 1 ? validated.upper[0] : validated.upper)
            : undefined,
        });
        
        logger.info('tickArrayValidator.validated', {
          cat: 'cache',
          poolId: poolId.slice(0, 8),
          dex,
          hasCenter: !!validated.center,
          lowerCount: validated.lower?.length || 0,
          upperCount: validated.upper?.length || 0,
        });
        
        return true;
      }
    }
    
    // Validate bin arrays for Meteora DLMM
    if (hot.needsBinArrayValidation && activeId !== undefined) {
      const validated = await validateMeteoraBinArrays(connection, poolId, activeId);
      
      if (validated.arrays.length > 0) {
        executionCache.setValidatedBinArrays(poolId, validated);
        
        logger.info('tickArrayValidator.binArrays.validated', {
          cat: 'cache',
          poolId: poolId.slice(0, 8),
          arrayCount: validated.arrays.length,
          hasActive: !!validated.active,
        });
        
        return true;
      }
    }
    
    return false;
  } catch (err) {
    logCatchError('tickArrayValidator.validatePool', err);
    return false;
  }
}

/**
 * Main validation loop
 */
async function runValidationLoop(): Promise<void> {
  if (!isRunning) return;
  
  try {
    const connection = getConnection();
    
    // Get pools needing validation
    const tickPools = executionCache.getPoolsNeedingTickArrayValidation();
    const binPools = executionCache.getPoolsNeedingBinArrayValidation();
    
    // Process tick array validations (batch of 5 at a time)
    const tickBatch = tickPools.slice(0, 5);
    if (tickBatch.length > 0) {
      logger.debug('tickArrayValidator.processing', {
        cat: 'cache',
        tickPoolCount: tickBatch.length,
        totalPending: tickPools.length,
      });
      
      await Promise.allSettled(
        tickBatch.map(p => validatePool(connection, p.poolId))
      );
    }
    
    // Process bin array validations
    const binBatch = binPools.slice(0, 5);
    if (binBatch.length > 0) {
      logger.debug('tickArrayValidator.binArrays.processing', {
        cat: 'cache',
        binPoolCount: binBatch.length,
        totalPending: binPools.length,
      });
      
      await Promise.allSettled(
        binBatch.map(p => validatePool(connection, p.poolId))
      );
    }
  } catch (err) {
    logCatchError('tickArrayValidator.loop', err);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Queue a pool for tick array validation
 * Called by WebSocket handlers when tick crosses boundary
 */
export function queueTickArrayValidation(poolId: string, priority: number = 0): void {
  const existing = validationQueue.get(poolId);
  if (!existing || priority > existing.priority) {
    validationQueue.set(poolId, { addedAt: Date.now(), priority });
  }
  
  // Also mark in cache
  const hot = executionCache.getHot(poolId);
  if (hot && !hot.needsTickArrayValidation) {
    executionCache.invalidateTickArrays(poolId);
  }
}

/**
 * Queue a pool for bin array validation (Meteora)
 */
export function queueBinArrayValidation(poolId: string, priority: number = 0): void {
  const hot = executionCache.getHot(poolId);
  if (hot && !hot.needsBinArrayValidation) {
    executionCache.invalidateBinArrays(poolId);
  }
}

/**
 * Start the background validation loop
 */
export function startTickArrayValidator(intervalMs: number = 100): void {
  if (isRunning) {
    logger.warn('tickArrayValidator.already_running', { cat: 'cache' });
    return;
  }
  
  isRunning = true;
  
  logger.info('tickArrayValidator.started', {
    cat: 'cache',
    intervalMs,
  });
  
  // Run immediately once
  runValidationLoop();
  
  // Then run on interval
  validationLoopInterval = setInterval(runValidationLoop, intervalMs);
}

/**
 * Stop the background validation loop
 */
export function stopTickArrayValidator(): void {
  if (!isRunning) return;
  
  isRunning = false;
  
  if (validationLoopInterval) {
    clearInterval(validationLoopInterval);
    validationLoopInterval = null;
  }
  
  validationQueue.clear();
  
  logger.info('tickArrayValidator.stopped', { cat: 'cache' });
}

/**
 * Check if the validator is running
 */
export function isTickArrayValidatorRunning(): boolean {
  return isRunning;
}

/**
 * Get validation queue stats
 */
export function getValidationStats(): {
  queueSize: number;
  tickPoolsPending: number;
  binPoolsPending: number;
  isRunning: boolean;
} {
  return {
    queueSize: validationQueue.size,
    tickPoolsPending: executionCache.getPoolsNeedingTickArrayValidation().length,
    binPoolsPending: executionCache.getPoolsNeedingBinArrayValidation().length,
    isRunning,
  };
}
