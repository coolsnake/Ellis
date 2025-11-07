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
            result = await withRpcLimit(() => 
              connection.getAddressLookupTable(lookupTableAddress)
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
    extendTx.add(extendIx);
    const extendBlockhash = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    extendTx.recentBlockhash = extendBlockhash.blockhash;
    extendTx.feePayer = payer.publicKey;
    
    extendTx.sign(kp);
    
    const extendSig = await withRpcLimit(() => connection.sendRawTransaction(extendTx.serialize()));
    await withRpcLimit(() => connection.confirmTransaction(extendSig, 'confirmed'));
    
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
    
    try {
      // Derive ALT address deterministically with custom seed (for checking existing ALTs)
      const [derivedAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(seed),
          payer.publicKey.toBuffer(),
        ],
        AddressLookupTableProgram.programId
      );
    
      // Check if ALT already exists at this address (with retries for RPC delays)
      let existing: { value: AddressLookupTableAccount | null } | null = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          existing = await withRpcLimit(() => 
            connection.getAddressLookupTable(derivedAddress)
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
      
      // Check ALT config for existing addresses first
      try {
        const config = await loadAltConfig();
        if (config.alts) {
          for (const [category, address] of Object.entries(config.alts)) {
            if (!address) continue;
            try {
              const altPk = new PublicKey(address);
              const result = await withRpcLimit(() => 
                connection.getAddressLookupTable(altPk)
              ).catch(() => ({ value: null }));
              
              if (result.value) {
                const accountCount = result.value.state?.addresses?.length || 0;
                const remainingCapacity = 256 - accountCount;
                
                // If empty or has enough capacity, reuse it
                if (accountCount === 0 || (remainingCapacity >= accounts.length && accounts.length > 0)) {
                  try {
                    logger.info('alt.manager.found.config', {
                      cat: 'tx',
                      ctx: {
                        address,
                        category,
                        accountCount,
                        remainingCapacity,
                        accountsToAdd: accounts.length,
                        requestedSeed: seed,
                      },
                    });
                  } catch {}
                  
                  // Extend if needed
                  if (accounts.length > 0 && remainingCapacity >= accounts.length) {
                    const addressesToAdd = accounts.slice(0, remainingCapacity);
                    await this.extendLookupTable(payer, altPk, addressesToAdd);
                  }
                  
                  this.altAddresses.set(seed, altPk);
                  return altPk;
                }
              }
            } catch {}
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
        
        // Store with the requested seed key
        this.altAddresses.set(seed, reusable.address);
        return reusable.address;
      }
    
    // Get recent slot for ALT creation
    const recentSlotRaw = await withRpcLimit(() => connection.getSlot('finalized'));
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
    createTx.add(createIx);
    const createBlockhash = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    createTx.recentBlockhash = createBlockhash.blockhash;
    createTx.feePayer = payer.publicKey;
    
    const kp = Keypair.fromSecretKey(payer.secretKey);
    createTx.sign(kp);
    
    const createSig = await withRpcLimit(() => connection.sendRawTransaction(createTx.serialize()));
    
    // Use 'finalized' commitment for more reliable confirmation
    const confirmation = await withRpcLimit(() => 
      connection.confirmTransaction(createSig, 'finalized')
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
        verifyResult = await withRpcLimit(() => 
          connection.getAddressLookupTable(lookupTableAddress)
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
        const txStatus = await withRpcLimit(() => 
          connection.getSignatureStatus(createSig)
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
      // No accounts to add, just cache the empty ALT
      this.altAddresses.set(seed, lookupTableAddress);
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
        const accountInfo = await withRpcLimit(() => 
          connection.getAccountInfo(lookupTableAddress)
        );
        
        if (accountInfo && accountInfo.owner) {
          const isOwnedByAltProgram = accountInfo.owner.equals(AddressLookupTableProgram.programId);
          
          if (isOwnedByAltProgram) {
            // Also verify we can get the lookup table data
            const altResult = await withRpcLimit(() => 
              connection.getAddressLookupTable(lookupTableAddress)
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
      
      // Cache the ALT address anyway
      this.altAddresses.set(seed, lookupTableAddress);
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
      
      // Still cache the ALT address even if extend failed
      this.altAddresses.set(seed, lookupTableAddress);
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

