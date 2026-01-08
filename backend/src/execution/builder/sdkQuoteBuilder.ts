/**
 * SDK Quote Builder
 *
 * Uses DEX SDK quote methods to get accurate tick/bin arrays and accounts
 * for router transaction building. This provides validated accounts directly
 * from the SDKs rather than relying on cached values.
 *
 * Supported DEXes:
 * - Orca Whirlpool: swapQuoteByInputToken() for tick arrays
 * - Raydium CLMM: Pool state + tick array bitmap for tick arrays
 * - Meteora DLMM: DLMM.create() + getBinArrays() for bin arrays
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { address } from '@solana/kit';
import { rpcFromUrl } from '@orca-so/tx-sender';
import BN from 'bn.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { getConnection } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import type { DirectHop } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

const RAYDIUM_TICK_ARRAY_SIZE = 60;
const RAYDIUM_BITMAP_RANGE = 512;
const RAYDIUM_BITMAP_WORDS = 16;

// ============================================================================
// Types
// ============================================================================

/**
 * Accounts provided by SDK quote methods
 */
export interface SdkProvidedAccounts {
  // Orca Whirlpool
  tickArray0?: string;
  tickArray1?: string;
  tickArray2?: string;
  oracle?: string;

  // Raydium CLMM
  tickArrayLower?: string;
  tickArrayCenter?: string;
  tickArrayUpper?: string;
  observationState?: string;
  exBitmap?: string;
  ammConfig?: string;

  // Meteora DLMM
  binArrays?: string[];
  activeId?: number;
  binArrayLower?: string;
  binArrayUpper?: string;

  // Common
  vaultA?: string;
  vaultB?: string;
}

/**
 * Result from SDK quote operation
 */
export interface SdkQuoteResult {
  success: boolean;
  accounts: SdkProvidedAccounts;
  quotedAmountOut?: bigint;
  error?: string;
}

// ============================================================================
// Cached SDK Imports
// ============================================================================

// Orca SDK v4 components (uses @solana/kit)
let OrcaSwapInstructions: any = null;
let OrcaSetRpc: any = null;
let orcaSdkInitialized = false;

// Raydium SDK components
let RaydiumClmmLayout: any = null;
let RaydiumTickQuery: any = null;
let RaydiumTickArrayBitmapExtensionLayout: any = null;
let RaydiumGetPdaTickArrayAddress: any = null;
let RaydiumPoolUtils: any = null;
let RaydiumGetPdaExBitmapAccount: any = null;
let raydiumSdkInitialized = false;

// Raydium constants for exBitmap determination
const RAYDIUM_TICK_ARRAY_SIZE_CONST = 60;
const RAYDIUM_TICK_ARRAY_BITMAP_SIZE_CONST = 512;

// Meteora SDK component
let MeteoraDLMM: any = null;
let meteoraSdkInitialized = false;

/**
 * Initialize Orca SDK v4 components (lazy loaded)
 * The new SDK uses @solana/kit instead of @solana/web3.js
 */
async function initOrcaSdk(): Promise<boolean> {
  if (orcaSdkInitialized && OrcaSwapInstructions) return true;
  orcaSdkInitialized = true;

  try {
    logger.info('sdkQuoteBuilder.orca.init.starting', { cat: 'tx', sdk: 'v4' });
    const orcaSdk = await import('@orca-so/whirlpools');

    // Log available exports
    const allKeys = Object.keys(orcaSdk);
    logger.info('sdkQuoteBuilder.orca.init.module_keys', {
      cat: 'tx',
      keys: allKeys.slice(0, 20),
      totalKeys: allKeys.length,
    });

    OrcaSwapInstructions = (orcaSdk as any).swapInstructions;
    OrcaSetRpc = (orcaSdk as any).setRpc;

    logger.info('sdkQuoteBuilder.orca.init.components', {
      cat: 'tx',
      hasSwapInstructions: !!OrcaSwapInstructions,
      hasSetRpc: !!OrcaSetRpc,
    });

    if (!OrcaSwapInstructions) {
      logger.warn('sdkQuoteBuilder.orca.init.missing_swapInstructions', { cat: 'tx' });
      return false;
    }

    logger.info('sdkQuoteBuilder.orca.init.success', { cat: 'tx', sdk: 'v4' });
    return true;
  } catch (e: any) {
    logger.error('sdkQuoteBuilder.orca.init.error', {
      cat: 'tx',
      error: e?.message || String(e),
      stack: e?.stack?.slice(0, 500),
    });
    return false;
  }
}

/**
 * Initialize Raydium SDK components (lazy loaded)
 */
