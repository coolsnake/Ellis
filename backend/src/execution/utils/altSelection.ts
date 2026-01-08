/**
 * Route-aware ALT selection for optimizing transaction size
 * Selects the minimum set of ALTs needed for a given route
 */

import { AddressLookupTableAccount } from '@solana/web3.js';
import { loadAltConfig, type AltConfig } from './altConfig.js';
import { dexAltManager } from './altManager.js';
import { logger } from '../../utils/logger.js';

/**
 * DEX type enumeration for estimating account requirements
 */
export enum DexType {
  Raydium = 0,
  Meteora = 1,
  Orca = 2,
  PumpSwap = 3,
}

/**
 * Estimated accounts per hop by DEX type
 * Used for transaction size estimation
 */
const ACCOUNTS_PER_HOP: Record<number, number> = {
  [DexType.Raydium]: 18,   // Raydium CLMM
  [DexType.Meteora]: 18,   // Meteora DLMM
  [DexType.Orca]: 12,      // Orca Whirlpool
  [DexType.PumpSwap]: 10,  // PumpSwap
};

/**
 * Select optimal ALTs for a route
 * Always includes common/flashloan/userPdas ALTs plus pool-specific ALTs
 * Falls back to including all DEX ALTs when pool-specific coverage is low
 * 
 * @param poolIds Array of pool addresses in the route
 * @param config ALT configuration (optional, will load if not provided)
 * @returns Array of ALT addresses to use
 */
export function selectAltsForRoute(
  poolIds: string[],
  config: AltConfig
): string[] {
  const altAddresses = new Set<string>();

  // Always include static ALTs if they exist
  if (config.alts.common) {
    altAddresses.add(config.alts.common);
  }
  if (config.alts.flashloan) {
    altAddresses.add(config.alts.flashloan);
  }
  if (config.alts.userPdas) {
    altAddresses.add(config.alts.userPdas);
  }

  // Track how many pools have specific ALT coverage
  let poolsCovered = 0;

  // Add pool-specific ALTs from poolToAlt mapping (O(1) per pool)
  if (config.poolToAlt) {
    for (const poolId of poolIds) {
      // Strip directional suffixes for lookup
      const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
      const altAddress = config.poolToAlt[cleanPoolId];
      if (altAddress) {
        altAddresses.add(altAddress);
        poolsCovered++;
      }
    }
  }

  // Fallback: If pool-specific coverage is low, include ALL DEX ALTs
  // This ensures partial coverage even for unmapped pools
  const staticAltCount = (config.alts.common ? 1 : 0) + 
                         (config.alts.flashloan ? 1 : 0) + 
                         (config.alts.userPdas ? 1 : 0);
  const hasLowCoverage = poolIds.length > 0 && poolsCovered < poolIds.length;
  
  if (hasLowCoverage || altAddresses.size <= staticAltCount) {
    // Include all DEX ALTs as fallback
    if (config.dexAlts?.raydium?.addresses) {
      for (const addr of config.dexAlts.raydium.addresses) {
        altAddresses.add(addr);
      }
    }
    if (config.dexAlts?.orca?.addresses) {
      for (const addr of config.dexAlts.orca.addresses) {
        altAddresses.add(addr);
      }
    }
    if (config.dexAlts?.meteora?.addresses) {
      for (const addr of config.dexAlts.meteora.addresses) {
        altAddresses.add(addr);
      }
    }
  }

  // Also include legacy ALTs if they exist
  if (config.alts.pools) {
    altAddresses.add(config.alts.pools);
  }
  if (config.alts.clmm) {
    altAddresses.add(config.alts.clmm);
  }
  if (config.alts.tokens) {
    altAddresses.add(config.alts.tokens);
  }

  return Array.from(altAddresses);
}

/**
 * Result of loading ALTs for a route
 */
export interface LoadAltsResult {
  /** Loaded ALT accounts ready for transaction */
  lookupTables: AddressLookupTableAccount[];
  /** Coverage percentage (0-1) of pools in route */
  coverage: number;
  /** Pools not covered by any ALT */
  missingPools: string[];
  /** Pools covered by ALTs */
  coveredPools: string[];
  /** ALT addresses selected */
  altAddresses: string[];
}

/**
 * Load ALT accounts for a route with coverage analysis
 * 
 * @param poolIds Array of pool addresses in the route
 * @param config Optional ALT configuration (will load if not provided)
 * @returns LoadAltsResult with lookup tables and coverage info
 */
