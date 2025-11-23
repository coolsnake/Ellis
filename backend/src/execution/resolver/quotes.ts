import type { DirectHop } from '../types.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { peekRaydiumPools, peekMeteoraPools } from '../../server/pools.js';

export async function quoteHopOut(hop: DirectHop, amountInRaw: bigint): Promise<bigint> {
  try {
    if (hop.dex === 'orca') {
      // OPTIMIZATION: Try local quote first using cached pool state
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const localQuote = await quoteOrcaClmmLocal(hop, amountInRaw);
        if (localQuote > 0n) return localQuote;
      }
      
      // Fallback to SDK quote if local fails
      const { logger } = await import('../../utils/logger.js');
      try {
        logger.info('tx.resolve.quote.orca.start', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            inputMint: hop.inputMint,
            outputMint: hop.outputMint,
            amountInRaw: amountInRaw.toString(),
            programId: hop.programId,
            inputDecimals: hop.inputDecimals,
            outputDecimals: hop.outputDecimals,
          }
        });
      } catch {}
      
      const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
      const { Percentage } = await import('@orca-so/common-sdk');
      const kp = await ensureWallet(CONFIG.walletPath);
      
      try {
        logger.info('tx.resolve.quote.orca.wallet', {
          cat: 'tx',
          ctx: {
            wallet: kp.publicKey.toBase58(),
          }
        });
      } catch {}
      
      const programId = new PublicKey(hop.programId || (CONFIG.orca?.programId as any));
      const ctx = (WhirlpoolContext as any).from(getConnection() as any, { publicKey: kp.publicKey } as any, programId);
      
      try {
        logger.info('tx.resolve.quote.orca.context', {
          cat: 'tx',
          ctx: {
            programId: ctx.program.programId.toBase58(),
            wallet: kp.publicKey.toBase58(),
          }
        });
      } catch {}
      
      const client = (buildWhirlpoolClient as any)(ctx);
      // Strip -rev suffix before creating PublicKey (similar to Raydium/Meteora)
      const poolIdStripped = hop.poolId.replace(/[#-]rev$/, '');
      const pool = await client.getPool(new PublicKey(poolIdStripped));
      
      try {
        const poolData = pool.getData ? pool.getData() : null;
        logger.info('tx.resolve.quote.orca.pool', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            poolAddress: pool.getAddress?.()?.toBase58() || 'unknown',
            hasData: !!poolData,
            tickCurrentIndex: poolData?.tickCurrentIndex?.toString() || 'unknown',
            tickSpacing: poolData?.tickSpacing?.toString() || 'unknown',
            sqrtPrice: poolData?.sqrtPrice?.toString() || 'unknown',
          }
        });
      } catch {}
      
      const slippageTolerance = (Percentage as any).fromFraction(1, 10_000);
      const inputMintPk = new PublicKey(hop.inputMint);
      
      // Convert amountInRaw to BN (BigNumber) - Orca SDK expects BN, not bigint
      const bnjs = await import('bn.js');
      const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
      const amountInBn = new BN(String(amountInRaw));
      
      try {
        logger.info('tx.resolve.quote.orca.params', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            inputMint: inputMintPk.toBase58(),
            amountInRaw: amountInRaw.toString(),
            amountInBn: amountInBn.toString(),
            slippageTolerance: String(slippageTolerance),
          }
        });
      } catch {}
      
      const quote = await (swapQuoteByInputToken as any)(
        pool,
        inputMintPk,
        amountInBn,  // Use BN instead of bigint
        slippageTolerance,
        ctx.program.programId,
        ctx.fetcher,
        true,
      );
      
      try {
        const quoteKeys = quote ? Object.keys(quote) : [];
        const otherAmount = quote?.otherAmount;
        const estimatedAmountOut = quote?.estimatedAmountOut;
        const estimatedAmountIn = quote?.estimatedAmountIn;
        const aToB = quote?.aToB;
        const sqrtPriceLimit = quote?.sqrtPriceLimit;
        
        logger.info('tx.resolve.quote.orca.result', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            quoteExists: !!quote,
            quoteKeys: quoteKeys.join(','),
            otherAmount: otherAmount?.toString() || 'undefined',
            estimatedAmountOut: estimatedAmountOut?.toString() || 'undefined',
            estimatedAmountIn: estimatedAmountIn?.toString() || 'undefined',
            aToB: aToB !== undefined ? String(aToB) : 'undefined',
            sqrtPriceLimit: sqrtPriceLimit?.toString() || 'undefined',
            quoteType: quote?.constructor?.name || typeof quote,
          }
        });
      } catch {}
      
      const out = BigInt((quote as any)?.otherAmount ?? (quote as any)?.estimatedAmountOut ?? 0);
      
      // Extract and cache tick arrays from quote result
      // This ensures tick arrays are available in execution cache for the builder
      try {
        const { executionCache } = await import('../cache.js');
        const poolIdStripped = hop.poolId.replace(/[#-]rev$/, '');
        const existing = executionCache.getHot(poolIdStripped);
        
        // Extract tick array addresses from quote
        // The Orca SDK quote provides tickArray0, tickArray1, tickArray2
        // These correspond to lower, center, and upper tick arrays
        const tickArray0 = (quote as any)?.tickArray0;
        const tickArray1 = (quote as any)?.tickArray1;
        const tickArray2 = (quote as any)?.tickArray2;
        
        // Convert PublicKey objects to base58 strings if needed
        const tickArray0Str = tickArray0?.toBase58?.() || tickArray0;
        const tickArray1Str = tickArray1?.toBase58?.() || tickArray1;
        const tickArray2Str = tickArray2?.toBase58?.() || tickArray2;
        
        // Map to lower/center/upper structure expected by builder
        // Note: lower and upper are arrays per type definition, center is a string
        const tickArrays: { lower?: string[]; center?: string; upper?: string[] } = {};
        if (tickArray0Str) tickArrays.lower = [String(tickArray0Str)];
        if (tickArray1Str) tickArrays.center = String(tickArray1Str);
        if (tickArray2Str) tickArrays.upper = [String(tickArray2Str)];
        
        // Only update cache if we have at least one tick array
        if (tickArrays.lower || tickArrays.center || tickArrays.upper) {
          executionCache.setHot(poolIdStripped, {
            ...existing,
            tickArrays: {
              ...existing?.tickArrays,
              ...tickArrays
            }
          });
          
          try {
            logger.info('tx.resolve.quote.orca.tickarrays.cached', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                lower: tickArrays.lower?.[0]?.slice(0, 8) + '…' || 'none',
                center: tickArrays.center?.slice(0, 8) + '…' || 'none',
                upper: tickArrays.upper?.[0]?.slice(0, 8) + '…' || 'none',
              }
            });
          } catch {}
        }
      } catch (err) {
        // Log but don't fail if caching fails - builder will fallback to RPC if needed
        try {
          logger.debug('tx.resolve.quote.orca.tickarrays.cache.failed', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              error: String((err as any)?.message || err)
            }
          });
        } catch {}
      }
      
      try {
        logger.info('tx.resolve.quote.orca.final', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            out: out.toString(),
            outIsZero: out === 0n,
            usedOtherAmount: quote?.otherAmount !== undefined,
            usedEstimatedAmountOut: quote?.estimatedAmountOut !== undefined,
          }
        });
      } catch {}
      
      if (out > 0n) return out;
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
          
          logger.info('raydium.clmm.quote.attempt', {
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
        } catch {}
        
        const clmmOut = quoteRaydiumClmmFromSnapshot(hop, amountInRaw, ray);
        
        try {
          const { logger } = await import('../../utils/logger.js');
          logger.info('raydium.clmm.quote.result', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              amountInRaw: amountInRaw.toString(),
              quotedOut: clmmOut.toString(),
              success: clmmOut > 0n,
            }
          });
        } catch {}
        
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
              const rate = isRev ? px : (1 / px);
              if (rate > 0) {
                const outWhole = amtIn * rate * fee;
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                if (outRaw > 0n) return outRaw;
              }
            }
          }
        }
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
          
          logger.info('meteora.dlmm.quote.attempt', {
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
        } catch {}
        
        if (p) {
          const feeBps = Number((p as any)?.fee_bps || 0);
          const decIn = Number(hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0);
          const decOut = Number(hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0);
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
                  logger.info('meteora.dlmm.quote.price_from_reserves', {
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
                      isRev,
                    }
                  });
                } catch {}
              }
            }
          }
          
          try {
            const { logger } = await import('../../utils/logger.js');
            logger.info('meteora.dlmm.quote.pool_data', {
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
          } catch {}
          
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            if (px > 0) {
              const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
              if (Number.isFinite(amtIn)) {
                const outWhole = (isRev ? amtIn * px : amtIn / px) * fee;
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.info('meteora.dlmm.quote.calculation', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      amountInRaw: amountInRaw.toString(),
                      amtIn,
                      outWhole,
                      outRaw: outRaw.toString(),
                      success: outRaw > 0n,
                      formula: isRev ? 'amtIn * px * fee' : '(amtIn / px) * fee',
                    }
                  });
                } catch {}
                
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
                } catch {}
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
              } catch {}
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
            } catch {}
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
          } catch {}
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
        ctx: {
          dex: hop.dex,
          poolId: hop.poolId,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          amountInRaw: amountInRaw.toString(),
          error: String((e as any)?.message || e),
          stack: (e as any)?.stack,
        }
      });
    } catch {}
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
 * Uses CLMM constant product formula with concentrated liquidity
 */