async function initRaydiumSdk(): Promise<boolean> {
  if (raydiumSdkInitialized) return !!RaydiumClmmLayout;
  raydiumSdkInitialized = true;

  try {
    // Import the main SDK
    const raydiumSdk = await import('@raydium-io/raydium-sdk-v2');

    // Try to get PoolInfoLayout
    try {
      const layoutModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js');
      RaydiumClmmLayout = layoutModule.PoolInfoLayout;
      RaydiumTickArrayBitmapExtensionLayout = layoutModule.TickArrayBitmapExtensionLayout;
    } catch {
      RaydiumClmmLayout = (raydiumSdk as any)?.PoolInfoLayout ||
                         (raydiumSdk as any)?.Clmm?.PoolInfoLayout;
    }

    // Try to get TickQuery for fetching tick arrays
    try {
      const tickQueryModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/clmm/utils/tickQuery.js');
      RaydiumTickQuery = tickQueryModule.TickQuery;
    } catch {
      RaydiumTickQuery = (raydiumSdk as any)?.TickQuery ||
                        (raydiumSdk as any)?.Clmm?.TickQuery;
    }

    // Try to import tick array PDA derivation
    RaydiumGetPdaTickArrayAddress = (raydiumSdk as any).getPdaTickArrayAddress
      || (raydiumSdk as any).CLMM?.getPdaTickArrayAddress
      || (raydiumSdk as any).Clmm?.getPdaTickArrayAddress;

    // Import PoolUtils for isOverflowDefaultTickarrayBitmap
    RaydiumPoolUtils = (raydiumSdk as any).PoolUtils;

    // Import getPdaExBitmapAccount for proper exBitmap PDA derivation
    RaydiumGetPdaExBitmapAccount = (raydiumSdk as any).getPdaExBitmapAccount;

    logger.info('sdkQuoteBuilder.raydium.init.success', {
      cat: 'tx',
      hasLayout: !!RaydiumClmmLayout,
      hasTickQuery: !!RaydiumTickQuery,
      hasBitmapLayout: !!RaydiumTickArrayBitmapExtensionLayout,
      hasPdaFn: !!RaydiumGetPdaTickArrayAddress,
      hasPoolUtils: !!RaydiumPoolUtils,
      hasExBitmapPda: !!RaydiumGetPdaExBitmapAccount,
    });
    return !!RaydiumClmmLayout;
  } catch (e) {
    logCatchError('sdkQuoteBuilder.raydium.init', e);
    return false;
  }
}

/**
 * Initialize Meteora SDK components (lazy loaded)
 */
async function initMeteoraSdk(): Promise<boolean> {
  // Don't skip on previous failure - allow retry
  if (meteoraSdkInitialized && MeteoraDLMM) return true;
  meteoraSdkInitialized = true;

  try {
    logger.info('sdkQuoteBuilder.meteora.init.starting', { cat: 'tx' });
    const meteoraModule = await import('@meteora-ag/dlmm');

    // Log all keys for debugging
    const allKeys = Object.keys(meteoraModule);
    logger.info('sdkQuoteBuilder.meteora.init.module_keys', {
      cat: 'tx',
      keys: allKeys.slice(0, 20),
      totalKeys: allKeys.length,
      hasDefault: 'default' in meteoraModule,
      defaultType: typeof (meteoraModule as any).default,
    });

    // Try multiple ways to find the DLMM class
    const defaultExport = (meteoraModule as any).default;
    const dlmmNamed = (meteoraModule as any).DLMM;

    // Check if default export has create method
    if (defaultExport && typeof defaultExport.create === 'function') {
      MeteoraDLMM = defaultExport;
      logger.info('sdkQuoteBuilder.meteora.init.found_default', { cat: 'tx' });
    }
    // Check if DLMM named export has create method
    else if (dlmmNamed && typeof dlmmNamed.create === 'function') {
      MeteoraDLMM = dlmmNamed;
      logger.info('sdkQuoteBuilder.meteora.init.found_named', { cat: 'tx' });
    }
    // Check if default export is the class itself (callable)
    else if (defaultExport && typeof defaultExport === 'function') {
      MeteoraDLMM = defaultExport;
      logger.info('sdkQuoteBuilder.meteora.init.found_class', { cat: 'tx' });
    }
    // Last resort: check for createProgram
    else if ((meteoraModule as any).createProgram) {
      // Store the module for alternative approach
      MeteoraDLMM = meteoraModule;
      logger.info('sdkQuoteBuilder.meteora.init.found_createProgram', { cat: 'tx' });
    }

    // Log what we ended up with
    const hasCreate = MeteoraDLMM && (
      typeof MeteoraDLMM.create === 'function' ||
      typeof MeteoraDLMM.createProgram === 'function'
    );
    logger.info('sdkQuoteBuilder.meteora.init.result', {
      cat: 'tx',
      hasDLMM: !!MeteoraDLMM,
      hasCreate,
      dlmmType: typeof MeteoraDLMM,
      dlmmKeys: MeteoraDLMM ? Object.keys(MeteoraDLMM).slice(0, 15) : [],
    });

    if (!MeteoraDLMM) {
      logger.warn('sdkQuoteBuilder.meteora.init.missing_dlmm', { cat: 'tx' });
      return false;
    }

    logger.info('sdkQuoteBuilder.meteora.init.success', { cat: 'tx' });
    return true;
  } catch (e: any) {
    logger.error('sdkQuoteBuilder.meteora.init.error', {
      cat: 'tx',
      error: e?.message || String(e),
      stack: e?.stack?.slice(0, 500),
    });
    return false;
  }
}

// ============================================================================
// Orca SDK Quote (v4 - uses @solana/kit)
// ============================================================================

/**
 * Create an RPC adapter for @solana/kit from @solana/web3.js Connection
 * The new SDK expects @solana/kit style RPC with .send() builder pattern
 * Data must be returned as Uint8Array (not Buffer) and encoded as base64
 */
