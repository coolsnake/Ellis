/**
 * Centralized Pricing Pipeline - Simplified
 * 
 * All pool prices flow through this pipeline.
 * 
 * ARCHITECTURE:
 * 1. DEX-specific normalizers extract raw data (handling varied field names)
 * 2. DEX-specific formulas calculate prices (sqrt, bin, reserves)
 * 3. Centralized pipeline processes prices (canonicalization only)
 * 4. Graph builder uses processed prices for edges
 * 
 * FLOW:
 * Raw DEX Data → Field Mapping → Price Formula → Pipeline → Canonical Pool → Graph Edges
 * 
 * NO calibration, NO rescaling - trust the mathematical formulas
 */

import { canonicalOrientation } from './canonical.js';
import { logger } from '../../utils/logger.js';
import { calculateAmmPrice, calculateClmmPrice, calculateMeteoraPrice } from './priceFormulas.js';
import { logCatchError } from '../../utils/errorHandler.js';

/**
 * Raw price input from DEX-specific calculation
 * This represents the price in the DEX's native orientation
 */
export interface RawPriceInput {
  mintA: string;           // Mint A (in DEX's native order, pre-canonical)
  mintB: string;           // Mint B (in DEX's native order, pre-canonical)
  rawPrice?: number;       // Optional: Price A-per-B in whole token units, DEX's native orientation
  decimalsA: number;       // Decimals for mint A
  decimalsB: number;       // Decimals for mint B
  poolId?: string;         // Pool ID for diagnostics
  dex?: string;            // DEX name for diagnostics
  poolType?: 'amm' | 'clmm' | 'dlmm' | 'cpmm';

  // Add raw data fields for direct calculation inside pipeline
  sqrtPriceX64?: bigint | number;
  activeId?: number;
  binStep?: number;
  tokenXMint?: string; // For Meteora
  tokenYMint?: string; // For Meteora
  reserveA?: bigint | number;
  reserveB?: bigint | number;
}

/**
 * Processed price output in canonical orientation
 */
export interface ProcessedPrice {
  mintA: string;           // Mint A (canonical order)
  mintB: string;           // Mint B (canonical order)
  priceForward: number;    // Canonical A-per-B
  priceReverse: number;    // Canonical B-per-A (inverted)
  wasSwapped: boolean;     // True if orientation was changed
  decimalsA: number;       // Decimals for canonical mint A
  decimalsB: number;       // Decimals for canonical mint B
}

/**
 * Options for price processing
 */
export interface PriceProcessingOptions {
  diagnostics?: boolean;                           // Enable diagnostic logging
}

/**
 * Canonicalize price orientation
 * 
 * Checks if mints need to be swapped according to quote hierarchy.
 * If swap is needed, inverts the price.
 */
function canonicalizeOrientation(input: RawPriceInput): {
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  wasSwapped: boolean;
  price: number;
} {
  const orientation = canonicalOrientation(input.mintA, input.mintB);
  const needsSwap = orientation === 'swap';

  if (needsSwap) {
    // Swap mints and invert price
    const invertedPrice = input.rawPrice! > 0 ? 1 / input.rawPrice! : 0;
    
    return {
      mintA: input.mintB,
      mintB: input.mintA,
      price: invertedPrice,
      decimalsA: input.decimalsB,
      decimalsB: input.decimalsA,
      wasSwapped: true,
    };
  }

  return {
    mintA: input.mintA,
    mintB: input.mintB,
    price: input.rawPrice!,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    wasSwapped: false,
  };
}


/**
 * SIMPLIFIED PRICE PIPELINE
 * 
 * Processes a raw price through the pipeline:
 * 1. Calculate raw price from formula (if not provided)
 * 2. Canonicalize orientation (swap if needed)
 * 3. Calculate reverse edge
 * 
 * NO calibration, NO rescaling - trust the mathematical formulas
 * 
 * @param input Raw price from DEX-specific calculation
 * @param options Processing options
 * @returns Processed price ready for graph edge creation
 */
