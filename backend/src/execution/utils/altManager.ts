import { Connection, PublicKey, AddressLookupTableAccount, TransactionMessage, VersionedTransaction, AddressLookupTableProgram, Transaction, Keypair } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';
import { accountCache } from './accountCache.js';

/**
 * Manages Address Lookup Tables (ALTs) for DEX transactions
 * Pre-creates and caches ALTs with frequently used accounts
 */
export class DexAltManager {
  private altAddresses: Map<string, PublicKey> = new Map();
  private altAccounts: Map<string, AddressLookupTableAccount> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize ALTs with frequently used accounts
   */
  async initialize(createIfMissing: boolean = false): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Collect frequently used accounts
        const commonAccounts = await this.collectCommonAccounts();
        
        // Load ALTs from config
        const configAlts = (CONFIG as any)?.execution?.lookupTableAddresses || [];
        for (const addr of configAlts) {
          try {
            const pk = new PublicKey(addr);
            this.altAddresses.set('config', pk);
          } catch {}
        }

        // Optionally create ALT if missing and we have accounts
        if (createIfMissing && commonAccounts.length > 0 && this.altAddresses.size === 0) {
          try {
            const { ensureWallet } = await import('../../wallet/wallet.js');
            const wallet = await ensureWallet(CONFIG.walletPath);
            await this.createAltOnChain(wallet, commonAccounts);
          } catch (error) {
            try {
              logger.warn('alt.manager.auto.create.failed', {
                cat: 'tx',
                ctx: { error: String((error as any)?.message || error) },
              });
            } catch {}
          }
        }

