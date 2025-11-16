/**
 * Centralized Pricing Pipeline - Single Source of Truth
 * 
 * All pool prices flow through this pipeline to ensure consistency.
 * 
 * ARCHITECTURE:
 * 1. DEX-specific normalizers extract raw data (handling varied field names)
 * 2. DEX-specific formulas calculate prices (sqrt, bin, reserves)
 * 3. Centralized pipeline processes prices (canonicalization, calibration)
 * 4. Graph builder uses processed prices for edges
 * 
 * FLOW:
 * Raw DEX Data → Field Mapping → Price Formula → Pipeline → Canonical Pool → Graph Edges
 */

import { canonicalOrientation, swapPoolFields } from './canonical.js';
import { computePriceForward, computePriceReverse } from '../graph.pricing.js';
import { logger } from '../../utils/logger.js';

/**
 * Raw price input from DEX-specific calculation
 * This represents the price in the DEX's native orientation
 */
export interface RawPriceInput {
  mintA: string;           // Mint A (in DEX's native order, pre-canonical)
  mintB: string;           // Mint B (in DEX's native order, pre-canonical)
  rawPrice: number;        // Price A-per-B in whole token units, DEX's native orientation
  decimalsA: number;       // Decimals for mint A
  decimalsB: number;       // Decimals for mint B
  poolId?: string;         // Pool ID for diagnostics
  dex?: string;            // DEX name for diagnostics
  poolType?: 'amm' | 'clmm';
}

/**
 * Processed price output in canonical orientation
 */
export interface ProcessedPrice {
  mintA: string;           // Mint A (canonical order)
  mintB: string;           // Mint B (canonical order)
  priceForward: number;    // Canonical A-per-B (calibrated & rescaled)
  priceReverse: number;    // Canonical B-per-A (inverted & rescaled)
  wasSwapped: boolean;     // True if orientation was changed
  decimalsA: number;       // Decimals for canonical mint A
  decimalsB: number;       // Decimals for canonical mint B
}

/**
 * Options for price processing
 */
export interface PriceProcessingOptions {
  getUsd?: (mint: string) => number | undefined;  // USD price lookup for calibration
  globalDecimals?: Record<string, number>;         // Global decimal map for rescaling
  skipMagnitudeCalibration?: boolean;              // Skip magnitude calibration (for testing)
  diagnostics?: boolean;                           // Enable diagnostic logging
}

/**
 * STEP 1: Canonicalize price orientation
 * 
 * Checks if mints need to be swapped according to quote hierarchy.
 * If swap is needed, inverts the price.
 * 
 * CRITICAL: This should happen BEFORE magnitude calibration
 */
function canonicalizeOrientation(input: RawPriceInput): {
  mintA: string;
  mintB: string;
  price: number;
  decimalsA: number;
  decimalsB: number;
  wasSwapped: boolean;
} {
  const orientation = canonicalOrientation(input.mintA, input.mintB);
  const needsSwap = orientation === 'swap';

  if (needsSwap) {
    // Swap mints and invert price
    const invertedPrice = input.rawPrice > 0 ? 1 / input.rawPrice : 0;
    
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
    price: input.rawPrice,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    wasSwapped: false,
  };
}

/**
 * STEP 2: Apply magnitude calibration and decimal rescaling
 * 
 * Uses USD reference prices to fix power-of-10 errors.
 * Rescales from pool decimals to global decimals if provided.
 */
function calibrateAndRescale(
  canonical: ReturnType<typeof canonicalizeOrientation>,
  options: PriceProcessingOptions
): number | undefined {
  const { getUsd, globalDecimals } = options;
  
  // Get global decimals (fallback to pool decimals)
  const globalDecA = globalDecimals?.[canonical.mintA] ?? canonical.decimalsA;
  const globalDecB = globalDecimals?.[canonical.mintB] ?? canonical.decimalsB;

  // Apply magnitude calibration and decimal rescaling
  const calibrated = computePriceForward(
    canonical.mintA,
    canonical.mintB,
    canonical.price,
    canonical.decimalsA,
    canonical.decimalsB,
    globalDecA,
    globalDecB,
    getUsd,
    undefined,
    false  // Not a reverse edge
  );

  return calibrated;
}

