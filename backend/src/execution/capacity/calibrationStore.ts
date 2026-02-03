/**
 * Capacity Calibration Store
 * 
 * Persists and manages learned calibration data for per-pool capacity adjustments.
 * The system learns from simulation feedback (especially 6007/NoProfitFromRoute errors)
 * to improve capacity curve accuracy over time.
 * 
 * Key features:
 * - Debounced persistence to avoid excessive disk I/O
 * - Exponential decay weighting for observations (recent data matters more)
 * - Per-pool learning with confidence tracking
 * - Graceful degradation when no data is available
 */

import { CONFIG } from '../../utils/config.js';
import { readJson, writeJson, joinPath } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import type { PoolType } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single observation of slippage deviation
 */
export interface SlippageObservation {
  /** When this observation was recorded */
  timestamp: number;
  /** Trade size in USD */
  sizeUsd: number;
  /** Actual delta in bps (negative = worse than expected) */
  actualDeltaBps: number;
  /** Outcome of the simulation/execution */
  outcome: 'success' | '6007' | 'other_error';
}

/**
 * Calibration data for a single pool
 */
export interface PoolCalibration {
  /** Pool identifier */
  poolId: string;
  /** Pool type (amm, clmm, dlmm) */
  poolType: PoolType;
  /** Historical observations (capped at MAX_OBSERVATIONS_PER_POOL) */
  observations: SlippageObservation[];
  /** Learned capacity scale factor (0.5-1.5) */
  scaleFactor: number;
  /** Average weighted slippage error in bps */
  avgSlippageError: number;
  /** Confidence level (0-1) based on observation count and recency */
  confidence: number;
  /** Last time this calibration was updated */
  lastUpdated: number;
}

/**
 * Snapshot format for persistence
 */
interface CalibrationSnapshot {
  version: number;
  savedAt: string;
  savedAtMs: number;
  calibrations: Record<string, PoolCalibration>;
}

// ============================================================================
// Configuration
// ============================================================================

/** Current schema version for backward compatibility */
const CALIBRATION_VERSION = 1;

/** Filename for persisted calibrations */
const CALIBRATION_FILE = 'capacity-calibrations.json';

/** Maximum observations to keep per pool */
const MAX_OBSERVATIONS_PER_POOL = 50;

/** Debounce interval for saves (ms) */
const SAVE_DEBOUNCE_MS = 30_000;

/** Exponential decay half-life for observation weighting (hours) */
const OBSERVATION_DECAY_HOURS = 24;

/** Minimum observations needed for any confidence */
const MIN_OBSERVATIONS_FOR_CONFIDENCE = 3;

/** Break-even slippage target in bps (used for scale factor calculation) */
const BREAK_EVEN_SLIPPAGE_BPS = 50;

// ============================================================================
// In-Memory State
// ============================================================================

const calibrations = new Map<string, PoolCalibration>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

// ============================================================================
// File Path
// ============================================================================

function getCalibrationFilePath(): string {
  return joinPath(CONFIG.cacheDir, CALIBRATION_FILE);
}

// ============================================================================
// Load on Startup
// ============================================================================

/**
 * Load calibrations from disk on startup
 * @returns Number of pools loaded
 */
export async function loadCalibrations(): Promise<number> {
  try {
    const snapshot = await readJson<CalibrationSnapshot>(
      getCalibrationFilePath(),
      null as any
    );
    
    if (!snapshot) {
      logger.info('capacity.calibration.no_data', { cat: 'sizing' });
      return 0;
    }
    
    // Version check for forward compatibility
    if (snapshot.version !== CALIBRATION_VERSION) {
      logger.warn('capacity.calibration.version_mismatch', {
        cat: 'sizing',
        found: snapshot.version,
        expected: CALIBRATION_VERSION,
      });
      // For now, skip loading incompatible versions
      // Future: add migration logic here
      return 0;
    }
    
    calibrations.clear();
    let loaded = 0;
    
    for (const [poolId, cal] of Object.entries(snapshot.calibrations || {})) {
      if (cal && cal.observations && Array.isArray(cal.observations)) {
        // Recompute calibration factors in case algorithm changed
        recomputeCalibration(cal);
        calibrations.set(poolId, cal);
        loaded++;
      }
    }
    
    const ageHours = (Date.now() - snapshot.savedAtMs) / 3600_000;
    
    logger.info('capacity.calibration.loaded', {
      cat: 'sizing',
      poolCount: loaded,
      ageHours: ageHours.toFixed(1),
    });
    
    return loaded;
  } catch (err: any) {
    logger.warn('capacity.calibration.load.failed', { 
      cat: 'sizing', 
      error: err.message 
    });
    return 0;
  }
}

