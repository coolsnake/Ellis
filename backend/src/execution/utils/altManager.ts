import { Connection, PublicKey, AddressLookupTableAccount, TransactionMessage, VersionedTransaction, AddressLookupTableProgram, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';
import { accountCache } from './accountCache.js';
import { loadAltConfig, saveAltConfig, type AltConfig, type DexAltSet } from './altConfig.js';
import { ARB_ROUTER_PROGRAM_ID } from '../../router/types.js';

// Batch size for ALT loading - conservative to avoid rate limits
const ALT_BATCH_SIZE = 5;
// Delay between batches in milliseconds
const ALT_BATCH_DELAY_MS = 500;
// Priority fee for ALT transactions (micro-lamports per compute unit)
// ALT operations are low CU (~10-20k), so a modest priority is sufficient
const ALT_PRIORITY_FEE_MICRO_LAMPORTS = 5000; // 5,000 micro-lamports per CU
const ALT_COMPUTE_UNIT_LIMIT = 50000; // Conservative limit for ALT operations

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
   * Batch load multiple ALTs using getMultipleAccountsInfo to minimize RPC calls.
   * This is much more efficient than loading each ALT individually.
   * 
   * @param addresses Array of ALT addresses to load
   * @returns Map of address -> AddressLookupTableAccount for valid ALTs
   */
  private async batchLoadAlts(
    addresses: string[]
  ): Promise<Map<string, AddressLookupTableAccount>> {
    const result = new Map<string, AddressLookupTableAccount>();
    if (addresses.length === 0) return result;

    const connection = getConnection();
    const uniqueAddresses = [...new Set(addresses)]; // Dedupe
    
    // Process in batches to respect rate limits
    for (let i = 0; i < uniqueAddresses.length; i += ALT_BATCH_SIZE) {
      const batch = uniqueAddresses.slice(i, i + ALT_BATCH_SIZE);
      const pubkeys = batch.map(addr => {
        try {
          return new PublicKey(addr);
        } catch {
          return null;
        }
      }).filter((pk): pk is PublicKey => pk !== null);

      if (pubkeys.length === 0) continue;

      try {
        // Use higher weight for batch calls - getMultipleAccountsInfo is heavier than individual calls
        const accountInfos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(pubkeys),
          5,
          { module: 'alt', method: 'batchLoadAlts' }
        );

        // Process results
        for (let j = 0; j < pubkeys.length; j++) {
          const pubkey = pubkeys[j];
          const accountInfo = accountInfos[j];
          const address = batch[j];

          if (accountInfo && accountInfo.data) {
            try {
              // Deserialize the ALT account data
              const altAccount = new AddressLookupTableAccount({
                key: pubkey,
                state: AddressLookupTableAccount.deserialize(accountInfo.data),
              });
              result.set(address, altAccount);
            } catch (deserializeError) {
              // Failed to deserialize - might not be a valid ALT
              try {
                logger.debug('alt.manager.batchLoad.deserialize.failed', {
                  cat: 'tx',
                  ctx: { address, error: String((deserializeError as any)?.message || deserializeError) },
                });
              } catch {}
            }
          }
        }

        try {
          logger.debug('alt.manager.batchLoad.batch.complete', {
            cat: 'tx',
            ctx: {
              batchIndex: Math.floor(i / ALT_BATCH_SIZE),
              batchSize: batch.length,
              loaded: accountInfos.filter(a => a !== null).length,
              totalProgress: `${Math.min(i + ALT_BATCH_SIZE, uniqueAddresses.length)}/${uniqueAddresses.length}`,
            },
          });
        } catch {}
      } catch (error) {
        // Log but continue - some ALTs might be missing
        try {
          logger.warn('alt.manager.batchLoad.batch.error', {
            cat: 'tx',
            ctx: {
              batchIndex: Math.floor(i / ALT_BATCH_SIZE),
              error: String((error as any)?.message || error),
            },
          });
        } catch {}
      }

      // Add delay between batches to respect rate limits
      if (i + ALT_BATCH_SIZE < uniqueAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, ALT_BATCH_DELAY_MS));
      }
    }

    try {
      logger.info('alt.manager.batchLoad.complete', {
        cat: 'tx',
        ctx: {
          requested: uniqueAddresses.length,
          loaded: result.size,
          batches: Math.ceil(uniqueAddresses.length / ALT_BATCH_SIZE),
        },
      });
    } catch {}

    return result;
  }

  /**
   * Initialize ALTs with frequently used accounts
   * Uses batch loading to minimize RPC calls and avoid rate limiting (429s)
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

        // Load ALTs from altConfig file using BATCH LOADING to avoid 429s
        try {
          this.altConfig = await loadAltConfig();
          const invalidCategories: string[] = [];
          
          // STEP 1: Collect all ALT addresses to load
          const addressToCategory = new Map<string, string>(); // address -> category
          const dexAddressInfo: Array<{ address: string; dex: string; index: number }> = [];
          
          // Collect from config.alts
          if (this.altConfig.alts) {
            for (const [category, address] of Object.entries(this.altConfig.alts)) {
              if (address) {
                addressToCategory.set(address, category);
              }
            }
          }
          
          // Collect from dexAlts
          if (this.altConfig.dexAlts) {
            for (const [dex, dexAltSet] of Object.entries(this.altConfig.dexAlts)) {
              if (!dexAltSet?.addresses) continue;
              for (let i = 0; i < dexAltSet.addresses.length; i++) {
                const address = dexAltSet.addresses[i];
                if (address && !addressToCategory.has(address)) {
                  dexAddressInfo.push({ address, dex, index: i });
                }
              }
            }
          }
          
          const allAddresses = [
            ...Array.from(addressToCategory.keys()),
            ...dexAddressInfo.map(d => d.address),
          ];
          
          try {
            logger.info('alt.manager.init.batch.start', {
              cat: 'tx',
              ctx: {
                totalAlts: allAddresses.length,
                fromConfig: addressToCategory.size,
                fromDexAlts: dexAddressInfo.length,
              },
            });
          } catch {}
          
          // STEP 2: Batch load all ALTs
          const loadedAlts = await this.batchLoadAlts(allAddresses);
          
          // STEP 3: Process results for config.alts
          for (const [address, category] of addressToCategory) {
            const altAccount = loadedAlts.get(address);
            if (altAccount) {
              try {
                this.altAddresses.set(category, new PublicKey(address));
                this.altAccounts.set(address, altAccount);
              } catch {}
            } else {
              // ALT not found - mark for removal
              invalidCategories.push(category);
              try {
                logger.warn('alt.manager.init.alt.not.found', {
                  cat: 'tx',
                  ctx: {
                    category,
                    address,
                    reason: 'ALT does not exist on-chain (possibly deleted)',
                  },
                });
              } catch {}
            }
          }
          
          // Clean up invalid ALTs from config file
          if (invalidCategories.length > 0) {
            try {
              for (const category of invalidCategories) {
                delete this.altConfig.alts[category as keyof typeof this.altConfig.alts];
              }
              await saveAltConfig(this.altConfig);
              try {
                logger.info('alt.manager.init.cleanup', {
                  cat: 'tx',
                  ctx: {
                    removedCategories: invalidCategories,
                    message: 'Removed deleted/invalid ALTs from config',
                  },
                });
              } catch {}
            } catch (saveError) {
              try {
                logger.warn('alt.manager.init.cleanup.failed', {
                  cat: 'tx',
                  ctx: {
                    error: String((saveError as any)?.message || saveError),
                  },
                });
              } catch {}
            }
          }
          
          // STEP 4: Process results for dexAlts
          let dexAltCount = 0;
          for (const { address, dex, index } of dexAddressInfo) {
            // Skip if already loaded from config.alts
            if (this.altAccounts.has(address)) {
              dexAltCount++;
              continue;
            }
            
            const altAccount = loadedAlts.get(address);
            if (altAccount) {
              const category = `${dex}-pools-${index}`;
              this.altAddresses.set(category, altAccount.key);
              this.altAccounts.set(address, altAccount);
              dexAltCount++;
            }
          }
          
          if (dexAltCount > 0) {
            try {
              logger.info('alt.manager.init.dexAlts.loaded', {
                cat: 'tx',
                ctx: { dexAltCount, dexes: Object.keys(this.altConfig.dexAlts || {}) },
              });
            } catch {}
          }
        } catch (error) {
          // If altConfig loading fails, continue without it
          try {
            logger.warn('alt.manager.init.config.load.failed', {
              cat: 'tx',
              ctx: { error: String((error as any)?.message || error) },
            });
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
   * Find existing empty or reusable lookup tables owned by this wallet
   */
  private async findReusableLookupTable(
    payer: { publicKey: PublicKey },
    accounts: PublicKey[]
  ): Promise<{ address: PublicKey; accountCount: number; seed: string } | null> {
    const connection = getConnection();
    
    // Check common seed variations that might have been created but not extended
    const seedsToCheck = ['common-alt', 'dex-common-alt', 'pool-alt', 'clmm-alt', 'tokens-alt'];
    
    for (const seed of seedsToCheck) {
      try {
        const [lookupTableAddress] = PublicKey.findProgramAddressSync(
          [
            Buffer.from(seed),
            payer.publicKey.toBuffer(),
          ],
          AddressLookupTableProgram.programId
        );
        
        // Retry a few times as the ALT might not be immediately queryable
        let result: { value: AddressLookupTableAccount | null } | null = null;
        for (let retry = 0; retry < 3; retry++) {
          try {
            result = await withRpcLimit(
              () => connection.getAddressLookupTable(lookupTableAddress),
              1,
              { module: 'alt', method: 'getAddressLookupTable' }
            );
            if (result && result.value) break;
          } catch {}
          if (retry < 2) {
            await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
          }
        }
        
        if (result && result.value) {
          const accountCount = result.value.state?.addresses?.length || 0;
          const remainingCapacity = 256 - accountCount;
          
          // If empty or has enough capacity, we can reuse it
          // Prefer empty ALTs first
          if (accountCount === 0) {
            try {
              logger.info('alt.manager.found.reusable.empty', {
                cat: 'tx',
                ctx: {
                  address: lookupTableAddress.toBase58(),
                  seed,
                  accountCount: 0,
                  accountsToAdd: accounts.length,
                },
              });
            } catch {}
            return { address: lookupTableAddress, accountCount: 0, seed };
          } else if (remainingCapacity >= accounts.length && accounts.length > 0) {
            try {
              logger.info('alt.manager.found.reusable', {
                cat: 'tx',
                ctx: {
                  address: lookupTableAddress.toBase58(),
                  seed,
                  accountCount,
                  remainingCapacity,
                  accountsToAdd: accounts.length,
                },
              });
            } catch {}
            return { address: lookupTableAddress, accountCount, seed };
          }
        }
      } catch (error) {
        // Continue checking other seeds
        continue;
      }
    }
    
    return null;
  }

  /**
   * Extend an existing lookup table with accounts
   */
  private async extendLookupTable(
    payer: { publicKey: PublicKey; secretKey: Uint8Array },
    lookupTableAddress: PublicKey,
    addresses: PublicKey[]
  ): Promise<string> {
    if (addresses.length === 0) {
      return '';
    }
    
    const connection = getConnection();
    const kp = Keypair.fromSecretKey(payer.secretKey);
    
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses,
    });
    
    const extendTx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    extendTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    extendTx.add(extendIx);
    const extendBlockhash = await withRpcLimit(
      () => connection.getLatestBlockhash('finalized'),
      1,
      { module: 'alt', method: 'getLatestBlockhash' }
    );
    extendTx.recentBlockhash = extendBlockhash.blockhash;
    extendTx.feePayer = payer.publicKey;
    
    extendTx.sign(kp);
    
    const extendSig = await withRpcLimit(
      () => connection.sendRawTransaction(extendTx.serialize()),
      1,
      { module: 'alt', method: 'sendRawTransaction' }
    );
    await withRpcLimit(
      () => connection.confirmTransaction(extendSig, 'confirmed'),
      1,
      { module: 'alt', method: 'confirmTransaction' }
    );
    
    try {
      logger.info('alt.manager.extended', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          accountCount: addresses.length,
          signature: extendSig,
        },
      });
    } catch {}
    
    return extendSig;
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
    
    // Truncate seed to max 32 bytes (Solana PDA seed limit)
    // Use a hash if the seed is too long to maintain uniqueness
    let effectiveSeed = seed;
    if (seed.length > 32) {
      // Use first 24 chars + 8 char hash to maintain uniqueness within 32 bytes
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
      effectiveSeed = seed.slice(0, 24) + hash;
      try {
        logger.info('alt.manager.seed.truncated', {
          cat: 'tx',
          ctx: { originalSeed: seed, effectiveSeed, originalLength: seed.length },
        });
      } catch {}
    }
    
    try {
      // Derive ALT address deterministically with custom seed (for checking existing ALTs)
      const [derivedAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(effectiveSeed),
          payer.publicKey.toBuffer(),
        ],
        AddressLookupTableProgram.programId
      );
    
      // Check if ALT already exists at this address (with retries for RPC delays)
      let existing: { value: AddressLookupTableAccount | null } | null = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          existing = await withRpcLimit(
            () => connection.getAddressLookupTable(derivedAddress),
            1,
            { module: 'alt', method: 'getAddressLookupTable' }
          );
          if (existing && existing.value) break;
        } catch {}
        if (retry < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
        }
      }
      
      if (existing && existing.value) {
        const accountCount = existing.value.state?.addresses?.length || 0;
        const remainingCapacity = 256 - accountCount;
        
        try {
          logger.info('alt.manager.exists.found', {
            cat: 'tx',
            ctx: {
              address: derivedAddress.toBase58(),
              accountCount,
              remainingCapacity,
              accountsToAdd: accounts.length,
              seed,
            },
          });
        } catch {}
        
        // If it has space, extend it
        if (remainingCapacity >= accounts.length && accounts.length > 0) {
          try {
            logger.info('alt.manager.exists.extendable', {
              cat: 'tx',
              ctx: {
                address: derivedAddress.toBase58(),
                currentCount: accountCount,
                remainingCapacity,
                accountsToAdd: accounts.length,
              },
            });
          } catch {}
          
          // Extend the existing ALT
          const addressesToAdd = accounts.slice(0, remainingCapacity);
          await this.extendLookupTable(payer, derivedAddress, addressesToAdd);
          
          this.altAddresses.set(seed, derivedAddress);
          return derivedAddress;
        } else {
          // ALT exists but is full or no accounts to add
          try {
            logger.info('alt.manager.exists', {
              cat: 'tx',
              ctx: {
                address: derivedAddress.toBase58(),
                accountCount,
                full: remainingCapacity < accounts.length,
                noAccountsToAdd: accounts.length === 0,
              },
            });
          } catch {}
          this.altAddresses.set(seed, derivedAddress);
          return derivedAddress;
        }
      }
      
      // Check ALT config for existing addresses with MATCHING category/seed
      // Don't reuse common/userPdas ALTs for pool-specific accounts
      try {
        const config = await loadAltConfig();
        if (config.alts) {
          // Only check for exact seed match in config.alts
          const existingAddress = config.alts[seed as keyof typeof config.alts];
          if (existingAddress) {
            try {
              const altPk = new PublicKey(existingAddress);
              const result = await withRpcLimit(
                () => connection.getAddressLookupTable(altPk),
                1,
                { module: 'alt', method: 'getAddressLookupTable' }
              ).catch(() => ({ value: null }));
              
              if (result.value) {
                const accountCount = result.value.state?.addresses?.length || 0;
                const remainingCapacity = 256 - accountCount;
                
                // If empty or has enough capacity, reuse it
                if (accountCount === 0 || (remainingCapacity >= accounts.length && accounts.length > 0)) {
                  try {
                    logger.info('alt.manager.found.config.match', {
                      cat: 'tx',
                      ctx: {
                        address: existingAddress,
                        category: seed,
                        accountCount,
                        remainingCapacity,
                        accountsToAdd: accounts.length,
                      },
                    });
                  } catch {}
                  
                  // Extend if needed
                  if (accounts.length > 0 && remainingCapacity >= accounts.length) {
                    const addressesToAdd = accounts.slice(0, remainingCapacity);
                    try {
                      await this.extendLookupTable(payer, altPk, addressesToAdd);
                    } catch (extendError) {
                      // Log the error instead of silently swallowing it
                      try {
                        logger.error('alt.manager.extend.reuse.failed', {
                          cat: 'tx',
                          ctx: {
                            address: existingAddress,
                            category: seed,
                            accountsToAdd: addressesToAdd.length,
                            error: String((extendError as any)?.message || extendError),
                          },
                        });
                      } catch {}
                      // Continue to create a new ALT instead
                      throw extendError;
                    }
                  }
                  
                  // Return the ALT address - caller will handle storing
                  return altPk;
                }
              }
            } catch (e) {
              // Log reuse attempt failure
              try {
                logger.warn('alt.manager.reuse.failed', {
                  cat: 'tx',
                  ctx: {
                    seed,
                    error: String((e as any)?.message || e),
                  },
                });
              } catch {}
            }
          }
        }
      } catch {}
      
      // Check for reusable lookup tables (created but not extended)
      // Retry this check a few times as the ALT might not be immediately queryable
      let reusable: { address: PublicKey; accountCount: number; seed: string } | null = null;
      for (let retry = 0; retry < 3; retry++) {
        reusable = await this.findReusableLookupTable(payer, accounts);
        if (reusable) break;
        if (retry < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
        }
      }
      
      if (reusable) {
        try {
          logger.info('alt.manager.reusing', {
            cat: 'tx',
            ctx: {
              address: reusable.address.toBase58(),
              originalSeed: reusable.seed,
              requestedSeed: seed,
              currentCount: reusable.accountCount,
              accountsToAdd: accounts.length,
            },
          });
        } catch {}
        
        // Extend the reusable ALT
        if (accounts.length > 0) {
          const addressesToAdd = accounts.slice(0, 256 - reusable.accountCount);
          await this.extendLookupTable(payer, reusable.address, addressesToAdd);
        }
        
        // Return the ALT address - caller will handle storing
        return reusable.address;
      }
    
    // Get recent slot for ALT creation
    const recentSlotRaw = await withRpcLimit(
      () => connection.getSlot('finalized'),
      1,
      { module: 'alt', method: 'getSlot' }
    );
    const recentSlot = typeof recentSlotRaw === 'number' ? recentSlotRaw : Number(recentSlotRaw);
    
    // Create ALT instruction (returns [instruction, lookupTableAddress])
    // IMPORTANT: Capture the actual address returned by createLookupTable!
    // The derived address might not match due to bump seed differences
    const [createIx, actualLookupTableAddress] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
    
    // Use the actual address from createLookupTable, not the derived one
    const lookupTableAddress = actualLookupTableAddress;
    
    // STEP 1: Create the lookup table (first transaction)
    // The lookup table account must exist before we can extend it
    const createTx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    createTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    createTx.add(createIx);
    const createBlockhash = await withRpcLimit(
      () => connection.getLatestBlockhash('finalized'),
      1,
      { module: 'alt', method: 'getLatestBlockhash' }
    );
    createTx.recentBlockhash = createBlockhash.blockhash;
    createTx.feePayer = payer.publicKey;
    
    const kp = Keypair.fromSecretKey(payer.secretKey);
    createTx.sign(kp);
    
    const createSig = await withRpcLimit(
      () => connection.sendRawTransaction(createTx.serialize()),
      1,
      { module: 'alt', method: 'sendRawTransaction' }
    );
    
    // Use 'finalized' commitment for more reliable confirmation
    const confirmation = await withRpcLimit(
      () => connection.confirmTransaction(createSig, 'finalized'),
      1,
      { module: 'alt', method: 'confirmTransaction' }
    );
    
    // Verify the transaction actually succeeded
    if (confirmation.value.err) {
      throw new Error(`Lookup table creation transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    try {
      logger.info('alt.manager.create.step1', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          signature: createSig,
        },
      });
    } catch {}
    
    // Retry verification with exponential backoff (reduced retries for faster operation)
    // The account may take a moment to be available after confirmation
    let verifyResult: { value: AddressLookupTableAccount | null } | null = null;
    const maxRetries = 5; // Reduced from 8 for faster operation
    const baseDelayMs = 500; // Reduced from 1000ms for faster operation
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      try {
        verifyResult = await withRpcLimit(
          () => connection.getAddressLookupTable(lookupTableAddress),
          1,
          { module: 'alt', method: 'getAddressLookupTable' }
        );
        
        if (verifyResult && verifyResult.value) {
          try {
            logger.info('alt.manager.create.verified', {
              cat: 'tx',
              ctx: {
                address: lookupTableAddress.toBase58(),
                attempt: attempt + 1,
                accountCount: verifyResult.value.state?.addresses?.length || 0,
              },
            });
          } catch {}
          break;
        }
      } catch (error) {
        // Continue to next retry
        if (attempt === maxRetries - 1) {
          try {
            logger.warn('alt.manager.create.verify.failed', {
              cat: 'tx',
              ctx: {
                address: lookupTableAddress.toBase58(),
                attempts: maxRetries,
                error: String((error as any)?.message || error),
              },
            });
          } catch {}
        }
      }
    }
    
    if (!verifyResult || !verifyResult.value) {
      // Check transaction status one more time
      try {
        const txStatus = await withRpcLimit(
          () => connection.getSignatureStatus(createSig),
          1,
          { module: 'alt', method: 'getSignatureStatus' }
        );
        
        if (txStatus.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(txStatus.value.err)}`);
        }
        
        // Transaction succeeded but account not queryable yet
        // This can happen due to RPC indexing delays - proceed with extend attempt
        // The extend will fail clearly if the account doesn't exist
        try {
          logger.warn('alt.manager.create.verify.timeout', {
            cat: 'tx',
            ctx: {
              address: lookupTableAddress.toBase58(),
              signature: createSig,
              attempts: maxRetries,
              note: 'Transaction succeeded but account not queryable. Proceeding with extend - it will fail if account does not exist.',
            },
          });
        } catch {}
        // Don't throw - proceed with extend attempt
      } catch (error) {
        // If we can't check status, assume transaction might have failed
        if (error instanceof Error && error.message.includes('Transaction failed')) {
          throw error;
        }
        // Otherwise, log warning and proceed - extend will fail if account doesn't exist
        try {
          logger.warn('alt.manager.create.verify.uncertain', {
            cat: 'tx',
            ctx: {
              address: lookupTableAddress.toBase58(),
              signature: createSig,
              error: String((error as any)?.message || error),
              note: 'Could not verify account exists. Proceeding with extend attempt.',
            },
          });
        } catch {}
      }
    }
    
    // Limit to 256 addresses per ALT (Solana limit)
    const addressesToAdd = accounts.slice(0, 256);
    
    try {
      logger.info('alt.manager.create.preparing.extend', {
        cat: 'tx',
        ctx: {
          address: lookupTableAddress.toBase58(),
          createSignature: createSig,
          accountsToAdd: addressesToAdd.length,
          totalAccountsProvided: accounts.length,
        },
      });
    } catch {}
    
    if (addressesToAdd.length === 0) {
      // No accounts to add, just return the empty ALT
      // NOTE: Caller (createAndExtendAlt) will handle storing in altAddresses map
      try {
        logger.warn('alt.manager.created.empty', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            signature: createSig,
            note: 'No accounts to add - ALT created but empty. Check collectCommonAccounts()',
            accountsProvided: accounts.length,
          },
        });
      } catch {}
      return lookupTableAddress;
    }
    
    // STEP 2: Extend ALT with accounts (second transaction)
    // Wait and verify the account exists and is properly initialized before extending
    // Reduced retries and delays for faster operation
    let accountReady = false;
    const maxReadyRetries = 5; // Reduced from 10 for faster operation
    const readyDelayMs = 1000; // Reduced from 2000ms for faster operation
    
    for (let retry = 0; retry < maxReadyRetries; retry++) {
      if (retry > 0) {
        await new Promise(resolve => setTimeout(resolve, readyDelayMs));
      }
      
      try {
        // Check if account exists and is owned by Address Lookup Table program
        const accountInfo = await withRpcLimit(
          () => connection.getAccountInfo(lookupTableAddress),
          1,
          { module: 'alt', method: 'getAccountInfo' }
        );
        
        if (accountInfo && accountInfo.owner) {
          const isOwnedByAltProgram = accountInfo.owner.equals(AddressLookupTableProgram.programId);
          
          if (isOwnedByAltProgram) {
            // Also verify we can get the lookup table data
            const altResult = await withRpcLimit(
              () => connection.getAddressLookupTable(lookupTableAddress),
              1,
              { module: 'alt', method: 'getAddressLookupTable' }
            );
            
            if (altResult && altResult.value) {
              accountReady = true;
              try {
                logger.info('alt.manager.account.ready', {
                  cat: 'tx',
                  ctx: {
                    address: lookupTableAddress.toBase58(),
                    attempt: retry + 1,
                    owner: accountInfo.owner.toBase58(),
                    accountCount: altResult.value.state?.addresses?.length || 0,
                  },
                });
              } catch {}
              break;
            }
          } else {
            try {
              logger.warn('alt.manager.account.wrong_owner', {
                cat: 'tx',
                ctx: {
                  address: lookupTableAddress.toBase58(),
                  attempt: retry + 1,
                  owner: accountInfo.owner.toBase58(),
                  expectedOwner: AddressLookupTableProgram.programId.toBase58(),
                },
              });
            } catch {}
          }
        }
      } catch (error) {
        // Continue retrying
        if (retry === maxReadyRetries - 1) {
          try {
            logger.warn('alt.manager.account.check.failed', {
              cat: 'tx',
              ctx: {
                address: lookupTableAddress.toBase58(),
                attempts: maxReadyRetries,
                error: String((error as any)?.message || error),
              },
            });
          } catch {}
        }
      }
    }
    
    if (!accountReady) {
      // Account not ready after retries - don't attempt extend
      try {
        logger.error('alt.manager.account.not_ready', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            createSignature: createSig,
            note: 'Account not ready for extension after retries. ALT created but not extended. Can be extended manually later.',
          },
        });
      } catch {}
      
      // Return the ALT address - caller will handle storing
      return lookupTableAddress;
    }
    
    try {
      try {
        logger.info('alt.manager.extend.starting', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            accountCount: addressesToAdd.length,
          },
        });
      } catch {}
      
      // IMPORTANT: ExtendLookupTable is limited to ~30 addresses per transaction
      // due to transaction size limits. Split into batches if needed.
      const BATCH_SIZE = 30;
      const batches: PublicKey[][] = [];
      
      for (let i = 0; i < addressesToAdd.length; i += BATCH_SIZE) {
        batches.push(addressesToAdd.slice(i, i + BATCH_SIZE));
      }
      
      try {
        logger.info('alt.manager.extend.batches', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            totalAccounts: addressesToAdd.length,
            batchCount: batches.length,
            batchSize: BATCH_SIZE,
          },
        });
      } catch {}
      
      const extendSignatures: string[] = [];
      
      // Extend ALT in batches
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        
        try {
          logger.info('alt.manager.extend.batch', {
            cat: 'tx',
            ctx: {
              address: lookupTableAddress.toBase58(),
              batchIndex: batchIdx + 1,
              batchTotal: batches.length,
              batchSize: batch.length,
            },
          });
        } catch {}
        
        const extendIx = AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: lookupTableAddress,
          addresses: batch,
        });
        
        const extendTx = new Transaction();
        // Add priority fee instructions for reliable confirmation
        extendTx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
        );
        extendTx.add(extendIx);
        const extendBlockhash = await withRpcLimit(
          () => connection.getLatestBlockhash('finalized'),
          1,
          { module: 'alt', method: 'getLatestBlockhash' }
        );
        extendTx.recentBlockhash = extendBlockhash.blockhash;
        extendTx.feePayer = payer.publicKey;
        
        extendTx.sign(kp);
        
        const extendSig = await withRpcLimit(
          () => connection.sendRawTransaction(extendTx.serialize()),
          1,
          { module: 'alt', method: 'sendRawTransaction' }
        );
        await withRpcLimit(
          () => connection.confirmTransaction(extendSig, 'confirmed'),
          1,
          { module: 'alt', method: 'confirmTransaction' }
        );
        
        extendSignatures.push(extendSig);
        
        // Small delay between batches to avoid overwhelming RPC
        if (batchIdx < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      try {
        logger.info('alt.manager.created', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            accountCount: addressesToAdd.length,
            batchCount: batches.length,
            createSignature: createSig,
            extendSignatures: extendSignatures.slice(0, 3), // Log first 3 for brevity
          },
        });
      } catch {}
      
      return lookupTableAddress;
    } catch (extendError) {
      // If extend fails, log but don't throw - the ALT was created successfully
      try {
        logger.error('alt.manager.extend.failed', {
          cat: 'tx',
          ctx: {
            address: lookupTableAddress.toBase58(),
            createSignature: createSig,
            accountCount: addressesToAdd.length,
            error: String((extendError as any)?.message || extendError),
            note: 'ALT created but extend failed - can be extended later',
          },
        });
      } catch {}
      
      // Return the ALT address - caller will handle storing
      return lookupTableAddress;
    }
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
   * These are accounts that appear in nearly every transaction
   */
  private async collectCommonAccounts(walletPubkey?: PublicKey): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const seen = new Set<string>(); // Deduplicate

    const addAccount = (pk: PublicKey | string) => {
      try {
        const pubkey = typeof pk === 'string' ? new PublicKey(pk) : pk;
        const addr = pubkey.toBase58();
        if (!seen.has(addr)) {
          seen.add(addr);
          accounts.push(pubkey);
        }
      } catch {}
    };

    try {
      // ============================================
      // 1. SYSTEM PROGRAMS (appear in every transaction)
      // ============================================
      addAccount('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');  // Token Program
      addAccount('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');  // Token-2022 Program
      addAccount('11111111111111111111111111111111');              // System Program
      addAccount('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');  // ATA Program
      addAccount('ComputeBudget111111111111111111111111111111');    // Compute Budget Program
      addAccount('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');    // Memo Program
      
      // ============================================
      // 1b. SYSVARS (frequently used in DeFi transactions)
      // ============================================
      addAccount('Sysvar1nstructions1111111111111111111111111');    // Instructions Sysvar
      addAccount('SysvarRent111111111111111111111111111111111');    // Rent Sysvar
      addAccount('SysvarC1ock11111111111111111111111111111111');    // Clock Sysvar
      addAccount('SysvarRecentB1teleHashes11111111111111111111');  // Recent Blockhashes Sysvar
      addAccount('SysvarS1otHashes111111111111111111111111111');   // Slot Hashes Sysvar
      addAccount('SysvarEpochScheworkahead1111111111111111111');   // Epoch Schedule Sysvar
      addAccount('SysvarFees111111111111111111111111111111111');    // Fees Sysvar
      addAccount('SysvarS1otHistory11111111111111111111111111');   // Slot History Sysvar

      // ============================================
      // 2. DEX PROGRAM IDs (appear in every DEX swap)
      // ============================================
      // Raydium programs
      addAccount((CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');  // Raydium CLMM
      addAccount((CONFIG as any)?.raydium?.ammV4Program || '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'); // Raydium AMM v4
      addAccount('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');  // Raydium CPMM
      addAccount('routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS');   // Raydium Routing Program
      
      // Orca Whirlpool
      addAccount((CONFIG as any)?.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
      
      // Meteora programs
      addAccount((CONFIG as any)?.meteora?.programId || 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');  // DLMM
      addAccount('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');  // Meteora Dynamic AMM (DAMM v1)
      addAccount('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');   // Meteora CP-AMM (DAMM v2)
      addAccount('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi');  // Meteora Pools Program
      
      // PumpSwap (post-graduation AMM)
      addAccount('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');   // PumpSwap AMM
      addAccount('BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW');  // PumpSwap Router
      
      // OpenBook DEX (used by Raydium AMM)
      addAccount('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');   // OpenBook DEX v1
      addAccount('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');   // OpenBook DEX v2
      
      // Jupiter aggregator (optional, for Jupiter routes)
      addAccount('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');   // Jupiter v6

      // ============================================
      // 3. DEX-SPECIFIC SHARED ACCOUNTS & AUTHORITIES
      // ============================================
      // Raydium AMM Authority PDA (required for all AMM v4 swaps)
      addAccount('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');  // Raydium AMM Authority
      
      // Meteora Event Authority PDA (every Meteora swap)
      addAccount('D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6');
      
      // Raydium CLMM AMM configs (all fee tiers)
      const raydiumClmmConfigs = [
        '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x',  // 1bp (0.01%) - most common for major pairs
        'HVSwB6sML94MBWaHNrfmLMo3ZstLYvbnqRtMRdupCrXJ',  // 2bp (0.02%)
        'GjLEiquek1Nc2YjcBhufUGFRkaqW1JhaGjsdFd8mys38',  // 4bp (0.04%)
        'E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp',  // 5bp (0.05%)
        '2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5',  // 10bp (0.10%)
        '3XKBz1TgMDzFKLD2MhFH8SfJpLCQcFQqbLhaBLAkKMRU',  // 20bp (0.20%)
        'CQYbhr6amxNER6Wrip4mFHPgA1wCyPqvCNqvLrsTdTHC',  // 25bp (0.25%)
        'A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x',  // 100bp (1%)
        'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',  // Additional config
      ];
      for (const config of raydiumClmmConfigs) {
        addAccount(config);
      }

      // Raydium CPMM configs
      const raydiumCpmmConfigs = [
        'GVSwm4smQBYcgAJU7qjFHLQBHTc4mL3yq7MfKGfKr95K',  // CPMM config 1
        'BMS3X4bVvMXqX8NjZqVVLfx9BSXJ3z1JqPBXMV7YMXHL',  // CPMM config 2
      ];
      for (const config of raydiumCpmmConfigs) {
        addAccount(config);
      }

      // Orca Whirlpools configs
      addAccount('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');  // Main whirlpools config
      addAccount('FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR');  // Whirlpools Config Extension v1
      addAccount('777H5H3Tp9U11uRVRzFwM8BinfiakbaLT8vQpeuhvEiH');  // Whirlpools Config Extension v2

      // ============================================
      // 4. ANCHOR MINT ADDRESSES
      // ============================================
      // Get anchor mints from config (or use defaults)
      const anchorMints: string[] = (CONFIG.system as any)?.anchorMints || [
        'So11111111111111111111111111111111111111112',   // SOL (wSOL)
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',  // cbBTC
        'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  // USD1
        'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
      ];
      
      // Add additional common mints
      const additionalMints = [
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
        'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH (Wormhole)
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC (Wormhole)
        'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
        'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  // RENDER
      ];
      
      const allMints = [...new Set([...anchorMints, ...additionalMints])];
      for (const mint of allMints) {
        addAccount(mint);
      }

      // ============================================
      // 5. USER ATAs FOR ANCHOR MINTS
      // ============================================
      if (walletPubkey) {
        const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
        
        // Add wallet pubkey itself
        addAccount(walletPubkey);
        
        // Token-2022 mints (add any known Token-2022 mints here)
        const token2022Mints = new Set<string>([
          // Add Token-2022 mints as discovered
        ]);
        
        for (const mint of allMints) {
          try {
            const mintPk = new PublicKey(mint);
            const program = token2022Mints.has(mint) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            const ata = getAssociatedTokenAddressSync(mintPk, walletPubkey, false, program);
            addAccount(ata);
          } catch {}
        }
      }

      // ============================================
      // 6. HIGH-FREQUENCY POOL VAULTS (ANCHOR PAIRS)
      // ============================================
      const frequentVaults = await this.collectFrequentAnchorVaults(anchorMints);
      for (const vault of frequentVaults) {
        addAccount(vault);
      }

      // ============================================
      // 7. ARB-ROUTER PROGRAM (always include)
      // ============================================
      // Use configured program ID or fall back to default ARB_ROUTER_PROGRAM_ID
      const routerProgramId = (CONFIG as any)?.router?.programId || ARB_ROUTER_PROGRAM_ID.toBase58();
      addAccount(routerProgramId);

      try {
        logger.info('alt.manager.collect.common.complete', {
          cat: 'tx',
          ctx: { 
            accountCount: accounts.length,
            hasWalletAtas: !!walletPubkey,
            anchorMintCount: allMints.length,
          },
        });
      } catch {}
      
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
   * Collect flashloan-related accounts (vault PDAs and vault token accounts)
   * These are used in flash_borrow and flash_repay instructions
   * @param vaultOwner Owner of the vaults (typically the deployer/authority)
   * @param routerProgramId The arb-router program ID
   * @returns Array of PublicKeys for vault accounts
   */
  async collectFlashloanAccounts(
    vaultOwner: PublicKey,
    routerProgramId: PublicKey
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');

    // VAULT_SEED from router types
    const VAULT_SEED = Buffer.from('vault');

    // Common mints that typically have vaults
    const vaultMints = [
      'So11111111111111111111111111111111111111112',   // SOL (wSOL)
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ];

    try {
      for (const mintStr of vaultMints) {
        const mint = new PublicKey(mintStr);
        
        // Derive vault PDA: seeds = ["vault", owner, mint]
        const [vault] = PublicKey.findProgramAddressSync(
          [VAULT_SEED, vaultOwner.toBuffer(), mint.toBuffer()],
          routerProgramId
        );
        accounts.push(vault);

        // Derive vault token account (ATA of vault for mint, allowOwnerOffCurve=true)
        const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);
        accounts.push(vaultTokenAccount);
      }

      // Instructions sysvar (used in flash_borrow for CPI introspection)
      accounts.push(new PublicKey('Sysvar1nstructions1111111111111111111111111'));

      try {
        logger.info('alt.manager.collect.flashloan.complete', {
          cat: 'tx',
          ctx: {
            vaultOwner: vaultOwner.toBase58().slice(0, 8) + '...',
            routerProgram: routerProgramId.toBase58().slice(0, 8) + '...',
            accountCount: accounts.length,
            vaultCount: vaultMints.length,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.flashloan.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Collect user PDA accounts (wallet ATAs for common mints)
   * These are the user's token accounts that appear in swap transactions
   * @param walletPubkey The user's wallet public key
   * @returns Array of PublicKeys for user token accounts
   */
  async collectUserPdaAccounts(walletPubkey: PublicKey): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

    // Token-2022 program ID
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    // Common mints the user likely has ATAs for
    // Format: { mint, programId } - most use TOKEN_PROGRAM_ID, some use Token-2022
    const commonMints = [
      { mint: 'So11111111111111111111111111111111111111112', program: TOKEN_PROGRAM_ID },   // SOL (wSOL)
      { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', program: TOKEN_PROGRAM_ID }, // USDC
      { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', program: TOKEN_PROGRAM_ID }, // USDT
      { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', program: TOKEN_PROGRAM_ID },  // JUP
      { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', program: TOKEN_PROGRAM_ID }, // BONK
      { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', program: TOKEN_PROGRAM_ID },  // mSOL
      { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', program: TOKEN_PROGRAM_ID },  // bSOL
      { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', program: TOKEN_PROGRAM_ID }, // ETH (Wormhole)
      { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', program: TOKEN_PROGRAM_ID }, // BTC (Wormhole)
    ];

    try {
      // Add wallet pubkey itself (appears as signer in many instructions)
      accounts.push(walletPubkey);

      for (const { mint, program } of commonMints) {
        try {
          const mintPk = new PublicKey(mint);
          const ata = getAssociatedTokenAddressSync(mintPk, walletPubkey, false, program);
          accounts.push(ata);
        } catch {}
      }

      try {
        logger.info('alt.manager.collect.userPdas.complete', {
          cat: 'tx',
          ctx: {
            wallet: walletPubkey.toBase58().slice(0, 8) + '...',
            accountCount: accounts.length,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.userPdas.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Collect pools for a specific DEX sorted by liquidity/TVL
   * @param dex DEX to collect pools for
   * @param poolType Type of pools to collect (amm, clmm, or both)
   * @param maxPools Maximum number of pools to collect (default 30)
   * @returns Array of PublicKeys for all accounts needed for the top pools
   */
  async collectDexPoolAccounts(
    dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap',
    poolType: 'amm' | 'clmm' | 'cpmm' | 'both' = 'both',
    maxPools: number = 30
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Import graph snapshot to access pool data with liquidity
      const { getGraphSnapshot } = await import('../../server/graph.js');
      const snapshot = await getGraphSnapshot();
      
      if (!snapshot || !snapshot.edges) {
        try {
          logger.warn('alt.manager.collect.dex.no.snapshot', {
            cat: 'tx',
            ctx: { dex, poolType, maxPools },
          });
        } catch {}
        return accounts;
      }

      // Map frontend DEX keys to graph edge dex values
      // This matches the logic in arb.ts pools-by-dex route
      const dexMatchFn = (edgeDex: string, edgePoolKind: string): boolean => {
        const normalizedEdgeDex = edgeDex.toLowerCase();
        
        switch (dex) {
          case 'raydium':
            // Match raydium CLMM only (for backward compat, excludes AMM and CPMM)
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'clmm';
          case 'raydium-amm':
            // Match only raydium AMM v4 pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'amm';
          case 'raydium-cpmm':
            // Match only raydium CPMM pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'cpmm';
          case 'orca':
            return normalizedEdgeDex === 'orca';
          case 'meteora':
            // Match meteora DLMM only (clmm type)
            return normalizedEdgeDex === 'meteora' && edgePoolKind === 'clmm';
          case 'meteora-balanced':
            return normalizedEdgeDex === 'meteora_balanced' || normalizedEdgeDex === 'meteorabalanced';
          case 'meteora-damm-v1':
            // Match Meteora Dynamic AMM v1 pools
            return normalizedEdgeDex === 'meteora_damm_v1' || normalizedEdgeDex === 'meteora-damm-v1' ||
                   normalizedEdgeDex === 'meteorabalanced_v1' || normalizedEdgeDex === 'meteora_balanced_v1';
          case 'meteora-damm-v2':
            // Match Meteora CP-AMM v2 pools
            return normalizedEdgeDex === 'meteora_damm_v2' || normalizedEdgeDex === 'meteora-damm-v2' ||
                   normalizedEdgeDex === 'meteorabalanced_v2' || normalizedEdgeDex === 'meteora_balanced_v2';
          case 'pumpswap':
            return normalizedEdgeDex === 'pumpswap';
          default:
            return false;
        }
      };

      // Filter edges by DEX and pool type
      let filtered = snapshot.edges.filter(edge => {
        const edgeDex = String(edge.dex || '').toLowerCase();
        const edgePoolKind = String(edge.pool_kind || '');
        
        if (!dexMatchFn(edgeDex, edgePoolKind)) return false;
        
        // For specific pool types, further filter (except for DEXes where we already filtered by kind)
        if (poolType === 'both') return true;
        if (dex === 'raydium-cpmm' || dex === 'raydium-amm' || dex === 'raydium') return true; // Already filtered by kind
        if (dex.startsWith('meteora-damm')) return true; // Already filtered by dex variant
        if (dex === 'pumpswap') return true; // Only has AMM type
        
        return edgePoolKind === poolType;
      });

      // CRITICAL: Filter out reverse edges to avoid counting the same pool twice
      // This allows us to maximize unique pools in the ALT
      const forwardEdgesOnly = filtered.filter(edge => {
        const poolId = String(edge.pool_id || '');
        // Keep edges that don't have -rev or #rev suffix (includes -fwd and base pools)
        // Skip edges marked as -rev or #rev to avoid duplicates
        return !/[#-]rev$/.test(poolId);
      });

      try {
        logger.info('alt.manager.collect.dex.filtered', {
          cat: 'tx',
          ctx: {
            dex,
            poolType,
            totalEdges: snapshot.edges.length,
            filteredByDex: filtered.length,
            afterRemovingRev: forwardEdgesOnly.length,
            revEdgesRemoved: filtered.length - forwardEdgesOnly.length,
          },
        });
      } catch {}

      // Sort by liquidity metrics (tvl_usd > liquidity_display > pool_liquidity_raw > liquidity)
      forwardEdgesOnly.sort((a, b) => {
        const getLiquidity = (edge: any): number => {
          if (edge.tvl_usd && edge.tvl_usd > 0) return edge.tvl_usd;
          if (edge.liquidity_display && edge.liquidity_display > 0) return edge.liquidity_display;
          if (edge.pool_liquidity_raw && edge.pool_liquidity_raw > 0) return edge.pool_liquidity_raw;
          if (edge.liquidity && edge.liquidity > 0) return edge.liquidity;
          return 0;
        };
        return getLiquidity(b) - getLiquidity(a);
      });

      // Take top N pools (deduplicate by pool_id base to be extra safe)
      const poolIds = new Set<string>();
      const topPools: any[] = [];
      
      for (const edge of forwardEdgesOnly) {
        if (!edge.pool_id) continue;
        // Clean the pool ID to its base form (remove -fwd/-rev if present)
        const cleanPoolId = String(edge.pool_id).replace(/-(rev|fwd)$/, '');
        if (poolIds.has(cleanPoolId)) continue;
        poolIds.add(cleanPoolId);
        topPools.push(edge);
        if (topPools.length >= maxPools) break;
      }

      try {
        logger.info('alt.manager.collect.dex.pools', {
          cat: 'tx',
          ctx: {
            dex,
            poolType,
            maxPools,
            foundPools: topPools.length,
            totalEdges: snapshot.edges.length,
            filteredEdges: filtered.length,
          },
        });
      } catch {}

      // Collect accounts for each pool
      for (const edge of topPools) {
        try {
          const poolAccounts = await this.collectPoolSpecificAccounts(edge.pool_id, dex);
          accounts.push(...poolAccounts);
        } catch (error) {
          try {
            logger.warn('alt.manager.collect.pool.accounts.error', {
              cat: 'tx',
              ctx: {
                poolId: edge.pool_id,
                dex,
                error: String((error as any)?.message || error),
              },
            });
          } catch {}
        }
      }

      // Deduplicate accounts
      const seen = new Set<string>();
      const deduped = accounts.filter(pk => {
        const addr = pk.toBase58();
        if (seen.has(addr)) return false;
        seen.add(addr);
        return true;
      });

      try {
        logger.info('alt.manager.collect.dex.complete', {
          cat: 'tx',
          ctx: {
            dex,
            poolType,
            poolCount: topPools.length,
            totalAccounts: deduped.length,
            avgAccountsPerPool: topPools.length > 0 ? (deduped.length / topPools.length).toFixed(1) : 0,
          },
        });
      } catch {}

      return deduped;
    } catch (error) {
      try {
        logger.error('alt.manager.collect.dex.error', {
          cat: 'tx',
          ctx: {
            dex,
            poolType,
            maxPools,
            error: String((error as any)?.message || error),
          },
        });
      } catch {}
      return accounts;
    }
  }

  /**
   * Collect detailed accounts for a specific pool ID
   * @param poolId Pool address (may include -rev or -fwd suffix)
   * @param dex DEX type
   * @returns Array of PublicKeys for all accounts needed for this pool
   */
  async collectPoolSpecificAccounts(
    poolId: string,
    dex: string
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const connection = getConnection();
    
    try {
      // Strip directional suffixes (-rev, -fwd, #rev, #fwd) from pool_id
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      const poolPk = new PublicKey(cleanPoolId);
      accounts.push(poolPk);

      const dexLower = dex.toLowerCase();

      if (dexLower === 'raydium') {
        // Fetch pool account data to determine if AMM or CLMM
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (!poolInfo) return accounts;

          // Try to determine pool type from account size
          // Raydium AMM pools are typically ~752 bytes
          // Raydium CLMM pools are typically ~1544 bytes
          const isClmm = poolInfo.data.length > 1000;

          if (isClmm) {
            // Raydium CLMM - parse and extract all accounts
            const clmmAccounts = await this.parseRaydiumClmmAccounts(poolPk, poolInfo);
            accounts.push(...clmmAccounts);
            try {
              logger.info('alt.manager.raydium.clmm.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: clmmAccounts.length },
              });
            } catch {}
          } else {
            // Raydium AMM - parse and extract accounts
            const ammAccounts = await this.parseRaydiumAmmAccounts(poolPk, poolInfo);
            accounts.push(...ammAccounts);
            try {
              logger.info('alt.manager.raydium.amm.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: ammAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.raydium.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'orca') {
        // Orca Whirlpool - parse and extract all accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const whirlpoolAccounts = await this.parseOrcaWhirlpoolAccounts(poolPk, poolInfo);
            accounts.push(...whirlpoolAccounts);
            try {
              logger.info('alt.manager.orca.whirlpool.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: whirlpoolAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.orca.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'meteora') {
        // Meteora DLMM - parse and extract all accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const dlmmAccounts = await this.parseMeteoraDlmmAccounts(poolPk, poolInfo);
            accounts.push(...dlmmAccounts);
            try {
              logger.info('alt.manager.meteora.dlmm.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: dlmmAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.meteora.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'meteora-balanced') {
        // Meteora Balanced AMM accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const balancedAccounts = await this.parseMeteoraBalancedAccounts(poolPk, poolInfo);
            accounts.push(...balancedAccounts);
            try {
              logger.info('alt.manager.meteora.balanced.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: balancedAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.meteora.balanced.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'raydium-cpmm') {
        // Raydium CPMM (Constant Product AMM) accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const cpmmAccounts = await this.parseRaydiumCpmmAccounts(poolPk, poolInfo);
            accounts.push(...cpmmAccounts);
            try {
              logger.info('alt.manager.raydium.cpmm.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: cpmmAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.raydium.cpmm.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'meteora-damm-v1' || dexLower === 'meteora_damm_v1') {
        // Meteora Dynamic AMM v1 accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const dammAccounts = await this.parseMeteoraDammAccounts(poolPk, poolInfo, 'v1');
            accounts.push(...dammAccounts);
            try {
              logger.info('alt.manager.meteora.damm.v1.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: dammAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.meteora.damm.v1.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'meteora-damm-v2' || dexLower === 'meteora_damm_v2') {
        // Meteora Dynamic AMM v2 (CP-AMM) accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const dammAccounts = await this.parseMeteoraDammAccounts(poolPk, poolInfo, 'v2');
            accounts.push(...dammAccounts);
            try {
              logger.info('alt.manager.meteora.damm.v2.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: dammAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.meteora.damm.v2.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      } else if (dexLower === 'pumpswap') {
        // Pumpswap (post-graduation AMM) accounts
        try {
          const poolInfo = await withRpcLimit(
            () => connection.getAccountInfo(poolPk),
            1,
            { module: 'alt', method: 'getAccountInfo' }
          );
          if (poolInfo) {
            const pumpswapAccounts = await this.parsePumpswapAccounts(poolPk, poolInfo);
            accounts.push(...pumpswapAccounts);
            try {
              logger.info('alt.manager.pumpswap.collected', {
                cat: 'tx',
                ctx: { poolId: cleanPoolId, accountCount: pumpswapAccounts.length },
              });
            } catch {}
          }
        } catch (e) {
          try {
            logger.warn('alt.manager.pumpswap.parse.error', {
              cat: 'tx',
              ctx: { poolId: cleanPoolId, error: String((e as any)?.message || e) },
            });
          } catch {}
        }
      }

      return accounts;
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.pool.specific.error', {
          cat: 'tx',
          ctx: {
            poolId,
            dex,
            error: String((error as any)?.message || error),
          },
        });
      } catch {}
      return accounts;
    }
  }

  /**
   * Create multi-ALT pool management for a specific DEX
   * This creates multiple ALTs if needed to fit all pool accounts
   * and updates the poolToAlt mapping for O(1) route lookups
   * 
   * @param dex DEX to create ALTs for
   * @param maxPoolsTotal Maximum pools to track (distributed across multiple ALTs)
   * @returns DexAltSet with all created ALT info
   */
  async createDexPoolAlts(
    dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap',
    maxPoolsTotal: number = 100
  ): Promise<DexAltSet> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    
    // Maximum accounts per ALT (Solana limit is 256, leave room for growth)
    const MAX_ACCOUNTS_PER_ALT = 230;
    
    // Estimated accounts per pool by DEX
    // Note: These include pool-specific accounts that appear in every swap
    const ACCOUNTS_PER_POOL: Record<string, number> = {
      raydium: 12,         // CLMM: pool, config, vaults, mints, observation, tick arrays
      'raydium-amm': 15,   // AMM v4: pool, authority, vaults, mints, markets, orders
      'raydium-cpmm': 10,  // CPMM: pool, config, vaults, mints, observation
      orca: 10,            // Whirlpool: pool, vaults, mints, oracle, tick arrays
      meteora: 10,         // DLMM: pair, reserves, mints, oracle, bin arrays
      'meteora-damm-v1': 10, // Dynamic AMM v1: pool, vaults, mints, oracle
      'meteora-damm-v2': 10, // CP-AMM v2: pool, vaults, mints
      pumpswap: 8,         // Post-graduation AMM: pool, vaults, mints
    };
    
    const result: DexAltSet = {
      addresses: [],
      altContents: {},
      totalPools: 0,
      totalAccounts: 0,
    };

    try {
      // Get pool data from graph snapshot
      const { getGraphSnapshot } = await import('../../server/graph.js');
      const snapshot = await getGraphSnapshot();
      
      if (!snapshot || !snapshot.edges) {
        try {
          logger.warn('alt.manager.createDexPoolAlts.no.snapshot', {
            cat: 'tx',
            ctx: { dex, maxPoolsTotal },
          });
        } catch {}
        return result;
      }

      // DEX matching function - handles graph edge dex values vs API dex keys
      // Graph edges use different naming conventions than the API parameter
      const dexMatchFn = (edgeDex: string, edgePoolKind: string): boolean => {
        const normalizedEdgeDex = edgeDex.toLowerCase();
        
        switch (dex) {
          case 'raydium':
            // Match raydium CLMM only
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'clmm';
          case 'raydium-amm':
            // Match only raydium AMM v4 pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'amm';
          case 'raydium-cpmm':
            // Match only raydium CPMM pools (edges have dex='Raydium' with pool_kind='cpmm')
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'cpmm';
          case 'orca':
            return normalizedEdgeDex === 'orca';
          case 'meteora':
            // Match meteora DLMM only (clmm type)
            return normalizedEdgeDex === 'meteora' && edgePoolKind === 'clmm';
          case 'meteora-balanced':
            return normalizedEdgeDex === 'meteora_balanced' || normalizedEdgeDex === 'meteora-balanced';
          case 'meteora-damm-v1':
            // Match Meteora Dynamic AMM v1 pools (various naming conventions in graph)
            return normalizedEdgeDex === 'meteora_damm_v1' || normalizedEdgeDex === 'meteora-damm-v1' ||
                   normalizedEdgeDex === 'meteorabalanced_v1' || normalizedEdgeDex === 'meteora_balanced_v1';
          case 'meteora-damm-v2':
            // Match Meteora CP-AMM v2 pools (various naming conventions in graph)
            return normalizedEdgeDex === 'meteora_damm_v2' || normalizedEdgeDex === 'meteora-damm-v2' ||
                   normalizedEdgeDex === 'meteorabalanced_v2' || normalizedEdgeDex === 'meteora_balanced_v2';
          case 'pumpswap':
            return normalizedEdgeDex === 'pumpswap';
          default:
            return false;
        }
      };

      // Filter and sort edges for this DEX
      let filtered = snapshot.edges.filter(edge => {
        const edgeDex = String(edge.dex || '').toLowerCase();
        const edgePoolKind = String((edge as any).pool_kind || '');
        return dexMatchFn(edgeDex, edgePoolKind);
      });

      // Filter out reverse edges
      const forwardEdgesOnly = filtered.filter(edge => {
        const poolId = String(edge.pool_id || '');
        return !/[#-]rev$/.test(poolId);
      });

      // Sort by liquidity
      forwardEdgesOnly.sort((a, b) => {
        const getLiquidity = (edge: any): number => {
          if (edge.tvl_usd && edge.tvl_usd > 0) return edge.tvl_usd;
          if (edge.liquidity_display && edge.liquidity_display > 0) return edge.liquidity_display;
          if (edge.pool_liquidity_raw && edge.pool_liquidity_raw > 0) return edge.pool_liquidity_raw;
          return 0;
        };
        return getLiquidity(b) - getLiquidity(a);
      });

      // Deduplicate and limit pools
      const poolIds = new Set<string>();
      const topPools: Array<{ poolId: string; edge: any }> = [];
      
      for (const edge of forwardEdgesOnly) {
        if (!edge.pool_id) continue;
        const cleanPoolId = String(edge.pool_id).replace(/-(rev|fwd)$/, '');
        if (poolIds.has(cleanPoolId)) continue;
        poolIds.add(cleanPoolId);
        topPools.push({ poolId: cleanPoolId, edge });
        if (topPools.length >= maxPoolsTotal) break;
      }

      if (topPools.length === 0) {
        try {
          logger.warn('alt.manager.createDexPoolAlts.no.pools', {
            cat: 'tx',
            ctx: { dex, maxPoolsTotal },
          });
        } catch {}
        return result;
      }

      // Calculate how many pools can fit per ALT
      const accountsPerPool = ACCOUNTS_PER_POOL[dex] || 10;
      const poolsPerAlt = Math.floor(MAX_ACCOUNTS_PER_ALT / accountsPerPool);

      // Load existing config
      const config = await loadAltConfig();
      if (!config.dexAlts) config.dexAlts = {};
      if (!config.poolToAlt) config.poolToAlt = {};

      // Chunk pools into groups for multiple ALTs
      const poolChunks: Array<Array<{ poolId: string; edge: any }>> = [];
      for (let i = 0; i < topPools.length; i += poolsPerAlt) {
        poolChunks.push(topPools.slice(i, i + poolsPerAlt));
      }

      try {
        logger.info('alt.manager.createDexPoolAlts.planning', {
          cat: 'tx',
          ctx: {
            dex,
            totalPools: topPools.length,
            poolsPerAlt,
            altsNeeded: poolChunks.length,
            accountsPerPool,
          },
        });
      } catch {}

      // Create or extend ALTs for each chunk
      for (let i = 0; i < poolChunks.length; i++) {
        const chunk = poolChunks[i];
        const category = `${dex}-pools-${i + 1}`;
        
        // Collect all accounts for this chunk
        const accounts: PublicKey[] = [];
        const chunkPoolIds: string[] = [];
        
        for (const { poolId } of chunk) {
          try {
            const poolAccounts = await this.collectPoolSpecificAccounts(poolId, dex);
            accounts.push(...poolAccounts);
            chunkPoolIds.push(poolId);
          } catch (e) {
            try {
              logger.warn('alt.manager.createDexPoolAlts.pool.error', {
                cat: 'tx',
                ctx: { poolId, dex, error: String((e as any)?.message || e) },
              });
            } catch {}
          }
        }

        if (accounts.length === 0) continue;

        // Deduplicate accounts within this chunk
        const seen = new Set<string>();
        const dedupedAccounts = accounts.filter(pk => {
          const addr = pk.toBase58();
          if (seen.has(addr)) return false;
          seen.add(addr);
          return true;
        });

        // Check if ALT already exists for this category
        let altAddress: string;
        const existingAlt = this.altAddresses.get(category);
        
        if (existingAlt) {
          // Extend existing ALT
          try {
            await this.extendAlt(category, dedupedAccounts);
            altAddress = existingAlt.toBase58();
          } catch (e) {
            // If extend fails, try creating new
            try {
              const address = await this.createAltOnChain(wallet, dedupedAccounts, category);
              altAddress = address.toBase58();
              this.altAddresses.set(category, address);
            } catch (createErr) {
              try {
                logger.error('alt.manager.createDexPoolAlts.create.failed', {
                  cat: 'tx',
                  ctx: { category, error: String((createErr as any)?.message || createErr) },
                });
              } catch {}
              continue;
            }
          }
        } else {
          // Create new ALT
          try {
            const address = await this.createAltOnChain(wallet, dedupedAccounts, category);
            altAddress = address.toBase58();
            this.altAddresses.set(category, address);
          } catch (e) {
            try {
              logger.error('alt.manager.createDexPoolAlts.create.failed', {
                cat: 'tx',
                ctx: { category, error: String((e as any)?.message || e) },
              });
            } catch {}
            continue;
          }
        }

        // Update result
        result.addresses.push(altAddress);
        result.altContents[altAddress] = chunkPoolIds;
        result.totalPools += chunkPoolIds.length;
        result.totalAccounts += dedupedAccounts.length;

        // Update poolToAlt mapping
        for (const poolId of chunkPoolIds) {
          config.poolToAlt![poolId] = altAddress;
        }

        try {
          logger.info('alt.manager.createDexPoolAlts.alt.created', {
            cat: 'tx',
            ctx: {
              category,
              altAddress: altAddress.slice(0, 8) + '...',
              poolCount: chunkPoolIds.length,
              accountCount: dedupedAccounts.length,
            },
          });
        } catch {}
      }

      // Save updated config
      config.dexAlts![dex] = result;
      await saveAltConfig(config);

      // Refresh ALT cache
      await this.preloadAllAltAccounts();

      try {
        logger.info('alt.manager.createDexPoolAlts.complete', {
          cat: 'tx',
          ctx: {
            dex,
            altsCreated: result.addresses.length,
            totalPools: result.totalPools,
            totalAccounts: result.totalAccounts,
          },
        });
      } catch {}

      return result;
    } catch (error) {
      try {
        logger.error('alt.manager.createDexPoolAlts.error', {
          cat: 'tx',
          ctx: {
            dex,
            maxPoolsTotal,
            error: String((error as any)?.message || error),
          },
        });
      } catch {}
      return result;
    }
  }

  /**
   * Parse Raydium CLMM pool accounts
   */
  private async parseRaydiumClmmAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Import Raydium SDK
      const sdk = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
      if (!sdk || !poolInfo?.data) return accounts;

      // Find the CLMM layout
      const layout =
        (sdk as any)?.PoolInfoLayout ||
        (sdk as any)?.Clmm?.PoolInfoLayout ||
        (sdk as any)?.Clmm?.PoolStateLayout ||
        (sdk as any)?.CLMM?.POOL_STATE_LAYOUT ||
        (sdk as any)?.PoolStateLayout;

      if (!layout || typeof layout.decode !== 'function') return accounts;

      // Decode pool state
      const state = layout.decode(poolInfo.data);
      if (!state) return accounts;

      // Helper to convert to PublicKey
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          if (typeof v?.toBase58 === 'function') return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // Extract all accounts from pool state
      const vaultA = asPk(state.vaultA || state.tokenVaultA || state.baseVault);
      const vaultB = asPk(state.vaultB || state.tokenVaultB || state.quoteVault);
      const oracle = asPk(state.oracle);
      const ammConfig = asPk(state.ammConfig || state.amm_config);
      const observationId = asPk(state.observationId || state.observation_id || state.observationAccount);

      if (vaultA) accounts.push(vaultA);
      if (vaultB) accounts.push(vaultB);
      if (oracle) accounts.push(oracle);
      if (ammConfig) accounts.push(ammConfig);
      if (observationId) accounts.push(observationId);

      // Add token mints
      const mintA = asPk(state.mintA || state.tokenMintA);
      const mintB = asPk(state.mintB || state.tokenMintB);
      if (mintA) accounts.push(mintA);
      if (mintB) accounts.push(mintB);

      // Note: Tick arrays are calculated dynamically based on current tick
      // and can't be pre-loaded into ALTs since they change
      // The 3 tick arrays (lower, center, upper) will still need to be in the transaction

      try {
        logger.debug('alt.manager.raydium.clmm.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            vaultA: vaultA?.toBase58(),
            vaultB: vaultB?.toBase58(),
            oracle: oracle?.toBase58(),
            ammConfig: ammConfig?.toBase58(),
            mintA: mintA?.toBase58(),
            mintB: mintB?.toBase58(),
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.raydium.clmm.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Raydium AMM pool accounts
   */
  private async parseRaydiumAmmAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Import Raydium SDK
      const sdk = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
      if (!sdk || !poolInfo?.data) return accounts;

      // Find the AMM layout
      const layout =
        (sdk as any)?.LIQUIDITY_STATE_LAYOUT_V4 ||
        (sdk as any)?.AmmV4?.StateLayout ||
        (sdk as any)?.LiquidityStateLayoutV4;

      if (!layout || typeof layout.decode !== 'function') return accounts;

      // Decode pool state
      const state = layout.decode(poolInfo.data);
      if (!state) return accounts;

      // Helper to convert to PublicKey
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          if (typeof v?.toBase58 === 'function') return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // Extract AMM accounts
      const baseVault = asPk(state.baseVault || state.poolCoinTokenAccount);
      const quoteVault = asPk(state.quoteVault || state.poolPcTokenAccount);
      const lpMint = asPk(state.lpMint);
      const baseMint = asPk(state.baseMint || state.coinMint);
      const quoteMint = asPk(state.quoteMint || state.pcMint);
      const authority = asPk(state.authority);
      const targetOrders = asPk(state.targetOrders);
      const openOrders = asPk(state.openOrders);
      const marketId = asPk(state.marketId || state.serumMarket);

      if (baseVault) accounts.push(baseVault);
      if (quoteVault) accounts.push(quoteVault);
      if (lpMint) accounts.push(lpMint);
      if (baseMint) accounts.push(baseMint);
      if (quoteMint) accounts.push(quoteMint);
      if (authority) accounts.push(authority);
      if (targetOrders) accounts.push(targetOrders);
      if (openOrders) accounts.push(openOrders);
      if (marketId) accounts.push(marketId);

      try {
        logger.debug('alt.manager.raydium.amm.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            baseVault: baseVault?.toBase58(),
            quoteVault: quoteVault?.toBase58(),
            marketId: marketId?.toBase58(),
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.raydium.amm.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Orca Whirlpool accounts
   */
  private async parseOrcaWhirlpoolAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      if (!poolInfo?.data) return accounts;

      // Helper to convert to PublicKey
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          if (typeof v?.toBase58 === 'function') return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      let parsed: any = null;
      
      // PRIORITY 1: New @orca-so/whirlpools-client (v4.0)
      try {
        const newClient = await import('@orca-so/whirlpools-client').catch(() => null);
        if (newClient && typeof (newClient as any).getWhirlpoolDecoder === 'function') {
          const decoder = (newClient as any).getWhirlpoolDecoder();
          const dataBuffer = poolInfo.data instanceof Buffer ? new Uint8Array(poolInfo.data) : poolInfo.data;
          const decoded = decoder.decode(dataBuffer);
          if (decoded && decoded.tokenMintA && decoded.tokenMintB) {
            parsed = {
              tokenVaultA: decoded.tokenVaultA,
              tokenVaultB: decoded.tokenVaultB,
              tokenMintA: decoded.tokenMintA,
              tokenMintB: decoded.tokenMintB,
              oracle: decoded.oracle,
              whirlpoolsConfig: decoded.whirlpoolsConfig,
              rewardInfos: decoded.rewardInfos || [],
            };
          }
        }
      } catch {}
      
      // PRIORITY 2: Legacy @orca-so/whirlpools-sdk (v0.16)
      if (!parsed) {
        const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
        if (sdk) {
          const { ParsableWhirlpool } = sdk as any;
          if (ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
            try {
              parsed = ParsableWhirlpool.parse(poolPk, poolInfo);
            } catch {}
          }
        }
      }
      
      if (!parsed) return accounts;

      // Extract whirlpool accounts
      const tokenVaultA = asPk(parsed.tokenVaultA);
      const tokenVaultB = asPk(parsed.tokenVaultB);
      const tokenMintA = asPk(parsed.tokenMintA);
      const tokenMintB = asPk(parsed.tokenMintB);
      const oracle = asPk(parsed.oracle);
      const whirlpoolsConfig = asPk(parsed.whirlpoolsConfig);
      const rewardInfos = Array.isArray(parsed.rewardInfos) ? parsed.rewardInfos : [];

      if (tokenVaultA) accounts.push(tokenVaultA);
      if (tokenVaultB) accounts.push(tokenVaultB);
      if (tokenMintA) accounts.push(tokenMintA);
      if (tokenMintB) accounts.push(tokenMintB);
      if (oracle) accounts.push(oracle);
      if (whirlpoolsConfig) accounts.push(whirlpoolsConfig);

      // Add reward vaults if they exist
      for (const reward of rewardInfos) {
        const rewardVault = asPk(reward?.vault);
        const rewardMint = asPk(reward?.mint);
        if (rewardVault) accounts.push(rewardVault);
        if (rewardMint) accounts.push(rewardMint);
      }

      // Note: Tick arrays are calculated dynamically based on current tick
      // and can't be pre-loaded into ALTs

      try {
        logger.debug('alt.manager.orca.whirlpool.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            tokenVaultA: tokenVaultA?.toBase58(),
            tokenVaultB: tokenVaultB?.toBase58(),
            oracle: oracle?.toBase58(),
            config: whirlpoolsConfig?.toBase58(),
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.orca.whirlpool.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Meteora DLMM pool accounts
   */
  private async parseMeteoraDlmmAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Import Meteora SDK
      let DLMM: any = null;
      try {
        const meteoraModule = await import('@meteora-ag/dlmm');
        DLMM = (meteoraModule as any).DLMM || meteoraModule;
      } catch {
        DLMM = null;
      }
      
      if (!DLMM || !poolInfo?.data) return accounts;

      // Helper to convert to PublicKey
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          if (typeof v?.toBase58 === 'function') return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // The Meteora SDK doesn't export a direct layout decoder like Raydium/Orca
      // But we can derive the key accounts using SDK helper functions
      const programId = poolInfo.owner;

      // Derive reserve accounts
      const deriveReserve = DLMM?.deriveReserve;
      let reserveX: PublicKey | null = null;
      let reserveY: PublicKey | null = null;
      
      if (typeof deriveReserve === 'function') {
        try {
          const rx = await deriveReserve(programId, poolPk, true);
          reserveX = asPk(rx?.publicKey || rx);
        } catch {}
        
        try {
          const ry = await deriveReserve(programId, poolPk, false);
          reserveY = asPk(ry?.publicKey || ry);
        } catch {}
      }

      // Derive oracle
      const deriveOracle = DLMM?.deriveOracle;
      let oracle: PublicKey | null = null;
      if (typeof deriveOracle === 'function') {
        try {
          const orc = await deriveOracle(programId, poolPk);
          oracle = asPk(orc?.publicKey || orc);
        } catch {}
      }

      // Parse pool state using SDK decode (binary offsets are unreliable)
      let tokenXMint: PublicKey | null = null;
      let tokenYMint: PublicKey | null = null;
      let activeId: number | null = null;
      let binStep: number | null = null;

      try {
        // Use createProgram to get proper Anchor coder for decoding
        const { createProgram } = await import('@meteora-ag/dlmm');
        const connection = getConnection();
        const program = createProgram(connection);
        
        if (program?.coder?.accounts?.decode) {
          const state = program.coder.accounts.decode('lbPair', poolInfo.data);
          if (state) {
            // Extract fields from SDK-decoded state (authoritative source)
            activeId = Number(state.activeId ?? state.active_id);
            binStep = Number(state.binStep ?? state.bin_step);
            tokenXMint = asPk(state.tokenXMint);
            tokenYMint = asPk(state.tokenYMint);
          }
        }
      } catch {
        // SDK decode failed - leave values as null
        // This is acceptable since bin arrays are optional for ALT
      }

      if (reserveX) accounts.push(reserveX);
      if (reserveY) accounts.push(reserveY);
      if (oracle) accounts.push(oracle);
      if (tokenXMint) accounts.push(tokenXMint);
      if (tokenYMint) accounts.push(tokenYMint);

      // NOTE: Bitmap extension is NOT added to ALT - the Meteora SDK handles it automatically
      // We previously derived and checked for bitmap extension to add to ALT, but this is
      // unnecessary. The SDK includes the correct bitmap extension PDA when building swap
      // instructions, and it doesn't need to be in the ALT for the transaction to work.

      // NOTE: Bin arrays are NOT added to ALT - they are position-dependent and change frequently
      // as the active bin moves. Including them would:
      // 1. Blow up ALT size (11 bin arrays per pool × many pools = hundreds of entries)
      // 2. Become stale quickly as prices move and active bins shift
      // 3. Require constant ALT updates/extensions
      // The transaction builder will include the necessary bin arrays dynamically based on
      // the current active bin at swap time.

      try {
        logger.debug('alt.manager.meteora.dlmm.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            reserveX: reserveX?.toBase58(),
            reserveY: reserveY?.toBase58(),
            oracle: oracle?.toBase58(),
            tokenXMint: tokenXMint?.toBase58(),
            tokenYMint: tokenYMint?.toBase58(),
            activeId,
            binStep,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.meteora.dlmm.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Meteora Balanced AMM pool accounts
   */
  private async parseMeteoraBalancedAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Meteora Balanced pools have a different structure
      // Similar to standard AMM pools with reserves, authority, etc.
      if (!poolInfo?.data || poolInfo.data.length < 100) return accounts;

      const data = poolInfo.data;
      
      // Helper to convert to PublicKey
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // Try to parse accounts from data (offsets are approximate)
      try {
        // Token A mint
        const tokenAMint = asPk(data.slice(8, 40));
        if (tokenAMint) accounts.push(tokenAMint);
      } catch {}

      try {
        // Token B mint
        const tokenBMint = asPk(data.slice(40, 72));
        if (tokenBMint) accounts.push(tokenBMint);
      } catch {}

      try {
        // Reserve A
        const reserveA = asPk(data.slice(72, 104));
        if (reserveA) accounts.push(reserveA);
      } catch {}

      try {
        // Reserve B
        const reserveB = asPk(data.slice(104, 136));
        if (reserveB) accounts.push(reserveB);
      } catch {}

      try {
        // LP mint
        const lpMint = asPk(data.slice(136, 168));
        if (lpMint) accounts.push(lpMint);
      } catch {}

      try {
        logger.debug('alt.manager.meteora.balanced.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            accountCount: accounts.length,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.meteora.balanced.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Raydium CPMM (Constant Product AMM) pool accounts
   * Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
   */
  private async parseRaydiumCpmmAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      // Require at least 264 bytes (last slice goes to offset 264)
      if (!poolInfo?.data || poolInfo.data.length < 264) return accounts;

      const data = poolInfo.data;
      const dataLen = data.length;
      
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          // Ensure we have exactly 32 bytes for a valid public key
          if (Buffer.isBuffer(v) && v.length !== 32) return null;
          if (v instanceof Uint8Array && v.length !== 32) return null;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };
      
      // Safe slice helper with bounds checking
      const safeSlice = (start: number, end: number): Buffer | null => {
        if (start < 0 || end > dataLen || start >= end) return null;
        try {
          return data.slice(start, end);
        } catch {
          return null;
        }
      };

      // CPMM pool layout (approximate offsets)
      // The structure includes: amm_config, creator, token0_mint, token1_mint,
      // token0_vault, token1_vault, observation_key, lp_mint

      try {
        // AMM config
        const slice = safeSlice(8, 40);
        if (slice) {
          const ammConfig = asPk(slice);
          if (ammConfig) accounts.push(ammConfig);
        }
      } catch {}

      try {
        // Token 0 mint
        const slice = safeSlice(72, 104);
        if (slice) {
          const token0Mint = asPk(slice);
          if (token0Mint) accounts.push(token0Mint);
        }
      } catch {}

      try {
        // Token 1 mint
        const slice = safeSlice(104, 136);
        if (slice) {
          const token1Mint = asPk(slice);
          if (token1Mint) accounts.push(token1Mint);
        }
      } catch {}

      try {
        // Token 0 vault
        const slice = safeSlice(136, 168);
        if (slice) {
          const token0Vault = asPk(slice);
          if (token0Vault) accounts.push(token0Vault);
        }
      } catch {}

      try {
        // Token 1 vault
        const slice = safeSlice(168, 200);
        if (slice) {
          const token1Vault = asPk(slice);
          if (token1Vault) accounts.push(token1Vault);
        }
      } catch {}

      try {
        // LP mint
        const slice = safeSlice(200, 232);
        if (slice) {
          const lpMint = asPk(slice);
          if (lpMint) accounts.push(lpMint);
        }
      } catch {}

      try {
        // Observation key
        const slice = safeSlice(232, 264);
        if (slice) {
          const observation = asPk(slice);
          if (observation) accounts.push(observation);
        }
      } catch {}

      try {
        logger.debug('alt.manager.raydium.cpmm.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            accountCount: accounts.length,
            dataLength: dataLen,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.raydium.cpmm.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Meteora Dynamic AMM (DAMM) pool accounts
   * Supports both v1 (Dynamic AMM) and v2 (CP-AMM)
   */
  private async parseMeteoraDammAccounts(
    poolPk: PublicKey,
    poolInfo: any,
    version: 'v1' | 'v2'
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      if (!poolInfo?.data || poolInfo.data.length < 100) return accounts;

      const data = poolInfo.data;
      
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // DAMM pool layout (approximate offsets, may vary by version)
      // Includes: token_a_mint, token_b_mint, token_a_vault, token_b_vault, lp_mint

      try {
        // Token A mint
        const tokenAMint = asPk(data.slice(8, 40));
        if (tokenAMint) accounts.push(tokenAMint);
      } catch {}

      try {
        // Token B mint
        const tokenBMint = asPk(data.slice(40, 72));
        if (tokenBMint) accounts.push(tokenBMint);
      } catch {}

      try {
        // Token A vault
        const tokenAVault = asPk(data.slice(72, 104));
        if (tokenAVault) accounts.push(tokenAVault);
      } catch {}

      try {
        // Token B vault
        const tokenBVault = asPk(data.slice(104, 136));
        if (tokenBVault) accounts.push(tokenBVault);
      } catch {}

      try {
        // LP mint
        const lpMint = asPk(data.slice(136, 168));
        if (lpMint) accounts.push(lpMint);
      } catch {}

      // V2 may have additional config accounts
      if (version === 'v2') {
        try {
          // Protocol fee vault or similar
          const configAccount = asPk(data.slice(168, 200));
          if (configAccount) accounts.push(configAccount);
        } catch {}
      }

      try {
        logger.debug(`alt.manager.meteora.damm.${version}.parsed`, {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            version,
            accountCount: accounts.length,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug(`alt.manager.meteora.damm.${version}.parse.failed`, {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), version, error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Parse Pumpswap (post-graduation AMM) pool accounts
   * Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
   */
  private async parsePumpswapAccounts(
    poolPk: PublicKey,
    poolInfo: any
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    
    try {
      if (!poolInfo?.data || poolInfo.data.length < 100) return accounts;

      const data = poolInfo.data;
      
      const asPk = (v: any): PublicKey | null => {
        try {
          if (!v) return null;
          if (v instanceof PublicKey) return v;
          return new PublicKey(v);
        } catch {
          return null;
        }
      };

      // Pumpswap pool layout (approximate offsets)
      // Simple AMM structure: base_mint, quote_mint, base_vault, quote_vault

      try {
        // Base mint (usually the graduated token)
        const baseMint = asPk(data.slice(8, 40));
        if (baseMint) accounts.push(baseMint);
      } catch {}

      try {
        // Quote mint (usually SOL wrapped)
        const quoteMint = asPk(data.slice(40, 72));
        if (quoteMint) accounts.push(quoteMint);
      } catch {}

      try {
        // Base vault
        const baseVault = asPk(data.slice(72, 104));
        if (baseVault) accounts.push(baseVault);
      } catch {}

      try {
        // Quote vault
        const quoteVault = asPk(data.slice(104, 136));
        if (quoteVault) accounts.push(quoteVault);
      } catch {}

      try {
        logger.debug('alt.manager.pumpswap.parsed', {
          cat: 'tx',
          ctx: {
            pool: poolPk.toBase58(),
            accountCount: accounts.length,
          },
        });
      } catch {}
    } catch (error) {
      try {
        logger.debug('alt.manager.pumpswap.parse.failed', {
          cat: 'tx',
          ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return accounts;
  }

  /**
   * Get ALT addresses for a transaction
   * Returns addresses that should be used based on the accounts in the transaction
   * @param accounts - Accounts used in the transaction
   * @param forceMultiHop - Force using ALTs even if account count is low
   * @param dexCategories - Optional set of DEX categories to filter ALTs (e.g., 'raydium-clmm', 'orca-whirlpool')
   */
  async getAltAddresses(
    accounts: (PublicKey | string)[],
    forceMultiHop: boolean = false,
    dexCategories?: Set<string>
  ): Promise<string[]> {
    await this.initialize();

    const addresses: string[] = [];

    // Always use ALTs for multi-hop or if we have many accounts
    // Lower threshold: CLMM swaps typically have 15+ accounts per instruction
    if (forceMultiHop || accounts.length > 15) {
      // If specific DEX categories are provided, only include those ALTs
      if (dexCategories && dexCategories.size > 0) {
        // Always include common ALT if it exists
        const commonAddr = this.altAddresses.get('common');
        if (commonAddr) {
          addresses.push(commonAddr.toBase58());
        }
        
        // Only add ALTs for the specified DEX categories
        for (const category of dexCategories) {
          const addr = this.altAddresses.get(category);
          if (addr) {
            addresses.push(addr.toBase58());
          }
        }
      } else {
        // Fallback: include all ALTs (backward compatible)
        for (const addr of this.altAddresses.values()) {
          addresses.push(addr.toBase58());
        }
      }
      
      try {
        logger.info('alt.manager.using_alts', {
          cat: 'tx',
          ctx: {
            accountCount: accounts.length,
            forceMultiHop,
            altCount: addresses.length,
            categories: dexCategories ? Array.from(dexCategories) : 'all',
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
        if (dexCategories && dexCategories.size > 0) {
          // Filter by DEX categories if provided
          const commonAddr = this.altAddresses.get('common');
          if (commonAddr) {
            addresses.push(commonAddr.toBase58());
          }
          for (const category of dexCategories) {
            const addr = this.altAddresses.get(category);
            if (addr) {
              addresses.push(addr.toBase58());
            }
          }
        } else {
          // Use all configured ALTs
          for (const addr of this.altAddresses.values()) {
            addresses.push(addr.toBase58());
          }
        }
        try {
          logger.info('alt.manager.using_config_alts', {
            cat: 'tx',
            ctx: {
              accountCount: accounts.length,
              altCount: addresses.length,
              categories: dexCategories ? Array.from(dexCategories) : 'all',
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
            requestedCategories: dexCategories ? Array.from(dexCategories) : undefined,
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
        const result = await withRpcLimit(
          () => connection.getAddressLookupTable(pk),
          1,
          { module: 'alt', method: 'getAddressLookupTable' }
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
   * Pre-load all registered ALTs into memory cache
   * Called at startup to avoid RPC calls during transaction building
   * Uses batchLoadAlts for proper rate limiting to avoid 429s
   */
  async preloadAllAltAccounts(): Promise<{ loaded: number; failed: number }> {
    const addresses = this.getAllAltAddresses();

    if (addresses.length === 0) {
      return { loaded: 0, failed: 0 };
    }

    // Use batchLoadAlts which has proper rate limiting built in
    const loadedAlts = await this.batchLoadAlts(addresses);

    // Update the cache with loaded ALTs
    let loaded = 0;
    let failed = 0;

    for (const addr of addresses) {
      const altAccount = loadedAlts.get(addr);
      if (altAccount) {
        this.altAccounts.set(addr, altAccount);
        loaded++;
      } else {
        failed++;
      }
    }

    try {
      logger.debug('alt.manager.preload.complete', {
        cat: 'tx',
        ctx: {
          loaded,
          failed,
          totalAddresses: addresses.length,
          cachedAccountCount: Array.from(this.altAccounts.values())
            .reduce((sum, alt) => sum + alt.state.addresses.length, 0),
        },
      });
    } catch {}

    return { loaded, failed };
  }

  /**
   * Get cached ALT accounts directly - NO RPC calls
   * Returns empty array if cache is cold (should never happen after startup)
   */
  getCachedAltAccounts(): AddressLookupTableAccount[] {
    return Array.from(this.altAccounts.values());
  }

  /**
   * Check if ALT cache is warm (has accounts loaded)
   */
  isCacheWarm(): boolean {
    return this.altAccounts.size > 0;
  }

  /**
   * Get cached ALT account by address - NO RPC calls
   * @param address ALT address as string
   * @returns AddressLookupTableAccount if cached, undefined otherwise
   */
  getCachedAltByAddress(address: string): AddressLookupTableAccount | undefined {
    return this.altAccounts.get(address);
  }

  /**
   * Add an ALT to the cache (for on-demand loading)
   * @param address ALT address as string
   * @param account The AddressLookupTableAccount to cache
   */
  addAltToCache(address: string, account: AddressLookupTableAccount): void {
    this.altAccounts.set(address, account);
    // Also add to altAddresses if not present
    if (!Array.from(this.altAddresses.values()).some(pk => pk.toBase58() === address)) {
      this.altAddresses.set(`cached-${Date.now()}-${address.slice(0, 8)}`, account.key);
    }
  }

  /**
   * Get ALT address for a specific pool (O(1) lookup)
   * Uses the poolToAlt mapping from config
   * @param poolId Pool address (will strip -rev/-fwd suffix)
   * @returns ALT address string if found, undefined otherwise
   */
  async getAltForPool(poolId: string): Promise<string | undefined> {
    const config = await loadAltConfig();
    if (!config.poolToAlt) return undefined;
    
    // Strip directional suffixes for consistent lookup
    const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
    return config.poolToAlt[cleanPoolId];
  }

  /**
   * Get ALT addresses for multiple pools
   * Returns unique ALT addresses needed for a route
   * @param poolIds Array of pool addresses
   * @returns Array of unique ALT addresses
   */
  async getAltsForPools(poolIds: string[]): Promise<string[]> {
    const config = await loadAltConfig();
    if (!config.poolToAlt) return [];
    
    const altAddresses = new Set<string>();
    
    for (const poolId of poolIds) {
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      const altAddress = config.poolToAlt[cleanPoolId];
      if (altAddress) {
        altAddresses.add(altAddress);
      }
    }
    
    return Array.from(altAddresses);
  }

  /**
   * Update pool-to-ALT mapping for a single pool
   * @param poolId Pool address
   * @param altAddress ALT address containing this pool's accounts
   */
  async updatePoolToAltMapping(poolId: string, altAddress: string): Promise<void> {
    const config = await loadAltConfig();
    if (!config.poolToAlt) {
      config.poolToAlt = {};
    }
    
    const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
    config.poolToAlt[cleanPoolId] = altAddress;
    await saveAltConfig(config);
  }

  /**
   * Update pool-to-ALT mappings for multiple pools
   * @param mappings Record of poolId -> altAddress
   */
  async updatePoolToAltMappingBatch(mappings: Record<string, string>): Promise<void> {
    const config = await loadAltConfig();
    if (!config.poolToAlt) {
      config.poolToAlt = {};
    }
    
    for (const [poolId, altAddress] of Object.entries(mappings)) {
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      config.poolToAlt[cleanPoolId] = altAddress;
    }
    
    await saveAltConfig(config);
  }

  /**
   * Get all pools tracked in the poolToAlt mapping
   * @returns Array of pool IDs that have ALT mappings
   */
  async getTrackedPools(): Promise<string[]> {
    const config = await loadAltConfig();
    if (!config.poolToAlt) return [];
    return Object.keys(config.poolToAlt);
  }

  /**
   * Check if a pool is covered by any ALT
   * @param poolId Pool address
   * @returns true if pool is in poolToAlt mapping
   */
  async isPoolCovered(poolId: string): Promise<boolean> {
    const alt = await this.getAltForPool(poolId);
    return alt !== undefined;
  }

  /**
   * Get ALT coverage statistics for a route
   * @param poolIds Array of pool addresses in the route
   * @returns Coverage info including percentage and missing pools
   */
  async getRouteCoverage(poolIds: string[]): Promise<{
    coverage: number;
    coveredPools: string[];
    missingPools: string[];
    altAddresses: string[];
  }> {
    const config = await loadAltConfig();
    
    const coveredPools: string[] = [];
    const missingPools: string[] = [];
    const altAddresses = new Set<string>();
    
    for (const poolId of poolIds) {
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      const altAddress = config.poolToAlt?.[cleanPoolId];
      
      if (altAddress) {
        coveredPools.push(cleanPoolId);
        altAddresses.add(altAddress);
      } else {
        missingPools.push(cleanPoolId);
      }
    }
    
    const coverage = poolIds.length > 0 
      ? coveredPools.length / poolIds.length 
      : 0;
    
    return {
      coverage,
      coveredPools,
      missingPools,
      altAddresses: Array.from(altAddresses),
    };
  }

  private backgroundRefreshInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start background refresh of ALT cache
   * @param intervalMs - Refresh interval in milliseconds (default: 60 seconds)
   */
  startBackgroundRefresh(intervalMs: number = 60000): void {
    // Clear any existing interval
    if (this.backgroundRefreshInterval) {
      clearInterval(this.backgroundRefreshInterval);
    }

    this.backgroundRefreshInterval = setInterval(async () => {
      try {
        await this.preloadAllAltAccounts();
      } catch (e) {
        try {
          logger.warn('alt.manager.background.refresh.error', {
            cat: 'tx',
            ctx: { error: String((e as any)?.message || e) },
          });
        } catch {}
      }
    }, intervalMs);

    try {
      logger.info('alt.manager.background.refresh.started', {
        cat: 'tx',
        ctx: { intervalMs },
      });
    } catch {}
  }

  /**
   * Stop background refresh
   */
  stopBackgroundRefresh(): void {
    if (this.backgroundRefreshInterval) {
      clearInterval(this.backgroundRefreshInterval);
      this.backgroundRefreshInterval = null;
    }
  }

  /**
   * Extend an existing ALT with additional accounts
   * @param category Category/key of the ALT (e.g., 'common', 'pools', 'tokens')
   * @param accounts Array of account addresses (strings or PublicKeys) to add
   * @returns Transaction signature of the extend transaction
   */
  async extendAlt(
    category: string,
    accounts: (string | PublicKey)[]
  ): Promise<{ signature: string; address: string; accountCount: number }> {
    const connection = getConnection();
    
    // Get the ALT address
    const altPk = this.altAddresses.get(category);
    if (!altPk) {
      throw new Error(`ALT with category "${category}" not found. Available categories: ${Array.from(this.altAddresses.keys()).join(', ')}`);
    }

    // Get wallet
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);

    // Convert accounts to PublicKeys
    const accountPks = accounts.map(acc => typeof acc === 'string' ? new PublicKey(acc) : acc);

    // Check current ALT state
    const result = await withRpcLimit(
      () => connection.getAddressLookupTable(altPk),
      1,
      { module: 'alt', method: 'getAddressLookupTable' }
    ).catch(() => ({ value: null }));

    if (!result.value) {
      throw new Error(`ALT ${altPk.toBase58()} not found on-chain`);
    }

    const currentCount = result.value.state?.addresses?.length || 0;
    const remainingCapacity = 256 - currentCount;

    if (accountPks.length > remainingCapacity) {
      throw new Error(`ALT has ${remainingCapacity} remaining capacity, but ${accountPks.length} accounts requested`);
    }

    // Filter out accounts that are already in the ALT
    const existingAddresses = new Set(
      (result.value.state?.addresses || []).map(addr => addr.toBase58())
    );
    const newAccounts = accountPks.filter(pk => !existingAddresses.has(pk.toBase58()));

    if (newAccounts.length === 0) {
      return {
        signature: '',
        address: altPk.toBase58(),
        accountCount: currentCount,
      };
    }

    // Extend the ALT
    const signature = await this.extendLookupTable(wallet, altPk, newAccounts);

    // Refresh cache
    this.altAccounts.delete(altPk.toBase58());

    try {
      logger.info('alt.manager.extended.public', {
        cat: 'tx',
        ctx: {
          category,
          address: altPk.toBase58(),
          accountsAdded: newAccounts.length,
          totalAccounts: currentCount + newAccounts.length,
          signature,
        },
      });
    } catch {}

    return {
      signature,
      address: altPk.toBase58(),
      accountCount: currentCount + newAccounts.length,
    };
  }

  /**
   * Create a new ALT and extend it with accounts
   * @param category Category/key for the ALT (e.g., 'common', 'pools', 'tokens')
   * @param accounts Array of account addresses to add
   * @param seed Optional seed for deterministic address derivation
   * @returns The created ALT address and account count
   */
  async createAndExtendAlt(
    category: string,
    accounts: (string | PublicKey)[],
    seed?: string
  ): Promise<{ address: string; accountCount: number }> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);

    const accountPks = accounts.map(acc => typeof acc === 'string' ? new PublicKey(acc) : acc);
    
    // Use category as the seed directly (no -alt suffix) to avoid duplicates
    const altSeed = seed || category;

    // Check if ALT already exists for this category
    if (this.altAddresses.has(category)) {
      throw new Error(`ALT with category "${category}" already exists. Use extendAlt() instead.`);
    }

    // Create and extend the ALT
    const address = await this.createAltOnChain(wallet, accountPks, altSeed);

    // Get the account count
    const connection = getConnection();
    const result = await withRpcLimit(
      () => connection.getAddressLookupTable(address),
      1,
      { module: 'alt-create', method: 'getAddressLookupTable' }
    ).catch(() => ({ value: null }));

    const accountCount = result.value?.state?.addresses?.length || 0;

    // CRITICAL: Add to our tracking map immediately
    // Only store under the category, not the seed (to avoid duplicates)
    this.altAddresses.set(category, address);

    // Save to config
    try {
      this.altConfig = await loadAltConfig();
      if (!this.altConfig.alts) {
        this.altConfig.alts = {};
      }
      this.altConfig.alts[category as keyof typeof this.altConfig.alts] = address.toBase58();
      this.altConfig.walletPublicKey = wallet.publicKey.toBase58();
      this.altConfig.lastValidated = Date.now();
      await saveAltConfig(this.altConfig);
    } catch (error) {
      try {
        logger.warn('alt.manager.create.save.config.failed', {
          cat: 'tx',
          ctx: { category, address: address.toBase58(), error: String((error as any)?.message || error) },
        });
      } catch {}
    }

    return {
      address: address.toBase58(),
      accountCount,
    };
  }

  /**
   * Collect accounts for a specific category
   * @param category Category type: 'common', 'pools', 'tokens', 'clmm', or 'all'
   * @param options Additional options for collection
   */
  async collectAccountsForCategory(
    category: 'common' | 'pools' | 'tokens' | 'clmm' | 'all',
    options?: {
      includeSystemPrograms?: boolean;
      includeWalletAtas?: boolean;
      maxPoolAccounts?: number;
      maxTokenAccounts?: number;
    }
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const opts = {
      includeSystemPrograms: true,
      includeWalletAtas: true,
      maxPoolAccounts: 50,
      maxTokenAccounts: 20,
      ...options,
    };

    if (category === 'common' || category === 'all') {
      const commonAccounts = await this.collectCommonAccounts();
      accounts.push(...commonAccounts);

      if (opts.includeSystemPrograms) {
        const { SystemProgram, SYSVAR_RENT_PUBKEY } = await import('@solana/web3.js');
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        accounts.push(SystemProgram.programId);
        accounts.push(TOKEN_PROGRAM_ID);
        accounts.push(TOKEN_2022_PROGRAM_ID);
        accounts.push(ASSOCIATED_TOKEN_PROGRAM_ID);
        accounts.push(SYSVAR_RENT_PUBKEY);
      }

      if (opts.includeWalletAtas) {
        try {
          const { ensureWallet } = await import('../../wallet/wallet.js');
          const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
          const wallet = await ensureWallet(CONFIG.walletPath);
          const connection = getConnection();
          const tokenManager = getTokenAccountManager(connection);
          const tokenAccounts = tokenManager.getTokenAccounts();
          
          const commonMints = [
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          ];
          const commonMintSet = new Set(commonMints);
          
          for (const tokenAccount of tokenAccounts.slice(0, opts.maxTokenAccounts)) {
            if (commonMintSet.has(tokenAccount.mint)) {
              accounts.push(new PublicKey(tokenAccount.address));
            }
          }
        } catch {}
      }
    }

    if (category === 'pools' || category === 'all') {
      const poolAccounts = await this.collectPoolAccounts();
      accounts.push(...poolAccounts.slice(0, opts.maxPoolAccounts));
    }

    if (category === 'clmm' || category === 'all') {
      const clmmAccounts = await this.collectClmmAccounts();
      accounts.push(...clmmAccounts);
    }

    // Deduplicate
    const seen = new Set<string>();
    return accounts.filter(pk => {
      const addr = pk.toBase58();
      if (seen.has(addr)) return false;
      seen.add(addr);
      return true;
    });
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

      // 3. Check and validate existing ALTs using BATCH LOADING to avoid 429s
      if (opts.validateExisting) {
        // Collect all ALT addresses for batch loading
        const addressToCategory = new Map<string, string>();
        const dexAddressInfo: Array<{ address: string; dex: string; index: number }> = [];
        
        // Collect from config.alts
        if (this.altConfig.alts) {
          for (const [category, address] of Object.entries(this.altConfig.alts)) {
            if (address) {
              addressToCategory.set(address, category);
            }
          }
        }
        
        // Collect from dexAlts
        if (this.altConfig.dexAlts) {
          for (const [dex, dexAltSet] of Object.entries(this.altConfig.dexAlts)) {
            if (!dexAltSet?.addresses) continue;
            for (let i = 0; i < dexAltSet.addresses.length; i++) {
              const address = dexAltSet.addresses[i];
              if (address && !addressToCategory.has(address)) {
                dexAddressInfo.push({ address, dex, index: i });
              }
            }
          }
        }
        
        const allAddresses = [
          ...Array.from(addressToCategory.keys()),
          ...dexAddressInfo.map(d => d.address),
        ];
        
        try {
          logger.info('alt.startup.batch.validation.start', {
            cat: 'tx',
            ctx: {
              totalAlts: allAddresses.length,
              fromConfig: addressToCategory.size,
              fromDexAlts: dexAddressInfo.length,
            },
          });
        } catch {}
        
        // Batch load all ALTs
        const loadedAlts = await this.batchLoadAlts(allAddresses);
        
        // Process results for config.alts
        const invalidCategories: string[] = [];
        for (const [address, category] of addressToCategory) {
          const altAccount = loadedAlts.get(address);
          if (altAccount) {
            const accountCount = altAccount.state?.addresses?.length || 0;
            if (accountCount > 0) {
              this.altAddresses.set(category, new PublicKey(address));
              this.altAccounts.set(address, altAccount);
              results[category] = address;
              try {
                logger.info('alt.startup.validated', {
                  cat: 'tx',
                  ctx: { category, address, accountCount },
                });
              } catch {}
            } else {
              errors.push(`ALT ${category} (${address}) is empty`);
              invalidCategories.push(category);
            }
          } else {
            errors.push(`ALT ${category} (${address}) not found on-chain`);
            invalidCategories.push(category);
          }
        }
        
        // Clean up invalid ALTs from config
        if (invalidCategories.length > 0 && this.altConfig.alts) {
          for (const category of invalidCategories) {
            delete this.altConfig.alts[category as keyof typeof this.altConfig.alts];
          }
          await saveAltConfig(this.altConfig);
        }
        
        // Process results for dexAlts
        let dexAltCount = 0;
        for (const { address, dex, index } of dexAddressInfo) {
          // Skip if already in config.alts
          if (this.altAccounts.has(address)) {
            dexAltCount++;
            continue;
          }
          
          const altAccount = loadedAlts.get(address);
          if (altAccount) {
            const accountCount = altAccount.state?.addresses?.length || 0;
            if (accountCount > 0) {
              // Use 1-based indexing to match createAllDexPoolAlts naming convention
              const category = `${dex}-pools-${index + 1}`;
              this.altAddresses.set(category, altAccount.key);
              this.altAccounts.set(address, altAccount);
              results[category] = address;
              dexAltCount++;
            } else {
              errors.push(`DEX ALT ${dex}[${index + 1}] (${address}) is empty`);
            }
          } else {
            errors.push(`DEX ALT ${dex}[${index + 1}] (${address}) not found on-chain`);
          }
        }
        
        if (dexAltCount > 0) {
          try {
            logger.info('alt.startup.dexAlts.validated', {
              cat: 'tx',
              ctx: { dexAltCount, dexes: Object.keys(this.altConfig.dexAlts || {}) },
            });
          } catch {}
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
                // Save the new ALT to config
                if (!this.altConfig.alts) {
                  this.altConfig.alts = {};
                }
                this.altConfig.alts.common = address.toBase58();
                this.altConfig.walletPublicKey = wallet.publicKey.toBase58();
                this.altConfig.lastValidated = Date.now();
                await saveAltConfig(this.altConfig);
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
                // Save the new ALT to config
                if (!this.altConfig.alts) {
                  this.altConfig.alts = {};
                }
                this.altConfig.alts.pools = address.toBase58();
                this.altConfig.walletPublicKey = wallet.publicKey.toBase58();
                this.altConfig.lastValidated = Date.now();
                await saveAltConfig(this.altConfig);
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
                // Save the new ALT to config
                if (!this.altConfig.alts) {
                  this.altConfig.alts = {};
                }
                this.altConfig.alts.clmm = address.toBase58();
                this.altConfig.walletPublicKey = wallet.publicKey.toBase58();
                this.altConfig.lastValidated = Date.now();
                await saveAltConfig(this.altConfig);
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

      // Pre-load all ALT accounts into cache for instant access during tx building
      // This eliminates RPC calls during transaction building
      try {
        const preloadResult = await this.preloadAllAltAccounts();
        try {
          logger.info('alt.startup.preload.complete', {
            cat: 'tx',
            ctx: {
              ...preloadResult,
              note: 'ALT accounts cached - no RPC calls needed during tx building',
            },
          });
        } catch {}
      } catch (e) {
        errors.push(`Failed to preload ALT accounts: ${String(e)}`);
      }

      // Start background refresh if enabled (default: 30 minutes, 0 = disabled)
      // ALTs rarely change on-chain, so frequent refresh is wasteful
      const altRefreshMs = CONFIG.system?.altRefreshMs ?? 1800_000;
      if (altRefreshMs > 0) {
        this.startBackgroundRefresh(altRefreshMs);
        try {
          logger.info('alt.startup.background_refresh.enabled', {
            cat: 'tx',
            ctx: { intervalMs: altRefreshMs, intervalMinutes: Math.round(altRefreshMs / 60000) },
          });
        } catch {}
      } else {
        try {
          logger.info('alt.startup.background_refresh.disabled', {
            cat: 'tx',
            ctx: { note: 'ALT cache will only refresh on-demand' },
          });
        } catch {}
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
   * Force re-initialization of the ALT manager
   * This is useful after deleting ALTs to clean up stale references
   */
  async forceReinitialize(): Promise<void> {
    // Reset state
    this.initialized = false;
    this.initPromise = null;
    this.altAddresses.clear();
    this.altAccounts.clear();
    
    try {
      logger.info('alt.manager.force.reinit', {
        cat: 'tx',
        ctx: { message: 'Forcing re-initialization to clean up stale ALT references' },
      });
    } catch {}
    
    // Re-initialize
    await this.initialize();
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
      const result = await withRpcLimit(
        () => connection.getAddressLookupTable(pk),
        1,
        { module: 'alt-validate', method: 'getAddressLookupTable' }
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

  /**
   * Discover ALL ALTs owned by the wallet on-chain.
   * This uses getProgramAccounts to find ALTs where the wallet is the authority.
   * Returns ALTs that may not be in our config (orphaned/untracked).
   */
  async discoverWalletAlts(): Promise<{
    address: string;
    accountCount: number;
    isDeactivated: boolean;
    canClose: boolean;
    rentLamports: number;
    rentSOL: string;
    inConfig: boolean;
    category?: string;
  }[]> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    const connection = getConnection();

    try {
      logger.info('alt.manager.discover.start', {
        cat: 'tx',
        ctx: { wallet: wallet.publicKey.toBase58() },
      });
    } catch {}

    // Address Lookup Table Program ID
    const ALT_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
    
    // Authority is at byte offset 22 in the ALT account data
    const AUTHORITY_OFFSET = 22;

    // Get all ALTs where our wallet is the authority
    const accounts = await withRpcLimit(
      () => connection.getProgramAccounts(ALT_PROGRAM_ID, {
        filters: [
          {
            memcmp: {
              offset: AUTHORITY_OFFSET,
              bytes: wallet.publicKey.toBase58(),
            },
          },
        ],
      }),
      5, // Higher weight for heavy getProgramAccounts call
      { module: 'alt-discovery', method: 'getProgramAccounts' }
    );

    try {
      logger.info('alt.manager.discover.found', {
        cat: 'tx',
        ctx: { count: accounts.length },
      });
    } catch {}

    // Build a reverse lookup from address to category
    const addressToCategory = new Map<string, string>();
    for (const [category, pk] of this.altAddresses.entries()) {
      addressToCategory.set(pk.toBase58(), category);
    }

    // Also check altConfig for static ALT addresses (common, flashloan, userPdas)
    const altConfig = this.altConfig || await loadAltConfig();
    if (altConfig.alts) {
      for (const [category, addr] of Object.entries(altConfig.alts)) {
        if (addr && !addressToCategory.has(addr)) {
          addressToCategory.set(addr, category);
        }
      }
    }

    // Also check altConfig for dexAlts addresses
    if (altConfig.dexAlts) {
      for (const [dex, dexAltSet] of Object.entries(altConfig.dexAlts)) {
        if (dexAltSet?.addresses) {
          for (let i = 0; i < dexAltSet.addresses.length; i++) {
            const addr = dexAltSet.addresses[i];
            if (!addressToCategory.has(addr)) {
              addressToCategory.set(addr, `${dex}-pool-${i}`);
            }
          }
        }
      }
    }

    const currentSlot = await withRpcLimit(
      () => connection.getSlot(),
      1,
      { module: 'alt-discovery', method: 'getSlot' }
    );
    const MAX_U64 = BigInt('18446744073709551615');

    const results: {
      address: string;
      accountCount: number;
      isDeactivated: boolean;
      canClose: boolean;
      rentLamports: number;
      rentSOL: string;
      inConfig: boolean;
      category?: string;
    }[] = [];

    for (const { pubkey, account } of accounts) {
      const address = pubkey.toBase58();
      
      // Parse ALT to get account count and deactivation status
      let accountCount = 0;
      let isDeactivated = false;
      let canClose = false;

      try {
        const altAccount = await withRpcLimit(
          () => connection.getAddressLookupTable(pubkey),
          1,
          { module: 'alt-discovery', method: 'getAddressLookupTable' }
        );
        
        if (altAccount.value) {
          accountCount = altAccount.value.state.addresses.length;
          
          const deactivationSlotBigInt = altAccount.value.state.deactivationSlot;
          isDeactivated = deactivationSlotBigInt !== undefined && 
                          deactivationSlotBigInt !== MAX_U64 &&
                          deactivationSlotBigInt < MAX_U64;
          
          if (isDeactivated) {
            const deactivationSlot = Number(deactivationSlotBigInt);
            const slotsSinceDeactivation = currentSlot - deactivationSlot;
            canClose = slotsSinceDeactivation >= 513;
          }
        }
      } catch {}

      const category = addressToCategory.get(address);
      const rentLamports = account.lamports;
      const rentSOL = (rentLamports / 1e9).toFixed(6);

      results.push({
        address,
        accountCount,
        isDeactivated,
        canClose,
        rentLamports,
        rentSOL,
        inConfig: !!category,
        category,
      });
    }

    // Sort: closeable first, then by rent amount (highest first)
    results.sort((a, b) => {
      if (a.canClose && !b.canClose) return -1;
      if (!a.canClose && b.canClose) return 1;
      if (a.isDeactivated && !b.isDeactivated) return -1;
      if (!a.isDeactivated && b.isDeactivated) return 1;
      return b.rentLamports - a.rentLamports;
    });

    try {
      logger.info('alt.manager.discover.complete', {
        cat: 'tx',
        ctx: {
          total: results.length,
          inConfig: results.filter(r => r.inConfig).length,
          orphaned: results.filter(r => !r.inConfig).length,
          deactivated: results.filter(r => r.isDeactivated).length,
          closeable: results.filter(r => r.canClose).length,
          totalRentSOL: results.reduce((sum, r) => sum + r.rentLamports, 0) / 1e9,
        },
      });
    } catch {}

    return results;
  }

  /**
   * Deactivate an ALT by address (for orphaned ALTs not in config)
   */
  async deactivateAltByAddress(altAddress: string): Promise<{ signature: string }> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    const connection = getConnection();

    const altPk = new PublicKey(altAddress);

    try {
      logger.info('alt.manager.deactivateByAddress.start', {
        cat: 'tx',
        ctx: { altAddress },
      });
    } catch {}

    const deactivateIx = AddressLookupTableProgram.deactivateLookupTable({
      lookupTable: altPk,
      authority: wallet.publicKey,
    });

    const tx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.add(deactivateIx);
    const { blockhash } = await withRpcLimit(
      () => connection.getLatestBlockhash(),
      1,
      { module: 'alt-deactivate', method: 'getLatestBlockhash' }
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(
      () => connection.sendRawTransaction(tx.serialize()),
      2,
      { module: 'alt-deactivate', method: 'sendRawTransaction' }
    );
    await withRpcLimit(
      () => connection.confirmTransaction(signature, 'confirmed'),
      2,
      { module: 'alt-deactivate', method: 'confirmTransaction' }
    );

    try {
      logger.info('alt.manager.deactivateByAddress.ok', {
        cat: 'tx',
        ctx: { altAddress, signature },
      });
    } catch {}

    return { signature };
  }

  /**
   * Close an ALT by address (for orphaned ALTs not in config)
   */
  async closeAltByAddress(altAddress: string): Promise<{ signature: string; rentRecovered: number }> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    const connection = getConnection();

    const altPk = new PublicKey(altAddress);

    // Verify ALT is closeable
    const altAccount = await withRpcLimit(
      () => connection.getAddressLookupTable(altPk),
      1,
      { module: 'alt-close', method: 'getAddressLookupTable' }
    );
    if (!altAccount.value) {
      throw new Error(`ALT not found: ${altAddress}`);
    }

    const MAX_U64 = BigInt('18446744073709551615');
    const deactivationSlotBigInt = altAccount.value.state.deactivationSlot;
    const isDeactivated = deactivationSlotBigInt !== undefined && 
                          deactivationSlotBigInt !== MAX_U64 &&
                          deactivationSlotBigInt < MAX_U64;

    if (!isDeactivated) {
      throw new Error(`ALT is not deactivated. Deactivate first and wait ~5 minutes.`);
    }

    const currentSlot = await withRpcLimit(
      () => connection.getSlot(),
      1,
      { module: 'alt-close', method: 'getSlot' }
    );
    const slotsSinceDeactivation = currentSlot - Number(deactivationSlotBigInt);
    if (slotsSinceDeactivation < 513) {
      const minutesLeft = Math.ceil((513 - slotsSinceDeactivation) * 0.4 / 60);
      throw new Error(`ALT not ready to close. Wait ~${minutesLeft} more minutes.`);
    }

    // Get rent amount before closing
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(altPk),
      1,
      { module: 'alt-close', method: 'getAccountInfo' }
    );
    const rentRecovered = accountInfo?.lamports || 0;

    try {
      logger.info('alt.manager.closeByAddress.start', {
        cat: 'tx',
        ctx: { altAddress, rentRecovered },
      });
    } catch {}

    const closeIx = AddressLookupTableProgram.closeLookupTable({
      lookupTable: altPk,
      authority: wallet.publicKey,
      recipient: wallet.publicKey,
    });

    const tx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.add(closeIx);
    const { blockhash } = await withRpcLimit(
      () => connection.getLatestBlockhash(),
      1,
      { module: 'alt-close', method: 'getLatestBlockhash' }
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(
      () => connection.sendRawTransaction(tx.serialize()),
      2,
      { module: 'alt-close', method: 'sendRawTransaction' }
    );
    await withRpcLimit(
      () => connection.confirmTransaction(signature, 'confirmed'),
      2,
      { module: 'alt-close', method: 'confirmTransaction' }
    );

    try {
      logger.info('alt.manager.closeByAddress.ok', {
        cat: 'tx',
        ctx: { altAddress, signature, rentRecoveredSOL: rentRecovered / 1e9 },
      });
    } catch {}

    // Clean up in-memory state and config after successful close
    await this.removeAltFromStateAndConfig(altAddress);

    return { signature, rentRecovered };
  }

  /**
   * Remove an ALT from in-memory state and config file.
   * Called after successfully closing an ALT on-chain.
   */
  private async removeAltFromStateAndConfig(altAddress: string): Promise<void> {
    let removedCategory: string | null = null;

    // 1. Remove from altAddresses map (find category by address)
    for (const [category, pk] of this.altAddresses.entries()) {
      if (pk.toBase58() === altAddress) {
        this.altAddresses.delete(category);
        removedCategory = category;
        break;
      }
    }

    // 2. Remove from altAccounts cache
    this.altAccounts.delete(altAddress);

    // 3. Remove from config file
    if (this.altConfig) {
      let configChanged = false;

      // Check config.alts (common, flashloan, userPdas, etc.)
      if (this.altConfig.alts) {
        for (const [key, addr] of Object.entries(this.altConfig.alts)) {
          if (addr === altAddress) {
            delete this.altConfig.alts[key as keyof typeof this.altConfig.alts];
            configChanged = true;
            if (!removedCategory) removedCategory = key;
          }
        }
      }

      // Check dexAlts (raydium, orca, etc.)
      if (this.altConfig.dexAlts) {
        for (const [dex, dexAltSet] of Object.entries(this.altConfig.dexAlts)) {
          if (dexAltSet?.addresses) {
            const idx = dexAltSet.addresses.indexOf(altAddress);
            if (idx !== -1) {
              dexAltSet.addresses.splice(idx, 1);
              // Also clean up altContents if it references this address
              if (dexAltSet.altContents && dexAltSet.altContents[altAddress]) {
                delete dexAltSet.altContents[altAddress];
              }
              configChanged = true;
              if (!removedCategory) removedCategory = `${dex}-pools`;
            }
          }
        }
      }

      // Clean up poolToAlt reverse mappings
      if (this.altConfig.poolToAlt) {
        const poolsToRemove: string[] = [];
        for (const [poolId, addr] of Object.entries(this.altConfig.poolToAlt)) {
          if (addr === altAddress) {
            poolsToRemove.push(poolId);
          }
        }
        for (const poolId of poolsToRemove) {
          delete this.altConfig.poolToAlt[poolId];
        }
        if (poolsToRemove.length > 0) configChanged = true;
      }

      // Save updated config
      if (configChanged) {
        try {
          await saveAltConfig(this.altConfig);
          try {
            logger.info('alt.manager.closeByAddress.config.cleaned', {
              cat: 'tx',
              ctx: { altAddress, removedCategory },
            });
          } catch {}
        } catch (saveError) {
          try {
            logger.warn('alt.manager.closeByAddress.config.save.failed', {
              cat: 'tx',
              ctx: { altAddress, error: String((saveError as any)?.message || saveError) },
            });
          } catch {}
        }
      }
    }

    try {
      logger.debug('alt.manager.closeByAddress.state.cleaned', {
        cat: 'tx',
        ctx: { altAddress, removedCategory, remainingAlts: this.altAddresses.size },
      });
    } catch {}
  }

  /**
   * Bulk deactivate multiple ALTs
   */
  async bulkDeactivate(altAddresses: string[]): Promise<{
    success: string[];
    failed: { address: string; error: string }[];
  }> {
    const success: string[] = [];
    const failed: { address: string; error: string }[] = [];

    for (const addr of altAddresses) {
      try {
        await this.deactivateAltByAddress(addr);
        success.push(addr);
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (e: any) {
        failed.push({ address: addr, error: String(e?.message || e) });
      }
    }

    return { success, failed };
  }

  /**
   * Bulk close multiple ALTs
   */
  async bulkClose(altAddresses: string[]): Promise<{
    success: { address: string; rentRecovered: number }[];
    failed: { address: string; error: string }[];
    totalRentRecovered: number;
  }> {
    const success: { address: string; rentRecovered: number }[] = [];
    const failed: { address: string; error: string }[] = [];
    let totalRentRecovered = 0;

    for (const addr of altAddresses) {
      try {
        const result = await this.closeAltByAddress(addr);
        success.push({ address: addr, rentRecovered: result.rentRecovered });
        totalRentRecovered += result.rentRecovered;
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (e: any) {
        failed.push({ address: addr, error: String(e?.message || e) });
      }
    }

    return { success, failed, totalRentRecovered };
  }

  /**
   * Get detailed ALT information including deactivation status
   */
  async getAltInfo(category: string): Promise<{
    address: string;
    accountCount: number;
    isDeactivated: boolean;
    deactivationSlot?: number;
    canClose: boolean;
    slotsUntilCloseable?: number;
    minutesUntilCloseable?: number;
    rentAmount: number;
  }> {
    const altPk = this.altAddresses.get(category);
    if (!altPk) {
      throw new Error(`No ALT found for category "${category}"`);
    }

    const connection = getConnection();
    const altAccount = await withRpcLimit(
      () => connection.getAddressLookupTable(altPk),
      1,
      { module: 'alt-status', method: 'getAddressLookupTable' }
    );

    if (!altAccount.value) {
      throw new Error(`ALT not found on-chain: ${altPk.toBase58()}`);
    }

    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(altPk),
      1,
      { module: 'alt-status', method: 'getAccountInfo' }
    );

    // Check if deactivated: Solana uses BigInt(2^64 - 1) for active ALTs
    // An ALT is deactivated only if the deactivationSlot is a valid slot number (not max u64)
    const deactivationSlotBigInt = altAccount.value.state.deactivationSlot;
    const MAX_U64 = BigInt('18446744073709551615'); // 2^64 - 1
    
    const isDeactivated = deactivationSlotBigInt !== undefined && 
                         deactivationSlotBigInt !== MAX_U64 &&
                         deactivationSlotBigInt < MAX_U64;
    
    const deactivationSlot = isDeactivated 
      ? Number(deactivationSlotBigInt) 
      : undefined;

    let canClose = false;
    let slotsUntilCloseable: number | undefined;
    let minutesUntilCloseable: number | undefined;

    if (isDeactivated && deactivationSlot !== undefined) {
      const currentSlot = await withRpcLimit(
        () => connection.getSlot(),
        1,
        { module: 'alt-status', method: 'getSlot' }
      );
      const slotsSinceDeactivation = currentSlot - deactivationSlot;
      canClose = slotsSinceDeactivation >= 513;
      
      if (!canClose) {
        slotsUntilCloseable = 513 - slotsSinceDeactivation;
        // Estimate ~0.4 seconds per slot
        minutesUntilCloseable = Math.ceil((slotsUntilCloseable * 0.4) / 60);
      } else {
        slotsUntilCloseable = 0;
        minutesUntilCloseable = 0;
      }
    }

    return {
      address: altPk.toBase58(),
      accountCount: altAccount.value.state.addresses.length,
      isDeactivated,
      deactivationSlot,
      canClose,
      slotsUntilCloseable,
      minutesUntilCloseable,
      rentAmount: accountInfo?.lamports || 0,
    };
  }

  /**
   * Deactivate an ALT (step 1 of deletion)
   * Must wait ~513 slots (~4-5 minutes) before closing
   */
  async deactivateAlt(
    category: string
  ): Promise<{ signature: string; altAddress: string }> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    const connection = getConnection();

    // Get the ALT address for this category
    const altPk = this.altAddresses.get(category);
    if (!altPk) {
      throw new Error(`No ALT found for category "${category}"`);
    }

    try {
      logger.info('alt.manager.deactivate.start', {
        cat: 'tx',
        ctx: {
          category,
          altAddress: altPk.toBase58(),
        },
      });
    } catch {}

    // Create deactivate instruction
    const deactivateIx = AddressLookupTableProgram.deactivateLookupTable({
      lookupTable: altPk,
      authority: wallet.publicKey,
    });

    // Create and send transaction
    const tx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.add(deactivateIx);
    const { blockhash } = await withRpcLimit(
      () => connection.getLatestBlockhash(),
      1,
      { module: 'alt-deactivate', method: 'getLatestBlockhash' }
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(
      () => connection.sendRawTransaction(tx.serialize()),
      2,
      { module: 'alt-deactivate', method: 'sendRawTransaction' }
    );

    // Wait for confirmation
    await withRpcLimit(
      () => connection.confirmTransaction(signature, 'confirmed'),
      2,
      { module: 'alt-deactivate', method: 'confirmTransaction' }
    );

    try {
      logger.info('alt.manager.deactivate.ok', {
        cat: 'tx',
        ctx: {
          category,
          altAddress: altPk.toBase58(),
          signature,
        },
      });
    } catch {}

    return {
      signature,
      altAddress: altPk.toBase58(),
    };
  }

  /**
   * Close an ALT and recover rent (step 2 of deletion)
   * Must be called after ALT has been deactivated for 513+ slots
   */
  async closeAlt(
    category: string,
    recipient?: PublicKey
  ): Promise<{ signature: string; altAddress: string; rentRecovered: number }> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    const connection = getConnection();

    // Get the ALT address for this category
    const altPk = this.altAddresses.get(category);
    if (!altPk) {
      throw new Error(`No ALT found for category "${category}"`);
    }

    try {
      logger.info('alt.manager.close.start', {
        cat: 'tx',
        ctx: {
          category,
          altAddress: altPk.toBase58(),
        },
      });
    } catch {}

    // Check ALT state
    const altAccount = await withRpcLimit(
      () => connection.getAddressLookupTable(altPk),
      1,
      { module: 'alt-close', method: 'getAddressLookupTable' }
    );
    
    if (!altAccount.value) {
      throw new Error(`ALT not found on-chain: ${altPk.toBase58()}`);
    }

    if (altAccount.value.state.deactivationSlot === undefined) {
      throw new Error('ALT has not been deactivated yet. Call deactivateAlt() first.');
    }

    // Get current slot to verify enough time has passed
    const currentSlot = await withRpcLimit(
      () => connection.getSlot(),
      1,
      { module: 'alt-close', method: 'getSlot' }
    );
    const slotsSinceDeactivation = currentSlot - Number(altAccount.value.state.deactivationSlot);
    
    if (slotsSinceDeactivation < 513) {
      const slotsRemaining = 513 - slotsSinceDeactivation;
      const minutesRemaining = Math.ceil((slotsRemaining * 0.4) / 60); // ~0.4s per slot
      throw new Error(
        `ALT cannot be closed yet. Wait ${slotsRemaining} more slots (~${minutesRemaining} minutes)`
      );
    }

    // Get account info to calculate rent recovered
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(altPk),
      1,
      { module: 'alt-close', method: 'getAccountInfo' }
    );
    const rentRecovered = accountInfo?.lamports || 0;

    // Create close instruction
    const closeIx = AddressLookupTableProgram.closeLookupTable({
      lookupTable: altPk,
      authority: wallet.publicKey,
      recipient: recipient || wallet.publicKey,
    });

    // Create and send transaction
    const tx = new Transaction();
    // Add priority fee instructions for reliable confirmation
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: ALT_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ALT_PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.add(closeIx);
    const { blockhash } = await withRpcLimit(
      () => connection.getLatestBlockhash(),
      1,
      { module: 'alt-close', method: 'getLatestBlockhash' }
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(
      () => connection.sendRawTransaction(tx.serialize()),
      2,
      { module: 'alt-close', method: 'sendRawTransaction' }
    );

    // Wait for confirmation
    await withRpcLimit(
      () => connection.confirmTransaction(signature, 'confirmed'),
      2,
      { module: 'alt-close', method: 'confirmTransaction' }
    );

    // Remove from our tracking
    this.altAddresses.delete(category);
    this.altAccounts.delete(altPk.toBase58());

    // Update config
    try {
      this.altConfig = await loadAltConfig();
      if (this.altConfig.alts && this.altConfig.alts[category as keyof typeof this.altConfig.alts]) {
        delete this.altConfig.alts[category as keyof typeof this.altConfig.alts];
        await saveAltConfig(this.altConfig);
      }
    } catch (e) {
      try {
        logger.warn('alt.manager.close.config.update.failed', {
          cat: 'tx',
          ctx: { category, error: String((e as any)?.message || e) },
        });
      } catch {}
    }

    try {
      logger.info('alt.manager.close.ok', {
        cat: 'tx',
        ctx: {
          category,
          altAddress: altPk.toBase58(),
          signature,
          rentRecoveredSOL: (rentRecovered / 1e9).toFixed(6),
        },
      });
    } catch {}

    return {
      signature,
      altAddress: altPk.toBase58(),
      rentRecovered,
    };
  }

  // ============================================================================
  // NEW METHODS: Enhanced ALT Management
  // ============================================================================

  /**
   * Collect frequently-used pool vaults for anchor token pairs.
   * These are vaults (token accounts) that appear in many pools involving anchor mints.
   * 
   * @param anchorMints List of anchor mint addresses
   * @param maxVaults Maximum number of vaults to collect (default 50)
   * @returns Array of vault PublicKeys sorted by frequency
   */
  private async collectFrequentAnchorVaults(
    anchorMints: string[],
    maxVaults: number = 50
  ): Promise<PublicKey[]> {
    const vaultCounts = new Map<string, number>();
    
    try {
      const { getGraphSnapshot } = await import('../../server/graph.js');
      const snapshot = await getGraphSnapshot();
      
      if (!snapshot?.edges) return [];
      
      const anchorSet = new Set(anchorMints);
      
      // Count vault occurrences in pools involving anchor mints
      for (const edge of snapshot.edges) {
        // Skip reverse edges
        if (/[#-]rev$/.test(String(edge.pool_id || ''))) continue;
        
        const mintA = (edge as any).from || (edge as any).mint_a;
        const mintB = (edge as any).to || (edge as any).mint_b;
        
        // Only consider pools with at least one anchor mint
        const hasAnchor = anchorSet.has(mintA) || anchorSet.has(mintB);
        if (!hasAnchor) continue;
        
        // Get vaults from edge data
        const vaultA = (edge as any).vault_a || (edge as any).account_a;
        const vaultB = (edge as any).vault_b || (edge as any).account_b;
        
        if (vaultA) {
          vaultCounts.set(vaultA, (vaultCounts.get(vaultA) || 0) + 1);
        }
        if (vaultB) {
          vaultCounts.set(vaultB, (vaultCounts.get(vaultB) || 0) + 1);
        }
      }
      
      // Sort by frequency and take top N
      const sortedVaults = Array.from(vaultCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxVaults)
        .map(([vault]) => vault);
      
      try {
        logger.debug('alt.manager.collect.anchor.vaults', {
          cat: 'tx',
          ctx: {
            totalVaultsFound: vaultCounts.size,
            selectedVaults: sortedVaults.length,
            topVaultFrequency: sortedVaults.length > 0 ? vaultCounts.get(sortedVaults[0]) : 0,
          },
        });
      } catch {}
      
      return sortedVaults.map(v => new PublicKey(v));
    } catch (error) {
      try {
        logger.warn('alt.manager.collect.anchor.vaults.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
      return [];
    }
  }

  /**
   * Collect only STATIC accounts for a pool (accounts that don't change with price).
   * Excludes tick arrays and bin arrays since they're position-dependent.
   * 
   * @param poolId Pool address (may include -rev or -fwd suffix)
   * @param dex DEX type
   * @returns Array of PublicKeys for static accounts needed for this pool
   */
  async collectStaticPoolAccounts(
    poolId: string,
    dex: string
  ): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];
    const connection = getConnection();
    
    try {
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      const poolPk = new PublicKey(cleanPoolId);
      accounts.push(poolPk);

      const dexLower = dex.toLowerCase();
      
      // Try to get from execution cache first (faster, no RPC)
      const { executionCache } = await import('../cache.js');
      const stat = executionCache.getStatic(cleanPoolId);
      
      if (stat) {
        // Use cached data (no RPC calls needed)
        const addIfValid = (val: any) => {
          if (!val) return;
          try {
            accounts.push(new PublicKey(val));
          } catch {}
        };
        
        // Common across all DEXes
        addIfValid(stat.mint_a);
        addIfValid(stat.mint_b);
        addIfValid(stat.account_a);  // vault A
        addIfValid(stat.account_b);  // vault B
        
        if (dexLower === 'raydium') {
          addIfValid(stat.amm_config);
          addIfValid(stat.observation_state);
          addIfValid(stat.ex_bitmap);  // only if exists
        } else if (dexLower === 'orca') {
          addIfValid((stat as any).oracle);
          addIfValid((stat as any).whirlpools_config);
        } else if (dexLower === 'meteora') {
          addIfValid((stat as any).oracle);
          addIfValid((stat as any).reserve_x);
          addIfValid((stat as any).reserve_y);
          // Add event authority (constant PDA)
          accounts.push(new PublicKey('D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6'));
        }
        
        return accounts;
      }
      
      // Fallback: fetch from chain (slower)
      const poolInfo = await withRpcLimit(
        () => connection.getAccountInfo(poolPk),
        1,
        { module: 'alt', method: 'getAccountInfo' }
      );
      
      if (!poolInfo) return accounts;
      
      // Parse based on DEX type - reuse existing parse methods
      if (dexLower === 'raydium') {
        const clmmAccounts = await this.parseRaydiumClmmAccounts(poolPk, poolInfo);
        accounts.push(...clmmAccounts);
      } else if (dexLower === 'raydium-amm') {
        const ammAccounts = await this.parseRaydiumAmmAccounts(poolPk, poolInfo);
        accounts.push(...ammAccounts);
      } else if (dexLower === 'raydium-cpmm') {
        const cpmmAccounts = await this.parseRaydiumCpmmAccounts(poolPk, poolInfo);
        accounts.push(...cpmmAccounts);
      } else if (dexLower === 'orca') {
        const whirlpoolAccounts = await this.parseOrcaWhirlpoolAccounts(poolPk, poolInfo);
        accounts.push(...whirlpoolAccounts);
      } else if (dexLower === 'meteora') {
        const dlmmAccounts = await this.parseMeteoraDlmmAccounts(poolPk, poolInfo);
        accounts.push(...dlmmAccounts);
      } else if (dexLower === 'meteora-damm-v1' || dexLower === 'meteora_damm_v1') {
        const dammAccounts = await this.parseMeteoraDammAccounts(poolPk, poolInfo, 'v1');
        accounts.push(...dammAccounts);
      } else if (dexLower === 'meteora-damm-v2' || dexLower === 'meteora_damm_v2') {
        const dammAccounts = await this.parseMeteoraDammAccounts(poolPk, poolInfo, 'v2');
        accounts.push(...dammAccounts);
      } else if (dexLower === 'pumpswap') {
        const pumpswapAccounts = await this.parsePumpswapAccounts(poolPk, poolInfo);
        accounts.push(...pumpswapAccounts);
      }
      
      return accounts;
    } catch (error) {
      try {
        logger.warn('alt.manager.collectStaticPoolAccounts.error', {
          cat: 'tx',
          ctx: { poolId, dex, error: String((error as any)?.message || error) },
        });
      } catch {}
      return accounts;
    }
  }

  /**
   * Create ALTs covering ALL pools in the graph for a specific DEX.
   * Creates as many ALTs as needed to fit all pools (no artificial limit).
   * 
   * @param dex DEX to create ALTs for
   * @returns DexAltSet with all created ALT info
   */
  async createAllDexPoolAlts(
    dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap'
  ): Promise<DexAltSet> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    
    // Solana ALT limit is 256, use 230 for safety margin
    const MAX_ACCOUNTS_PER_ALT = 230;
    
    // Accounts per pool (static accounts only - excludes tick/bin arrays)
    const STATIC_ACCOUNTS_PER_POOL: Record<string, number> = {
      raydium: 8,           // CLMM: pool, amm_config, vaultA, vaultB, mintA, mintB, observation, [exBitmap]
      'raydium-amm': 12,    // AMM v4: pool, authority, openOrders, targetOrders, vaults, mints, markets
      'raydium-cpmm': 8,    // CPMM: pool, config, vaultA, vaultB, mintA, mintB, observation, authority
      orca: 7,              // Whirlpool: pool, vaultA, vaultB, mintA, mintB, oracle, whirlpoolsConfig
      meteora: 8,           // DLMM: pair, reserveX, reserveY, mintX, mintY, oracle, eventAuthority, [bitmapExt]
      'meteora-damm-v1': 8, // Dynamic AMM v1: pool, vaults, mints, oracle, authority
      'meteora-damm-v2': 8, // CP-AMM v2: pool, vaults, mints, config
      pumpswap: 6,          // Post-graduation: pool, vaults, mints, authority
    };
    
    const result: DexAltSet = {
      addresses: [],
      altContents: {},
      totalPools: 0,
      totalAccounts: 0,
    };

    try {
      // Get ALL pools from graph snapshot (no limit)
      const { getGraphSnapshot } = await import('../../server/graph.js');
      const snapshot = await getGraphSnapshot();
      
      if (!snapshot?.edges) {
        try {
          logger.warn('alt.manager.createAllDexPoolAlts.no.snapshot', {
            cat: 'tx',
            ctx: { dex },
          });
        } catch {}
        return result;
      }

      // DEX matching function - handles graph edge dex values vs API dex keys
      // Graph edges use different naming conventions than the API parameter
      const dexMatchFn = (edgeDex: string, edgePoolKind: string): boolean => {
        const normalizedEdgeDex = edgeDex.toLowerCase();
        
        switch (dex) {
          case 'raydium':
            // Match raydium CLMM only
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'clmm';
          case 'raydium-amm':
            // Match only raydium AMM v4 pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'amm';
          case 'raydium-cpmm':
            // Match only raydium CPMM pools (edges have dex='Raydium' with pool_kind='cpmm')
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'cpmm';
          case 'orca':
            return normalizedEdgeDex === 'orca';
          case 'meteora':
            // Match meteora DLMM only (clmm type)
            return normalizedEdgeDex === 'meteora' && edgePoolKind === 'clmm';
          case 'meteora-balanced':
            return normalizedEdgeDex === 'meteora_balanced' || normalizedEdgeDex === 'meteora-balanced';
          case 'meteora-damm-v1':
            // Match Meteora Dynamic AMM v1 pools (various naming conventions in graph)
            return normalizedEdgeDex === 'meteora_damm_v1' || normalizedEdgeDex === 'meteora-damm-v1' ||
                   normalizedEdgeDex === 'meteorabalanced_v1' || normalizedEdgeDex === 'meteora_balanced_v1';
          case 'meteora-damm-v2':
            // Match Meteora CP-AMM v2 pools (various naming conventions in graph)
            return normalizedEdgeDex === 'meteora_damm_v2' || normalizedEdgeDex === 'meteora-damm-v2' ||
                   normalizedEdgeDex === 'meteorabalanced_v2' || normalizedEdgeDex === 'meteora_balanced_v2';
          case 'pumpswap':
            return normalizedEdgeDex === 'pumpswap';
          default:
            return false;
        }
      };

      // Collect ALL unique pools for this DEX
      const poolIds = new Set<string>();
      for (const edge of snapshot.edges) {
        const edgeDex = String(edge.dex || '').toLowerCase();
        const edgePoolKind = String((edge as any).pool_kind || '');
        
        if (!dexMatchFn(edgeDex, edgePoolKind)) continue;
        
        const poolId = String(edge.pool_id || '');
        if (!poolId) continue;
        
        // Skip reverse edges
        if (/[#-]rev$/.test(poolId)) continue;
        
        const cleanPoolId = poolId.replace(/-(rev|fwd)$/, '');
        poolIds.add(cleanPoolId);
      }

      if (poolIds.size === 0) {
        try {
          logger.warn('alt.manager.createAllDexPoolAlts.no.pools', {
            cat: 'tx',
            ctx: { dex },
          });
        } catch {}
        return result;
      }

      const allPools = Array.from(poolIds);
      const accountsPerPool = STATIC_ACCOUNTS_PER_POOL[dex] || 8;
      const poolsPerAlt = Math.floor(MAX_ACCOUNTS_PER_ALT / accountsPerPool);
      const altsNeeded = Math.ceil(allPools.length / poolsPerAlt);

      try {
        logger.info('alt.manager.createAllDexPoolAlts.planning', {
          cat: 'tx',
          ctx: {
            dex,
            totalPools: allPools.length,
            accountsPerPool,
            poolsPerAlt,
            altsNeeded,
            estimatedTotalAccounts: allPools.length * accountsPerPool,
          },
        });
      } catch {}

      // Load existing config
      const config = await loadAltConfig();
      if (!config.dexAlts) config.dexAlts = {};
      if (!config.poolToAlt) config.poolToAlt = {};

      // Load existing DEX ALT addresses from config into in-memory cache
      // This ensures we don't create duplicate ALTs after service restart
      const existingDexAlts = config.dexAlts[dex];
      if (existingDexAlts?.addresses && Array.isArray(existingDexAlts.addresses)) {
        // Limit to reasonable number of existing ALTs (safety check)
        const maxExistingAlts = Math.min(existingDexAlts.addresses.length, 100);
        for (let altIdx = 0; altIdx < maxExistingAlts; altIdx++) {
          const altAddr = existingDexAlts.addresses[altIdx];
          if (!altAddr || typeof altAddr !== 'string') continue;
          
          try {
            // Validate it's a valid base58 address
            new PublicKey(altAddr);
            
            const category = `${dex}-pools-${altIdx + 1}`;
            if (!this.altAddresses.has(category)) {
              this.altAddresses.set(category, new PublicKey(altAddr));
              try {
                logger.info('alt.manager.loaded.existing.dex.alt', {
                  cat: 'tx',
                  ctx: { dex, category, altAddress: altAddr.slice(0, 8) + '...' },
                });
              } catch {}
            }
          } catch (e) {
            // Invalid address, skip
            try {
              logger.warn('alt.manager.invalid.existing.alt', {
                cat: 'tx',
                ctx: { dex, altIdx, error: String((e as any)?.message || e) },
              });
            } catch {}
          }
        }
      }

      // Filter out pools that already have ALTs assigned
      const poolsNeedingAlts = allPools.filter(poolId => !config.poolToAlt![poolId]);
      const poolsAlreadyAssigned = allPools.length - poolsNeedingAlts.length;
      
      if (poolsAlreadyAssigned > 0) {
        try {
          logger.info('alt.manager.createAllDexPoolAlts.existing.pools', {
            cat: 'tx',
            ctx: {
              dex,
              totalPools: allPools.length,
              poolsAlreadyAssigned,
              poolsNeedingAlts: poolsNeedingAlts.length,
            },
          });
        } catch {}
      }

      // If all pools already have ALTs, return existing result
      if (poolsNeedingAlts.length === 0) {
        try {
          logger.info('alt.manager.createAllDexPoolAlts.all.assigned', {
            cat: 'tx',
            ctx: { dex, totalPools: allPools.length },
          });
        } catch {}
        
        // Return existing result from config
        if (existingDexAlts) {
          return existingDexAlts;
        }
        return result;
      }

      // Recalculate ALTs needed for remaining pools
      const poolsToProcess = poolsNeedingAlts;
      const altsNeededForRemaining = Math.ceil(poolsToProcess.length / poolsPerAlt);
      
      // Find the next ALT index (continue from existing)
      let nextAltIndex = existingDexAlts?.addresses?.length || 0;

      // Process pools in chunks
      for (let i = 0; i < altsNeededForRemaining; i++) {
        const altIndex = nextAltIndex + i;
        const startIdx = i * poolsPerAlt;
        const endIdx = Math.min(startIdx + poolsPerAlt, poolsToProcess.length);
        const chunkPools = poolsToProcess.slice(startIdx, endIdx);
        
        if (chunkPools.length === 0) continue;
        
        const category = `${dex}-pools-${altIndex + 1}`;
        
        // Collect accounts for this chunk
        const accounts: PublicKey[] = [];
        const chunkPoolIds: string[] = [];
        
        for (const poolId of chunkPools) {
          try {
            // Only collect static accounts (not tick/bin arrays)
            const poolAccounts = await this.collectStaticPoolAccounts(poolId, dex);
            accounts.push(...poolAccounts);
            chunkPoolIds.push(poolId);
          } catch (e) {
            try {
              logger.warn('alt.manager.createAllDexPoolAlts.pool.error', {
                cat: 'tx',
                ctx: { poolId, dex, error: String((e as any)?.message || e) },
              });
            } catch {}
          }
        }

        if (accounts.length === 0) continue;

        // Deduplicate accounts within this chunk
        const seen = new Set<string>();
        const dedupedAccounts = accounts.filter(pk => {
          const addr = pk.toBase58();
          if (seen.has(addr)) return false;
          seen.add(addr);
          return true;
        });

        // Create or extend ALT
        let altAddress: string;
        const existingAlt = this.altAddresses.get(category);
        
        if (existingAlt) {
          // Check if we can extend existing ALT
          const existingAccount = this.altAccounts.get(existingAlt.toBase58());
          const existingCount = existingAccount?.state?.addresses?.length || 0;
          const remainingCapacity = 256 - existingCount;
          
          if (remainingCapacity >= dedupedAccounts.length) {
            // Filter out accounts already in the ALT
            const existingAddrs = new Set(
              (existingAccount?.state?.addresses || []).map(a => a.toBase58())
            );
            const newAccounts = dedupedAccounts.filter(
              pk => !existingAddrs.has(pk.toBase58())
            );
            
            if (newAccounts.length > 0) {
              await this.extendAlt(category, newAccounts);
            }
            altAddress = existingAlt.toBase58();
          } else {
            // Need to create a new ALT for overflow
            const overflowCategory = `${category}-overflow-${Date.now()}`;
            const address = await this.createAltOnChain(wallet, dedupedAccounts, overflowCategory);
            altAddress = address.toBase58();
            this.altAddresses.set(overflowCategory, address);
          }
        } else {
          // Create new ALT
          const address = await this.createAltOnChain(wallet, dedupedAccounts, category);
          altAddress = address.toBase58();
          this.altAddresses.set(category, address);
        }

        // Update result and mappings
        result.addresses.push(altAddress);
        result.altContents[altAddress] = chunkPoolIds;
        result.totalPools += chunkPoolIds.length;
        result.totalAccounts += dedupedAccounts.length;

        // Update poolToAlt mapping for O(1) lookup
        for (const poolId of chunkPoolIds) {
          config.poolToAlt![poolId] = altAddress;
        }

        try {
          logger.info('alt.manager.createAllDexPoolAlts.alt.created', {
            cat: 'tx',
            ctx: {
              category,
              altAddress: altAddress.slice(0, 8) + '...',
              poolCount: chunkPoolIds.length,
              accountCount: dedupedAccounts.length,
              progress: `${i + 1}/${altsNeededForRemaining} (ALT #${altIndex + 1})`,
            },
          });
        } catch {}
      }

      // Merge existing ALTs with new ones
      if (existingDexAlts) {
        // Prepend existing addresses and contents
        result.addresses = [...existingDexAlts.addresses, ...result.addresses];
        result.altContents = { ...existingDexAlts.altContents, ...result.altContents };
        result.totalPools += existingDexAlts.totalPools || 0;
        result.totalAccounts += existingDexAlts.totalAccounts || 0;
      }

      // Save updated config
      config.dexAlts![dex] = result;
      await saveAltConfig(config);

      // Refresh ALT cache
      await this.preloadAllAltAccounts();

      try {
        logger.info('alt.manager.createAllDexPoolAlts.complete', {
          cat: 'tx',
          ctx: {
            dex,
            altsCreated: result.addresses.length,
            totalPools: result.totalPools,
            totalAccounts: result.totalAccounts,
            coveragePercent: '100%',
          },
        });
      } catch {}

      return result;
    } catch (error) {
      try {
        logger.error('alt.manager.createAllDexPoolAlts.error', {
          cat: 'tx',
          ctx: {
            dex,
            error: String((error as any)?.message || error),
          },
        });
      } catch {}
      return result;
    }
  }

  /**
   * Create or update the common ALT with all frequently-used accounts.
   * This should be called on startup and periodically to refresh.
   * 
   * @param walletPubkey Wallet to derive ATAs for (optional but recommended)
   * @returns Address of the common ALT
   */
  async createOrUpdateCommonAlt(walletPubkey?: PublicKey): Promise<string | null> {
    try {
      // Get wallet if not provided
      const { ensureWallet } = await import('../../wallet/wallet.js');
      const wallet = await ensureWallet(CONFIG.walletPath);
      const walletPk = walletPubkey || wallet.publicKey;
      
      // Collect all common accounts including wallet ATAs
      const commonAccounts = await this.collectCommonAccounts(walletPk);
      
      if (commonAccounts.length === 0) {
        try {
          logger.warn('alt.manager.common.no_accounts', { cat: 'tx' });
        } catch {}
        return null;
      }
      
      // Check if common ALT already exists
      const config = await loadAltConfig();
      
      if (config.alts.common) {
        // ALT exists - check if we need to extend it
        const existingAlt = this.altAccounts.get(config.alts.common);
        if (existingAlt) {
          const existingAddrs = new Set(
            (existingAlt.state?.addresses || []).map(a => a.toBase58())
          );
          
          // Filter to only accounts not already in ALT
          const newAccounts = commonAccounts.filter(
            pk => !existingAddrs.has(pk.toBase58())
          );
          
          if (newAccounts.length > 0) {
            const remainingCapacity = 256 - (existingAlt.state?.addresses?.length || 0);
            
            if (newAccounts.length <= remainingCapacity) {
              await this.extendAlt('common', newAccounts);
              try {
                logger.info('alt.manager.common.extended', {
                  cat: 'tx',
                  ctx: {
                    address: config.alts.common,
                    newAccounts: newAccounts.length,
                    totalAccounts: (existingAlt.state?.addresses?.length || 0) + newAccounts.length,
                  },
                });
              } catch {}
              return config.alts.common;
            } else {
              try {
                logger.warn('alt.manager.common.full', {
                  cat: 'tx',
                  ctx: {
                    address: config.alts.common,
                    capacity: remainingCapacity,
                    needed: newAccounts.length,
                  },
                });
              } catch {}
            }
          }
          
          return config.alts.common;
        }
      }
      
      // Create new common ALT
      const address = await this.createAltOnChain(wallet, commonAccounts, 'common');

      // Update in-memory state
      this.altAddresses.set('common', address);

      // Also load the ALT account into cache for immediate use
      try {
        const connection = getConnection();
        const altAccount = await withRpcLimit(
          () => connection.getAddressLookupTable(address),
          1,
          { module: 'alt', method: 'getAddressLookupTable' }
        );
        if (altAccount.value) {
          this.altAccounts.set(address.toBase58(), altAccount.value);
        }
      } catch {}

      // Save to config
      config.alts.common = address.toBase58();
      config.walletPublicKey = walletPk.toBase58();
      await saveAltConfig(config);
      
      try {
        logger.info('alt.manager.common.created', {
          cat: 'tx',
          ctx: {
            address: address.toBase58(),
            accountCount: commonAccounts.length,
            wallet: walletPk.toBase58().slice(0, 8) + '...',
          },
        });
      } catch {}
      
      return address.toBase58();
    } catch (error) {
      try {
        logger.error('alt.manager.common.create.error', {
          cat: 'tx',
          ctx: { error: String((error as any)?.message || error) },
        });
      } catch {}
      return null;
    }
  }

  /**
   * Create ALTs for ALL DEXes, covering all pools in the graph.
   * Call this on startup or when graph changes significantly.
   */
  async createAllAlts(): Promise<{
    raydium: DexAltSet;
    orca: DexAltSet;
    meteora: DexAltSet;
    common: string | null;
  }> {
    try {
      logger.info('alt.manager.createAllAlts.start', { cat: 'tx' });
    } catch {}
    
    // Create common ALT first (programs, sysvars, user ATAs, etc.)
    const commonAltAddress = await this.createOrUpdateCommonAlt();
    
    // Create DEX-specific ALTs (sequentially to avoid rate limits)
    const raydium = await this.createAllDexPoolAlts('raydium');
    const orca = await this.createAllDexPoolAlts('orca');
    const meteora = await this.createAllDexPoolAlts('meteora');
    
    try {
      logger.info('alt.manager.createAllAlts.complete', {
        cat: 'tx',
        ctx: {
          common: commonAltAddress ? 'created' : 'skipped',
          raydium: { alts: raydium.addresses.length, pools: raydium.totalPools },
          orca: { alts: orca.addresses.length, pools: orca.totalPools },
          meteora: { alts: meteora.addresses.length, pools: meteora.totalPools },
        },
      });
    } catch {}
    
    return { raydium, orca, meteora, common: commonAltAddress };
  }
}

// Singleton instance
export const dexAltManager = new DexAltManager();

// Initialize on import
dexAltManager.initialize().catch(() => {});

