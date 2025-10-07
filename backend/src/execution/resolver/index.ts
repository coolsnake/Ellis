import { executionCache } from '../cache.js';
import type { DirectHop, ExecutionPlan, ExecConfig, ResolveDirectInput } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getTokenMeta } from './tokenMeta.js';
import { applySlippage } from '../limits.js';

export async function resolveDirectPlan(input: ResolveDirectInput, cfg: ExecConfig): Promise<ExecutionPlan> {
  const path = Array.isArray(input.path) ? input.path : [];
  const hopPoolIds = Array.isArray(input.hopPoolIds) ? input.hopPoolIds : [];
  const dexes = Array.isArray(input.dexes) ? input.dexes : [];
  if (path.length < 2 || hopPoolIds.length !== (path.length - 1) || dexes.length !== (path.length - 1)) {
    throw new Error('invalid resolve input: path/hops mismatch');
  }

  const t0 = Date.now();
  logger.info('tx.resolve.start', { cat: 'tx', code: 'TX.RESOLVE.START', ctx: { hopCount: path.length - 1 } as any });
  const hops: DirectHop[] = await Promise.all(path.slice(0, -1).map(async (_mint, i) => {
    const dexv = String(dexes[i] || '').toLowerCase();
    const dex = (dexv.includes('raydium') ? 'raydium' : (dexv.includes('orca') ? 'orca' : 'meteora')) as DirectHop['dex'];
    const variant: DirectHop['variant'] = dex === 'raydium' ? (dexv.includes('clmm') ? 'clmm' : 'amm') : (dex === 'orca' ? 'clmm' : 'dlmm');
    const poolId = String(hopPoolIds[i]);
    const inputMint = path[i];
    const outputMint = path[i+1];
    // lightweight placeholders; per-DEX resolvers will fill in accounts/state
    const tokenInMeta = executionCache.getTokenMeta(inputMint) || await getTokenMeta(inputMint);
    const tokenOutMeta = executionCache.getTokenMeta(outputMint) || await getTokenMeta(outputMint);
    const hop: DirectHop = {
      dex,
      variant,
      poolId,
      programId: executionCache.getStatic(poolId)?.programId || '',
      inputMint,
      outputMint,
      inputDecimals: tokenInMeta.decimals,
      outputDecimals: tokenOutMeta.decimals,
      inputTokenProgram: tokenInMeta.program,
      outputTokenProgram: tokenOutMeta.program,
      userSourceAta: '',
      userDestAta: '',
      amountInRaw: BigInt(Math.max(0, Math.floor(Number(input.size || 0)))) ,
      minOutRaw: 0n,
    };
    // Compute conservative minOut using default slippage when provided size specified (placeholder)
    if (hop.amountInRaw > 0n) {
      const slippage = typeof input.slippageBps === 'number' ? input.slippageBps : cfg.slippageBpsDefault;
      hop.minOutRaw = applySlippage(hop.amountInRaw, slippage, 'minOut');
    }
    // Per-DEX refinement hooks (populate program accounts/ticks)
    try {
      if (hop.dex === 'raydium' && hop.variant === 'amm') {
        const { resolveRaydiumAmm } = await import('./raydiumAmm.js');
        return await resolveRaydiumAmm(hop);
      } else if (hop.dex === 'raydium' && hop.variant === 'clmm') {
        const { resolveRaydiumClmm } = await import('./raydiumClmm.js');
        return await resolveRaydiumClmm(hop);
      } else if (hop.dex === 'orca') {
        const { resolveOrca } = await import('./orca.js');
        return await resolveOrca(hop);
      } else {
        const { resolveMeteoraDlmm } = await import('./meteora.js');
        return await resolveMeteoraDlmm(hop);
      }
    } catch {
      return hop;
    }
  }));

  // Dynamic sizing from bottleneck: naive proportional to min vault liquidity across hops
  try {
    const caps = hops.map(h => Number((h as any)?.liquidity_display || 0)).filter(v => Number.isFinite(v) && v > 0);
    if (caps.length) {
      const minCap = Math.min(...caps);
      const usd = Math.max(1, Math.floor(minCap * 0.02));
      const dec = hops[0]?.inputDecimals || 9;
      const priceUsd = 1; // placeholder: assume $1 units for input mint
      const tokens = usd / priceUsd;
      const raw = BigInt(Math.max(1, Math.floor(tokens * Math.pow(10, dec))));
      // Apply to first hop only for now
      if (raw > 0n) hopAdjustAmount(hops, raw);
    }
  } catch {}
  logger.info('tx.resolve.ok', { cat: 'tx', code: 'TX.RESOLVE.OK', ctx: { ms: Date.now() - t0, hops: hops.length } as any });
  return { path, hops, computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports };
}

function hopAdjustAmount(hops: DirectHop[], raw: bigint): void {
  try {
    const h0 = hops[0];
    if (h0) {
      h0.amountInRaw = raw;
      const slippageBps = 100;
      const one = 10_000n;
      h0.minOutRaw = (raw * (one - BigInt(slippageBps))) / one;
    }
  } catch {}
}


