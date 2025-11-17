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
  orca: { baseline: null, timer: null },
  meteora: { baseline: null, timer: null },
  pumpswap: { baseline: null, timer: null },
  meteora_balanced: { baseline: null, timer: null },
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
          await gmod.applyPoolUpdates(base, cur, { pushToArb: true });
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
  for (const dex of ['raydium', 'orca', 'meteora', 'pumpswap', 'meteora_balanced'] as DexSource[]) {
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
    orca: { hasBaseline: !!wsApply.orca.baseline, hasTimer: !!wsApply.orca.timer },
    meteora: { hasBaseline: !!wsApply.meteora.baseline, hasTimer: !!wsApply.meteora.timer },
    pumpswap: { hasBaseline: !!wsApply.pumpswap.baseline, hasTimer: !!wsApply.pumpswap.timer },
    meteora_balanced: { hasBaseline: !!wsApply.meteora_balanced.baseline, hasTimer: !!wsApply.meteora_balanced.timer },
  };
}

