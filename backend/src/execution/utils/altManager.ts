import { Connection, PublicKey, AddressLookupTableAccount, TransactionMessage, VersionedTransaction, AddressLookupTableProgram, Transaction, Keypair } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';
import { accountCache } from './accountCache.js';
import { loadAltConfig, saveAltConfig, type AltConfig } from './altConfig.js';

/**
 * Manages Address Lookup Tables (ALTs) for DEX transactions
 * Pre-creates and caches ALTs with frequently used accounts
 */
export class DexAltManager {
  private altAddresses: Map<string, PublicKey> = new Map();
  private altAccounts: Map<string, AddressLookupTableAccount> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private altConfig: AltConfig | null = null;
  private startupStatus: {
    initialized: boolean;
    alts: { [category: string]: string };
    errors: string[];
  } | null = null;

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
        
        // Load ALTs from config (fix: use unique keys for multiple ALTs)
        const configAlts = (CONFIG as any)?.execution?.lookupTableAddresses || [];
        for (let i = 0; i < configAlts.length; i++) {
          try {
            const pk = new PublicKey(configAlts[i]);
            this.altAddresses.set(`exec-config-${i}`, pk);
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
    accounts: PublicKey[],
    seed: string = 'dex-common-alt'
  ): Promise<PublicKey> {
    const connection = getConnection();
    
    try {
      // Derive ALT address deterministically with custom seed
      const [lookupTableAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(seed),
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
      // Store with seed-based key
      this.altAddresses.set(seed, lookupTableAddress);
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
    
    // STEP 1: Create the lookup table (first transaction)
    // The lookup table account must exist before we can extend it
    const createTx = new Transaction();
    createTx.add(createIx);
    const createBlockhash = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    createTx.recentBlockhash = createBlockhash.blockhash;
    createTx.feePayer = payer.publicKey;
    
    const kp = Keypair.fromSecretKey(payer.secretKey);
    createTx.sign(kp);
    
    const createSig = await withRpcLimit(() => connection.sendRawTransaction(createTx.serialize()));
    await withRpcLimit(() => connection.confirmTransaction(createSig, 'confirmed'));
    
    try {
      logger.info('alt.manager.create.step1', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          signature: createSig,
        },
      });
    } catch {}
    
    // Wait a bit to ensure the account is fully initialized
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify the lookup table was created
    const verifyResult = await connection.getAddressLookupTable(lookupTableAddress).catch(() => ({ value: null }));
    if (!verifyResult.value) {
      throw new Error('Lookup table creation failed - account not found after creation');
    }
    
    // Limit to 256 addresses per ALT (Solana limit)
    const addressesToAdd = accounts.slice(0, 256);
    
    if (addressesToAdd.length === 0) {
      // No accounts to add, just cache the empty ALT
      this.altAddresses.set(seed, lookupTableAddress);
      try {
        logger.info('alt.manager.created.empty', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            signature: createSig,
          },
        });
      } catch {}
      return lookupTableAddress;
    }
    