function createKitRpcAdapter(connection: Connection): any {
  // @solana/kit uses a builder pattern: rpc.method(args).send()
  // We create methods that return an object with send() that does the actual call
  return {
    getAccountInfo: (address: string, config?: any) => ({
      send: async () => {
        const pubkey = new PublicKey(address);
        const info = await connection.getAccountInfo(pubkey, config?.commitment);
        if (!info) return { value: null };
        // @solana/kit expects data as [base64String, encoding] tuple
        const dataBase64 = Buffer.from(info.data).toString('base64');
        return {
          value: {
            data: [dataBase64, 'base64'] as [string, string],
            executable: info.executable,
            lamports: BigInt(info.lamports),
            owner: info.owner.toBase58(),
            rentEpoch: info.rentEpoch ? BigInt(info.rentEpoch) : 0n,
          },
        };
      },
    }),
    getMultipleAccounts: (addresses: string[], config?: any) => ({
      send: async () => {
        const pubkeys = addresses.map((a: string) => new PublicKey(a));
        const infos = await connection.getMultipleAccountsInfo(pubkeys, config?.commitment);
        return {
          value: infos.map(info => {
            if (!info) return null;
            const dataBase64 = Buffer.from(info.data).toString('base64');
            return {
              data: [dataBase64, 'base64'] as [string, string],
              executable: info.executable,
              lamports: BigInt(info.lamports),
              owner: info.owner.toBase58(),
              rentEpoch: info.rentEpoch ? BigInt(info.rentEpoch) : 0n,
            };
          }),
        };
      },
    }),
    getMinimumBalanceForRentExemption: (dataLength: bigint) => ({
      send: async () => {
        const balance = await connection.getMinimumBalanceForRentExemption(Number(dataLength));
        return { value: BigInt(balance) };
      },
    }),
    getEpochInfo: () => ({
      send: async () => {
        const info = await connection.getEpochInfo();
        return {
          value: {
            absoluteSlot: BigInt(info.absoluteSlot),
            blockHeight: BigInt(info.blockHeight ?? 0),
            epoch: BigInt(info.epoch),
            slotIndex: BigInt(info.slotIndex),
            slotsInEpoch: BigInt(info.slotsInEpoch),
          },
        };
      },
    }),
  };
}

/**
 * Get Orca Whirlpool accounts via SDK v4 quote
 * Uses rpcFromUrl from @orca-so/tx-sender for proper @solana/kit compatibility
 */
async function getOrcaSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');

  try {
    const sdkAvailable = await initOrcaSdk();
    if (!sdkAvailable || !OrcaSwapInstructions) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK v4 not available',
      };
    }

    // Use proper @solana/kit RPC from tx-sender (like ix.ts does)
    // This avoids issues with custom RPC adapter type mismatches
    const rpcUrl = String(CONFIG.readRpcUrl || CONFIG.rpcUrl || '').trim();
    const rpc = rpcFromUrl(rpcUrl);

    // Use swap amount from hop (or a minimal amount for account discovery)
    // Ensure it's a native bigint (not BN or other object)
    const amountIn = hop.amountInRaw && hop.amountInRaw > 0n
      ? BigInt(hop.amountInRaw.toString())
      : 1000n; // Minimal amount for discovery

    // Convert to proper @solana/kit Address types
    const poolAddress = address(poolId);
    const inputMint = address(hop.inputMint);

    // Call swapInstructions with proper @solana/kit types
    const swapResult = await OrcaSwapInstructions(
      rpc,
      { inputAmount: amountIn, mint: inputMint },
      poolAddress,
      100, // 1% slippage tolerance in bps
    );

    if (!swapResult || !swapResult.instructions || swapResult.instructions.length === 0) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK v4 returned no instructions',
      };
    }

    // Extract tick arrays from the swap instruction accounts
    // SDK may return Swap (11 accounts) or SwapV2 (15+ accounts) instructions
    // Swap: [tokenProgram, tokenAuthority, whirlpool, tokenOwnerAccountA, tokenVaultA, 
    //        tokenOwnerAccountB, tokenVaultB, tickArray0, tickArray1, tickArray2, oracle]
    // SwapV2: [tokenProgramA, tokenProgramB, memoProgram, tokenAuthority, whirlpool, tokenMintA,
    //          tokenMintB, tokenOwnerAccountA, tokenVaultA, tokenOwnerAccountB, tokenVaultB,
    //          tickArray0, tickArray1, tickArray2, oracle]
    const swapIx = swapResult.instructions.find((ix: any) =>
      ix.programAddress === ORCA_WHIRLPOOL_PROGRAM.toBase58()
    );

    if (!swapIx || !swapIx.accounts) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK v4 swap instruction has unexpected format',
      };
    }

    // Helper to extract address from various formats
    const extractAddress = (acct: any): string | undefined => {
      if (!acct) return undefined;
      if (typeof acct === 'string') return acct;
      if (typeof acct.address === 'string') return acct.address;
      if (typeof acct.toBase58 === 'function') return acct.toBase58();
      return undefined;
    };

    // Extract accounts - first try named properties (SDK v4 format), then fall back to indices
    const ixAccounts = swapIx.accounts;
    const isSwapV2 = Array.isArray(ixAccounts) && ixAccounts.length >= 15;

    // Account indices differ between Swap and SwapV2
    // Swap:   tickArray0=7,  tickArray1=8,  tickArray2=9,  oracle=10, vaultA=4, vaultB=6
    // SwapV2: tickArray0=11, tickArray1=12, tickArray2=13, oracle=14, vaultA=8, vaultB=10
    const tickArray0Idx = isSwapV2 ? 11 : 7;
    const tickArray1Idx = isSwapV2 ? 12 : 8;
    const tickArray2Idx = isSwapV2 ? 13 : 9;
    const oracleIdx = isSwapV2 ? 14 : 10;
    const vaultAIdx = isSwapV2 ? 8 : 4;
    const vaultBIdx = isSwapV2 ? 10 : 6;

    const accounts: SdkProvidedAccounts = {
      // Try named properties first (SDK may return object with named accounts)
      tickArray0: extractAddress(ixAccounts.tickArray0) ?? extractAddress(ixAccounts[tickArray0Idx]),
      tickArray1: extractAddress(ixAccounts.tickArray1) ?? extractAddress(ixAccounts[tickArray1Idx]),
      tickArray2: extractAddress(ixAccounts.tickArray2) ?? extractAddress(ixAccounts[tickArray2Idx]),
      oracle: extractAddress(ixAccounts.oracle) ?? extractAddress(ixAccounts[oracleIdx]),
      vaultA: extractAddress(ixAccounts.tokenVaultA) ?? extractAddress(ixAccounts[vaultAIdx]),
      vaultB: extractAddress(ixAccounts.tokenVaultB) ?? extractAddress(ixAccounts[vaultBIdx]),
    };

    // Log account extraction for debugging
    logger.debug('sdkQuoteBuilder.orca.quote.accounts_extracted', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        isSwapV2,
        accountCount: Array.isArray(ixAccounts) ? ixAccounts.length : Object.keys(ixAccounts).length,
        hasNamedOracle: !!ixAccounts.oracle,
        oracleIdx,
        extractedOracle: accounts.oracle?.slice(0, 12) + '...',
        extractedTickArrays: [
          accounts.tickArray0?.slice(0, 8),
          accounts.tickArray1?.slice(0, 8),
          accounts.tickArray2?.slice(0, 8),
        ],
      },
    });

    // Get quoted amount from the result - handle various SDK return formats
    // SDK v4 ExactInSwapQuote has: tokenIn, tokenEstOut, tokenMinOut, tradeFee, etc.
    let quotedAmountOut: bigint | undefined;
    try {
      const rawQuote = swapResult.quote?.tokenEstOut ?? swapResult.quote?.tokenEstB ?? swapResult.quote?.estimatedAmountOut ?? swapResult.quote?.amountOut;
      if (rawQuote !== undefined && rawQuote !== null) {
        // Handle different possible formats: bigint, number, string, BN-like object
        if (typeof rawQuote === 'bigint') {
          quotedAmountOut = rawQuote;
        } else if (typeof rawQuote === 'number') {
          quotedAmountOut = BigInt(Math.floor(rawQuote));
        } else if (typeof rawQuote === 'string') {
          quotedAmountOut = BigInt(rawQuote);
        } else if (typeof rawQuote === 'object') {
          // BN-like object with toString() or value property
          const strVal = rawQuote.toString?.() ?? rawQuote.value?.toString?.() ?? String(rawQuote);
          // Clean up any non-numeric characters
          const numericStr = strVal.replace(/[^0-9-]/g, '');
          if (numericStr && numericStr !== '-') {
            quotedAmountOut = BigInt(numericStr);
          }
        }
      }
    } catch (e) {
      // Ignore quote extraction errors - we have the accounts which is what we need
      logger.debug('sdkQuoteBuilder.orca.quote.amount_extraction_failed', { cat: 'tx', error: (e as Error).message });
    }

    logger.info('sdkQuoteBuilder.orca.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        tickArray0: accounts.tickArray0?.slice(0, 12) + '...',
        oracle: accounts.oracle?.slice(0, 12) + '...',
        quotedOut: quotedAmountOut?.toString(),
        ixAccountCount: Array.isArray(ixAccounts) ? ixAccounts.length : Object.keys(ixAccounts).length,
        isSwapV2,
      },
    });

    return {
      success: true,
      accounts,
      quotedAmountOut,
    };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.orca.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// Raydium SDK Quote
