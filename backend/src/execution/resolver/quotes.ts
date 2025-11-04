import type { DirectHop } from '../types.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { peekRaydiumPools, peekMeteoraPools } from '../../server/pools.js';

export async function quoteHopOut(hop: DirectHop, amountInRaw: bigint): Promise<bigint> {
  try {
    if (hop.dex === 'orca') {
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
      const pool = await client.getPool(new PublicKey(hop.poolId));
      
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
      if (sys.quotes?.enableMinimalMath !== false) {
        const isRev = /-rev$/.test(hop.poolId || '');
        const id = hop.poolId.replace(/-rev$/, '');
        const ray = peekRaydiumPools();
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


