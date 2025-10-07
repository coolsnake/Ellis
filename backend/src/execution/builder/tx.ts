import type { ExecutionPlan } from '../types.js';
import { buildRaydiumAmmSwapIx, buildRaydiumClmmSwapIx, buildOrcaSwapIx, buildMeteoraDlmmSwapIx } from './ix.js';

export function buildDirectArbTx(plan: ExecutionPlan, extraSetupIxs: any[]): { tx: any; ixCount: number; sizeBytes: number } {
  const t0 = Date.now();
  // Build per-hop placeholders
  const hopIxs: any[] = [];
  for (const hop of plan.hops) {
    if (hop.dex === 'raydium' && hop.variant === 'amm') hopIxs.push(...buildRaydiumAmmSwapIx(hop));
    else if (hop.dex === 'raydium' && hop.variant === 'clmm') hopIxs.push(...buildRaydiumClmmSwapIx(hop));
    else if (hop.dex === 'orca') hopIxs.push(...buildOrcaSwapIx(hop));
    else if (hop.dex === 'meteora') hopIxs.push(...buildMeteoraDlmmSwapIx(hop));
  }
  const all = [...extraSetupIxs, ...hopIxs];
  // Approximate size
  const sizeBytes = all.length * 200;
  try { (await import('../../utils/logger.js')).logger.info('tx.build.ok', { cat: 'tx', code: 'TX.BUILD.OK', ctx: { ms: Date.now() - t0, ixCount: all.length, sizeBytes } as any }); } catch {}
  return { tx: { instructions: all, v: 0 }, ixCount: all.length, sizeBytes };
}