// ============================================================================

/**
 * Derive Raydium tick array PDA
 */
function deriveRaydiumTickArrayPda(
  poolId: PublicKey,
  startTickIndex: number,
  programId: PublicKey = RAYDIUM_CLMM_PROGRAM
): PublicKey {
  // Try SDK method first
  if (RaydiumGetPdaTickArrayAddress) {
    try {
      const result = RaydiumGetPdaTickArrayAddress(programId, poolId, startTickIndex);
      const pk = result?.publicKey || result;
      if (pk) return pk;
    } catch { /* fall through */ }
  }

  // Manual derivation
  const startTickBuffer = Buffer.alloc(4);
  startTickBuffer.writeInt32LE(startTickIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
    programId
  );
  return pda;
}

/**
 * Decode Raydium tick array bitmap to find initialized indices
 */
function decodeRaydiumTickArrayBitmap(bitmap: (bigint | string | number)[]): number[] {
  if (!bitmap || !Array.isArray(bitmap) || bitmap.length !== RAYDIUM_BITMAP_WORDS) {
    return [];
  }

  const initializedIndices: number[] = [];

  for (let wordIdx = 0; wordIdx < RAYDIUM_BITMAP_WORDS; wordIdx++) {
    const word = BigInt(bitmap[wordIdx] || 0);
    if (word === 0n) continue;

    const baseIndex = -RAYDIUM_BITMAP_RANGE + (wordIdx * 64);

    for (let bit = 0; bit < 64; bit++) {
      if ((word >> BigInt(bit)) & 1n) {
        initializedIndices.push(baseIndex + bit);
      }
    }
  }

  return initializedIndices;
}

/**
 * Get Raydium CLMM accounts via SDK
 */
