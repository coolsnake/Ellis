/**
 * gRPC Pool Streaming Module
 * 
 * Provides Yellowstone gRPC streaming as an alternative to WSS subscriptions.
 * Exports adapter management functions and helpers.
 */

import { GrpcStreamAdapter, GrpcAdapterConfig, PoolSubscription, DexMetrics, DexMetricsMap } from './adapter.js';
import { CONFIG } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { isValidPublicKey } from '../../../execution/builder/utils.js';

// Re-export types
export { GrpcStreamAdapter, GrpcAdapterConfig, PoolSubscription, DexMetrics, DexMetricsMap };

// Singleton instance
let grpcAdapter: GrpcStreamAdapter | null = null;

/**
 * Get the current gRPC adapter instance
 */
export function getGrpcAdapter(): GrpcStreamAdapter | null {
  return grpcAdapter;
}

/**
 * Initialize a new gRPC adapter with the given config
 */
export function initGrpcAdapter(config: GrpcAdapterConfig): GrpcStreamAdapter {
  if (grpcAdapter) {
    grpcAdapter.disconnect().catch(() => {});
  }
  grpcAdapter = new GrpcStreamAdapter(config);
  return grpcAdapter;
}

/**
 * Shutdown the gRPC adapter
 */
export async function shutdownGrpcAdapter(): Promise<void> {
  if (grpcAdapter) {
    await grpcAdapter.disconnect();
    grpcAdapter = null;
  }
}

/**
 * Check if gRPC mode is configured and ready
 */
export function isGrpcConfigured(): boolean {
  const grpcConfig = (CONFIG.system as any)?.grpc;
  return !!(grpcConfig?.endpoint && grpcConfig?.xToken);
}

/**
 * Get gRPC configuration from CONFIG
 */
export function getGrpcConfig(): GrpcAdapterConfig | null {
  const grpcConfig = (CONFIG.system as any)?.grpc;
  if (!grpcConfig?.endpoint || !grpcConfig?.xToken) {
    return null;
  }
  return {
    endpoint: grpcConfig.endpoint,
    xToken: grpcConfig.xToken,
    commitment: grpcConfig.commitment || 'processed',
    maxReconnectAttempts: grpcConfig.maxReconnectAttempts || 10,
    reconnectDelayMs: grpcConfig.reconnectDelayMs || 1000,
  };
}

/**
 * Extract pool targets from graph snapshot for gRPC subscription
 */
export async function getPoolTargetsForGrpc(): Promise<PoolSubscription[]> {
  try {
    const { getGraphSnapshot } = await import('../../graph.js');
    const snap = await getGraphSnapshot(false);
    const pools: PoolSubscription[] = [];
    const seen = new Set<string>();
    
    for (const e of (snap?.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const base = pid.replace(/[#-]rev$/, '');
      
      // Skip if already seen or not a valid public key
      if (seen.has(base)) continue;
      if (!isValidPublicKey(base)) continue;
      seen.add(base);
      
      const dex = String((e as any)?.dex || '');
      let dexType: PoolSubscription['dex'] | null = null;
      
      if (dex === 'Raydium') dexType = 'raydium';
      else if (dex === 'Orca') dexType = 'orca';
      else if (dex === 'Meteora') dexType = 'meteora';
      else if (dex.startsWith('MeteoraBalanced')) dexType = 'meteora_balanced';
      else if (dex === 'Pumpswap') dexType = 'pumpswap';
      
      if (!dexType) continue;
      
      pools.push({
        poolId: base,
        dex: dexType,
        // Derived accounts (vaults, oracles) could be added here based on cached pool data
        // For now, we just subscribe to the pool accounts
      });
    }
    
    logger.info('grpc.targets.computed', {
      totalPools: pools.length,
      byDex: {
        raydium: pools.filter(p => p.dex === 'raydium').length,
        orca: pools.filter(p => p.dex === 'orca').length,
        meteora: pools.filter(p => p.dex === 'meteora').length,
        meteora_balanced: pools.filter(p => p.dex === 'meteora_balanced').length,
        pumpswap: pools.filter(p => p.dex === 'pumpswap').length,
      },
      cat: 'grpc'
    });
    
    return pools;
  } catch (err) {
    logger.error('grpc.targets.failed', {
      error: String((err as Error)?.message || err),
      cat: 'grpc'
    });
    return [];
  }
}

/**
 * Get gRPC adapter status including per-DEX metrics
 */
export function getGrpcStatus(): {
  mode: 'grpc' | 'wss' | 'disabled';
  configured: boolean;
  connected: boolean;
  subscriptionCount: number;
  eventCount: number;
  lastEventMs: number;
  lastPongMs: number;
  reconnectAttempts: number;
  dexMetrics: DexMetricsMap | null;
} {
  const mode = (CONFIG.system as any)?.poolSubscriptionMode || 'wss';
  const configured = isGrpcConfigured();
  
  if (!grpcAdapter) {
    return {
      mode,
      configured,
      connected: false,
      subscriptionCount: 0,
      eventCount: 0,
      lastEventMs: 0,
      lastPongMs: 0,
      reconnectAttempts: 0,
      dexMetrics: null,
    };
  }
  
  const status = grpcAdapter.getStatus();
  return {
    mode,
    configured,
    connected: status.connected,
    subscriptionCount: status.subscriptionCount,
    eventCount: status.eventCount,
    lastEventMs: status.lastEventMs,
    lastPongMs: status.lastPongMs,
    reconnectAttempts: status.reconnectAttempts,
    dexMetrics: status.dexMetrics,
  };
}

/**
 * Start gRPC subscriptions
 * Called by the orchestrator when poolSubscriptionMode is 'grpc'
 */
export async function startGrpcSubscriptions(): Promise<boolean> {
  const config = getGrpcConfig();
  
  if (!config) {
    logger.error('grpc.start.config_missing', {
      message: 'gRPC endpoint or xToken not configured',
      cat: 'grpc'
    });
    return false;
  }
  
  try {
    const adapter = initGrpcAdapter(config);
    const connected = await adapter.connect();
    
    if (!connected) {
      logger.error('grpc.start.connect_failed', { cat: 'grpc' });
      return false;
    }
    
    // Get pool targets and subscribe
    const pools = await getPoolTargetsForGrpc();
    
    if (pools.length > 0) {
      await adapter.subscribeToAccounts(pools);
    } else {
      logger.warn('grpc.start.no_pools', {
        message: 'No pool targets found in graph',
        cat: 'grpc'
      });
    }
    
    logger.info('grpc.start.success', {
      poolCount: pools.length,
      cat: 'grpc'
    });
    
    return true;
  } catch (err) {
    logger.error('grpc.start.error', {
      error: String((err as Error)?.message || err),
      cat: 'grpc'
    });
    return false;
  }
}

/**
 * Retarget gRPC subscriptions to updated pool list
 */
export async function retargetGrpcSubscriptions(): Promise<boolean> {
  if (!grpcAdapter || !grpcAdapter.isActive()) {
    logger.warn('grpc.retarget.not_active', { cat: 'grpc' });
    return false;
  }
  
  try {
    const pools = await getPoolTargetsForGrpc();
    await grpcAdapter.retarget(pools);
    
    logger.info('grpc.retarget.success', {
      poolCount: pools.length,
      cat: 'grpc'
    });
    
    return true;
  } catch (err) {
    logger.error('grpc.retarget.error', {
      error: String((err as Error)?.message || err),
      cat: 'grpc'
    });
    return false;
  }
}

