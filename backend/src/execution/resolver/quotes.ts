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
      const poolIdStripped = hop.poolId.replace(/-rev$/, '');
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
        const clmmOut = quoteRaydiumClmmFromSnapshot(hop, amountInRaw, ray);
        if (clmmOut > 0n) return clmmOut;
      }

      if (minimalMathAllowed && ray) {
        const isRev = /-rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/-rev$/, '');
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
    } else if (hop.dex === 'meteora') {
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const isRev = /-rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/-rev$/, '');
        const met = peekMeteoraPools();
        const p = (met.clmm || []).find((x: any) => String(x?.id || '') === id);
        if (p) {
          const feeBps = Number((p as any)?.fee_bps || 0);
          const decIn = Number(hop.inputDecimals ?? (isRev ? (p as any)?.decimals_b : (p as any)?.decimals_a) ?? 0);
          const decOut = Number(hop.outputDecimals ?? (isRev ? (p as any)?.decimals_a : (p as any)?.decimals_b) ?? 0);
          const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps)) / 10_000));
          if (Number.isFinite(decIn) && Number.isFinite(decOut)) {
            const px = Number((p as any)?.price_a_per_b || 0);
            if (px > 0) {
              const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
              if (Number.isFinite(amtIn)) {
                const outWhole = (isRev ? amtIn * px : amtIn / px) * fee;
                const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
                if (outRaw > 0n) return outRaw;
              }
            }
          }
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
    const poolId = hop.poolId?.replace(/-rev$/, '') || '';
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
    const isRev = /-rev$/.test(hop.poolId || '');
    
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
  if (!(amountInRaw > 0n)) return 0n;
  if (!pools || !Array.isArray(pools.clmm)) return 0n;

  const rawPoolId = String(hop.poolId || '');
  if (!rawPoolId) return 0n;
  const isRev = rawPoolId.endsWith('-rev');
  const baseId = rawPoolId.replace(/-rev$/, '');
  const pool = (pools.clmm || []).find((x: any) => String(x?.id || '') === baseId);
  if (!pool) return 0n;

  const ratio = extractClmmPriceRatio(pool, isRev);
  if (!ratio) return 0n;
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
  if (!scaleIn || !scaleOut) return 0n;

  const feeBpsBig = BigInt(clampFeeBps((pool as any)?.fee_bps ?? (hop as any)?.fee_bps));
  const feeNumerator = 10_000n - feeBpsBig;
  const feeDenominator = 10_000n;

  const numerator = amountInRaw * priceDenominator * scaleOut * feeNumerator;
  const denominator = scaleIn * priceNumerator * feeDenominator;
  if (!(denominator > 0n)) return 0n;

  const out = numerator / denominator;
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


