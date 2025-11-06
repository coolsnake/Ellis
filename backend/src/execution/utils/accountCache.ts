import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { getConnection } from '../../utils/connection.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';

interface CachedAccount {
  data: AccountInfo<Buffer>;
  expiresAt: number;
}

/**
 * Cache for account data to avoid per-transaction RPC calls
 */
export class AccountDataCache {
  private cache = new Map<string, CachedAccount>();
  private defaultTtl: number;
  private maxSize: number;

  constructor(defaultTtl: number = 5000, maxSize: number = 10000) {
    this.defaultTtl = defaultTtl;
    this.maxSize = maxSize;
  }

  /**
   * Get account info, using cache if available and fresh
   */
  async getAccountInfo(
    address: PublicKey | string,
    ttl?: number
  ): Promise<AccountInfo<Buffer> | null> {
    const key = typeof address === 'string' ? address : address.toBase58();
    const cached = this.cache.get(key);
    const now = Date.now();
    
    // Return cached if still valid
    if (cached && now < cached.expiresAt) {
      return cached.data;
    }

    // Fetch fresh data
    const connection = getConnection();
    const pubkey = typeof address === 'string' ? new PublicKey(address) : address;
    
    try {
      const info = await withRpcLimit(() => connection.getAccountInfo(pubkey));
      
      if (info) {
        const expiresAt = now + (ttl || this.defaultTtl);
        this.set(key, { data: info, expiresAt });
        return info;
      }
      
      return null;
    } catch (error) {
      try {
        logger.warn('account.cache.fetch.error', {
          cat: 'tx',
          ctx: {
            address: key,
            error: String((error as any)?.message || error),
          },
        });
      } catch {}
      return null;
    }
  }

  /**
   * Batch fetch multiple accounts
   */
  async getMultipleAccountsInfo(
    addresses: (PublicKey | string)[]
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const keys = addresses.map(a => typeof a === 'string' ? a : a.toBase58());
    const now = Date.now();
    
    // Check cache first
    const cached: (AccountInfo<Buffer> | null)[] = [];
    const toFetch: { index: number; pubkey: PublicKey }[] = [];
    
    for (let i = 0; i < keys.length; i++) {
      const cachedEntry = this.cache.get(keys[i]);
      if (cachedEntry && now < cachedEntry.expiresAt) {
        cached[i] = cachedEntry.data;
      } else {
        const pubkey = typeof addresses[i] === 'string' 
          ? new PublicKey(addresses[i]) 
          : addresses[i];
        toFetch.push({ index: i, pubkey });
      }
    }

    // Fill in cached results
    const result: (AccountInfo<Buffer> | null)[] = new Array(addresses.length);
    for (let i = 0; i < cached.length; i++) {
      if (cached[i] !== undefined) {
        result[i] = cached[i];
      }
    }

    // Fetch missing accounts
    if (toFetch.length > 0) {
      const connection = getConnection();
      const pubkeys = toFetch.map(tf => tf.pubkey);
      
      try {
        const infos = await withRpcLimit(() => 
          connection.getMultipleAccountsInfo(pubkeys)
        );
        
        const expiresAt = now + this.defaultTtl;
        for (let i = 0; i < toFetch.length; i++) {
          const info = infos[i];
          const key = keys[toFetch[i].index];
          result[toFetch[i].index] = info;
          
          if (info) {
            this.set(key, { data: info, expiresAt });
          }
        }
      } catch (error) {
        try {
          logger.warn('account.cache.batch.error', {
            cat: 'tx',
            ctx: {
              count: toFetch.length,
              error: String((error as any)?.message || error),
            },
          });
        } catch {}
      }
    }

    return result;
  }

  /**
   * Set cache entry
   */
  private set(key: string, entry: CachedAccount): void {
    // Evict oldest entries if at max size
    if (this.cache.size >= this.maxSize) {
      const sorted = Array.from(this.cache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      
      // Remove oldest 10%
      const toRemove = Math.ceil(this.maxSize * 0.1);
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(sorted[i][0]);
      }
    }
    
    this.cache.set(key, entry);
  }

  /**
   * Invalidate cache entry
   */
  invalidate(address: PublicKey | string): void {
    const key = typeof address === 'string' ? address : address.toBase58();
    this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clean expired entries
   */
  cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache stats
   */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }
}

// Singleton instance
export const accountCache = new AccountDataCache(5000, 10000);

// Periodic cleanup of expired entries
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    try {
      accountCache.cleanExpired();
    } catch {}
  }, 30000); // Every 30 seconds
}

