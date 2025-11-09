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

        // Load ALTs from altConfig file (same as initializeStartup does)
        try {
          this.altConfig = await loadAltConfig();
          if (this.altConfig.alts) {
            for (const [category, address] of Object.entries(this.altConfig.alts)) {
              if (!address) continue;
              try {
                const pk = new PublicKey(address);
                this.altAddresses.set(category, pk);
              } catch (e) {
                // Invalid address, skip it
              }
            }
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

      // System programs (appear in every transaction)
      accounts.push(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')); // Token Program
      accounts.push(new PublicKey('11111111111111111111111111111111')); // System Program
      accounts.push(new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')); // ATA Program
      accounts.push(new PublicKey('ComputeBudget111111111111111111111111111111')); // Compute Budget Program
      
      // Meteora-specific common account (appears in EVERY Meteora swap)
      accounts.push(new PublicKey('D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6')); // Event Authority PDA
      
      // NOTE: Pool-specific accounts (vaults, pools, etc.) should NOT be here
      // They should be in DEX-specific ALTs via collectDexPoolAccounts()
      
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
   * Collect pools for a specific DEX sorted by liquidity/TVL
   * @param dex DEX to collect pools for
   * @param poolType Type of pools to collect (amm, clmm, or both)
   * @param maxPools Maximum number of pools to collect (default 30)
   * @returns Array of PublicKeys for all accounts needed for the top pools
   */
  async collectDexPoolAccounts(
    dex: 'raydium' | 'orca' | 'meteora' | 'meteora-balanced',
    poolType: 'amm' | 'clmm' | 'both' = 'both',
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

      // Filter edges by DEX and pool type
      let filtered = snapshot.edges.filter(edge => {
        const edgeDex = String(edge.dex || '').toLowerCase();
        const dexMatch = edgeDex === dex.toLowerCase() || 
                        (dex === 'meteora' && edgeDex === 'meteora') ||
                        (dex === 'orca' && edgeDex === 'orca');
        
        if (!dexMatch) return false;
        
        if (poolType === 'both') return true;
        return edge.pool_kind === poolType;
      });

      // Sort by liquidity metrics (tvl_usd > liquidity_display > pool_liquidity_raw > liquidity)
      filtered.sort((a, b) => {
        const getLiquidity = (edge: any): number => {
          if (edge.tvl_usd && edge.tvl_usd > 0) return edge.tvl_usd;
          if (edge.liquidity_display && edge.liquidity_display > 0) return edge.liquidity_display;
          if (edge.pool_liquidity_raw && edge.pool_liquidity_raw > 0) return edge.pool_liquidity_raw;
          if (edge.liquidity && edge.liquidity > 0) return edge.liquidity;
          return 0;
        };
        return getLiquidity(b) - getLiquidity(a);
      });

      // Take top N pools (deduplicate by pool_id)
      const poolIds = new Set<string>();
      const topPools: any[] = [];
      
      for (const edge of filtered) {
        if (!edge.pool_id) continue;
        if (poolIds.has(edge.pool_id)) continue;
        poolIds.add(edge.pool_id);
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
      // Strip directional suffixes (-rev, -fwd) from pool_id
      const cleanPoolId = poolId.replace(/-(rev|fwd)$/, '');
      const poolPk = new PublicKey(cleanPoolId);
      accounts.push(poolPk);

      const dexLower = dex.toLowerCase();

      if (dexLower === 'raydium') {
        // Fetch pool account data to determine if AMM or CLMM
        try {
          const poolInfo = await withRpcLimit(() => connection.getAccountInfo(poolPk));
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
          const poolInfo = await withRpcLimit(() => connection.getAccountInfo(poolPk));
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
          const poolInfo = await withRpcLimit(() => connection.getAccountInfo(poolPk));
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
          const poolInfo = await withRpcLimit(() => connection.getAccountInfo(poolPk));
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
      // Import Orca SDK
      const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
      if (!sdk || !poolInfo) return accounts;

      const { ParsableWhirlpool } = sdk as any;
      if (!ParsableWhirlpool || typeof ParsableWhirlpool.parse !== 'function') return accounts;

      // Parse whirlpool state
      const parsed = ParsableWhirlpool.parse(poolPk, poolInfo);
      if (!parsed) return accounts;

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

      // Try to parse pool state to get token mints and active bin
      // Meteora pool layout (rough structure based on on-chain observations):
      // First 8 bytes: discriminator
      // Then various fields including mints, reserves, bin step, active id, etc.
      let tokenXMint: PublicKey | null = null;
      let tokenYMint: PublicKey | null = null;
      let activeId: number | null = null;
      let binStep: number | null = null;

      try {
        // Try to read mint addresses (at fixed offsets if layout is stable)
        // This is fragile but better than nothing
        const data = poolInfo.data;
        if (data.length >= 200) {
          // Typical offsets (may vary by version):
          // tokenXMint: around offset 72-104
          // tokenYMint: around offset 104-136
          try {
            tokenXMint = new PublicKey(data.slice(72, 104));
          } catch {}
          try {
            tokenYMint = new PublicKey(data.slice(104, 136));
          } catch {}
          
          // Active ID is typically a i32 or i24 around offset 180-184
          try {
            activeId = data.readInt32LE(180);
          } catch {}
          
          // Bin step is typically a u16 around offset 176-178
          try {
            binStep = data.readUInt16LE(176);
          } catch {}
        }
      } catch {}

      if (reserveX) accounts.push(reserveX);
      if (reserveY) accounts.push(reserveY);
      if (oracle) accounts.push(oracle);
      if (tokenXMint) accounts.push(tokenXMint);
      if (tokenYMint) accounts.push(tokenYMint);

      // Derive bitmapExtension (if it exists)
      // BitmapExtension PDA: [b"bitmap_extension", lb_pair.key()]
      try {
        const [bitmapExt] = PublicKey.findProgramAddressSync(
          [Buffer.from('bitmap_extension'), poolPk.toBuffer()],
          programId
        );
        // Check if it exists on-chain before adding
        const connection = getConnection();
        const bitmapInfo = await withRpcLimit(() => connection.getAccountInfo(bitmapExt), 0.5).catch(() => null);
        if (bitmapInfo) {
          accounts.push(bitmapExt);
        }
      } catch {}

      // Note: Bin arrays are calculated dynamically based on active bin
      // We could pre-calculate a few bin arrays around the active bin, but they change over time
      // For now, just add the static accounts

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
    const result = await withRpcLimit(() => 
      connection.getAddressLookupTable(altPk)
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
    const altSeed = seed || `${category}-alt`;

    // Check if ALT already exists for this category
    if (this.altAddresses.has(category)) {
      throw new Error(`ALT with category "${category}" already exists. Use extendAlt() instead.`);
    }

    // Create and extend the ALT
    const address = await this.createAltOnChain(wallet, accountPks, altSeed);

    // Get the account count
    const connection = getConnection();
    const result = await withRpcLimit(() => 
      connection.getAddressLookupTable(address)
    ).catch(() => ({ value: null }));

    const accountCount = result.value?.state?.addresses?.length || 0;

    // CRITICAL: Add to our tracking map immediately
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
              // Save updated config to remove invalid ALT
              await saveAltConfig(this.altConfig);
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
    const altAccount = await withRpcLimit(() => 
      connection.getAddressLookupTable(altPk)
    );

    if (!altAccount.value) {
      throw new Error(`ALT not found on-chain: ${altPk.toBase58()}`);
    }

    const accountInfo = await withRpcLimit(() => 
      connection.getAccountInfo(altPk)
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
      const currentSlot = await withRpcLimit(() => connection.getSlot());
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
    const tx = new Transaction().add(deactivateIx);
    const { blockhash } = await withRpcLimit(() => 
      connection.getLatestBlockhash()
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(() => 
      connection.sendRawTransaction(tx.serialize())
    );

    // Wait for confirmation
    await withRpcLimit(() => 
      connection.confirmTransaction(signature, 'confirmed')
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
    const altAccount = await withRpcLimit(() => 
      connection.getAddressLookupTable(altPk)
    );
    
    if (!altAccount.value) {
      throw new Error(`ALT not found on-chain: ${altPk.toBase58()}`);
    }

    if (altAccount.value.state.deactivationSlot === undefined) {
      throw new Error('ALT has not been deactivated yet. Call deactivateAlt() first.');
    }

    // Get current slot to verify enough time has passed
    const currentSlot = await withRpcLimit(() => connection.getSlot());
    const slotsSinceDeactivation = currentSlot - Number(altAccount.value.state.deactivationSlot);
    
    if (slotsSinceDeactivation < 513) {
      const slotsRemaining = 513 - slotsSinceDeactivation;
      const minutesRemaining = Math.ceil((slotsRemaining * 0.4) / 60); // ~0.4s per slot
      throw new Error(
        `ALT cannot be closed yet. Wait ${slotsRemaining} more slots (~${minutesRemaining} minutes)`
      );
    }

    // Get account info to calculate rent recovered
    const accountInfo = await withRpcLimit(() => 
      connection.getAccountInfo(altPk)
    );
    const rentRecovered = accountInfo?.lamports || 0;

    // Create close instruction
    const closeIx = AddressLookupTableProgram.closeLookupTable({
      lookupTable: altPk,
      authority: wallet.publicKey,
      recipient: recipient || wallet.publicKey,
    });

    // Create and send transaction
    const tx = new Transaction().add(closeIx);
    const { blockhash } = await withRpcLimit(() => 
      connection.getLatestBlockhash()
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await withRpcLimit(() => 
      connection.sendRawTransaction(tx.serialize())
    );

    // Wait for confirmation
    await withRpcLimit(() => 
      connection.confirmTransaction(signature, 'confirmed')
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
}

// Singleton instance
export const dexAltManager = new DexAltManager();

// Initialize on import
dexAltManager.initialize().catch(() => {});

