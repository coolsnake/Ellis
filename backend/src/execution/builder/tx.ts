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

// Add timing metrics interface
interface TimingMetrics {
  total: number;
  setup: {
    wallet: number;
    config: number;
    total: number;
  };
  hops: Array<{
    index: number;
    dex: string;
    variant: string;
    poolId: string;
    accountPrep: number;
    amountPropagation: number;
    validation: number;
    instructionBuilding: number;
    total: number;
  }>;
  finalization: {
    unwrap: number;
    budget: number;
    sizeCalculation: number;
    total: number;
  };
}

// Helper function to create timing summary
function logTimingMetrics(
  metrics: TimingMetrics,
  traceId: string,
  success: boolean,
  error?: string,
  additionalCtx?: Record<string, any>
): void {
  try {
    const summary = {
      traceId,
      success,
      timing: {
        total: metrics.total,
        setup: metrics.setup,
        hops: metrics.hops,
        finalization: metrics.finalization,
      },
      ...(error && { error }),
      ...additionalCtx,
    };

    if (success) {
      logger.info('tx.build.timing', {
        cat: 'tx',
        code: LogCode.TX_BUILD_OK,
        ctx: summary as any,
      });
    } else {
      logger.error('tx.build.timing', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: summary as any,
      });
    }
  } catch {}
}

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

/**
 * Estimates the full serialized size of a VersionedTransaction
 * This includes transaction overhead (signatures, header, lookup tables, etc.)
 */
function estimateVersionedTransactionSize(instructions: any[], lookupTableCount = 0): number {
  try {
    // Base transaction overhead:
    // - Version byte: 1
    // - Signature count (u8): 1
    // - Signatures: 64 bytes each (typically 1)
    // - Message header overhead: ~20 bytes
    let size = 1 + 1 + 64 + 20;
    
    // Lookup table addresses: 32 bytes each
    size += lookupTableCount * 32;
    
    // Instruction count: 1 byte
    size += 1;
    
    // Account keys count: 2 bytes (u16)
    // For v0 transactions with lookup tables, accounts are compressed
    // Estimate: ~2 bytes per account (index) vs 33 bytes (full key)
    // We'll use a conservative estimate assuming some compression
    const totalAccounts = new Set<string>();
    for (const ix of instructions) {
      const keys = ix?.keys || ix?.accounts || [];
      for (const key of keys) {
        const pk = key?.pubkey || key;
        if (pk) {
          const addr = typeof pk.toBase58 === 'function' ? pk.toBase58() : String(pk);
          totalAccounts.add(addr);
        }
      }
    }
    // With lookup tables: ~2 bytes per account (index) + overhead
    // Without: ~33 bytes per account
    // Use conservative estimate: assume 50% compression with lookup tables
    const accountSize = lookupTableCount > 0 ? Math.max(2, 33 * 0.5) : 33;
    size += 2 + (totalAccounts.size * accountSize);
    
    // Instructions: each instruction has overhead
    for (const ix of instructions) {
      // Program ID index: 1 byte (if in lookup table) or 2 bytes (u16 for account index)
      size += lookupTableCount > 0 ? 1 : 2;
      // Account indices: 1 byte each (u8)
      const keys = ix?.keys || ix?.accounts || [];
      size += keys.length;
      // Data length: 2 bytes (u16) + data
      const data = ix?.data;
      let dataLen = 0;
      if (data) {
        if (Buffer.isBuffer(data)) {
          dataLen = data.length;
        } else if (data instanceof Uint8Array) {
          dataLen = data.length;
        } else if (Array.isArray(data)) {
          dataLen = data.length;
        } else if (typeof data === 'string') {
          dataLen = Buffer.from(data, 'base64').length;
        }
      }
      size += 2 + dataLen;
    }
    
    return size;
  } catch {
    // Fallback: use instruction-based estimate with 2x multiplier for overhead
    return instructions.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0) * 2;
  }
}

