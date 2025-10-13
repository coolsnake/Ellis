import { executionCache } from '../cache.js';
import type { DirectHop, ExecutionPlan, ExecConfig, ResolveDirectInput } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { getTokenMeta } from './tokenMeta.js';
import { CONFIG } from '../../utils/config.js';
import { applySlippage } from '../limits.js';

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
    const dex = (dexv.includes('raydium') ? 'raydium' : (dexv.includes('orca') ? 'orca' : 'meteora')) as DirectHop['dex'];
    const variant: DirectHop['variant'] = dex === 'raydium' ? (dexv.includes('clmm') ? 'clmm' : 'amm') : (dex === 'orca' ? 'clmm' : 'dlmm');
    const poolId = String(hopPoolIds[i]);
    const inputMint = path[i];
    const outputMint = path[i+1];
    // lightweight placeholders; per-DEX resolvers will fill in accounts/state
    const tokenInMeta = executionCache.getTokenMeta(inputMint) || await getTokenMeta(inputMint);
    const tokenOutMeta = executionCache.getTokenMeta(outputMint) || await getTokenMeta(outputMint);
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
  // Set amounts and minOuts using per-hop quotes; propagate through hops
  try {
    const slippage = typeof input.slippageBps === 'number' ? input.slippageBps : cfg.slippageBpsDefault;
    // Determine initial input size: prefer raw size; else compute from sizeUsd using priceStore (USD → tokens)
    let curIn = 0n;
    const rawSize = Number.isFinite(input.size as any) ? Math.floor(Number(input.size)) : 0;
    if (rawSize > 0) {
      curIn = BigInt(Math.max(0, rawSize));
    } else if (Number.isFinite(input.sizeUsd as any) && Number(input.sizeUsd) > 0 && hops.length > 0) {
      try {
        const startMint = hops[0].inputMint;
        const decimals = Number(hops[0].inputDecimals ?? 0);
        const { getPriceByMint } = await import('../../server/priceStore.js');
        const usdPx = Number((getPriceByMint(startMint)?.usdc) ?? 0); // USD per 1 token
        if (usdPx > 0) {
          // atoms = (usdAmt * 10^decimals) / usdPx, with micro precision for stability
          const usdAmtMicro = BigInt(Math.round(Number(input.sizeUsd) * 1_000_000));
          const usdPxMicro  = BigInt(Math.round(usdPx * 1_000_000));
          const scale       = (10n ** BigInt(Math.max(0, Math.min(12, decimals))));
          curIn = (usdAmtMicro * scale) / usdPxMicro;
        }
      } catch {}
    }
    const { quoteHopOut, applyMinOut } = await import('./quotes.js');
    for (let i = 0; i < hops.length; i++) {
      hops[i].amountInRaw = curIn;
      const out = await quoteHopOut(hops[i], curIn);
      // Optional extra bps for Token-2022 hops
      try {
        const sys = (CONFIG.system as any) || {};
        const bump = Number(sys.token2022ExtraSlippageBps ?? 0);
        const is2022 = (hops[i].inputTokenProgram === 'token-2022') || (hops[i].outputTokenProgram === 'token-2022');
        const eff = Math.max(0, Math.min(9900, slippage + (is2022 ? bump : 0)));
        hops[i].minOutRaw = applyMinOut(out, eff);
      } catch {
        hops[i].minOutRaw = applyMinOut(out, slippage);
      }
      curIn = out > 0n ? out : curIn;
    }
  } catch {}
  logger.info('tx.resolve.ok', { cat: 'tx', code: LogCode.TX_RESOLVE_OK, ctx: { ms: Date.now() - t0, hops: hops.length } as any });
  return { path, hops, computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports };
}

function hopAdjustAmount(_hops: DirectHop[], _raw: bigint): void { /* deprecated */ }


