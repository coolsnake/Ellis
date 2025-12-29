/**
 * MarginFi Flashloan Cache
 * 
 * Caches validated MarginFi accounts, banks, and PDAs after successful flashloan tests
 * to avoid slow SDK calls when building flashloan instructions for router transactions.
 */

import { PublicKey } from '@solana/web3.js';
import { ensureDir, readJson, writeJson, joinPath } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  MARGINFI_PROGRAM_ID,
  MARGINFI_GROUP_ID,
  deriveMarginfiAccountPda,
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
  MARGINFI_BANKS,
} from './flashloan.js';

// ============================================================================
// Types
// ============================================================================

export interface MarginfiFlashloanCache {
  /** Per-wallet MarginFi account PDAs */
  accounts: Array<[string, {
    /** MarginFi account PDA address */
    address: string;
    /** Authority (wallet) that owns this account */
    authority: string;
    /** When this was validated (timestamp) */
    validatedAt: number;
  }]>;
  
  /** Per-token bank and vault information */
  banks: Array<['SOL' | 'USDC', {
    /** Bank address */
    bank: string;
    /** Liquidity vault address */
    liquidityVault: string;
    /** Liquidity vault authority address */
    liquidityVaultAuthority: string;
    /** Mint address */
    mint: string;
    /** When this was validated (timestamp) */
    validatedAt: number;
  }]>;
  
  /** Cache metadata */
  metadata: {
    /** Last time cache was updated */
    lastUpdated: number;
    /** Cache version for migration */
    version: number;
  };
}

// ============================================================================
// Cache Implementation
// ============================================================================

export class MarginfiFlashloanCacheManager {
  private accounts: Map<string, {
    address: string;
    authority: string;
    validatedAt: number;
  }> = new Map();
  
  private banks: Map<'SOL' | 'USDC', {
    bank: string;
    liquidityVault: string;
    liquidityVaultAuthority: string;
    mint: string;
    validatedAt: number;
  }> = new Map();
  
  private cacheFile: string;
  private ttlMs: number; // Time-to-live for cached entries (default 24 hours)
  private lastUpdated: number = Date.now();
  private version: number = 1;

  constructor(opts?: { ttlMs?: number; cacheFileName?: string }) {
    this.ttlMs = opts?.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours default
    const fileName = opts?.cacheFileName || 'marginfi-flashloan-cache.json';
    this.cacheFile = joinPath(CONFIG.cacheDir, fileName);
  }

  /**
   * Get cached MarginFi account for a wallet
   */
  getAccount(authority: PublicKey | string): string | null {
    const authorityStr = typeof authority === 'string' ? authority : authority.toBase58();
    const entry = this.accounts.get(authorityStr);
    
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() > entry.validatedAt + this.ttlMs) {
      this.accounts.delete(authorityStr);
      return null;
    }
    
