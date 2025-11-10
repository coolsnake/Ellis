import { PublicKey, Connection } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface TokenAccountInfo {
  mint: string;
  address: string;
  owner: string;
  createdAt: number;
  lastUsed: number;
  scheduledCloseAt?: number; // When to close this account (if set)
  useCount?: number; // Track how frequently this account is used
}

export class TokenAccountManager {
  private tokenAccounts: Map<string, TokenAccountInfo> = new Map();
  private configPath: string;
  private connection: Connection;
  private recentCreations: Map<string, number> = new Map(); // Track recent account creations

  private scheduledClosures: Map<string, { closeAt: number; mint: string }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly DEFAULT_KEEP_OPEN_MS = 30 * 60 * 1000; // 30 minutes default
  private readonly FREQUENT_TOKEN_KEEP_OPEN_MS = 2 * 60 * 60 * 1000; // 2 hours for frequent tokens
  private readonly FREQUENT_TOKEN_THRESHOLD = 5; // Use 5+ times = frequent

  constructor(connection: Connection) {
    this.connection = connection;
    this.configPath = CONFIG.tokenAccountsPath;
    this.loadTokenAccounts();
    this.startCleanupScheduler();
  }

  private async loadTokenAccounts() {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const accounts = JSON.parse(data) as TokenAccountInfo[];
      for (const account of accounts) {
        this.tokenAccounts.set(account.address, account);
      }
      logger.info(`Loaded ${accounts.length} token accounts from config`);
    } catch (error) {
      // File doesn't exist or is invalid, start with empty map
      this.tokenAccounts = new Map();
    }
  }

  private async saveTokenAccounts() {
    try {
      const accounts = Array.from(this.tokenAccounts.values());
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(accounts, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save token accounts', { error: String(error) });
    }
  }

  async getOrCreateTokenAccount(
    mint: PublicKey,
    owner: PublicKey,
    payer: PublicKey
  ): Promise<{ address: PublicKey; isNew: boolean }> {
    // Clean up old recent creation entries
    this.cleanupRecentCreations();
    
    const mintStr = mint.toBase58();
    const ownerStr = owner.toBase58();
    const accountKey = `${mintStr}-${ownerStr}`;
    
    // Check if we recently tried to create this account (within last 60 seconds)
    const now = Date.now();
    const recentCreation = this.recentCreations.get(accountKey);
    if (recentCreation && (now - recentCreation) < 60000) {
      logger.debug(`Recent creation attempt detected for ${accountKey}, reusing existing account...`);
      // Return the associated token address but mark as not new to prevent creation
      const associatedTokenAddress = await getAssociatedTokenAddress(mint, owner);
      
      // Add to cache if not already there
      const addressStr = associatedTokenAddress.toBase58();
      if (!this.tokenAccounts.has(addressStr)) {
        const accountInfo: TokenAccountInfo = {
          mint: mintStr,
          address: addressStr,
          owner: ownerStr,
          createdAt: now,
          lastUsed: now
        };
        this.tokenAccounts.set(addressStr, accountInfo);
        await this.saveTokenAccounts();
      }
      
      return { address: associatedTokenAddress, isNew: false };
    }
    
    // First, check if we have a cached account for this mint/owner pair
    for (const [address, info] of this.tokenAccounts.entries()) {
      if (info.mint === mintStr && info.owner === ownerStr) {
        // Verify the account still exists on-chain
        try {
          const account = await getAccount(this.connection, new PublicKey(address));
          if (account.owner.equals(owner)) {
            // Update last used timestamp and increment use count
            info.lastUsed = Date.now();
            info.useCount = (info.useCount || 0) + 1;
            // Cancel scheduled closure if account is being used again
            this.cancelScheduledClosure(new PublicKey(address));
            await this.saveTokenAccounts();
            logger.debug(`Found cached token account: ${address}`);
            return { address: new PublicKey(address), isNew: false };
          }
        } catch (error) {
          // Account doesn't exist on-chain, remove from cache
          logger.debug(`Cached account no longer exists, removing: ${address}`);
          this.tokenAccounts.delete(address);
        }
      }
    }

    // No cached account found, check if the associated token account exists on-chain
    const associatedTokenAddress = await getAssociatedTokenAddress(mint, owner);
    
    try {
      await getAccount(this.connection, associatedTokenAddress);
      // Account exists on-chain, add to cache
      const existingInfo = this.tokenAccounts.get(associatedTokenAddress.toBase58());
      const accountInfo: TokenAccountInfo = {
        mint: mintStr,
        address: associatedTokenAddress.toBase58(),
        owner: ownerStr,
        createdAt: existingInfo?.createdAt || Date.now(),
        lastUsed: Date.now(),
        useCount: existingInfo ? (existingInfo.useCount || 0) + 1 : 1
      };
      this.tokenAccounts.set(associatedTokenAddress.toBase58(), accountInfo);
      // Cancel scheduled closure if account is being used again
      this.cancelScheduledClosure(associatedTokenAddress);
      await this.saveTokenAccounts();
      logger.debug(`Found existing token account on-chain: ${associatedTokenAddress.toBase58()}`);
      return { address: associatedTokenAddress, isNew: false };
    } catch (error) {
      // Account doesn't exist on-chain, we need to create it
      // Track this creation attempt
      this.recentCreations.set(accountKey, now);
      
      const accountInfo: TokenAccountInfo = {
        mint: mintStr,
        address: associatedTokenAddress.toBase58(),
        owner: ownerStr,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      this.tokenAccounts.set(associatedTokenAddress.toBase58(), accountInfo);
      await this.saveTokenAccounts();
      logger.info(`Token account needs to be created: ${associatedTokenAddress.toBase58()}`);
      return { address: associatedTokenAddress, isNew: true };
    }
  }

  /**
   * Schedule an account for closure after a delay
   * Returns the scheduled close time
   */
  scheduleAccountClosure(
    address: PublicKey,
    mint: PublicKey,
    keepOpenMs?: number
  ): number {
    const addressStr = address.toBase58();
    const mintStr = mint.toBase58();
    const account = this.tokenAccounts.get(addressStr);
    
    // Determine keep-open duration
    let keepOpenDuration = keepOpenMs;
    if (!keepOpenDuration) {
      // Check if this is a frequently used token
      const useCount = account?.useCount || 0;
      const frequentThreshold = Number((CONFIG as any)?.system?.frequentTokenThreshold) || this.FREQUENT_TOKEN_THRESHOLD;
      if (useCount >= frequentThreshold) {
        keepOpenDuration = Number((CONFIG as any)?.system?.frequentTokenKeepOpenMs) || this.FREQUENT_TOKEN_KEEP_OPEN_MS;
      } else {
        keepOpenDuration = Number((CONFIG as any)?.system?.accountKeepOpenMs) || this.DEFAULT_KEEP_OPEN_MS;
      }
    }
    
    const closeAt = Date.now() + keepOpenDuration;
    this.scheduledClosures.set(addressStr, { closeAt, mint: mintStr });
    
    // Update account info
    if (account) {
      account.scheduledCloseAt = closeAt;
      this.saveTokenAccounts();
    }
    
    try {
      logger.info('account.scheduled.close', {
        cat: 'wallet',
        ctx: {
          address: addressStr,
          mint: mintStr,
          closeAt: new Date(closeAt).toISOString(),
          keepOpenMs: keepOpenDuration,
          useCount: account?.useCount || 0,
        },
      });
    } catch {}
    
    return closeAt;
  }

  /**
   * Cancel scheduled closure for an account (e.g., if it's used again)
   */
  cancelScheduledClosure(address: PublicKey): void {
    const addressStr = address.toBase58();
    const wasScheduled = this.scheduledClosures.has(addressStr);
    
    if (wasScheduled) {
      this.scheduledClosures.delete(addressStr);
      const account = this.tokenAccounts.get(addressStr);
      if (account) {
        delete account.scheduledCloseAt;
        this.saveTokenAccounts();
      }
      
      try {
        logger.info('account.closure.cancelled', {
          cat: 'wallet',
          ctx: { address: addressStr },
        });
      } catch {}
    }
  }

  /**
   * Start background scheduler to close accounts
   */
  private startCleanupScheduler(): void {
    if (this.cleanupInterval) return;
    
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(async () => {
      await this.processScheduledClosures();
    }, 5 * 60 * 1000);
    
    // Also run on startup
    this.processScheduledClosures().catch(() => {});
  }

  /**
   * Process scheduled account closures
   */
  private async processScheduledClosures(): Promise<void> {
    const now = Date.now();
    const toClose: Array<{ address: string; mint: string }> = [];
    
    // Find accounts that should be closed
    for (const [address, schedule] of this.scheduledClosures.entries()) {
      if (now >= schedule.closeAt) {
        toClose.push({ address, mint: schedule.mint });
      }
    }
    
    if (toClose.length === 0) return;
    
    try {
      logger.info('account.cleanup.start', {
        cat: 'wallet',
        ctx: { count: toClose.length },
      });
      
      const { ensureWallet } = await import('./wallet.js');
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      for (const { address } of toClose) {
        try {
          const success = await this.closeTokenAccount(
            new PublicKey(address),
            wallet.publicKey
          );
          
          if (success) {
            this.scheduledClosures.delete(address);
          }
        } catch (error) {
          try {
            logger.warn('account.cleanup.error', {
              cat: 'wallet',
              ctx: {
                address,
                error: String((error as any)?.message || error),
              },
            });
          } catch {}
        }
      }
      
      try {
        logger.info('account.cleanup.complete', {
          cat: 'wallet',
          ctx: {
            closed: toClose.length,
            remaining: this.scheduledClosures.size,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.error('account.cleanup.failed', {
          cat: 'wallet',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
    }
  }

  async markTokenAccountUsed(address: PublicKey) {
    const addressStr = address.toBase58();
    const account = this.tokenAccounts.get(addressStr);
    if (account) {
      account.lastUsed = Date.now();
      account.useCount = (account.useCount || 0) + 1;
      
      // Cancel scheduled closure if account is being used again
      this.cancelScheduledClosure(address);
      
      await this.saveTokenAccounts();
    }
  }

  getTokenAccounts(): TokenAccountInfo[] {
    return Array.from(this.tokenAccounts.values());
  }

  getTokenAccountsForMint(mint: string): TokenAccountInfo[] {
    return Array.from(this.tokenAccounts.values()).filter(account => account.mint === mint);
  }

  async removeTokenAccount(address: PublicKey) {
    const addressStr = address.toBase58();
    if (this.tokenAccounts.has(addressStr)) {
      this.tokenAccounts.delete(addressStr);
      await this.saveTokenAccounts();
      logger.info(`Removed token account from cache: ${addressStr}`);
    }
  }

  async closeTokenAccount(address: PublicKey, payer: PublicKey): Promise<boolean> {
    try {
      const { getAccount, createCloseAccountInstruction } = await import('@solana/spl-token');
      const { Connection, Transaction } = await import('@solana/web3.js');
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      const { ensureWallet } = await import('./wallet.js');
      
      // Check if account has zero balance before closing
      const account = await getAccount(this.connection, address);
      if (account.amount > 0n) {
        logger.warn(`Cannot close token account with non-zero balance: ${address.toBase58()}`);
        // Reschedule closure
        this.scheduleAccountClosure(address, account.mint);
        return false;
      }

      // Create close instruction
      const closeIx = createCloseAccountInstruction(address, payer, payer);
      
      // Build and send transaction
      const { blockhash } = await withRpcLimit(
        () => this.connection.getLatestBlockhash('finalized'),
        1,
        { module: 'wallet', method: 'getLatestBlockhash' }
      );
      const tx = new Transaction().add(closeIx);
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer;
      
      const wallet = await ensureWallet(CONFIG.walletPath);
      const { Keypair } = await import('@solana/web3.js');
      const kp = Keypair.fromSecretKey(wallet.secretKey);
      tx.sign(kp);
      
      const sig = await withRpcLimit(
        () => this.connection.sendRawTransaction(tx.serialize()),
        1,
        { module: 'wallet', method: 'sendRawTransaction' }
      );
      await withRpcLimit(
        () => this.connection.confirmTransaction(sig, 'confirmed'),
        1,
        { module: 'wallet', method: 'confirmTransaction' }
      );

      // Remove from cache and scheduled closures
      await this.removeTokenAccount(address);
      this.scheduledClosures.delete(address.toBase58());
      
      logger.info(`Token account closed: ${address.toBase58()}, signature: ${sig}`);
      return true;
    } catch (error) {
      logger.error(`Failed to close token account: ${address.toBase58()}`, { 
        error: String((error as any)?.message || error) 
      });
      return false;
    }
  }

  async cleanupUnusedAccounts(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000) { // 7 days default
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [address, info] of this.tokenAccounts.entries()) {
      if (now - info.lastUsed > maxAgeMs) {
        toRemove.push(address);
      }
    }
    
    for (const address of toRemove) {
      this.tokenAccounts.delete(address);
    }
    
    if (toRemove.length > 0) {
      await this.saveTokenAccounts();
      logger.info(`Cleaned up ${toRemove.length} unused token accounts`);
    }
  }

  private cleanupRecentCreations() {
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [key, timestamp] of this.recentCreations.entries()) {
      if (now - timestamp > 300000) { // Remove entries older than 5 minutes
        toRemove.push(key);
      }
    }
    
    for (const key of toRemove) {
      this.recentCreations.delete(key);
    }
  }
}

// Global instance
let tokenAccountManager: TokenAccountManager | null = null;

export function getTokenAccountManager(connection: Connection): TokenAccountManager {
  if (!tokenAccountManager) {
    tokenAccountManager = new TokenAccountManager(connection);
  }
  return tokenAccountManager;
}
