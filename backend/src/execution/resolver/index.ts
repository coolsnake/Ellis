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
    return hop;
  }));

  logger.info('arb.resolve_direct.plan_ready', { cat: 'arb', subcat: 'direct', code: 'ARB.RESOLVE.PLAN' });
  return { path, hops, computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports };
}