    return entry.address;
  }

  /**
   * Cache a validated MarginFi account
   */
  setAccount(authority: PublicKey | string, accountAddress: PublicKey | string): void {
    const authorityStr = typeof authority === 'string' ? authority : authority.toBase58();
    const accountStr = typeof accountAddress === 'string' ? accountAddress : accountAddress.toBase58();
    
    this.accounts.set(authorityStr, {
      address: accountStr,
      authority: authorityStr,
      validatedAt: Date.now(),
    });
    
    this.lastUpdated = Date.now();
    
    logger.debug('marginfi.cache.account.set', {
      cat: 'marginfi',
      authority: authorityStr,
      account: accountStr,
    });
  }

  /**
   * Get cached bank info for a token
   */
  getBank(token: 'SOL' | 'USDC'): {
    bank: string;
    liquidityVault: string;
    liquidityVaultAuthority: string;
    mint: string;
  } | null {
    const entry = this.banks.get(token);
    
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() > entry.validatedAt + this.ttlMs) {
      this.banks.delete(token);
      return null;
    }
    
    return {
      bank: entry.bank,
      liquidityVault: entry.liquidityVault,
      liquidityVaultAuthority: entry.liquidityVaultAuthority,
      mint: entry.mint,
    };
  }

  /**
   * Cache validated bank info for a token
   */
  setBank(
    token: 'SOL' | 'USDC',
    bank: PublicKey | string,
    liquidityVault: PublicKey | string,
    liquidityVaultAuthority: PublicKey | string,
    mint: PublicKey | string
  ): void {
    const bankStr = typeof bank === 'string' ? bank : bank.toBase58();
    const vaultStr = typeof liquidityVault === 'string' ? liquidityVault : liquidityVault.toBase58();
    const vaultAuthStr = typeof liquidityVaultAuthority === 'string' ? liquidityVaultAuthority : liquidityVaultAuthority.toBase58();
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    
    this.banks.set(token, {
      bank: bankStr,
      liquidityVault: vaultStr,
      liquidityVaultAuthority: vaultAuthStr,
      mint: mintStr,
      validatedAt: Date.now(),
    });
    
    this.lastUpdated = Date.now();
    
    logger.debug('marginfi.cache.bank.set', {
      cat: 'marginfi',
      token,
      bank: bankStr,
    });
  }

  /**
   * Get or derive MarginFi account PDA (uses cache if available)
   */
  getOrDeriveAccount(
    authority: PublicKey,
    group: PublicKey = MARGINFI_GROUP_ID,
    accountIndex: number = 0
  ): PublicKey {
    // Try cache first
    const cached = this.getAccount(authority);
    if (cached) {
      return new PublicKey(cached);
    }
    
    // Derive if not cached
    const [pda] = deriveMarginfiAccountPda(group, authority, accountIndex);
    return pda;
  }

  /**
   * Get or derive bank vault info (uses cache if available)
   */
  getOrDeriveBank(token: 'SOL' | 'USDC'): {
    bank: PublicKey;
    liquidityVault: PublicKey;
    liquidityVaultAuthority: PublicKey;
    mint: PublicKey;
  } {
    // Try cache first
    const cached = this.getBank(token);
    if (cached) {
      return {
        bank: new PublicKey(cached.bank),
        liquidityVault: new PublicKey(cached.liquidityVault),
        liquidityVaultAuthority: new PublicKey(cached.liquidityVaultAuthority),
        mint: new PublicKey(cached.mint),
      };
    }
    
    // Use constants and derive if not cached
    const bank = MARGINFI_BANKS[token];
    const [liquidityVault] = deriveLiquidityVault(bank);
    const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(bank);
    
    // Get mint from constants or derive
    const mint = token === 'SOL' 
      ? new PublicKey('So11111111111111111111111111111111111111112')
      : new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    
    return {
      bank,
      liquidityVault,
      liquidityVaultAuthority,
      mint,
    };
  }

  /**
   * Save cache to disk
   */
  async save(): Promise<void> {
    try {
      await ensureDir(joinPath(this.cacheFile, '..'));
      
      // Convert Maps to arrays for JSON serialization
      const payload: MarginfiFlashloanCache = {
        accounts: Array.from(this.accounts.entries()),
        banks: Array.from(this.banks.entries()),
        metadata: {
          lastUpdated: this.lastUpdated,
          version: this.version,
        },
      };
      
      await writeJson(this.cacheFile, payload);
      
      logger.debug('marginfi.cache.saved', {
        cat: 'marginfi',
        accounts: this.accounts.size,
        banks: this.banks.size,
      });
    } catch (err: any) {
      logger.error('marginfi.cache.save.error', {
        cat: 'marginfi',
        error: err.message,
      });
    }
  }

  /**
   * Load cache from disk
   */
  async load(): Promise<void> {
    try {
      const payload = await readJson<MarginfiFlashloanCache>(this.cacheFile, {
        accounts: [],
        banks: [],
        metadata: { lastUpdated: 0, version: 1 },
      });
      
      // Restore Maps from arrays
      this.accounts = new Map(payload.accounts || []);
      this.banks = new Map(payload.banks || []);
      this.lastUpdated = payload.metadata?.lastUpdated || Date.now();
      this.version = payload.metadata?.version || 1;
      
      // Clean up expired entries
      this.cleanExpired();
      
      logger.info('marginfi.cache.loaded', {
        cat: 'marginfi',
        accounts: this.accounts.size,
        banks: this.banks.size,
      });
    } catch (err: any) {
      // Cache file doesn't exist or is invalid - start fresh
      logger.debug('marginfi.cache.load.miss', {
        cat: 'marginfi',
        error: err.message,
      });
    }
  }

  /**
   * Clean expired entries
   */
  private cleanExpired(): void {
    const now = Date.now();
    
    // Clean expired accounts
    for (const [authority, entry] of this.accounts.entries()) {
      if (now > entry.validatedAt + this.ttlMs) {
        this.accounts.delete(authority);
      }
    }
    
    // Clean expired banks
    for (const [token, entry] of this.banks.entries()) {
      if (now > entry.validatedAt + this.ttlMs) {
        this.banks.delete(token);
      }
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.accounts.clear();
    this.banks.clear();
    this.lastUpdated = Date.now();
  }
}

// Singleton instance
export const marginfiFlashloanCache = new MarginfiFlashloanCacheManager();

