/**
 * Cache preloading utilities
 * 
 * Pre-populates vault balance caches before WebSocket subscriptions
 * to prevent decode failures when pool events arrive before vault events
 */

import { logger } from '../../../utils/logger.js';
import { CONFIG } from '../../../utils/config.js';
import { vaultBalanceCache, pumpswapCache, metbalCache } from '../../pools.cache.js';
import { parseTokenAccountAmount } from '../../pools.utils.js';

/**
 * Pre-populate vault balance cache for pumpswap pools
 * This prevents pool decode failures when pool events arrive before vault events
 */
export async function preloadPumpswapVaultCache(): Promise<void> {
  const pools = pumpswapCache.data?.amm || [];
  if (pools.length === 0) {
    return;
  }

  try {
    logger.info('pumpswap.preload.vault_cache.start', {
      poolCount: pools.length,
      cat: 'pools'
    });

    const vaultAddresses = new Set<string>();
    for (const pool of pools) {
      if (pool.account_a) vaultAddresses.add(pool.account_a);
      if (pool.account_b) vaultAddresses.add(pool.account_b);
    }

    if (vaultAddresses.size === 0) {
      return;
    }

    const { withRpcLimit } = await import('../../../utils/rpcLimiter.js');
    const web3 = await import('@solana/web3.js');
    const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
    const pks = Array.from(vaultAddresses).map(addr => new web3.PublicKey(addr));

    const weight = Math.max(1, Math.ceil(pks.length / 100));
    const infos = await withRpcLimit(
      () => conn.getMultipleAccountsInfo(pks, CONFIG.system.txCommitment as any),
      weight,
      { module: 'pools', method: 'getMultipleAccountsInfo' }
    );

    let loaded = 0;
    for (let i = 0; i < pks.length; i++) {
      const info = infos[i];
      if (info?.data) {
        const address = pks[i].toBase58();
        const balance = parseTokenAccountAmount(info.data);
        if (balance !== null) {
          vaultBalanceCache.set(address, balance);
          loaded++;
        }
      }
    }

    logger.info('pumpswap.preload.vault_cache.complete', {
      totalVaults: vaultAddresses.size,
      loaded,
      cat: 'pools'
    });
  } catch (err) {
    logger.error('pumpswap.preload.vault_cache.failed', {
      error: String((err as any)?.message || err),
      cat: 'pools'
    });
  }
}

/**
 * Pre-populate vault balance cache for meteora_balanced pools
 * This prevents pool decode failures when pool events arrive before vault events
 */
export async function preloadMeteoraBalancedVaultCache(): Promise<void> {
  const pools = metbalCache.data?.amm || [];
  if (pools.length === 0) {
    return;
  }

  try {
    logger.info('meteora_balanced.preload.vault_cache.start', {
      poolCount: pools.length,
      cat: 'pools'
    });

    const vaultAddresses = new Set<string>();
    for (const pool of pools) {
      if (pool.account_a) vaultAddresses.add(pool.account_a);
      if (pool.account_b) vaultAddresses.add(pool.account_b);
    }

    if (vaultAddresses.size === 0) {
      return;
    }

    const { withRpcLimit } = await import('../../../utils/rpcLimiter.js');
    const web3 = await import('@solana/web3.js');
    const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
    const pks = Array.from(vaultAddresses).map(addr => new web3.PublicKey(addr));

    const weight = Math.max(1, Math.ceil(pks.length / 100));
    const infos = await withRpcLimit(
      () => conn.getMultipleAccountsInfo(pks, CONFIG.system.txCommitment as any),
      weight,
      { module: 'pools', method: 'getMultipleAccountsInfo' }
    );

    let loaded = 0;
    for (let i = 0; i < pks.length; i++) {
      const info = infos[i];
      if (info?.data) {
        const address = pks[i].toBase58();
        const balance = parseTokenAccountAmount(info.data);
        if (balance !== null) {
          vaultBalanceCache.set(address, balance);
          loaded++;
        }
      }
    }

    logger.info('meteora_balanced.preload.vault_cache.complete', {
      totalVaults: vaultAddresses.size,
      loaded,
      cat: 'pools'
    });
  } catch (err) {
    logger.error('meteora_balanced.preload.vault_cache.failed', {
      error: String((err as any)?.message || err),
      cat: 'pools'
    });
  }
}

