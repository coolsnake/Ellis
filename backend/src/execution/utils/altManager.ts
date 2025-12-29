import { Connection, PublicKey, AddressLookupTableAccount, TransactionMessage, VersionedTransaction, AddressLookupTableProgram, Transaction, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';
import { accountCache } from './accountCache.js';
import { loadAltConfig, saveAltConfig, type AltConfig, type DexAltSet } from './altConfig.js';

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
          const connection = getConnection();
          const invalidCategories: string[] = [];
          
          if (this.altConfig.alts) {
            for (const [category, address] of Object.entries(this.altConfig.alts)) {
              if (!address) continue;
              try {
                const pk = new PublicKey(address);
                
                // CRITICAL: Validate that the ALT actually exists on-chain
                // This prevents stale references to deleted ALTs
                const altAccount = await withRpcLimit(
                  () => connection.getAddressLookupTable(pk),
                  1,
                  { module: 'alt', method: 'getAddressLookupTable' }
                );
                
                if (!altAccount.value) {
                  // ALT has been closed/deleted, mark for removal
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
                  continue;
                }
                
                // ALT is valid, add it to our maps
                this.altAddresses.set(category, pk);
                // CRITICAL: Also cache the ALT account for getCachedAltByAddress()
                this.altAccounts.set(address, altAccount.value);
              } catch (e) {
                // Invalid address or RPC error, skip it
                invalidCategories.push(category);
                try {
                  logger.warn('alt.manager.init.alt.error', {
                    cat: 'tx',
                    ctx: {
                      category,
                      address,
                      error: String((e as any)?.message || e),
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
      
      // Check ALT config for existing addresses first
      try {
        const config = await loadAltConfig();
        if (config.alts) {
          for (const [category, address] of Object.entries(config.alts)) {
            if (!address) continue;
            try {
              const altPk = new PublicKey(address);
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
                  
                  // Return the ALT address - caller will handle storing
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
  private async collectCommonAccounts(): Promise<PublicKey[]> {
    const accounts: PublicKey[] = [];

    try {
      // ============================================
      // 1. SYSTEM PROGRAMS (appear in every transaction)
      // ============================================
      accounts.push(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')); // Token Program
      accounts.push(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')); // Token-2022 Program
      accounts.push(new PublicKey('11111111111111111111111111111111'));             // System Program
      accounts.push(new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')); // ATA Program
      accounts.push(new PublicKey('ComputeBudget111111111111111111111111111111'));   // Compute Budget Program
      accounts.push(new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'));   // Memo Program (Meteora swap2)
      accounts.push(new PublicKey('Sysvar1nstructions1111111111111111111111111'));   // Instructions Sysvar (flash_borrow)
      accounts.push(new PublicKey('SysvarRent111111111111111111111111111111111'));   // Rent Sysvar

      // ============================================
      // 2. DEX PROGRAM IDs (appear in every DEX swap)
      // ============================================
      // Raydium programs
      if ((CONFIG as any)?.raydium?.ammV4Program) {
        accounts.push(new PublicKey((CONFIG as any).raydium.ammV4Program));
      }
      if ((CONFIG as any)?.raydium?.ammV5Program) {
        accounts.push(new PublicKey((CONFIG as any).raydium.ammV5Program));
      }
      if ((CONFIG as any)?.raydium?.clmmProgram) {
        accounts.push(new PublicKey((CONFIG as any).raydium.clmmProgram));
      } else {
        // Default Raydium CLMM program
        accounts.push(new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'));
      }
      
      // Orca Whirlpool program
      if ((CONFIG as any)?.orca?.programId) {
        accounts.push(new PublicKey((CONFIG as any).orca.programId));
      } else {
        accounts.push(new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'));
      }
      
      // Meteora DLMM program
      if ((CONFIG as any)?.meteora?.programId) {
        accounts.push(new PublicKey((CONFIG as any).meteora.programId));
      } else {
        accounts.push(new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'));
      }

      // ============================================
      // 3. DEX-SPECIFIC SHARED ACCOUNTS
      // ============================================
      // Meteora Event Authority PDA (appears in EVERY Meteora swap)
      accounts.push(new PublicKey('D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6'));
      
      // Common Raydium AMM configs (shared across many pools)
      const raydiumConfigs = [
        'HVSwB6sML94MBWaHNrfmLMo3ZstLYvbnqRtMRdupCrXJ', // Common CLMM config
        'GjLEiquek1Nc2YjcBhufUGFRkaqW1JhaGjsdFd8mys38', // Another common config
      ];
      for (const config of raydiumConfigs) {
        try { accounts.push(new PublicKey(config)); } catch {}
      }

      // ============================================
      // 4. HIGH-FREQUENCY TOKEN MINTS
      // ============================================
      const commonMints = [
        'So11111111111111111111111111111111111111112',   // SOL (wSOL)
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
        'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH (Wormhole)
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC (Wormhole)
        'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
        'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  // RENDER
      ];

      for (const mint of commonMints) {
        try {
          accounts.push(new PublicKey(mint));
        } catch {}
      }

      // ============================================
      // 5. ROUTER PROGRAM (if configured)
      // ============================================
      if ((CONFIG as any)?.router?.programId) {
        try {
          accounts.push(new PublicKey((CONFIG as any).router.programId));
        } catch {}
      }

      try {
        logger.info('alt.manager.collect.common.complete', {
          cat: 'tx',
          ctx: { accountCount: accounts.length },
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
    dex: 'raydium' | 'orca' | 'meteora',
    maxPoolsTotal: number = 100
  ): Promise<DexAltSet> {
    const { ensureWallet } = await import('../../wallet/wallet.js');
    const wallet = await ensureWallet(CONFIG.walletPath);
    
    // Maximum accounts per ALT (Solana limit is 256, leave room for growth)
    const MAX_ACCOUNTS_PER_ALT = 230;
    
    // Estimated accounts per pool by DEX
    const ACCOUNTS_PER_POOL: Record<string, number> = {
      raydium: 12,  // pool, config, vaults, mints, observation, tick arrays
      orca: 10,     // pool, vaults, mints, oracle, tick arrays
      meteora: 10,  // pair, reserves, mints, oracle, bin arrays
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

      // Filter and sort edges for this DEX
      let filtered = snapshot.edges.filter(edge => {
        const edgeDex = String(edge.dex || '').toLowerCase();
        return edgeDex === dex.toLowerCase();
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

      // Add bin arrays around the active bin
      // Bin arrays are PDAs that follow a deterministic pattern
      if (activeId !== null && binStep !== null) {
        try {
          const binIdToBinArrayIndex = DLMM?.binIdToBinArrayIndex;
          const deriveBinArray = DLMM?.deriveBinArray;
          
          if (binIdToBinArrayIndex && deriveBinArray) {
            // Calculate the bin array index for the active bin
            const activeBinArrayIndex = binIdToBinArrayIndex(new BN(activeId));
            const index = activeBinArrayIndex instanceof BN ? activeBinArrayIndex.toNumber() : Number(activeBinArrayIndex);
            
            // Add bin arrays in a range around the active bin (e.g., -5 to +5)
            // Reduced range to avoid too many RPC calls
            const binArrayRange = 5;
            const binArraysToCheck: Array<{ index: number; pk: PublicKey }> = [];
            
            // First, derive all bin arrays we want to check
            for (let i = index - binArrayRange; i <= index + binArrayRange; i++) {
              try {
                const binArrayPda = deriveBinArray(poolPk, new BN(i), programId);
                let binArrayPk: PublicKey;
                
                if (binArrayPda instanceof PublicKey) {
                  binArrayPk = binArrayPda;
                } else if (Array.isArray(binArrayPda)) {
                  binArrayPk = binArrayPda[0];
                } else {
                  binArrayPk = new PublicKey(binArrayPda);
                }
                
                binArraysToCheck.push({ index: i, pk: binArrayPk });
              } catch {}
            }
            
            // Batch check existence (getMultipleAccountsInfo is more efficient)
            if (binArraysToCheck.length > 0) {
              const connection = getConnection();
              try {
                const accountInfos = await withRpcLimit(
                  () => connection.getMultipleAccountsInfo(binArraysToCheck.map(b => b.pk)),
                  1.0,
                  { module: 'alt', method: 'getMultipleAccountsInfo' }
                ).catch(() => null);
                
                if (accountInfos) {
                  const binArraysAdded: string[] = [];
                  accountInfos.forEach((info, idx) => {
                    if (info) {
                      const binArray = binArraysToCheck[idx];
                      accounts.push(binArray.pk);
                      binArraysAdded.push(`${binArray.index}:${binArray.pk.toBase58().substring(0, 8)}`);
                    }
                  });
                  
                  try {
                    logger.debug('alt.manager.meteora.dlmm.bin_arrays.added', {
                      cat: 'tx',
                      ctx: {
                        pool: poolPk.toBase58(),
                        activeId,
                        activeBinArrayIndex: index,
                        binArraysAdded: binArraysAdded.length,
                        binArraysChecked: binArraysToCheck.length,
                        range: `${index - binArrayRange} to ${index + binArrayRange}`,
                        sample: binArraysAdded.slice(0, 5),
                      },
                    });
                  } catch {}
                }
              } catch (batchError) {
                // Fallback to individual checks if batch fails
                try {
                  logger.debug('alt.manager.meteora.dlmm.bin_arrays.batch_failed_fallback', {
                    cat: 'tx',
                    ctx: { pool: poolPk.toBase58(), error: String((batchError as any)?.message || batchError) },
                  });
                } catch {}
                
                const binArraysAdded: string[] = [];
                for (const binArray of binArraysToCheck) {
                  try {
                    const binArrayInfo = await withRpcLimit(
                      () => connection.getAccountInfo(binArray.pk),
                      0.3,
                      { module: 'alt', method: 'getAccountInfo' }
                    ).catch(() => null);
                    
                    if (binArrayInfo) {
                      accounts.push(binArray.pk);
                      binArraysAdded.push(`${binArray.index}:${binArray.pk.toBase58().substring(0, 8)}`);
                    }
                  } catch {}
                }
                
                try {
                  logger.debug('alt.manager.meteora.dlmm.bin_arrays.added', {
                    cat: 'tx',
                    ctx: {
                      pool: poolPk.toBase58(),
                      activeId,
                      activeBinArrayIndex: index,
                      binArraysAdded: binArraysAdded.length,
                      range: `${index - binArrayRange} to ${index + binArrayRange}`,
                      fallback: true,
                    },
                  });
                } catch {}
              }
            }
          }
        } catch (error) {
          try {
            logger.debug('alt.manager.meteora.dlmm.bin_arrays.failed', {
              cat: 'tx',
              ctx: { pool: poolPk.toBase58(), error: String((error as any)?.message || error) },
            });
          } catch {}
        }
      }

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
   */
  async preloadAllAltAccounts(): Promise<{ loaded: number; failed: number }> {
    const connection = getConnection();
    const addresses = this.getAllAltAddresses();
    let loaded = 0;
    let failed = 0;

    if (addresses.length === 0) {
      return { loaded: 0, failed: 0 };
    }

    // Load all ALTs in parallel for faster startup
    const results = await Promise.allSettled(
      addresses.map(async (addr) => {
        try {
          const pk = new PublicKey(addr);
          const result = await connection.getAddressLookupTable(pk);
          if (result.value) {
            this.altAccounts.set(addr, result.value);
            return { addr, success: true, accountCount: result.value.state.addresses.length };
          }
          return { addr, success: false };
        } catch (e) {
          return { addr, success: false, error: e };
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
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
    const result = await withRpcLimit(() => 
      connection.getAddressLookupTable(address)
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

      // Start background refresh to keep cache fresh (every 60 seconds)
      this.startBackgroundRefresh(60000);

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

