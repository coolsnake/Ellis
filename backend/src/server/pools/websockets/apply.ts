/**
 * Debounced graph update application
 * 
 * Schedules and debounces DEX-specific graph updates to prevent excessive rebuilds
 */

import { logger } from '../../../utils/logger.js';
import type { DexSource, DexApplyState } from './types.js';

/**
 * Debounce interval for applying graph updates (milliseconds)
 */
const WS_APPLY_DEBOUNCE_MS = 100;

/**
 * Apply state per DEX
 */
const wsApply: Record<DexSource, DexApplyState> = {
  raydium: { baseline: null, timer: null },
  'raydium-cpmm': { baseline: null, timer: null },
  orca: { baseline: null, timer: null },
  meteora_dlmm: { baseline: null, timer: null },
  meteora_damm_v1: { baseline: null, timer: null },
  meteora_damm_v2: { baseline: null, timer: null },
  pumpswap: { baseline: null, timer: null },
};

/**
 * Get current cache for a DEX
 */
type GetCurrentCacheFn = (dex: DexSource) => any;
let getCurrentCacheFn: GetCurrentCacheFn | null = null;

/**
 * Set the function to get current cache
 */
export function setGetCurrentCacheFn(fn: GetCurrentCacheFn): void {
  getCurrentCacheFn = fn;
}

/**
 * Schedule a debounced graph update for a specific DEX
 * Multiple updates within the debounce window will be coalesced
 */
export async function scheduleDexApply(dex: DexSource, baseline: any): Promise<void> {
  try {
    if (!wsApply[dex].baseline) {
      wsApply[dex].baseline = baseline;
    }
    
    // Reset timer on new updates - clear existing timer if present
    if (wsApply[dex].timer) {
      clearTimeout(wsApply[dex].timer);
      wsApply[dex].timer = null;
    }
    
    wsApply[dex].timer = setTimeout(async () => {
      const base = wsApply[dex].baseline;
      wsApply[dex].baseline = null;
      wsApply[dex].timer = null;
      
      if (!base) return;
      
      try {
        const gmod: any = await import('../../graph.js');
        const cur = getCurrentCacheFn ? getCurrentCacheFn(dex) : null;
        
        if (typeof gmod.applyPoolUpdates === 'function' && cur) {
          // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
          await gmod.applyPoolUpdates(base, cur, { pushToArb: false });
        }
      } catch (err) {
        logger.error('apply.graph_update.failed', {
          dex,
          error: String((err as any)?.message || err),
          cat: 'pools'
        });
      }
    }, WS_APPLY_DEBOUNCE_MS);
  } catch (err) {
    logger.error('apply.schedule.failed', {
      dex,
      error: String((err as any)?.message || err),
      cat: 'pools'
    });
  }
}

/**
 * Clear all debounce timers
 */
export function clearAllApplyTimers(): void {
  for (const dex of ['raydium', 'raydium-cpmm', 'orca', 'meteora_dlmm', 'meteora_damm_v1', 'meteora_damm_v2', 'pumpswap'] as DexSource[]) {
    if (wsApply[dex].timer) {
      clearTimeout(wsApply[dex].timer);
      wsApply[dex].timer = null;
    }
    wsApply[dex].baseline = null;
  }
}

/**
 * Get apply state for debugging
 */
export function getApplyState(): Record<DexSource, { hasBaseline: boolean; hasTimer: boolean }> {
  return {
    raydium: { hasBaseline: !!wsApply.raydium.baseline, hasTimer: !!wsApply.raydium.timer },
    'raydium-cpmm': { hasBaseline: !!wsApply['raydium-cpmm'].baseline, hasTimer: !!wsApply['raydium-cpmm'].timer },
    orca: { hasBaseline: !!wsApply.orca.baseline, hasTimer: !!wsApply.orca.timer },
    meteora_dlmm: { hasBaseline: !!wsApply.meteora_dlmm.baseline, hasTimer: !!wsApply.meteora_dlmm.timer },
    meteora_damm_v1: { hasBaseline: !!wsApply.meteora_damm_v1.baseline, hasTimer: !!wsApply.meteora_damm_v1.timer },
    meteora_damm_v2: { hasBaseline: !!wsApply.meteora_damm_v2.baseline, hasTimer: !!wsApply.meteora_damm_v2.timer },
    pumpswap: { hasBaseline: !!wsApply.pumpswap.baseline, hasTimer: !!wsApply.pumpswap.timer },
  };
}