/**
 * STEP 3: Calculate reverse edge price
 * 
 * Properly inverts the forward price with correct decimal handling.
 */
function calculateReverse(
  canonical: ReturnType<typeof canonicalizeOrientation>,
  forwardPrice: number,
  options: PriceProcessingOptions
): number | undefined {
  const { getUsd, globalDecimals } = options;
  
  const globalDecA = globalDecimals?.[canonical.mintA] ?? canonical.decimalsA;
  const globalDecB = globalDecimals?.[canonical.mintB] ?? canonical.decimalsB;

  const reverse = computePriceReverse(
    canonical.mintA,
    canonical.mintB,
    forwardPrice,
    canonical.price,  // Raw canonical price before calibration
    canonical.decimalsA,
    canonical.decimalsB,
    globalDecA,
    globalDecB,
    getUsd
  );

  return reverse;
}

/**
 * CENTRALIZED PRICE PIPELINE
 * 
 * Processes a raw price through the complete pipeline:
 * 1. Canonicalize orientation (swap if needed)
 * 2. Apply magnitude calibration (fix power-of-10 errors)
 * 3. Rescale decimals (pool → global)
 * 4. Calculate reverse edge
 * 
 * @param input Raw price from DEX-specific calculation
 * @param options Processing options (USD lookup, global decimals)
 * @returns Processed price ready for graph edge creation
 */
export function processPriceThroughPipeline(
  input: RawPriceInput,
  options: PriceProcessingOptions = {}
): ProcessedPrice | undefined {
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
    
    // STEP 2: Calibrate and rescale forward price
    const forward = calibrateAndRescale(canonical, options);
    
    if (!forward || forward <= 0 || !Number.isFinite(forward)) {
      return undefined;
    }

    // STEP 3: Calculate reverse price
    const reverse = calculateReverse(canonical, forward, options);
    
    if (!reverse || reverse <= 0 || !Number.isFinite(reverse)) {
      // Fallback to simple inversion if reverse calculation fails
      const fallbackReverse = 1 / forward;
      return {
        mintA: canonical.mintA,
        mintB: canonical.mintB,
        priceForward: forward,
        priceReverse: fallbackReverse,
        wasSwapped: canonical.wasSwapped,
        decimalsA: canonical.decimalsA,
        decimalsB: canonical.decimalsB,
      };
    }

    // Diagnostic: Check if forward * reverse ≈ 1
    if (options.diagnostics) {
      const product = forward * reverse;
      if (Math.abs(product - 1) > 0.05) {
        try {
          logger.warn('price.pipeline.product_check', {
            dex: input.dex,
            pool_id: input.poolId?.slice(0, 12),
            mint_a: canonical.mintA.slice(0, 8),
            mint_b: canonical.mintB.slice(0, 8),
            forward,
            reverse,
            product,
            expected: 1,
            deviation_pct: ((product - 1) * 100).toFixed(2),
            was_swapped: canonical.wasSwapped,
            cat: 'price.pipeline'
          });
        } catch {}
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
    } catch {}
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

/**
 * Validate processed price against USD reference
 * Returns deviation multiplier (1.0 = perfect match)
 */
export function validatePriceAgainstUSD(
  processed: ProcessedPrice,
  getUsd: (mint: string) => number | undefined
): { valid: boolean; deviation: number; details?: string } {
  const usdA = getUsd(processed.mintA);
  const usdB = getUsd(processed.mintB);
  
  if (!usdA || !usdB || usdA <= 0 || usdB <= 0) {
    return { valid: true, deviation: 1, details: 'No USD reference available' };
  }

  const expectedRatio = usdB / usdA;
  const deviation = Math.max(
    processed.priceForward / expectedRatio,
    expectedRatio / processed.priceForward
  );

  const valid = deviation <= 100; // Allow up to 100x deviation (might be stale USD prices)

  return {
    valid,
    deviation,
    details: valid 
      ? undefined 
      : `Price deviates ${deviation.toFixed(2)}x from USD reference`
  };
}

