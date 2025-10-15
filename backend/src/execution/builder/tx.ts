import type { ExecutionPlan } from '../types.js';
import { buildRaydiumAmmSwapIx, buildRaydiumClmmSwapIx, buildOrcaSwapIx, buildMeteoraDlmmSwapIx, buildRaydiumAmmSwapIxReal, buildRaydiumClmmSwapIxReal, buildMeteoraDlmmSwapIxReal } from './ix.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { buildCreateAtaIx, deriveAta, isSolMint, buildWrapSolIxs, buildUnwrapSolIx } from '../accounts.js';
import { ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { loadExecConfig } from '../../server/execConfigStore.js';

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

export async function buildDirectArbTx(plan: ExecutionPlan, extraSetupIxs: any[], cb?: ComputeBudgetConfig): Promise<{ tx: any; ixCount: number; sizeBytes: number }> {
  const t0 = Date.now();
  // Build per-hop placeholders
  const hopIxs: any[] = [];
  const owner = (await ensureWallet(CONFIG.walletPath)).publicKey;
  // Optional basic preflight checks (balances/ATAs) can be added here in future
  const execCfg = await loadExecConfig().catch(() => ({ createAtasInTx: true, wrapSolInTx: true } as any));
  let performedWrap = false;
  let willUnwrap = false;
  for (const hop of plan.hops) {
    try { logger.debug('tx.build.hop', { cat: 'tx', code: LogCode.TX_BUILD_HOP, ctx: { dex: hop.dex, variant: hop.variant, poolId: hop.poolId } as any }); } catch {}
    try {
      // --- Pre-hop account prep: ATAs and optional SOL wrapping ---
      if (execCfg.createAtasInTx !== false) {
        const payer = owner;
        // Derive ATAs when missing
        if (!hop.userSourceAta) {
          try { hop.userSourceAta = deriveAta(owner, new PublicKey(hop.inputMint), hop.inputTokenProgram).toBase58(); } catch {}
        }
        if (!hop.userDestAta) {
          try { hop.userDestAta = deriveAta(owner, new PublicKey(hop.outputMint), hop.outputTokenProgram).toBase58(); } catch {}
        }
        // Create ATAs if still missing (emit real create-ATA ixs)
        if (!hop.userSourceAta) hopIxs.push(buildCreateAtaIx(owner, owner, new PublicKey(hop.inputMint), hop.inputTokenProgram));
        if (!hop.userDestAta) hopIxs.push(buildCreateAtaIx(owner, owner, new PublicKey(hop.outputMint), hop.outputTokenProgram));
      }
      // SOL wrapping/unwrap if configured
      const wrapSol = (execCfg.wrapSolInTx !== false) && (CONFIG.system.wrapAndUnwrapSol !== false);
      if (wrapSol) {
        if (isSolMint(hop.inputMint) && !performedWrap) {
          const lamports = Number(hop.amountInRaw || 0n);
          if (lamports > 0) {
            const wrap = buildWrapSolIxs(owner, owner, lamports);
            hopIxs.push(...wrap.ixs);
            hop.userSourceAta = wrap.wsolAta.toBase58();
            performedWrap = true;
          }
        }
        // If final hop outputs SOL, schedule unwrap
        const isLastHop = hop === plan.hops[plan.hops.length - 1];
        if (isLastHop && isSolMint(hop.outputMint)) {
          willUnwrap = true;
          // Ensure dest ATA is WSOL; unwrap will close it to SOL
          try { hop.userDestAta = deriveAta(owner, new PublicKey(hop.outputMint), hop.outputTokenProgram).toBase58(); } catch {}
        }
      }

      // Guard: if amount is zero, avoid invoking real SDK builders
      // - In simulate mode, fall back to placeholder descriptors so build succeeds
      // - In direct mode, fail fast with a descriptive error
      if ((hop.amountInRaw || 0n) <= 0n) {
        const mode: any = (execCfg as any)?.mode || 'simulate';
        if (mode !== 'direct') {
          if (hop.dex === 'raydium' && hop.variant === 'amm') { hopIxs.push(...buildRaydiumAmmSwapIx(hop)); continue; }
          else if (hop.dex === 'raydium' && hop.variant === 'clmm') { hopIxs.push(...buildRaydiumClmmSwapIx(hop)); continue; }
          else if (hop.dex === 'orca') { hopIxs.push({ programId: hop.programId || 'whirlpool', type: 'orca.clmm.swap', keys: { poolId: hop.poolId }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }); continue; }
          else if (hop.dex === 'meteora') { hopIxs.push(...buildMeteoraDlmmSwapIx(hop)); continue; }
        } else {
          throw new Error('AMOUNT_ZERO');
        }
      }

      if (hop.dex === 'raydium' && hop.variant === 'amm') { const ixs = await buildRaydiumAmmSwapIxReal(hop); hopIxs.push(...ixs); }
      else if (hop.dex === 'raydium' && hop.variant === 'clmm') { const ixs = await buildRaydiumClmmSwapIxReal(hop); hopIxs.push(...ixs); }
      else if (hop.dex === 'orca') { const ixs = await buildOrcaSwapIx(hop) as any[]; hopIxs.push(...ixs); }
      else if (hop.dex === 'meteora') { const ixs = await buildMeteoraDlmmSwapIxReal(hop); hopIxs.push(...ixs); }
    } catch (e) {
      try { logger.error('tx.build.hop.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { dex: hop.dex, variant: hop.variant, poolId: hop.poolId, error: String((e as any)?.message || e) } as any }); } catch {}
      throw e;
    }
  }
  if (willUnwrap) {
    hopIxs.push(buildUnwrapSolIx(owner));
  }
  const budget = computeBudgetIxs(cb);
  const all = [...budget, ...extraSetupIxs, ...hopIxs];
  // Approximate size
  const sizeBytes = all.length * 200;
  try {
    const programCounts: Record<string, number> = {};
    for (const it of all) {
      let pid = (it as any)?.programId;
      try { if (pid && typeof pid.toBase58 === 'function') pid = pid.toBase58(); } catch {}
      const key = String(pid || 'unknown');
      programCounts[key] = (programCounts[key] || 0) + 1;
    }
    logger.info('tx.build.detail', { cat: 'tx', ctx: { ixCount: all.length, programs: programCounts } as any });
  } catch {}
  try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { ms: Date.now() - t0, ixCount: all.length, sizeBytes } as any }); } catch {}
  return { tx: { instructions: all, v: 0 }, ixCount: all.length, sizeBytes };
}