// ============================================================================
// Save (Debounced)
// ============================================================================

/**
 * Save calibrations to disk
 */
export async function saveCalibrations(): Promise<boolean> {
  if (calibrations.size === 0) {
    isDirty = false;
    return true;
  }
  
  try {
    const snapshot: CalibrationSnapshot = {
      version: CALIBRATION_VERSION,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      calibrations: Object.fromEntries(calibrations),
    };
    
    await writeJson(getCalibrationFilePath(), snapshot);
    isDirty = false;
    
    logger.debug('capacity.calibration.saved', {
      cat: 'sizing',
      poolCount: calibrations.size,
    });
    
    return true;
  } catch (err: any) {
    logger.warn('capacity.calibration.save.failed', { 
      cat: 'sizing', 
      error: err.message 
    });
    return false;
  }
}

/**
 * Schedule a debounced save
 */
function scheduleSave(): void {
  isDirty = true;
  if (saveTimer) return;  // Already scheduled
  
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (isDirty) {
      await saveCalibrations();
    }
  }, SAVE_DEBOUNCE_MS);
  
  // Don't block process exit
  if (typeof saveTimer.unref === 'function') {
    saveTimer.unref();
  }
}

/**
 * Force save before shutdown
 */
export async function saveOnShutdown(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (isDirty || calibrations.size > 0) {
    await saveCalibrations();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get calibration for a specific pool
 */
export function getPoolCalibration(poolId: string): PoolCalibration | undefined {
  return calibrations.get(poolId);
}

/**
 * Get pool-type-level calibration as a fallback for uncalibrated pools.
 * 
 * This solves the cold-start problem: new pools have no calibration data,
 * so we use aggregate learnings from all pools of the same type.
 * 
 * @param poolType - The pool type (amm, clmm, dlmm)
 * @returns Aggregate calibration for the pool type, or undefined if insufficient data
 */
export function getPoolTypeCalibration(poolType: PoolType): {
  scaleFactor: number;
  confidence: number;
  poolCount: number;
} | undefined {
  let totalWeight = 0;
  let weightedScaleSum = 0;
  let poolCount = 0;
  
  const now = Date.now();
  
  for (const cal of calibrations.values()) {
    if (cal.poolType !== poolType) continue;
    if (cal.confidence < 0.2) continue; // Skip very low confidence calibrations
    
    // Weight by confidence and recency
    const ageHours = (now - cal.lastUpdated) / 3600_000;
    const recencyWeight = Math.exp(-ageHours / 48); // 48-hour half-life
    const weight = cal.confidence * recencyWeight;
    
    weightedScaleSum += cal.scaleFactor * weight;
    totalWeight += weight;
    poolCount++;
  }
  
  // Need at least 3 pools with calibration data
  if (poolCount < 3 || totalWeight <= 0) {
    return undefined;
  }
  
  const avgScaleFactor = weightedScaleSum / totalWeight;
  
  // Aggregate confidence is lower than individual pool confidence
  // because we're extrapolating from other pools
  const aggregateConfidence = Math.min(0.5, totalWeight / 10);
  
  return {
    scaleFactor: avgScaleFactor,
    confidence: aggregateConfidence,
    poolCount,
  };
}

/**
 * Get calibration for a pool with fallback to pool-type-level calibration.
 * 
 * This is the recommended function for getting calibration data, as it
 * handles the cold-start problem by falling back to aggregate data.
 * 
 * @param poolId - The pool identifier
 * @param poolType - The pool type (for fallback)
 * @returns Pool-specific calibration if available, otherwise pool-type aggregate
 */
export function getCalibrationWithFallback(
  poolId: string,
  poolType: PoolType
): PoolCalibration | { scaleFactor: number; confidence: number; isFallback: true } | undefined {
  // Try pool-specific calibration first
  const poolCal = calibrations.get(poolId);
  if (poolCal && poolCal.confidence > 0.2) {
    return poolCal;
  }
  
  // Fall back to pool-type aggregate
  const typeCal = getPoolTypeCalibration(poolType);
  if (typeCal) {
    logger.debug('capacity.calibration.using_fallback', {
      cat: 'sizing',
      poolId: poolId.slice(0, 12) + '...',
      poolType,
      fallbackScaleFactor: typeCal.scaleFactor.toFixed(3),
      fallbackConfidence: typeCal.confidence.toFixed(2),
      poolsUsed: typeCal.poolCount,
    });
    
    return {
      scaleFactor: typeCal.scaleFactor,
      confidence: typeCal.confidence,
      isFallback: true,
    };
  }
  
  return undefined;
}

/**
 * Record a new slippage observation for a pool
 */
export function recordObservation(
  poolId: string,
  poolType: PoolType,
  observation: SlippageObservation
): void {
  let cal = calibrations.get(poolId);
  
  if (!cal) {
    cal = {
      poolId,
      poolType,
      observations: [],
      scaleFactor: 1.0,
      avgSlippageError: 0,
      confidence: 0,
      lastUpdated: Date.now(),
    };
    calibrations.set(poolId, cal);
  }
  
  // Add observation
  cal.observations.push(observation);
  
  // Trim old observations (keep most recent MAX)
  if (cal.observations.length > MAX_OBSERVATIONS_PER_POOL) {
    cal.observations = cal.observations.slice(-MAX_OBSERVATIONS_PER_POOL);
  }
  
  // Recompute calibration factors
  recomputeCalibration(cal);
  
  // Schedule async save
  scheduleSave();
  
  logger.debug('capacity.calibration.observation_recorded', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    poolType,
    deltaBps: observation.actualDeltaBps,
    outcome: observation.outcome,
    newScaleFactor: cal.scaleFactor.toFixed(3),
    confidence: cal.confidence.toFixed(2),
  });
}

// ============================================================================
// Calibration Computation
// ============================================================================

/**
 * Minimum positive delta (bps) to count as "better than expected".
 * This avoids noise from tiny differences.
 */
const MIN_POSITIVE_DELTA_BPS = 5;

/**
 * Bonus delta to add for successful trades to provide recovery signal.
 * When a trade succeeds, we assume we could have traded slightly larger.
 */
const SUCCESS_RECOVERY_BONUS_BPS = 10;

/**
 * Recompute calibration factors from observations.
 * 
 * IMPORTANT: This now uses SYMMETRIC feedback:
 * - Negative outcomes (6007, worse slippage) push scale factor DOWN
 * - Positive outcomes (success, better slippage) push scale factor UP
 * 
 * This prevents the one-way ratchet that previously locked capacity at minimum.
 */
function recomputeCalibration(cal: PoolCalibration): void {
  const now = Date.now();
  const previousScaleFactor = cal.scaleFactor;
  
  if (cal.observations.length === 0) {
    cal.scaleFactor = 1.0;
    cal.avgSlippageError = 0;
    cal.confidence = 0;
    cal.lastUpdated = now;
    return;
  }
  
  // Weight observations by recency (exponential decay)
  let weightedSum = 0;
  let totalWeight = 0;
  let recentCount = 0;
  let recentSuccessCount = 0;
  let recentFailCount = 0;
  
  for (const obs of cal.observations) {
    const ageHours = (now - obs.timestamp) / 3600_000;
    const weight = Math.exp(-ageHours / OBSERVATION_DECAY_HOURS);
    
    // Track recent observations for confidence and recovery detection
    if (ageHours < 1) {
      recentCount++;
      if (obs.outcome === 'success') recentSuccessCount++;
      if (obs.outcome === '6007') recentFailCount++;
    }
    
    // SYMMETRIC FEEDBACK:
    // - Positive weightedSum = need to reduce capacity (underestimated slippage)
    // - Negative weightedSum = can increase capacity (overestimated slippage)
    
    if (obs.outcome === '6007') {
      // 6007 error: slippage was worse than expected
      // -deltaBps because negative delta means worse than expected
      // Use 70% weight (was 100%) to balance with positive feedback
      weightedSum += -obs.actualDeltaBps * weight * 0.7;
      totalWeight += weight * 0.7;
    } else if (obs.outcome === 'success') {
      if (obs.actualDeltaBps < -MIN_POSITIVE_DELTA_BPS) {
        // Worse than expected but still succeeded - minor negative signal
        // Use 30% weight (was 50%)
        weightedSum += -obs.actualDeltaBps * weight * 0.3;
        totalWeight += weight * 0.3;
      } else if (obs.actualDeltaBps > MIN_POSITIVE_DELTA_BPS) {
        // BETTER than expected - POSITIVE signal to increase capacity
        // This is the key fix: we now count positive outcomes
        weightedSum += -obs.actualDeltaBps * weight * 0.5;
        totalWeight += weight * 0.5;
      } else {
        // Neutral outcome (within ±5 bps) - add small positive bias for recovery
        // Success means our estimate worked, give small credit toward increasing
        weightedSum += -SUCCESS_RECOVERY_BONUS_BPS * weight * 0.2;
        totalWeight += weight * 0.2;
      }
    }
    // 'other_error' outcomes are not used for calibration
  }
  
  // Compute average slippage error
  cal.avgSlippageError = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  // SYMMETRIC scale factor calculation
  // Formula: scaleFactor = 1.0 - (avgError / BREAK_EVEN_SLIPPAGE_BPS)
  // +50 bps error (underestimating) -> 0.5 scaleFactor
  // -50 bps error (overestimating) -> 1.5 scaleFactor
  // 0 bps error -> 1.0 scaleFactor
  cal.scaleFactor = Math.max(0.5, Math.min(1.5,
    1.0 - (cal.avgSlippageError / BREAK_EVEN_SLIPPAGE_BPS)
  ));
  
  // RECOVERY MECHANISM: If stuck at low scale factor with mostly successes, recover faster
  // This catches edge cases where the feedback loop still gets stuck
  if (previousScaleFactor < 0.7 && recentCount >= 5) {
    const recentSuccessRate = recentSuccessCount / recentCount;
    if (recentSuccessRate >= 0.8 && recentFailCount === 0) {
      // 80%+ success rate with no recent failures - boost recovery
      const recoveryBoost = Math.min(0.1, (recentSuccessRate - 0.8) * 0.5);
      cal.scaleFactor = Math.min(1.5, cal.scaleFactor + recoveryBoost);
      
      logger.debug('capacity.calibration.recovery_boost', {
        cat: 'sizing',
        poolId: cal.poolId.slice(0, 12) + '...',
        previousScale: previousScaleFactor.toFixed(3),
        newScale: cal.scaleFactor.toFixed(3),
        recentSuccessRate: recentSuccessRate.toFixed(2),
        boost: recoveryBoost.toFixed(3),
      });
    }
  }
  
  // Confidence based on observation count and recency
  // Need at least MIN_OBSERVATIONS_FOR_CONFIDENCE observations
  const totalObs = cal.observations.length;
  if (totalObs < MIN_OBSERVATIONS_FOR_CONFIDENCE) {
    cal.confidence = 0;
  } else {
    // Base confidence on total count (up to 0.5)
    const countConfidence = Math.min(0.5, totalObs / 20);
    // Add recency boost (up to 0.5)
    const recencyConfidence = Math.min(0.5, recentCount / 5);
    cal.confidence = countConfidence + recencyConfidence;
  }
  
  // STALE DATA HANDLING: When confidence drops due to old data, drift toward neutral
  // This prevents old pessimistic calibrations from persisting forever
  if (cal.confidence < 0.3 && totalObs >= MIN_OBSERVATIONS_FOR_CONFIDENCE) {
    // Data is getting stale - blend scale factor toward 1.0
    const staleDriftFactor = 0.1; // 10% drift per recompute when stale
    cal.scaleFactor = cal.scaleFactor * (1 - staleDriftFactor) + 1.0 * staleDriftFactor;
  }
  
  cal.lastUpdated = now;
}

// ============================================================================
// Stats and Debugging
// ============================================================================

/**
 * Get calibration statistics for debugging/monitoring
 */
export function getCalibrationStats(): {
  totalPools: number;
  totalObservations: number;
  avgScaleFactor: number;
  poolsWithConfidence: number;
  byPoolType: Record<PoolType, { count: number; avgScale: number; avgConfidence: number }>;
} {
  let totalObs = 0;
  let scaleSum = 0;
  let poolsWithConfidence = 0;
  
  const byType: Record<PoolType, { count: number; scaleSum: number; confSum: number }> = {
    amm: { count: 0, scaleSum: 0, confSum: 0 },
    clmm: { count: 0, scaleSum: 0, confSum: 0 },
    dlmm: { count: 0, scaleSum: 0, confSum: 0 },
  };
  
  for (const cal of calibrations.values()) {
    totalObs += cal.observations.length;
    scaleSum += cal.scaleFactor;
    
    if (cal.confidence > 0.3) {
      poolsWithConfidence++;
    }
    
    const typeData = byType[cal.poolType];
    if (typeData) {
      typeData.count++;
      typeData.scaleSum += cal.scaleFactor;
      typeData.confSum += cal.confidence;
    }
  }
  
  return {
    totalPools: calibrations.size,
    totalObservations: totalObs,
    avgScaleFactor: calibrations.size > 0 ? scaleSum / calibrations.size : 1.0,
    poolsWithConfidence,
    byPoolType: {
      amm: {
        count: byType.amm.count,
        avgScale: byType.amm.count > 0 ? byType.amm.scaleSum / byType.amm.count : 1.0,
        avgConfidence: byType.amm.count > 0 ? byType.amm.confSum / byType.amm.count : 0,
      },
      clmm: {
        count: byType.clmm.count,
        avgScale: byType.clmm.count > 0 ? byType.clmm.scaleSum / byType.clmm.count : 1.0,
        avgConfidence: byType.clmm.count > 0 ? byType.clmm.confSum / byType.clmm.count : 0,
      },
      dlmm: {
        count: byType.dlmm.count,
        avgScale: byType.dlmm.count > 0 ? byType.dlmm.scaleSum / byType.dlmm.count : 1.0,
        avgConfidence: byType.dlmm.count > 0 ? byType.dlmm.confSum / byType.dlmm.count : 0,
      },
    },
  };
}

/**
 * Check if calibrations have been modified since last save
 */
export function isDirtyState(): boolean {
  return isDirty;
}

/**
 * Get the number of calibrated pools
 */
export function getCalibratedPoolCount(): number {
  return calibrations.size;
}

/**
 * Clear all calibrations (for testing)
 */
export function clearCalibrations(): void {
  calibrations.clear();
  isDirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/**
 * Reset all calibrations - clears memory and deletes persisted file.
 * This gives the system a fresh start with no learned data.
 * 
 * @returns Number of pools that were cleared
 */
export async function resetCalibrations(): Promise<{ clearedPools: number; fileDeleted: boolean }> {
  const clearedPools = calibrations.size;
  
  // Clear in-memory state
  calibrations.clear();
  isDirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  
  // Delete persisted file
  let fileDeleted = false;
  try {
    const fs = await import('fs/promises');
    const filePath = getCalibrationFilePath();
    await fs.unlink(filePath);
    fileDeleted = true;
    logger.info('capacity.calibration.reset', {
      cat: 'sizing',
      clearedPools,
      fileDeleted: true,
    });
  } catch (err: any) {
    // File might not exist, which is fine
    if (err.code !== 'ENOENT') {
      logger.warn('capacity.calibration.reset.file_error', {
        cat: 'sizing',
        error: err.message,
      });
    }
    logger.info('capacity.calibration.reset', {
      cat: 'sizing',
      clearedPools,
      fileDeleted: false,
    });
  }
  
  return { clearedPools, fileDeleted };
}
