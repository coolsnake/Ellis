/**
 * Meteora Balanced (DAMM) pool decoder
 * 
 * Handles decoding and WebSocket updates for Meteora Balanced pools.
 * 
 * IMPORTANT: V1 and V2 use DIFFERENT pricing mechanisms:
 * - V1 (Dynamic AMM): Constant-product AMM, price = reserveB / reserveA
 * - V2 (CP-AMM): Concentrated liquidity with sqrtPrice, price = (sqrtPrice / 2^64)^2
 * 
 * WebSocket updates can come from:
 * 1. Vault token accounts (balance changes) - processed via handleMeteoraBalancedVaultUpdate
 * 2. Pool accounts directly - processed via handleMeteoraBalancedPoolAccountUpdate
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools, parseTokenAccountAmount } from '../../../pools.utils.js';
import { metbalCache, vaultBalanceCache, findPoolInCache } from '../../../pools.cache.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool, validatePriceDelta } from '../validation.js';
import { CONFIG } from '../../../../utils/config.js';
// Import pool activation tracking for lazy activation mode
import { tryActivatePool } from '../../../pools.activation.js';
// Import per-pool staleness tracking
import { recordPoolActivity } from '../staleness.js';
import { PublicKey, Connection } from '@solana/web3.js';
import type { 
  DecodedPool, 
  UpdateResult, 
  AccountInfo, 
  ProcessedPriceResult,
  DerivedAccountInfo 
} from './types.js';
import type { AmmPool, PoolsPayload } from '../../types.js';

// Program IDs - Meteora DAMM has v1 and v2 versions
export const METEORA_BALANCED_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
export const METEORA_BALANCED_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'; // CP-AMM SDK

// Import centralized decimal resolution with RPC + persistence
import { resolveDecimalsGuaranteed } from '../../decimals.js';

// Minimum buffer length for pool account decoding
const MIN_DAMM_V1_POOL_BUFFER_LENGTH = 232;
const MIN_DAMM_V2_POOL_BUFFER_LENGTH = 480; // CP-AMM pools need at least 472 bytes (sqrtPrice ends at offset 472)

// CP-AMM (V2) Pool struct offsets (bytemuck/zero-copy serialization)
// Layout: discriminator(8) + poolFees(160) + mints/vaults/etc
const V2_OFFSET_TOKEN_A_MINT = 168;   // 32 bytes
const V2_OFFSET_TOKEN_B_MINT = 200;   // 32 bytes
const V2_OFFSET_TOKEN_A_VAULT = 232;  // 32 bytes
const V2_OFFSET_TOKEN_B_VAULT = 264;  // 32 bytes
const V2_OFFSET_SQRT_PRICE = 456;     // 16 bytes (u128)

// Q64.64 fixed-point constants for sqrtPrice conversion
const TWO_POW_64 = BigInt(2) ** BigInt(64);
const TWO_POW_128 = BigInt(2) ** BigInt(128);

/**
 * Calculate price from CP-AMM sqrtPrice (Q64.64 fixed-point)
 * 
 * sqrtPrice represents sqrt(tokenB/tokenA) * 2^64
 * price_a_per_b = (sqrtPrice / 2^64)^2 = sqrtPrice^2 / 2^128
 * 
 * Decimal adjustment is applied after: price * 10^(decimalsA - decimalsB)
 * 
 * @param sqrtPrice - The sqrtPrice from CP-AMM pool state (bigint)
 * @param decimalsA - Decimals for token A
 * @param decimalsB - Decimals for token B
 * @returns price_a_per_b in whole units, or undefined if calculation fails
 */
export function calculateCpAmmPrice(
  sqrtPrice: bigint,
  decimalsA: number,
  decimalsB: number
): number | undefined {
  try {
    if (!sqrtPrice || sqrtPrice <= BigInt(0)) {
      return undefined;
    }
    
    // price = sqrtPrice^2 / 2^128
    // To avoid overflow, we calculate: (sqrtPrice / 2^64)^2
    // Using floating point for the final calculation
    const sqrtPriceNum = Number(sqrtPrice) / Number(TWO_POW_64);
    const rawPrice = sqrtPriceNum * sqrtPriceNum;
    
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      return undefined;
    }
    
    // Apply decimal adjustment: price * 10^(decimalsA - decimalsB)
    const decimalAdjustment = Math.pow(10, decimalsA - decimalsB);
    const adjustedPrice = rawPrice * decimalAdjustment;
    
    if (!Number.isFinite(adjustedPrice) || adjustedPrice <= 0) {
      return undefined;
    }
    
    return adjustedPrice;
  } catch (e) {
    logCatchDebug('meteora_balanced.calculateCpAmmPrice', e);
    return undefined;
  }
}

// Cached SDK program for offline decoding
let dammV1Program: any = null;
let dammV1ProgramInitializing = false;
let dammV2Coder: any = null;
let dammV2CoderInitializing = false;

/**
 * Decoded DAMM v1 pool account state
 */
interface DammV1PoolState {
  lpMint: string;
  tokenAMint: string;
  tokenBMint: string;
  aVault: string;
  bVault: string;
  aVaultLp: string;
  bVaultLp: string;
  aVaultLpBump?: number;
  enabled?: boolean;
  fees?: {
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    protocolTradeFeeNumerator?: bigint;
    protocolTradeFeeDenominator?: bigint;
  };
}

/**
 * Load the DAMM v1 Anchor program for offline decoding
 * Uses @meteora-ag/dynamic-amm-sdk IDL with Anchor coder
 */