async function getRaydiumSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);
  const programId = hop.programId ? new PublicKey(hop.programId) : RAYDIUM_CLMM_PROGRAM;

  try {
    const sdkAvailable = await initRaydiumSdk();
    if (!sdkAvailable || !RaydiumClmmLayout) {
      return {
        success: false,
        accounts: {},
        error: 'Raydium SDK not available',
      };
    }

    // Fetch pool account
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) {
      return {
        success: false,
        accounts: {},
        error: 'Raydium pool account not found',
      };
    }

    // Decode pool state
    let state: any;
    try {
      state = RaydiumClmmLayout.decode(accountInfo.data);
    } catch (decodeErr) {
      return {
        success: false,
        accounts: {},
        error: `Failed to decode Raydium pool: ${(decodeErr as Error).message}`,
      };
    }

    const tickCurrent = Number(state.tickCurrent ?? state.tick_current ?? 0);
    const tickSpacing = Number(state.tickSpacing ?? state.tick_spacing ?? 0);

    if (tickSpacing <= 0) {
      return {
        success: false,
        accounts: {},
        error: `Invalid tick spacing: ${tickSpacing}`,
      };
    }

    // Extract ammConfig
    const ammConfigPk = state.ammConfig ?? state.amm_config;
    const ammConfig = ammConfigPk
      ? (typeof ammConfigPk === 'string' ? ammConfigPk : ammConfigPk.toBase58?.() ?? new PublicKey(ammConfigPk).toBase58())
      : undefined;

    // Extract observationState
    const observationPk = state.observationId ?? state.observation_id ?? state.observationKey;
    const observationState = observationPk
      ? (typeof observationPk === 'string' ? observationPk : observationPk.toBase58?.() ?? new PublicKey(observationPk).toBase58())
      : undefined;

    // Extract vaults
    const vaultA = state.tokenVault0?.toBase58?.() || state.token_vault_0?.toBase58?.();
    const vaultB = state.tokenVault1?.toBase58?.() || state.token_vault_1?.toBase58?.();

    // Calculate tick array indices
    // The "center" tick array contains the current tick and MUST be provided first for swaps
    const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(tickCurrent / ticksInArray);
    const currentTickArrayStart = centerIdx * ticksInArray;

    // Get tick array bitmap from pool state
    const tickArrayBitmapArray = state.tickArrayBitmap ?? state.tick_array_bitmap ?? [];

    // Determine if exBitmap is needed using SDK's PoolUtils (computational - no RPC!)
    // exBitmap is required when tick arrays are outside the default bitmap range
    // Default bitmap covers: [-tickSpacing * 60 * 512, +tickSpacing * 60 * 512)
    let needsExBitmap = false;
    let exBitmapPda: PublicKey | null = null;
    let exBitmapAddress: string | undefined;
    let exTickArrayBitmap: any = undefined;

    // Derive exBitmap PDA using SDK or manual derivation
    if (RaydiumGetPdaExBitmapAccount) {
      try {
        const result = RaydiumGetPdaExBitmapAccount(programId, poolPk);
        exBitmapPda = result.publicKey;
      } catch {
        // Fallback to manual derivation with correct seed
        [exBitmapPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('pool_tick_array_bitmap_extension'), poolPk.toBuffer()],
          programId
        );
      }
    } else {
      // Manual derivation with correct seed
      [exBitmapPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_tick_array_bitmap_extension'), poolPk.toBuffer()],
        programId
      );
    }

    // Use SDK's computational method to check if exBitmap is needed FOR THE SWAP (no RPC!)
    // This determines whether we include exBitmap in the final accounts
    if (RaydiumPoolUtils && typeof RaydiumPoolUtils.isOverflowDefaultTickarrayBitmap === 'function') {
      try {
        needsExBitmap = RaydiumPoolUtils.isOverflowDefaultTickarrayBitmap(tickSpacing, [tickCurrent]);
        logger.debug('sdkQuoteBuilder.raydium.exBitmap.sdkCheck', {
          cat: 'tx',
          ctx: { poolId: poolId.slice(0, 8), tickCurrent, tickSpacing, needsExBitmap },
        });
      } catch (e) {
        // Fallback to manual calculation
        const maxTickInBitmap = tickSpacing * RAYDIUM_TICK_ARRAY_SIZE_CONST * RAYDIUM_TICK_ARRAY_BITMAP_SIZE_CONST;
        needsExBitmap = tickCurrent < -maxTickInBitmap || tickCurrent >= maxTickInBitmap;
      }
    } else {
      // Manual calculation if SDK method not available
      const maxTickInBitmap = tickSpacing * RAYDIUM_TICK_ARRAY_SIZE_CONST * RAYDIUM_TICK_ARRAY_BITMAP_SIZE_CONST;
      needsExBitmap = tickCurrent < -maxTickInBitmap || tickCurrent >= maxTickInBitmap;
    }

    // ALWAYS try to fetch exBitmap for SDK tick array discovery
    // The SDK's getTickArrays() internally accesses exTickArrayBitmap properties
    // even when the swap itself doesn't need it included in accounts
    let exBitmapExists = false;
    if (exBitmapPda && RaydiumTickArrayBitmapExtensionLayout) {
      try {
        const exBitmapInfo = await connection.getAccountInfo(exBitmapPda);
        if (exBitmapInfo && exBitmapInfo.data) {
          exTickArrayBitmap = RaydiumTickArrayBitmapExtensionLayout.decode(exBitmapInfo.data);
          exBitmapExists = true;
          // Only set exBitmapAddress if the swap actually needs it
          if (needsExBitmap) {
            exBitmapAddress = exBitmapPda.toBase58();
          }
          logger.debug('sdkQuoteBuilder.raydium.exBitmap.fetched', {
            cat: 'tx',
            ctx: { 
              poolId: poolId.slice(0, 8), 
              exBitmap: exBitmapPda.toBase58().slice(0, 8),
              needsExBitmap,
              willIncludeInAccounts: needsExBitmap,
            },
          });
        }
      } catch { /* exBitmap doesn't exist */ }
    }

    // Warn if exBitmap is needed for swap but doesn't exist
    if (needsExBitmap && !exBitmapExists) {
      logger.warn('sdkQuoteBuilder.raydium.exBitmap.needed_but_missing', {
        cat: 'tx',
        ctx: { poolId: poolId.slice(0, 8), tickCurrent, tickSpacing, exBitmapPda: exBitmapPda?.toBase58() },
      });
    }

    // Try to use SDK's TickQuery.getTickArrays() for proper tick array discovery
    // The SDK returns an object keyed by start tick index (as string)
    let tickArrayMap = new Map<number, string>();

    if (RaydiumTickQuery && typeof RaydiumTickQuery.getTickArrays === 'function') {
      try {

        // Use SDK to get tick arrays
        const tickArrayCache = await RaydiumTickQuery.getTickArrays(
          connection,
          programId,
          poolPk,
          tickCurrent,
          tickSpacing,
          tickArrayBitmapArray,
          exTickArrayBitmap
        );

        // Extract addresses from the cache
        // The SDK returns an object keyed by start tick index (e.g., "-20400")
        const rawKeys = Object.keys(tickArrayCache);

        for (const key of rawKeys) {
          // Parse the start tick index from the key
          const startTick = parseInt(key, 10);
          if (isNaN(startTick)) continue;

          const entry = tickArrayCache[key];
          if (!entry) continue;

          // Extract address from entry - it might have publicKey, address, or be the address itself
          const addr = entry.publicKey ?? entry.address ?? entry;
          let addressStr: string | null = null;

          if (typeof addr === 'string' && addr.length >= 32 && addr.length <= 44) {
            try {
              new PublicKey(addr);
              addressStr = addr;
            } catch { /* not valid */ }
          } else if (typeof addr?.toBase58 === 'function') {
            addressStr = addr.toBase58();
          } else if (addr instanceof PublicKey) {
            addressStr = addr.toBase58();
          }

          if (addressStr) {
            tickArrayMap.set(startTick, addressStr);
          }
        }

        logger.info('sdkQuoteBuilder.raydium.quote.sdk_tick_arrays', {
          cat: 'tx',
          ctx: {
            poolId: poolId.slice(0, 8),
            rawKeyCount: rawKeys.length,
            validTickArrayCount: tickArrayMap.size,
            tickCurrent,
            tickSpacing,
            currentTickArrayStart,
            addresses: Array.from(tickArrayMap.values()).slice(0, 5).map(a => a.slice(0, 8)),
            sampleRawKey: rawKeys[0]?.slice(0, 20),
          },
        });
      } catch (e) {
        logger.warn('sdkQuoteBuilder.raydium.quote.sdk_failed', {
          cat: 'tx',
          error: (e as Error).message,
        });
      }
    }

    // Get the center tick array (the one containing the current tick)
    // This MUST be provided first for Raydium CLMM swaps
    let centerAddress = tickArrayMap.get(currentTickArrayStart);
    let lowerAddress = tickArrayMap.get(currentTickArrayStart - ticksInArray);
    let upperAddress = tickArrayMap.get(currentTickArrayStart + ticksInArray);

    // If center isn't in SDK map but SDK has tick arrays, use the closest ones
    // This handles liquidity gaps where the "expected" tick array doesn't exist on-chain
    if (!centerAddress && tickArrayMap.size > 0) {
      const sortedStartTicks = Array.from(tickArrayMap.keys()).sort((a, b) => a - b);
      
      // Find tick arrays closest to where current tick should be
      let closestBelowIdx = -1;
      let closestAboveIdx = -1;
      
      for (let i = 0; i < sortedStartTicks.length; i++) {
        if (sortedStartTicks[i] <= currentTickArrayStart) {
          closestBelowIdx = i;
        }
        if (sortedStartTicks[i] >= currentTickArrayStart && closestAboveIdx === -1) {
          closestAboveIdx = i;
        }
      }
      
      // Use closest available as center, and adjacent ones for lower/upper
      const centerIdx = closestBelowIdx >= 0 ? closestBelowIdx : closestAboveIdx;
      if (centerIdx >= 0) {
        const centerStartTick = sortedStartTicks[centerIdx];
        centerAddress = tickArrayMap.get(centerStartTick);
        
        // Get adjacent from SDK if available
        if (centerIdx > 0) {
          lowerAddress = tickArrayMap.get(sortedStartTicks[centerIdx - 1]);
        }
        if (centerIdx < sortedStartTicks.length - 1) {
          upperAddress = tickArrayMap.get(sortedStartTicks[centerIdx + 1]);
        }
        
        logger.warn('sdkQuoteBuilder.raydium.quote.using_nearest_tick_arrays', {
          cat: 'tx',
          ctx: {
            poolId: poolId.slice(0, 8),
            tickCurrent,
            tickSpacing,
            expectedCenter: currentTickArrayStart,
            actualCenter: centerStartTick,
            offset: centerStartTick - currentTickArrayStart,
            sdkArrayCount: sortedStartTicks.length,
            hint: 'Using nearest SDK tick arrays - pool may have liquidity gap',
          },
        });
      }
    }

    // Only derive manually if SDK returned NO tick arrays at all
    // This is the "first fetch" case where we haven't discovered tick arrays yet
    if (!centerAddress && tickArrayMap.size === 0) {
      logger.info('sdkQuoteBuilder.raydium.quote.manual_derivation', {
        cat: 'tx',
        ctx: { 
          poolId: poolId.slice(0, 8), 
          tickCurrent, 
          tickSpacing, 
          currentTickArrayStart,
          hint: 'No SDK tick arrays available - deriving manually',
        },
      });

      // Derive center, lower, upper tick arrays
      centerAddress = deriveRaydiumTickArrayPda(poolPk, currentTickArrayStart, programId).toBase58();
      lowerAddress = deriveRaydiumTickArrayPda(poolPk, currentTickArrayStart - ticksInArray, programId).toBase58();
      upperAddress = deriveRaydiumTickArrayPda(poolPk, currentTickArrayStart + ticksInArray, programId).toBase58();
    } else if (centerAddress) {
      // SDK provided center, derive any missing adjacent arrays
      if (!lowerAddress) {
        lowerAddress = deriveRaydiumTickArrayPda(poolPk, currentTickArrayStart - ticksInArray, programId).toBase58();
      }
      if (!upperAddress) {
        upperAddress = deriveRaydiumTickArrayPda(poolPk, currentTickArrayStart + ticksInArray, programId).toBase58();
      }
    }

    // Create center, lower, upper objects
    const center = { address: centerAddress };
    const lower = lowerAddress ? { address: lowerAddress } : undefined;
    const upper = upperAddress ? { address: upperAddress } : undefined;

    // exBitmap is already computed above using SDK's isOverflowDefaultTickarrayBitmap
    // Only include it if it's actually needed AND exists on-chain
    const accounts: SdkProvidedAccounts = {
      tickArrayCenter: center.address,
      tickArrayLower: lower?.address,
      tickArrayUpper: upper?.address,
      observationState,
      ammConfig,
      exBitmap: exBitmapAddress, // Only set if needed AND fetched successfully
      vaultA,
      vaultB,
    };

    logger.info('sdkQuoteBuilder.raydium.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        tickCurrent,
        tickSpacing,
        tickArraysFound: tickArrayMap.size,
        needsExBitmap,
        hasExBitmap: !!exBitmapAddress,
        exBitmapMethod: RaydiumPoolUtils ? 'sdk' : 'manual',
        center: center.address.slice(0, 8),
        lower: lower?.address?.slice(0, 8),
        upper: upper?.address?.slice(0, 8),
      },
    });

    return {
      success: true,
      accounts,
    };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.raydium.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// Meteora SDK Quote
