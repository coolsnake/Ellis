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

// Orca SDK v4 components (uses @solana/kit)
let OrcaSwapInstructions: any = null;
let OrcaSetRpc: any = null;
let orcaSdkInitialized = false;

// Raydium SDK components
let RaydiumClmmLayout: any = null;
let RaydiumGetPdaTickArrayAddress: any = null;
let raydiumSdkInitialized = false;

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
// Orca SDK Quote (v4 - uses @solana/kit)
// ============================================================================

/**
 * Create an RPC adapter for @solana/kit from @solana/web3.js Connection
 * The new SDK expects @solana/kit style RPC with .send() builder pattern
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
        return {
          value: {
            data: info.data,
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
            return {
              data: info.data,
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
 * The new SDK uses @solana/kit types, we adapt our web3.js connection
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

    // Create RPC adapter for @solana/kit
    const rpc = createKitRpcAdapter(connection);

    // Use swap amount from hop (or a minimal amount for account discovery)
    const amountIn = hop.amountInRaw && hop.amountInRaw > 0n
      ? hop.amountInRaw
      : 1000n; // Minimal amount for discovery

    // Call swapInstructions with exact-in parameters
    // The SDK v4 uses Address (string) instead of PublicKey
    const swapResult = await OrcaSwapInstructions(
      rpc,
      { inputAmount: amountIn, mint: hop.inputMint },
      poolId, // pool address as string
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
    // The swap instruction typically has tick arrays in specific positions
    // Orca swap instruction accounts: [tokenProgram, tokenAuthority, whirlpool, tokenOwnerAccountA,
    //   tokenVaultA, tokenOwnerAccountB, tokenVaultB, tickArray0, tickArray1, tickArray2, oracle]
    const swapIx = swapResult.instructions.find((ix: any) =>
      ix.programAddress === ORCA_WHIRLPOOL_PROGRAM.toBase58()
    );

    if (!swapIx || !swapIx.accounts || swapIx.accounts.length < 11) {
      return {
        success: false,
        accounts: {},
        error: 'Orca SDK v4 swap instruction has unexpected format',
      };
    }

    // Extract accounts from the instruction (addresses are already strings in @solana/kit)
    const ixAccounts = swapIx.accounts;
    const accounts: SdkProvidedAccounts = {
      // Tick arrays are typically at indices 7, 8, 9
      tickArray0: typeof ixAccounts[7] === 'string' ? ixAccounts[7] : ixAccounts[7]?.address,
      tickArray1: typeof ixAccounts[8] === 'string' ? ixAccounts[8] : ixAccounts[8]?.address,
      tickArray2: typeof ixAccounts[9] === 'string' ? ixAccounts[9] : ixAccounts[9]?.address,
      // Oracle is typically at index 10
      oracle: typeof ixAccounts[10] === 'string' ? ixAccounts[10] : ixAccounts[10]?.address,
      // Vaults at indices 4 and 6
      vaultA: typeof ixAccounts[4] === 'string' ? ixAccounts[4] : ixAccounts[4]?.address,
      vaultB: typeof ixAccounts[6] === 'string' ? ixAccounts[6] : ixAccounts[6]?.address,
    };

    // Get quoted amount from the result
    const quotedAmountOut = swapResult.quote?.tokenEstB ?? swapResult.quote?.estimatedAmountOut;

    logger.info('sdkQuoteBuilder.orca.quote.success', {
      cat: 'tx',
      ctx: {
        poolId: poolId.slice(0, 8) + '...',
        tickArray0: accounts.tickArray0?.slice(0, 12) + '...',
        quotedOut: quotedAmountOut?.toString(),
        ixAccountCount: ixAccounts.length,
      },
    });

    return {
      success: true,
      accounts,
      quotedAmountOut: quotedAmountOut ? BigInt(quotedAmountOut.toString()) : undefined,
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