async function loadDammV1Program(): Promise<any> {
  if (dammV1Program) return dammV1Program;
  if (dammV1ProgramInitializing) {
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    return dammV1Program;
  }
  
  dammV1ProgramInitializing = true;
  
  try {
    // Import Anchor and SDK
    const { Program, AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
    const { Connection, Keypair } = await import('@solana/web3.js');
    const dynamicAmmModule = await import('@meteora-ag/dynamic-amm-sdk');
    
    // Get the IDL from the SDK
    const AmmIdl = (dynamicAmmModule as any).AmmIdl;
    if (!AmmIdl) {
      logCatchDebug('meteora_balanced.loadDammV1Program', 'AmmIdl not found in dynamic-amm-sdk');
      dammV1ProgramInitializing = false;
      return null;
    }
    
    // Create an offline provider (no actual RPC calls needed for decoding)
    const dummyConnection = new Connection('http://localhost:8899'); // Never actually used
    const dummyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(dummyConnection, dummyWallet, {
      commitment: 'confirmed',
      skipPreflight: true,
    });
    
    // Create the program instance - Anchor v0.30+ signature: new Program(idl, provider)
    // The program ID is derived from the IDL metadata
    const idlWithAddress = {
      ...AmmIdl,
      address: METEORA_BALANCED_V1_PROGRAM,
    };
    dammV1Program = new Program(idlWithAddress as any, provider);
    
    logger.info('meteora_balanced.dammV1Program.init.success', {
      programId: METEORA_BALANCED_V1_PROGRAM,
      cat: 'pools'
    });
    
    dammV1ProgramInitializing = false;
    return dammV1Program;
  } catch (e) {
    logCatchDebug('meteora_balanced.loadDammV1Program', e);
    dammV1ProgramInitializing = false;
    return null;
  }
}

/**
 * Decode DAMM v1 pool account using SDK's Anchor coder
 * Falls back to manual buffer parsing if SDK fails
 */
export async function decodeDammV1PoolAccount(data: Buffer): Promise<DammV1PoolState | null> {
  try {
    if (!data || data.length < MIN_DAMM_V1_POOL_BUFFER_LENGTH) {
      return null;
    }
    
    // Try SDK-based decoding first
    const program = await loadDammV1Program();
    if (program?.coder?.accounts?.decode) {
      try {
        const state = program.coder.accounts.decode('pool', data);
        if (state) {
          // Extract and convert BN values to strings
          const tradeFeeNum = state.fees?.tradeFeeNumerator;
          const tradeFeeDen = state.fees?.tradeFeeDenominator;
          
          return {
            lpMint: state.lpMint?.toBase58?.() || '',
            tokenAMint: state.tokenAMint?.toBase58?.() || '',
            tokenBMint: state.tokenBMint?.toBase58?.() || '',
            aVault: state.aVault?.toBase58?.() || '',
            bVault: state.bVault?.toBase58?.() || '',
            aVaultLp: state.aVaultLp?.toBase58?.() || '',
            bVaultLp: state.bVaultLp?.toBase58?.() || '',
            aVaultLpBump: state.aVaultLpBump,
            enabled: state.enabled,
            fees: tradeFeeNum && tradeFeeDen ? {
              tradeFeeNumerator: BigInt(tradeFeeNum.toString()),
              tradeFeeDenominator: BigInt(tradeFeeDen.toString()),
              protocolTradeFeeNumerator: state.fees?.protocolTradeFeeNumerator 
                ? BigInt(state.fees.protocolTradeFeeNumerator.toString()) 
                : undefined,
              protocolTradeFeeDenominator: state.fees?.protocolTradeFeeDenominator 
                ? BigInt(state.fees.protocolTradeFeeDenominator.toString()) 
                : undefined,
            } : undefined,
          };
        }
      } catch (sdkErr) {
        logCatchDebug('meteora_balanced.decodeDammV1.sdk_error', sdkErr);
        // Fall through to manual parsing
      }
    }
    
    // Fallback: Manual buffer parsing
    // DAMM v1 pool layout (after 8-byte discriminator):
    // lpMint at 8-40, tokenAMint at 40-72, tokenBMint at 72-104
    // aVault at 104-136, bVault at 136-168
    // aVaultLp at 168-200, bVaultLp at 200-232
    const lpMint = new PublicKey(data.subarray(8, 40)).toBase58();
    const tokenAMint = new PublicKey(data.subarray(40, 72)).toBase58();
    const tokenBMint = new PublicKey(data.subarray(72, 104)).toBase58();
    const aVault = new PublicKey(data.subarray(104, 136)).toBase58();
    const bVault = new PublicKey(data.subarray(136, 168)).toBase58();
    const aVaultLp = new PublicKey(data.subarray(168, 200)).toBase58();
    const bVaultLp = new PublicKey(data.subarray(200, 232)).toBase58();
    
    return {
      lpMint,
      tokenAMint,
      tokenBMint,
      aVault,
      bVault,
      aVaultLp,
      bVaultLp,
    };
  } catch (e) {
    logCatchDebug('meteora_balanced.decodeDammV1PoolAccount', e);
    return null;
  }
}

/**
 * Decoded DAMM v2 (CP-AMM) pool account state
 * CP-AMM uses concentrated liquidity with sqrtPrice, NOT simple constant-product
 */
interface DammV2PoolState {
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;  // CP-AMM uses tokenAVault/tokenBVault naming
  tokenBVault: string;
  sqrtPrice: bigint;    // Q64.64 fixed-point: sqrt(tokenB/tokenA) * 2^64
}

/**
 * Load the DAMM v2 (CP-AMM) BorshCoder for offline decoding
 * Uses @meteora-ag/cp-amm-sdk's exported coder
 */
async function loadDammV2Coder(): Promise<any> {
  if (dammV2Coder) return dammV2Coder;
  if (dammV2CoderInitializing) {
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    return dammV2Coder;
  }
  
  dammV2CoderInitializing = true;
  
  try {
    // Import the CP-AMM SDK's pre-configured BorshCoder
    const cpAmmSdk = await import('@meteora-ag/cp-amm-sdk');
    
    // The SDK exports cpAmmCoder which is a pre-built BorshCoder instance
    if (cpAmmSdk.cpAmmCoder) {
      dammV2Coder = cpAmmSdk.cpAmmCoder;
      logger.info('meteora_balanced.dammV2Coder.init.success', {
        programId: METEORA_BALANCED_V2_PROGRAM,
        cat: 'pools'
      });
      dammV2CoderInitializing = false;
      return dammV2Coder;
    }
    
    logCatchDebug('meteora_balanced.loadDammV2Coder', 'cpAmmCoder not found in cp-amm-sdk');
    dammV2CoderInitializing = false;
    return null;
  } catch (e) {
    logCatchDebug('meteora_balanced.loadDammV2Coder', e);
    dammV2CoderInitializing = false;
    return null;
  }
}

/**
 * Decode DAMM v2 (CP-AMM) pool account using manual offset parsing
 * 
 * CP-AMM pools use bytemuck/zero-copy serialization (NOT Borsh), so we must
 * use direct offset-based parsing. The BorshCoder cannot decode bytemuck accounts.
 * 
 * Pool struct layout (after 8-byte Anchor discriminator):
 * - poolFees: 160 bytes (offset 8-167)
 * - tokenAMint: 32 bytes (offset 168-199)
 * - tokenBMint: 32 bytes (offset 200-231)
 * - tokenAVault: 32 bytes (offset 232-263)
 * - tokenBVault: 32 bytes (offset 264-295)
 * - whitelisted_vault: 32 bytes (offset 296-327)
 * - partner: 32 bytes (offset 328-359)
 * - liquidity: 16 bytes (offset 360-375)
 * - _padding: 16 bytes (offset 376-391)
 * - protocol_a_fee: 8 bytes (offset 392-399)
 * - protocol_b_fee: 8 bytes (offset 400-407)
 * - partner_a_fee: 8 bytes (offset 408-415)
 * - partner_b_fee: 8 bytes (offset 416-423)
 * - sqrt_min_price: 16 bytes (offset 424-439)
 * - sqrt_max_price: 16 bytes (offset 440-455)
 * - sqrt_price: 16 bytes (offset 456-471) <-- CRITICAL FOR PRICING
 */
export async function decodeDammV2PoolAccount(data: Buffer): Promise<DammV2PoolState | null> {
  try {
    if (!data || data.length < MIN_DAMM_V2_POOL_BUFFER_LENGTH) {
      return null;
    }
    
    // Ensure we have a proper Node.js Buffer for reading BigInt
    const buf = Buffer.from(data);
    
    // Manual offset parsing for bytemuck/zero-copy accounts
    // PublicKey fields are 32 bytes each
    const tokenAMint = new PublicKey(buf.subarray(V2_OFFSET_TOKEN_A_MINT, V2_OFFSET_TOKEN_A_MINT + 32)).toBase58();
    const tokenBMint = new PublicKey(buf.subarray(V2_OFFSET_TOKEN_B_MINT, V2_OFFSET_TOKEN_B_MINT + 32)).toBase58();
    const tokenAVault = new PublicKey(buf.subarray(V2_OFFSET_TOKEN_A_VAULT, V2_OFFSET_TOKEN_A_VAULT + 32)).toBase58();
    const tokenBVault = new PublicKey(buf.subarray(V2_OFFSET_TOKEN_B_VAULT, V2_OFFSET_TOKEN_B_VAULT + 32)).toBase58();
    
    // sqrtPrice is u128 (16 bytes) stored as little-endian
    // Read as two u64 values and combine: low + (high << 64)
    const sqrtPriceLow = buf.readBigUInt64LE(V2_OFFSET_SQRT_PRICE);
    const sqrtPriceHigh = buf.readBigUInt64LE(V2_OFFSET_SQRT_PRICE + 8);
    const sqrtPrice = sqrtPriceLow + (sqrtPriceHigh << BigInt(64));
    
    // Validate mints
    if (!tokenAMint || !tokenBMint || tokenAMint.length < 32 || tokenBMint.length < 32) {
      logCatchDebug('meteora_balanced.decodeDammV2', 'Invalid mints decoded from V2 pool');
      return null;
    }
    
    return {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      sqrtPrice,
    };
  } catch (e) {
    logCatchDebug('meteora_balanced.decodeDammV2PoolAccount', e);
    return null;
  }
}

/**
 * Unified decoder that handles both V1 and V2 pool accounts
 * Returns a normalized structure with aVault/bVault naming
 * For V2 (CP-AMM) pools, also returns sqrtPrice for correct pricing
 */
export async function decodeMeteoraBalancedPoolAccount(
  data: Buffer,
  owner: string
): Promise<{ tokenAMint: string; tokenBMint: string; aVault: string; bVault: string; sqrtPrice?: bigint } | null> {
  try {
    const isV2 = owner === METEORA_BALANCED_V2_PROGRAM;
    
    if (isV2) {
      // Use V2 SDK decoder
      const v2Result = await decodeDammV2PoolAccount(data);
      if (v2Result) {
        return {
          tokenAMint: v2Result.tokenAMint,
          tokenBMint: v2Result.tokenBMint,
          aVault: v2Result.tokenAVault,
          bVault: v2Result.tokenBVault,
          sqrtPrice: v2Result.sqrtPrice,  // CP-AMM uses sqrtPrice for pricing
        };
      }
      return null;
    } else {
      // Use V1 decoder (handles both SDK and manual fallback)
      const v1Result = await decodeDammV1PoolAccount(data);
      if (v1Result) {
        return {
          tokenAMint: v1Result.tokenAMint,
          tokenBMint: v1Result.tokenBMint,
          aVault: v1Result.aVault,
          bVault: v1Result.bVault,
          // V1 pools use constant-product formula, no sqrtPrice
        };
      }
      return null;
    }
  } catch (e) {
    logCatchDebug('meteora_balanced.decodeMeteoraBalancedPoolAccount', e);
    return null;
  }
}

// Debounce state for graph updates
let metbalApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Schedule debounced graph update for Meteora Balanced (DAMM v1/v2)
 */
async function scheduleDexApply(source: 'meteora_damm_v1' | 'meteora_damm_v2', baseline: PoolsPayload): Promise<void> {
  try {
    if (!metbalApplyState.baseline) {
      metbalApplyState.baseline = baseline;
    }
    if (metbalApplyState.timer) {
      clearTimeout(metbalApplyState.timer);
    }
    metbalApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = metbalCache.data;
        if (current && metbalApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(metbalApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('meteora_balanced.scheduleDexApply', e);
      } finally {
        metbalApplyState.baseline = null;
        metbalApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('meteora_balanced.scheduleDexApply.setup', e);
  }
}

/**
 * Decode Meteora Balanced pool from vault balance updates
 * 
 * Meteora Balanced pools are simple AMMs where price is derived from vault balances.
 * The pool data comes from HTTP API and is cached.
 * WebSocket updates to vaults provide real-time balance changes.
 */
export function decodeMeteoraBalancedPool(
  existingPool: AmmPool,
  vaultABalance: bigint | null,
  vaultBBalance: bigint | null
): DecodedPool | null {
  try {
    if (!existingPool) return null;

    // CRITICAL: Use native mints/decimals consistently
    // If native fields are missing, derive them from canonical fields + was_swapped flag
    const wasSwapped = (existingPool as any).was_swapped === true;
    
    // Get mints - prefer native, derive from canonical if needed
    let mintA: string | undefined;
    let mintB: string | undefined;
    
    if (existingPool.native_mint_a && existingPool.native_mint_a.length > 10) {
      mintA = existingPool.native_mint_a;
      mintB = existingPool.native_mint_b;
    } else if (existingPool.mint_a && existingPool.mint_a.length > 10) {
      // Derive native mints from canonical + was_swapped
      if (wasSwapped) {
        mintA = existingPool.mint_b;
        mintB = existingPool.mint_a;
      } else {
        mintA = existingPool.mint_a;
        mintB = existingPool.mint_b;
      }
    }
    
    if (!mintA || !mintB) {
      logger.debug('meteora_balanced.decode.missing_mints', { poolId: existingPool.id, cat: 'pools' });
      return null;
    }

    // Get decimals - prefer native, derive from canonical if needed
    let decA: number | undefined;
    let decB: number | undefined;
    
    if (Number.isFinite(existingPool.native_decimals_a)) {
      decA = existingPool.native_decimals_a;
      decB = existingPool.native_decimals_b;
    } else if (Number.isFinite(existingPool.decimals_a)) {
      // Derive native decimals from canonical + was_swapped
      if (wasSwapped) {
        decA = existingPool.decimals_b;
        decB = existingPool.decimals_a;
      } else {
        decA = existingPool.decimals_a;
        decB = existingPool.decimals_b;
      }
      
      logger.debug('meteora_balanced.decoder.derived_native_decimals', {
        poolId: existingPool.id?.slice(0, 8) + '…',
        wasSwapped,
        decA,
        decB,
        cat: 'pools'
      });
    }

    // Track if we need async resolution (will be handled by caller)
    let needsDecimalsResolution = false;

    if (!Number.isFinite(decA)) {
      // Sync fallback to 9 - caller should resolve via resolveDecimalsGuaranteed()
      decA = 9;
      needsDecimalsResolution = true;
      logger.debug('meteora_balanced.decoder.decimals_needs_resolution', {
        poolId: existingPool.id?.slice(0, 8) + '…',
        mint: mintA?.slice(0, 8) + '…',
        side: 'A',
        cat: 'pools'
      });
    }
    if (!Number.isFinite(decB)) {
      // Sync fallback to 9 - caller should resolve via resolveDecimalsGuaranteed()
      decB = 9;
      needsDecimalsResolution = true;
      logger.debug('meteora_balanced.decoder.decimals_needs_resolution', {
        poolId: existingPool.id?.slice(0, 8) + '…',
        mint: mintB?.slice(0, 8) + '…',
        side: 'B',
        cat: 'pools'
      });
    }

    // Calculate reserves from vault balances
    let reserveA = vaultABalance;
    let reserveB = vaultBBalance;

    // Fall back to cached raw reserves if vault balances not available
    // CRITICAL: Use native reserves, derive from canonical if needed
    if (reserveA === null) {
      if (existingPool.native_reserve_a_raw) {
        reserveA = anyToBigInt(existingPool.native_reserve_a_raw);
      } else if (existingPool.reserve_a_raw) {
        // Derive native reserves from canonical + was_swapped
        if (wasSwapped) {
          reserveA = anyToBigInt(existingPool.reserve_b_raw);
        } else {
          reserveA = anyToBigInt(existingPool.reserve_a_raw);
        }
      }
    }
    if (reserveB === null) {
      if (existingPool.native_reserve_b_raw) {
        reserveB = anyToBigInt(existingPool.native_reserve_b_raw);
      } else if (existingPool.reserve_b_raw) {
        // Derive native reserves from canonical + was_swapped
        if (wasSwapped) {
          reserveB = anyToBigInt(existingPool.reserve_a_raw);
        } else {
          reserveB = anyToBigInt(existingPool.reserve_b_raw);
        }
      }
    }

    if (reserveA === null || reserveB === null) {
      logger.debug('meteora_balanced.decode.missing_reserves', { 
        poolId: existingPool.id, 
        hasA: reserveA !== null, 
        hasB: reserveB !== null,
        cat: 'pools' 
      });
      return null;
    }

    return {
      id: existingPool.id,
      dex: existingPool.dex || 'MeteoraBalanced_v2', // Preserve version info
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: existingPool.fee_bps || 30,
      price_a_per_b: 0, // Will be calculated through pipeline
      liquidity_base: 0, // Will be calculated
      updated_ms: Date.now(),
      pool_kind: 'amm',
      native_mint_a: mintA,
      native_mint_b: mintB,
      native_decimals_a: decA,
      native_decimals_b: decB,
      reserve_a_raw: reserveA.toString(),
      reserve_b_raw: reserveB.toString(),
      native_reserve_a_raw: reserveA.toString(),
      native_reserve_b_raw: reserveB.toString(),
      native_account_a: existingPool.native_account_a,
      native_account_b: existingPool.native_account_b,
    };
  } catch (e) {
    logCatchDebug('meteora_balanced.decode', e);
    return null;
  }
}

/**
 * Handle Meteora Balanced vault balance update
 * 
 * This is called when a vault token account update is received via WebSocket.
 * We use the cached vault balances to recalculate the pool price.
 */
export async function handleMeteoraBalancedVaultUpdate(
  info: AccountInfo,
  vaultAddress: string,
  poolId: string
): Promise<UpdateResult> {
  try {
    wsDecodeStats.meteora_damm_v2.attempts += 1;
    
    // Parse the new vault balance
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    const newBalance = parseTokenAccountAmount(data);
    
    if (newBalance === null) {
      logger.debug('meteora_balanced.vault.parse.fail', { vault: vaultAddress.slice(0, 8) + '…', cat: 'pools' });
      return { success: false, error: 'parse_failed', skipped: true };
    }

    // Cache the vault balance
    vaultBalanceCache.set(vaultAddress, newBalance);
    
    logger.debug('meteora_balanced.vault.balance_cached', {
      vault: vaultAddress.slice(0, 8) + '…',
      balance: newBalance.toString(),
      poolId: poolId.slice(0, 8) + '…',
      cat: 'pools'
    });

    // Find the pool in cache
    const poolData = findPoolInCache(poolId);
    if (!poolData || poolData.source !== 'meteora_balanced') {
      logger.debug('meteora_balanced.vault.pool.not_found', { 
        vault: vaultAddress.slice(0, 8) + '…', 
        pool: poolId.slice(0, 8) + '…', 
        cat: 'pools' 
      });
      return { success: true, skipped: true, skipReason: 'pool_not_in_cache' };
    }

    const existingPool = poolData.pool as AmmPool;
    
    // Get vault addresses from the pool
    // CRITICAL: Must use native vault addresses consistently with native mints/decimals
    // If native_account_a is missing, derive it from canonical account_a + was_swapped flag
    const wasSwapped = (existingPool as any).was_swapped === true;
    
    let vaultA: string | undefined;
    let vaultB: string | undefined;
    
    // Prefer native vault addresses if available (non-empty)
    if (existingPool.native_account_a && existingPool.native_account_a.length > 10) {
      vaultA = existingPool.native_account_a;
      vaultB = existingPool.native_account_b;
    } else if (existingPool.account_a && existingPool.account_a.length > 10) {
      // Canonical vaults available - derive native order from was_swapped
      if (wasSwapped) {
        // If swapped: canonical A = native B, canonical B = native A
        vaultA = existingPool.account_b;
        vaultB = existingPool.account_a;
      } else {
        vaultA = existingPool.account_a;
        vaultB = existingPool.account_b;
      }
      
      logger.debug('meteora_balanced.vault.derived_native_order', {
        pool: poolId.slice(0, 8) + '…',
        wasSwapped,
        vaultA: vaultA?.slice(0, 8) + '…',
        vaultB: vaultB?.slice(0, 8) + '…',
        cat: 'pools'
      });
    }
    
    if (!vaultA || !vaultB) {
      logger.debug('meteora_balanced.vault.pool.missing_vaults', { 
        pool: poolId.slice(0, 8) + '…', 
        cat: 'pools' 
      });
      return { success: true, skipped: true, skipReason: 'pool_missing_vaults' };
    }

    // Get both vault balances from cache
    const balanceA = vaultBalanceCache.get(vaultA) ?? null;
    const balanceB = vaultBalanceCache.get(vaultB) ?? null;

    if (balanceA === null || balanceB === null) {
      logger.debug('meteora_balanced.vault.awaiting_both', {
        pool: poolId.slice(0, 8) + '…',
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        cat: 'pools'
      });
      return { success: true, skipped: true, skipReason: 'awaiting_both_vaults' };
    }

    // Decode the pool with updated balances
    const decoded = decodeMeteoraBalancedPool(existingPool, balanceA, balanceB);
    if (!decoded) {
      return { success: false, error: 'decode_failed', skipped: true };
    }

    // Process through price pipeline
    const mintA = decoded.native_mint_a || decoded.mint_a;
    const mintB = decoded.native_mint_b || decoded.mint_b;
    const reserveA = anyToBigInt(decoded.reserve_a_raw);
    const reserveB = anyToBigInt(decoded.reserve_b_raw);
    let decA = decoded.native_decimals_a ?? decoded.decimals_a;
    let decB = decoded.native_decimals_b ?? decoded.decimals_b;

    // Fallback decimals with logging (vault update path)
    // Use known decimals if available, otherwise default to 9 (most common on Solana)
    // Use centralized decimal resolution with RPC + persistence
    // This ensures decimals are resolved via RPC if not cached, and persisted for future use
    if (!Number.isFinite(decA) && mintA) {
      const resolved = await resolveDecimalsGuaranteed(mintA, poolId, 'MeteoraBalanced');
      decA = resolved.decimals;
      logger.info('meteora_balanced.decoder.decimals_resolved', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintA?.slice(0, 8) + '…',
        side: 'A',
        decimals: decA,
        source: resolved.source,
        validated: resolved.validated,
        reason: 'vault_update_missing_decimals',
        cat: 'pools'
      });
    }
    if (!Number.isFinite(decB) && mintB) {
      const resolved = await resolveDecimalsGuaranteed(mintB, poolId, 'MeteoraBalanced');
      decB = resolved.decimals;
      logger.info('meteora_balanced.decoder.decimals_resolved', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintB?.slice(0, 8) + '…',
        side: 'B',
        decimals: decB,
        source: resolved.source,
        validated: resolved.validated,
        reason: 'vault_update_missing_decimals',
        cat: 'pools'
      });
    }

    // Determine if this is a V2 (CP-AMM) pool
    // V2 pools use sqrtPrice for pricing, NOT vault balance ratios
    const dexName = decoded.dex || 'MeteoraBalanced_v2';
    const isV2Pool = dexName === 'MeteoraBalanced_v2' || dexName.includes('_v2');
    
    // Try to get sqrtPrice from cached pool data for V2 pools
    let storedSqrtPrice = (existingPool as any)?._sqrtPrice;
    let processedPrice: ProcessedPriceResult | undefined;
    
    // CRITICAL: On-demand fetch sqrtPrice for V2 pools when missing from cache
    // This ensures correct concentrated liquidity pricing even if:
    // - Pool was loaded from old snapshot without sqrtPrice
    // - HTTP enrichment failed to extract sqrtPrice
    // - Vault updates arrived before pool account updates
    if (isV2Pool && !storedSqrtPrice) {
      try {
        const conn = new Connection(CONFIG.rpcUrl, 'confirmed');
        const poolPk = new PublicKey(poolId);
        const account = await conn.getAccountInfo(poolPk);
        
        if (!account) {
          logger.warn('meteora_balanced.vault.v2.sqrtPrice_fetch.no_account', {
            poolId: poolId.slice(0, 8) + '…',
            cat: 'pools'
          });
        } else if (!account.data || account.data.length < 168) {
          logger.warn('meteora_balanced.vault.v2.sqrtPrice_fetch.small_buffer', {
            poolId: poolId.slice(0, 8) + '…',
            dataLen: account.data?.length ?? 0,
            cat: 'pools'
          });
        } else {
          const data = Buffer.from(account.data);
          const decodedPool = await decodeDammV2PoolAccount(data);
          
          if (!decodedPool) {
            logger.warn('meteora_balanced.vault.v2.sqrtPrice_fetch.decode_null', {
              poolId: poolId.slice(0, 8) + '…',
              dataLen: data.length,
              cat: 'pools'
            });
          } else if (!decodedPool.sqrtPrice || decodedPool.sqrtPrice <= BigInt(0)) {
            logger.warn('meteora_balanced.vault.v2.sqrtPrice_fetch.sqrtPrice_zero', {
              poolId: poolId.slice(0, 8) + '…',
              sqrtPrice: decodedPool.sqrtPrice?.toString() ?? 'undefined',
              cat: 'pools'
            });
          } else {
            storedSqrtPrice = decodedPool.sqrtPrice.toString();
            
            // Update cache for future vault updates
            (existingPool as any)._sqrtPrice = storedSqrtPrice;
            
            // Also update the pool in metbalCache.data for persistence
            const cached = metbalCache.data?.amm?.find(p => p.id === poolId);
            if (cached) {
              (cached as any)._sqrtPrice = storedSqrtPrice;
            }
            
            logger.info('meteora_balanced.vault.v2.sqrtPrice_fetched', {
              poolId: poolId.slice(0, 8) + '…',
              sqrtPrice: storedSqrtPrice.slice(0, 16) + '…',
              reason: 'on_demand_fetch_for_correct_pricing',
              cat: 'pools'
            });
          }
        }
      } catch (fetchErr: any) {
        logger.warn('meteora_balanced.vault.v2.sqrtPrice_ondemand_fetch.error', {
          poolId: poolId.slice(0, 8) + '…',
          error: String(fetchErr?.message || fetchErr),
          cat: 'pools'
        });
      }
    }
    
    if (isV2Pool && storedSqrtPrice) {
      // V2 (CP-AMM): Use sqrtPrice for pricing - concentrated liquidity
      try {
        const sqrtPrice = BigInt(storedSqrtPrice);
        const cpAmmPrice = calculateCpAmmPrice(sqrtPrice, decA, decB);
        
        if (cpAmmPrice && Number.isFinite(cpAmmPrice) && cpAmmPrice > 0) {
          processedPrice = processPriceThroughPipeline({
            mintA,
            mintB,
            decimalsA: decA,
            decimalsB: decB,
            poolId,
            dex: dexName,
            poolType: 'amm',
            rawPrice: cpAmmPrice,  // Pre-calculated from sqrtPrice
          });
          
          logger.debug('meteora_balanced.vault.v2.sqrtPrice_pricing', {
            poolId: poolId.slice(0, 8) + '…',
            sqrtPrice: storedSqrtPrice.slice(0, 16) + '…',
            cpAmmPrice,
            decA,
            decB,
            cat: 'pools'
          });
        }
      } catch (sqrtErr) {
        logCatchDebug('meteora_balanced.vault.v2.sqrtPrice_parse', sqrtErr);
      }
    }
    
    // Fallback to reserve-based pricing (V1 pools only)
    if (!processedPrice) {
      // V2 pools require sqrtPrice for correct pricing - skip if unavailable
      if (isV2Pool) {
        logger.warn('meteora_balanced.vault.v2.missing_sqrtprice', {
          poolId: poolId.slice(0, 8) + '…',
          warning: 'V2 pool missing sqrtPrice - skipping vault-based pricing',
          hasSqrtPrice: !!storedSqrtPrice,
          cat: 'pools'
        });
        wsDeltaStats.meteora_damm_v2.skipped += 1;
        incrementSkipReason('meteora_damm_v2', 'missing_sqrt_price');
        return { success: false, error: 'missing_sqrt_price', skipped: true };
      }
      
      processedPrice = processPriceThroughPipeline({
        mintA,
        mintB,
        decimalsA: decA,
        decimalsB: decB,
        poolId,
        dex: dexName,
        poolType: 'amm',
        reserveA,
        reserveB,
      });
    }

    if (!processedPrice) {
      wsDeltaStats.meteora_damm_v2.skipped += 1;
      incrementSkipReason('meteora_damm_v2', 'price_calc_failed');
      return { success: false, error: 'price_calc_failed', skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: dexName,
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: decoded.fee_bps || 30,
      price_a_per_b: processedPrice.priceForward,
      liquidity_base: liquidityBase,
      updated_ms: Date.now(),
      pool_kind: 'amm',
      liquidity_display: liquidityBase,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      reserve_a_raw: processedPrice.wasSwapped ? reserveB?.toString() : reserveA?.toString(),
      reserve_b_raw: processedPrice.wasSwapped ? reserveA?.toString() : reserveB?.toString(),
      was_swapped: processedPrice.wasSwapped,
      native_mint_a: mintA,
      native_mint_b: mintB,
      native_decimals_a: decA,
      native_decimals_b: decB,
      native_reserve_a_raw: reserveA?.toString(),
      native_reserve_b_raw: reserveB?.toString(),
      native_account_a: vaultA,
      native_account_b: vaultB,
      _pipelineProcessed: true,
      // Preserve sqrtPrice for V2 pools
      ...(storedSqrtPrice ? { _sqrtPrice: storedSqrtPrice } : {}),
    } as AmmPool;

    // Validate decoded pool
    const validation = validateDecodedPool('meteora_damm_v2', item, poolId);
    if (!validation.valid) {
      wsDecodeStats.meteora_damm_v2.failures += 1;
      incrementSkipReason('meteora_damm_v2', `validation_failed:${validation.reasons.join(',')}`);
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = metbalCache.data || { amm: [], clmm: [], cpmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
    const idx = next.amm.findIndex(p => p.id === item.id);

    // Validate price delta against previous value
    // CRITICAL: Check was_swapped to handle orientation differences between HTTP and WS updates
    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const prevWasSwapped = (prevPool as any).was_swapped ?? false;
      const newWasSwapped = processedPrice.wasSwapped ?? false;
      
      // Only validate price delta if orientations match
      if (prevWasSwapped === newWasSwapped) {
        validatePriceDelta('meteora_damm_v2', poolId, item.price_a_per_b, prevPool.price_a_per_b);
      } else {
        // Orientation changed - compare with inverted previous price to avoid false alarms
        const adjustedPrevPrice = prevPool.price_a_per_b && prevPool.price_a_per_b > 0 
          ? 1 / prevPool.price_a_per_b 
          : undefined;
        validatePriceDelta('meteora_damm_v2', poolId, item.price_a_per_b, adjustedPrevPrice);
        
        logger.debug('meteora_balanced.vault.orientation_flip', {
          poolId: poolId.slice(0, 8) + '…',
          prevWasSwapped,
          newWasSwapped,
          prevPrice: prevPool.price_a_per_b,
          newPrice: item.price_a_per_b,
          adjustedPrevPrice,
          cat: 'pools'
        });
      }
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'MeteoraBalanced',
          prevMintA: prevPool.mint_a?.slice(0, 8),
          prevMintB: prevPool.mint_b?.slice(0, 8),
          newMintA: item.mint_a?.slice(0, 8),
          newMintB: item.mint_b?.slice(0, 8),
          cat: 'pools'
        });
        
        const orientationIndependentFields = {
          tvl_usd: prevPool.tvl_usd,
          liquidity_display: prevPool.liquidity_display,
          pool_liquidity_raw: prevPool.pool_liquidity_raw,
          // Preserve native reserves - they're in on-chain order, not affected by canonicalization
          native_reserve_a_raw: (prevPool as any).native_reserve_a_raw,
          native_reserve_b_raw: (prevPool as any).native_reserve_b_raw,
        };
        next.amm[idx] = { ...item, ...orientationIndependentFields };
      } else {
        next.amm[idx] = { ...next.amm[idx], ...item };
      }
    } else {
      next.amm.push(item);
    }

    // Update stats and cache
    wsDecodeStats.meteora_damm_v2.successes += 1;
    wsDeltaStats.meteora_damm_v2.decoded += 1;
    
    const delta = diffNormalizedPools(prev, next);
    metbalCache.data = next;
    metbalCache.ts = Date.now();
    
    // CRITICAL: Update execution cache with native mints and was_swapped for direction calculation
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const existingStatic = executionCache.getStatic(poolId) || {} as any;
      executionCache.setStatic(poolId, {
        ...existingStatic,
        programId: (existingPool as any)?.programId || existingStatic.programId,
        dex: 'meteora_balanced',
        pool_kind: 'amm',
        mint_a: item.mint_a,
        mint_b: item.mint_b,
        decimals_a: item.decimals_a,
        decimals_b: item.decimals_b,
        vault_a: (item as any).account_a || vaultA,
        vault_b: (item as any).account_b || vaultB,
        native_mint_a: mintA,
        native_mint_b: mintB,
        native_account_a: vaultA,
        native_account_b: vaultB,
        was_swapped: processedPrice.wasSwapped,
      });
    } catch (e) { logCatchError('meteora_balanced.vault.cache', e); }

    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.meteora_damm_v2.applied += 1;
    } else {
      wsDeltaStats.meteora_damm_v2.skipped += 1;
      incrementSkipReason('meteora_damm_v2', 'no_delta');
    }

    // Emit update event
    try {
      emit('pool-updates', {
        source: 'meteora_balanced',
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now()
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('meteora_damm_v2', prev);
    }

    // Try to activate pool for lazy activation mode (only activates on first valid price update)
    const hasValidPrice = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, 'meteora_damm_v2', hasValidPrice);

    // Track successful activity for staleness monitoring (track the actual pool, not vault)
    recordPoolActivity(poolId, 'meteora_damm_v2', vaultAddress);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.meteora_damm_v2.failures += 1;
    logCatchError('meteora_balanced.handleVaultUpdate', e, { vault: vaultAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Meteora Balanced pool account update (direct pool data)
 * 
 * This is called when a pool account update is received via WebSocket.
 * It decodes the pool state and updates the cache.
 */
export async function handleMeteoraBalancedPoolAccountUpdate(
  info: AccountInfo,
  poolId: string
): Promise<UpdateResult> {
  // Determine pool version from account owner - do this outside try block for catch access
  const ownerRaw = info.owner;
  const ownerStr = typeof ownerRaw === 'string' 
    ? ownerRaw 
    : (ownerRaw as any)?.toBase58?.() || String(ownerRaw || '');
  const isV2 = ownerStr === METEORA_BALANCED_V2_PROGRAM;
  const statsKey = isV2 ? 'meteora_damm_v2' : 'meteora_damm_v1';
  
  try {
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    wsDecodeStats[statsKey].attempts += 1;
    
    const minBufferLength = isV2 ? MIN_DAMM_V2_POOL_BUFFER_LENGTH : MIN_DAMM_V1_POOL_BUFFER_LENGTH;
    if (!data || data.length < minBufferLength) {
      wsDeltaStats[statsKey].skipped += 1;
      incrementSkipReason(statsKey, 'pool_data_too_short');
      return { success: false, error: 'pool_data_too_short', skipped: true };
    }
    
    // Decode the pool account using the appropriate decoder for V1 or V2
    // CRITICAL: V1 and V2 have DIFFERENT on-chain layouts AND pricing mechanisms!
    // - V1: Constant-product AMM, price = reserveB / reserveA
    // - V2: Concentrated liquidity, price = (sqrtPrice / 2^64)^2
    let decoded: { tokenAMint: string; tokenBMint: string; aVault: string; bVault: string; fees?: any; sqrtPrice?: bigint } | null = null;
    
    if (isV2) {
      // Use V2 decoder (CP-AMM SDK)
      const v2Result = await decodeDammV2PoolAccount(data);
      if (v2Result) {
        decoded = {
          tokenAMint: v2Result.tokenAMint,
          tokenBMint: v2Result.tokenBMint,
          aVault: v2Result.tokenAVault,
          bVault: v2Result.tokenBVault,
          sqrtPrice: v2Result.sqrtPrice,  // CRITICAL: V2 uses sqrtPrice for pricing
        };
      }
    } else {
      // Use V1 decoder
      const v1Result = await decodeDammV1PoolAccount(data);
      if (v1Result) {
        decoded = {
          tokenAMint: v1Result.tokenAMint,
          tokenBMint: v1Result.tokenBMint,
          aVault: v1Result.aVault,
          bVault: v1Result.bVault,
          fees: v1Result.fees,
        };
      }
    }
    
    if (!decoded) {
      wsDecodeStats[statsKey].failures += 1;
      incrementSkipReason(statsKey, 'pool_state_decode_failed');
      return { success: false, error: 'pool_state_decode_failed', skipped: true };
    }
    
    // Cache vault addresses for future vault balance updates
    if (decoded.aVault) vaultBalanceCache.set(`meta:${decoded.aVault}`, poolId as any);
    if (decoded.bVault) vaultBalanceCache.set(`meta:${decoded.bVault}`, poolId as any);
    
    // Determine dex name based on version
    const dexName = isV2 ? 'MeteoraBalanced_v2' : 'MeteoraBalanced_v1';
    
    // Find existing pool in cache to get decimals and other metadata
    const poolData = findPoolInCache(poolId);
    const existingPool = poolData?.pool as AmmPool | undefined;
    
    // Get decimals from existing pool or use defaults
    // CRITICAL: If native decimals missing, derive from canonical + was_swapped
    const wasSwapped = (existingPool as any)?.was_swapped === true;
    let decA = existingPool?.native_decimals_a ?? (wasSwapped ? existingPool?.decimals_b : existingPool?.decimals_a);
    let decB = existingPool?.native_decimals_b ?? (wasSwapped ? existingPool?.decimals_a : existingPool?.decimals_b);
    
    // Use centralized decimal resolution with RPC + persistence
    // resolveDecimalsGuaranteed handles: anchors → cache → RPC → Jupiter → known → default
    // and persists RPC-resolved values to disk
    if (!Number.isFinite(decA) && decoded.tokenAMint) {
      const resolved = await resolveDecimalsGuaranteed(decoded.tokenAMint, poolId, dexName);
      decA = resolved.decimals;
      logger.info('meteora_balanced.decoder.decimals_resolved', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: decoded.tokenAMint?.slice(0, 8) + '…',
        side: 'A',
        decimals: decA,
        source: resolved.source,
        validated: resolved.validated,
        reason: 'pool_account_update_missing_decimals',
        cat: 'pools'
      });
    }
    if (!Number.isFinite(decB) && decoded.tokenBMint) {
      const resolved = await resolveDecimalsGuaranteed(decoded.tokenBMint, poolId, dexName);
      decB = resolved.decimals;
      logger.info('meteora_balanced.decoder.decimals_resolved', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: decoded.tokenBMint?.slice(0, 8) + '…',
        side: 'B',
        decimals: decB,
        source: resolved.source,
        validated: resolved.validated,
        reason: 'pool_account_update_missing_decimals',
        cat: 'pools'
      });
    }
    
    // Calculate fee in BPS from the pool state
    let feeBps = existingPool?.fee_bps || 30; // Default 0.3%
    if (decoded.fees?.tradeFeeNumerator && decoded.fees?.tradeFeeDenominator) {
      const feeNum = Number(decoded.fees.tradeFeeNumerator);
      const feeDen = Number(decoded.fees.tradeFeeDenominator);
      if (feeDen > 0) {
        // Convert to BPS (basis points = 1/10000)
        feeBps = Math.round((feeNum / feeDen) * 10000);
      }
    }
    
    // Get vault balances from cache if available
    const balanceA = vaultBalanceCache.get(decoded.aVault) ?? null;
    const balanceB = vaultBalanceCache.get(decoded.bVault) ?? null;
    
    // Calculate price based on pool version
    // CRITICAL: V1 and V2 use DIFFERENT pricing mechanisms!
    let processedPrice: ProcessedPriceResult | null = null;
    let reserveA: bigint | null = balanceA;
    let reserveB: bigint | null = balanceB;
    
    // Try to get reserves from existing pool if vault balances not available
    if (reserveA === null && existingPool?.native_reserve_a_raw) {
      reserveA = anyToBigInt(existingPool.native_reserve_a_raw);
    }
    if (reserveB === null && existingPool?.native_reserve_b_raw) {
      reserveB = anyToBigInt(existingPool.native_reserve_b_raw);
    }
    
    if (isV2 && decoded.sqrtPrice && decoded.sqrtPrice > BigInt(0)) {
      // V2 (CP-AMM): Use sqrtPrice for pricing - concentrated liquidity
      // This is the correct price, NOT derived from vault balances
      const cpAmmPrice = calculateCpAmmPrice(decoded.sqrtPrice, decA!, decB!);
      
      if (cpAmmPrice && Number.isFinite(cpAmmPrice) && cpAmmPrice > 0) {
        // Use the pipeline for canonicalization only, passing the pre-calculated price
        processedPrice = processPriceThroughPipeline({
          mintA: decoded.tokenAMint,
          mintB: decoded.tokenBMint,
          decimalsA: decA!,
          decimalsB: decB!,
          poolId,
          dex: dexName,
          poolType: 'amm',
          rawPrice: cpAmmPrice,  // Pre-calculated from sqrtPrice
        });
        
        logger.debug('meteora_balanced.v2.sqrtPrice_pricing', {
          poolId: poolId.slice(0, 8) + '…',
          sqrtPrice: decoded.sqrtPrice.toString().slice(0, 16) + '…',
          cpAmmPrice,
          decA,
          decB,
          cat: 'pools'
        });
      }
    }
    
    // Fallback to reserve-based pricing (V1, or V2 if sqrtPrice unavailable)
    if (!processedPrice && reserveA !== null && reserveB !== null) {
      processedPrice = processPriceThroughPipeline({
        mintA: decoded.tokenAMint,
        mintB: decoded.tokenBMint,
        decimalsA: decA!,
        decimalsB: decB!,
        poolId,
        dex: dexName,
        poolType: 'amm',
        reserveA,
        reserveB,
      });
    }
    
    // Calculate liquidity if we have reserves
    let liquidityBase = 0;
    if (reserveA !== null && reserveB !== null && decA && decB) {
      const wholeA = Number(reserveA) / Math.pow(10, decA);
      const wholeB = Number(reserveB) / Math.pow(10, decB);
      liquidityBase = Math.min(wholeA, wholeB);
    }
    
    // Build the pool item
    const item: AmmPool = {
      id: poolId,
      dex: dexName,
      mint_a: processedPrice?.mintA || decoded.tokenAMint,
      mint_b: processedPrice?.mintB || decoded.tokenBMint,
      fee_bps: feeBps,
      price_a_per_b: processedPrice?.priceForward || 0,
      liquidity_base: liquidityBase,
      updated_ms: Date.now(),
      pool_kind: 'amm',
      liquidity_display: liquidityBase,
      decimals_a: processedPrice?.decimalsA || decA,
      decimals_b: processedPrice?.decimalsB || decB,
      reserve_a_raw: processedPrice?.wasSwapped ? reserveB?.toString() : reserveA?.toString(),
      reserve_b_raw: processedPrice?.wasSwapped ? reserveA?.toString() : reserveB?.toString(),
      was_swapped: processedPrice?.wasSwapped,
      native_mint_a: decoded.tokenAMint,
      native_mint_b: decoded.tokenBMint,
      native_decimals_a: decA,
      native_decimals_b: decB,
      native_reserve_a_raw: reserveA?.toString(),
      native_reserve_b_raw: reserveB?.toString(),
      native_account_a: decoded.aVault,
      native_account_b: decoded.bVault,
      account_a: processedPrice?.wasSwapped ? decoded.bVault : decoded.aVault,
      account_b: processedPrice?.wasSwapped ? decoded.aVault : decoded.bVault,
      _pipelineProcessed: !!processedPrice,
      // Store sqrtPrice for V2 pools - used for pricing on subsequent vault updates
      ...(isV2 && decoded.sqrtPrice ? { _sqrtPrice: decoded.sqrtPrice.toString() } : {}),
    } as AmmPool;
    
    // If we don't have a valid price, we can still update the pool metadata
    // but won't mark it as fully decoded
    if (!processedPrice?.priceForward || !Number.isFinite(processedPrice.priceForward)) {
      // Update the pool in cache with whatever data we have
      const prev = metbalCache.data || { amm: [], clmm: [], cpmm: [] };
      const idx = prev.amm.findIndex(p => p.id === poolId);
      
      if (idx >= 0) {
        // Update existing pool metadata
        const updated = { ...prev.amm[idx] };
        updated.native_account_a = decoded.aVault;
        updated.native_account_b = decoded.bVault;
        updated.native_mint_a = decoded.tokenAMint;
        updated.native_mint_b = decoded.tokenBMint;
        updated.fee_bps = feeBps;
        updated.updated_ms = Date.now();
        
        // CRITICAL: Always store sqrtPrice for V2 pools from WS updates
        // This ensures vault updates can use it for correct pricing even if
        // price calculation failed (e.g., vault balances not yet available)
        if (isV2 && decoded.sqrtPrice && decoded.sqrtPrice > BigInt(0)) {
          (updated as any)._sqrtPrice = decoded.sqrtPrice.toString();
        }
        
        prev.amm[idx] = updated;
        metbalCache.data = prev;
        metbalCache.ts = Date.now();
        
        wsDeltaStats[statsKey].decoded += 1;
        wsDeltaStats[statsKey].applied += 1;
        wsDecodeStats[statsKey].successes += 1;
        
        return { success: true, pool: updated as DecodedPool };
      }
      
      // New pool without price - skip for now, will be picked up later
      wsDeltaStats[statsKey].skipped += 1;
      incrementSkipReason(statsKey, 'new_pool_no_price');
      return { success: true, skipped: true, skipReason: 'new_pool_no_price' };
    }
    
    // Validate decoded pool
    const validation = validateDecodedPool(statsKey, item, poolId);
    if (!validation.valid) {
      wsDecodeStats[statsKey].failures += 1;
      incrementSkipReason(statsKey, `validation_failed:${validation.reasons.join(',')}`);
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }
    
    // Update cache
    const prev = metbalCache.data || { amm: [], clmm: [], cpmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
    const idx = next.amm.findIndex(p => p.id === item.id);
    
    // Validate price delta against previous value
    // CRITICAL: Check was_swapped to handle orientation differences between HTTP and WS updates
    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const prevWasSwapped = (prevPool as any).was_swapped ?? false;
      const newWasSwapped = processedPrice?.wasSwapped ?? false;
      
      // Only validate price delta if orientations match
      if (prevWasSwapped === newWasSwapped) {
        validatePriceDelta(statsKey, poolId, item.price_a_per_b, prevPool.price_a_per_b);
      } else {
        // Orientation changed - compare with inverted previous price to avoid false alarms
        const adjustedPrevPrice = prevPool.price_a_per_b && prevPool.price_a_per_b > 0 
          ? 1 / prevPool.price_a_per_b 
          : undefined;
        validatePriceDelta(statsKey, poolId, item.price_a_per_b, adjustedPrevPrice);
        
        logger.debug('meteora_balanced.orientation_flip', {
          poolId: poolId.slice(0, 8) + '…',
          prevWasSwapped,
          newWasSwapped,
          prevPrice: prevPool.price_a_per_b,
          newPrice: item.price_a_per_b,
          adjustedPrevPrice,
          cat: 'pools'
        });
      }
    }
    
    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        const orientationIndependentFields = {
          tvl_usd: prevPool.tvl_usd,
          liquidity_display: prevPool.liquidity_display,
          pool_liquidity_raw: prevPool.pool_liquidity_raw,
          // Preserve native reserves - they're in on-chain order, not affected by canonicalization
          native_reserve_a_raw: (prevPool as any).native_reserve_a_raw,
          native_reserve_b_raw: (prevPool as any).native_reserve_b_raw,
        };
        next.amm[idx] = { ...item, ...orientationIndependentFields };
      } else {
        next.amm[idx] = { ...next.amm[idx], ...item };
      }
    } else {
      next.amm.push(item);
    }
    
    // Update stats and cache
    wsDecodeStats[statsKey].successes += 1;
    wsDeltaStats[statsKey].decoded += 1;
    
    const delta = diffNormalizedPools(prev, next);
    metbalCache.data = next;
    metbalCache.ts = Date.now();
    
    // CRITICAL: Update execution cache with native mints and was_swapped for direction calculation
    const programId = isV2 ? METEORA_BALANCED_V2_PROGRAM : METEORA_BALANCED_V1_PROGRAM;
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const existingStatic = executionCache.getStatic(poolId) || {} as any;
      executionCache.setStatic(poolId, {
        ...existingStatic,
        programId,
        dex: 'meteora_balanced',
        pool_kind: 'amm',
        mint_a: item.mint_a,
        mint_b: item.mint_b,
        decimals_a: item.decimals_a,
        decimals_b: item.decimals_b,
        vault_a: decoded.aVault,
        vault_b: decoded.bVault,
        native_mint_a: decoded.tokenAMint,
        native_mint_b: decoded.tokenBMint,
        native_account_a: decoded.aVault,
        native_account_b: decoded.bVault,
        was_swapped: processedPrice?.wasSwapped,
      });
    } catch (e) { logCatchError('meteora_balanced.cache', e); }
    
    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats[statsKey].applied += 1;
    } else {
      wsDeltaStats[statsKey].skipped += 1;
      incrementSkipReason(statsKey, 'no_delta');
    }
    
    // Emit update event
    try {
      emit('pool-updates', {
        source: 'meteora_balanced',
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now()
      });
    } catch {}
    
    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply(isV2 ? 'meteora_damm_v2' : 'meteora_damm_v1', prev);
    }
    
    // Try to activate pool for lazy activation mode
    const hasValidPrice = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, statsKey, hasValidPrice);
    
    // Track successful activity for staleness monitoring
    recordPoolActivity(poolId, statsKey, poolId);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats[statsKey].failures += 1;
    logCatchError('meteora_balanced.handlePoolAccountUpdate', e, { pool: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Meteora Balanced WebSocket account update
 * 
 * Routes updates to appropriate handlers based on account type:
 * 1. Pool accounts (owned by DAMM v1 program) → handleMeteoraBalancedPoolAccountUpdate (meteora_damm_v1)
 * 2. Vault accounts (derived from pools) → handleMeteoraBalancedVaultUpdate (meteora_damm_v2)
 */
export async function handleMeteoraBalancedUpdate(
  info: AccountInfo,
  accountAddress: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map()
): Promise<UpdateResult> {
  try {
    // Note: Attempts are tracked per version in individual handlers
    
    const owner = typeof info.owner === 'string' ? info.owner : info.owner?.toBase58?.() || '';
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    // Check if this is a pool account (owned by DAMM v1 or v2 program)
    if (owner === METEORA_BALANCED_V1_PROGRAM) {
      // This is a direct DAMM v1 pool account update
      logger.debug('meteora_balanced.update.pool_account', {
        account: accountAddress.slice(0, 8) + '…',
        dataLen: data.length,
        version: 'v1',
        cat: 'pools'
      });
      return handleMeteoraBalancedPoolAccountUpdate(info, accountAddress);
    }
    
    if (owner === METEORA_BALANCED_V2_PROGRAM) {
      // This is a direct DAMM v2 (CP-AMM) pool account update
      // Note: V2 pools are typically updated via vault balance changes,
      // but direct pool account updates should also be handled
      logger.debug('meteora_balanced.update.pool_account', {
        account: accountAddress.slice(0, 8) + '…',
        dataLen: data.length,
        version: 'v2',
        cat: 'pools'
      });
      // V2 pool accounts have different structure - route to vault update path
      // since we track V2 pools via their vault balances
      const poolData = findPoolInCache(accountAddress);
      if (poolData && poolData.source === 'meteora_balanced') {
        // Pool is known, but we need vault balances to update price
        // Log and skip - vault updates will provide the balance data
        logger.debug('meteora_balanced.update.v2_pool_direct', {
          account: accountAddress.slice(0, 8) + '…',
          hint: 'V2 pools update via vault balances',
          cat: 'pools'
        });
        return { success: true, skipped: true, skipReason: 'v2_pool_via_vault' };
      }
      // Unknown V2 pool - skip for now
      wsDeltaStats.meteora_damm_v2.skipped += 1;
      incrementSkipReason('meteora_damm_v2', 'unknown_v2_pool');
      return { success: true, skipped: true, skipReason: 'unknown_v2_pool' };
    }
    
    // Check if this is a derived account (vault)
    const derivedMeta = derivedAccountToPool.get(accountAddress);
    if (!derivedMeta) {
      // Not a known vault, try to decode as pool account anyway
      // (in case the pool wasn't registered in derivedAccountToPool)
      if (data.length >= MIN_DAMM_V1_POOL_BUFFER_LENGTH) {
        const decoded = await decodeDammV1PoolAccount(data);
        if (decoded && decoded.tokenAMint && decoded.tokenBMint) {
          logger.debug('meteora_balanced.update.unregistered_pool', {
            account: accountAddress.slice(0, 8) + '…',
            tokenA: decoded.tokenAMint.slice(0, 8) + '…',
            tokenB: decoded.tokenBMint.slice(0, 8) + '…',
            cat: 'pools'
          });
          return handleMeteoraBalancedPoolAccountUpdate(info, accountAddress);
        }
      }
      
      logger.debug('meteora_balanced.update.unknown_account', {
        account: accountAddress.slice(0, 8) + '…',
        owner: owner.slice(0, 8) + '…',
        dataLen: data.length,
        cat: 'pools'
      });
      wsDeltaStats.meteora_damm_v2.skipped += 1;
      incrementSkipReason('meteora_damm_v2', 'unknown_account');
      return { success: false, error: 'unknown_account', skipped: true };
    }

    if (derivedMeta.accountType !== 'vault' && derivedMeta.accountType !== 'reserve') {
      logger.debug('meteora_balanced.update.not_vault', {
        account: accountAddress.slice(0, 8) + '…',
        accountType: derivedMeta.accountType,
        cat: 'pools'
      });
      wsDeltaStats.meteora_damm_v2.skipped += 1;
      incrementSkipReason('meteora_damm_v2', 'not_vault');
      return { success: true, skipped: true, skipReason: 'not_vault' };
    }

    return handleMeteoraBalancedVaultUpdate(info, accountAddress, derivedMeta.poolId);
  } catch (e) {
    wsDecodeStats.meteora_damm_v2.failures += 1;
    logCatchError('meteora_balanced.handleUpdate', e, { account: accountAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is a Meteora Balanced program
 */
export function isMeteoraBalancedOwner(owner: string): boolean {
  return owner === METEORA_BALANCED_V1_PROGRAM || owner === METEORA_BALANCED_V2_PROGRAM;
}

/**
 * Get Meteora Balanced program IDs
 */
export const METEORA_BALANCED_PROGRAMS = {
  V1: METEORA_BALANCED_V1_PROGRAM,
  V2: METEORA_BALANCED_V2_PROGRAM,
};

