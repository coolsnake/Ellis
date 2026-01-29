/**
 * WebSocket Pool Decoders - Unified Export
 * 
 * This module provides a unified entry point for all DEX-specific pool decoders.
 * Each decoder handles WebSocket account updates for its respective DEX.
 * 
 * All decoders:
 * 1. Parse raw account data using DEX-specific SDKs/layouts
 * 2. Process prices through the centralized price pipeline
 * 3. Validate decoded pools before applying to cache
 * 4. Schedule incremental graph updates on changes
 */

// Raydium decoder (AMM V4 + CLMM)
export {
  decodeRaydiumClmmPool,
  decodeRaydiumAmmPool,
  handleRaydiumUpdate,
  isRaydiumOwner,
  RAYDIUM_PROGRAMS,
} from './raydium.js';

// Orca decoder (Whirlpools CLMM)
export {
  decodeOrcaWhirlpool,
  handleOrcaUpdate,
  isOrcaOwner,
  ORCA_PROGRAM,
} from './orca.js';

// Meteora DLMM decoder
export {
  decodeMeteoraLbPair,
  decodeMeteoraBinArray,
  handleMeteoraUpdate,
  isMeteoraOwner,
  METEORA_PROGRAM,
} from './meteora.js';

// Pumpswap decoder (AMM via pool and vault updates)
export {
  decodePumpswapPool,
  decodePumpswapPoolState,
  handlePumpswapPoolAccountUpdate,
  handlePumpswapVaultUpdate,
  handlePumpswapUpdate,
  isPumpswapOwner,
  PUMPSWAP_PROGRAM,
  PUMPSWAP_PROGRAMS,
  PUMPSWAP_BONDING_CURVE_PROGRAM_ID,
  PUMPSWAP_AMM_PROGRAM_ID,
} from './pumpswap.js';

// Meteora Balanced decoder (DAMM via vault updates)
export {
  decodeMeteoraBalancedPool,
  decodeDammV1PoolAccount,
  decodeDammV2PoolAccount,
  decodeMeteoraBalancedPoolAccount,
  handleMeteoraBalancedVaultUpdate,
  handleMeteoraBalancedUpdate,
  isMeteoraBalancedOwner,
  calculateCpAmmPrice,
  METEORA_BALANCED_PROGRAMS,
  METEORA_BALANCED_V1_PROGRAM,
  METEORA_BALANCED_V2_PROGRAM,
} from './meteoraBalanced.js';

// Raydium CPMM decoder
export {
  decodeRaydiumCpmmPool,
  handleRaydiumCpmmUpdate,
  handleCpmmVaultUpdate,
  isRaydiumCpmmOwner,
  RAYDIUM_CPMM_PROGRAM_ID,
} from './raydiumCpmm.js';

// Shared types
export type {
  DexSource,
  PoolType,
  DecodedPool,
  PoolDelta,
  UpdateResult,
  AccountInfo,
  ProcessedPriceResult,
  ValidationResult,
  PoolCache,
  DerivedAccountInfo,
  DerivedCacheFields,
  DecoderContext,
  DecoderHandler,
  DecodeFunction,
} from './types.js';

// Per-pool staleness tracking (monitoring/alerting only, no auto-resubscription)
export {
  recordPoolActivity,
  registerPoolSubscription,
  unregisterPool,
  unregisterPools,
  clearPoolActivityTracking,
  checkPoolStaleness,
  setResubscribeCallback,
  startStalenessMonitor,
  stopStalenessMonitor,
  isStalenessMonitorRunning,
  getStalenessStatus,
  getPoolActivityAge,
  getTrackedPoolIds,
  getPoolsExceedingAge,
} from '../staleness.js';

export type {
  PoolActivityState,
  StalenessCheckResult,
} from '../staleness.js';

/**
 * Route WebSocket account update to the appropriate decoder based on program owner
 */
export async function routeAccountUpdate(
  owner: string,
  info: { data: Buffer; owner: any },
  poolId: string,
  derivedAccountToPool?: Map<string, { poolId: string; accountType: string }>
): Promise<{ handled: boolean; dex?: string; result?: any }> {
  const { handleRaydiumUpdate, isRaydiumOwner } = await import('./raydium.js');
  const { handleRaydiumCpmmUpdate, isRaydiumCpmmOwner } = await import('./raydiumCpmm.js');
  const { handleOrcaUpdate, isOrcaOwner } = await import('./orca.js');
  const { handleMeteoraUpdate, isMeteoraOwner } = await import('./meteora.js');
  const { handlePumpswapUpdate, isPumpswapOwner } = await import('./pumpswap.js');
  const { handleMeteoraBalancedUpdate, isMeteoraBalancedOwner } = await import('./meteoraBalanced.js');

  const derivedMap = derivedAccountToPool as Map<string, { poolId: string; accountType: 'vault' | 'reserve' | 'tick_array' | 'oracle' | 'observation' }> || new Map();

  // Check Raydium CPMM first (more specific)
  if (isRaydiumCpmmOwner(owner)) {
    const result = await handleRaydiumCpmmUpdate(info as any, poolId, derivedMap);
    return { handled: true, dex: 'raydium-cpmm', result };
  }

  if (isRaydiumOwner(owner)) {
    const result = await handleRaydiumUpdate(info as any, poolId, derivedMap);
    return { handled: true, dex: 'raydium', result };
  }

  if (isOrcaOwner(owner)) {
    const result = await handleOrcaUpdate(info as any, poolId, derivedMap);
    return { handled: true, dex: 'orca', result };
  }

  if (isMeteoraOwner(owner)) {
    const result = await handleMeteoraUpdate(info as any, poolId, derivedMap);
    return { handled: true, dex: 'meteora', result };
  }

  // For Pumpswap and Meteora Balanced, check if account is a known vault
  const derivedMeta = derivedMap.get(poolId);
  if (derivedMeta) {
    // Check the source from the target map
    // This would need to be passed in or looked up from cache
  }

  return { handled: false };
}

/**
 * Get all decoder program IDs for subscription filtering
 */
export function getAllProgramIds(): string[] {
  return [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // PumpSwap (bonding curve)
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM (post-graduation)
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Balanced V1 (Dynamic AMM)
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora Balanced V2 (CP-AMM)
  ];
}


