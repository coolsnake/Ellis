/**
 * Batching utilities for getAccountInfo calls
 * 
 * Batches multiple getAccountInfo requests to reduce RPC load
 */

import { CONFIG } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

/**
 * Queue for batching getAccountInfo requests
 */
const accountInfoQueue: Map<string, { resolve: (info: any) => void; reject: (err: any) => void }[]> = new Map();
let accountInfoBatchTimer: NodeJS.Timeout | null = null;

/**
 * Batch getAccountInfo calls to reduce RPC load
 * Multiple requests for different accounts will be batched together
 */
export async function batchGetAccountInfo(conn: any, address: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!accountInfoQueue.has(address)) {
      accountInfoQueue.set(address, []);
    }
    accountInfoQueue.get(address)!.push({ resolve, reject });
    
    // Schedule batch processing
    if (!accountInfoBatchTimer) {
      accountInfoBatchTimer = setTimeout(async () => {
        accountInfoBatchTimer = null;
        const addresses = Array.from(accountInfoQueue.keys());
        if (addresses.length === 0) return;
        
        try {
          const { withRpcLimit } = await import('../../../utils/rpcLimiter.js');
          const web3 = await import('@solana/web3.js');
          const pks = addresses.map(addr => new web3.PublicKey(addr));
          
          // Use getMultipleAccountsInfo for batch fetch
          const weight = Math.max(1, Math.ceil(addresses.length / 100));
          const infos = await withRpcLimit(
            () => conn.getMultipleAccountsInfo(pks, CONFIG.system.txCommitment as any),
            weight,
            { module: 'pools', method: 'getMultipleAccountsInfo' }
          );
          
          // Resolve all promises
          addresses.forEach((addr, idx) => {
            const waiters = accountInfoQueue.get(addr) || [];
            const info = infos[idx];
            waiters.forEach(w => w.resolve(info));
            accountInfoQueue.delete(addr);
          });
        } catch (err) {
          // Reject all on error
          addresses.forEach(addr => {
            const waiters = accountInfoQueue.get(addr) || [];
            waiters.forEach(w => w.reject(err));
            accountInfoQueue.delete(addr);
          });
          
          logger.error('batching.getAccountInfo.failed', {
            error: String((err as any)?.message || err),
            addressCount: addresses.length,
            cat: 'pools'
          });
        }
      }, 50); // 50ms batch window
    }
  });
}

/**
 * Clear the batching queue (useful for cleanup)
 */
export function clearBatchQueue(): void {
  if (accountInfoBatchTimer) {
    clearTimeout(accountInfoBatchTimer);
    accountInfoBatchTimer = null;
  }
  accountInfoQueue.clear();
}