// ============================================================================

/**
 * Get Meteora DLMM accounts via SDK
 */
async function getMeteoraSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);

  try {
    const sdkAvailable = await initMeteoraSdk();
    if (!sdkAvailable || !MeteoraDLMM) {
      return {
        success: false,
        accounts: {},
        error: 'Meteora SDK not available',
      };
    }

    // Try different ways to create pool instance
    let dlmmPool: any = null;
    let activeId: number = 0;
    let binStep: number = 0;

    // Method 1: DLMM.create (standard SDK method)
    const createFn = MeteoraDLMM?.create || MeteoraDLMM?.DLMM?.create;
    if (createFn && typeof createFn === 'function') {
      try {
        dlmmPool = await createFn(connection, poolPk);
        logger.debug('sdkQuoteBuilder.meteora.quote.used_create', { cat: 'tx' });
      } catch (e) {
        logger.debug('sdkQuoteBuilder.meteora.quote.create_failed', { cat: 'tx', error: (e as Error).message });
      }
    }

    // Method 2: createProgram + manual decode (fallback)
    if (!dlmmPool) {
      const createProgram = MeteoraDLMM?.createProgram;
      if (createProgram && typeof createProgram === 'function') {
        try {
          const program = createProgram(connection);
          const accountInfo = await connection.getAccountInfo(poolPk);
          if (accountInfo && accountInfo.data) {
            const state = program.coder.accounts.decode('lbPair', accountInfo.data);
            activeId = Number(state.activeId ?? 0);
            binStep = Number(state.binStep ?? 0);
            logger.debug('sdkQuoteBuilder.meteora.quote.used_createProgram', { cat: 'tx', activeId, binStep });
          }
        } catch (e) {
          logger.debug('sdkQuoteBuilder.meteora.quote.createProgram_failed', { cat: 'tx', error: (e as Error).message });
        }
      }
    }

    // Method 3: Direct account fetch and manual decode
    if (!dlmmPool && activeId === 0) {
      try {
        const accountInfo = await connection.getAccountInfo(poolPk);
        if (accountInfo && accountInfo.data) {
          // Try to read activeId and binStep from known offsets
          // LbPair layout: activeId is at offset 136 (i32), binStep is at offset 140 (u16)
          const data = Buffer.from(accountInfo.data);
          if (data.length >= 142) {
            activeId = data.readInt32LE(136);
            binStep = data.readUInt16LE(140);
            logger.debug('sdkQuoteBuilder.meteora.quote.manual_decode', { cat: 'tx', activeId, binStep });
          }
        }
      } catch (e) {
        logger.debug('sdkQuoteBuilder.meteora.quote.manual_decode_failed', { cat: 'tx', error: (e as Error).message });
      }
    }

    // If we have dlmmPool, use its methods
    if (dlmmPool) {
      // Get active bin
      try {
        const activeBin = await dlmmPool.getActiveBin();
        activeId = activeBin?.binId ?? dlmmPool.lbPair?.activeId ?? activeId;
        binStep = dlmmPool.lbPair?.binStep ?? binStep;
      } catch { /* use defaults */ }
    }

    if (activeId === 0) {
      return {
        success: false,
        accounts: {},
        error: 'Could not determine Meteora pool activeId',
      };
    }

    // Get bin arrays - try SDK first, then manual derivation
    // OPTIMIZATION: Only keep bin arrays near the active bin to reduce transaction size
    // routerTx will select the correct directional subset based on swap direction
    const BIN_ARRAY_SIZE = 70;
    const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
    const MAX_BIN_ARRAY_RANGE = 3; // Keep 3 arrays in each direction (7 total max)
    
    let binArrayAddresses: string[] = [];

    // Try getting bin arrays from dlmmPool if available
    if (dlmmPool) {
      try {
        const binArrays = await dlmmPool.getBinArrays();
        if (Array.isArray(binArrays)) {
          const totalFromSdk = binArrays.length;
          
          // SDK returns ALL bin arrays - filter to those near active bin for efficiency
          const binArraysWithIndex = binArrays
            .map((ba: any) => {
              const addr = typeof ba.publicKey?.toBase58 === 'function'
                ? ba.publicKey.toBase58()
                : String(ba.publicKey || ba.address);
              // Try to get the bin array index from the account data
              const binArrayIndex = ba.account?.index ?? ba.index ?? null;
              return { addr, index: binArrayIndex };
            })
            .filter((item: { addr: string; index: number | null }) => {
              // If we have index info, filter to nearby arrays only
              if (typeof item.index === 'number') {
                return Math.abs(item.index - activeIndex) <= MAX_BIN_ARRAY_RANGE;
              }
              return true; // Keep if we can't determine index
            })
            .slice(0, 7); // Hard cap at 7 bin arrays
          
          // Sort by index (low to high) so routerTx can select directionally
          binArraysWithIndex.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          binArrayAddresses = binArraysWithIndex.map(item => item.addr);
            
          logger.debug('sdkQuoteBuilder.meteora.quote.bin_arrays_from_sdk', { 
            cat: 'tx', 
            totalFromSdk,
            filtered: binArrayAddresses.length,
            activeIndex,
            indices: binArraysWithIndex.map(item => item.index),
          });
        }
      } catch (e) {
        logger.debug('sdkQuoteBuilder.meteora.quote.getBinArrays_failed', { cat: 'tx', error: (e as Error).message });
      }
    }

    // Fallback: derive bin arrays manually with optimized range
    if (binArrayAddresses.length === 0) {
      const RANGE = MAX_BIN_ARRAY_RANGE; // Use same range as SDK filtering (was 5, now 3)

      const derivedArrays: PublicKey[] = [];

      for (let i = activeIndex - RANGE; i <= activeIndex + RANGE; i++) {
        try {
          const idxBn = new BN(i);
          const seed = idxBn.isNeg()
            ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
            : idxBn.toArrayLike(Buffer, 'le', 8);

          const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('bin_array'), poolPk.toBuffer(), seed],
            METEORA_DLMM_PROGRAM
          );
          derivedArrays.push(pda);
        } catch { /* ignore */ }
      }

      // Verify existence
      const infos = await connection.getMultipleAccountsInfo(derivedArrays);
      for (let i = 0; i < derivedArrays.length; i++) {
        if (infos[i] && infos[i]!.owner.equals(METEORA_DLMM_PROGRAM)) {
          binArrayAddresses.push(derivedArrays[i].toBase58());
        }
      }
      logger.debug('sdkQuoteBuilder.meteora.quote.bin_arrays_manual', { 
        cat: 'tx', 
        derived: derivedArrays.length,
        verified: binArrayAddresses.length,
        activeIndex,
      });
    }

    if (binArrayAddresses.length === 0) {
      return {
        success: false,
        accounts: {},
        error: 'No bin arrays found for Meteora pool',
      };
    }

    // Get vaults from pool data if available
    let vaultA: string | undefined;
    let vaultB: string | undefined;
    if (dlmmPool?.lbPair) {
      const lbPair = dlmmPool.lbPair;
      vaultA = lbPair?.reserveX?.toBase58?.() || lbPair?.reserve_x?.toBase58?.();
      vaultB = lbPair?.reserveY?.toBase58?.() || lbPair?.reserve_y?.toBase58?.();
    }

    // Cap bin arrays to prevent transaction bloat
    // routerTx will select the correct directional subset based on swap direction
    const cappedBinArrays = binArrayAddresses.slice(0, 7);
    
    const accounts: SdkProvidedAccounts = {
      binArrays: cappedBinArrays,
      activeId,
      binArrayLower: cappedBinArrays[0],
      binArrayUpper: cappedBinArrays[cappedBinArrays.length - 1],
      vaultA,
      vaultB,
    };

    logger.info('sdkQuoteBuilder.meteora.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        activeId,
        binStep,
        binArraysProvided: cappedBinArrays.length,
      },
    });

    return {
      success: true,
      accounts,
    };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.meteora.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Get SDK-provided accounts for a hop
 * Routes to the appropriate DEX SDK based on hop.dex
 */
