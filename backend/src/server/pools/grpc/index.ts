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
import {
  raydiumCache,
  orcaCache,
  meteoraCache,
  metbalCache,
  pumpswapCache,
  cpmmCache
} from '../../pools.cache.js';
import type { AmmPool, ClmmPool, CpmmPool } from '../types.js';

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
 * Get derived accounts (vaults) for a pool based on its DEX type.
 *
 * Different DEXes have different price sources:
 * - CLMM pools (Orca, Raydium CLMM, Meteora DLMM): Price is in pool account (sqrt_price_x64 or activeId)
 * - AMM pools (Raydium AMM, Raydium CPMM, Meteora Balanced, Pumpswap): Price derived from vault balances
 *
 * For AMM pools, we need to subscribe to vault accounts to get real-time pricing.
 */
function getDerivedAccountsForPool(
  poolId: string,
  dexType: PoolSubscription['dex']
): string[] {
  const derivedAccounts: string[] = [];

  // Helper to add valid vault address
  const addVault = (addr: string | undefined) => {
    if (addr && addr.length > 30 && isValidPublicKey(addr) && addr !== poolId) {
      derivedAccounts.push(addr);
    }
  };

  // Meteora Balanced (DAMM v1/v2) - vault-based pricing
  if (dexType === 'meteora_balanced') {
    const pools = metbalCache.data;
    if (pools) {
      const pool = pools.amm.find(p => p.id === poolId) as AmmPool | undefined;
      if (pool) {
        // Prefer native accounts (on-chain orientation)
        addVault(pool.native_account_a);
        addVault(pool.native_account_b);
        // Fallback to canonical accounts if native not available
        if (derivedAccounts.length === 0) {
          addVault(pool.account_a);
          addVault(pool.account_b);
        }
      }
    }
  }

  // Pumpswap - vault-based pricing
  else if (dexType === 'pumpswap') {
    const pools = pumpswapCache.data;
    if (pools) {
      const pool = pools.amm.find(p => p.id === poolId) as AmmPool | undefined;
      if (pool) {
        addVault(pool.native_account_a);
        addVault(pool.native_account_b);
        if (derivedAccounts.length === 0) {
          addVault(pool.account_a);
          addVault(pool.account_b);
        }
      }
    }
  }

  // Raydium AMM - vault-based pricing (also handles CLMM which doesn't need vaults)
  else if (dexType === 'raydium') {
    const pools = raydiumCache.data;
    if (pools) {
      // Check AMM pools (vault-based pricing)
      const ammPool = pools.amm.find(p => p.id === poolId) as AmmPool | undefined;
      if (ammPool) {
        addVault(ammPool.native_account_a);
        addVault(ammPool.native_account_b);
        if (derivedAccounts.length === 0) {
          addVault(ammPool.account_a);
          addVault(ammPool.account_b);
        }
      }
      // CLMM pools don't need vault subscriptions (price is in pool account)
    }
  }

  // Raydium CPMM - vault-based pricing
  else if (dexType === 'raydium-cpmm') {
    const cpmmPools = cpmmCache.data;
    if (cpmmPools) {
      const cpmmPool = cpmmPools.cpmm.find(p => p.id === poolId) as CpmmPool | undefined;
      if (cpmmPool) {
        addVault(cpmmPool.native_account_a);
        addVault(cpmmPool.native_account_b);
        if (derivedAccounts.length === 0) {
          addVault(cpmmPool.account_a);
          addVault(cpmmPool.account_b);
        }
      }
    }
  }

  // Orca - CLMM pools have price in pool account, but we can optionally track vaults
  // for liquidity updates (not strictly required for pricing)
  else if (dexType === 'orca') {
    // Orca Whirlpool uses sqrt_price_x64 in pool account - no vault subscription needed
    // However, if we want liquidity tracking, we could add vaults here
  }

  // Meteora DLMM - price from activeId/binStep in pool account
  else if (dexType === 'meteora') {
    // Meteora DLMM uses activeId + binStep in pool account - no vault subscription needed
  }

  return derivedAccounts;
}

/**
 * Extract pool targets from graph snapshot for gRPC subscription.
 *
 * This function builds subscription targets including:
 * 1. Pool accounts (for all pools)
 * 2. Vault accounts (for AMM pools that derive price from vault balances)
 */
export async function getPoolTargetsForGrpc(): Promise<PoolSubscription[]> {
  try {
    const { getGraphSnapshot } = await import('../../graph.js');
    const snap = await getGraphSnapshot(false);
    const pools: PoolSubscription[] = [];
    const seen = new Set<string>();

    // Stats for logging
    let totalVaults = 0;
    const vaultsByDex: Record<string, number> = {
      raydium: 0,
      'raydium-cpmm': 0,
      orca: 0,
      meteora: 0,
      meteora_balanced: 0,
      pumpswap: 0,
    };

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
      else if (dex === 'RaydiumCpmm') dexType = 'raydium-cpmm';
      else if (dex === 'Orca') dexType = 'orca';
      else if (dex === 'Meteora') dexType = 'meteora';
      else if (dex.startsWith('MeteoraBalanced')) dexType = 'meteora_balanced';
      else if (dex === 'Pumpswap') dexType = 'pumpswap';

      if (!dexType) continue;

      // Get derived accounts (vaults) for this pool
      const derivedAccounts = getDerivedAccountsForPool(base, dexType);

      if (derivedAccounts.length > 0) {
        totalVaults += derivedAccounts.length;
        vaultsByDex[dexType] += derivedAccounts.length;
      }

      pools.push({
        poolId: base,
        dex: dexType,
        derivedAccounts: derivedAccounts.length > 0 ? derivedAccounts : undefined,
      });
    }

    logger.info('grpc.targets.computed', {
      totalPools: pools.length,
      totalVaults,
      byDex: {
        raydium: pools.filter(p => p.dex === 'raydium').length,
        'raydium-cpmm': pools.filter(p => p.dex === 'raydium-cpmm').length,
        orca: pools.filter(p => p.dex === 'orca').length,
        meteora: pools.filter(p => p.dex === 'meteora').length,
        meteora_balanced: pools.filter(p => p.dex === 'meteora_balanced').length,
        pumpswap: pools.filter(p => p.dex === 'pumpswap').length,
      },
      vaultsByDex,
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

