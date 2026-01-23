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
 * Recompute calibration factors from observations
 */
function recomputeCalibration(cal: PoolCalibration): void {
  const now = Date.now();
  
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
  
  for (const obs of cal.observations) {
    const ageHours = (now - obs.timestamp) / 3600_000;
    const weight = Math.exp(-ageHours / OBSERVATION_DECAY_HOURS);
    
    // Track recent observations for confidence
    if (ageHours < 1) {
      recentCount++;
    }
    
    // For 6007 errors, the slippage was underestimated
    // deltaBps is negative when quoted was worse than expected
    // We want to track how much we underestimated (positive = underestimated)
    if (obs.outcome === '6007') {
      // -deltaBps because negative delta means worse than expected
      weightedSum += -obs.actualDeltaBps * weight;
      totalWeight += weight;
    } else if (obs.outcome === 'success') {
      // Success means our estimate was acceptable
      // Only count if we were too optimistic (negative delta)
      if (obs.actualDeltaBps < 0) {
        weightedSum += -obs.actualDeltaBps * weight * 0.5; // Weight success less
      }
      totalWeight += weight * 0.5;
    }
    // 'other_error' outcomes are not used for calibration
  }
  
  // Compute average slippage error
  cal.avgSlippageError = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  // Convert slippage error to scale factor
  // If we're underestimating slippage by X bps on average,
  // scale down capacity proportionally
  // Formula: scaleFactor = 1 / (1 + avgError / BREAK_EVEN_SLIPPAGE_BPS)
  // This means: 50 bps error -> 0.5 scaleFactor (halve capacity)
  //             25 bps error -> 0.67 scaleFactor
  //             0 bps error -> 1.0 scaleFactor
  if (cal.avgSlippageError > 0) {
    cal.scaleFactor = Math.max(0.5, Math.min(1.5,
      1 / (1 + cal.avgSlippageError / BREAK_EVEN_SLIPPAGE_BPS)
    ));
  } else {
    // If we're overestimating slippage (good!), slightly increase capacity
    cal.scaleFactor = Math.max(0.5, Math.min(1.5,
      1 + Math.min(0.2, -cal.avgSlippageError / (BREAK_EVEN_SLIPPAGE_BPS * 2))
    ));
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