export async function getSdkQuoteAccounts(hop: DirectHop): Promise<SdkQuoteResult> {
  const connection = getConnection();
  const dex = hop.dex?.toLowerCase();

  switch (dex) {
    case 'orca':
      return getOrcaSdkQuote(connection, hop);

    case 'raydium':
      if (hop.variant === 'clmm') {
        return getRaydiumSdkQuote(connection, hop);
      }
      // Raydium AMM doesn't need SDK quotes (constant product)
      return {
        success: true,
        accounts: {},
      };

    case 'meteora':
      return getMeteoraSdkQuote(connection, hop);

    case 'meteora_balanced':
      // Meteora DAMM doesn't need SDK quotes (constant product)
      return {
        success: true,
        accounts: {},
      };

    case 'pumpswap':
      // PumpSwap doesn't need SDK quotes (constant product)
      return {
        success: true,
        accounts: {},
      };

    default:
      return {
        success: false,
        accounts: {},
        error: `Unsupported DEX for SDK quote: ${dex}`,
      };
  }
}

/**
 * Get SDK-provided accounts for all hops in an execution plan
 * Runs all hop quotes in parallel for reduced latency
 */
export async function getSdkQuoteAccountsForPlan(
  hops: DirectHop[]
): Promise<{ success: boolean; results: SdkQuoteResult[]; error?: string }> {
  // Run all hop SDK quotes in parallel
  const results = await Promise.all(
    hops.map(hop => getSdkQuoteAccounts(hop))
  );

  // Check for any failures and return first error found
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result.success) {
      return {
        success: false,
        results,
        error: `Hop ${i} (${hops[i].dex}/${hops[i].poolId.slice(0, 8)}...): ${result.error}`,
      };
    }
  }

  return {
    success: true,
    results,
  };
}

/**
 * Pre-warm all SDK imports at startup
 * This avoids lazy initialization overhead on first execution
 */
export async function warmupSdks(): Promise<void> {
  const startMs = Date.now();
  
  await Promise.all([
    initOrcaSdk(),
    initRaydiumSdk(),
    initMeteoraSdk(),
  ]);
  
  const elapsed = Date.now() - startMs;
  logger.info('sdkQuoteBuilder.warmup.complete', { 
    cat: 'tx', 
    elapsed_ms: elapsed,
  });
}
