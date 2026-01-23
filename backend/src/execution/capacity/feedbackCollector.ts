/**
 * Feedback Collector
 * 
 * Bridges simulation results to the calibration store.
 * Extracts per-hop slippage observations from simulation reports
 * and records them for capacity curve calibration.
 */

import { recordObservation, type SlippageObservation } from './calibrationStore.js';
import { getPoolTypeFromDex } from './types.js';
import { logger } from '../../utils/logger.js';
import type { PoolType } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Hop comparison data from simulation report
 */
interface HopComparison {
  index: number;
  poolId?: string;
  dex: string;
  expectedDex?: string;
  expectedRate?: string;
  quotedRate?: string;
  rateDeltaBps?: number | null;
  rateOk?: boolean;
  matchedDirection?: 'forward' | 'inverse' | null;
  amountInRaw?: string;
  quotedOutRaw?: string;
  actualInRaw?: string;
  actualMinOut?: string;
  executed?: boolean;
}

/**
 * Simulation report structure (subset of fields we need)
 */
interface SimulationReport {
  hopCount?: number;
  hopComparison?: HopComparison[];
  pathStr?: string;
}

/**
 * Outcome type for feedback recording
 */
export type FeedbackOutcome = 'success' | '6007' | 'other_error';

// ============================================================================
// Public API
// ============================================================================

/**
 * Record slippage feedback from a simulation result.
 * 
 * This function extracts per-hop slippage deltas from the simulation report
 * and records them as observations for capacity calibration.
 * 
 * @param simReport - The simulation report from buildSimulationReport()
 * @param outcome - The outcome of the simulation ('success', '6007', 'other_error')
 * @param effectiveSizeUsd - The total trade size in USD
 */
export function recordSlippageFeedback(
  simReport: SimulationReport | Record<string, any>,
  outcome: FeedbackOutcome,
  effectiveSizeUsd: number
): void {
  // Skip if no hop comparison data
  if (!simReport.hopComparison || !Array.isArray(simReport.hopComparison)) {
    return;
  }
  
  const hopCount = simReport.hopCount || simReport.hopComparison.length;
  if (hopCount === 0) return;
  
  // Approximate per-hop size (evenly distributed)
  const perHopSizeUsd = effectiveSizeUsd / hopCount;
  
  let recordedCount = 0;
  
  for (const hop of simReport.hopComparison) {
    // Skip hops without poolId or delta data
    if (!hop.poolId || hop.rateDeltaBps === null || hop.rateDeltaBps === undefined) {
      continue;
    }
    
    // Determine pool type from dex string
    const poolType = getPoolTypeFromDex(hop.dex);
    
    // Create observation
    const observation: SlippageObservation = {
      timestamp: Date.now(),
      sizeUsd: perHopSizeUsd,
      actualDeltaBps: hop.rateDeltaBps,
      outcome,
    };
    
    // Record the observation
    recordObservation(hop.poolId, poolType, observation);
    recordedCount++;
  }
  
  if (recordedCount > 0) {
    logger.debug('capacity.feedback.recorded', {
      cat: 'sizing',
      outcome,
      hopsRecorded: recordedCount,
      totalHops: hopCount,
      sizeUsd: effectiveSizeUsd.toFixed(2),
      path: simReport.pathStr?.slice(0, 50),
    });
  }
}

/**
 * Record feedback for a single pool directly.
 * 
 * Use this when you have direct pool-level feedback rather than
 * extracting from a simulation report.
 * 
 * @param poolId - The pool identifier
 * @param poolType - The pool type (amm, clmm, dlmm)
 * @param deltaBps - The slippage delta in basis points
 * @param sizeUsd - The trade size in USD
 * @param outcome - The outcome
 */
export function recordPoolFeedback(
  poolId: string,
  poolType: PoolType,
  deltaBps: number,
  sizeUsd: number,
  outcome: FeedbackOutcome
): void {
  const observation: SlippageObservation = {
    timestamp: Date.now(),
    sizeUsd,
    actualDeltaBps: deltaBps,
    outcome,
  };
  
  recordObservation(poolId, poolType, observation);
}
