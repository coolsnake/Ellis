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
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { getConnection } from '../../wallet/wallet.js';
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

// Orca SDK components
let OrcaWhirlpoolContext: any = null;
let OrcaBuildWhirlpoolClient: any = null;
let OrcaSwapQuoteByInputToken: any = null;
let OrcaPercentage: any = null;
let orcaSdkInitialized = false;

// Raydium SDK components
let RaydiumClmmLayout: any = null;
let RaydiumGetPdaTickArrayAddress: any = null;
let raydiumSdkInitialized = false;

// Meteora SDK component
let MeteoraDLMM: any = null;
let meteoraSdkInitialized = false;

/**
 * Initialize Orca SDK components (lazy loaded)
 */
async function initOrcaSdk(): Promise<boolean> {
  // Don't skip on previous failure - allow retry
  if (orcaSdkInitialized && OrcaSwapQuoteByInputToken) return true;
  orcaSdkInitialized = true;

  try {
    logger.info('sdkQuoteBuilder.orca.init.starting', { cat: 'tx' });
    const orcaSdk = await import('@orca-so/whirlpools-sdk');

    // Log all available keys for debugging
    const allKeys = Object.keys(orcaSdk);
    logger.info('sdkQuoteBuilder.orca.init.module_keys', {
      cat: 'tx',
      keys: allKeys.slice(0, 20),
      totalKeys: allKeys.length,
    });

    OrcaWhirlpoolContext = (orcaSdk as any).WhirlpoolContext;
    OrcaBuildWhirlpoolClient = (orcaSdk as any).buildWhirlpoolClient;
    OrcaSwapQuoteByInputToken = (orcaSdk as any).swapQuoteByInputToken;

    // Log what we found
    logger.info('sdkQuoteBuilder.orca.init.components', {
      cat: 'tx',
      hasContext: !!OrcaWhirlpoolContext,
      hasBuildClient: !!OrcaBuildWhirlpoolClient,
      hasSwapQuote: !!OrcaSwapQuoteByInputToken,
    });

    try {
      const commonSdk = await import('@orca-so/common-sdk');
      OrcaPercentage = (commonSdk as any).Percentage;
    } catch { /* ignore */ }

    if (!OrcaWhirlpoolContext || !OrcaBuildWhirlpoolClient || !OrcaSwapQuoteByInputToken) {
      logger.warn('sdkQuoteBuilder.orca.init.missing_components', { cat: 'tx' });
      return false;
    }

    logger.info('sdkQuoteBuilder.orca.init.success', { cat: 'tx' });
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
    // Try to import pool layout
    try {
      const layoutModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js');
      RaydiumClmmLayout = layoutModule.PoolInfoLayout;
    } catch {
      const sdk = await import('@raydium-io/raydium-sdk-v2');
      RaydiumClmmLayout = (sdk as any)?.PoolInfoLayout ||
                         (sdk as any)?.Clmm?.PoolInfoLayout ||
                         (sdk as any)?.Clmm?.PoolStateLayout;
    }

    // Try to import tick array PDA derivation
    try {
      const raydiumSdk = await import('@raydium-io/raydium-sdk-v2');
      RaydiumGetPdaTickArrayAddress = (raydiumSdk as any).getPdaTickArrayAddress
        || (raydiumSdk as any).CLMM?.getPdaTickArrayAddress
        || (raydiumSdk as any).Clmm?.getPdaTickArrayAddress;
    } catch { /* ignore */ }

    logger.debug('sdkQuoteBuilder.raydium.init.success', { cat: 'tx' });
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
// Orca SDK Quote
// ============================================================================

/**
 * Get Orca Whirlpool accounts via SDK quote
 */
async function getOrcaSdkQuote(
  connection: Connection,
  hop: DirectHop
): Promise<SdkQuoteResult> {
  const poolId = hop.poolId.replace(/[#-]rev$/, '');

  try {
    const sdkAvailable = await initOrcaSdk();
    if (!sdkAvailable || !OrcaSwapQuoteByInputToken || !OrcaWhirlpoolContext || !OrcaBuildWhirlpoolClient) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK not available',
      };
    }

    // Create a minimal context
    const dummyWallet = { publicKey: new PublicKey('11111111111111111111111111111111') };

    const ctx = OrcaWhirlpoolContext.from(
      connection,
      dummyWallet,
      ORCA_WHIRLPOOL_PROGRAM,
      {
        userDefaultBuildOptions: {
          defaultBuildOption: { maxSupportedTransactionVersion: 'legacy' },
        },
      },
    );

    const client = OrcaBuildWhirlpoolClient(ctx);
    const pool = await client.getPool(new PublicKey(poolId));

    // Get the pool data for vaults
    const poolData = pool.getData();

    // Use swap amount from hop (or a minimal amount for account discovery)
    const BN = (await import('bn.js')).default;
    const amountIn = hop.amountInRaw && hop.amountInRaw > 0n
      ? new BN(hop.amountInRaw.toString())
      : new BN(1000); // Minimal amount for discovery

    // Default slippage (1%)
    const slippage = OrcaPercentage
      ? OrcaPercentage.fromFraction(100, 10000)
      : { numerator: new BN(100), denominator: new BN(10000) };

    const quote = await OrcaSwapQuoteByInputToken(
      pool,
      new PublicKey(hop.inputMint),
      amountIn,
      slippage,
      ORCA_WHIRLPOOL_PROGRAM,
      ctx.fetcher,
    );

    if (!quote || !quote.tickArray0) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK quote returned no tick arrays',
      };
    }

    const accounts: SdkProvidedAccounts = {
      tickArray0: quote.tickArray0.toBase58(),
      tickArray1: quote.tickArray1?.toBase58(),
      tickArray2: quote.tickArray2?.toBase58(),
      oracle: poolData.oracle?.toBase58(),
      vaultA: poolData.tokenVaultA?.toBase58(),
      vaultB: poolData.tokenVaultB?.toBase58(),
    };

    logger.info('sdkQuoteBuilder.orca.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        tickArray0: accounts.tickArray0?.slice(0, 12) + '...',
        quotedOut: quote.estimatedAmountOut?.toString(),
      },
    });

    return {
      success: true,
      accounts,
      quotedAmountOut: quote.estimatedAmountOut ? BigInt(quote.estimatedAmountOut.toString()) : undefined,
    };
  } catch (e) {
    logCatchError('sdkQuoteBuilder.orca.quote', e);
    return {
      success: false,
      accounts: {},
      error: (e as Error).message,
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
    const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * tickSpacing;
    const centerIdx = Math.floor(tickCurrent / ticksInArray);

    // Use bitmap to find initialized tick arrays
    const tickArrayBitmap = state.tickArrayBitmap ?? state.tick_array_bitmap;
    let tickArrayIndices: number[] = [];

    if (Array.isArray(tickArrayBitmap) && tickArrayBitmap.length === RAYDIUM_BITMAP_WORDS) {
      const allInitialized = decodeRaydiumTickArrayBitmap(tickArrayBitmap);

      // Find arrays near center
      tickArrayIndices = allInitialized
        .filter(idx => Math.abs(idx - centerIdx) <= 10)
        .sort((a, b) => Math.abs(a - centerIdx) - Math.abs(b - centerIdx));
    }

    // Derive tick array PDAs
    const centerStart = centerIdx * ticksInArray;
    const tickArrayPdas: Array<{ index: number; address: string }> = [];

    if (tickArrayIndices.length > 0) {
      // Use bitmap-validated indices
      for (const idx of tickArrayIndices.slice(0, 5)) {
        const startTick = idx * ticksInArray;
        const pda = deriveRaydiumTickArrayPda(poolPk, startTick, programId);
        tickArrayPdas.push({ index: idx, address: pda.toBase58() });
      }
    } else {
      // Fallback: derive and validate PDAs around center
      const searchRange = tickSpacing <= 2 ? 12 : tickSpacing <= 10 ? 8 : 5;
      const pdaInfos: Array<{ index: number; pda: PublicKey }> = [];

      for (let i = -searchRange; i <= searchRange; i++) {
        const startTick = centerStart + (i * ticksInArray);
        const pda = deriveRaydiumTickArrayPda(poolPk, startTick, programId);
        pdaInfos.push({ index: i, pda });
      }

      // Batch verify existence
      const infos = await connection.getMultipleAccountsInfo(pdaInfos.map(p => p.pda));
      for (let i = 0; i < pdaInfos.length; i++) {
        if (infos[i] && infos[i]!.owner.equals(programId)) {
          tickArrayPdas.push({
            index: pdaInfos[i].index,
            address: pdaInfos[i].pda.toBase58()
          });
        }
      }
    }

    // Sort by distance from center
    tickArrayPdas.sort((a, b) => Math.abs(a.index - centerIdx) - Math.abs(b.index - centerIdx));

    // Extract tick arrays (center, lower, upper)
    const center = tickArrayPdas.find(t => t.index === centerIdx) || tickArrayPdas[0];
    const lower = tickArrayPdas.find(t => t.index < (center?.index ?? centerIdx));
    const upper = tickArrayPdas.find(t => t.index > (center?.index ?? centerIdx));

    if (!center) {
      return {
        success: false,
        accounts: {},
        error: 'No tick arrays found for Raydium pool',
      };
    }

    // Check for exBitmap
    let exBitmap: string | undefined;
    try {
      const [exBitmapPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('exaccount'), poolPk.toBuffer()],
        programId
      );
      const exBitmapInfo = await connection.getAccountInfo(exBitmapPda);
      if (exBitmapInfo && exBitmapInfo.owner.equals(programId)) {
        exBitmap = exBitmapPda.toBase58();
      }
    } catch { /* ignore */ }

    const accounts: SdkProvidedAccounts = {
      tickArrayCenter: center.address,
      tickArrayLower: lower?.address,
      tickArrayUpper: upper?.address,
      observationState,
      ammConfig,
      exBitmap,
      vaultA,
      vaultB,
    };

    logger.info('sdkQuoteBuilder.raydium.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        tickCurrent,
        tickSpacing,
        tickArraysFound: tickArrayPdas.length,
        hasExBitmap: !!exBitmap,
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
      error: (e as Error).message,
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
          const data = accountInfo.data;
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
    let binArrayAddresses: string[] = [];

    // Try getting bin arrays from dlmmPool if available
    if (dlmmPool) {
      try {
        const binArrays = await dlmmPool.getBinArrays();
        if (Array.isArray(binArrays)) {
          binArrayAddresses = binArrays.map((ba: any) => {
            const addr = typeof ba.publicKey?.toBase58 === 'function'
              ? ba.publicKey.toBase58()
              : String(ba.publicKey || ba.address);
            return addr;
          });
          logger.debug('sdkQuoteBuilder.meteora.quote.bin_arrays_from_sdk', { cat: 'tx', count: binArrayAddresses.length });
        }
      } catch (e) {
        logger.debug('sdkQuoteBuilder.meteora.quote.getBinArrays_failed', { cat: 'tx', error: (e as Error).message });
      }
    }

    // Fallback: derive bin arrays manually
    if (binArrayAddresses.length === 0) {
      const BIN_ARRAY_SIZE = 70;
      const activeIndex = Math.floor(activeId / BIN_ARRAY_SIZE);
      const RANGE = 5;

      const BN = (await import('bn.js')).default;
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
      logger.debug('sdkQuoteBuilder.meteora.quote.bin_arrays_manual', { cat: 'tx', count: binArrayAddresses.length });
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

    const accounts: SdkProvidedAccounts = {
      binArrays: binArrayAddresses,
      activeId,
      binArrayLower: binArrayAddresses[0],
      binArrayUpper: binArrayAddresses[binArrayAddresses.length - 1],
      vaultA,
      vaultB,
    };

    logger.info('sdkQuoteBuilder.meteora.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        activeId,
        binStep,
        binArraysFound: binArrayAddresses.length,
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
      error: (e as Error).message,
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
 */
export async function getSdkQuoteAccountsForPlan(
  hops: DirectHop[]
): Promise<{ success: boolean; results: SdkQuoteResult[]; error?: string }> {
  const results: SdkQuoteResult[] = [];

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const result = await getSdkQuoteAccounts(hop);
    results.push(result);

    if (!result.success) {
      return {
        success: false,
        results,
        error: `Hop ${i} (${hop.dex}/${hop.poolId.slice(0, 8)}...): ${result.error}`,
      };
    }
  }

  return {
    success: true,
    results,
  };
}