export async function buildDirectArbTx(plan: ExecutionPlan, extraSetupIxs: any[], cb?: ComputeBudgetConfig): Promise<{ tx: any; ixCount: number; sizeBytes: number }> {
  const t0 = Date.now();
  const traceId = Math.random().toString(36).slice(2, 10);
  
  // Initialize timing metrics
  const metrics: TimingMetrics = {
    total: 0,
    setup: {
      wallet: 0,
      config: 0,
      total: 0,
    },
    hops: [],
    finalization: {
      unwrap: 0,
      budget: 0,
      sizeCalculation: 0,
      total: 0,
    },
  };

  const setupStart = Date.now();
  
  // Build per-hop placeholders
  const hopIxs: any[] = [];
  
  // Time wallet initialization
  const walletStart = Date.now();
  const owner = (await ensureWallet(CONFIG.walletPath)).publicKey;
  metrics.setup.wallet = Date.now() - walletStart;
  
  // Time config loading
  const configStart = Date.now();
  const execCfg = await loadExecConfig().catch(() => ({ createAtasInTx: true, wrapSolInTx: true } as any));
  metrics.setup.config = Date.now() - configStart;
  
  metrics.setup.total = Date.now() - setupStart;
  
  const modeOverride: 'direct' | 'simulate' | undefined = (cb as any)?.__modeOverride;
  let performedWrap = false;
  let willUnwrap = false;
  
  // Track actual output amounts from previous hops (for amount propagation)
  const hopOutputs: bigint[] = [];
  const ensuredAtas = new Set<string>();
  let prevHopDestAta: string | undefined = undefined;
  let prevHopOutputMint: string | undefined = undefined;
  let prevHopOutputTokenProgram: string | undefined = undefined;
  
  try {
    for (let i = 0; i < plan.hops.length; i++) {
      const hopStart = Date.now();
      const hopMetrics = {
        index: i,
        dex: '',
        variant: '',
        poolId: '',
        accountPrep: 0,
        amountPropagation: 0,
        validation: 0,
        instructionBuilding: 0,
        total: 0,
      };
      
      // Create a working copy of the hop to avoid mutating the original
      const hop: DirectHop = { ...plan.hops[i] };
      hopMetrics.dex = hop.dex || '';
      hopMetrics.variant = hop.variant || '';
      hopMetrics.poolId = hop.poolId || '';
      
      try { logger.debug('tx.build.hop', { cat: 'tx', code: LogCode.TX_BUILD_HOP, ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId } as any }); } catch {}
      try {
        logger.info('tx.build.hop.start', { cat: 'tx', ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId, inputMint: hop.inputMint, outputMint: hop.outputMint, amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n), userSourceAta: hop.userSourceAta ? 'set' : 'missing', userDestAta: hop.userDestAta ? 'set' : 'missing' } as any });
      } catch {}
      try {
        // --- Pre-hop account prep: ATAs and optional SOL wrapping ---
        const accountPrepStart = Date.now();
        
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
        
        hopMetrics.accountPrep = Date.now() - accountPrepStart;

        // Defensive amount propagation fallback: if later hop is zero, try to use previous hop's output
        // For multihop: prefer exact quoted output from previous hop to ensure no amount leakage
        const amountPropStart = Date.now();
        if ((hop.amountInRaw || 0n) <= 0n && i > 0) {
          try {
            const prevHop = plan.hops[i - 1];
            
            // CRITICAL: For multihop, use the exact quoted output from previous hop
            // This ensures we use the exact amount that will be received, preventing leakage
            if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
              hop.amountInRaw = prevHop.quotedOutputRaw;
              hop.useExactAmount = true; // Flag to prevent re-quote adjustments
              try {
                logger.info('tx.build.amount_propagation.exact', {
                  cat: 'tx',
                  code: LogCode.TX_BUILD_HOP,
                  ctx: {
                    traceId,
                    hopIndex: i,
                    prevHopIndex: i - 1,
                    exactAmount: prevHop.quotedOutputRaw.toString(),
                    inputMint: hop.inputMint,
                    outputMint: prevHop.outputMint,
                  }
                });
              } catch {}
            } else {
              // Fallback: prefer actual output from previous hop if tracked
              const prevOutput = hopOutputs[i - 1];
              if (prevOutput && prevOutput > 0n) {
                hop.amountInRaw = prevOutput;
              } else {
                // Final fallback to minOutRaw from previous hop
                const candidate: bigint = (prevHop?.minOutRaw && prevHop.minOutRaw > 0n) ? prevHop.minOutRaw : (prevHop?.amountInRaw || 0n);
                if (candidate > 0n) {
                  hop.amountInRaw = candidate;
                }
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
        } else if (i > 0 && hop.amountInRaw > 0n) {
          // Even if amountInRaw is already set, verify it matches previous hop's exact output
          // This ensures consistency between resolution and instruction building
          const prevHop = plan.hops[i - 1];
          if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
            if (hop.amountInRaw !== prevHop.quotedOutputRaw) {
              try {
                logger.warn('tx.build.amount.mismatch', {
                  cat: 'tx',
                  code: LogCode.TX_BUILD_ERR,
                  ctx: {
                    traceId,
                    hopIndex: i,
                    prevHopIndex: i - 1,
                    currentAmount: hop.amountInRaw.toString(),
                    expectedExactAmount: prevHop.quotedOutputRaw.toString(),
                    difference: (hop.amountInRaw - prevHop.quotedOutputRaw).toString(),
                    inputMint: hop.inputMint,
                  }
                });
              } catch {}
              // Use the exact amount from previous hop for consistency
              hop.amountInRaw = prevHop.quotedOutputRaw;
              hop.useExactAmount = true;
            } else {
              // Amounts match - mark as exact to prevent adjustments
              hop.useExactAmount = true;
            }
          }
        }
        hopMetrics.amountPropagation = Date.now() - amountPropStart;

        // Guard: if amount is still zero, avoid invoking real SDK builders
        // - In simulate mode, insert a non-executable placeholder (no programId) so assembly skips it
        // - In direct mode, fail fast with a descriptive error
        if ((hop.amountInRaw || 0n) <= 0n) {
          const mode: any = modeOverride || (execCfg as any)?.mode || 'simulate';
          if (mode !== 'direct') {
            hopIxs.push({ kind: 'placeholder', dex: hop.dex, variant: hop.variant, poolId: hop.poolId, reason: 'amount=0' });
            hopOutputs.push(0n); // Track zero output
            hopMetrics.total = Date.now() - hopStart;
            metrics.hops.push(hopMetrics);
            continue;
          } else {
            throw new Error(`AMOUNT_ZERO: hop ${i} has zero amountInRaw after propagation`);
          }
        }
        
        // Validate amounts before building
        const validationStart = Date.now();
        try {
          validateHopAmounts(hop, { traceId, hopIndex: i });
        } catch (validationErr) {
          const mode: any = modeOverride || (execCfg as any)?.mode || 'simulate';
          if (mode !== 'direct') {
            hopIxs.push({ kind: 'placeholder', dex: hop.dex, variant: hop.variant, poolId: hop.poolId, reason: `validation_failed: ${String((validationErr as any)?.message || validationErr)}` });
            hopOutputs.push(0n);
            hopMetrics.validation = Date.now() - validationStart;
            hopMetrics.total = Date.now() - hopStart;
            metrics.hops.push(hopMetrics);
            continue;
          } else {
            throw validationErr;
          }
        }
        hopMetrics.validation = Date.now() - validationStart;

        // Build instructions
        const instructionStart = Date.now();
        let ixs: any[] = [];
        if (hop.dex === 'raydium' && hop.variant === 'amm') {
          ixs = await buildRaydiumAmmSwapIxReal(hop);
        } else if (hop.dex === 'raydium' && hop.variant === 'clmm') {
          ixs = await buildRaydiumClmmSwapIxReal(hop);
        } else if (hop.dex === 'orca') {
          ixs = await buildOrcaSwapIx(hop) as any[];
        } else if (hop.dex === 'meteora') {
          try { logger.info('tx.build.hop.meteora.real', { cat: 'tx', ctx: { poolId: hop.poolId } as any }); } catch {}
          ixs = await buildMeteoraDlmmSwapIxReal(hop);
        }
        hopMetrics.instructionBuilding = Date.now() - instructionStart;
        
        hopIxs.push(...ixs);
        
        // Track output amount for next hop (use minOutRaw as conservative estimate)
        // In a real scenario, this would come from quote simulation, but we use minOutRaw as fallback
        hopOutputs.push(hop.minOutRaw && hop.minOutRaw > 0n ? hop.minOutRaw : (hop.amountInRaw || 0n));
        
        // Track this hop's output ATA for chaining to next hop
        prevHopDestAta = hop.userDestAta;
        prevHopOutputMint = hop.outputMint;
        prevHopOutputTokenProgram = hop.outputTokenProgram;
        
        hopMetrics.total = Date.now() - hopStart;
        metrics.hops.push(hopMetrics);
        
        try { logger.info('tx.build.hop.ok', { cat: 'tx', ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId } as any }); } catch {}
      } catch (e) {
        hopMetrics.total = Date.now() - hopStart;
        metrics.hops.push(hopMetrics);
        try { logger.error('tx.build.hop.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { traceId, dex: hop.dex, variant: hop.variant, poolId: hop.poolId, error: String((e as any)?.message || e) } as any }); } catch {}
        throw e;
      }
    }
    
    // Finalization phase
    const finalizationStart = Date.now();
    
    const unwrapStart = Date.now();
    if (willUnwrap) {
      hopIxs.push(buildUnwrapSolIx(owner));
    }
    metrics.finalization.unwrap = Date.now() - unwrapStart;
    
    const budgetStart = Date.now();
    const budget = computeBudgetIxs(cb);
    metrics.finalization.budget = Date.now() - budgetStart;
    
    const all = [...budget, ...extraSetupIxs, ...hopIxs];
    
    const sizeCalcStart = Date.now();
    // Calculate estimated serialized size for VersionedTransaction
    // Note: This is an estimate; actual size may vary due to lookup table compression
    const estimatedSizeBytes = estimateVersionedTransactionSize(all, 0); // Conservative: assume no lookup tables
    const sizeBytes = estimatedSizeBytes;
    metrics.finalization.sizeCalculation = Date.now() - sizeCalcStart;
    
    metrics.finalization.total = Date.now() - finalizationStart;
    
    // Calculate total time
    metrics.total = Date.now() - t0;
    
    // Log detailed metrics
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
    
    // Log success with timing metrics
    logTimingMetrics(metrics, traceId, true, undefined, {
      ixCount: all.length,
      sizeBytes,
    });
    
    try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { traceId, ms: Date.now() - t0, ixCount: all.length, sizeBytes } as any }); } catch {}
    return { tx: { instructions: all, v: 0 }, ixCount: all.length, sizeBytes };
  } catch (error) {
    // Calculate total time even on error
    metrics.total = Date.now() - t0;
    
    // Log failure with timing metrics
    const errorMsg = String((error as any)?.message || error);
    logTimingMetrics(metrics, traceId, false, errorMsg, {
      error: errorMsg,
    });
    
    try { logger.error('tx.build.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { traceId, error: errorMsg, ms: Date.now() - t0 } as any }); } catch {}
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