async function quoteOrcaClmmLocal(hop: DirectHop, amountInRaw: bigint): Promise<bigint> {
  if (!(amountInRaw > 0n)) return 0n;
  
  try {
    const { executionCache } = await import('../cache.js');
    
    // Get cached pool state
    const poolId = hop.poolId?.replace(/[#-]rev$/, '') || '';
    if (!poolId) return 0n;
    
    const cached = executionCache.getHot(poolId);
    if (!cached?.sqrtPriceX64 || !cached?.liquidity) {
      // Cache miss - fallback to SDK quote
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.debug('orca.quote.local.cache_miss', {
          cat: 'tx',
          ctx: {
            pool: poolId,
            hasSqrtPrice: !!cached?.sqrtPriceX64,
            hasLiquidity: !!cached?.liquidity,
            msg: 'Falling back to SDK quote'
          }
        });
      } catch {}
      return 0n;
    }
    
    const { sqrtPriceX64, liquidity, feeRate } = cached;
    
    // Determine swap direction
    const isRev = /[#-]rev$/.test(hop.poolId || '');
    
    // Get decimals (should be available from hop or fetch from cache)
    const decIn = hop.inputDecimals;
    const decOut = hop.outputDecimals;
    
    if (!Number.isFinite(decIn) || !Number.isFinite(decOut)) {
      return 0n;
    }
    
    // CLMM Quote Formula (simplified constant product for small swaps)
    // For exact calculation, we'd need to iterate through tick ranges
    // This is an approximation that works well for swaps within the current tick
    
    // Apply fee
    const feeBps = feeRate || 25; // Default to 25 bps (0.25%) if not available
    const feeMultiplier = 10000 - feeBps;
    const amountInAfterFee = (amountInRaw * BigInt(feeMultiplier)) / 10000n;
    
    // Convert sqrtPriceX64 to price ratio
    // sqrtPrice = sqrt(tokenB / tokenA) * 2^64
    // price = (sqrtPrice / 2^64)^2
    const Q64 = 1n << 64n;
    
    // For small swaps, use linear approximation based on current price
    // out = in * price * (1 - fee)
    // This is similar to Raydium/Meteora simple price-based calculation
    
    let outRaw: bigint;
    
    if (isRev) {
      // Swapping B -> A: multiply by price
      // price_b_per_a = (sqrtPrice / 2^64)^2
      const sqrtPrice = sqrtPriceX64;
      const numerator = amountInAfterFee * Q64 * Q64;
      const denominator = sqrtPrice * sqrtPrice;
      
      if (denominator === 0n) return 0n;
      
      // Adjust for decimals
      const decimalAdjustment = BigInt(Math.pow(10, decOut as number)) * 10n ** 18n;
      const decimalDivisor = BigInt(Math.pow(10, decIn as number)) * 10n ** 18n;
      
      outRaw = (numerator * decimalAdjustment) / (denominator * decimalDivisor);
    } else {
      // Swapping A -> B: divide by price  
      // price_a_per_b = 1 / ((sqrtPrice / 2^64)^2)
      const sqrtPrice = sqrtPriceX64;
      const numerator = amountInAfterFee * sqrtPrice * sqrtPrice;
      const denominator = Q64 * Q64;
      
      if (denominator === 0n) return 0n;
      
      // Adjust for decimals
      const decimalAdjustment = BigInt(Math.pow(10, decOut as number)) * 10n ** 18n;
      const decimalDivisor = BigInt(Math.pow(10, decIn as number)) * 10n ** 18n;
      
      outRaw = (numerator * decimalAdjustment) / (denominator * decimalDivisor);
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
            isRev,
            sqrtPriceX64: sqrtPriceX64.toString()
          }
        });
      } catch {}
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
    } catch {}
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
    } catch {}
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
    } catch {}
    return 0n;
  }

  const rawPoolId = String(hop.poolId || '');
  if (!rawPoolId) return 0n;
  const isRev = /[#-]rev$/.test(rawPoolId);
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
            isRev,
            availablePoolIds: (pools.clmm || []).slice(0, 5).map((x: any) => x?.id),
          }
        });
      });
    } catch {}
    return 0n;
  }

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
            logger.info('raydium.clmm.quote.price_from_reserves', {
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
        } catch {}
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
    } catch {}
    return 0n;
  }
  const { numerator: priceNumerator, denominator: priceDenominator } = ratio;

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
    } catch {}
    return 0n;
  }

  const feeBpsBig = BigInt(clampFeeBps((pool as any)?.fee_bps ?? (hop as any)?.fee_bps));
  const feeNumerator = 10_000n - feeBpsBig;
  const feeDenominator = 10_000n;

  const numerator = amountInRaw * priceDenominator * scaleOut * feeNumerator;
  const denominator = scaleIn * priceNumerator * feeDenominator;
  
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
    } catch {}
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
                executionCache.setHot(poolIdStripped, {
                  ...existing,
                  tickArrays: {
                    ...existing?.tickArrays,
                    ...tickArrays
                  }
                });
                
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.info('raydium.clmm.quote.tickarrays.cached', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      lower: tickArrays.lower?.[0]?.slice(0, 8) + '…' || 'none',
                      center: tickArrays.center?.slice(0, 8) + '…' || 'none',
                      upper: tickArrays.upper?.[0]?.slice(0, 8) + '…' || 'none',
                    }
                  });
                } catch {}
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
              } catch {}
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
      logger.info('raydium.clmm.quote.calculated', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          amountInRaw: amountInRaw.toString(),
          out: out.toString(),
          success: out > 0n,
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
  } catch {}
  
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