        this.initialized = true;
        try {
          logger.info('alt.manager.initialized', {
            cat: 'tx',
            ctx: {
              altCount: this.altAddresses.size,
              commonAccountCount: commonAccounts.length,
            },
          });
        } catch {}
      } catch (error) {
        try {
          logger.warn('alt.manager.init.error', {
            cat: 'tx',
            ctx: { error: String((error as any)?.message || error) },
          });
        } catch {}
        this.initialized = true; // Mark as initialized even on error
      }
    })();

    return this.initPromise;
  }

  /**
   * Create a new ALT on-chain with frequently used accounts
   * Note: This requires a funded wallet and should be done once during setup
   */
  async createAltOnChain(
    payer: { publicKey: PublicKey; secretKey: Uint8Array },
    accounts: PublicKey[]
  ): Promise<PublicKey> {
    const connection = getConnection();
    
    try {
      // Derive ALT address deterministically
      const [lookupTableAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('dex-common-alt'),
          payer.publicKey.toBuffer(),
        ],
        AddressLookupTableProgram.programId
      );
    
    // Check if ALT already exists
    const existing = await connection.getAddressLookupTable(lookupTableAddress).catch(() => ({ value: null }));
    if (existing.value) {
      try {
        logger.info('alt.manager.exists', {
          cat: 'tx',
          ctx: { address: lookupTableAddress.toBase58() },
        });
      } catch {}
      this.altAddresses.set('dex-common', lookupTableAddress);
      return lookupTableAddress;
    }
    
    // Get recent slot for ALT creation
    const recentSlotRaw = await withRpcLimit(() => connection.getSlot('finalized'));
    const recentSlot = typeof recentSlotRaw === 'number' ? recentSlotRaw : Number(recentSlotRaw);
    
    // Create ALT instruction (returns [instruction, lookupTableAddress])
    const [createIx] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
    
    // Limit to 256 addresses per ALT (Solana limit)
    const addressesToAdd = accounts.slice(0, 256);
    
    // Extend ALT with accounts
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addressesToAdd,
    });
    
    // Send transaction
    const tx = new Transaction();
    tx.add(createIx);
    tx.add(extendIx);
    const latestBlockhash = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = payer.publicKey;
    
    const kp = Keypair.fromSecretKey(payer.secretKey);
    tx.sign(kp);
    
    const sig = await withRpcLimit(() => connection.sendRawTransaction(tx.serialize()));
    await withRpcLimit(() => connection.confirmTransaction(sig, 'confirmed'));
    
    // Cache the new ALT
    this.altAddresses.set('dex-common', lookupTableAddress);
    
    try {
      logger.info('alt.manager.created', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          accountCount: addressesToAdd.length,
          signature: sig,
        },
      });
    } catch {}
    
    return lookupTableAddress;
  } catch (error) {
    try {
      logger.error('alt.manager.create.error', {
        cat: 'tx',
        ctx: { error: String((error as any)?.message || error) },
      });
    } catch {}
    throw error;
  }
  }

  /**
   * Collect common accounts that should be in ALTs
   */
  private async collectCommonAccounts(): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];

    try {
      // DEX program IDs
      if ((CONFIG as any)?.raydium?.ammV4Program) {
        accounts.push(new PublicKey((CONFIG as any).raydium.ammV4Program));
      }
      if ((CONFIG as any)?.raydium?.ammV5Program) {
        accounts.push(new PublicKey((CONFIG as any).raydium.ammV5Program));
      }
      if ((CONFIG as any)?.raydium?.clmmProgram) {
        accounts.push(new PublicKey((CONFIG as any).raydium.clmmProgram));
      }
      if ((CONFIG as any)?.orca?.programId) {
        accounts.push(new PublicKey((CONFIG as any).orca.programId));
      }
      if ((CONFIG as any)?.meteora?.programId) {
        accounts.push(new PublicKey((CONFIG as any).meteora.programId));
      }

      // Common token mints (SOL, USDC, USDT, etc.)
      const commonMints = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      ];

      for (const mint of commonMints) {
        try {
          accounts.push(new PublicKey(mint));
        } catch {}
      }
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Get ALT addresses for a transaction
   * Returns addresses that should be used based on the accounts in the transaction
   */
  async getAltAddresses(
    accounts: (PublicKey | string)[],
    forceMultiHop: boolean = false
  ): Promise<string[]> {
    await this.initialize();

    const addresses: string[] = [];

    // Always use ALTs for multi-hop swaps
    if (forceMultiHop || accounts.length > 32) {
      for (const addr of this.altAddresses.values()) {
        addresses.push(addr.toBase58());
      }
    }

    // Check if we have many accounts that would benefit from ALTs
    if (accounts.length > 20) {
      for (const addr of this.altAddresses.values()) {
        addresses.push(addr.toBase58());
      }
    }

    return Array.from(new Set(addresses)); // Deduplicate
  }

  /**
   * Load ALT accounts from addresses
   */
  async loadAltAccounts(addresses: string[]): Promise<AddressLookupTableAccount[]> {
    const connection = getConnection();
    const accounts: AddressLookupTableAccount[] = [];

    for (const addr of addresses) {
      try {
        // Check cache first
        const cached = this.altAccounts.get(addr);
        if (cached) {
          accounts.push(cached);
          continue;
        }

        // Load from chain
        const pk = new PublicKey(addr);
        const result = await withRpcLimit(() => 
          connection.getAddressLookupTable(pk)
        );

        if (result && 'value' in result && result.value) {
          this.altAccounts.set(addr, result.value);
          accounts.push(result.value);
        }
      } catch (error) {
        try {
          logger.warn('alt.manager.load.error', {
            cat: 'tx',
            ctx: {
              address: addr,
              error: String((error as any)?.message || error),
            },
          });
        } catch {}
      }
    }

    return accounts;
  }

  /**
   * Add ALT address (for external ALTs)
   */
  addAltAddress(key: string, address: PublicKey | string): void {
    const pk = typeof address === 'string' ? new PublicKey(address) : address;
    this.altAddresses.set(key, pk);
  }

  /**
   * Get all registered ALT addresses
   */
  getAllAltAddresses(): string[] {
    return Array.from(this.altAddresses.values()).map(pk => pk.toBase58());
  }

  /**
   * Clear cached ALT accounts (force refresh)
   */
  clearCache(): void {
    this.altAccounts.clear();
  }
}

// Singleton instance
export const dexAltManager = new DexAltManager();

// Initialize on import
dexAltManager.initialize().catch(() => {});

