/**
 * Metrics aggregation for WebSocket pool monitoring
 * 
 * Tracks decode statistics, delta statistics, and skip reasons
 */

import { wsDecodeStats, wsDeltaStats, incrementSkipReason, wsDebugCounters, wsTargetDebugCounters } from '../../pools.metrics.js';
import type { DexSource } from './types.js';
import { logCatchError } from '../../../utils/errorHandler.js';

/**
 * Re-export metrics from pools.metrics for convenience
 */
export { wsDecodeStats, wsDeltaStats, incrementSkipReason, wsDebugCounters, wsTargetDebugCounters };

/**
 * WebSocket activity counts per DEX
 */
const wsCounts: Record<DexSource, number> = {
  raydium: 0,
  'raydium-cpmm': 0,
  orca: 0,
  meteora_dlmm: 0,
  meteora_damm_v1: 0,
  meteora_damm_v2: 0,
  pumpswap: 0,
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
  wsCounts.meteora_dlmm = 0;
  wsCounts.meteora_damm_v1 = 0;
  wsCounts.meteora_damm_v2 = 0;
  wsCounts.pumpswap = 0;
}

/**
 * Record successful decode
 */
export function recordDecodeSuccess(dex: DexSource): void {
  try {
    wsDecodeStats[dex].successes += 1;
  } catch (e) { logCatchError('pools.ws.metrics', e); }
}

/**
 * Record failed decode
 */
export function recordDecodeFailure(dex: DexSource): void {
  try {
    wsDecodeStats[dex].failures += 1;
  } catch (e) { logCatchError('pools.ws.metrics', e); }
}

/**
 * Record delta (pool update)
 */
export function recordDelta(dex: DexSource): void {
  try {
    wsDeltaStats[dex].decoded += 1;
  } catch (e) { logCatchError('pools.ws.metrics', e); }
}

