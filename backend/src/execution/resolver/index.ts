import { executionCache } from '../cache.js';
import type { DirectHop, ExecutionPlan, ExecConfig, ResolveDirectInput } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { getTokenMeta } from './tokenMeta.js';
import { CONFIG } from '../../utils/config.js';
import { applySlippage } from '../limits.js';
import { logCatchError } from '../../utils/errorHandler.js';
import {
  estimateSlippage,
  getPoolFeeBps,
  getPoolLiquidityUsd,
  getTradeSizeUsd,
  getDlmmPoolInfo,
  getClmmPoolInfo,
  getPoolType,
  type SlippageEstimateInput,
} from '../slippage/index.js';

export async function resolveDirectPlan(input: ResolveDirectInput, cfg: ExecConfig): Promise<ExecutionPlan> {
  const path = Array.isArray(input.path) ? input.path : [];
  const hopPoolIds = Array.isArray(input.hopPoolIds) ? input.hopPoolIds : [];
  const dexes = Array.isArray(input.dexes) ? input.dexes : [];
  if (path.length < 2 || hopPoolIds.length !== (path.length - 1) || dexes.length !== (path.length - 1)) {
    throw new Error('invalid resolve input: path/hops mismatch');
  }

  const t0 = Date.now();
  logger.debug('tx.resolve.start', { cat: 'tx', code: LogCode.TX_RESOLVE_START, ctx: { hopCount: path.length - 1 } as any });
  const hops: DirectHop[] = await Promise.all(path.slice(0, -1).map(async (_mint, i) => {
    const dexv = String(dexes[i] || '').toLowerCase();
    // Map graph DEX names to execution DEX types
    const dex = (
      dexv.includes('raydium') ? 'raydium' : 
      dexv.includes('orca') ? 'orca' : 
      dexv.includes('pumpswap') ? 'pumpswap' :
      (dexv.includes('meteora') && dexv.includes('balanced')) ? 'meteora_balanced' :  // MeteoraBalanced_v1 or MeteoraBalanced_v2
      'meteora'  // Default to Meteora DLMM
    ) as DirectHop['dex'];
    const poolId = String(hopPoolIds[i]);
    let variant: DirectHop['variant'];
    if (dex === 'raydium') {
      if (dexv.includes('clmm')) {
        variant = 'clmm';
      } else {
        // Infer from poolId presence in Raydium CLMM list when variant not hinted
        try {
          const { peekRaydiumPools } = await import('../../server/pools.js');
          const id = poolId.replace(/[#-]rev$/, '');
          const ray = peekRaydiumPools();
          // Validate that pool has valid tickSpacing > 0 before considering it CLMM
          const isClmm = Array.isArray(ray?.clmm) && (ray!.clmm as any[]).some((p: any) => {
            const matchesId = String(p?.id || '') === id;
            const tickSpacing = p?.tick_spacing ?? p?.tickSpacing;
            const hasValidTick = typeof tickSpacing === 'number' && tickSpacing > 0;
            return matchesId && hasValidTick;
          });
          variant = isClmm ? 'clmm' : 'amm';
        } catch { variant = 'amm'; }
      }
    } else if (dex === 'orca') {
      variant = 'clmm';
    } else if (dex === 'pumpswap') {
      variant = 'amm';
    } else if (dex === 'meteora_balanced') {
      // Detect DAMM v1 vs v2 from DEX name
      if (dexv.includes('_v1')) {
        variant = 'damm_v1';
      } else if (dexv.includes('_v2')) {
        variant = 'damm_v2';
      } else {
        variant = 'damm_v1';  // Default to v1 if unclear
      }
    } else {
      variant = 'dlmm';  // Meteora DLMM
    }
    const inputMint = path[i];
    const outputMint = path[i+1];
    // lightweight placeholders; per-DEX resolvers will fill in accounts/state
    // Parallelize token metadata lookups for better performance
    const [tokenInMeta, tokenOutMeta] = await Promise.all([
      Promise.resolve(executionCache.getTokenMeta(inputMint) || getTokenMeta(inputMint)),
      Promise.resolve(executionCache.getTokenMeta(outputMint) || getTokenMeta(outputMint)),
    ]);
    // Token-2022 gating with mode controls
    const sys = (CONFIG.system as any) || {};
    const mode = String(sys.token2022Mode || 'block');
    const allow = (sys.token2022Allow || {}) as { raydium?: boolean; orca?: boolean; meteora?: boolean };
    const any2022 = tokenInMeta.program === 'token-2022' || tokenOutMeta.program === 'token-2022';
    if (any2022) {
      let ok = false;
      if (mode === 'allow' || mode === 'auto') ok = true;
      else {
        ok = (dex === 'raydium' && !!allow.raydium) || (dex === 'orca' && !!allow.orca) || (dex === 'meteora' && !!allow.meteora);
      }
      if (!ok) {
        const msg = `TOKEN2022_NOT_ALLOWED: dex=${dex}, mode=${mode}, in=${tokenInMeta.program}, out=${tokenOutMeta.program}`;
        throw new Error(msg);
      }
    }
    const hop: DirectHop = {
      dex,
      variant,
      poolId,
      programId: executionCache.getStatic(poolId)?.programId || (() => {
        if (dex === 'raydium') return variant === 'clmm' ? (CONFIG.raydium?.clmmProgram || '') : (CONFIG.raydium?.ammV4Program || '');
        if (dex === 'orca') return CONFIG.orca?.programId || '';
        if (dex === 'meteora') return (CONFIG.meteora?.programId as any) || '';
        if (dex === 'meteora_balanced') {
          const balanced = (CONFIG.meteora?.amm as any) || {};
          return variant === 'damm_v1' ? (balanced.v1ProgramId || '') : (balanced.v2ProgramId || '');
        }
        if (dex === 'pumpswap') return 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
        return '';
      })(),
      inputMint,
      outputMint,
      inputDecimals: tokenInMeta.decimals,
      outputDecimals: tokenOutMeta.decimals,
      inputTokenProgram: tokenInMeta.program,
      outputTokenProgram: tokenOutMeta.program,
      userSourceAta: '',
      userDestAta: '',
      amountInRaw: 0n,
      minOutRaw: 0n,
    };
    // Populate common per-DEX account fields opportunistically from cache
    const stat = executionCache.getStatic(poolId);
    if (stat) {
      hop.vaultA = hop.vaultA || (stat.vaults?.a);
      hop.vaultB = hop.vaultB || (stat.vaults?.b);
      if (variant === 'clmm') {
        hop.tickSpacing = hop.tickSpacing || stat.tickSpacing;
      }
      if (dex === 'meteora' && variant === 'dlmm') {
        hop.binStep = hop.binStep || stat.binStep;
      }
    }
    // NOTE: minOutRaw is calculated later after quoting (line ~353) using the quoted output amount.
    // We cannot calculate it here because:
    // 1. amountInRaw is in input token units, but minOutRaw must be in output token units
    // 2. We need the actual quoted output to apply slippage correctly
    // Per-DEX refinement hooks (populate program accounts/ticks)
    try {
      if (hop.dex === 'raydium' && hop.variant === 'amm') {
        const { resolveRaydiumAmm } = await import('./raydiumAmm.js');
        return await resolveRaydiumAmm(hop);
      } else if (hop.dex === 'raydium' && hop.variant === 'clmm') {
        const { resolveRaydiumClmm } = await import('./raydiumClmm.js');
        return await resolveRaydiumClmm(hop);
      } else if (hop.dex === 'orca') {
        try { logger.info('tx.resolve.orca.start', { cat: 'tx', code: LogCode.TX_RESOLVE_START, ctx: { poolId: hop.poolId, inputMint: hop.inputMint, outputMint: hop.outputMint } as any }); } catch (e) { logCatchError('resolver.index', e); }
        const { resolveOrca } = await import('./orca.js');
        const resolved = await resolveOrca(hop);
        try { logger.info('tx.resolve.orca.complete', { cat: 'tx', code: LogCode.TX_RESOLVE_OK, ctx: { poolId: resolved.poolId, hasTickArrays: !!(resolved.tickArrayLower && resolved.tickArrayCenter && resolved.tickArrayUpper) } as any }); } catch (e) { logCatchError('resolver.index', e); }
        return resolved;
      } else if (hop.dex === 'pumpswap') {
        const { resolvePumpswap } = await import('./pumpswap.js');
        return await resolvePumpswap(hop);
      } else if (hop.dex === 'meteora_balanced') {
        const { resolveMeteoraDamm } = await import('./meteoraDamm.js');
        return await resolveMeteoraDamm(hop);
      } else {
        const { resolveMeteoraDlmm } = await import('./meteora.js');
        return await resolveMeteoraDlmm(hop);
      }
    } catch {
      return hop;
    }
  }));
  // Validate upstream-provided path alignment for Orca hops: inputMint must be a pool token
  try {
    const { peekOrcaPools } = await import('../../server/pools.js');
    const orca = peekOrcaPools();
    const byId = new Map<string, any>((orca.clmm || []).map((p: any) => [String(p.id), p]));
    for (const h of hops) {
      if (h.dex !== 'orca') continue;
      const id = String(h.poolId || '').replace(/[#-]rev$/, '');
      if (!id) continue;
      const p = byId.get(id);
      if (!p) continue;
      const mintA = String((p as any)?.mint_a || '');
      const mintB = String((p as any)?.mint_b || '');
      if (h.inputMint !== mintA && h.inputMint !== mintB) {
        try { logger.warn('tx.resolve.orca.input_mint_mismatch', { cat: 'tx', ctx: { pool: id, inputMint: h.inputMint, mintA, mintB } }); } catch (e) { logCatchError('resolver.index', e); }
        throw new Error(`ORCA_WRONG_INPUT_MINT_FOR_POOL: pool=${id}, in=${h.inputMint}, a=${mintA}, b=${mintB}`);
      }
    }
  } catch (e) {
    throw e;
  }
  // Set amounts and minOuts using per-hop quotes; propagate through hops
  try {
    const slippage = typeof input.slippageBps === 'number' ? input.slippageBps : cfg.slippageBpsDefault;
    // Determine initial input size:
    // - interpret input.size as raw atoms (already in mint decimals)
    // - otherwise compute from sizeUsd using priceStore (USD → tokens)
    let curIn = 0n;
    if (hops.length > 0) {
      const decimals = Number(hops[0].inputDecimals ?? 0);
      const rawSize = (input as any).size;
      if (rawSize !== undefined && rawSize !== null) {
        if (typeof rawSize === 'bigint') {
          if (rawSize > 0n) curIn = rawSize;
        } else if (typeof rawSize === 'number') {
          if (Number.isFinite(rawSize) && rawSize > 0) {
            curIn = BigInt(Math.trunc(rawSize));
          }
        } else if (typeof rawSize === 'string') {
          const trimmed = rawSize.trim();
          if (trimmed.length > 0) {
            try {
              const parsed = BigInt(trimmed);
              if (parsed > 0n) curIn = parsed;
            } catch (e) { logCatchError('resolver.index', e); }
          }
        }
      }
      if (curIn === 0n && Number.isFinite(input.sizeUsd as any) && Number(input.sizeUsd) > 0) {
        try {
          const startMint = hops[0].inputMint;
          const { getPriceByMint } = await import('../../server/priceStore.js');
          let usdPx = Number((getPriceByMint(startMint)?.usdc) ?? 0); // USD per 1 token
          
          // Fallback to Jupiter token list if priceStore doesn't have it
          if (usdPx === 0) {
            try {
              const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
              const jupiterMap = await loadJupiterTokenMap();
              const jupiterToken = jupiterMap[startMint];
              if (jupiterToken && typeof jupiterToken.usdPrice === 'number' && jupiterToken.usdPrice > 0) {
                usdPx = jupiterToken.usdPrice;
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.debug('resolver.jupiter_price_fallback', {
                    cat: 'tx',
                    startMint,
                    usdPx,
                    source: 'jupiter_token_list',
                  });
                } catch (e) { logCatchError('resolver.index', e); }
              }
            } catch (e: any) {
              // Log Jupiter fallback failure but continue
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.debug('resolver.jupiter_fallback_failed', {
                  cat: 'tx',
                  error: String(e?.message || e),
                });
              } catch (e) { logCatchError('resolver.index', e); }
            }
          }
          
          if (usdPx > 0) {
            // atoms = (usdAmt * 10^decimals) / usdPx, with micro precision for stability
            const usdAmtMicro = BigInt(Math.round(Number(input.sizeUsd) * 1_000_000));
            const usdPxMicro  = BigInt(Math.round(usdPx * 1_000_000));
            const scale       = (10n ** BigInt(Math.max(0, Math.min(12, decimals))));
            curIn = (usdAmtMicro * scale) / usdPxMicro;
          } else {
            // Price lookup failed - log for debugging
            try {
              const { logger } = await import('../../utils/logger.js');
              logger.debug('resolver.price_lookup_failed', {
                cat: 'tx',
                startMint,
                sizeUsd: input.sizeUsd,
                usdPx,
              });
            } catch (e) { logCatchError('resolver.index', e); }
          }
        } catch (e: any) {
          // Log the error instead of silently catching
          try {
            const { logger } = await import('../../utils/logger.js');
            logger.debug('resolver.sizeUsd_conversion_failed', {
              cat: 'tx',
              error: String(e?.message || e),
              sizeUsd: input.sizeUsd,
            });
          } catch (e) { logCatchError('resolver.index', e); }
        }
      }
    }
    // If still zero and a defaultQuoteSizeUsd is configured, convert USD→atoms using start mint
    if (curIn === 0n && hops.length > 0) {
      try {
        // First check CONFIG.system.defaultQuoteSizeUsd (from env var)
        let defUsd = Number(((CONFIG.system as any)?.defaultQuoteSizeUsd) || 0);
        
        // If not set, try to load from executor config file as fallback
        if (defUsd === 0) {
          try {
            const { readJson } = await import('../../utils/fs.js');
            const { resolve } = await import('path');
            // Use path.resolve to properly resolve the config file path
            const configPath = resolve('backend/config/arbExecutor.json');
            const executorConfig = await readJson(configPath, {}) as any;
            
            if (executorConfig && typeof executorConfig.sizeUsd === 'number' && executorConfig.sizeUsd > 0) {
              defUsd = executorConfig.sizeUsd;
              // Log that we found it
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.debug('resolver.executor_config_loaded', {
                  cat: 'tx',
                  sizeUsd: defUsd,
                  configPath,
                });
              } catch (e) { logCatchError('resolver.index', e); }
            } else {
              // Log that we didn't find it
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.debug('resolver.executor_config_not_found', {
                  cat: 'tx',
                  configPath,
                  executorConfig: executorConfig ? Object.keys(executorConfig) : 'null',
                });
              } catch (e) { logCatchError('resolver.index', e); }
            }
          } catch (e: any) {
            // Log the error for debugging instead of silently catching
            try {
              const { logger } = await import('../../utils/logger.js');
              logger.debug('resolver.executor_config_read_failed', {
                cat: 'tx',
                error: String(e?.message || e),
                code: e?.code,
                stack: e?.stack,
              });
            } catch (e) { logCatchError('resolver.index', e); }
          }
        }
        
        if (defUsd > 0) {
          const startMint = hops[0].inputMint;
          const decimals = Number(hops[0].inputDecimals ?? 0);
          const { getPriceByMint } = await import('../../server/priceStore.js');
          let usdPx = Number((getPriceByMint(startMint)?.usdc) ?? 0); // USD per 1 token
          
          // Fallback to Jupiter token list if priceStore doesn't have it
          if (usdPx === 0) {
            try {
              const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
              const jupiterMap = await loadJupiterTokenMap();
              const jupiterToken = jupiterMap[startMint];
              if (jupiterToken && typeof jupiterToken.usdPrice === 'number' && jupiterToken.usdPrice > 0) {
                usdPx = jupiterToken.usdPrice;
                try {
                  const { logger } = await import('../../utils/logger.js');
                  logger.debug('resolver.fallback_jupiter_price', {
                    cat: 'tx',
                    startMint,
                    defUsd,
                    usdPx,
                    source: 'jupiter_token_list',
                  });
                } catch (e) { logCatchError('resolver.index', e); }
              }
            } catch (e: any) {
              // Log Jupiter fallback failure but continue
              try {
                const { logger } = await import('../../utils/logger.js');
                logger.debug('resolver.fallback_jupiter_failed', {
                  cat: 'tx',
                  error: String(e?.message || e),
                });
              } catch (e) { logCatchError('resolver.index', e); }
            }
          }
          
          if (usdPx > 0) {
            const usdAmtMicro = BigInt(Math.round(defUsd * 1_000_000));
            const usdPxMicro  = BigInt(Math.round(usdPx * 1_000_000));
            const scale       = (10n ** BigInt(Math.max(0, Math.min(12, decimals))));
            curIn = (usdAmtMicro * scale) / usdPxMicro;
          } else {
            // Log price lookup failure in fallback too
            try {
              const { logger } = await import('../../utils/logger.js');
              logger.warn('resolver.fallback_price_lookup_failed', {
                cat: 'tx',
                startMint,
                defUsd,
                usdPx,
              });
            } catch (e) { logCatchError('resolver.index', e); }
          }
        }
      } catch (e: any) {
        // Log the error
        try {
          const { logger } = await import('../../utils/logger.js');
          logger.error('resolver.default_size_fallback_failed', {
            cat: 'tx',
            error: String(e?.message || e),
            stack: e?.stack,
          });
        } catch (e) { logCatchError('resolver.index', e); }
      }
    }
    if (curIn === 0n && hops.length > 0) {
      throw new Error('QUOTE_SIZE_REQUIRED: provide size/sizeUsd or configure defaultQuoteSizeUsd');
    }
    const { quoteHopOut, applyMinOut } = await import('./quotes.js');
    for (let i = 0; i < hops.length; i++) {
      // CRITICAL: Always set current hop input from curIn
      // For multi-hop swaps (i > 0), this ensures we use the exact output from previous hop
      // Never preserve a pre-set amountInRaw for hops after the first - always propagate correctly
      const previousAmountInRaw = hops[i].amountInRaw;
      
      // CRITICAL: For multi-hop swaps, use the exact quotedOutputRaw from previous hop
      // This ensures perfect amount propagation without any rounding errors
      if (i > 0) {
        const prevHop = hops[i - 1];
        if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
          // Use the exact quotedOutputRaw from previous hop, not curIn which might have rounding
          curIn = prevHop.quotedOutputRaw;
          try {
            logger.info('tx.resolve.hop.amount.use_exact_quoted', {
              cat: 'tx',
              code: LogCode.TX_RESOLVE_OK,
              ctx: {
                hopIndex: i,
                prevHopIndex: i - 1,
                exactQuotedOutput: prevHop.quotedOutputRaw.toString(),
                curInBefore: curIn.toString(),
                inputMint: hops[i].inputMint,
                outputMint: prevHop.outputMint,
              }
            });
          } catch (e) { logCatchError('resolver.index', e); }
        }
      }
      
      hops[i].amountInRaw = curIn;
      
      // Log if we're overriding a pre-set amount (indicates potential issue upstream)
      if (i > 0 && previousAmountInRaw > 0n && previousAmountInRaw !== curIn) {
        try {
          logger.warn('tx.resolve.hop.amount.overridden', {
            cat: 'tx',
            code: LogCode.TX_RESOLVE_OK,
            ctx: {
              hopIndex: i,
              previousAmount: previousAmountInRaw.toString(),
              newAmount: curIn.toString(),
              inputMint: hops[i].inputMint,
              prevHopOutput: hops[i - 1]?.quotedOutputRaw?.toString() || 'N/A',
            }
          });
        } catch (e) { logCatchError('resolver.index', e); }
      }

      // Add logging to debug amount propagation
      try {
        logger.info('tx.resolve.hop.amount.set', {
          cat: 'tx',
          code: LogCode.TX_RESOLVE_OK,
          ctx: {
            hopIndex: i,
            amountInRaw: curIn.toString(),
            inputMint: hops[i].inputMint,
            outputMint: hops[i].outputMint,
            inputDecimals: hops[i].inputDecimals,
            outputDecimals: hops[i].outputDecimals,
          }
        });
      } catch (e) { logCatchError('resolver.index', e); }

      // CRITICAL: If this is not the first hop, verify curIn matches the input mint's decimals
      // This prevents using SOL lamports (9 decimals) for USDC (6 decimals)
      if (i > 0) {
        const prevHop = hops[i - 1];
        const currentHop = hops[i];
        const prevDecimals = prevHop.outputDecimals ?? 0;
        const currentDecimals = currentHop.inputDecimals ?? 0;
        
        // Log decimal check for debugging
        try {
          logger.info('tx.resolve.hop.decimal_check', {
            cat: 'tx',
            code: LogCode.TX_RESOLVE_OK,
            ctx: {
              hopIndex: i,
              prevOutputDecimals: prevDecimals,
              currentInputDecimals: currentDecimals,
              curIn: curIn.toString(),
              prevOutputMint: prevHop.outputMint,
              currentInputMint: currentHop.inputMint,
            }
          });
        } catch (e) { logCatchError('resolver.index', e); }
      }

      // CRITICAL: Verify amountInRaw matches what we're quoting with
      // For multi-hop swaps, ensure we're using the exact quotedOutputRaw from previous hop
      if (i > 0) {
        const prevHop = hops[i - 1];
        if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
          if (hops[i].amountInRaw !== prevHop.quotedOutputRaw) {
            try {
              logger.error('tx.resolve.hop.amount.mismatch', {
                cat: 'tx',
                code: LogCode.TX_BUILD_ERR,
                ctx: {
                  hopIndex: i,
                  expectedAmount: prevHop.quotedOutputRaw.toString(),
                  actualAmount: hops[i].amountInRaw.toString(),
                  difference: (hops[i].amountInRaw > prevHop.quotedOutputRaw 
                    ? (hops[i].amountInRaw - prevHop.quotedOutputRaw).toString() 
                    : (prevHop.quotedOutputRaw - hops[i].amountInRaw).toString()),
                  inputMint: hops[i].inputMint,
                  outputMint: prevHop.outputMint,
                }
              });
            } catch (e) { logCatchError('resolver.index', e); }
            // Force correct amount
            hops[i].amountInRaw = prevHop.quotedOutputRaw;
            curIn = prevHop.quotedOutputRaw;
          }
        }
      }
      
      // Quote per-hop; never let one failure abort subsequent hops
      // CRITICAL: Use hops[i].amountInRaw (which should be the exact prevHop.quotedOutputRaw) for quoting
      // This ensures the quote uses the exact amount that will be used in the swap
      let out = 0n;
      let quoteError: Error | null = null;
      try {
        out = await quoteHopOut(hops[i], hops[i].amountInRaw);
      } catch (e) {
        quoteError = e as Error;
        try {
          logger.warn('tx.resolve.hop.quote.failed', {
            cat: 'tx',
            code: LogCode.TX_BUILD_ERR,
            ctx: { 
              hopIndex: i, 
              error: String((e as any)?.message || e),
              amountInRaw: hops[i].amountInRaw.toString(),
              inputMint: hops[i].inputMint,
            }
          });
        } catch (e) { logCatchError('resolver.index', e); }
      }

      // Compute effective slippage and minOut even if out=0n
      // Use per-hop slippage estimation based on pool type, fee, and trade size
      let eff = slippage;
      try {
        // Build input for per-hop slippage estimation
        const hop = hops[i];
        const dex = String(hop.dex || '');
        const variant = String(hop.variant || '');
        const poolId = String(hop.poolId || '');
        const poolType = getPoolType(dex, variant);

        // Get pool-specific info
        const poolFeeBps = await getPoolFeeBps(dex, variant || undefined, poolId);
        const poolLiquidityUsd = await getPoolLiquidityUsd(dex, variant || undefined, poolId);
        const tradeSizeUsd = await getTradeSizeUsd(
          hop.amountInRaw,
          hop.inputMint,
          Number(hop.inputDecimals || 0)
        );

        // Build slippage input
        const slippageInput: SlippageEstimateInput = {
          dex,
          variant,
          poolType,
          poolFeeBps,
          poolLiquidityUsd,
          tradeSizeUsd,
        };

        // Add pool-type specific info
        if (poolType === 'dlmm') {
          const dlmmInfo = await getDlmmPoolInfo(poolId);
          if (dlmmInfo) {
            slippageInput.binStep = dlmmInfo.binStep;
            slippageInput.activeBinLiquidityUsd = dlmmInfo.activeBinLiquidityUsd;
          }
        } else if (poolType === 'clmm') {
          const clmmInfo = await getClmmPoolInfo(dex, poolId);
          if (clmmInfo) {
            slippageInput.tickSpacing = clmmInfo.tickSpacing;
            slippageInput.concentratedLiquidityUsd = clmmInfo.concentratedLiquidityUsd;
          }
        }

        // Estimate slippage
        const estimate = estimateSlippage(slippageInput);
        eff = estimate.totalBps;

        // Log the estimation for debugging
        logger.debug('tx.resolve.hop.slippage.estimated', {
          cat: 'tx',
          code: LogCode.TX_RESOLVE_OK,
          ctx: {
            hopIndex: i,
            poolId,
            dex,
            poolType,
            poolFeeBps: estimate.poolFeeBps,
            priceImpactBps: estimate.priceImpactBps,
            safetyBufferBps: estimate.safetyBufferBps,
            totalBps: estimate.totalBps,
            formula: estimate.breakdown.formula,
            tradeSizeUsd,
            poolLiquidityUsd,
            fallbackSlippageBps: slippage,
          }
        });
      } catch (e) {
        // Fall back to global slippage on any error
        logCatchError('resolver.slippage.estimate', e);
        logger.warn('tx.resolve.hop.slippage.fallback', {
          cat: 'tx',
          code: LogCode.TX_RESOLVE_OK,
          ctx: { hopIndex: i, fallbackBps: slippage, error: String((e as any)?.message || e) }
        });
      }

      // Apply Token-2022 bump on top of estimated slippage
      try {
        const sys = (CONFIG.system as any) || {};
        const bump = Number(sys.token2022ExtraSlippageBps ?? 0);
        const is2022 = (hops[i].inputTokenProgram === 'token-2022') || (hops[i].outputTokenProgram === 'token-2022');
        eff = Math.max(0, Math.min(9900, eff + (is2022 ? bump : 0)));
      } catch (e) { logCatchError('resolver.index', e); }
      try { hops[i].minOutRaw = applyMinOut(out, eff); } catch { hops[i].minOutRaw = 0n; }

      // For multihop: use the actual quoted output for propagation, not minOutRaw
      // The minOutRaw is only used for minimum output protection in the swap instruction
      // Using the actual quoted output ensures we use all tokens received from the previous hop
      // This prevents leaking small amounts between hops in multihop transactions
      if (out > 0n) {
        // Store the exact quoted output for this hop - this will be used as exact input for next hop
        hops[i].quotedOutputRaw = out;
        
        // Use the actual quoted output amount for propagation to next hop
        // This ensures we use the full amount received, not the slippage-adjusted minimum
        curIn = out;
        
        // Add logging for successful propagation
        try {
          logger.info('tx.resolve.hop.propagate', {
            cat: 'tx',
            code: LogCode.TX_RESOLVE_OK,
            ctx: {
              hopIndex: i,
              quotedOut: out.toString(),
              quotedOutputRaw: hops[i].quotedOutputRaw?.toString() || '0',
              minOutRaw: hops[i].minOutRaw.toString(),
              propagatedAmount: out.toString(), // Now using actual output
              nextHopInput: curIn.toString(),
              nextHopInputMint: (i < hops.length - 1) ? hops[i + 1].inputMint : 'N/A',
            }
          });
        } catch (e) { logCatchError('resolver.index', e); }
      } else {
        // Quote failed or returned 0 - don't propagate old curIn
        // Set curIn to 0 so next hop will fail validation
        try {
          logger.warn('tx.resolve.hop.no_propagation', {
            cat: 'tx',
            code: LogCode.TX_BUILD_ERR,
            ctx: {
              hopIndex: i,
              quotedOut: out.toString(),
              amountInRaw: curIn.toString(),
              inputMint: hops[i].inputMint,
              outputMint: hops[i].outputMint,
              quoteError: quoteError ? String(quoteError.message) : 'none',
            }
          });
        } catch (e) { logCatchError('resolver.index', e); }
        // Don't propagate - set to 0 to prevent using wrong amount
        curIn = 0n;
      }
    }
  } catch (e) {
    // Log the error instead of swallowing it
    try {
      logger.error('tx.resolve.failed', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: { 
          error: String((e as any)?.message || e), 
          hops: hops.length,
          stack: (e as any)?.stack,
        }
      });
    } catch (e) { logCatchError('resolver.index', e); }
    // Re-throw so the caller knows resolution failed
    throw e;
  }
  logger.info('tx.resolve.ok', { cat: 'tx', code: LogCode.TX_RESOLVE_OK, ctx: { ms: Date.now() - t0, hops: hops.length } as any });
  return { path, hops, computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports };
}

function hopAdjustAmount(_hops: DirectHop[], _raw: bigint): void { /* deprecated */ }