export function chunkRoute(plan: ExecutionPlan, extraSetupIxs: any[], cb: ComputeBudgetConfig | undefined, maxBytes = 1100): { txs: Array<{ instructions: any[]; approxSizeBytes: number }>; totalIxs: number; totalBytes: number } {
  const budget = computeBudgetIxs(cb);
  const perHop: any[] = [];
  for (const hop of plan.hops) {
    if (hop.dex === 'raydium' && hop.variant === 'amm') perHop.push(...buildRaydiumAmmSwapIx(hop));
    else if (hop.dex === 'raydium' && hop.variant === 'clmm') perHop.push(...buildRaydiumClmmSwapIx(hop));
    else if (hop.dex === 'orca') {
      // Do not invoke async builders in sync chunking; insert a stub marker
      perHop.push({ kind: 'placeholder', dex: 'orca', poolId: hop.poolId });
    }
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

export async function chunkRouteAsync(plan: ExecutionPlan, extraSetupIxs: any[], cb: ComputeBudgetConfig | undefined, maxBytes = 1100): Promise<{ txs: Array<{ instructions: any[]; approxSizeBytes: number }>; totalIxs: number; totalBytes: number }> {
  const budget = computeBudgetIxs(cb);
  const perHop: any[] = [];
  for (const hop of plan.hops) {
    if (hop.dex === 'raydium' && hop.variant === 'amm') perHop.push(...buildRaydiumAmmSwapIx(hop));
    else if (hop.dex === 'raydium' && hop.variant === 'clmm') perHop.push(...buildRaydiumClmmSwapIx(hop));
    else if (hop.dex === 'orca') perHop.push(...(await buildOrcaSwapIx(hop) as any));
    else if (hop.dex === 'meteora') perHop.push(...buildMeteoraDlmmSwapIx(hop));
  }
  const base = [...budget, ...extraSetupIxs];
  const txs: Array<{ instructions: any[]; approxSizeBytes: number }>= [];
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


