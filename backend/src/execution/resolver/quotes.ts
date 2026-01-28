import type { DirectHop } from '../types.js';
import { CONFIG } from '../../utils/config.js';
import { peekRaydiumPools, peekMeteoraPools } from '../../server/pools.js';
import { logCatchError } from '../../utils/errorHandler.js';

export async function quoteHopOut(hop: DirectHop, amountInRaw: bigint, traceId?: string): Promise<bigint> {
  // Get traceId from hop if not passed directly (set by resolver)
  const effectiveTraceId = traceId || (hop as any)._traceId;
  
  try {
    if (hop.dex === 'orca') {
      // LOCAL QUOTE ONLY - No SDK fallback for maximum speed
      // Pool cache fallback is built into quoteOrcaClmmLocal, so if this fails,
      // the opportunity is stale and should be skipped
      const localQuote = await quoteOrcaClmmLocal(hop, amountInRaw, effectiveTraceId);
      if (localQuote > 0n) return localQuote;
      
      // Log cache miss - this means pool data is not available anywhere
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.debug('orca.quote.cache_miss', {
          cat: 'tx',
          traceId: effectiveTraceId,
          ctx: {
            poolId: hop.poolId,
            inputMint: hop.inputMint?.slice(0, 8),
            outputMint: hop.outputMint?.slice(0, 8),
            reason: 'local_quote_returned_zero_no_sdk_fallback',
          }
        });
      } catch (e) { logCatchError('resolver.quotes', e); }
      
      // Return 0 - skip this opportunity rather than making slow SDK/RPC calls
      return 0n;
    } else if (hop.dex === 'raydium') {
      const sys: any = (CONFIG as any)?.system || {};
      const minimalMathAllowed = sys.quotes?.enableMinimalMath !== false;
      const ray = minimalMathAllowed ? peekRaydiumPools() : null;

      if (minimalMathAllowed && ray && hop.variant === 'clmm') {
        try {
          const { logger } = await import('../../utils/logger.js');
          const isRev = /[#-]rev$/.test(hop.poolId || '');
          const baseId = hop.poolId.replace(/[#-]rev$/, '');
          const pool = (ray.clmm || []).find((x: any) => String(x?.id || '') === baseId);
          
          // Log ALL fields from the found pool to see what we actually have
          const poolFields = pool ? Object.keys(pool).reduce((acc: any, key) => {
            const val = (pool as any)[key];
            if (val !== undefined && val !== null) {
              acc[key] = String(val);
            }
            return acc;
          }, {}) : null;
          
          logger.debug('raydium.clmm.quote.attempt', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              amountInRaw: amountInRaw.toString(),
              inputMint: hop.inputMint,
              outputMint: hop.outputMint,
              inputDecimals: hop.inputDecimals,
              outputDecimals: hop.outputDecimals,
              hasRayData: !!ray,
              clmmPoolCount: ray?.clmm?.length || 0,
              poolFound: !!pool,
              poolFields: poolFields, // Log ALL pool fields
            }
          });
        } catch (e) { logCatchError('resolver.quotes', e); }
        
        const clmmOut = quoteRaydiumClmmFromSnapshot(hop, amountInRaw, ray);
        
        try {
          const { logger } = await import('../../utils/logger.js');
          logger.debug('raydium.clmm.quote.result', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              amountInRaw: amountInRaw.toString(),
              quotedOut: clmmOut.toString(),
              success: clmmOut > 0n,
            }
          });
        } catch (e) { logCatchError('resolver.quotes', e); }
        
        if (clmmOut > 0n) return clmmOut;
      }

      if (minimalMathAllowed && ray) {
        const isRev = /[#-]rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/[#-]rev$/, '');
        const p = (ray.amm || []).find((x: any) => String(x?.id || '') === id);
        if (p) {
          const feeBps = Number((p as any)?.fee_bps || (hop as any)?.fee_bps || 0);
          const decIn = Number(
            hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0,
          );
          const decOut = Number(
            hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0,
          );
          const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            const reserveInWhole = Number(
              isRev
                ? (p as any)?.amount_b_whole ?? (p as any)?.reserveB ?? 0
                : (p as any)?.amount_a_whole ?? (p as any)?.reserveA ?? 0,
            );
            const reserveOutWhole = Number(
              isRev
                ? (p as any)?.amount_a_whole ?? (p as any)?.reserveA ?? 0
                : (p as any)?.amount_b_whole ?? (p as any)?.reserveB ?? 0,
            );
            const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
            if (reserveInWhole > 0 && reserveOutWhole > 0 && Number.isFinite(amtIn)) {
              const amtInAfterFee = amtIn * fee;
              const outWhole = (amtInAfterFee * reserveOutWhole) / (reserveInWhole + amtInAfterFee);
              const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
              if (outRaw > 0n) return outRaw;
            }
            const px = Number((p as any)?.price_a_per_b || 0);
            if (px > 0 && Number.isFinite(amtIn)) {
              // FIX: Rate was inverted. price_a_per_b = B per A (how many B for 1 A)
              // A→B (isRev=false): out = in × price (multiply by price)
              // B→A (isRev=true): out = in / price (divide by price)
              const rate = isRev ? (1 / px) : px;
              if (rate > 0) {
                const outWhole = amtIn * rate * fee;
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                if (outRaw > 0n) return outRaw;
              }
            }
          }
        }
      }
      
      // CPMM variant - constant product formula
      if (minimalMathAllowed && hop.variant === 'cpmm') {
        try {
          const { peekCpmmPools } = await import('../../server/pools.cache.js');
          const cpmmPools = peekCpmmPools();
          const isRev = /[#-]rev$/.test(hop.poolId || '');
          const id = hop.poolId.replace(/[#-]rev$/, '');
          const p = (cpmmPools.cpmm || []).find((x: any) => String(x?.id || '') === id);
          
          if (p) {
            const feeBps = Number((p as any)?.fee_bps || 25);
            const decIn = Number(
              hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0,
            );
            const decOut = Number(
              hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0,
            );
            const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
            
            if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
              const reserveInWhole = Number(
                isRev
                  ? (p as any)?.amount_b_whole ?? 0
                  : (p as any)?.amount_a_whole ?? 0,
              );
              const reserveOutWhole = Number(
                isRev
                  ? (p as any)?.amount_a_whole ?? 0
                  : (p as any)?.amount_b_whole ?? 0,
              );
              const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
              
              if (reserveInWhole > 0 && reserveOutWhole > 0 && Number.isFinite(amtIn)) {
                // Constant product formula: out = (in * fee * reserveOut) / (reserveIn + in * fee)
                const amtInAfterFee = amtIn * fee;
                const outWhole = (amtInAfterFee * reserveOutWhole) / (reserveInWhole + amtInAfterFee);
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                if (outRaw > 0n) return outRaw;
              }
              
              // Fallback to price-based calculation
              const px = Number((p as any)?.price_a_per_b || 0);
              if (px > 0 && Number.isFinite(amtIn)) {
                // FIX: Rate was inverted. price_a_per_b = B per A (how many B for 1 A)
                // A→B (isRev=false): out = in × price (multiply by price)
                // B→A (isRev=true): out = in / price (divide by price)
                const rate = isRev ? (1 / px) : px;
                if (rate > 0) {
                  const outWhole = amtIn * rate * fee;
                  const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                  if (outRaw > 0n) return outRaw;
                }
              }
            }
          }
        } catch (e) { logCatchError('resolver.quotes', e); }
      }
      return 0n;
    } else if (hop.dex === 'pumpswap') {
      // PumpSwap constant product AMM quoting
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const isRev = /[#-]rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/[#-]rev$/, '');
        
        // Import PumpSwap pools
        const { peekPumpswapPools } = await import('../../server/pools.js');
        const pumpswapPools = peekPumpswapPools();
        const p = (pumpswapPools.amm || []).find((x: any) => String(x?.id || '') === id);
        
        if (p) {
          // PumpSwap uses 25 bps total fee (20 bps LP + 5 bps protocol)
          const feeBps = Number((p as any)?.fee_bps || 25);
          const decIn = Number(
            hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0,
          );
          const decOut = Number(
            hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0,
          );
          const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
          
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            const reserveInWhole = Number(
              isRev
                ? (p as any)?.amount_b_whole ?? 0
                : (p as any)?.amount_a_whole ?? 0,
            );
            const reserveOutWhole = Number(
              isRev
                ? (p as any)?.amount_a_whole ?? 0
                : (p as any)?.amount_b_whole ?? 0,
            );
            const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
            
            if (reserveInWhole > 0 && reserveOutWhole > 0 && Number.isFinite(amtIn)) {
              // Constant product formula: out = (in * fee * reserveOut) / (reserveIn + in * fee)
              const amtInAfterFee = amtIn * fee;
              const outWhole = (amtInAfterFee * reserveOutWhole) / (reserveInWhole + amtInAfterFee);
              const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
              if (outRaw > 0n) return outRaw;
            }
          }
        }
      }
      return 0n;
    } else if (hop.dex === 'meteora_balanced') {
      // Meteora Balanced (DAMM) constant product AMM quoting
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const isRev = /[#-]rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/[#-]rev$/, '');
        
        // Import Meteora Balanced pools
        const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
        const dammPools = peekMeteoraBalancedPools();
        const p = (dammPools.amm || []).find((x: any) => String(x?.id || '') === id);
        
        if (p) {
          // Get fee from pool (typically 10-30 bps for DAMM)
          const feeBps = Number((p as any)?.fee_bps || 10);
          const decIn = Number(
            hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0,
          );
          const decOut = Number(
            hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0,
          );
          const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
          
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            const reserveInWhole = Number(
              isRev
                ? (p as any)?.amount_b_whole ?? 0
                : (p as any)?.amount_a_whole ?? 0,
            );
            const reserveOutWhole = Number(
              isRev
                ? (p as any)?.amount_a_whole ?? 0
                : (p as any)?.amount_b_whole ?? 0,
            );
            const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
            
            if (reserveInWhole > 0 && reserveOutWhole > 0 && Number.isFinite(amtIn)) {
              // Constant product formula: out = (in * fee * reserveOut) / (reserveIn + in * fee)
              const amtInAfterFee = amtIn * fee;
              const outWhole = (amtInAfterFee * reserveOutWhole) / (reserveInWhole + amtInAfterFee);
              const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
              if (outRaw > 0n) return outRaw;
            }
          }
        }
      }
      return 0n;
    } else if (hop.dex === 'meteora') {
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const isRev = /[#-]rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/[#-]rev$/, '');
        const met = peekMeteoraPools();
        const p = (met.clmm || []).find((x: any) => String(x?.id || '') === id);
        
        try {
          const { logger } = await import('../../utils/logger.js');
          
          // Log ALL fields from the found pool to see what we actually have
          const poolFields = p ? Object.keys(p).reduce((acc: any, key) => {
            const val = (p as any)[key];
            if (val !== undefined && val !== null) {
              acc[key] = String(val);
            }
            return acc;
          }, {}) : null;
          
          logger.debug('meteora.dlmm.quote.attempt', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              strippedId: id,
              amountInRaw: amountInRaw.toString(),
              inputMint: hop.inputMint,
              outputMint: hop.outputMint,
              inputDecimals: hop.inputDecimals,
              outputDecimals: hop.outputDecimals,
              isRev,
              hasMetData: !!met,
              clmmPoolCount: met?.clmm?.length || 0,
              poolFound: !!p,
              poolFields: poolFields, // Log ALL pool fields
            }
          });
        } catch (e) { logCatchError('resolver.quotes', e); }
        
        if (p) {
          // Use CANONICAL ordering for quote calculation (price_a_per_b is in canonical terms)
          const poolMintA = String((p as any)?.mint_a || '');
          const poolMintB = String((p as any)?.mint_b || '');
          
          // Also get NATIVE ordering for clearer logging
          const nativeMintA = String((p as any)?.native_mint_a || poolMintA);
          const nativeMintB = String((p as any)?.native_mint_b || poolMintB);
          
          // Determine swap direction in CANONICAL terms (for calculation)
          // This must match the price_a_per_b which is also in canonical terms
          const swappingAtoB = hop.inputMint === poolMintA && hop.outputMint === poolMintB;
          const swappingBtoA = hop.inputMint === poolMintB && hop.outputMint === poolMintA;
          
          // Also compute NATIVE direction for logging clarity
          const nativeXtoY = hop.inputMint === nativeMintA && hop.outputMint === nativeMintB;
          const nativeYtoX = hop.inputMint === nativeMintB && hop.outputMint === nativeMintA;
          
          // Validate that hop mints match pool mints
          if (!swappingAtoB && !swappingBtoA) {
            try {
              const { logger } = await import('../../utils/logger.js');
              logger.warn('meteora.dlmm.quote.mint_mismatch', {
                cat: 'tx',
                ctx: {
                  poolId: hop.poolId,
                  hopInputMint: hop.inputMint,
                  hopOutputMint: hop.outputMint,
                  poolMintA,
                  poolMintB,
                  isRevFromSuffix: /[#-]rev$/.test(hop.poolId || ''),
                }
              });
            } catch (e) { logCatchError('resolver.quotes', e); }
            return 0n; // Return 0 if mints don't match
          }
          
          // Use actual swap direction determined from mint matching
          // The pool ID suffix (#rev) is just a hint, but mint matching is authoritative
          const actualIsRev = swappingBtoA;
          
          const feeBps = Number((p as any)?.fee_bps || 0);
          const decIn = Number(hop.inputDecimals ?? (actualIsRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0);
          const decOut = Number(hop.outputDecimals ?? (actualIsRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0);
          const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
          let px = Number((p as any)?.price_a_per_b || 0);
          
          // FALLBACK: Calculate price from reserves if missing
          if (!(px > 0)) {
            const amtA = Number((p as any)?.amount_a || 0);
            const amtB = Number((p as any)?.amount_b || 0);
            
            // Get pool's actual decimals (NOT from hop, as hop may be reversed)
            const poolDecA = Number((p as any)?.decimals_a ?? 9);
            const poolDecB = Number((p as any)?.decimals_b ?? 6);
            
            if (amtA > 0 && amtB > 0 && Number.isFinite(poolDecA) && Number.isFinite(poolDecB)) {
              const wholeA = amtA / Math.pow(10, poolDecA);
              const wholeB = amtB / Math.pow(10, poolDecB);
              if (wholeB > 0) {
                // price_a_per_b = how many B per 1 A (always from pool's perspective)
                px = wholeB / wholeA;
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.debug('meteora.dlmm.quote.price_from_reserves', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      amtA,
                      amtB,
                      poolDecA,
                      poolDecB,
                      wholeA,
                      wholeB,
                      calculatedPrice: px,
                      actualIsRev,
                    }
                  });
                } catch (e) { logCatchError('resolver.quotes', e); }
              }
            }
          }
          
          try {
            const { logger } = await import('../../utils/logger.js');
            logger.debug('meteora.dlmm.quote.pool_data', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                feeBps,
                decIn,
                decOut,
                fee,
                priceAPerB: px,
                decimalsFinite: Number.isFinite(decIn) && Number.isFinite(decOut),
                pricePositive: px > 0,
                poolData: {
                  mint_a: (p as any)?.mint_a,
                  mint_b: (p as any)?.mint_b,
                  decimals_a: (p as any)?.decimals_a,
                  decimals_b: (p as any)?.decimals_b,
                  fee_bps: (p as any)?.fee_bps,
                  price_a_per_b: (p as any)?.price_a_per_b,
                }
              }
            });
          } catch (e) { logCatchError('resolver.quotes', e); }
          
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            if (px > 0) {
              const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
              if (Number.isFinite(amtIn)) {
                // Use actual swap direction for price calculation
                // price_a_per_b = how many B tokens per 1 A token
                // A→B (NOT actualIsRev): output B = input A * price_a_per_b → MULTIPLY
                // B→A (actualIsRev): output A = input B / price_a_per_b → DIVIDE
                const outWhole = (actualIsRev ? amtIn / px : amtIn * px) * fee;
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.debug('meteora.dlmm.quote.calculation', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      amountInRaw: amountInRaw.toString(),
                      amtIn,
                      outWhole,
                      outRaw: outRaw.toString(),
                      success: outRaw > 0n,
                      formula: actualIsRev ? '(amtIn / px) * fee' : 'amtIn * px * fee',
                      // Canonical direction (matches price_a_per_b ordering)
                      swappingAtoB,
                      swappingBtoA,
                      // Native direction (matches on-chain X/Y ordering)
                      nativeXtoY,
                      nativeYtoX,
                      actualIsRev,
                      isRevFromSuffix: /[#-]rev$/.test(hop.poolId || ''),
                    }
                  });
                } catch (e) { logCatchError('resolver.quotes', e); }
                
                if (outRaw > 0n) return outRaw;
              } else {
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.warn('meteora.dlmm.quote.invalid_amtIn', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      amountInRaw: amountInRaw.toString(),
                      decIn,
                      amtIn,
                      isFinite: Number.isFinite(amtIn),
                    }
                  });
                } catch (e) { logCatchError('resolver.quotes', e); }
              }
            } else {
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.warn('meteora.dlmm.quote.no_price', {
                  cat: 'tx',
                  ctx: {
                    poolId: hop.poolId,
                    priceAPerB: px,
                    poolHasPrice: (p as any)?.price_a_per_b !== undefined,
                  }
                });
              } catch (e) { logCatchError('resolver.quotes', e); }
            }
          } else {
            try {
              const { logger } = await import('../../utils/logger.js');
              logger.warn('meteora.dlmm.quote.invalid_decimals', {
                cat: 'tx',
                ctx: {
                  poolId: hop.poolId,
                  decIn,
                  decOut,
                  decInFinite: Number.isFinite(decIn),
                  decOutFinite: Number.isFinite(decOut),
                }
              });
            } catch (e) { logCatchError('resolver.quotes', e); }
          }
        } else {
          try {
            const { logger } = await import('../../utils/logger.js');
            logger.warn('meteora.dlmm.quote.pool_not_found', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                strippedId: id,
                availablePoolIds: (met?.clmm || []).slice(0, 5).map((x: any) => x?.id),
              }
            });
          } catch (e) { logCatchError('resolver.quotes', e); }
        }
      }
      return 0n;
    }
  } catch (e) {
    // Log the error instead of swallowing it
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.error('tx.resolve.quote.error', {
        cat: 'tx',
        traceId: effectiveTraceId,
        ctx: {
          dex: hop.dex,
          poolId: hop.poolId,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          amountInRaw: amountInRaw.toString(),
          error: String((e as any)?.message || e),
          stack: (e as any)?.stack,
          traceId: effectiveTraceId,
        }
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }
  return 0n;
}

export function applyMinOut(outRaw: bigint, slippageBps: number): bigint {
  const one = 10_000n;
  const bps = BigInt(Math.max(0, Math.min(9900, Math.round(slippageBps))));
  return (outRaw * (one - bps)) / one;
}

/**
 * Quote Orca Whirlpool CLMM swap using cached pool state (no RPC calls)
 * Uses CLMM price formula with mint-based direction detection
 */
async function quoteOrcaClmmLocal(hop: DirectHop, amountInRaw: bigint, traceId?: string): Promise<bigint> {
  if (!(amountInRaw > 0n)) return 0n;
  
  try {
    const { executionCache } = await import('../cache.js');
    const poolId = hop.poolId?.replace(/[#-]rev$/, '') || '';
    if (!poolId) return 0n;
    
    // Get cached state - both hot (prices) and static (mints)
    let cached = executionCache.getHot(poolId);
    let staticData = executionCache.getStatic(poolId);
    
    // FALLBACK: If execution cache misses, try pool cache (always available, not TTL-limited)
    if (!cached?.sqrtPriceX64 || !staticData?.mint_a) {
      try {
        const { peekOrcaPools } = await import('../../server/pools.cache.js');
        const pools = peekOrcaPools();
        const pool = pools.clmm.find((p: any) => p.id === poolId || p.id === hop.poolId);
        
        if (pool) {
          const wasSwapped = (pool as any).was_swapped === true;
          const tickCanonRaw = (pool as any).tick_current_index ?? (pool as any).tickCurrentIndex;
          const tickCanon = Number(tickCanonRaw);
          const tickNative = Number.isFinite(tickCanon) ? (wasSwapped ? -tickCanon : tickCanon) : undefined;

          // Derive sqrtPriceX64 from pool cache
          const sqrtRaw = (pool as any).sqrt_price_x64_raw ?? (pool as any).sqrt_price_x64;
          if (!cached?.sqrtPriceX64 && sqrtRaw != null) {
            const sqrtFromPool = BigInt(sqrtRaw);
            const feeFromPool = (pool as any).fee_bps || 30;
            cached = {
              sqrtPriceX64: sqrtFromPool,
              feeRate: feeFromPool,
              currentTickIndex: tickNative,
              // Include tickSpacing for boundary crossing detection in cache
              tickSpacing: (pool as any).tick_spacing,
              liquidity: (pool as any).liquidity_raw ? BigInt((pool as any).liquidity_raw) : undefined,
            };
            
            // Also populate execution cache for future use
            executionCache.setHot(poolId, cached);
          }
          
          // Get static data from pool cache
          if (!staticData?.mint_a) {
            // Get vault addresses from pool (token_vault_a/b or account_a/b)
            const vaultA = (pool as any).token_vault_a || (pool as any).account_a;
            const vaultB = (pool as any).token_vault_b || (pool as any).account_b;
            
            staticData = {
              mint_a: (pool as any).mint_a,
              mint_b: (pool as any).mint_b,
              decimals_a: (pool as any).decimals_a,
              decimals_b: (pool as any).decimals_b,
              native_mint_a: (pool as any).native_mint_a,
              native_mint_b: (pool as any).native_mint_b,
              tick_spacing: (pool as any).tick_spacing,
            };
            
            // Also populate execution cache for future use
            executionCache.setStatic(poolId, {
              ...staticData,
              programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
              dex: 'orca',
              pool_kind: 'clmm',
              // Include vaults for builder
              ...(vaultA && vaultB ? { vaults: { a: vaultA, b: vaultB } } : {}),
            });
          }
          
          try {
            const { logger } = await import('../../utils/logger.js');
            logger.debug('orca.quote.local.fallback_from_pool_cache', {
              cat: 'tx',
              ctx: {
                pool: poolId,
                sqrtPriceX64: cached?.sqrtPriceX64?.toString(),
                mintA: staticData?.mint_a?.slice(0, 8),
                mintB: staticData?.mint_b?.slice(0, 8),
              }
            });
          } catch (e) { logCatchError('resolver.quotes', e); }
        }
      } catch (fallbackErr) {
        // Fallback failed, continue with original cache check
        try {
          const { logger } = await import('../../utils/logger.js');
          logger.debug('orca.quote.local.fallback_failed', {
            cat: 'tx',
            ctx: { pool: poolId, error: String((fallbackErr as any)?.message || fallbackErr) }
          });
        } catch (e) { logCatchError('resolver.quotes', e); }
      }
    }
    
    if (!cached?.sqrtPriceX64) {
      // Cache miss even after fallback - SDK fallback will be used
      return 0n;
    }
    
    const sqrtPriceX64 = cached.sqrtPriceX64;
    const feeBps = cached.feeRate || 30; // Default 30 bps
    
    // CRITICAL FIX: sqrtPriceX64 is in NATIVE on-chain orientation (token0 → token1)
    // We MUST use native mints for direction detection, not canonical mints!
    // When was_swapped=true, canonical mint_a/mint_b are flipped from native, 
    // which would give wrong direction for native sqrtPriceX64.
    
    // Use native mints if available, otherwise fall back to canonical
    const nativeMintA = (staticData as any)?.native_mint_a || staticData?.mint_a || '';
    const nativeMintB = (staticData as any)?.native_mint_b || staticData?.mint_b || '';
    
    // Direction in NATIVE terms (matches sqrtPriceX64 orientation)
    const nativeAtoB = hop.inputMint === nativeMintA && hop.outputMint === nativeMintB;
    const nativeBtoA = hop.inputMint === nativeMintB && hop.outputMint === nativeMintA;
    
    if (!nativeAtoB && !nativeBtoA) {
      // Mint mismatch - cannot determine direction
      return 0n;
    }
    
    // FIX: ALWAYS prefer pool cache decimals when available
    // Pool cache decimals come from on-chain data and are authoritative
    // hop.inputDecimals/outputDecimals can be wrong (e.g., defaulting to 9 for all tokens)
    // Use native decimals to match native direction
    
    // Get pool cache decimals based on NATIVE direction
    const poolDecIn = nativeAtoB 
      ? ((staticData as any)?.native_decimals_a ?? staticData?.decimals_a)
      : ((staticData as any)?.native_decimals_b ?? staticData?.decimals_b);
    const poolDecOut = nativeAtoB
      ? ((staticData as any)?.native_decimals_b ?? staticData?.decimals_b)
      : ((staticData as any)?.native_decimals_a ?? staticData?.decimals_a);
    
    // Prefer pool cache decimals, fall back to hop decimals only if pool cache unavailable
    const decIn = Number.isFinite(poolDecIn) ? poolDecIn : (hop.inputDecimals ?? 9);
    const decOut = Number.isFinite(poolDecOut) ? poolDecOut : (hop.outputDecimals ?? 9);
    
    if (!Number.isFinite(decIn) || !Number.isFinite(decOut)) return 0n;
    
    // Apply fee
    const amountInAfterFee = (amountInRaw * BigInt(10000 - feeBps)) / 10000n;
    
    // CLMM price formula: price = (sqrtPriceX64 / 2^64)^2
    // sqrtPriceX64 is in NATIVE orientation, so we use nativeAtoB for direction
    // For native A->B: outB = inA * price
    // For native B->A: outA = inB / price
    const Q64 = 1n << 64n;
    const sqrtPrice = sqrtPriceX64;
    
    let outRaw: bigint;
    if (nativeAtoB) {
      // Native A -> B: multiply by price
      // out = in * (sqrtPrice^2 / Q64^2) * 10^(decOut-decIn)
      const decimalShift = decOut - decIn;
      if (decimalShift >= 0) {
        outRaw = (amountInAfterFee * sqrtPrice * sqrtPrice * BigInt(10 ** decimalShift)) / (Q64 * Q64);
      } else {
        outRaw = (amountInAfterFee * sqrtPrice * sqrtPrice) / (Q64 * Q64 * BigInt(10 ** (-decimalShift)));
      }
    } else {
      // Native B -> A: divide by price
      // out = in * (Q64^2 / sqrtPrice^2) * 10^(decOut-decIn)
      if (sqrtPrice === 0n) return 0n;
      const decimalShift = decOut - decIn;
      if (decimalShift >= 0) {
        outRaw = (amountInAfterFee * Q64 * Q64 * BigInt(10 ** decimalShift)) / (sqrtPrice * sqrtPrice);
      } else {
        outRaw = (amountInAfterFee * Q64 * Q64) / (sqrtPrice * sqrtPrice * BigInt(10 ** (-decimalShift)));
      }
    }
    
    if (outRaw > 0n) {
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.debug('orca.quote.local.success', {
          cat: 'tx',
          ctx: {
            pool: poolId,
            amountIn: amountInRaw.toString(),
            amountOut: outRaw.toString(),
            feeBps,
            direction: nativeAtoB ? 'NativeAtoB' : 'NativeBtoA',
            sqrtPriceX64: sqrtPriceX64.toString()
          }
        });
      } catch (e) { logCatchError('resolver.quotes', e); }
      
      // Derive and cache tick arrays for builder (like Raydium does)
      // This ensures tick arrays are available even for pools not in initial GraphQL fetch
      (async () => {
        try {
          const existing = executionCache.getHot(poolId);
          
          // Only derive if not already cached
          if (!existing?.tickArrays?.lower || !existing?.tickArrays?.center || !existing?.tickArrays?.upper) {
            const tickIndex = cached?.currentTickIndex;
            // Get tick_spacing from static data or pool cache
            let tickSpacing = (staticData as any)?.tick_spacing;
            if (!Number.isFinite(tickSpacing)) {
              try {
                const { peekOrcaPools } = await import('../../server/pools.cache.js');
                const pools = peekOrcaPools();
                const pool = pools.clmm.find((p: any) => p.id === poolId);
                tickSpacing = (pool as any)?.tick_spacing;
              } catch { /* ignore */ }
            }
            
            if (Number.isFinite(tickIndex) && Number.isFinite(tickSpacing) && tickSpacing > 0) {
              const PDAUtil = (await import('@orca-so/whirlpools-sdk').catch(() => null))?.PDAUtil;
              const TickUtil = (await import('@orca-so/whirlpools-sdk/dist/utils/public/tick-utils.js').catch(() => null))?.TickUtil;
              const { PublicKey } = await import('@solana/web3.js');
              
              if (PDAUtil && TickUtil && typeof TickUtil.getStartTickIndex === 'function') {
                const orcaProgramId = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
                const poolPk = new PublicKey(poolId);
                
                const tickArrays: { lower?: string; center?: string; upper?: string } = {};
                for (let offset = -1; offset <= 1; offset++) {
                  try {
                    const startTick = TickUtil.getStartTickIndex(tickIndex, tickSpacing, offset);
                    const tickArrayPda = PDAUtil.getTickArray(orcaProgramId, poolPk, startTick);
                    if (tickArrayPda?.publicKey) {
                      const address = tickArrayPda.publicKey.toBase58();
                      if (offset === -1) tickArrays.lower = address;
                      else if (offset === 0) tickArrays.center = address;
                      else if (offset === 1) tickArrays.upper = address;
                    }
                  } catch { /* ignore individual offset failures */ }
                }
                
                if (tickArrays.lower && tickArrays.center && tickArrays.upper) {
                  // Include tickSpacing for boundary crossing detection
                  executionCache.setHot(poolId, {
                    ...existing,
                    tickSpacing,
                    tickArrays,
                  });
                  
                  try {
                    const { logger } = await import('../../utils/logger.js');
                    logger.debug('orca.quote.local.tickarrays.cached', {
                      cat: 'tx',
                      ctx: {
                        pool: poolId,
                        lower: tickArrays.lower?.slice(0, 8) + '…',
                        center: tickArrays.center?.slice(0, 8) + '…',
                        upper: tickArrays.upper?.slice(0, 8) + '…',
                      }
                    });
                  } catch { /* ignore logging errors */ }
                }
              }
            }
          }
        } catch { /* Silently fail - don't block quote */ }
      })();
      
      return outRaw;
    }
    
    return 0n;
  } catch (err) {
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.warn('orca.quote.local.error', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          error: String((err as any)?.message || err),
          msg: 'Falling back to SDK quote'
        }
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }
}

function quoteRaydiumClmmFromSnapshot(hop: DirectHop, amountInRaw: bigint, pools: any): bigint {
  if (!(amountInRaw > 0n)) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.zero_input', {
          cat: 'tx',
          ctx: { poolId: hop.poolId, amountInRaw: amountInRaw.toString() }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }
  
  if (!pools || !Array.isArray(pools.clmm)) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.no_pools_data', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            hasPools: !!pools,
            hasClmm: pools && Array.isArray(pools.clmm),
            clmmLength: pools?.clmm?.length || 0,
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }

  const rawPoolId = String(hop.poolId || '');
  if (!rawPoolId) return 0n;
  const isRevFromSuffix = /[#-]rev$/.test(rawPoolId);
  const baseId = rawPoolId.replace(/[#-]rev$/, '');
  const pool = (pools.clmm || []).find((x: any) => String(x?.id || '') === baseId);
  
  if (!pool) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.pool_not_found', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            baseId,
            isRevFromSuffix,
            availablePoolIds: (pools.clmm || []).slice(0, 5).map((x: any) => x?.id),
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }

  // CRITICAL: Determine swap direction from ACTUAL MINTS, not pool ID suffix
  // The pool ID suffix is just a hint; the hop's inputMint/outputMint are authoritative
  const poolMintA = String((pool as any)?.mint_a || '');
  const poolMintB = String((pool as any)?.mint_b || '');
  
  // Determine swap direction in canonical terms (A/B as stored in pool)
  const swappingAtoB = hop.inputMint === poolMintA && hop.outputMint === poolMintB;
  const swappingBtoA = hop.inputMint === poolMintB && hop.outputMint === poolMintA;
  
  // Validate that hop mints match pool mints
  if (!swappingAtoB && !swappingBtoA) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.mint_mismatch', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            hopInputMint: hop.inputMint,
            hopOutputMint: hop.outputMint,
            poolMintA,
            poolMintB,
            isRevFromSuffix,
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n; // Return 0 if mints don't match
  }
  
  // Use actual swap direction determined from mint matching
  // swappingBtoA means we're going from B to A, which is the "reverse" direction
  const isRev = swappingBtoA;

  let ratio = extractClmmPriceRatio(pool, isRev);
  
  // FALLBACK: Calculate price ratio from amount_a_whole and amount_b_whole if missing
  if (!ratio) {
    const wholeA = Number((pool as any)?.amount_a_whole || 0);
    const wholeB = Number((pool as any)?.amount_b_whole || 0);
    
    if (wholeA > 0 && wholeB > 0 && Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
      // price_a_per_b = wholeA / wholeB (how many B per 1 A)
      const price = wholeB / wholeA;
      if (price > 0 && Number.isFinite(price)) {
        // Convert to ratio with high precision
        const scale = 1_000_000_000_000; // 1 trillion for precision
        const numerator = BigInt(Math.round(price * scale));
        const denominator = BigInt(scale);
        
        if (isRev) {
          ratio = { numerator: denominator, denominator: numerator };
        } else {
          ratio = { numerator, denominator };
        }
        
        try {
          import('../../utils/logger.js').then(({ logger }) => {
            logger.debug('raydium.clmm.quote.price_from_reserves', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                wholeA,
                wholeB,
                calculatedPrice: price,
                numerator: numerator.toString(),
                denominator: denominator.toString(),
                isRev,
              }
            });
          });
        } catch (e) { logCatchError('resolver.quotes', e); }
      }
    }
  }
  
  if (!ratio) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.no_price_ratio', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            poolData: {
              price_a_per_b: (pool as any)?.price_a_per_b,
              price_a_per_b_num: (pool as any)?.price_a_per_b_num,
              price_a_per_b_den: (pool as any)?.price_a_per_b_den,
              amount_a_whole: (pool as any)?.amount_a_whole,
              amount_b_whole: (pool as any)?.amount_b_whole,
            }
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }
  const { numerator: priceNumerator, denominator: priceDenominator } = ratio;

  // For decimals: if swapping A->B, input is A decimals, output is B decimals
  // If swapping B->A (isRev), input is B decimals, output is A decimals
  const decInCandidate =
    typeof hop.inputDecimals === 'number' && Number.isFinite(hop.inputDecimals)
      ? hop.inputDecimals
      : (isRev
          ? Number((pool as any)?.decimals_b ?? (pool as any)?.decimalsB)
          : Number((pool as any)?.decimals_a ?? (pool as any)?.decimalsA));
  const decOutCandidate =
    typeof hop.outputDecimals === 'number' && Number.isFinite(hop.outputDecimals)
      ? hop.outputDecimals
      : (isRev
          ? Number((pool as any)?.decimals_a ?? (pool as any)?.decimalsA)
          : Number((pool as any)?.decimals_b ?? (pool as any)?.decimalsB));
          
  try {
    import('../../utils/logger.js').then(({ logger }) => {
      logger.debug('raydium.clmm.quote.direction', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          hopInputMint: hop.inputMint?.slice(0, 8) + '…',
          hopOutputMint: hop.outputMint?.slice(0, 8) + '…',
          poolMintA: poolMintA.slice(0, 8) + '…',
          poolMintB: poolMintB.slice(0, 8) + '…',
          swappingAtoB,
          swappingBtoA,
          isRev,
          isRevFromSuffix,
          decInCandidate,
          decOutCandidate,
        }
      });
    });
  } catch (e) { logCatchError('resolver.quotes', e); }

  const scaleIn = decimalScale(decInCandidate);
  const scaleOut = decimalScale(decOutCandidate);
  
  if (!scaleIn || !scaleOut) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.invalid_decimal_scale', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            decInCandidate,
            decOutCandidate,
            scaleIn: scaleIn?.toString() || 'null',
            scaleOut: scaleOut?.toString() || 'null',
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }

  const feeBpsBig = BigInt(clampFeeBps((pool as any)?.fee_bps ?? (hop as any)?.fee_bps));
  const feeNumerator = 10_000n - feeBpsBig;
  const feeDenominator = 10_000n;

  // FIX: Price ratio was inverted. For A→B swap, we multiply by price (priceNumerator/priceDenominator)
  // Formula: out = in × (priceNum/priceDenom) × (scaleOut/scaleIn) × fee
  const numerator = amountInRaw * priceNumerator * scaleOut * feeNumerator;
  const denominator = scaleIn * priceDenominator * feeDenominator;
  
  if (!(denominator > 0n)) {
    try {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.warn('raydium.clmm.quote.zero_denominator', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            scaleIn: scaleIn.toString(),
            priceNumerator: priceNumerator.toString(),
            feeDenominator: feeDenominator.toString(),
            denominator: denominator.toString(),
          }
        });
      });
    } catch (e) { logCatchError('resolver.quotes', e); }
    return 0n;
  }

  const out = numerator / denominator;
  
  // Derive and cache tick arrays if quote succeeded and we have pool data
  // This ensures tick arrays are available in execution cache for the builder
  if (out > 0n) {
    // Derive tick arrays asynchronously (don't block quote return)
    (async () => {
      try {
        const tickCurrent = Number((pool as any)?.tick_current ?? (pool as any)?.tickCurrent);
        const tickSpacing = Number((pool as any)?.tick_spacing ?? (pool as any)?.tickSpacing);
        const programId = hop.programId || String((CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
        
        if (Number.isFinite(tickCurrent) && Number.isFinite(tickSpacing) && tickSpacing > 0) {
          const { executionCache } = await import('../cache.js');
          const { getTickArrayStartIndexByTick, deriveTickArrayPda } = await import('../../execution/raydiumTickArrays.js');
          const { PublicKey } = await import('@solana/web3.js');
          
          const poolIdStripped = baseId;
          const existing = executionCache.getHot(poolIdStripped);
          
          // Only derive if not already cached
          if (!existing?.tickArrays?.lower || !existing?.tickArrays?.upper) {
            try {
              const programPk = new PublicKey(programId);
              const poolPk = new PublicKey(poolIdStripped);
              const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
              const delta = 60 * Math.max(1, tickSpacing);
              
              const [lowerPk, centerPk, upperPk] = await Promise.all([
                deriveTickArrayPda(programPk, poolPk, centerStart - delta),
                deriveTickArrayPda(programPk, poolPk, centerStart),
                deriveTickArrayPda(programPk, poolPk, centerStart + delta),
              ]);
              
              // Note: lower and upper are arrays per type definition, center is a string
              const tickArrays: { lower?: string[]; center?: string; upper?: string[] } = {};
              if (lowerPk) tickArrays.lower = [lowerPk.toBase58()];
              if (centerPk) tickArrays.center = centerPk.toBase58();
              if (upperPk) tickArrays.upper = [upperPk.toBase58()];
              
              if (tickArrays.lower || tickArrays.center || tickArrays.upper) {
                // Include tickSpacing for boundary crossing detection
                executionCache.setHot(poolIdStripped, {
                  ...existing,
                  tickSpacing,
                  tickArrays: {
                    ...existing?.tickArrays,
                    ...tickArrays
                  }
                });
                
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.debug('raydium.clmm.quote.tickarrays.cached', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      lower: tickArrays.lower?.[0]?.slice(0, 8) + '…' || 'none',
                      center: tickArrays.center?.slice(0, 8) + '…' || 'none',
                      upper: tickArrays.upper?.[0]?.slice(0, 8) + '…' || 'none',
                    }
                  });
                } catch (e) { logCatchError('resolver.quotes', e); }
              }
            } catch (err) {
              // Log but don't fail if derivation fails
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.debug('raydium.clmm.quote.tickarrays.derive.failed', {
                  cat: 'tx',
                  ctx: {
                    poolId: hop.poolId,
                    error: String((err as any)?.message || err)
                  }
                });
              } catch (e) { logCatchError('resolver.quotes', e); }
            }
          }
        }
      } catch (err) {
        // Silently fail - don't block quote
      }
    })();
  }
  
  try {
    import('../../utils/logger.js').then(({ logger }) => {
      logger.debug('raydium.clmm.quote.calculated', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          amountInRaw: amountInRaw.toString(),
          out: out.toString(),
          success: out > 0n,
          direction: isRev ? 'B→A (reverse)' : 'A→B (forward)',
          isRevFromSuffix,
          calculation: {
            priceNumerator: priceNumerator.toString(),
            priceDenominator: priceDenominator.toString(),
            scaleIn: scaleIn.toString(),
            scaleOut: scaleOut.toString(),
            feeBpsBig: feeBpsBig.toString(),
            decInCandidate,
            decOutCandidate,
          }
        }
      });
    });
  } catch (e) { logCatchError('resolver.quotes', e); }
  
  return out > 0n ? out : 0n;
}

