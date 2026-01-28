/**
 * Alternative Pool Explorer
 * 
 * When a simulation fails due to worse-than-expected slippage on a specific hop,
 * this module finds and tests alternative pools for that hop.
 * 
 * The key insight: a pool with a nominally lower rate might have better actual
 * execution due to fresher prices, less MEV activity, or more accurate quotes.
 */

import { logger } from '../utils/logger.js';
import type { GraphSnapshot, GraphEdge } from '../server/graph.types.js';
import type { HopActualOutput, SimulationAnalysis } from './simLogParser.js';

// Types for hop analysis
export interface HopQuotedOutput {
  quotedOutputRaw?: string;
  amountInRaw?: string;
  dex: string;
  poolId: string;
}

export interface ProblematicHop {
  hopIndex: number;
  poolId: string;
  dex: string;
  inputMint: string;
  outputMint: string;
  expectedOutput: bigint;
  actualOutput: bigint;
  slippageBps: number;
}

export interface AlternativePool {
  poolId: string;
  dex: string;
  rateEffective: number;  // price_a_per_b adjusted for direction
  liquidity: number;
  feeBps: number;
}

export interface AlternativePoolResult {
  found: boolean;
  alternatives: AlternativePool[];
  problematicHop: ProblematicHop | null;
}

/**
 * Analyze simulation results to find which hop had the worst slippage
 * compared to quoted expectations.
 */
export function findProblematicHop(
  hopQuotedOutputs: HopQuotedOutput[],
  hopActualOutputs: HopActualOutput[],
  path: string[],  // Token path [A, B, C, A] for cycles
  minSlippageThresholdBps: number = 50  // Only flag if >0.5% worse
): ProblematicHop | null {
  if (!hopQuotedOutputs || !hopActualOutputs) {
    return null;
  }

  let worstIndex = -1;
  let worstSlippageBps = 0;
  let worstExpected = 0n;
  let worstActual = 0n;

  for (let i = 0; i < Math.min(hopQuotedOutputs.length, hopActualOutputs.length); i++) {
    const quoted = hopQuotedOutputs[i];
    const actual = hopActualOutputs[i];

    if (!quoted?.quotedOutputRaw || !actual?.amountOut) {
      continue;
    }

    try {
      const expectedRaw = BigInt(quoted.quotedOutputRaw);
      const actualRaw = BigInt(actual.amountOut);

      if (expectedRaw <= 0n) continue;

      // Calculate slippage in bps (negative = worse than expected)
      const slippageBps = Number((actualRaw - expectedRaw) * 10000n / expectedRaw);

      // Track the worst hop (most negative slippage)
      if (slippageBps < worstSlippageBps) {
        worstSlippageBps = slippageBps;
        worstIndex = i;
        worstExpected = expectedRaw;
        worstActual = actualRaw;
      }
    } catch (e) {
      // Skip hops with parsing errors
      continue;
    }
  }

  // Only return if slippage exceeds threshold
  if (worstIndex === -1 || worstSlippageBps > -minSlippageThresholdBps) {
    return null;
  }

  const quoted = hopQuotedOutputs[worstIndex];
  
  // Derive input/output mints from path
  const inputMint = path[worstIndex];
  const outputMint = path[worstIndex + 1] || path[0];  // Wrap for cycles

  return {
    hopIndex: worstIndex,
    poolId: quoted.poolId,
    dex: quoted.dex,
    inputMint,
    outputMint,
    expectedOutput: worstExpected,
    actualOutput: worstActual,
    slippageBps: worstSlippageBps,
  };
}

/**
 * Find alternative pools for a given token pair from the graph snapshot.
 * 
 * @param snapshot - Current graph snapshot with all pool edges
 * @param inputMint - Input token mint
 * @param outputMint - Output token mint  
 * @param excludePoolId - Pool ID to exclude (the problematic one)
 * @param minLiquidity - Minimum liquidity threshold
 * @param maxAlternatives - Maximum number of alternatives to return
 */
