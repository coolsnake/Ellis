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
const RAYDIUM_AMM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const METEORA_DAMM_V1_PROGRAM = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
const METEORA_DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
// Use the post-graduation AMM program (not bonding curve) for Pumpswap
const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Import pre-computed PDA from SDK for accuracy
import { GLOBAL_CONFIG_PDA as PUMPSWAP_GLOBAL_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';

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

  // Raydium AMM v4 (Serum/OpenBook market accounts)
  ammAuthority?: string;
  openOrders?: string;
  targetOrders?: string;
  marketId?: string;
  marketProgramId?: string;
  serumBids?: string;
  serumAsks?: string;
  serumEventQueue?: string;
  serumCoinVault?: string;
  serumPcVault?: string;
  serumVaultSigner?: string;

  // Meteora DLMM
  binArrays?: string[];
  activeId?: number;
  binArrayLower?: string;
  binArrayUpper?: string;

  // Meteora DAMM (v1/v2)
  poolAuthority?: string;
  lpMint?: string;
  // Meteora DAMM v1 - Mercurial Vault accounts
  aVault?: string;           // Mercurial Vault account for token A
  bVault?: string;           // Mercurial Vault account for token B
  aTokenVault?: string;      // SPL Token account inside aVault
  bTokenVault?: string;      // SPL Token account inside bVault
  aVaultLpMint?: string;     // LP token mint of vault A
  bVaultLpMint?: string;     // LP token mint of vault B
  aVaultLp?: string;         // Pool's LP token account for vault A
  bVaultLp?: string;         // Pool's LP token account for vault B
  protocolTokenAFee?: string; // Protocol fee account for token A
  protocolTokenBFee?: string; // Protocol fee account for token B
  vaultProgram?: string;     // Mercurial Vault program ID

  // PumpSwap
  globalConfig?: string;
  protocolFeeRecipient?: string;
  bondingCurve?: string;
  associatedBondingCurve?: string;

  // Common
  vaultA?: string;
  vaultB?: string;

  // Quote results (for reference)
  expectedAmountOut?: bigint;
  priceImpact?: number;
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
// AMM SDK Cached Imports
// ============================================================================

// Raydium AMM v4 SDK components
let RaydiumAmmLayout: any = null;
let RaydiumLiquidity: any = null;
let raydiumAmmSdkInitialized = false;

// Meteora DAMM SDK components (v1 = Dynamic AMM, v2 = CP-AMM)
let MeteoraDynamicAmm: any = null;
let MeteoraCpAmm: any = null;
let meteoraDammV1Initialized = false;
let meteoraDammV2Initialized = false;

// PumpSwap SDK components
let PumpSwapSdk: any = null;
let pumpswapSdkInitialized = false;

/**
 * Initialize Raydium AMM v4 SDK components (lazy loaded)
 * Used for fetching Serum/OpenBook market accounts
 */
async function initRaydiumAmmSdk(): Promise<boolean> {
  if (raydiumAmmSdkInitialized) return !!RaydiumAmmLayout;
  raydiumAmmSdkInitialized = true;

  try {
    const raydiumSdk = await import('@raydium-io/raydium-sdk-v2');
    
    // Try to get AMM pool layout
    RaydiumLiquidity = (raydiumSdk as any).Liquidity 
      || (raydiumSdk as any).AmmV4 
      || (raydiumSdk as any).Amm;
    
    // Try to get layout for manual decoding
    try {
      const layoutModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/liquidity/layout.js');
      RaydiumAmmLayout = layoutModule.liquidityStateV4Layout;
    } catch {
      // Fallback - try from main export
      RaydiumAmmLayout = (raydiumSdk as any).liquidityStateV4Layout
        || (raydiumSdk as any).LIQUIDITY_STATE_LAYOUT_V4
        || (raydiumSdk as any).Liquidity?.LIQUIDITY_STATE_LAYOUT_V4;
    }

    logger.info('sdkQuoteBuilder.raydiumAmm.init.success', {
      cat: 'tx',
      hasLayout: !!RaydiumAmmLayout,
      hasLiquidity: !!RaydiumLiquidity,
    });
    return !!RaydiumAmmLayout || !!RaydiumLiquidity;
  } catch (e) {
    logCatchError('sdkQuoteBuilder.raydiumAmm.init', e);
    return false;
  }
}

/**
 * Initialize Meteora Dynamic AMM SDK (DAMM v1)
 */
async function initMeteoraDammV1Sdk(): Promise<boolean> {
  if (meteoraDammV1Initialized && MeteoraDynamicAmm) return true;
  meteoraDammV1Initialized = true;

  try {
    const dynamicAmmModule = await import('@meteora-ag/dynamic-amm-sdk');
    MeteoraDynamicAmm = dynamicAmmModule.default || dynamicAmmModule;
    
    logger.info('sdkQuoteBuilder.meteoraDammV1.init.success', {
      cat: 'tx',
      hasCreate: typeof MeteoraDynamicAmm?.create === 'function',
    });
    return !!MeteoraDynamicAmm;
  } catch (e) {
    logCatchError('sdkQuoteBuilder.meteoraDammV1.init', e);
    return false;
  }
}

/**
 * Initialize Meteora CP-AMM SDK (DAMM v2)
 */
async function initMeteoraDammV2Sdk(): Promise<boolean> {
  if (meteoraDammV2Initialized && MeteoraCpAmm) return true;
  meteoraDammV2Initialized = true;

  try {
    const cpAmmModule = await import('@meteora-ag/cp-amm-sdk');
    MeteoraCpAmm = (cpAmmModule as any).CpAmm || cpAmmModule.default || cpAmmModule;
    
    logger.info('sdkQuoteBuilder.meteoraDammV2.init.success', {
      cat: 'tx',
      hasCpAmm: !!MeteoraCpAmm,
    });
    return !!MeteoraCpAmm;
  } catch (e) {
    logCatchError('sdkQuoteBuilder.meteoraDammV2.init', e);
    return false;
  }
}

/**
 * Initialize PumpSwap SDK
 */
async function initPumpswapSdk(): Promise<boolean> {
  if (pumpswapSdkInitialized && PumpSwapSdk) return true;
  pumpswapSdkInitialized = true;

  try {
    // Try to import PumpSwap SDK
    const pumpModule = await import('@pump-fun/pump-swap-sdk');
    PumpSwapSdk = pumpModule.default || pumpModule;
    
    logger.info('sdkQuoteBuilder.pumpswap.init.success', {
      cat: 'tx',
      hasSdk: !!PumpSwapSdk,
      keys: PumpSwapSdk ? Object.keys(PumpSwapSdk).slice(0, 10) : [],
    });
    return !!PumpSwapSdk;
  } catch (e) {
    // PumpSwap SDK may not be installed - this is optional
    logger.debug('sdkQuoteBuilder.pumpswap.init.not_available', {
      cat: 'tx',
      error: (e as Error).message,
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
// Raydium AMM v4 SDK Quote
// ============================================================================

/**
 * Get Raydium AMM v4 accounts via SDK
 * Fetches Serum/OpenBook market accounts which are required for swaps
 */
async function getRaydiumAmmSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);

  try {
    const sdkAvailable = await initRaydiumAmmSdk();
    
    // Even if SDK not available, we can still fetch and decode the pool state manually
    const accountInfo = await connection.getAccountInfo(poolPk);
    if (!accountInfo || !accountInfo.data) {
      return {
        success: false,
        accounts: {},
        error: 'Raydium AMM pool account not found',
      };
    }

    // Raydium AMM v4 pool layout (key offsets for accounts):
    // The state contains: status, nonce, orderNum, depth, coinDecimals, pcDecimals,
    // state, resetFlag, minSize, volMaxCutRatio, amountWaveRatio, coinLotSize, pcLotSize,
    // minPriceMultiplier, maxPriceMultiplier, systemDecimalValue, ... fees ...
    // poolOpenTime, punishPcAmount, punishCoinAmount, orderbookToInitTime,
    // (padding), coinVault, pcVault, coinMint, pcMint, lpMint,
    // openOrders, marketId, marketProgramId, targetOrders, ...
    
    const data = Buffer.from(accountInfo.data);
    const accounts: SdkProvidedAccounts = {};
    
    // AMM v4 layout parsing (offsets based on Raydium SDK)
    // Skip the initial 8 bytes (u64 status through orderNum, etc.) 
    // to the address fields which start around byte 336
    
    try {
      // These offsets are from the Raydium AMM v4 state layout
      let offset = 336; // Start of pubkey fields after numeric fields and padding
      
      const coinVault = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const pcVault = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const coinMint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const pcMint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const lpMint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const openOrders = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const marketId = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const marketProgramId = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      const targetOrders = new PublicKey(data.subarray(offset, offset + 32));
      
      // Store AMM accounts
      accounts.vaultA = coinVault.toBase58();
      accounts.vaultB = pcVault.toBase58();
      accounts.openOrders = openOrders.toBase58();
      accounts.targetOrders = targetOrders.toBase58();
      accounts.marketId = marketId.toBase58();
      accounts.marketProgramId = marketProgramId.toBase58();
      accounts.lpMint = lpMint.toBase58();
      
      // Raydium AMM v4 uses a GLOBAL authority, not per-pool derivation
      // The authority is hardcoded and never changes across all AMM v4 pools
      accounts.ammAuthority = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
      
      // Now fetch the Serum/OpenBook market to get remaining accounts
      const marketAccountInfo = await connection.getAccountInfo(marketId);
      if (marketAccountInfo && marketAccountInfo.data) {
        const marketData = Buffer.from(marketAccountInfo.data);
        
        // OpenBook/Serum market layout (simplified):
        // Bids at offset 40, Asks at 72, EventQueue at 136, BaseVault at 168, QuoteVault at 200
        // VaultSignerNonce at 232 (u64), then derive vault signer PDA
        if (marketData.length >= 240) {
          // Skip first 5 bytes (account flags) and padding to reach data
          const marketOffset = 13; // Serum market header offset
          
          // Read market accounts (each is 32 bytes)
          const bids = new PublicKey(marketData.subarray(marketOffset + 40, marketOffset + 72));
          const asks = new PublicKey(marketData.subarray(marketOffset + 72, marketOffset + 104));
          const eventQueue = new PublicKey(marketData.subarray(marketOffset + 136, marketOffset + 168));
          const baseVault = new PublicKey(marketData.subarray(marketOffset + 168, marketOffset + 200));
          const quoteVault = new PublicKey(marketData.subarray(marketOffset + 200, marketOffset + 232));
          
          // Read vault signer nonce (u64 at offset 232)
          const vaultSignerNonce = marketData.readBigUInt64LE(marketOffset + 232);
          
          // Derive vault signer PDA
          const [vaultSigner] = PublicKey.findProgramAddressSync(
            [marketId.toBuffer(), Buffer.from([Number(vaultSignerNonce)])],
            marketProgramId
          );
          
          accounts.serumBids = bids.toBase58();
          accounts.serumAsks = asks.toBase58();
          accounts.serumEventQueue = eventQueue.toBase58();
          accounts.serumCoinVault = baseVault.toBase58();
          accounts.serumPcVault = quoteVault.toBase58();
          accounts.serumVaultSigner = vaultSigner.toBase58();
          
          logger.info('sdkQuoteBuilder.raydiumAmm.market.decoded', {
            cat: 'tx',
            poolId: poolId.slice(0, 8) + '...',
            marketId: marketId.toBase58().slice(0, 8) + '...',
            hasSerumAccounts: true,
          });
        }
      }
      
      logger.info('sdkQuoteBuilder.raydiumAmm.quote.success', {
        cat: 'tx',
        poolId: poolId.slice(0, 8) + '...',
        hasVaults: !!(accounts.vaultA && accounts.vaultB),
        hasOpenOrders: !!accounts.openOrders,
        hasMarket: !!accounts.marketId,
        hasSerumAccounts: !!accounts.serumBids,
      });
      
      return { success: true, accounts };
    } catch (decodeErr) {
      logger.warn('sdkQuoteBuilder.raydiumAmm.decode.fallback', {
        cat: 'tx',
        error: (decodeErr as Error).message,
      });
      // Return partial success - some accounts may be populated from cache
      return { success: true, accounts };
    }
  } catch (e) {
    logCatchError('sdkQuoteBuilder.raydiumAmm.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// Meteora DAMM SDK Quote (v1/v2)
// ============================================================================

/**
 * Get Meteora DAMM v1 (Dynamic AMM) accounts via SDK
 * 
 * Meteora Dynamic AMM uses a "vault of vaults" architecture with Mercurial Vaults.
 * The swap instruction requires 15 accounts (+ program = 16 total):
 * 
 * 0:  pool
 * 1:  userSourceToken
 * 2:  userDestinationToken
 * 3:  aVault (Mercurial Vault account)
 * 4:  bVault (Mercurial Vault account)
 * 5:  aTokenVault (SPL Token account inside aVault)
 * 6:  bTokenVault (SPL Token account inside bVault)
 * 7:  aVaultLpMint (LP token mint of vault A)
 * 8:  bVaultLpMint (LP token mint of vault B)
 * 9:  aVaultLp (Pool's LP token account for vault A)
 * 10: bVaultLp (Pool's LP token account for vault B)
 * 11: protocolTokenFee (direction-dependent)
 * 12: user (signer)
 * 13: vaultProgram (Mercurial Vault program)
 * 14: tokenProgram
 */
async function getMeteoraDammV1SdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);

  try {
    const sdkAvailable = await initMeteoraDammV1Sdk();
    const accounts: SdkProvidedAccounts = {};
    
    if (sdkAvailable && MeteoraDynamicAmm) {
      try {
        // Create pool instance - this fetches pool state and vault states
        const pool = await MeteoraDynamicAmm.create(connection, poolPk);
        if (pool) {
          // Extract Mercurial Vault accounts from pool state
          // These are the vault PDAs (not the token accounts inside them)
          if (pool.poolState) {
            accounts.aVault = pool.poolState.aVault?.toBase58?.();
            accounts.bVault = pool.poolState.bVault?.toBase58?.();
            accounts.aVaultLp = pool.poolState.aVaultLp?.toBase58?.();
            accounts.bVaultLp = pool.poolState.bVaultLp?.toBase58?.();
            
            // Extract protocol fee accounts from pool state
            if (pool.poolState.protocolTokenAFee) {
              const pfa = pool.poolState.protocolTokenAFee;
              accounts.protocolTokenAFee = typeof pfa.toBase58 === 'function' ? pfa.toBase58() : new PublicKey(pfa as any).toBase58();
            }
            if (pool.poolState.protocolTokenBFee) {
              const pfb = pool.poolState.protocolTokenBFee;
              accounts.protocolTokenBFee = typeof pfb.toBase58 === 'function' ? pfb.toBase58() : new PublicKey(pfb as any).toBase58();
            }
            
            // Fallback: Derive protocol fee accounts using PDA if not available from state
            // Seeds: ['fee', tokenMint, poolAddress] - from SDK utils.deriveProtocolTokenFee
            const METEORA_DAMM_V1_PROGRAM = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
            if (!accounts.protocolTokenAFee && pool.poolState.tokenAMint) {
              const tokenAMint = pool.poolState.tokenAMint;
              const [protocolFeeA] = PublicKey.findProgramAddressSync(
                [Buffer.from('fee'), tokenAMint.toBuffer(), poolPk.toBuffer()],
                METEORA_DAMM_V1_PROGRAM
              );
              accounts.protocolTokenAFee = protocolFeeA.toBase58();
            }
            if (!accounts.protocolTokenBFee && pool.poolState.tokenBMint) {
              const tokenBMint = pool.poolState.tokenBMint;
              const [protocolFeeB] = PublicKey.findProgramAddressSync(
                [Buffer.from('fee'), tokenBMint.toBuffer(), poolPk.toBuffer()],
                METEORA_DAMM_V1_PROGRAM
              );
              accounts.protocolTokenBFee = protocolFeeB.toBase58();
            }
          }
          
          // Extract token vaults from the VaultImpl instances
          // VaultImpl has:
          // - vaultState.tokenVault: The actual on-chain token vault address (authoritative)
          // - vaultState.lpMint: The actual on-chain LP mint address
          // - tokenVaultPda: Derived PDA (should match but prefer on-chain)
          // - tokenLpMint: The Mint object (use .address)
          if (pool.vaultA) {
            // Primary: Use on-chain vaultState (authoritative)
            if (pool.vaultA.vaultState?.tokenVault) {
              const tv = pool.vaultA.vaultState.tokenVault;
              accounts.aTokenVault = typeof tv.toBase58 === 'function' ? tv.toBase58() : new PublicKey(tv as any).toBase58();
            }
            if (pool.vaultA.vaultState?.lpMint) {
              const lm = pool.vaultA.vaultState.lpMint;
              accounts.aVaultLpMint = typeof lm.toBase58 === 'function' ? lm.toBase58() : new PublicKey(lm as any).toBase58();
            }
            // Fallback: Use derived properties if on-chain not available
            if (!accounts.aTokenVault && pool.vaultA.tokenVaultPda) {
              accounts.aTokenVault = pool.vaultA.tokenVaultPda.toBase58();
            }
            if (!accounts.aVaultLpMint && pool.vaultA.tokenLpMint?.address) {
              accounts.aVaultLpMint = pool.vaultA.tokenLpMint.address.toBase58();
            }
          }
          if (pool.vaultB) {
            if (pool.vaultB.vaultState?.tokenVault) {
              const tv = pool.vaultB.vaultState.tokenVault;
              accounts.bTokenVault = typeof tv.toBase58 === 'function' ? tv.toBase58() : new PublicKey(tv as any).toBase58();
            }
            if (pool.vaultB.vaultState?.lpMint) {
              const lm = pool.vaultB.vaultState.lpMint;
              accounts.bVaultLpMint = typeof lm.toBase58 === 'function' ? lm.toBase58() : new PublicKey(lm as any).toBase58();
            }
            if (!accounts.bTokenVault && pool.vaultB.tokenVaultPda) {
              accounts.bTokenVault = pool.vaultB.tokenVaultPda.toBase58();
            }
            if (!accounts.bVaultLpMint && pool.vaultB.tokenLpMint?.address) {
              accounts.bVaultLpMint = pool.vaultB.tokenLpMint.address.toBase58();
            }
          }
          
          // Get vault program ID from the VaultImpl's program instance
          if (pool.vaultA?.['program']?.programId) {
            accounts.vaultProgram = pool.vaultA['program'].programId.toBase58();
          } else {
            // Mercurial Vault program ID (mainnet)
            accounts.vaultProgram = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
          }
          
          // Also get poolInfo data if available
          if (pool.poolInfo) {
            accounts.lpMint = pool.poolInfo.lpMint?.toBase58?.();
          }
          
          logger.info('sdkQuoteBuilder.meteoraDammV1.sdk.success', {
            cat: 'tx',
            poolId: poolId.slice(0, 8) + '...',
            hasVaults: !!(accounts.aVault && accounts.bVault),
            hasTokenVaults: !!(accounts.aTokenVault && accounts.bTokenVault),
            hasVaultLp: !!(accounts.aVaultLp && accounts.bVaultLp),
            hasVaultLpMints: !!(accounts.aVaultLpMint && accounts.bVaultLpMint),
            hasProtocolFees: !!(accounts.protocolTokenAFee && accounts.protocolTokenBFee),
            protocolTokenAFee: accounts.protocolTokenAFee,
            protocolTokenBFee: accounts.protocolTokenBFee,
            tokenAMint: pool.poolState?.tokenAMint?.toBase58?.(),
            tokenBMint: pool.poolState?.tokenBMint?.toBase58?.(),
          });
        }
      } catch (sdkErr) {
        logger.debug('sdkQuoteBuilder.meteoraDammV1.sdk.fallback', {
          cat: 'tx',
          error: (sdkErr as Error).message,
        });
      }
    }
    
    // Derive pool authority PDA (always do this as backup)
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_pda'), poolPk.toBuffer()],
      METEORA_DAMM_V1_PROGRAM
    );
    accounts.poolAuthority = authority.toBase58();
    
    // Default vault program if SDK didn't provide it
    if (!accounts.vaultProgram) {
      accounts.vaultProgram = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
    }
    
    // If SDK didn't populate vaults, try manual decode from pool account
    if (!accounts.aVault || !accounts.bVault) {
      const accountInfo = await connection.getAccountInfo(poolPk);
      if (accountInfo && accountInfo.data) {
        const data = Buffer.from(accountInfo.data);
        // DAMM v1 pool layout: after 8-byte discriminator
        // lpMint at 8, tokenAMint at 40, tokenBMint at 72, aVault at 104, bVault at 136
        // aVaultLp at 168, bVaultLp at 200
        if (data.length >= 232) {
          const lpMint = new PublicKey(data.subarray(8, 40));
          const tokenAMint = new PublicKey(data.subarray(40, 72));
          const tokenBMint = new PublicKey(data.subarray(72, 104));
          const aVault = new PublicKey(data.subarray(104, 136));
          const bVault = new PublicKey(data.subarray(136, 168));
          const aVaultLp = new PublicKey(data.subarray(168, 200));
          const bVaultLp = new PublicKey(data.subarray(200, 232));
          
          accounts.aVault = aVault.toBase58();
          accounts.bVault = bVault.toBase58();
          accounts.aVaultLp = aVaultLp.toBase58();
          accounts.bVaultLp = bVaultLp.toBase58();
          accounts.lpMint = lpMint.toBase58();
          
          // Need to fetch vault accounts to get tokenVault and lpMint
          // This is a fallback - the SDK path above is preferred
          try {
            const [aVaultInfo, bVaultInfo] = await connection.getMultipleAccountsInfo([aVault, bVault]);
            // Mercurial Vault account layout (after 8-byte Anchor discriminator):
            // - offset 8: enabled (u8, 1 byte)
            // - offset 9: bumps.vaultBump (u8, 1 byte)
            // - offset 10: bumps.tokenVaultBump (u8, 1 byte)
            // - offset 11: totalAmount (u64, 8 bytes)
            // - offset 19: tokenVault (pubkey, 32 bytes)
            // - offset 51: feeVault (pubkey, 32 bytes)
            // - offset 83: tokenMint (pubkey, 32 bytes)
            // - offset 115: lpMint (pubkey, 32 bytes)
            const VAULT_TOKEN_VAULT_OFFSET = 19;
            const VAULT_LP_MINT_OFFSET = 115;
            
            if (aVaultInfo?.data && aVaultInfo.data.length >= 147) {
              const aVaultData = Buffer.from(aVaultInfo.data);
              accounts.aTokenVault = new PublicKey(aVaultData.subarray(VAULT_TOKEN_VAULT_OFFSET, VAULT_TOKEN_VAULT_OFFSET + 32)).toBase58();
              accounts.aVaultLpMint = new PublicKey(aVaultData.subarray(VAULT_LP_MINT_OFFSET, VAULT_LP_MINT_OFFSET + 32)).toBase58();
            }
            if (bVaultInfo?.data && bVaultInfo.data.length >= 147) {
              const bVaultData = Buffer.from(bVaultInfo.data);
              accounts.bTokenVault = new PublicKey(bVaultData.subarray(VAULT_TOKEN_VAULT_OFFSET, VAULT_TOKEN_VAULT_OFFSET + 32)).toBase58();
              accounts.bVaultLpMint = new PublicKey(bVaultData.subarray(VAULT_LP_MINT_OFFSET, VAULT_LP_MINT_OFFSET + 32)).toBase58();
            }
          } catch (vaultErr) {
            logger.debug('sdkQuoteBuilder.meteoraDammV1.vaultFetch.error', {
              cat: 'tx',
              error: (vaultErr as Error).message,
            });
          }
          
          // Derive protocol fee accounts if not already set
          // protocolTokenAFee and protocolTokenBFee are in the pool state at specific offsets
          // For now, try to parse them from pool data if available
          // Pool state has protocolTokenAFee after bVaultLpBump (1 byte), enabled (1 byte)
          // Offset: 232 + some padding
          if (data.length >= 360 && !accounts.protocolTokenAFee) {
            // These offsets may need adjustment based on actual layout
            // protocolTokenAFee is typically around offset 264
            // protocolTokenBFee is typically around offset 296
            try {
              const protocolAFee = new PublicKey(data.subarray(264, 296));
              const protocolBFee = new PublicKey(data.subarray(296, 328));
              accounts.protocolTokenAFee = protocolAFee.toBase58();
              accounts.protocolTokenBFee = protocolBFee.toBase58();
            } catch {
              // Ignore parse errors for protocol fees
            }
          }
        }
      }
    }
    
    logger.info('sdkQuoteBuilder.meteoraDammV1.quote.success', {
      cat: 'tx',
      poolId: poolId.slice(0, 8) + '...',
      hasVaults: !!(accounts.aVault && accounts.bVault),
      hasTokenVaults: !!(accounts.aTokenVault && accounts.bTokenVault),
      hasAuthority: !!accounts.poolAuthority,
      hasAllAccounts: !!(
        accounts.aVault && accounts.bVault &&
        accounts.aTokenVault && accounts.bTokenVault &&
        accounts.aVaultLpMint && accounts.bVaultLpMint &&
        accounts.aVaultLp && accounts.bVaultLp &&
        accounts.protocolTokenAFee && accounts.protocolTokenBFee
      ),
    });
    
    return { success: true, accounts };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.meteoraDammV1.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Get Meteora DAMM v2 (CP-AMM) accounts via SDK
 */
async function getMeteoraDammV2SdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);

  try {
    const sdkAvailable = await initMeteoraDammV2Sdk();
    const accounts: SdkProvidedAccounts = {};
    
    if (sdkAvailable && MeteoraCpAmm) {
      try {
        // Try using the SDK
        const cpAmm = new MeteoraCpAmm(connection);
        const poolInfo = await cpAmm.getPool?.(poolPk) || await cpAmm.fetchPoolState?.(poolPk);
        if (poolInfo) {
          accounts.vaultA = poolInfo.tokenAVault?.toBase58?.() || poolInfo.aVault?.toBase58?.();
          accounts.vaultB = poolInfo.tokenBVault?.toBase58?.() || poolInfo.bVault?.toBase58?.();
          accounts.lpMint = poolInfo.lpMint?.toBase58?.();
          
          logger.info('sdkQuoteBuilder.meteoraDammV2.sdk.success', {
            cat: 'tx',
            poolId: poolId.slice(0, 8) + '...',
          });
        }
      } catch (sdkErr) {
        logger.debug('sdkQuoteBuilder.meteoraDammV2.sdk.fallback', {
          cat: 'tx',
          error: (sdkErr as Error).message,
        });
      }
    }
    
    // Derive pool authority PDA (v2 uses different seed)
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_authority'), poolPk.toBuffer()],
      METEORA_DAMM_V2_PROGRAM
    );
    accounts.poolAuthority = authority.toBase58();
    
    // If SDK didn't populate vaults, try manual decode
    if (!accounts.vaultA || !accounts.vaultB) {
      const accountInfo = await connection.getAccountInfo(poolPk);
      if (accountInfo && accountInfo.data) {
        const data = Buffer.from(accountInfo.data);
        // CP-AMM v2 pool layout may differ - try similar offsets
        if (data.length >= 168) {
          const lpMint = new PublicKey(data.subarray(8, 40));
          const tokenAMint = new PublicKey(data.subarray(40, 72));
          const tokenBMint = new PublicKey(data.subarray(72, 104));
          const aVault = new PublicKey(data.subarray(104, 136));
          const bVault = new PublicKey(data.subarray(136, 168));
          
          accounts.vaultA = aVault.toBase58();
          accounts.vaultB = bVault.toBase58();
          accounts.lpMint = lpMint.toBase58();
        }
      }
    }
    
    logger.info('sdkQuoteBuilder.meteoraDammV2.quote.success', {
      cat: 'tx',
      poolId: poolId.slice(0, 8) + '...',
      hasVaults: !!(accounts.vaultA && accounts.vaultB),
      hasAuthority: !!accounts.poolAuthority,
    });
    
    return { success: true, accounts };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.meteoraDammV2.quote', e);
    return {
      success: false,
      accounts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// PumpSwap SDK Quote
// ============================================================================

/**
 * Get PumpSwap accounts via SDK or manual derivation
 * Key account: protocolFeeRecipient
 */
async function getPumpswapSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');
  const poolPk = new PublicKey(poolId);

  try {
    const accounts: SdkProvidedAccounts = {};
    
    // Try SDK first
    const sdkAvailable = await initPumpswapSdk();
    if (sdkAvailable && PumpSwapSdk) {
      try {
        // Try to get global config and fee recipient from SDK
        if (PumpSwapSdk.getGlobalConfig) {
          const globalConfig = await PumpSwapSdk.getGlobalConfig(connection);
          if (globalConfig) {
            accounts.globalConfig = globalConfig.address?.toBase58?.() || globalConfig.publicKey?.toBase58?.();
            accounts.protocolFeeRecipient = globalConfig.protocolFeeRecipient?.toBase58?.() 
              || globalConfig.feeRecipient?.toBase58?.();
          }
        }
        
        // Try to get pool info
        if (PumpSwapSdk.getPool || PumpSwapSdk.fetchPool) {
          const poolFn = PumpSwapSdk.getPool || PumpSwapSdk.fetchPool;
          const poolInfo = await poolFn(connection, poolPk);
          if (poolInfo) {
            accounts.vaultA = poolInfo.tokenVault?.toBase58?.() || poolInfo.baseVault?.toBase58?.();
            accounts.bondingCurve = poolPk.toBase58();
          }
        }
        
        logger.info('sdkQuoteBuilder.pumpswap.sdk.success', {
          cat: 'tx',
          poolId: poolId.slice(0, 8) + '...',
          hasGlobalConfig: !!accounts.globalConfig,
          hasFeeRecipient: !!accounts.protocolFeeRecipient,
        });
      } catch (sdkErr) {
        logger.debug('sdkQuoteBuilder.pumpswap.sdk.fallback', {
          cat: 'tx',
          error: (sdkErr as Error).message,
        });
      }
    }
    
    // Use SDK's pre-computed global config PDA (only if not already set from SDK call)
    if (!accounts.globalConfig) {
      accounts.globalConfig = PUMPSWAP_GLOBAL_CONFIG_PDA.toBase58();
    }
    
    // If we don't have fee recipient from SDK, try to fetch it from global config account
    if (!accounts.protocolFeeRecipient) {
      try {
        const globalConfigPk = new PublicKey(accounts.globalConfig);
        const globalConfigInfo = await connection.getAccountInfo(globalConfigPk);
        if (globalConfigInfo && globalConfigInfo.data) {
          const data = Buffer.from(globalConfigInfo.data);
          // PumpSwap global config layout: fee recipient is typically near the start
          // Skip 8-byte discriminator, then read addresses
          if (data.length >= 72) {
            // Try offset 8 (after discriminator) for fee recipient
            const feeRecipient = new PublicKey(data.subarray(8, 40));
            if (!feeRecipient.equals(PublicKey.default)) {
              accounts.protocolFeeRecipient = feeRecipient.toBase58();
            }
          }
        }
      } catch (fetchErr) {
        logger.debug('sdkQuoteBuilder.pumpswap.globalConfig.fetch.failed', {
          cat: 'tx',
          error: (fetchErr as Error).message,
        });
      }
    }
    
    // Derive associated bonding curve if we know the mint
    // CRITICAL: Must use the correct token program based on whether the mint is Token-2022 or SPL
    const pumpMint = hop.inputMint === 'So11111111111111111111111111111111111111112' 
      ? hop.outputMint 
      : hop.inputMint;
    if (pumpMint) {
      try {
        const mintPk = new PublicKey(pumpMint);
        const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const TOKEN_PROGRAM_SPL = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const TOKEN_PROGRAM_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
        
        // Determine which token program to use based on hop.inputTokenProgram or hop.outputTokenProgram
        // PumpMint is the non-SOL token in the pair
        const pumpMintTokenProgram = hop.inputMint === 'So11111111111111111111111111111111111111112'
          ? hop.outputTokenProgram
          : hop.inputTokenProgram;
        const isToken2022 = pumpMintTokenProgram === 'token-2022' || pumpMintTokenProgram === TOKEN_PROGRAM_2022.toBase58();
        const tokenProgram = isToken2022 ? TOKEN_PROGRAM_2022 : TOKEN_PROGRAM_SPL;
        
        // ATA derivation uses: [owner, tokenProgram, mint]
        const [associatedBC] = PublicKey.findProgramAddressSync(
          [poolPk.toBuffer(), tokenProgram.toBuffer(), mintPk.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM
        );
        accounts.associatedBondingCurve = associatedBC.toBase58();
        
        // Store the token program for the builder
        (accounts as any).pumpMintTokenProgram = tokenProgram.toBase58();
        
        logger.debug('sdkQuoteBuilder.pumpswap.associatedBC.derived', {
          cat: 'tx',
          ctx: {
            poolId: poolId.slice(0, 8) + '...',
            pumpMint: pumpMint.slice(0, 8) + '...',
            isToken2022,
            tokenProgram: tokenProgram.toBase58().slice(0, 8) + '...',
            associatedBC: accounts.associatedBondingCurve.slice(0, 8) + '...',
          },
        });
      } catch (e) {
        logger.debug('sdkQuoteBuilder.pumpswap.associatedBC.derivation.failed', {
          cat: 'tx',
          error: (e as Error).message,
        });
      }
    }
    
    accounts.bondingCurve = poolPk.toBase58();
    
    logger.info('sdkQuoteBuilder.pumpswap.quote.success', {
      cat: 'tx',
      poolId: poolId.slice(0, 8) + '...',
      hasGlobalConfig: !!accounts.globalConfig,
      hasFeeRecipient: !!accounts.protocolFeeRecipient,
      hasAssociatedBC: !!accounts.associatedBondingCurve,
    });
    
    return { success: true, accounts };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.pumpswap.quote', e);
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
 * Routes to the appropriate DEX SDK based on hop.dex and hop.variant
 * 
 * CRITICAL: The variant field determines which SDK to use:
 * - Raydium: 'clmm' (default), 'amm'/'amm_v4', 'cpmm'
 * - Meteora: 'dlmm' (default), 'damm_v1', 'damm_v2'
 * 
 * If variant is not set, we check programId as fallback.
 */
export async function getSdkQuoteAccounts(hop: DirectHop): Promise<SdkQuoteResult> {
  const connection = getConnection();
  const dex = hop.dex?.toLowerCase();
  const variant = hop.variant?.toLowerCase();
  const programId = hop.programId || '';

  // Log routing decision for debugging
  logger.debug('sdkQuoteBuilder.routing', {
    cat: 'tx',
    ctx: {
      poolId: hop.poolId?.slice(0, 8) + '...',
      dex,
      variant,
      programId: programId.slice(0, 8) + '...',
    },
  });

  switch (dex) {
    case 'orca':
      return getOrcaSdkQuote(connection, hop);

    case 'raydium':
      // CPMM variant - handle first as it's most specific
      if (variant === 'cpmm') {
        logger.debug('sdkQuoteBuilder.routing.raydium.cpmm', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        // Note: CPMM doesn't need SDK quote - it's a constant product AMM
        // Return empty success to let builder derive accounts manually
        return { success: true, accounts: {} };
      }
      
      // AMM v4 variant
      if (variant === 'amm' || variant === 'amm_v4') {
        logger.debug('sdkQuoteBuilder.routing.raydium.amm', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getRaydiumAmmSdkQuote(connection, hop);
      }
      
      // CLMM variant (default for Raydium)
      if (variant === 'clmm') {
        logger.debug('sdkQuoteBuilder.routing.raydium.clmm', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getRaydiumSdkQuote(connection, hop);
      }
      
      // No variant - check program ID to determine type
      if (programId === RAYDIUM_AMM_V4_PROGRAM.toBase58() || 
          programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
        logger.debug('sdkQuoteBuilder.routing.raydium.amm_by_programId', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getRaydiumAmmSdkQuote(connection, hop);
      }
      
      // Check for CPMM program ID
      if (programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C') {
        logger.debug('sdkQuoteBuilder.routing.raydium.cpmm_by_programId', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return { success: true, accounts: {} };
      }
      
      // Default to CLMM
      logger.debug('sdkQuoteBuilder.routing.raydium.clmm_default', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
      return getRaydiumSdkQuote(connection, hop);

    case 'meteora':
      // DAMM v1 variant
      if (variant === 'damm_v1' || variant === 'damm' || variant === 'balanced') {
        logger.debug('sdkQuoteBuilder.routing.meteora.damm_v1', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV1SdkQuote(connection, hop);
      }
      
      // DAMM v2 variant
      if (variant === 'damm_v2' || variant === 'cpamm') {
        logger.debug('sdkQuoteBuilder.routing.meteora.damm_v2', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV2SdkQuote(connection, hop);
      }
      
      // DLMM variant (default for Meteora)
      if (variant === 'dlmm') {
        logger.debug('sdkQuoteBuilder.routing.meteora.dlmm', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraSdkQuote(connection, hop);
      }
      
      // No variant - check program ID to determine type
      if (programId === METEORA_DAMM_V1_PROGRAM.toBase58() ||
          programId === 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB') {
        logger.debug('sdkQuoteBuilder.routing.meteora.damm_v1_by_programId', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV1SdkQuote(connection, hop);
      }
      if (programId === METEORA_DAMM_V2_PROGRAM.toBase58() ||
          programId === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') {
        logger.debug('sdkQuoteBuilder.routing.meteora.damm_v2_by_programId', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV2SdkQuote(connection, hop);
      }
      
      // Default to DLMM
      logger.debug('sdkQuoteBuilder.routing.meteora.dlmm_default', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
      return getMeteoraSdkQuote(connection, hop);

    case 'meteora_balanced':
      // meteora_balanced DEX name - always DAMM, detect v1 vs v2 from variant or programId
      if (variant === 'damm_v2') {
        logger.debug('sdkQuoteBuilder.routing.meteora_balanced.v2_by_variant', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV2SdkQuote(connection, hop);
      }
      if (variant === 'damm_v1') {
        logger.debug('sdkQuoteBuilder.routing.meteora_balanced.v1_by_variant', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV1SdkQuote(connection, hop);
      }
      
      // Check program ID
      if (programId === METEORA_DAMM_V2_PROGRAM.toBase58() ||
          programId === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') {
        logger.debug('sdkQuoteBuilder.routing.meteora_balanced.v2_by_programId', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
        return getMeteoraDammV2SdkQuote(connection, hop);
      }
      
      // Default to v1
      logger.debug('sdkQuoteBuilder.routing.meteora_balanced.v1_default', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
      return getMeteoraDammV1SdkQuote(connection, hop);

    case 'pumpswap':
      // PumpSwap needs SDK for global config and fee recipient resolution
      logger.debug('sdkQuoteBuilder.routing.pumpswap', { cat: 'tx', poolId: hop.poolId?.slice(0, 8) });
      return getPumpswapSdkQuote(connection, hop);

    default:
      logger.warn('sdkQuoteBuilder.routing.unsupported', {
        cat: 'tx',
        ctx: { dex, variant, poolId: hop.poolId?.slice(0, 8) },
      });
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
  
  // Core CLMM/DLMM SDKs (critical path)
  const coreResults = await Promise.all([
    initOrcaSdk(),
    initRaydiumSdk(),
    initMeteoraSdk(),
  ]);
  
  // AMM SDKs (optional but useful)
  // Run in parallel but don't block on failure
  const ammResults = await Promise.allSettled([
    initRaydiumAmmSdk(),
    initMeteoraDammV1Sdk(),
    initMeteoraDammV2Sdk(),
    initPumpswapSdk(),
  ]);
  
  const elapsed = Date.now() - startMs;
  logger.info('sdkQuoteBuilder.warmup.complete', { 
    cat: 'tx', 
    elapsed_ms: elapsed,
    core: {
      orca: coreResults[0],
      raydiumClmm: coreResults[1],
      meteoraDlmm: coreResults[2],
    },
    amm: {
      raydiumAmm: ammResults[0].status === 'fulfilled' ? ammResults[0].value : false,
      meteoraDammV1: ammResults[1].status === 'fulfilled' ? ammResults[1].value : false,
      meteoraDammV2: ammResults[2].status === 'fulfilled' ? ammResults[2].value : false,
      pumpswap: ammResults[3].status === 'fulfilled' ? ammResults[3].value : false,
    },
  });
}
