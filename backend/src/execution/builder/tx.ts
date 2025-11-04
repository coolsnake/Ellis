import type { ExecutionPlan, DirectHop } from '../types.js';
import { buildRaydiumAmmSwapIx, buildRaydiumClmmSwapIx, buildOrcaSwapIx, buildMeteoraDlmmSwapIx, buildRaydiumAmmSwapIxReal, buildRaydiumClmmSwapIxReal, buildMeteoraDlmmSwapIxReal } from './ix.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey } from '@solana/web3.js';
import { buildCreateAtaIx, deriveAta, isSolMint, buildWrapSolIxs, buildUnwrapSolIx } from '../accounts.js';
import { ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { loadExecConfig } from '../../server/execConfigStore.js';
import { validateHopAmounts } from './validation.js';
import { TransactionTiming } from './timing.js';

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

/**
 * Estimates the serialized size of a transaction instruction
 */
function estimateInstructionSize(ix: any): number {
  try {
    // Base overhead: programId (32) + accounts length (1) + data length (4)
    let size = 37;
    
    // Add account keys (32 bytes each + 1 byte flags)
    const keys = ix?.keys || ix?.accounts || [];
    if (Array.isArray(keys)) {
      size += keys.length * 33;
    }
    
    // Add instruction data
    const data = ix?.data;
    if (data) {
      if (Buffer.isBuffer(data)) {
        size += data.length;
      } else if (data instanceof Uint8Array) {
        size += data.length;
      } else if (Array.isArray(data)) {
        size += data.length;
      } else if (typeof data === 'string') {
        size += Buffer.from(data, 'base64').length;
      }
    }
    
    return size;
  } catch {
    // Fallback to conservative estimate
    return 200;
  }
}

export async function buildDirectArbTx(plan: ExecutionPlan, extraSetupIxs: any[], cb?: ComputeBudgetConfig): Promise<{ tx: any; ixCount: number; sizeBytes: number }> {
  const timing = new TransactionTiming();
  const traceId = Math.random().toString(36).slice(2, 10);
  
  try {
    timing.startStep('initialization');
    // Build per-hop placeholders
    const hopIxs: any[] = [];
    const owner = (await ensureWallet(CONFIG.walletPath)).publicKey;
    // Optional basic preflight checks (balances/ATAs) can be added here in future
    const execCfg = await loadExecConfig().catch(() => ({ createAtasInTx: true, wrapSolInTx: true } as any));
    const modeOverride: 'direct' | 'simulate' | undefined = (cb as any)?.__modeOverride;
    let performedWrap = false;
    let willUnwrap = false;
    
    // Track actual output amounts from previous hops (for amount propagation)
    const hopOutputs: bigint[] = [];
    const ensuredAtas = new Set<string>();
    let prevHopDestAta: string | undefined = undefined;
    let prevHopOutputMint: string | undefined = undefined;
    let prevHopOutputTokenProgram: string | undefined = undefined;
    timing.endStep();

    for (let i = 0; i < plan.hops.length; i++) {
      timing.startStep(`hop_${i}_total`);
      
      // Create a working copy of the hop to avoid mutating the original
      const hop: DirectHop = { ...plan.hops[i] };
      try { logger.debug('tx.build.hop', { cat: 'tx', code: LogCode.TX_BUILD_HOP, ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId } as any }); } catch {}
      try {
        logger.info('tx.build.hop.start', { cat: 'tx', ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId, inputMint: hop.inputMint, outputMint: hop.outputMint, amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n), userSourceAta: hop.userSourceAta ? 'set' : 'missing', userDestAta: hop.userDestAta ? 'set' : 'missing' } as any });
      } catch {}
      
      try {
        timing.startStep(`hop_${i}_account_prep`);
        // --- Pre-hop account prep: ATAs and optional SOL wrapping ---
        if (execCfg.createAtasInTx !== false) {
          const payer = owner;
          
          // For multihop: chain output of previous hop as input of current hop
          if (i > 0 && !hop.userSourceAta && prevHopDestAta) {
            // If previous hop's output mint matches current hop's input mint, reuse the ATA
            if (prevHopOutputMint === hop.inputMint && 
                prevHopOutputTokenProgram === hop.inputTokenProgram) {
              hop.userSourceAta = prevHopDestAta;
              try {
                logger.info('tx.build.hop.chain', { cat: 'tx', ctx: { traceId, hopIndex: i, chainedAta: hop.userSourceAta, mint: hop.inputMint } as any });
              } catch {}
            }
          }
          
          // Derive ATAs when missing
          if (!hop.userSourceAta) {
            try { hop.userSourceAta = deriveAta(owner, new PublicKey(hop.inputMint), hop.inputTokenProgram).toBase58(); } catch {}
          }
          if (!hop.userDestAta) {
            try { hop.userDestAta = deriveAta(owner, new PublicKey(hop.outputMint), hop.outputTokenProgram).toBase58(); } catch {}
          }

          if (hop.userDestAta && !ensuredAtas.has(hop.userDestAta)) {
            hopIxs.push(buildCreateAtaIx(owner, payer, new PublicKey(hop.outputMint), hop.outputTokenProgram));
            ensuredAtas.add(hop.userDestAta);
          }

          if (!isSolMint(hop.inputMint) && hop.userSourceAta && !ensuredAtas.has(hop.userSourceAta)) {
            hopIxs.push(buildCreateAtaIx(owner, payer, new PublicKey(hop.inputMint), hop.inputTokenProgram));
            ensuredAtas.add(hop.userSourceAta);
          }
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
              ensuredAtas.add(hop.userSourceAta);
              performedWrap = true;
            }
          }
          // If final hop outputs SOL, schedule unwrap
          const isLastHop = hop === plan.hops[plan.hops.length - 1];
          if (isLastHop && isSolMint(hop.outputMint)) {
            willUnwrap = true;
            // Ensure dest ATA is WSOL; unwrap will close it to SOL
            try {
              hop.userDestAta = deriveAta(owner, new PublicKey(hop.outputMint), hop.outputTokenProgram).toBase58();
              if (hop.userDestAta && !ensuredAtas.has(hop.userDestAta)) {
                hopIxs.push(buildCreateAtaIx(owner, owner, new PublicKey(hop.outputMint), hop.outputTokenProgram));
                ensuredAtas.add(hop.userDestAta);
              }
            } catch {}
          }
        }
        timing.endStep();

        timing.startStep(`hop_${i}_amount_propagation`);
        // Defensive amount propagation fallback: if later hop is zero, try to use previous hop's output
        // Use actual output amount from previous hop if available, otherwise fall back to minOutRaw
        if ((hop.amountInRaw || 0n) <= 0n && i > 0) {
          try {
            // Prefer actual output from previous hop if tracked
            const prevOutput = hopOutputs[i - 1];
            if (prevOutput && prevOutput > 0n) {
              hop.amountInRaw = prevOutput;
            } else {
              // Fallback to minOutRaw from previous hop
              const prev = plan.hops[i - 1];
              const candidate: bigint = (prev?.minOutRaw && prev.minOutRaw > 0n) ? prev.minOutRaw : (prev?.amountInRaw || 0n);
              if (candidate > 0n) {
                hop.amountInRaw = candidate;
              }
            }
            
            // Validate propagated amount is reasonable
            if (hop.amountInRaw > 0n) {
              validateHopAmounts(hop, { traceId, hopIndex: i, propagated: true });
            }
          } catch (propErr) {
            try {
              logger.warn('tx.build.amount_propagation.failed', {
                cat: 'tx',
                code: LogCode.TX_BUILD_ERR,
                ctx: { traceId, hopIndex: i, error: String((propErr as any)?.message || propErr) }
              });
            } catch {}
          }
        }
        timing.endStep();

        // Guard: if amount is still zero, avoid invoking real SDK builders
        // - In simulate mode, insert a non-executable placeholder (no programId) so assembly skips it
        // - In direct mode, fail fast with a descriptive error
        if ((hop.amountInRaw || 0n) <= 0n) {
          const mode: any = modeOverride || (execCfg as any)?.mode || 'simulate';
          if (mode !== 'direct') {
            hopIxs.push({ kind: 'placeholder', dex: hop.dex, variant: hop.variant, poolId: hop.poolId, reason: 'amount=0' });
            hopOutputs.push(0n); // Track zero output
            timing.endStep(); // End hop_${i}_total
            continue;
          } else {
            throw new Error(`AMOUNT_ZERO: hop ${i} has zero amountInRaw after propagation`);
          }
        }
        
        timing.startStep(`hop_${i}_validation`);
        // Validate amounts before building
        try {
          validateHopAmounts(hop, { traceId, hopIndex: i });
        } catch (validationErr) {
          const mode: any = modeOverride || (execCfg as any)?.mode || 'simulate';
          if (mode !== 'direct') {
            hopIxs.push({ kind: 'placeholder', dex: hop.dex, variant: hop.variant, poolId: hop.poolId, reason: `validation_failed: ${String((validationErr as any)?.message || validationErr)}` });
            hopOutputs.push(0n);
            timing.endStep(); // End hop_${i}_validation
            timing.endStep(); // End hop_${i}_total
            continue;
          } else {
            throw validationErr;
          }
        }
        timing.endStep();

        timing.startStep(`hop_${i}_build_ix`);
        let ixs: any[] = [];
        if (hop.dex === 'raydium' && hop.variant === 'amm') {
          ixs = await buildRaydiumAmmSwapIxReal(hop, timing);
        } else if (hop.dex === 'raydium' && hop.variant === 'clmm') {
          ixs = await buildRaydiumClmmSwapIxReal(hop, timing);
        } else if (hop.dex === 'orca') {
          ixs = await buildOrcaSwapIx(hop, timing) as any[];
        } else if (hop.dex === 'meteora') {
          try { logger.info('tx.build.hop.meteora.real', { cat: 'tx', ctx: { poolId: hop.poolId } as any }); } catch {}
          ixs = await buildMeteoraDlmmSwapIxReal(hop, timing);
        }
        timing.endStep();
        
        hopIxs.push(...ixs);
        
        // Track output amount for next hop (use minOutRaw as conservative estimate)
        // In a real scenario, this would come from quote simulation, but we use minOutRaw as fallback
        hopOutputs.push(hop.minOutRaw && hop.minOutRaw > 0n ? hop.minOutRaw : (hop.amountInRaw || 0n));
        
        // Track this hop's output ATA for chaining to next hop
        prevHopDestAta = hop.userDestAta;
        prevHopOutputMint = hop.outputMint;
        prevHopOutputTokenProgram = hop.outputTokenProgram;
        
        try { logger.info('tx.build.hop.ok', { cat: 'tx', ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId } as any }); } catch {}
        timing.endStep(); // End hop_${i}_total
      } catch (e) {
        timing.endStep(); // Make sure to end any active step
        try { logger.error('tx.build.hop.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId, error: String((e as any)?.message || e) } as any }); } catch {}
        throw e;
      }
    }
    
    timing.startStep('final_assembly');
    if (willUnwrap) {
      hopIxs.push(buildUnwrapSolIx(owner));
    }
    const budget = computeBudgetIxs(cb);
    const all = [...budget, ...extraSetupIxs, ...hopIxs];
    // Calculate actual serialized size instead of fixed estimate
    const sizeBytes = all.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0);
    try {
      const programCounts: Record<string, number> = {};
      for (const it of all) {
        let pid = (it as any)?.programId;
        try { if (pid && typeof pid.toBase58 === 'function') pid = pid.toBase58(); } catch {}
        const key = String(pid || 'unknown');
        programCounts[key] = (programCounts[key] || 0) + 1;
      }
      logger.info('tx.build.detail', { cat: 'tx', ctx: { traceId, ixCount: all.length, programs: programCounts } as any });
    } catch {}
    timing.endStep();

    // Log success with timing breakdown
    const breakdown = timing.getBreakdown();
    try { 
      logger.info('tx.build.ok', { 
        cat: 'tx', 
        code: LogCode.TX_BUILD_OK, 
        ctx: { 
          traceId, 
          ixCount: all.length, 
          sizeBytes,
          ...breakdown
        } as any 
      }); 
    } catch {}
    
    return { tx: { instructions: all, v: 0 }, ixCount: all.length, sizeBytes };
  } catch (error) {
    // Log failure with timing breakdown
    const breakdown = timing.getBreakdown();
    try {
      logger.error('tx.build.failed', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: {
          traceId,
          error: String((error as any)?.message || error),
          stack: (error as any)?.stack,
          ...breakdown
        } as any
      });
    } catch {}
    throw error;
  }
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
  let curBytes = cur.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0);
  const pushCur = () => { txs.push({ instructions: cur, approxSizeBytes: curBytes }); cur = [...base]; curBytes = cur.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0); };
  for (const ix of perHop) {
    const ixSize = estimateInstructionSize(ix);
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
  let curBytes = cur.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0);
  const pushCur = () => { txs.push({ instructions: cur, approxSizeBytes: curBytes }); cur = [...base]; curBytes = cur.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0); };
  for (const ix of perHop) {
    const ixSize = estimateInstructionSize(ix);
    if (curBytes + ixSize > maxBytes && cur.length > base.length) pushCur();
    cur.push(ix);
    curBytes += ixSize;
  }
  if (cur.length > base.length) pushCur();
  const totalBytes = txs.reduce((a, b) => a + b.approxSizeBytes, 0);
  const totalIxs = txs.reduce((a, b) => a + b.instructions.length, 0);
  return { txs, totalIxs, totalBytes };
}