function extractClmmPriceRatio(pool: any, isRev: boolean): { numerator: bigint; denominator: bigint } | null {
  let numerator = parsePositiveBigInt((pool as any)?.price_a_per_b_num);
  let denominator = parsePositiveBigInt((pool as any)?.price_a_per_b_den);

  if (!numerator || !denominator) {
    const price = Number((pool as any)?.price_a_per_b ?? 0);
    if (Number.isFinite(price) && price > 0) {
      const candidateScales = [1_000_000_000_000, 1_000_000_000, 1_000_000, 1_000];
      for (const scale of candidateScales) {
        const scaled = price * scale;
        if (Number.isFinite(scaled) && Math.abs(scaled) <= Number.MAX_SAFE_INTEGER) {
          const rounded = Math.round(scaled);
          if (rounded > 0) {
            numerator = BigInt(rounded);
            denominator = BigInt(scale);
            break;
          }
        }
      }
    }
  }

  if (!numerator || !denominator) return null;
  if (isRev) return { numerator: denominator, denominator: numerator };
  return { numerator, denominator };
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    const bi = BigInt(String(value));
    return bi > 0n ? bi : null;
  } catch {
    return null;
  }
}

function decimalScale(dec?: number | null): bigint | null {
  if (dec === null || dec === undefined) return null;
  const n = Number(dec);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(18, Math.max(0, Math.floor(n)));
  try {
    return 10n ** BigInt(clamped);
  } catch {
    return null;
  }
}

function clampFeeBps(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(9999, Math.round(n)));
}