export function findAlternativePools(
  snapshot: GraphSnapshot,
  inputMint: string,
  outputMint: string,
  excludePoolId: string,
  minLiquidity: number = 1000,
  maxAlternatives: number = 3
): AlternativePool[] {
  const alternatives: AlternativePool[] = [];

  // Graph edges are stored in canonical direction (mint_a < mint_b lexicographically)
  // We need to find edges that connect inputMint -> outputMint in either direction
  
  for (const edge of snapshot.edges) {
    // Skip the problematic pool
    if (edge.pool_id === excludePoolId) {
      continue;
    }

    // Skip if pool_id is missing
    if (!edge.pool_id) {
      continue;
    }

    // Check if this edge connects our token pair (in either direction)
    const isForward = edge.source === inputMint && edge.target === outputMint;
    const isReverse = edge.source === outputMint && edge.target === inputMint;

    if (!isForward && !isReverse) {
      continue;
    }

    // Check liquidity threshold
    const liquidity = edge.liquidity_display ?? edge.liquidity ?? 0;
    if (liquidity < minLiquidity) {
      continue;
    }

    // Calculate effective rate for our direction
    // edge.price_a_per_b is "how many B tokens per 1 A token" (A → B rate)
    // If we're going A → B (forward), use price_a_per_b directly
    // If we're going B → A (reverse), we need 1 / price_a_per_b
    const priceAPerB = edge.price_a_per_b ?? 0;
    if (priceAPerB <= 0) {
      continue;
    }

    const rateEffective = isForward ? priceAPerB : (1 / priceAPerB);
    const feeBps = edge.fee_bps ?? 0;

    alternatives.push({
      poolId: edge.pool_id,
      dex: edge.dex,
      rateEffective,
      liquidity,
      feeBps,
    });
  }

  // Sort by effective rate (higher is better for swaps), then by liquidity
  alternatives.sort((a, b) => {
    // Primary: better rate
    const rateDiff = b.rateEffective - a.rateEffective;
    if (Math.abs(rateDiff) > 0.0001) {
      return rateDiff;
    }
    // Secondary: higher liquidity
    return b.liquidity - a.liquidity;
  });

  // Return top N alternatives
  return alternatives.slice(0, maxAlternatives);
}

/**
 * Main entry point: analyze a failed simulation and find alternative pools
 * for the problematic hop.
 */
export async function exploreAlternativePools(
  simAnalysis: SimulationAnalysis,
  hopQuotedOutputs: HopQuotedOutput[],
  path: string[],
  getSnapshot: () => Promise<GraphSnapshot>,
  options: {
    minSlippageThresholdBps?: number;
    minLiquidity?: number;
    maxAlternatives?: number;
  } = {}
): Promise<AlternativePoolResult> {
  const {
    minSlippageThresholdBps = 50,
    minLiquidity = 1000,
    maxAlternatives = 3,
  } = options;

  // Step 1: Find the problematic hop
  const problematicHop = findProblematicHop(
    hopQuotedOutputs,
    simAnalysis.hopActualOutputs || [],
    path,
    minSlippageThresholdBps
  );

  if (!problematicHop) {
    return {
      found: false,
      alternatives: [],
      problematicHop: null,
    };
  }

  logger.debug('altpool.problematic_hop.found', {
    cat: 'arb',
    hopIndex: problematicHop.hopIndex,
    poolId: problematicHop.poolId.slice(0, 12) + '...',
    dex: problematicHop.dex,
    inputMint: problematicHop.inputMint.slice(0, 8) + '...',
    outputMint: problematicHop.outputMint.slice(0, 8) + '...',
    slippageBps: problematicHop.slippageBps,
    expectedOutput: problematicHop.expectedOutput.toString(),
    actualOutput: problematicHop.actualOutput.toString(),
  });

  // Step 2: Get graph snapshot and find alternatives
  let snapshot: GraphSnapshot;
  try {
    snapshot = await getSnapshot();
  } catch (e) {
    logger.warn('altpool.snapshot.failed', { cat: 'arb', error: String(e) });
    return {
      found: false,
      alternatives: [],
      problematicHop,
    };
  }

  // Step 3: Find alternative pools
  const alternatives = findAlternativePools(
    snapshot,
    problematicHop.inputMint,
    problematicHop.outputMint,
    problematicHop.poolId,
    minLiquidity,
    maxAlternatives
  );

  if (alternatives.length > 0) {
    logger.info('altpool.alternatives.found', {
      cat: 'arb',
      hopIndex: problematicHop.hopIndex,
      originalPool: problematicHop.poolId.slice(0, 12) + '...',
      originalDex: problematicHop.dex,
      slippageBps: problematicHop.slippageBps,
      alternativeCount: alternatives.length,
      alternatives: alternatives.map(a => ({
        poolId: a.poolId.slice(0, 12) + '...',
        dex: a.dex,
        rate: a.rateEffective.toFixed(8),
        liquidity: a.liquidity.toFixed(0),
      })),
    });
  }

  return {
    found: alternatives.length > 0,
    alternatives,
    problematicHop,
  };
}

/**
 * Check if alternative pool exploration should be attempted.
 * Returns true if the simulation failed due to profit check (6007)
 * and we have the necessary data for analysis.
 */
export function shouldExploreAlternatives(
  simAnalysis: SimulationAnalysis,
  hopQuotedOutputs: HopQuotedOutput[] | undefined,
  hopActualOutputs: HopActualOutput[] | undefined
): boolean {
  // Only explore if profit check failed (all swaps executed but not profitable)
  if (!simAnalysis.profitCheckFailed) {
    return false;
  }

  // Need both quoted and actual outputs for comparison
  if (!hopQuotedOutputs || !hopActualOutputs) {
    return false;
  }

  // Need at least some data to analyze
  if (hopQuotedOutputs.length === 0 || hopActualOutputs.length === 0) {
    return false;
  }

  return true;
}
