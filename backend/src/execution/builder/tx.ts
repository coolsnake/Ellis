import type { ExecutionPlan, DirectHop } from '../types.js';
import { buildRaydiumAmmSwapIx, buildRaydiumClmmSwapIx, buildOrcaSwapIx, buildMeteoraDlmmSwapIx, buildRaydiumAmmSwapIxReal, buildRaydiumClmmSwapIxReal, buildMeteoraDlmmSwapIxReal } from './ix.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildCreateAtaIx, deriveAta, isSolMint, buildWrapSolIxs, buildUnwrapSolIx } from '../accounts.js';
import { ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { loadExecConfig } from '../../server/execConfigStore.js';
import { validateHopAmounts } from './validation.js';
import { measureComputeUnits, estimateComputeUnits } from '../utils/computeUnits.js';
import { dexAltManager } from '../utils/altManager.js';
import { getFeeCalculator } from '../../utils/feeCalculator.js';
import { getConnection } from '../../wallet/wallet.js';

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
            // Mark account as used for delayed closing tracking
            try {
              const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
              const manager = getTokenAccountManager(getConnection());
              await manager.markTokenAccountUsed(new PublicKey(hop.userDestAta));
            } catch {}
          }

          if (!isSolMint(hop.inputMint) && hop.userSourceAta && !ensuredAtas.has(hop.userSourceAta)) {
            hopIxs.push(buildCreateAtaIx(owner, payer, new PublicKey(hop.inputMint), hop.inputTokenProgram));
            ensuredAtas.add(hop.userSourceAta);
            // Mark account as used for delayed closing tracking
            try {
              const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
              const manager = getTokenAccountManager(getConnection());
              await manager.markTokenAccountUsed(new PublicKey(hop.userSourceAta));
            } catch {}
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

        // CRITICAL: For multi-hop swaps, ALWAYS use the exact quotedOutputRaw from previous hop
        // This ensures we use the exact amount that will be received, preventing leakage
        const amountPropStart = Date.now();
        if (i > 0) {
          try {
            const prevHop = plan.hops[i - 1];
            
            // Always prefer quotedOutputRaw for multi-hop swaps when available
            if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
              // Use exact quoted output, even if amountInRaw is already set
              // This ensures consistency and prevents using wrong amounts
              const exactAmount = prevHop.quotedOutputRaw;
              if (hop.amountInRaw !== exactAmount) {
                try {
                  logger.info('tx.build.amount_propagation.exact', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_HOP,
                    ctx: {
                      traceId,
                      hopIndex: i,
                      prevHopIndex: i - 1,
                      previousAmount: hop.amountInRaw.toString(),
                      exactAmount: exactAmount.toString(),
                      inputMint: hop.inputMint,
                      outputMint: prevHop.outputMint,
                      prevHopQuotedOutputRaw: exactAmount.toString(),
                    }
                  });
                } catch {}
                // CRITICAL: Set amountInRaw to the exact quotedOutputRaw from previous hop
                // This ensures perfect amount propagation without any rounding errors
                hop.amountInRaw = exactAmount;
              }
              hop.useExactAmount = true; // Flag to prevent re-quote adjustments
              
              // CRITICAL: Verify the amount was set correctly and log if there's any discrepancy
              // This helps catch any code that might be modifying amountInRaw after propagation
              if (hop.amountInRaw !== exactAmount) {
                try {
                  logger.error('tx.build.amount_propagation.verification_failed', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_ERR,
                    ctx: {
                      traceId,
                      hopIndex: i,
                      expectedAmount: exactAmount.toString(),
                      actualAmount: hop.amountInRaw.toString(),
                      difference: (hop.amountInRaw > exactAmount 
                        ? (hop.amountInRaw - exactAmount).toString() 
                        : (exactAmount - hop.amountInRaw).toString()),
                      inputMint: hop.inputMint,
                      outputMint: prevHop.outputMint,
                    }
                  });
                } catch {}
                // Force correct amount even if something tried to modify it
                hop.amountInRaw = exactAmount;
              }
            } else {
              // Fallback: if quotedOutputRaw not available, try other sources
              // CRITICAL: Always try to fix amount for multi-hop swaps, even if amountInRaw is already set
              // This handles cases where quotedOutputRaw might be missing but we still need correct propagation
              const prevOutput = hopOutputs[i - 1];
              let shouldUpdate = false;
              let newAmount: bigint | null = null;
              
              if (prevOutput && prevOutput > 0n) {
                // Use tracked output from previous hop
                newAmount = prevOutput;
                shouldUpdate = (hop.amountInRaw || 0n) <= 0n || hop.amountInRaw !== prevOutput;
              } else if (prevHop?.minOutRaw && prevHop.minOutRaw > 0n) {
                // Fallback to minOutRaw from previous hop
                newAmount = prevHop.minOutRaw;
                shouldUpdate = (hop.amountInRaw || 0n) <= 0n || hop.amountInRaw !== prevHop.minOutRaw;
              }
              
              if (shouldUpdate && newAmount && newAmount > 0n) {
                try {
                  logger.warn('tx.build.amount_propagation.fallback', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_HOP,
                    ctx: {
                      traceId,
                      hopIndex: i,
                      prevHopIndex: i - 1,
                      previousAmount: hop.amountInRaw.toString(),
                      fallbackAmount: newAmount.toString(),
                      reason: 'quotedOutputRaw_unavailable_using_fallback',
                      inputMint: hop.inputMint,
                      outputMint: prevHop.outputMint,
                    }
                  });
                } catch {}
                hop.amountInRaw = newAmount;
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

        // CRITICAL: Final verification before building instructions
        // Ensure amountInRaw hasn't been modified after propagation
        if (i > 0 && hop.useExactAmount) {
          const prevHop = plan.hops[i - 1];
          if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
            const expectedAmount = prevHop.quotedOutputRaw;
            if (hop.amountInRaw !== expectedAmount) {
              try {
                logger.error('tx.build.amount_propagation.pre_build_mismatch', {
                  cat: 'tx',
                  code: LogCode.TX_BUILD_ERR,
                  ctx: {
                    traceId,
                    hopIndex: i,
                    expectedAmount: expectedAmount.toString(),
                    actualAmount: hop.amountInRaw.toString(),
                    difference: (hop.amountInRaw > expectedAmount 
                      ? (hop.amountInRaw - expectedAmount).toString() 
                      : (expectedAmount - hop.amountInRaw).toString()),
                    inputMint: hop.inputMint,
                    outputMint: prevHop.outputMint,
                  }
                });
              } catch {}
              // Force correct amount before building instruction
              hop.amountInRaw = expectedAmount;
            }
          }
        }
        
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
        
        // Track output amount for next hop - use quotedOutputRaw if available, otherwise minOutRaw
        // CRITICAL: Use quotedOutputRaw (exact output) instead of minOutRaw (slippage-adjusted minimum)
        // This ensures the next hop uses the full amount received, not a reduced amount
        const outputForNextHop = hop.quotedOutputRaw && hop.quotedOutputRaw > 0n 
          ? hop.quotedOutputRaw 
          : (hop.minOutRaw && hop.minOutRaw > 0n ? hop.minOutRaw : (hop.amountInRaw || 0n));
        hopOutputs.push(outputForNextHop);
        
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
    const scheduledClosures: Array<{ address: PublicKey; mint: PublicKey }> = [];

    if (willUnwrap) {
      const unwrapIx = buildUnwrapSolIx(owner, true); // Schedule close instead of immediate
      
      // Check if it's a scheduled close
      if (unwrapIx?.type === 'schedule_close_ata') {
        const { PublicKey } = await import('@solana/web3.js');
        scheduledClosures.push({
          address: new PublicKey(unwrapIx.address),
          mint: new PublicKey(unwrapIx.mint),
        });
        // Don't add to instructions - we'll schedule it separately
      } else {
        hopIxs.push(unwrapIx);
      }
    }
    metrics.finalization.unwrap = Date.now() - unwrapStart;
    
    const budgetStart = Date.now();
    
    // Measure compute units if not provided or if dynamic compute is enabled
    let measuredComputeUnits: number | undefined = undefined;
    let dynamicPriorityFee: number | undefined = undefined;
    // Reuse execCfg from earlier in the function (line 161)
    const shouldMeasure = !cb?.computeUnitLimit || (execCfg as any)?.dynamicCompute;
    
    // Calculate dynamic priority fees if enabled
    if ((CONFIG.fees as any)?.dynamicFees || !cb?.computeUnitPriceMicroLamports) {
      try {
        const connection = getConnection();
        const feeCalculator = getFeeCalculator(connection);
        const calculatedFees = await feeCalculator.calculateFees(CONFIG.fees as any);
        
        // Convert priority fee from lamports to micro-lamports for compute budget
        // Priority fee in config is in lamports, but compute budget expects micro-lamports
        dynamicPriorityFee = Math.floor(calculatedFees.priorityFee * 1000);
        
        try {
          logger.info('tx.build.priority.fee.dynamic', {
            cat: 'tx',
            ctx: {
              traceId,
              priorityFeeLamports: calculatedFees.priorityFee,
              priorityFeeMicroLamports: dynamicPriorityFee,
              isDynamic: calculatedFees.isDynamic,
            } as any,
          });
        } catch {}
      } catch (error) {
        try {
          logger.warn('tx.build.priority.fee.error', {
            cat: 'tx',
            ctx: {
              traceId,
              error: String((error as any)?.message || error),
            } as any,
          });
        } catch {}
      }
    }
    
    if (shouldMeasure && hopIxs.length > 0) {
      try {
        // Convert instructions to TransactionInstruction format for measurement
        const realIxs: TransactionInstruction[] = [];
        for (const ix of [...extraSetupIxs, ...hopIxs]) {
          try {
            // Try to convert instruction - this is a simplified version
            // In practice, you'd use the full toInstruction logic
            if (ix && typeof ix === 'object') {
              // For now, we'll estimate based on instruction count
              // Full conversion would require the toInstruction function
            }
          } catch {}
        }
        
        // Collect all accounts from instructions for ALT determination
        const allAccounts: (PublicKey | string)[] = [];
        for (const ix of [...extraSetupIxs, ...hopIxs]) {
          // Handle both array format (TransactionInstruction) and object format (placeholder)
          const keys = (ix as any)?.keys;
          if (Array.isArray(keys)) {
            // Array format: [{ pubkey, isSigner, isWritable }, ...]
            for (const key of keys) {
              const pk = key?.pubkey || key?.publicKey || key;
              if (pk) allAccounts.push(pk);
            }
          } else if (keys && typeof keys === 'object') {
            // Object format: { poolId, tickArrayLower, ... }
            for (const value of Object.values(keys)) {
              if (value && (typeof value === 'string' || value instanceof PublicKey)) {
                allAccounts.push(value);
              }
            }
          }
          // Also check accounts field
          const accounts = (ix as any)?.accounts;
          if (Array.isArray(accounts)) {
            for (const acc of accounts) {
              const pk = acc?.pubkey || acc?.publicKey || acc;
              if (pk) allAccounts.push(pk);
            }
          }
          // Also collect programId
          const programId = (ix as any)?.programId;
          if (programId) {
            allAccounts.push(programId);
          }
        }
        
        // Get ALT addresses for this transaction
        const isMultiHop = plan.hops.length > 1;
        // Lower threshold for CLMM swaps - they always have many accounts
        const hasClmmSwap = plan.hops.some(h => h.dex === 'raydium' && h.variant === 'clmm');
        const shouldUseAlts = isMultiHop || allAccounts.length > 15 || hasClmmSwap;
        const altAddresses = shouldUseAlts 
          ? await dexAltManager.getAltAddresses(allAccounts, isMultiHop || hasClmmSwap)
          : [];
        
        // If we have real instructions, measure them
        if (realIxs.length > 0) {
          measuredComputeUnits = await measureComputeUnits(realIxs, altAddresses);
        } else {
          // Fallback to estimation
          const dexTypes = Array.from(new Set(plan.hops.map(h => h.dex)));
          measuredComputeUnits = estimateComputeUnits(
            hopIxs.length + extraSetupIxs.length,
            isMultiHop,
            dexTypes
          );
        }
        
        try {
          logger.info('tx.build.compute.measured', {
            cat: 'tx',
            ctx: {
              traceId,
              measured: measuredComputeUnits,
              instructionCount: hopIxs.length + extraSetupIxs.length,
              isMultiHop,
            } as any,
          });
        } catch {}
      } catch (error) {
        try {
          logger.warn('tx.build.compute.measure.error', {
            cat: 'tx',
            ctx: {
              traceId,
              error: String((error as any)?.message || error),
            } as any,
          });
        } catch {}
        // Fallback to estimation
        const dexTypes = Array.from(new Set(plan.hops.map(h => h.dex)));
        measuredComputeUnits = estimateComputeUnits(
          hopIxs.length + extraSetupIxs.length,
          plan.hops.length > 1,
          dexTypes
        );
      }
    }
    
    // Use measured compute units if available, otherwise use provided config
    const finalComputeBudget: ComputeBudgetConfig = {
      computeUnitLimit: measuredComputeUnits || cb?.computeUnitLimit,
      computeUnitPriceMicroLamports: dynamicPriorityFee || cb?.computeUnitPriceMicroLamports,
    };
    
    const budget = computeBudgetIxs(finalComputeBudget);
    metrics.finalization.budget = Date.now() - budgetStart;
    
    const all = [...budget, ...extraSetupIxs, ...hopIxs];
    
    const sizeCalcStart = Date.now();
    // Calculate actual serialized size instead of fixed estimate
    const sizeBytes = all.reduce((sum, ix) => sum + estimateInstructionSize(ix), 0);
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
    
    try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { traceId, ms: Date.now() - t0, ixCount: all.length, sizeBytes, computeUnits: finalComputeBudget.computeUnitLimit } as any }); } catch {}
    
    // Collect ALT addresses for the transaction
    const allAccounts: (PublicKey | string)[] = [];
    for (const ix of all) {
      // Handle both array format (TransactionInstruction) and object format (placeholder)
      const keys = (ix as any)?.keys;
      if (Array.isArray(keys)) {
        // Array format: [{ pubkey, isSigner, isWritable }, ...]
        for (const key of keys) {
          const pk = key?.pubkey || key?.publicKey || key;
          if (pk) allAccounts.push(pk);
        }
      } else if (keys && typeof keys === 'object') {
        // Object format: { poolId, tickArrayLower, ... }
        for (const value of Object.values(keys)) {
          if (value && (typeof value === 'string' || value instanceof PublicKey)) {
            allAccounts.push(value);
          }
        }
      }
      // Also check accounts field
      const accounts = (ix as any)?.accounts;
      if (Array.isArray(accounts)) {
        for (const acc of accounts) {
          const pk = acc?.pubkey || acc?.publicKey || acc;
          if (pk) allAccounts.push(pk);
        }
      }
      // Also collect programId
      const programId = (ix as any)?.programId;
      if (programId) {
        allAccounts.push(programId);
      }
    }
    
    const isMultiHop = plan.hops.length > 1;
    // Lower threshold for CLMM swaps - they always have many accounts
    const hasClmmSwap = plan.hops.some(h => h.dex === 'raydium' && h.variant === 'clmm');
    const shouldUseAlts = isMultiHop || allAccounts.length > 15 || hasClmmSwap;
    const altAddresses = shouldUseAlts 
      ? await dexAltManager.getAltAddresses(allAccounts, isMultiHop || hasClmmSwap)
      : [];
    
    // After transaction is built, schedule closures and mark accounts as used:
    if (scheduledClosures.length > 0 || (CONFIG.system as any)?.autoCloseAccounts !== false) {
      try {
        const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
        const manager = getTokenAccountManager(getConnection());
        
        // Schedule closures for accounts that should be closed
        for (const { address, mint } of scheduledClosures) {
          manager.scheduleAccountClosure(address, mint);
        }
        
        // Mark all token accounts used in this transaction (for usage tracking)
        const tokenAccountsUsed = new Set<string>();
        for (const hop of plan.hops) {
          if (hop.userSourceAta && !isSolMint(hop.inputMint)) {
            tokenAccountsUsed.add(hop.userSourceAta);
          }
          if (hop.userDestAta && !isSolMint(hop.outputMint)) {
            tokenAccountsUsed.add(hop.userDestAta);
          }
        }
        
        for (const ataStr of tokenAccountsUsed) {
          try {
            await manager.markTokenAccountUsed(new PublicKey(ataStr));
          } catch {}
        }
        
        try {
          logger.info('tx.build.accounts.scheduled.close', {
            cat: 'tx',
            ctx: {
              traceId,
              scheduledCloseCount: scheduledClosures.length,
              accountsUsedCount: tokenAccountsUsed.size,
            } as any,
          });
        } catch {}
      } catch (error) {
        try {
          logger.warn('tx.build.accounts.schedule.error', {
            cat: 'tx',
            ctx: {
              traceId,
              error: String((error as any)?.message || error),
            } as any,
          });
        } catch {}
      }
    }

    return { 
      tx: { 
        instructions: all, 
        v: 0,
        lookupTableAddresses: altAddresses, // Include ALT addresses
      }, 
      ixCount: all.length, 
      sizeBytes 
    };
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


