import type { DirectHop } from '../types.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { peekRaydiumPools, peekMeteoraPools } from '../../server/pools.js';

export async function quoteHopOut(hop: DirectHop, amountInRaw: bigint): Promise<bigint> {
  try {
    if (hop.dex === 'orca') {
      const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
      const { Percentage } = await import('@orca-so/common-sdk');
      const kp = await ensureWallet(CONFIG.walletPath);
      const ctx = (WhirlpoolContext as any).from(getConnection() as any, { publicKey: kp.publicKey } as any, new PublicKey(hop.programId || (CONFIG.orca?.programId as any)));
      const client = (buildWhirlpoolClient as any)(ctx);
      const pool = await client.getPool(new PublicKey(hop.poolId));
      const quote = await (swapQuoteByInputToken as any)(
        pool,
        new PublicKey(hop.inputMint),
        amountInRaw,
        (Percentage as any).fromFraction(1, 10_000),
        ctx.program.programId,
        ctx.fetcher,
        true,
      );
      const out = BigInt((quote as any)?.otherAmount ?? (quote as any)?.estimatedAmountOut ?? 0);
      if (out > 0n) return out;
    } else if (hop.dex === 'raydium') {
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const id = hop.poolId.replace(/-rev$/, '');
        const ray = peekRaydiumPools();
        const p = (ray.amm || []).find((x: any) => String(x?.id||'')===id);
        if (p) {
          const feeBps = Number((p as any)?.fee_bps || (hop as any)?.fee_bps || 0);
          const decIn = Number(hop.inputDecimals || (p as any)?.decimals_a || 0);
          const decOut = Number(hop.outputDecimals || (p as any)?.decimals_b || 0);
          const reserveA = Number((p as any)?.amount_a_whole ?? (p as any)?.reserveA ?? 0);
          const reserveB = Number((p as any)?.amount_b_whole ?? (p as any)?.reserveB ?? 0);
          if (reserveA > 0 && reserveB > 0) {
            const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
            const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps))/10_000));
            const amtInAfterFee = amtIn * fee;
            const outWhole = (amtInAfterFee * reserveB) / (reserveA + amtInAfterFee);
            const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
            if (outRaw > 0n) return outRaw;
          }
        }
      }
      const delta = Number(hop.outputDecimals) - Number(hop.inputDecimals);
      if (delta >= 0) {
        const mul = Math.min(6, delta);
        return amountInRaw * BigInt(10 ** mul);
      }
      const div = Math.min(6, -delta);
      return amountInRaw / BigInt(10 ** div);
    } else if (hop.dex === 'meteora') {
      const sys: any = (CONFIG as any)?.system || {};
      if (sys.quotes?.enableMinimalMath !== false) {
        const id = hop.poolId.replace(/-rev$/, '');
        const met = peekMeteoraPools();
        const p = (met.clmm || []).find((x: any) => String(x?.id||'')===id);
        if (p) {
          const feeBps = Number((p as any)?.fee_bps || 0);
          const decIn = Number(hop.inputDecimals || (p as any)?.decimals_a || 0);
          const decOut = Number(hop.outputDecimals || (p as any)?.decimals_b || 0);
          const px = Number((p as any)?.price_a_per_b || 0); // A per 1 B
          if (px > 0) {
            const amtIn = Number(amountInRaw) / Math.pow(10, decIn);
            const fee = Math.max(0, 1 - (Math.min(9900, Math.max(0, feeBps))/10_000));
            const outWhole = (amtIn / px) * fee;
            const outRaw = BigInt(Math.floor(outWhole * Math.pow(10, decOut)));
            if (outRaw > 0n) return outRaw;
          }
        }
      }
      const delta = Number(hop.outputDecimals) - Number(hop.inputDecimals);
      if (delta >= 0) {
        const mul = Math.min(6, delta);
        return amountInRaw * BigInt(10 ** mul);
      }
      const div = Math.min(6, -delta);
      return amountInRaw / BigInt(10 ** div);
    }
  } catch {}
  return 0n;
}

export function applyMinOut(outRaw: bigint, slippageBps: number): bigint {
  const one = 10_000n;
  const bps = BigInt(Math.max(0, Math.min(9900, Math.round(slippageBps))));
  return (outRaw * (one - bps)) / one;
}