export async function loadAltsForRoute(
  poolIds: string[],
  config?: AltConfig
): Promise<LoadAltsResult> {
  // Load config if not provided
  const altConfig = config || await loadAltConfig();
  
  // Select ALTs for this route
  const selectedAlts = selectAltsForRoute(poolIds, altConfig);
  
  // Load ALT accounts from cache
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const altAddr of selectedAlts) {
    const cached = dexAltManager.getCachedAltByAddress(altAddr);
    if (cached) {
      lookupTables.push(cached);
    } else {
      // Try to load from the manager's general cache
      const allCached = dexAltManager.getCachedAltAccounts();
      const found = allCached.find(alt => alt.key.toBase58() === altAddr);
      if (found) {
        lookupTables.push(found);
      }
    }
  }

  // Calculate coverage
  const coveredPools: string[] = [];
  const missingPools: string[] = [];
  
  for (const poolId of poolIds) {
    const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
    if (altConfig.poolToAlt?.[cleanPoolId]) {
      coveredPools.push(cleanPoolId);
    } else {
      missingPools.push(cleanPoolId);
    }
  }

  const coverage = poolIds.length > 0 
    ? coveredPools.length / poolIds.length 
    : 0;

  try {
    logger.debug('alt.selection.loadAltsForRoute', {
      cat: 'tx',
      ctx: {
        poolCount: poolIds.length,
        selectedAltCount: selectedAlts.length,
        loadedAltCount: lookupTables.length,
        coverage: `${(coverage * 100).toFixed(1)}%`,
        missingPoolCount: missingPools.length,
      },
    });
  } catch {}

  return {
    lookupTables,
    coverage,
    missingPools,
    coveredPools,
    altAddresses: selectedAlts,
  };
}

/**
 * Estimate if a route will fit in a transaction with current ALT coverage
 */
export interface RouteFitEstimate {
  /** Whether the route likely fits in a transaction */
  canFit: boolean;
  /** Estimated transaction size in bytes */
  estimatedSize: number;
  /** Maximum allowed size (1232 bytes) */
  maxSize: number;
  /** Recommended minimum coverage for this route */
  recommendedCoverage: number;
  /** Warning message if coverage is low */
  warning?: string;
}

/**
 * Estimate if a route will fit in a transaction
 * 
 * @param hops Number of hops in the route
 * @param coverage ALT coverage percentage (0-1)
 * @param dexTypes DEX types for each hop
 * @returns RouteFitEstimate with size analysis
 */
export function estimateRouteFit(
  hops: number,
  coverage: number,
  dexTypes: DexType[]
): RouteFitEstimate {
  const maxSize = 1232; // Solana transaction size limit
  
  // Calculate total accounts needed
  let totalAccounts = 3; // Base accounts: user, userTokenAccount, TOKEN_PROGRAM_ID
  
  for (let i = 0; i < hops && i < dexTypes.length; i++) {
    const dexType = dexTypes[i];
    totalAccounts += ACCOUNTS_PER_HOP[dexType] || 15; // Default to 15 if unknown
  }

  // Calculate estimated size
  // With ALT coverage: covered accounts = 1 byte each, uncovered = 32 bytes each
  const coveredAccounts = Math.floor(totalAccounts * coverage);
  const uncoveredAccounts = totalAccounts - coveredAccounts;
  
  // Overhead: signatures (~64), blockhash (~32), instruction data (~100), headers (~50)
  const overhead = 250;
  
  const accountBytes = (coveredAccounts * 1) + (uncoveredAccounts * 32);
  const estimatedSize = accountBytes + overhead;

  // Determine recommended coverage based on hops
  let recommendedCoverage: number;
  if (hops >= 4) {
    recommendedCoverage = 0.8; // 80% for 4+ hops
  } else if (hops >= 3) {
    recommendedCoverage = 0.6; // 60% for 3 hops
  } else if (hops >= 2) {
    recommendedCoverage = 0.4; // 40% for 2 hops
  } else {
    recommendedCoverage = 0; // Single hop usually fits without ALTs
  }

  const canFit = estimatedSize < maxSize;
  
  let warning: string | undefined;
  if (!canFit) {
    warning = `Transaction too large (${estimatedSize} bytes > ${maxSize}). Need higher ALT coverage.`;
  } else if (coverage < recommendedCoverage) {
    warning = `Low ALT coverage (${(coverage * 100).toFixed(1)}%). Recommended: ${(recommendedCoverage * 100).toFixed(0)}% for ${hops}-hop routes.`;
  }

  return {
    canFit,
    estimatedSize,
    maxSize,
    recommendedCoverage,
    warning,
  };
}

