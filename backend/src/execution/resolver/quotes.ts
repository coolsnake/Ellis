import type { DirectHop } from '../types.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';

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
      // Conservative fallback scaling using decimals difference
      const delta = Number(hop.outputDecimals) - Number(hop.inputDecimals);
      if (delta >= 0) {
        const mul = Math.min(6, delta);
        return amountInRaw * BigInt(10 ** mul);
      }
      const div = Math.min(6, -delta);
      return amountInRaw / BigInt(10 ** div);
    } else if (hop.dex === 'meteora') {
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


