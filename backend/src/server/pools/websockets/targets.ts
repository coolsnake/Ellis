/**
 * Target management for WebSocket subscriptions
 * 
 * Computes subscription targets from graph data and manages retargeting
 */

import { logger } from '../../../utils/logger.js';
import { CONFIG } from '../../../utils/config.js';
import { emit } from '../../realtime.js';

/**
 * Compute target counts for WS subscriptions based on current graph edges per source
 */
export async function getWsTargets(): Promise<{
  orca: { target: number };
  raydium: { target: number };
  meteora: { target: number };
  meteora_balanced: { target: number };
  pumpswap: { target: number };
}> {
  try {
    const { getGraphSnapshot } = await import('../../graph.js');
    const snap = await getGraphSnapshot(false);
    const ray = new Set<string>();
    const orc = new Set<string>();
    const met = new Set<string>();
    const metBal = new Set<string>();
    const pump = new Set<string>();
    
    for (const e of (snap?.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const base = pid.replace(/-rev$/, '');
      const dex = String((e as any)?.dex || '');
      if (dex === 'Raydium') ray.add(base);
      else if (dex === 'Orca') orc.add(base);
      else if (dex === 'Meteora') met.add(base);
      else if (dex.startsWith('MeteoraBalanced')) metBal.add(base);
      else if (dex === 'Pumpswap') pump.add(base);
    }
    
    const out = {
      orca: { target: orc.size },
      raydium: { target: ray.size },
      meteora: { target: met.size },
      meteora_balanced: { target: metBal.size },
      pumpswap: { target: pump.size }
    };
    
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  } catch {
    const out = {
      orca: { target: 0 },
      raydium: { target: 0 },
      meteora: { target: 0 },
      meteora_balanced: { target: 0 },
      pumpswap: { target: 0 }
    };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  }
}

/**
 * Retarget WebSocket subscriptions
 * Unsubscribes and re-subscribes to current graph-derived targets
 * Uses sequential subscription with throttling to avoid RPC burst
 * 
 * Note: This function coordinates with the main orchestrator for actual subscription logic
 */
export async function retargetPoolWebsockets(
  disableRefreshes: () => void,
  enableRefreshes: () => void,
  getClosePromise: () => Promise<void> | null,
  clearClosePromise: () => void
): Promise<{
  attached: {
    orca: number;
    raydium: number;
    meteora: number;
    meteora_balanced: number;
    pumpswap: number;
  };
}> {
  try {
    emit('log', {
      level: 'info',
      message: 'pools:ws retarget.start - sequential resubscription with throttling',
      timestamp: new Date().toISOString(),
      context: { cat: 'pools' }
    });
  } catch {}

  // Step 1: Unsubscribe all existing subscriptions
  try { disableRefreshes(); } catch {}

  // Step 2: Wait for websocket cleanup to complete before starting new subscriptions
  try {
    const closePromise = getClosePromise();
    if (closePromise) {
      await closePromise.catch(() => {});
      clearClosePromise();
    }
  } catch {}

  // Step 3: Cooldown period to let RPC limiter refill tokens after unsubscribe burst
  const cooldownMs = Number((CONFIG.system as any)?.wsRetargetCooldownMs || 2000);
  try {
    logger.info('pools.ws retarget.cooldown', { ms: cooldownMs, cat: 'pools' });
    emit('log', {
      level: 'info',
      message: `pools:ws retarget.cooldown ${cooldownMs}ms`,
      timestamp: new Date().toISOString(),
      context: { cat: 'pools' }
    });
  } catch {}
  await new Promise(r => setTimeout(r, cooldownMs));

  // Step 4: Re-enable subscriptions (will trigger new setup)
  try { enableRefreshes(); } catch {}

  // Step 5: Wait briefly for setup to attach subscriptions
  await new Promise(r => setTimeout(r, 500));

  // Return current counts (will be updated by the orchestrator)
  return {
    attached: {
      orca: 0,
      raydium: 0,
      meteora: 0,
      meteora_balanced: 0,
      pumpswap: 0,
    },
  };
}

