import type { ExecutionPlan } from '../types.js';
import { buildRaydiumAmmSwapIx, buildRaydiumClmmSwapIx, buildOrcaSwapIx, buildMeteoraDlmmSwapIx } from './ix.js';
import { logger } from '../../utils/logger.js';

export type ComputeBudgetConfig = { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number };

function computeBudgetIxs(cfg?: ComputeBudgetConfig): any[] {
  const out: any[] = [];
  if (!cfg) return out;
  const limit = Math.max(0, Number(cfg.computeUnitLimit || 0));
  const price = Math.max(0, Number(cfg.computeUnitPriceMicroLamports || 0));
  if (limit > 0) out.push({ programId: 'ComputeBudget111111111111111111111111111111', type: 'set_compute_unit_limit', units: limit });
  if (price > 0) out.push({ programId: 'ComputeBudget111111111111111111111111111111', type: 'set_compute_unit_price', microLamports: price });
  return out;
}

export function buildDirectArbTx(plan: ExecutionPlan, extraSetupIxs: any[], cb?: ComputeBudgetConfig): { tx: any; ixCount: number; sizeBytes: number } {
  const t0 = Date.now();
  // Build per-hop placeholders
  const hopIxs: any[] = [];
  for (const hop of plan.hops) {
    if (hop.dex === 'raydium' && hop.variant === 'amm') hopIxs.push(...buildRaydiumAmmSwapIx(hop));
    else if (hop.dex === 'raydium' && hop.variant === 'clmm') hopIxs.push(...buildRaydiumClmmSwapIx(hop));
    else if (hop.dex === 'orca') hopIxs.push(...buildOrcaSwapIx(hop));
    else if (hop.dex === 'meteora') hopIxs.push(...buildMeteoraDlmmSwapIx(hop));
  }
  const budget = computeBudgetIxs(cb);
  const all = [...budget, ...extraSetupIxs, ...hopIxs];
  // Approximate size
  const sizeBytes = all.length * 200;
  try { logger.info('tx.build.ok', { cat: 'tx', code: 'TX.BUILD.OK', ctx: { ms: Date.now() - t0, ixCount: all.length, sizeBytes } as any }); } catch {}
  return { tx: { instructions: all, v: 0 }, ixCount: all.length, sizeBytes };
}

export function chunkRoute(plan: ExecutionPlan, extraSetupIxs: any[], cb: ComputeBudgetConfig | undefined, maxBytes = 1100): { txs: Array<{ instructions: any[]; approxSizeBytes: number }>; totalIxs: number; totalBytes: number } {
  const budget = computeBudgetIxs(cb);
  const perHop: any[] = [];
  for (const hop of plan.hops) {
    if (hop.dex === 'raydium' && hop.variant === 'amm') perHop.push(...buildRaydiumAmmSwapIx(hop));
    else if (hop.dex === 'raydium' && hop.variant === 'clmm') perHop.push(...buildRaydiumClmmSwapIx(hop));
    else if (hop.dex === 'orca') perHop.push(...buildOrcaSwapIx(hop));
    else if (hop.dex === 'meteora') perHop.push(...buildMeteoraDlmmSwapIx(hop));
  }
  const base = [...budget, ...extraSetupIxs];
  const txs: Array<{ instructions: any[]; approxSizeBytes: number }> = [];
  let cur: any[] = [...base];
  let curBytes = cur.length * 200;
  const pushCur = () => { txs.push({ instructions: cur, approxSizeBytes: curBytes }); cur = [...base]; curBytes = cur.length * 200; };
  for (const ix of perHop) {
    const ixSize = 200;
    if (curBytes + ixSize > maxBytes && cur.length > base.length) pushCur();
    cur.push(ix);
    curBytes += ixSize;
  }
  if (cur.length > base.length) pushCur();
  const totalBytes = txs.reduce((a, b) => a + b.approxSizeBytes, 0);
  const totalIxs = txs.reduce((a, b) => a + b.instructions.length, 0);
  return { txs, totalIxs, totalBytes };
}