/**
 * Get all static ALTs (common, flashloan, userPdas)
 * These should always be loaded regardless of route
 */
export async function getStaticAlts(): Promise<string[]> {
  const config = await loadAltConfig();
  const alts: string[] = [];
  
  if (config.alts.common) alts.push(config.alts.common);
  if (config.alts.flashloan) alts.push(config.alts.flashloan);
  if (config.alts.userPdas) alts.push(config.alts.userPdas);
  
  return alts;
}

/**
 * Load static ALT accounts
 * Returns lookup tables for common/flashloan/userPdas ALTs
 */
export async function loadStaticAlts(): Promise<AddressLookupTableAccount[]> {
  const addresses = await getStaticAlts();
  const lookupTables: AddressLookupTableAccount[] = [];
  
  for (const addr of addresses) {
    const cached = dexAltManager.getCachedAltByAddress(addr);
    if (cached) {
      lookupTables.push(cached);
    }
  }
  
  return lookupTables;
}

/**
 * Analyze ALT requirements for a route and suggest actions
 */
export interface RouteAltAnalysis {
  /** Is route executable with current ALTs? */
  canExecute: boolean;
  /** ALTs to use for this route */
  altsToUse: string[];
  /** Lookup tables loaded from cache */
  lookupTables: AddressLookupTableAccount[];
  /** Coverage analysis */
  coverage: {
    percentage: number;
    coveredPools: string[];
    missingPools: string[];
  };
  /** Size estimation */
  sizeEstimate: RouteFitEstimate;
  /** Suggested actions to improve */
  suggestions: string[];
}

/**
 * Comprehensive analysis of ALT requirements for a route
 * 
 * @param poolIds Pool addresses in the route
 * @param dexTypes DEX types for each hop
 * @returns Complete analysis with suggestions
 */
export async function analyzeRouteAlts(
  poolIds: string[],
  dexTypes: DexType[]
): Promise<RouteAltAnalysis> {
  const config = await loadAltConfig();
  
  // Load ALTs for route
  const loadResult = await loadAltsForRoute(poolIds, config);
  
  // Estimate fit
  const sizeEstimate = estimateRouteFit(
    poolIds.length,
    loadResult.coverage,
    dexTypes
  );

  // Determine if executable
  const canExecute = sizeEstimate.canFit && loadResult.lookupTables.length > 0;

  // Generate suggestions
  const suggestions: string[] = [];
  
  if (loadResult.missingPools.length > 0) {
    suggestions.push(
      `${loadResult.missingPools.length} pool(s) not covered by ALTs. ` +
      `Consider running createDexPoolAlts() to add them.`
    );
  }
  
  if (!config.alts.common) {
    suggestions.push('Common ALT not created. Run ALT creation for common accounts.');
  }
  
  if (!config.alts.flashloan) {
    suggestions.push('Flashloan ALT not created. Create one for flashloan-enabled routes.');
  }
  
  if (!sizeEstimate.canFit) {
    suggestions.push(
      `Transaction estimated at ${sizeEstimate.estimatedSize} bytes, exceeds limit. ` +
      `Need ${((1 - (1232 - 250) / (poolIds.length * 18 * 32)) * 100).toFixed(0)}%+ coverage.`
    );
  }
  
  if (loadResult.coverage < sizeEstimate.recommendedCoverage) {
    suggestions.push(
      `Coverage ${(loadResult.coverage * 100).toFixed(1)}% below recommended ` +
      `${(sizeEstimate.recommendedCoverage * 100).toFixed(0)}% for ${poolIds.length}-hop routes.`
    );
  }

  try {
    logger.info('alt.selection.analyzeRouteAlts', {
      cat: 'tx',
      ctx: {
        hops: poolIds.length,
        canExecute,
        coverage: `${(loadResult.coverage * 100).toFixed(1)}%`,
        estimatedSize: sizeEstimate.estimatedSize,
        altCount: loadResult.lookupTables.length,
        suggestions: suggestions.length,
      },
    });
  } catch {}

  return {
    canExecute,
    altsToUse: loadResult.altAddresses,
    lookupTables: loadResult.lookupTables,
    coverage: {
      percentage: loadResult.coverage,
      coveredPools: loadResult.coveredPools,
      missingPools: loadResult.missingPools,
    },
    sizeEstimate,
    suggestions,
  };
}