    // STEP 2: Extend ALT with accounts (second transaction)
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: addressesToAdd,
    });
    
    const extendTx = new Transaction();
    extendTx.add(extendIx);
    const extendBlockhash = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    extendTx.recentBlockhash = extendBlockhash.blockhash;
    extendTx.feePayer = payer.publicKey;
    
    extendTx.sign(kp);
    
    const extendSig = await withRpcLimit(() => connection.sendRawTransaction(extendTx.serialize()));
    await withRpcLimit(() => connection.confirmTransaction(extendSig, 'confirmed'));
    
    // Cache the new ALT with seed-based key
    this.altAddresses.set(seed, lookupTableAddress);
    
    try {
      logger.info('alt.manager.created', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          accountCount: addressesToAdd.length,
          createSignature: createSig,
          extendSignature: extendSig,
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
   * Collect frequently used pool addresses
   */
  private async collectPoolAccounts(): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Load pools from watchlist/config if available
      // For now, return empty - can be enhanced to load from watchlist
      // Example: get top N most frequently traded pools
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.pools.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
    }
    
    return accounts;
  }

  /**
   * Collect CLMM-specific accounts (tick arrays, etc.)
   */
  private async collectClmmAccounts(): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Add frequently used tick array addresses
      // This would require tracking which tick arrays you use most
      // Could be populated from transaction history analysis
      // For now, return empty - can be enhanced later
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.clmm.error', {
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

    // Always use ALTs for multi-hop or if we have many accounts
    // Lower threshold: CLMM swaps typically have 15+ accounts per instruction
    if (forceMultiHop || accounts.length > 15) {
      for (const addr of this.altAddresses.values()) {
        addresses.push(addr.toBase58());
      }
      try {
        logger.info('alt.manager.using_alts', {
          cat: 'tx',
          ctx: {
            accountCount: accounts.length,
            forceMultiHop,
            altCount: addresses.length,
            altAddresses: addresses,
          },
        });
      } catch {}
    }

    // Also check if we have any registered ALTs from config
    // Even if account count is low, use them if configured
    if (this.altAddresses.size > 0 && addresses.length === 0) {
      // If ALTs are explicitly configured, use them
      const configAlts = (CONFIG as any)?.execution?.lookupTableAddresses || [];
      if (configAlts.length > 0) {
        for (const addr of this.altAddresses.values()) {
          addresses.push(addr.toBase58());
        }
        try {
          logger.info('alt.manager.using_config_alts', {
            cat: 'tx',
            ctx: {
              accountCount: accounts.length,
              altCount: addresses.length,
              altAddresses: addresses,
            },
          });
        } catch {}
      }
    }

    if (addresses.length === 0) {
      try {
        logger.debug('alt.manager.no_alts', {
          cat: 'tx',
          ctx: {
            accountCount: accounts.length,
            forceMultiHop,
            registeredAltCount: this.altAddresses.size,
          },
        });
      } catch {}
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

  /**
   * Comprehensive startup initialization
   * Checks existing ALTs, validates them, creates if missing
   */
  async initializeStartup(options?: {
    createIfMissing?: boolean;
    validateExisting?: boolean;
    autoCreateCategories?: string[]; // ['common', 'pools', 'clmm']
  }): Promise<{
    initialized: boolean;
    alts: { [category: string]: string };
    errors: string[];
  }> {
    const opts = {
      createIfMissing: false,
      validateExisting: true,
      autoCreateCategories: [] as string[],
      ...options,
    };

    const errors: string[] = [];
    const results: { [category: string]: string } = {};

    try {
      // 1. Load ALT config from disk
      this.altConfig = await loadAltConfig();

      // 2. Load ALTs from exec-config (backward compatibility)
      try {
        const execCfg = await import('../../server/execConfigStore.js');
        const execConfig = await execCfg.loadExecConfig();
        if (execConfig.lookupTableAddresses?.length) {
          for (let i = 0; i < execConfig.lookupTableAddresses.length; i++) {
            try {
              const pk = new PublicKey(execConfig.lookupTableAddresses[i]);
              this.altAddresses.set(`exec-config-${i}`, pk);
            } catch (e) {
              errors.push(`Invalid exec-config ALT ${i}: ${String(e)}`);
            }
          }
        }
      } catch (e) {
        errors.push(`Failed to load exec-config: ${String(e)}`);
      }

      // 3. Check and validate existing ALTs from config
      if (opts.validateExisting && this.altConfig.alts) {
        for (const [category, address] of Object.entries(this.altConfig.alts)) {
          if (!address) continue;
          
          try {
            const exists = await this.validateAltExists(address);
            if (exists.valid) {
              this.altAddresses.set(category, new PublicKey(address));
              results[category] = address;
              try {
                logger.info('alt.startup.validated', {
                  cat: 'tx',
                  ctx: { category, address, accountCount: exists.accountCount },
                });
              } catch {}
            } else {
              errors.push(`ALT ${category} (${address}) is invalid: ${exists.reason}`);
              // Remove invalid ALT from config
              if (this.altConfig.alts) {
                delete this.altConfig.alts[category as keyof typeof this.altConfig.alts];
              }
            }
          } catch (e) {
            errors.push(`Failed to validate ALT ${category}: ${String(e)}`);
          }
        }
      }

      // 4. Create missing ALTs if requested
      if (opts.createIfMissing) {
        try {
          const { ensureWallet } = await import('../../wallet/wallet.js');
          const wallet = await ensureWallet(CONFIG.walletPath);
          
          if (!this.altConfig.walletPublicKey) {
            this.altConfig.walletPublicKey = wallet.publicKey.toBase58();
          }

          // Create common ALT if missing
          if (opts.autoCreateCategories.includes('common') && !results.common) {
            try {
              const commonAccounts = await this.collectCommonAccounts();
              if (commonAccounts.length > 0) {
                const address = await this.createAltOnChain(
                  wallet,
                  commonAccounts,
                  'common-alt'
                );
                results.common = address.toBase58();
                if (this.altConfig.alts) {
                  this.altConfig.alts.common = address.toBase58();
                }
                try {
                  logger.info('alt.startup.created', {
                    cat: 'tx',
                    ctx: { category: 'common', address: address.toBase58(), accountCount: commonAccounts.length },
                  });
                } catch {}
              }
            } catch (e) {
              errors.push(`Failed to create common ALT: ${String(e)}`);
            }
          }

          // Create pools ALT if missing
          if (opts.autoCreateCategories.includes('pools') && !results.pools) {
            try {
              const poolAccounts = await this.collectPoolAccounts();
              if (poolAccounts.length > 0) {
                const address = await this.createAltOnChain(
                  wallet,
                  poolAccounts,
                  'pool-alt'
                );
                results.pools = address.toBase58();
                if (this.altConfig.alts) {
                  this.altConfig.alts.pools = address.toBase58();
                }
                try {
                  logger.info('alt.startup.created', {
                    cat: 'tx',
                    ctx: { category: 'pools', address: address.toBase58(), accountCount: poolAccounts.length },
                  });
                } catch {}
              }
            } catch (e) {
              errors.push(`Failed to create pools ALT: ${String(e)}`);
            }
          }

          // Create CLMM ALT if missing
          if (opts.autoCreateCategories.includes('clmm') && !results.clmm) {
            try {
              const clmmAccounts = await this.collectClmmAccounts();
              if (clmmAccounts.length > 0) {
                const address = await this.createAltOnChain(
                  wallet,
                  clmmAccounts,
                  'clmm-alt'
                );
                results.clmm = address.toBase58();
                if (this.altConfig.alts) {
                  this.altConfig.alts.clmm = address.toBase58();
                }
                try {
                  logger.info('alt.startup.created', {
                    cat: 'tx',
                    ctx: { category: 'clmm', address: address.toBase58(), accountCount: clmmAccounts.length },
                  });
                } catch {}
              }
            } catch (e) {
              errors.push(`Failed to create CLMM ALT: ${String(e)}`);
            }
          }

          // Save updated config
          if (this.altConfig) {
            this.altConfig.lastValidated = Date.now();
            if (!this.altConfig.createdAt) {
              this.altConfig.createdAt = Date.now();
            }
            await saveAltConfig(this.altConfig);
          }
        } catch (e) {
          errors.push(`Failed to create ALTs: ${String(e)}`);
        }
      }

      this.initialized = true;
      this.startupStatus = {
        initialized: this.initialized,
        alts: results,
        errors,
      };
      
      try {
        logger.info('alt.startup.complete', {
          cat: 'tx',
          ctx: {
            altCount: this.altAddresses.size,
            categories: Object.keys(results),
            errorCount: errors.length,
          },
        });
      } catch {}

    } catch (error) {
      errors.push(`Startup initialization failed: ${String(error)}`);
      try {
        logger.error('alt.startup.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
      this.initialized = true; // Mark as initialized even on error
      this.startupStatus = {
        initialized: this.initialized,
        alts: results,
        errors,
      };
    }

    return {
      initialized: this.initialized,
      alts: results,
      errors,
    };
  }

  /**
   * Validate that an ALT exists and is accessible
   */
  async validateAltExists(address: string): Promise<{
    valid: boolean;
    reason?: string;
    accountCount?: number;
  }> {
    try {
      const connection = getConnection();
      const pk = new PublicKey(address);
      const result = await withRpcLimit(() =>
        connection.getAddressLookupTable(pk)
      );

      if (!result || !result.value) {
        return { valid: false, reason: 'ALT not found on-chain' };
      }

      const accountCount = result.value.state?.addresses?.length || 0;
      if (accountCount === 0) {
        return { valid: false, reason: 'ALT is empty (no accounts)' };
      }

      // Cache the ALT account
      this.altAccounts.set(address, result.value);

      return { valid: true, accountCount };
    } catch (error) {
      return {
        valid: false,
        reason: `Validation error: ${String((error as any)?.message || error)}`,
      };
    }
  }

  /**
   * Check if ALTs need to be created/updated
   */
  async checkAltStatus(): Promise<{
    needsSetup: boolean;
    existing: { [category: string]: string };
    missing: string[];
  }> {
    const config = await loadAltConfig();
    
    const existing: { [category: string]: string } = {};
    const missing: string[] = [];

    if (config.alts) {
      for (const [category, address] of Object.entries(config.alts)) {
        if (address) {
          const validated = await this.validateAltExists(address);
          if (validated.valid) {
            existing[category] = address;
          } else {
            missing.push(category);
          }
        } else {
          missing.push(category);
        }
      }
    }

    return {
      needsSetup: missing.length > 0,
      existing,
      missing,
    };
  }

  /**
   * Get current ALT status for API
   */
  getStatus(): {
    initialized: boolean;
    altCount: number;
    categories: string[];
    addresses: { [category: string]: string };
    startupStatus?: {
      initialized: boolean;
      alts: { [category: string]: string };
      errors: string[];
    };
  } {
    const addresses: { [category: string]: string } = {};
    for (const [key, pk] of this.altAddresses.entries()) {
      // Skip exec-config prefixed keys for cleaner output
      if (!key.startsWith('exec-config-')) {
        addresses[key] = pk.toBase58();
      }
    }

    return {
      initialized: this.initialized,
      altCount: this.altAddresses.size,
      categories: Object.keys(addresses),
      addresses,
      startupStatus: this.startupStatus || undefined,
    };
  }
}

// Singleton instance
export const dexAltManager = new DexAltManager();

// Initialize on import
dexAltManager.initialize().catch(() => {});

