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
}

export class TokenAccountManager {
  private tokenAccounts: Map<string, TokenAccountInfo> = new Map();
  private configPath: string;
  private connection: Connection;
  private recentCreations: Map<string, number> = new Map(); // Track recent account creations

  constructor(connection: Connection) {
    this.connection = connection;
    this.configPath = path.join(process.cwd(), 'backend/config/tokenAccounts.json');
    this.loadTokenAccounts();
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
            // Update last used timestamp
            info.lastUsed = Date.now();
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
      const accountInfo: TokenAccountInfo = {
        mint: mintStr,
        address: associatedTokenAddress.toBase58(),
        owner: ownerStr,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      this.tokenAccounts.set(associatedTokenAddress.toBase58(), accountInfo);
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

  async markTokenAccountUsed(address: PublicKey) {
    const addressStr = address.toBase58();
    const account = this.tokenAccounts.get(addressStr);
    if (account) {
      account.lastUsed = Date.now();
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
      // Check if account has zero balance before closing
      const account = await getAccount(this.connection, address);
      if (account.amount > 0) {
        logger.warn(`Cannot close token account with non-zero balance: ${address.toBase58()}`);
        return false;
      }

      // Remove from cache
      await this.removeTokenAccount(address);
      
      logger.info(`Token account closed: ${address.toBase58()}`);
      return true;
    } catch (error) {
      logger.error(`Failed to close token account: ${address.toBase58()}`, { error: String(error) });
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