export function processPriceThroughPipeline(
  input: RawPriceInput,
  options: PriceProcessingOptions = {}
): ProcessedPrice | undefined {
  // STEP 0: Calculate raw price from formula if not provided
  if (input.rawPrice == null || !Number.isFinite(input.rawPrice)) {
    if (input.dex === 'Meteora' && (input.poolType === 'clmm' || input.poolType === 'dlmm') && input.activeId != null && input.binStep != null && input.tokenXMint && input.tokenYMint) {
      input.rawPrice = calculateMeteoraPrice(input.activeId, input.binStep, input.tokenXMint, input.tokenYMint, input.mintA, input.mintB, input.decimalsA, input.decimalsB);
    } else if (input.poolType === 'clmm' && input.sqrtPriceX64) {
      input.rawPrice = calculateClmmPrice(input.sqrtPriceX64, input.decimalsA, input.decimalsB, input.mintA, input.mintB);
    } else if ((input.poolType === 'amm' || input.poolType === 'cpmm') && input.reserveA != null && input.reserveB != null) {
      // AMM and CPMM both use constant product formula: Price A-per-B = reserveB / reserveA
      // This is the correct marginal price: how many B you get for 1 A
      input.rawPrice = calculateAmmPrice(input.reserveA, input.reserveB, input.decimalsA, input.decimalsB);
    }
  }

  // Validate input
  if (!input.mintA || !input.mintB || input.mintA === input.mintB) {
    return undefined;
  }

  if (!Number.isFinite(input.rawPrice) || input.rawPrice <= 0) {
    return undefined;
  }

  if (!Number.isFinite(input.decimalsA) || !Number.isFinite(input.decimalsB)) {
    return undefined;
  }

  try {
    // STEP 1: Canonicalize orientation
    const canonical = canonicalizeOrientation(input);
    
    // Diagnostic logging to trace canonicalization
    try {
      logger.debug('price.pipeline.canonicalization', {
        dex: input.dex,
        pool: input.poolId?.slice(0, 8),
        input_mintA: input.mintA.slice(0, 8),
        input_mintB: input.mintB.slice(0, 8),
        input_price: input.rawPrice,
        canonical_mintA: canonical.mintA.slice(0, 8),
        canonical_mintB: canonical.mintB.slice(0, 8),
        canonical_price: canonical.price,
        wasSwapped: canonical.wasSwapped,
        cat: 'price.pipeline'
      });
    } catch (e) { logCatchError('pools.pricePipeline', e); }
    
    // STEP 2: Use the price directly - NO calibration, NO rescaling
    const forward = canonical.price;

    if (!forward || forward <= 0 || !Number.isFinite(forward)) {
      return undefined;
    }

    // STEP 3: Calculate reverse price
    const reverse = 1 / forward;
    
    // Diagnostic: Check if forward * reverse ≈ 1
    if (options.diagnostics) {
      const product = forward * reverse;
      if (Math.abs(product - 1) > 0.001) {
        try {
          logger.warn('price.pipeline.product_check', {
            dex: input.dex,
            pool_id: input.poolId?.slice(0, 12),
            mint_a: canonical.mintA.slice(0, 8),
            mint_b: canonical.mintB.slice(0, 8),
            forward,
            reverse,
            product,
            deviation: Math.abs(product - 1),
            cat: 'price.pipeline'
          });
        } catch (e) { logCatchError('pools.pricePipeline', e); }
      }
    }

    return {
      mintA: canonical.mintA,
      mintB: canonical.mintB,
      priceForward: forward,
      priceReverse: reverse,
      wasSwapped: canonical.wasSwapped,
      decimalsA: canonical.decimalsA,
      decimalsB: canonical.decimalsB,
    };
  } catch (error) {
    try {
      logger.error('price.pipeline.error', {
        error: String(error),
        dex: input.dex,
        pool_id: input.poolId?.slice(0, 12),
        cat: 'price.pipeline'
      });
    } catch (e) { logCatchError('pools.pricePipeline', e); }
    return undefined;
  }
}

/**
 * Batch process multiple prices through the pipeline
 * Useful for normalizers that process many pools at once
 */
export function processPricesBatch(
  inputs: RawPriceInput[],
  options: PriceProcessingOptions = {}
): Map<string, ProcessedPrice> {
  const results = new Map<string, ProcessedPrice>();
  
  for (const input of inputs) {
    const processed = processPriceThroughPipeline(input, options);
    if (processed && input.poolId) {
      results.set(input.poolId, processed);
    }
  }
  
  return results;
}


