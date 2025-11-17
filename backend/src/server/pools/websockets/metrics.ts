/**
 * Metrics aggregation for WebSocket pool monitoring
 * 
 * Tracks decode statistics, delta statistics, and skip reasons
 */

import { wsDecodeStats, wsDeltaStats, incrementSkipReason, wsDebugCounters, wsTargetDebugCounters } from '../../pools.metrics.js';
import type { DexSource } from './types.js';

/**
 * Re-export metrics from pools.metrics for convenience
 */
export { wsDecodeStats, wsDeltaStats, incrementSkipReason, wsDebugCounters, wsTargetDebugCounters };

/**
 * WebSocket activity counts per DEX
 */
const wsCounts: Record<DexSource, number> = {
  raydium: 0,
  orca: 0,
  meteora: 0,
  pumpswap: 0,
  meteora_balanced: 0,
};

/**
 * Get current WebSocket counts
 */
export function getWsCounts(): Record<DexSource, number> {
  return { ...wsCounts };
}

/**
 * Increment WebSocket count for a DEX
 */
export function incrementWsCount(dex: DexSource): void {
  wsCounts[dex]++;
}

/**
 * Reset WebSocket count for a DEX
 */
export function resetWsCount(dex: DexSource): void {
  wsCounts[dex] = 0;
}

/**
 * Reset all WebSocket counts
 */
export function resetAllWsCounts(): void {
  wsCounts.raydium = 0;
  wsCounts.orca = 0;
  wsCounts.meteora = 0;
  wsCounts.pumpswap = 0;
  wsCounts.meteora_balanced = 0;
}

/**
 * Record successful decode
 */
export function recordDecodeSuccess(dex: DexSource): void {
  try {
    wsDecodeStats[dex].successes += 1;
  } catch {}
}

/**
 * Record failed decode
 */
export function recordDecodeFailure(dex: DexSource): void {
  try {
    wsDecodeStats[dex].failures += 1;
  } catch {}
}

/**
 * Record delta (pool update)
 */
export function recordDelta(dex: DexSource): void {
  try {
    wsDeltaStats[dex].decoded += 1;
  } catch {}
}

