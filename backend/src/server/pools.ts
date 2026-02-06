import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { readJson, writeJson, joinPath } from '../utils/fs.js';
import { enablePriceFeed, isPriceFeedEnabled } from './feedRegistry.js';
// Defer web3 imports to runtime to prevent type issues in environments without types
// import { PublicKey } from '@solana/web3.js';
import type { AmmPool, ClmmPool, PoolsPayload, SummaryPool, SurvivorPoolIds } from './pools/types.js';
import { raydiumCache, orcaCache, meteoraCache, metbalCache, pumpswapCache } from './pools.cache.js';
export {
  clearAllPoolCaches,
  peekRaydiumPools,
  peekOrcaPools,
  peekMeteoraPools,
  peekMeteoraBalancedPools,
  peekPumpswapPools,
  findPoolInCache,
} from './pools.cache.js';
import { applyTokenMintBlocklist, diffNormalizedPools, toB58Any } from './pools.utils.js';
export { diffNormalizedPools } from './pools.utils.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './pools/precision.js';
import { fetchRaydiumPoolsRaw as fetchRaydiumPoolsRawImpl, normalizeRaydiumPools as normalizeRaydiumPoolsImpl } from './pools/raydium.js';
import { fetchOrcaHttp as fetchOrcaHttpImpl, normalizeOrcaHttp as normalizeOrcaHttpImpl } from './pools/orca.js';
import { fetchMeteoraHttp as fetchMeteoraHttpImpl, normalizeMeteoraHttp as normalizeMeteoraHttpImpl } from './pools/meteora.js';
import { fetchPumpswapGraphQL as fetchPumpswapGraphQLImpl, normalizePumpswapPools as normalizePumpswapPoolsImpl, enrichPumpswapPoolsWithRpc as enrichPumpswapPoolsWithRpcImpl, fetchPumpswapSummaryOnly } from './pools/pumpswap.js';
// Early filter optimization imports
import { fetchRaydiumSummaryOnly, fetchRaydiumClmmSummaryOnly, fetchRaydiumPoolsByAddress, fetchRaydiumClmmPoolsByAddress, normalizeRaydiumGraphQL } from './pools/raydiumGraphQL.js';
import { fetchOrcaSummaryOnly, fetchOrcaPoolsByAddress, normalizeOrcaGraphQL } from './pools/orcaGraphQL.js';
import { fetchMeteoraSummaryOnly, fetchMeteoraPoolsByAddress, normalizeMeteoraGraphQL } from './pools/meteoraGraphQL.js';
import { validateCrossDexPrices } from './pools/validation.js';
import { loadPersistedDecimals, flushPersistedDecimals } from './pools/decimals.js';
export { flushPersistedDecimals } from './pools/decimals.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './pools/httpLog.js';
import { fetchMeteoraBalancedHttp as fetchMeteoraBalancedHttpImpl, normalizeMeteoraBalancedHttp as normalizeMeteoraBalancedHttpImpl, fetchMeteoraBalancedAll as fetchMeteoraBalancedAllImpl } from './pools/meteoraBalanced.js';
import { checkPoolsActivityBatch } from './pools/activityCheck.js';
import { poolsMetrics } from './pools.metrics.js';
export { getPoolsMetrics } from './pools.metrics.js';
import {
  setPoolRefreshHandler,
  startPoolWebsocketsOnlyOnce,
  getWsActivity,
  getWsTargets,
  retargetPoolWebsockets,
  subscribeToDiscoveredPools,
  enablePoolWebsocketRefreshes,
  disablePoolWebsocketRefreshes,
  getPoolWsStatus,
  stopPoolRefreshLoop,
} from './pools.websockets.js';
export {
  startPoolWebsocketsOnlyOnce,
  getWsActivity,
  getWsTargets,
  retargetPoolWebsockets,
  subscribeToDiscoveredPools,
  enablePoolWebsocketRefreshes,
  disablePoolWebsocketRefreshes,
  getPoolWsStatus,
  stopPoolRefreshLoop,
  isMeteoraBinArraySubscribed,
} from './pools.websockets.js';
import { deriveRaydiumClmmCacheFields, deriveMeteoraBinArrayAddresses, getMeteoraBinHelpers } from './pools.derivation.js';
import { PoolInfoLayout as RaydiumClmmLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../execution/raydiumTickArrays.js';
import BN from 'bn.js';
import { createHash } from 'crypto';

export function getPoolCacheAges(): {
  raydium: number;
  orca: number;
  meteora: number;
  meteora_balanced: number;
  ttl: { raydium: number; orca: number; meteora: number; meteora_balanced: number };
} {
  const now = Date.now();
  const rayTtl = Number((CONFIG as any)?.raydium?.cacheTtlMs || 300_000);
  const orcTtl = Number((CONFIG as any)?.orca?.cacheTtlMs || 300_000);
  const metTtl = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const mblTtl = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const rayAge = raydiumCache.ts ? now - raydiumCache.ts : Number.POSITIVE_INFINITY;
  const orcAge = orcaCache.ts ? now - orcaCache.ts : Number.POSITIVE_INFINITY;
  const metAge = meteoraCache.ts ? now - meteoraCache.ts : Number.POSITIVE_INFINITY;
  const mblAge = metbalCache.ts ? now - metbalCache.ts : Number.POSITIVE_INFINITY;
  return {
    raydium: rayAge,
    orca: orcAge,
    meteora: metAge,
    meteora_balanced: mblAge,
    ttl: { raydium: rayTtl, orca: orcTtl, meteora: metTtl, meteora_balanced: mblTtl },
  };
}

export interface RefreshSourcesOptions {
  force?: boolean;
  subscribe?: boolean;
  sources?: {
    raydium?: boolean | { amm?: boolean; clmm?: boolean };
    orca?: boolean | { amm?: boolean; clmm?: boolean };
    meteora?: boolean;
    meteora_balanced?: boolean;
    pumpswap?: boolean;
  };
}

export async function normalizeRaydiumPools(raw: any): Promise<PoolsPayload> { return normalizeRaydiumPoolsImpl(raw); }

// Synchronous default normalizer for tests that import without awaiting.
// Mirrors core fields from normalizeRaydiumPools but avoids async imports and network calls.
export async function defaultNormalizeRaydiumPools(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: any[] = [];
  const clmm: any[] = [];
  const arr: any[] = Array.isArray(raw?.data?.data)
    ? raw.data.data
    : (Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []));
  
  // Enrich missing token decimals before price calculations
  let enrichedDecimals: Map<string, number> = new Map();
  try {
    const { enrichPoolTokenDecimals } = await import('../utils/tokens.js');
    enrichedDecimals = await enrichPoolTokenDecimals(arr, { logger, forceOnchain: true });
  } catch (err: any) {
    try { logger.warn('raydium.normalizer.enrich.failed', { error: String(err?.message || err), cat: 'pools' }); } catch {}
    enrichedDecimals = new Map();
  }
  const toMint = (v: any): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if ((v as any)?.address) return String((v as any).address);
    return '';
  };
  const toFeeBps = (v: any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 30;
    return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
  };
  for (const it of (arr || [])) {
    if (!it) continue;
    const id = String(it?.id || it?.address || it?.pool_id || it?.ammId || '');
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (!id || !mintA || !mintB) continue;
    const typeStr = String(it?.type || it?.poolType || '').toLowerCase();
    const pooltype = Array.isArray((it as any)?.pooltype) ? (it as any).pooltype : [];
    const tickSpacing = (it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing;
    const hasTick = typeof tickSpacing === 'number' && tickSpacing > 0; // Only consider valid tick spacing
    const isClmm = (
      typeStr.includes('concentrated') ||
      pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm') ||
      hasTick ||
      (typeof (it as any)?.sqrtPriceX64 !== 'undefined' || typeof (it as any)?.sqrtPrice !== 'undefined')
    );
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    let decA = Number((it?.mintA as any)?.decimals);
    let decB = Number((it?.mintB as any)?.decimals);
    const enrichedA = enrichedDecimals.get(mintA);
    const enrichedB = enrichedDecimals.get(mintB);
    if (typeof enrichedA === 'number' && Number.isFinite(enrichedA)) decA = enrichedA;
    if (typeof enrichedB === 'number' && Number.isFinite(enrichedB)) decB = enrichedB;
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountA = Number((it as any)?.mintAmountA);
    const mintAmountB = Number((it as any)?.mintAmountB);
    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrtCandidate = (it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0;
      const sqrtBig = anyToBigInt(sqrtCandidate);
      const sqrt = typeof sqrtCandidate === 'number' ? sqrtCandidate : Number(sqrtBig ?? 0n);
      const liquidityCandidate = (it as any)?.liquidity ?? 0;
      const liquidity = Number(liquidityCandidate);
      const liquidityRaw = anyToBigInt(liquidityCandidate);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      let price_from_sqrt = 0;
      let ratio: ReturnType<typeof sqrtPriceX64ToPriceRatio> | null = null;
      if (sqrtBig && Number.isFinite(decA) && Number.isFinite(decB)) {
        ratio = sqrtPriceX64ToPriceRatio(sqrtBig, decA as number, decB as number);
        if (ratio?.float && Number.isFinite(ratio.float) && ratio.float > 0) {
          price_from_sqrt = ratio.float;
        }
      } else if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
        // sqrt_price_x64 = sqrt(tokenB_atomic / tokenA_atomic) * 2^64
        // price_a_per_b_atomic = (sqrt / 2^64)^2 = sqrt^2 / 2^128
        // price_a_per_b_whole = price_a_per_b_atomic * 10^(decA - decB)
        const two64 = Math.pow(2, 64);
        const priceAperB_atomic = (sqrt / two64) * (sqrt / two64);
        const decimalAdjust = Math.pow(10, (decA as number) - (decB as number));
        const cand = priceAperB_atomic * decimalAdjust;
        price_from_sqrt = Number.isFinite(cand) && cand > 0 ? cand : 0;
      }
      const px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
      clmm.push({
        id,
        dex: 'Raydium',
        mint_a: mintA,
        mint_b: mintB,
        fee_bps,
        sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0,
        sqrt_price_x64_raw: sqrtBig ? sqrtBig.toString() : undefined,
        liquidity: Number.isFinite(liquidity) ? liquidity : 0,
        liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
        'tick_spacing': Number.isFinite(tick) ? tick : 0,
        updated_ms: now,
        price_a_per_b: px > 0 ? px : undefined,
        price_a_per_b_num: ratio ? ratio.numerator.toString() : undefined,
        price_a_per_b_den: ratio ? ratio.denominator.toString() : undefined,
        price_a_per_b_exact: ratioToDecimalString(ratio) ?? undefined,
        decimals_a: Number.isFinite(decA) ? decA : undefined,
        decimals_b: Number.isFinite(decB) ? decB : undefined,
        pool_kind: 'clmm',
        tvl_usd,
      } as any);
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const reserveA = Number((it as any)?.reserveA ?? NaN);
      const reserveB = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA) ? reserveA : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB) ? reserveB : undefined);
      const reserveA0 = Number((it as any)?.reserveA ?? 0);
      const reserveB0 = Number((it as any)?.reserveB ?? 0);
      // price_a_per_b = "how many B for 1 A" = B/A
      // For whole units: price = amount_b_whole / amount_a_whole
      // For atomic units: price = (reserveB / reserveA) * 10^(decA - decB)
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_a_whole as number) > 0)
        ? ((amount_b_whole as number) / (amount_a_whole as number))
        : ((reserveA0 > 0) ? (reserveB0 / reserveA0) : 0);
      const price_res_decs = (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(mintAmountA) && Number.isFinite(mintAmountB) && (mintAmountA as number) > 0)
        ? ((mintAmountB as number) / Math.pow(10, decB as number)) / ((mintAmountA as number) / Math.pow(10, decA as number))
        : 0;
      const px = price_res_decs > 0 ? price_res_decs : (price_res > 0 ? price_res : (Number(price) > 0 ? Number(price) : 0));
      const reserveARaw = anyToBigInt((it as any)?.reserveA ?? mintAmountA);
      const reserveBRaw = anyToBigInt((it as any)?.reserveB ?? mintAmountB);
      amm.push({
        id,
        dex: 'Raydium',
        mint_a: mintA,
        mint_b: mintB,
        fee_bps,
        price_a_per_b: Number.isFinite(px) ? px : 0,
        updated_ms: now,
        pool_kind: 'amm',
        tvl_usd,
        amount_a_whole,
        amount_b_whole,
        decimals_a: Number.isFinite(decA) ? decA : undefined,
        decimals_b: Number.isFinite(decB) ? decB : undefined,
        reserve_a_raw: reserveARaw ? reserveARaw.toString() : undefined,
        reserve_b_raw: reserveBRaw ? reserveBRaw.toString() : undefined,
      } as any);
    }
  }
  return { amm, clmm } as any;
}

export async function refreshAllSources(force = true, subscribe = true, opts?: RefreshSourcesOptions): Promise<{ raydium: PoolsPayload; orca: PoolsPayload; meteora: PoolsPayload; meteora_balanced: PoolsPayload; pumpswap: PoolsPayload }> {
  // Track refresh timing for summary
  const refreshStartTime = Date.now();
  
  // Accumulator for phase stats (used for summary log)
  const phaseStats: {
    fetch?: { raydium: { amm: number; clmm: number; cpmm?: number }; orca: { amm: number; clmm: number }; meteora: { amm: number; clmm: number }; meteora_balanced: { amm: number; clmm: number }; pumpswap: { amm: number; clmm: number } };
    universe?: { mode: string; before: Record<string, number>; after: Record<string, number> };
    minPools1?: { minPools: number; before: Record<string, number>; after: Record<string, number> };
    tvl?: { minAmm: number; minClmm: number; before: Record<string, { a: number; c: number }>; after: Record<string, { a: number; c: number }> };
    activity?: { maxInactiveMs: number; totalChecked: number; active: number; inactive: number };
    minPools2?: { minPools: number; before: Record<string, number>; after: Record<string, number> };
  } = {};
  
  // Track last call time to prevent excessive refreshes
  (refreshAllSources as any).__lastCallTime = Date.now();
  
  // Prevent recursive calls from subscribe phase
  if ((refreshAllSources as any).__isRunning) {
    try {
      logger.info('pools.refresh.skipped', { reason: 'already_running', cat: 'pools' });
    } catch {}
    // Return cached data if available
    return {
      raydium: raydiumCache.data || { amm: [], clmm: [], cpmm: [] },
      orca: orcaCache.data || { amm: [], clmm: [], cpmm: [] },
      meteora: meteoraCache.data || { amm: [], clmm: [], cpmm: [] },
      meteora_balanced: metbalCache.data || { amm: [], clmm: [], cpmm: [] },
      pumpswap: pumpswapCache.data || { amm: [], clmm: [], cpmm: [] }
    };
  }
  (refreshAllSources as any).__isRunning = true;

  // Load persisted decimals early to avoid RPC calls for known tokens
  try {
    const loadedCount = await loadPersistedDecimals();
    if (loadedCount > 0) {
      logger.info('pools.refresh.decimals.loaded', { count: loadedCount, cat: 'decimals' });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.decimals.load_failed', { error: String(e?.message || e), cat: 'decimals' });
  }

  // Mark that we're in a refresh cycle - individual fetchers should skip incremental graph updates
  // until all filtering is complete to avoid building huge unfiltered snapshots
  (refreshAllSources as any).__inProgress = true;
  
  // Parse options with backward compatibility
  const options: RefreshSourcesOptions = {
    force: opts?.force ?? force,
    subscribe: opts?.subscribe ?? subscribe,
    sources: opts?.sources
  };
  
  // Load enabled sources from config (defaults to all enabled)
  const configSources = (CONFIG.system as any)?.enabledDexSources || {};
  
  // Handle meteora_balanced v1/v2 sub-options
  const meteoraBalancedConfig = configSources.meteora_balanced;
  const meteoraBalancedEnabled = typeof meteoraBalancedConfig === 'object' 
    ? (meteoraBalancedConfig.v1 || meteoraBalancedConfig.v2) 
    : (meteoraBalancedConfig ?? true);
  const meteoraBalancedV1 = typeof meteoraBalancedConfig === 'object' 
    ? (meteoraBalancedConfig.v1 ?? true) 
    : (meteoraBalancedConfig ?? true);
  const meteoraBalancedV2 = typeof meteoraBalancedConfig === 'object' 
    ? (meteoraBalancedConfig.v2 ?? true) 
    : (meteoraBalancedConfig ?? true);
  
  const shouldFetch = {
    raydium: options.sources?.raydium ?? configSources.raydium ?? true,
    orca: options.sources?.orca ?? configSources.orca ?? true,
    meteora: options.sources?.meteora ?? configSources.meteora ?? true,
    meteora_balanced: options.sources?.meteora_balanced ?? meteoraBalancedEnabled,
    meteora_balanced_v1: meteoraBalancedV1,
    meteora_balanced_v2: meteoraBalancedV2,
    pumpswap: options.sources?.pumpswap ?? configSources.pumpswap ?? true,
  };
  
  try {
    logger.info('pools.refresh.start', { 
      force: options.force, 
      subscribe: options.subscribe, 
      enabledSources: shouldFetch,
      caller: new Error().stack?.split('\n')?.[2]?.trim() || 'unknown',
      cat: 'pools' 
    });
    
    // Deep bootstrap phase: optionally pause feed/API, fetch Jup tokens, then hydrate prices
    if (force) {
      let shouldResumeFeed = false;
      const pauseFeed = ((CONFIG.system as any)?.pausePriceFeedDuringBootstrap !== false);
      if (pauseFeed) {
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.pause', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.pause', { cat: 'pools' }); } catch {}
        try {
          const reg: any = await import('./feedRegistry.js');
          shouldResumeFeed = reg.isPriceFeedEnabled?.() === true;
          reg.enablePriceFeed?.(false);
        } catch {}
        try { (await import('../jupiter/rateLimiter.js')).apiStop(); } catch {}
      }

      // Removed auto verified token refresh in refresh flow; use manual endpoint

      // Removed auto bootstrap on refresh; use manual endpoint

      // Resume Jupiter API before source fetches so downstream calls are allowed
      if (pauseFeed) {
        try { (await import('../jupiter/rateLimiter.js')).apiStart(); } catch {}
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.resume', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.resume', { cat: 'pools' }); } catch {}
        // Stash the intent to resume the feed at the end of refresh
        (refreshAllSources as any).__resumeFeed = shouldResumeFeed;
        // Opportunistically resume immediately if it was previously enabled
        try {
          if (shouldResumeFeed === true) {
            const reg: any = await import('./feedRegistry.js');
            reg.enablePriceFeed?.(true);
          }
        } catch {}
      }
    }
  } catch {}
  
  // Pre-warm token universes that will be required so expensive fetches (e.g. Jupiter Top list)
  // are completed before DEX fetches begin. This ensures we can scope pools immediately after fetch.
  try {
    const warmModes = new Set<string>();
    const tokenUniMode = String((CONFIG.system as any)?.tokenUniverseMode || 'union');
    if (tokenUniMode === 'jupiterTop') warmModes.add('jupiterTop');
    const scopeMode = String((CONFIG.system as any)?.scopePoolsMode || 'none');
    const scopingEnabled = (CONFIG.system as any)?.scopePools !== false && scopeMode !== 'none';
    if (scopingEnabled && scopeMode === 'jupiterTop') warmModes.add('jupiterTop');
    if (warmModes.size > 0) {
      const { computeTokenUniverse } = await import('./universe.js');
      for (const mode of warmModes) {
        try {
          await computeTokenUniverse(mode as any);
        } catch (err: any) {
          logger.warn('pools.refresh.universe_prewarm_failed', { mode, error: String(err?.message || err), cat: 'pools' });
        }
      }
      logger.info('pools.refresh.universe_prewarm.complete', { modes: Array.from(warmModes), cat: 'pools' });
    }
  } catch (err: any) {
    logger.warn('pools.refresh.universe_prewarm.error', { error: String(err?.message || err), cat: 'pools' });
  }
  
  // === PHASE 1: FETCH RAW DATA FROM ALL DEXES ===
  // Check if early filter optimization is enabled and GraphQL is used for all relevant DEXes
  const enableEarlyFilter = (CONFIG.system as any)?.enableEarlyMinPoolsFilter !== false;
  const useRaydiumGraphQL = !!(CONFIG as any)?.raydium?.useGraphQL;
  const useOrcaGraphQL = !!(CONFIG as any)?.orca?.useGraphQL;
  const useMeteoraGraphQL = !!(CONFIG as any)?.meteora?.useGraphQL;
  const minPoolsThreshold = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
  
  // Early filter optimization applies when: enabled in config AND minPools > 1 AND GraphQL is used
  const useEarlyFilterPath = enableEarlyFilter && minPoolsThreshold > 1 && (
    (shouldFetch.raydium && useRaydiumGraphQL) ||
    (shouldFetch.orca && useOrcaGraphQL) ||
    (shouldFetch.meteora && useMeteoraGraphQL) ||
    shouldFetch.pumpswap
  );
  
  // Track if early filters were applied (to skip Phase 2 and 3)
  let earlyFiltersApplied = false;
  
  logger.info('pools.refresh.phase.fetch', { 
    enabled: shouldFetch, 
    useEarlyFilterPath,
    minPoolsThreshold,
    graphql: { raydium: useRaydiumGraphQL, orca: useOrcaGraphQL, meteora: useMeteoraGraphQL },
    cat: 'pools' 
  });
  
  let r: PoolsPayload = { amm: [], clmm: [], cpmm: [] };
  let o: PoolsPayload = { amm: [], clmm: [], cpmm: [] };
  let m: PoolsPayload = { amm: [], clmm: [], cpmm: [] };
  let mb: PoolsPayload = { amm: [], clmm: [], cpmm: [] };
  let pump: PoolsPayload = { amm: [], clmm: [], cpmm: [] };
  
  // Shared mints for consistent universe across all DEX fetchers
  // Computed once and passed to all GraphQL fetchers to avoid timing inconsistencies
  let sharedMints: string[] | undefined;
  
  if (useEarlyFilterPath) {
    // === OPTIMIZED PATH: Early filter before detail fetch ===
    logger.info('pools.refresh.phase.fetch.early_filter_path', { cat: 'pools' });
    
    // Get token universe for summary queries - compute once and share with all fetchers
    const { computeTokenUniverse, getAnchorSet } = await import('./universe.js');
    const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
    let mints = Array.from(universe);
    
    // CRITICAL: Always include anchor tokens in shared mints list for GraphQL queries
    // This ensures pools containing SOL/USDC/USDT are always fetched, regardless of
    // includeAnchorsInUniverse setting. Anchor bridging controls post-fetch filtering,
    // but we need anchors in the query to find the pools in the first place.
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    sharedMints = mints; // Store for potential use outside early filter path
    
    // === PHASE 1A: SUMMARY FETCH (lightweight) ===
    logger.info('pools.refresh.phase.1A.summary_fetch', { mintCount: mints.length, cat: 'pools' });
    
    let raySummary: SummaryPool[] = [];
    let rayClmmSummary: SummaryPool[] = [];
    let orcaSummary: SummaryPool[] = [];
    let metSummary: SummaryPool[] = [];
    let pumpSummary: SummaryPool[] = [];
    
    // Store raw Pumpswap pools for later enrichment
    let pumpRawPools: any[] = [];
    
    // Fetch summaries in sequence (to respect rate limits)
    if (shouldFetch.raydium && useRaydiumGraphQL) {
      try {
        // Check AMM/CLMM enabled status BEFORE fetching to avoid wasted work
        const isAmmEnabled = (() => {
          if (typeof options.sources?.raydium === 'object') {
            return options.sources.raydium.amm !== false;
          }
          const configRaydium = configSources.raydium;
          if (typeof configRaydium === 'object') {
            return configRaydium.amm !== false;
          }
          return true;
        })();
        
        const isClmmEnabled = (() => {
          if (typeof options.sources?.raydium === 'object') {
            return options.sources.raydium.clmm !== false;
          }
          const configRaydium = configSources.raydium;
          if (typeof configRaydium === 'object') {
            return configRaydium.clmm !== false;
          }
          return true;
        })();
        
        logger.debug('pools.refresh.phase.1A.raydium.config', { 
          isAmmEnabled, 
          isClmmEnabled, 
          cat: 'pools' 
        });
        
        // Only fetch AMM if enabled
        if (isAmmEnabled) {
          raySummary = await fetchRaydiumSummaryOnly(mints);
          logger.debug('pools.refresh.phase.1A.raydium.amm', { count: raySummary.length, cat: 'pools' });
        } else {
          logger.debug('pools.refresh.phase.1A.raydium.amm.skipped', { reason: 'disabled', cat: 'pools' });
        }
        
        // Only fetch CLMM if enabled
        if (isClmmEnabled) {
          // Only add delay if AMM was also fetched
          if (isAmmEnabled) {
            const clmmPageDelayMs = Number((CONFIG as any)?.raydiumClmm?.pageDelayMs || 200);
            const interPhaseMultiplier = Number((CONFIG as any)?.raydiumClmm?.initialDelayMultiplier || 10);
            await new Promise(resolve => setTimeout(resolve, clmmPageDelayMs * interPhaseMultiplier));
          }
          
          rayClmmSummary = await fetchRaydiumClmmSummaryOnly(mints);
          logger.debug('pools.refresh.phase.1A.raydium.clmm', { count: rayClmmSummary.length, cat: 'pools' });
        } else {
          logger.debug('pools.refresh.phase.1A.raydium.clmm.skipped', { reason: 'disabled', cat: 'pools' });
        }
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1A.raydium.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    if (shouldFetch.orca && useOrcaGraphQL) {
      try {
        orcaSummary = await fetchOrcaSummaryOnly(mints);
        logger.debug('pools.refresh.phase.1A.orca', { count: orcaSummary.length, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1A.orca.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    if (shouldFetch.meteora && useMeteoraGraphQL) {
      try {
        metSummary = await fetchMeteoraSummaryOnly(mints);
        logger.debug('pools.refresh.phase.1A.meteora', { count: metSummary.length, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1A.meteora.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    if (shouldFetch.pumpswap) {
      try {
        // Pass shared mints to Pumpswap for consistent universe
        pumpSummary = await fetchPumpswapSummaryOnly(mints);
        // Also fetch raw pools for later enrichment (Pumpswap doesn't have separate detail fetch)
        pumpRawPools = await fetchPumpswapGraphQLImpl(mints);
        logger.debug('pools.refresh.phase.1A.pumpswap', { count: pumpSummary.length, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1A.pumpswap.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    const summaryCounts = {
      raydiumAmm: raySummary.length,
      raydiumClmm: rayClmmSummary.length,
      orca: orcaSummary.length,
      meteora: metSummary.length,
      pumpswap: pumpSummary.length,
      total: raySummary.length + rayClmmSummary.length + orcaSummary.length + metSummary.length + pumpSummary.length,
    };
    logger.info('pools.refresh.phase.1A.complete', { counts: summaryCounts, cat: 'pools' });
    
    // === PHASE 1B: EARLY UNIVERSE FILTER (on summaries) ===
    logger.info('pools.refresh.phase.1B.early_universe_filter', { cat: 'pools' });
    const scopeMode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
    const scoped = CONFIG.system.scopePools !== false && scopeMode !== 'none';
    const anchorBridging = !!((CONFIG.system as any)?.enableAnchorBridging);
    
    const filterSummariesByUniverse = (summaries: SummaryPool[], uni: Set<string>, anchorBridge: boolean): SummaryPool[] => {
      return summaries.filter(p => {
        const aIn = uni.has(p.mint_a);
        const bIn = uni.has(p.mint_b);
        if (anchorBridge) return aIn || bIn;
        return aIn && bIn;
      });
    };
    
    if (scoped) {
      const beforeCounts = { ...summaryCounts };
      raySummary = filterSummariesByUniverse(raySummary, universe, anchorBridging);
      rayClmmSummary = filterSummariesByUniverse(rayClmmSummary, universe, anchorBridging);
      orcaSummary = filterSummariesByUniverse(orcaSummary, universe, anchorBridging);
      metSummary = filterSummariesByUniverse(metSummary, universe, anchorBridging);
      pumpSummary = filterSummariesByUniverse(pumpSummary, universe, anchorBridging);
      
      const afterCounts = {
        raydiumAmm: raySummary.length,
        raydiumClmm: rayClmmSummary.length,
        orca: orcaSummary.length,
        meteora: metSummary.length,
        pumpswap: pumpSummary.length,
      };
      logger.info('pools.refresh.phase.1B.complete', { mode: scopeMode, before: beforeCounts, after: afterCounts, cat: 'pools' });
    }
    
    // === PHASE 1C: EARLY MIN POOLS FILTER (on summaries) ===
    logger.info('pools.refresh.phase.1C.early_min_pools_filter', { minPools: minPoolsThreshold, cat: 'pools' });
    
    const canonicalPairKey = (mintA: string, mintB: string): string => {
      const a = String(mintA || '');
      const b = String(mintB || '');
      return a <= b ? `${a}-${b}` : `${b}-${a}`;
    };
    
    // Count pools per pair across all summaries
    const poolCounts = new Map<string, number>();
    const countSummaries = (arr: SummaryPool[]) => {
      for (const p of arr) {
        const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
        poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
      }
    };
    
    countSummaries(raySummary);
    countSummaries(rayClmmSummary);
    countSummaries(orcaSummary);
    countSummaries(metSummary);
    countSummaries(pumpSummary);
    
    // Build allow set for pairs meeting threshold
    const allowedPairs = new Set<string>();
    for (const [k, count] of poolCounts.entries()) {
      if (count >= minPoolsThreshold) {
        allowedPairs.add(k);
      }
    }
    
    // Filter summaries and build survivor pool IDs
    const filterAndGetIds = (arr: SummaryPool[]): Set<string> => {
      const ids = new Set<string>();
      for (const p of arr) {
        if (allowedPairs.has(canonicalPairKey(p.mint_a, p.mint_b))) {
          ids.add(p.pubkey);
        }
      }
      return ids;
    };
    
    const survivorIds: SurvivorPoolIds = {
      raydiumAmm: filterAndGetIds(raySummary),
      raydiumClmm: filterAndGetIds(rayClmmSummary),
      raydiumCpmm: new Set<string>(), // CPMM handled separately
      orca: filterAndGetIds(orcaSummary),
      meteora: filterAndGetIds(metSummary),
      pumpswap: filterAndGetIds(pumpSummary),
    };
    
    const beforeMinPools = {
      raydiumAmm: raySummary.length,
      raydiumClmm: rayClmmSummary.length,
      orca: orcaSummary.length,
      meteora: metSummary.length,
      pumpswap: pumpSummary.length,
    };
    const afterMinPools = {
      raydiumAmm: survivorIds.raydiumAmm.size,
      raydiumClmm: survivorIds.raydiumClmm.size,
      orca: survivorIds.orca.size,
      meteora: survivorIds.meteora.size,
      pumpswap: survivorIds.pumpswap.size,
    };
    const totalBefore = Object.values(beforeMinPools).reduce((a, b) => a + b, 0);
    const totalAfter = Object.values(afterMinPools).reduce((a, b) => a + b, 0);
    const savings = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
    
    logger.info('pools.refresh.phase.1C.complete', { 
      minPools: minPoolsThreshold,
      before: beforeMinPools, 
      after: afterMinPools,
      totalBefore,
      totalAfter,
      savings: `${savings}%`,
      cat: 'pools' 
    });
    
    // === PHASE 1D: DETAIL FETCH + RPC + NORMALIZE (survivors only) ===
    logger.info('pools.refresh.phase.1D.detail_fetch', { survivors: afterMinPools, cat: 'pools' });
    
    // Fetch details only for survivor pools
    const detailBatchSize = Number((CONFIG as any)?.raydium?.detailBatchSize || 50);
    const detailDelayMs = Number((CONFIG as any)?.raydium?.detailBatchDelayMs || 200);
    const retries = Number((CONFIG as any)?.raydium?.maxHttpRetries || 2);
    const backoffMs = Number((CONFIG as any)?.raydium?.httpBackoffMs || 500);
    
    // Raydium AMM detail fetch
    if (survivorIds.raydiumAmm.size > 0) {
      try {
        const rayDetailMap = await fetchRaydiumPoolsByAddress(Array.from(survivorIds.raydiumAmm), {
          retries,
          backoffMs,
          batchSize: detailBatchSize,
          delayMs: detailDelayMs,
        });
        const rayNormalized = await normalizeRaydiumGraphQL([...rayDetailMap.values()]);
        r.amm = rayNormalized.amm || [];
        logger.debug('pools.refresh.phase.1D.raydium.amm', { count: r.amm.length, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1D.raydium.amm.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    // Raydium CLMM detail fetch
    if (survivorIds.raydiumClmm.size > 0) {
      try {
        await new Promise(resolve => setTimeout(resolve, detailDelayMs)); // Rate limit
        const rayClmmDetailMap = await fetchRaydiumClmmPoolsByAddress(Array.from(survivorIds.raydiumClmm), {
          retries,
          backoffMs,
          batchSize: detailBatchSize,
          delayMs: detailDelayMs,
        });
        const rayClmmNormalized = await normalizeRaydiumGraphQL([...rayClmmDetailMap.values()]);
        r.clmm = rayClmmNormalized.clmm || [];
        logger.debug('pools.refresh.phase.1D.raydium.clmm', { count: r.clmm.length, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1D.raydium.clmm.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    // Orca detail fetch
    if (survivorIds.orca.size > 0) {
      try {
        const orcaDetailBatchSize = Math.min(
          Number((CONFIG as any)?.orca?.detailBatchSize || 20),
          Number((CONFIG as any)?.orca?.maxDetailBatchSize || 40)
        );
        const orcaDetailMap = await fetchOrcaPoolsByAddress(Array.from(survivorIds.orca), {
          retries: Number((CONFIG as any)?.orca?.maxHttpRetries || 2),
          backoffMs: Number((CONFIG as any)?.orca?.httpBackoffMs || 500),
          batchSize: orcaDetailBatchSize,
          delayMs: Number((CONFIG as any)?.orca?.detailBatchDelayMs || 200),
        });
        o = await normalizeOrcaGraphQL([...orcaDetailMap.values()]);
        logger.debug('pools.refresh.phase.1D.orca', { count: (o.amm?.length || 0) + (o.clmm?.length || 0), cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1D.orca.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    // Meteora detail fetch
    if (survivorIds.meteora.size > 0) {
      try {
        const metDetailBatchSize = Math.min(
          Number((CONFIG as any)?.meteora?.detailBatchSize || 10),
          Number((CONFIG as any)?.meteora?.maxDetailBatchSize || 40)
        );
        const metDetailMap = await fetchMeteoraPoolsByAddress(Array.from(survivorIds.meteora), {
          retries: Number((CONFIG as any)?.meteora?.maxHttpRetries || 2),
          backoffMs: Number((CONFIG as any)?.meteora?.httpBackoffMs || 500),
          batchSize: metDetailBatchSize,
          delayMs: Number((CONFIG as any)?.meteora?.detailBatchDelayMs || 200),
        });
        m = await normalizeMeteoraGraphQL([...metDetailMap.values()]);
        logger.debug('pools.refresh.phase.1D.meteora', { count: (m.amm?.length || 0) + (m.clmm?.length || 0), cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1D.meteora.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    // Pumpswap: filter raw pools by survivor IDs, then enrich
    if (survivorIds.pumpswap.size > 0 && pumpRawPools.length > 0) {
      try {
        const survivorRaw = pumpRawPools.filter(p => survivorIds.pumpswap.has(p.pubkey));
        logger.debug('pools.refresh.phase.1D.pumpswap.filter', { 
          raw: pumpRawPools.length, 
          survivors: survivorRaw.length, 
          cat: 'pools' 
        });
        
        const { pools: enriched } = await enrichPumpswapPoolsWithRpcImpl(survivorRaw);
        pump = await normalizePumpswapPoolsImpl(enriched);
        logger.debug('pools.refresh.phase.1D.pumpswap', { count: pump.amm?.length || 0, cat: 'pools' });
      } catch (e: any) {
        logger.warn('pools.refresh.phase.1D.pumpswap.failed', { error: String(e?.message || e), cat: 'pools' });
      }
    }
    
    // Mark that early filters were applied (skip Phase 2 and 3)
    earlyFiltersApplied = true;
    
    logger.info('pools.refresh.phase.1D.complete', {
      counts: {
        raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0 },
        orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
        meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
        pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
      },
      cat: 'pools'
    });
    
  } else {
    // === LEGACY PATH: Existing behavior (summary + detail + normalize, then filter) ===
    logger.info('pools.refresh.phase.fetch.legacy_path', { cat: 'pools' });
    
    // OPTIMIZATION: Compute token universe ONCE and pass to all GraphQL fetchers
    // This ensures consistent mint sets across all DEXes and avoids race conditions
    const anyUseGraphQL = 
      ((CONFIG as any)?.raydium?.useGraphQL && shouldFetch.raydium) ||
      ((CONFIG as any)?.orca?.useGraphQL && shouldFetch.orca) ||
      ((CONFIG as any)?.meteora?.useGraphQL && shouldFetch.meteora) ||
      shouldFetch.pumpswap;
    
    if (anyUseGraphQL) {
      try {
        const { computeTokenUniverse } = await import('./universe.js');
        const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
        sharedMints = Array.from(universe);
        logger.info('pools.refresh.phase.fetch.shared_universe', { 
          mintCount: sharedMints.length, 
          mode: (CONFIG.system as any)?.tokenUniverseMode || 'union',
          cat: 'pools' 
        });
      } catch (err) {
        logger.warn('pools.refresh.phase.fetch.shared_universe.failed', { 
          error: String((err as any)?.message || err), 
          cat: 'pools' 
        });
        // Fetchers will fall back to computing their own universe
      }
    }
    
    if (shouldFetch.raydium) {
      try {
        const useGraphQL = (CONFIG as any)?.raydium?.useGraphQL;
        
        // Check AMM/CLMM enabled status BEFORE fetching to avoid wasted work
        const isAmmEnabled = (() => {
          if (typeof options.sources?.raydium === 'object') {
            return options.sources.raydium.amm !== false;
          }
          if (options.sources?.raydium === false) return false;
          const configRaydium = configSources.raydium;
          if (typeof configRaydium === 'object') {
            return configRaydium.amm !== false;
          }
          return configRaydium !== false;
        })();
        
        const isClmmEnabled = (() => {
          if (typeof options.sources?.raydium === 'object') {
            return options.sources.raydium.clmm !== false;
          }
          if (options.sources?.raydium === false) return false;
          const configRaydium = configSources.raydium;
          if (typeof configRaydium === 'object') {
            return configRaydium.clmm !== false;
          }
          return configRaydium !== false;
        })();
        
        const isCpmmEnabledPreCheck = (CONFIG as any)?.raydiumCpmm?.enabled !== false;
        
        logger.info('pools.refresh.phase.fetch.raydium.config', { 
          useGraphQL, 
          isAmmEnabled, 
          isClmmEnabled,
          isCpmmEnabled: isCpmmEnabledPreCheck,
          cat: 'pools' 
        });
        
        // Only fetch AMM if enabled
        if (isAmmEnabled) {
          r = useGraphQL
            ? await getRaydiumPoolsGraphQL(!!options.force, { mints: sharedMints }) 
            : await getRaydiumPoolsNormalized(!!options.force, { skipUniverseFilter: true });
        } else {
          logger.info('pools.refresh.phase.fetch.raydium.amm.skipped', { reason: 'disabled', cat: 'pools' });
        }
        
        // Only fetch CLMM if enabled (can run even if AMM is disabled)
        if (useGraphQL && isClmmEnabled) {
          try {
            // Only add delay if AMM was also fetched (to respect rate limits)
            if (isAmmEnabled) {
              const clmmPageDelayMs = Number((CONFIG as any)?.raydiumClmm?.pageDelayMs || 200);
              const interPhaseMultiplier = Number((CONFIG as any)?.raydiumClmm?.initialDelayMultiplier || 10);
              const interPhaseDelayMs = clmmPageDelayMs * interPhaseMultiplier;
              if (interPhaseDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, interPhaseDelayMs));
              }
            }
            
            const clmmResult = await getRaydiumClmmPoolsGraphQL(!!options.force, { mints: sharedMints });
            r.clmm = [...(r.clmm || []), ...(clmmResult.clmm || [])];
          } catch (err) {
            logger.warn('pools.refresh.phase.fetch.raydium.clmm.failed', { 
              error: String((err as any)?.message || err), 
              cat: 'pools' 
            });
          }
        } else if (!isClmmEnabled) {
          logger.info('pools.refresh.phase.fetch.raydium.clmm.skipped', { reason: 'disabled', cat: 'pools' });
        }
        
        // Only fetch CPMM if enabled
        const isCpmmEnabled = (() => {
          if (typeof options.sources?.raydium === 'object') {
            return (options.sources.raydium as any).cpmm !== false;
          }
          if (options.sources?.raydium === false) return false;
          const configRaydium = configSources.raydium;
          if (typeof configRaydium === 'object') {
            return (configRaydium as any).cpmm !== false;
          }
          // Check dedicated raydiumCpmm config
          return (CONFIG as any)?.raydiumCpmm?.enabled !== false;
        })();
        
        if (isCpmmEnabled && (CONFIG as any)?.raydiumCpmm?.enabled !== false) {
          try {
            // Add delay if AMM or CLMM was also fetched (to respect rate limits)
            if (isAmmEnabled || isClmmEnabled) {
              const cpmmPageDelayMs = Number((CONFIG as any)?.raydiumCpmm?.pageDelayMs || 200);
              const interPhaseMultiplier = Number((CONFIG as any)?.raydiumCpmm?.initialDelayMultiplier || 10);
              const interPhaseDelayMs = cpmmPageDelayMs * interPhaseMultiplier;
              if (interPhaseDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, interPhaseDelayMs));
              }
            }
            
            const cpmmResult = await getRaydiumCpmmPoolsGraphQL(!!options.force, { mints: sharedMints });
            r.cpmm = [...(r.cpmm || []), ...(cpmmResult.cpmm || [])];
          } catch (err) {
            logger.warn('pools.refresh.phase.fetch.raydium.cpmm.failed', { 
              error: String((err as any)?.message || err), 
              cat: 'pools' 
            });
          }
        } else if (!isCpmmEnabled) {
          logger.info('pools.refresh.phase.fetch.raydium.cpmm.skipped', { reason: 'disabled', cat: 'pools' });
        }
      } catch (err) {
        logger.warn('pools.refresh.phase.fetch.raydium.failed', { error: String((err as any)?.message || err), cat: 'pools' });
        r = { amm: [], clmm: [], cpmm: [] };
      }
    } else {
      logger.info('pools.refresh.phase.fetch.raydium.skipped', { reason: 'disabled', cat: 'pools' });
    }
    
    if (shouldFetch.orca) {
      try {
        o = (CONFIG as any)?.orca?.useGraphQL 
          ? await getOrcaPoolsGraphQL(!!options.force, { mints: sharedMints }) 
          : await getOrcaPoolsCached(!!options.force, { skipUniverseFilter: true });
        if (typeof options.sources?.orca === 'object') {
          const poolTypes = options.sources.orca;
          if (poolTypes.amm === false) o.amm = [];
          if (poolTypes.clmm === false) o.clmm = [];
        }
      } catch (err) {
        logger.warn('pools.refresh.phase.fetch.orca.failed', { error: String((err as any)?.message || err), cat: 'pools' });
        o = { amm: [], clmm: [], cpmm: [] };
      }
    } else {
      logger.info('pools.refresh.phase.fetch.orca.skipped', { reason: 'disabled', cat: 'pools' });
    }
    
    if (shouldFetch.meteora) {
      try {
        m = (CONFIG as any)?.meteora?.useGraphQL 
          ? await getMeteoraPoolsGraphQL(!!options.force, { mints: sharedMints }) 
          : await getMeteoraPoolsCached(!!options.force, { skipUniverseFilter: true });
      } catch (err) {
        logger.warn('pools.refresh.phase.fetch.meteora.failed', { error: String((err as any)?.message || err), cat: 'pools' });
        m = { amm: [], clmm: [], cpmm: [] };
      }
    } else {
      logger.info('pools.refresh.phase.fetch.meteora.skipped', { reason: 'disabled', cat: 'pools' });
    }
  }
  
  // Meteora Balanced always uses legacy path (no GraphQL)
  if (shouldFetch.meteora_balanced) {
    try {
      mb = await getMeteoraBalancedPoolsCached(!!options.force, { 
        skipUniverseFilter: true,
        fetchV1: shouldFetch.meteora_balanced_v1,
        fetchV2: shouldFetch.meteora_balanced_v2,
      });
      logger.info('pools.refresh.phase.fetch.meteora_balanced.complete', { 
        v1Enabled: shouldFetch.meteora_balanced_v1,
        v2Enabled: shouldFetch.meteora_balanced_v2,
        poolCount: mb.amm?.length || 0,
        cat: 'pools' 
      });
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.meteora_balanced.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      mb = { amm: [], clmm: [], cpmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.meteora_balanced.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  // Pumpswap in legacy path
  if (!useEarlyFilterPath && shouldFetch.pumpswap) {
    try {
      // Pass shared mints if available (from shared universe computed in legacy path)
      pump = await getPumpswapPoolsCached(!!options.force, { mints: sharedMints });
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.pumpswap.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      pump = { amm: [], clmm: [], cpmm: [] };
    }
  } else if (!useEarlyFilterPath) {
    logger.info('pools.refresh.phase.fetch.pumpswap.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  try {
    const fetchCounts = {
      raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0, cpmm: r.cpmm?.length || 0 },
      orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
      meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
      meteora_balanced: { amm: mb.amm?.length || 0, clmm: mb.clmm?.length || 0 },
      pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
    };
    phaseStats.fetch = fetchCounts;
    logger.info('pools.refresh.phase.fetch.complete', { counts: fetchCounts, earlyFiltersApplied, cat: 'pools' });
  } catch {}
  
  // === PHASE 2: FILTER BY UNIVERSE (across all DEXes) ===
  // Skip if early filters were already applied in Phase 1B
  if (earlyFiltersApplied) {
    logger.info('pools.refresh.phase.universe_filter.skipped', { reason: 'early_filters_applied', cat: 'pools' });
  } else {
    logger.info('pools.refresh.phase.universe_filter', { cat: 'pools' });
  }
  try {
    const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
    const scoped = CONFIG.system.scopePools !== false && mode !== 'none';
    if (scoped && !earlyFiltersApplied) {
      const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse(mode as any);
      const anchorBridging = !!((CONFIG.system as any)?.enableAnchorBridging);
      
      const rScoped = filterPoolsByUniverse(r as any, universe, anchorBridging);
      const oScoped = filterPoolsByUniverse(o as any, universe, anchorBridging);
      const mScoped = filterPoolsByUniverse(m as any, universe, anchorBridging);
      const mbScoped = filterPoolsByUniverse(mb as any, universe, anchorBridging);
      const pScoped = filterPoolsByUniverse(pump as any, universe, anchorBridging);
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = rScoped as any;
      o = oScoped as any;
      m = mScoped as any;
      mb = mbScoped as any;
      pump = pScoped as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      phaseStats.universe = { mode, before: beforeCounts, after: afterCounts };
      logger.info('pools.refresh.phase.universe_filter.complete', { 
        mode, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.universe_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 3: FILTER BY MINIMUM POOLS PER PAIR (first pass) ===
  // Skip if early filters were already applied in Phase 1C
  if (earlyFiltersApplied) {
    logger.info('pools.refresh.phase.min_pools_filter.skipped', { reason: 'early_filters_applied', cat: 'pools' });
  } else {
    logger.info('pools.refresh.phase.min_pools_filter', { cat: 'pools' });
  }
  try {
    const minPools = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
    if (minPools > 1 && !earlyFiltersApplied) {
      const canonicalPairKey = (mintA: string, mintB: string): string => {
        const a = String(mintA || '');
        const b = String(mintB || '');
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      
      // Count total pools per pair across all DEXes
      const poolCounts = new Map<string, number>();
      const countPools = (arr: any[]) => {
        for (const p of (arr || [])) {
          const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
          poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
        }
      };
      
      countPools(r.amm);
      countPools(r.clmm);
      countPools(r.cpmm);
      countPools(o.amm);
      countPools(o.clmm);
      countPools(m.amm);
      countPools(m.clmm);
      countPools(mb.amm);
      countPools(pump.amm);
      
      // Allow pairs with at least minPools total pools
      const allow = new Set<string>();
      for (const [k, count] of poolCounts.entries()) {
        if (count >= minPools) {
          allow.add(k);
        }
      }
      
      const filt = <T extends { mint_a: string; mint_b: string }>(arr: T[]) => 
        (arr || []).filter(p => allow.has(canonicalPairKey(p.mint_a, p.mint_b)));
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = { amm: filt(r.amm), clmm: filt(r.clmm), cpmm: filt(r.cpmm || []) } as any;
      o = { amm: filt(o.amm), clmm: filt(o.clmm) } as any;
      m = { amm: filt(m.amm), clmm: filt(m.clmm) } as any;
      mb = { amm: filt(mb.amm || []), clmm: filt(mb.clmm || []) } as any;
      pump = { amm: filt(pump.amm || []), clmm: filt(pump.clmm || []) } as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      phaseStats.minPools1 = { minPools, before: beforeCounts, after: afterCounts };
      logger.info('pools.refresh.phase.min_pools_filter.complete', { 
        minPools, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    } else {
      phaseStats.minPools1 = { minPools, before: {}, after: {} };
      logger.info('pools.refresh.phase.min_pools_filter.skipped', { 
        reason: 'minPoolsPerPair_is_1',
        minPools,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.min_pools_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 4: ENRICH ALL DEXES IN SEQUENCE ===
  // Note: Pumpswap enrichment already happens in fetchPumpswapGraphQL (RPC reserves)
  // Orca/Raydium/Meteora enrichment happens in their normalizers
  // No additional enrichment phase needed currently
  logger.info('pools.refresh.phase.enrich', { note: 'enrichment_embedded_in_normalizers', cat: 'pools' });
  
  // === PHASE 5: FILTER BY TVL/LIQUIDITY ===
  logger.info('pools.refresh.phase.tvl_filter', { cat: 'pools' });
  try {
    const minAmm = Math.max(0, Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0));
    const minClmm = Math.max(0, Number(((CONFIG.system as any)?.minClmmLiquidity) ?? 0));
    if (minAmm > 0 || minClmm > 0) {
      const valAmm = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const base = Number((p as any)?.liquidity_base ?? 0);
        return Number.isFinite(base) && base > 0 ? base : 0;
      };
      const valClmm = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const liq = Number((p as any)?.liquidity ?? 0);
        if (Number.isFinite(liq) && liq > 0) return liq;
        const raw = Number((p as any)?.pool_liquidity_raw ?? 0);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
      };
      const filt = (norm: { amm: any[]; clmm: any[]; cpmm?: any[] }) => ({
        amm: minAmm > 0 ? (norm.amm || []).filter((p: any) => valAmm(p) >= minAmm) : (norm.amm || []),
        clmm: minClmm > 0 ? (norm.clmm || []).filter((p: any) => valClmm(p) >= minClmm) : (norm.clmm || []),
        cpmm: minAmm > 0 ? (norm.cpmm || []).filter((p: any) => valAmm(p) >= minAmm) : (norm.cpmm || []),
      });
      
      const beforeCounts = {
        raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0, cp: r.cpmm?.length || 0 },
        orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
        meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
        meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
        pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
      };
      
      r = filt(r) as any;
      o = filt(o) as any;
      m = filt(m) as any;
      mb = filt(mb) as any;
      pump = filt(pump) as any;
      
      const afterCounts = {
        raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0, cp: r.cpmm?.length || 0 },
        orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
        meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
        meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
        pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
      };
      
      phaseStats.tvl = { minAmm, minClmm, before: beforeCounts, after: afterCounts };
      logger.info('pools.refresh.phase.tvl_filter.complete', { 
        minAmm, 
        minClmm, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    } else {
      phaseStats.tvl = { minAmm, minClmm, before: {}, after: {} };
      logger.info('pools.refresh.phase.tvl_filter.skipped', { 
        reason: 'thresholds_are_zero',
        minAmm, 
        minClmm,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.tvl_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 6: FILTER BY ON-CHAIN ACTIVITY ===
  logger.info('pools.refresh.phase.activity_filter', { cat: 'pools' });
  try {
    const maxInactiveMs = Number(((CONFIG.system as any)?.maxInactivePoolMs) ?? (12 * 60 * 60 * 1000)); // Default 12 hours
    const enableActivityFilter = maxInactiveMs > 0 && ((CONFIG.system as any)?.enableActivityFilter !== false);
    
    if (enableActivityFilter) {
      // Collect all pool IDs from all sources
      const allPoolIds: string[] = [];
      const poolSourceMap = new Map<string, { source: string; type: 'amm' | 'clmm' }>();
      
      const collectPools = (pools: any[], source: string, type: 'amm' | 'clmm') => {
        for (const p of pools || []) {
          if (p?.id) {
            allPoolIds.push(p.id);
            poolSourceMap.set(p.id, { source, type });
          }
        }
      };
      
      collectPools(r.amm, 'raydium', 'amm');
      collectPools(r.clmm, 'raydium', 'clmm');
      collectPools(o.amm, 'orca', 'amm');
      collectPools(o.clmm, 'orca', 'clmm');
      collectPools(m.amm, 'meteora', 'amm');
      collectPools(m.clmm, 'meteora', 'clmm');
      collectPools(mb.amm, 'meteora_balanced', 'amm');
      collectPools(pump.amm, 'pumpswap', 'amm');
      
      if (allPoolIds.length > 0) {
        const beforeCounts = {
          raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0 },
          orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
          meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
          meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
          pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
        };
        
        // Batch check activity
        const activityResults = await checkPoolsActivityBatch(
          allPoolIds,
          maxInactiveMs,
          10, // batchSize
          100 // delayBetweenBatches
        );
        
        // Filter pools based on activity
        const filterByActivity = (pools: any[]) => {
          return (pools || []).filter((p: any) => {
            const result = activityResults.get(p.id);
            return result?.active === true;
          });
        };
        
        r = {
          amm: filterByActivity(r.amm),
          clmm: filterByActivity(r.clmm),
          cpmm: filterByActivity(r.cpmm),
        } as any;
        
        o = {
          amm: filterByActivity(o.amm),
          clmm: filterByActivity(o.clmm),
        } as any;
        
        m = {
          amm: filterByActivity(m.amm),
          clmm: filterByActivity(m.clmm),
        } as any;
        
        mb = {
          amm: filterByActivity(mb.amm),
          clmm: filterByActivity(mb.clmm),
        } as any;
        
        pump = {
          amm: filterByActivity(pump.amm),
          clmm: filterByActivity(pump.clmm),
        } as any;
        
        const afterCounts = {
          raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0 },
          orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
          meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
          meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
          pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
        };
        
        // Calculate totals for summary
        const totalBefore = Object.values(beforeCounts).reduce((sum, v) => sum + v.a + v.c, 0);
        const totalAfter = Object.values(afterCounts).reduce((sum, v) => sum + v.a + v.c, 0);
        phaseStats.activity = { 
          maxInactiveMs, 
          totalChecked: allPoolIds.length,
          active: totalAfter,
          inactive: totalBefore - totalAfter
        };
        logger.info('pools.refresh.phase.activity_filter.complete', {
          maxInactiveMs,
          maxInactiveHours: Math.round(maxInactiveMs / (60 * 60 * 1000)),
          totalChecked: allPoolIds.length,
          before: beforeCounts,
          after: afterCounts,
          removed: {
            raydium: {
              a: beforeCounts.raydium.a - afterCounts.raydium.a,
              c: beforeCounts.raydium.c - afterCounts.raydium.c,
            },
            orca: {
              a: beforeCounts.orca.a - afterCounts.orca.a,
              c: beforeCounts.orca.c - afterCounts.orca.c,
            },
            meteora: {
              a: beforeCounts.meteora.a - afterCounts.meteora.a,
              c: beforeCounts.meteora.c - afterCounts.meteora.c,
            },
            meteora_balanced: {
              a: beforeCounts.meteora_balanced.a - afterCounts.meteora_balanced.a,
              c: beforeCounts.meteora_balanced.c - afterCounts.meteora_balanced.c,
            },
            pumpswap: {
              a: beforeCounts.pumpswap.a - afterCounts.pumpswap.a,
              c: beforeCounts.pumpswap.c - afterCounts.pumpswap.c,
            },
          },
          cat: 'pools',
        });
      } else {
        phaseStats.activity = { maxInactiveMs, totalChecked: 0, active: 0, inactive: 0 };
        logger.info('pools.refresh.phase.activity_filter.skipped', {
          reason: 'no_pools_to_check',
          cat: 'pools',
        });
      }
    } else {
      phaseStats.activity = { maxInactiveMs, totalChecked: 0, active: 0, inactive: 0 };
      logger.info('pools.refresh.phase.activity_filter.skipped', {
        reason: 'disabled_or_zero_threshold',
        maxInactiveMs,
        cat: 'pools',
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.activity_filter.failed', {
      error: String(e?.message || e),
      cat: 'pools',
    });
  }
  
  // === PHASE 7: FILTER BY MINIMUM POOLS PER PAIR (second pass after TVL filtering) ===
  logger.info('pools.refresh.phase.min_pools_filter_2nd', { cat: 'pools' });
  try {
    const minPools = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
    if (minPools > 1) {
      const canonicalPairKey = (mintA: string, mintB: string): string => {
        const a = String(mintA || '');
        const b = String(mintB || '');
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      
      // Count total pools per pair across all DEXes again
      const poolCounts = new Map<string, number>();
      const countPools = (arr: any[]) => {
        for (const p of (arr || [])) {
          const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
          poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
        }
      };
      
      countPools(r.amm);
      countPools(r.clmm);
      countPools(r.cpmm);
      countPools(o.amm);
      countPools(o.clmm);
      countPools(m.amm);
      countPools(m.clmm);
      countPools(mb.amm);
      countPools(pump.amm);
      
      // Allow pairs with at least minPools total pools
      const allow = new Set<string>();
      for (const [k, count] of poolCounts.entries()) {
        if (count >= minPools) {
          allow.add(k);
        }
      }
      
      const filt = <T extends { mint_a: string; mint_b: string }>(arr: T[]) => 
        (arr || []).filter(p => allow.has(canonicalPairKey(p.mint_a, p.mint_b)));
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = { amm: filt(r.amm), clmm: filt(r.clmm), cpmm: filt(r.cpmm || []) } as any;
      o = { amm: filt(o.amm), clmm: filt(o.clmm) } as any;
      m = { amm: filt(m.amm), clmm: filt(m.clmm) } as any;
      mb = { amm: filt(mb.amm || []), clmm: filt(mb.clmm || []) } as any;
      pump = { amm: filt(pump.amm || []), clmm: filt(pump.clmm || []) } as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0) + (r.cpmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      phaseStats.minPools2 = { minPools, before: beforeCounts, after: afterCounts };
      logger.info('pools.refresh.phase.min_pools_filter_2nd.complete', { 
        minPools, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    } else {
      phaseStats.minPools2 = { minPools, before: {}, after: {} };
      logger.info('pools.refresh.phase.min_pools_filter_2nd.skipped', { 
        reason: 'minPoolsPerPair_is_1',
        minPools,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.min_pools_filter_2nd.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // Update caches with filtered results
  raydiumCache.data = r;
  raydiumCache.ts = Date.now();
  orcaCache.data = o;
  orcaCache.ts = Date.now();
  meteoraCache.data = m;
  meteoraCache.ts = Date.now();
  metbalCache.data = mb;
  metbalCache.ts = Date.now();
  pumpswapCache.data = pump;
  pumpswapCache.ts = Date.now();

  // Post-fetch bootstrap: if pricing coverage is low, hydrate prices for all fetched mints and rebuild graph
  try {
    if (force) {
      const { getAllPrices } = await import('./priceStore.js');
      const mintSet = new Set<string>();
      const addFrom = (pp: PoolsPayload) => {
        try { for (const p of (pp?.amm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
        try { for (const p of (pp?.clmm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
      };
      addFrom(r); addFrom(o); addFrom(m); addFrom(mb); addFrom(pump);
      if (mintSet.size > 0) {
        const pricedMap = getAllPrices() || {};
        let pricedCount = 0;
        for (const x of mintSet) { if (typeof (pricedMap as any)[x]?.usdc === 'number') pricedCount++; }
        const coverage = pricedCount / Math.max(1, mintSet.size);
        const minPriced = Math.max(50, Number((CONFIG.system as any)?.minMintPriceBootstrap || 120));
        const minCoverage = Math.max(0.05, Math.min(0.9, Number((CONFIG.system as any)?.minMintPriceCoverage || 0.4)));
        // Removed post-refresh mass bootstrap; only report coverage metrics

        // Secondary pass: price any fetched mints outside the Jupiter token list
        // Removed secondary pass for outside-Jupiter mints
      }
    }
  } catch {}
  
  logger.info('pools.refresh.phase.complete_all_filtering', { 
    finalCounts: {
      raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0, cpmm: r.cpmm?.length || 0 },
      orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
      meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
      meteora_balanced: { amm: mb.amm?.length || 0, clmm: mb.clmm?.length || 0 },
      pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
    },
    cat: 'pools'
  });
  
  // === PHASE 8: CROSS-DEX VALIDATION & FILTERING ===
  // Validate and filter prices across DEXes after all filtering is complete
  logger.info('pools.refresh.phase.crossdex_validation', { cat: 'pools' });
  try {
    const { validateCrossDexPrices, filterAnomalousPrices } = await import('./pools/validation.js');
    const { validateCrossDexPricesSimple } = await import('./pools/comprehensiveValidation.js');
    const allPools = {
      raydium: r,
      orca: o,
      meteora: m,
      meteora_balanced: mb,
      pumpswap: pump
    };
    
    // Simple validation for logging only
    const loggingThreshold = Number((CONFIG.system as any)?.crossDexLoggingThreshold || 0.05); // 5%
    validateCrossDexPrices(allPools, loggingThreshold);
    
    // Simplified validation (no comprehensive checks)
    validateCrossDexPricesSimple(allPools, 0.10);
    
    // Filter out severe anomalies
    const filteringThreshold = Number((CONFIG.system as any)?.crossDexFilteringThreshold || 0.10); // 10%
    const filtered = filterAnomalousPrices(allPools, filteringThreshold);
    
    // Apply filtered results
    r = filtered.raydium;
    o = filtered.orca;
    m = filtered.meteora;
    mb = filtered.meteora_balanced;
    pump = filtered.pumpswap;
  } catch (e: any) {
    logger.warn('pools.refresh.phase.validation.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // Pair diagnostics: log a single SOL-USDC pool per fetcher
  try {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const compute = (p: any): { forward: number | undefined; reverse: number | undefined } => {
      try {
        const a = String(p?.mint_a || '');
        const b = String(p?.mint_b || '');
        const px = Number(p?.price_a_per_b || 0);
        if (!a || !b) return { forward: undefined, reverse: undefined };
        if (!Number.isFinite(px) || px <= 0) return { forward: undefined, reverse: undefined };
        // forward = USDC per 1 SOL
        if (a === USDC && b === SOL) return { forward: px, reverse: 1 / px };
        if (a === SOL && b === USDC) return { forward: 1 / px, reverse: px };
        return { forward: undefined, reverse: undefined };
      } catch { return { forward: undefined, reverse: undefined }; }
    };
    const pickOne = (pools: PoolsPayload): any => {
      for (const p of (pools?.clmm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      for (const p of (pools?.amm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      return null;
    };
    const rayPick = pickOne(r);
    if (rayPick) {
      const { forward, reverse } = compute(rayPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'raydium', id: rayPick.id, kind: rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=raydium id=${rayPick.id} kind=${rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'invalid_price_or_orientation', id: rayPick.id, a: rayPick.mint_a, b: rayPick.mint_b, px: rayPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=raydium reason=invalid_price_or_orientation id=${rayPick.id} a=${rayPick.mint_a} b=${rayPick.mint_b} px=${rayPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=raydium reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const orcPick = pickOne(o);
    if (orcPick) {
      const { forward, reverse } = compute(orcPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'orca', id: orcPick.id, kind: orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=orca id=${orcPick.id} kind=${orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'invalid_price_or_orientation', id: orcPick.id, a: orcPick.mint_a, b: orcPick.mint_b, px: orcPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=orca reason=invalid_price_or_orientation id=${orcPick.id} a=${orcPick.mint_a} b=${orcPick.mint_b} px=${orcPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=orca reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const metPick = pickOne(m);
    if (metPick) {
      const { forward, reverse } = compute(metPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'meteora', id: metPick.id, kind: metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=meteora id=${metPick.id} kind=${metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'invalid_price_or_orientation', id: metPick.id, a: metPick.mint_a, b: metPick.mint_b, px: metPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=meteora reason=invalid_price_or_orientation id=${metPick.id} a=${metPick.mint_a} b=${metPick.mint_b} px=${metPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=meteora reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const pumpPick = pickOne(pump);
    if (pumpPick) {
      const { forward, reverse } = compute(pumpPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'pumpswap', id: pumpPick.id, kind: pumpPick.pool_kind || 'amm', forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=pumpswap id=${pumpPick.id} kind=${pumpPick.pool_kind || 'amm'} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'pumpswap', reason: 'invalid_price_or_orientation', id: pumpPick.id, a: pumpPick.mint_a, b: pumpPick.mint_b, px: pumpPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=pumpswap reason=invalid_price_or_orientation id=${pumpPick.id} a=${pumpPick.mint_a} b=${pumpPick.mint_b} px=${pumpPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'pumpswap', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=pumpswap reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
  } catch (e:any) {
    try { logger.warn('pools.pair_sol_usdc.failed', { error: String(e?.message || e), cat: 'pools' }); } catch {}
    try { emit('log', { level: 'warn', message: `pools:pair_sol_usdc.failed error=${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  }
  // Resume watchlist price feed based on prior state or watchlist
  try {
    if (force) {
      const reg: any = await import('./feedRegistry.js');
      const wantResume = (refreshAllSources as any).__resumeFeed === true || reg.isPriceFeedEnabled?.() === true;
      delete (refreshAllSources as any).__resumeFeed;
      const fsmod: any = await import('../utils/fs.js');
      const wl = await fsmod.readJson(CONFIG.watchlistPath, [] as any[]);
      const shouldEnable = wantResume || (Array.isArray(wl) && wl.length > 0);
      reg.enablePriceFeed?.(shouldEnable);
      try { emit('log', { level: 'info', message: `pools:bootstrap feed.resume enabled=${shouldEnable}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      try { logger.info(`pools:bootstrap feed.resume enabled=${shouldEnable}`, { cat: 'pools' }); } catch {}
    }
  } catch {}
  
  // === PHASE 7: SUBSCRIBE TO RETAINED POOLS PER DEX IN SEQUENCE ===
  // When pool persistence is enabled, subscriptions require manual trigger via retarget button
  // unless autoStartSubscriptions is explicitly set to true
  let shouldSubscribe = options.subscribe;
  try {
    const { shouldAutoStartSubscriptions } = await import('./pools.persistence.js');
    if (!shouldAutoStartSubscriptions()) {
      shouldSubscribe = false;
      logger.info('pools.refresh.phase.subscribe.manual_control', { 
        message: 'Pool persistence enabled - use retarget button to start subscriptions',
        cat: 'pools' 
      });
      try {
        emit('log', {
          level: 'info',
          message: 'pools:subscriptions require manual start - use retarget button',
          timestamp: new Date().toISOString(),
          context: { cat: 'pools' }
        });
      } catch {}
    }
  } catch {}
  
  if (shouldSubscribe) {
    logger.info('pools.refresh.phase.subscribe', { enabled: shouldFetch, cat: 'pools' });
    try {
      // Sequential subscription: enable WS and start refresh loop
      // The refresh loop internally handles sequential DEX subscription via startPoolWebsocketsOnlyOnce
      enablePoolWebsocketRefreshes();
      
      // Small delay to ensure WS connection is fully established before subscribing
      await new Promise(resolve => setTimeout(resolve, 500));
      
      logger.info('pools.refresh.phase.subscribe.start_loop', { cat: 'pools' });
      startPoolWebsocketsOnlyOnce();
      
      logger.info('pools.refresh.phase.subscribe.complete', { cat: 'pools' });
    } catch (e: any) {
      logger.warn('pools.refresh.phase.subscribe.failed', { error: String(e?.message || e), cat: 'pools' });
    }
  }
  // One-shot consolidated graph push after initial forced refresh completes (guarded)
  try {
    (refreshAllSources as any).__didInitialGraphPush = (refreshAllSources as any).__didInitialGraphPush || false;
    if (options.force && !(refreshAllSources as any).__didInitialGraphPush) {
      const gmod: any = await import('./graph.js');
      try { await gmod.rebuildGraphNow(); } catch {}
      // Ensure websocket-based pool refreshes are enabled immediately after first graph build
      try { const pools = await import('./pools.js'); (pools as any).enablePoolWebsocketRefreshes?.(); } catch {}
      (refreshAllSources as any).__didInitialGraphPush = true;
    }
  } catch {}
  
  // Clear the in-progress flag now that all filtering and graph building is complete
  (refreshAllSources as any).__inProgress = false;
  (refreshAllSources as any).__isRunning = false;
  
  // Build comprehensive refresh summary
  const refreshDurationMs = Date.now() - refreshStartTime;
  const finalCounts = {
    raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0, cpmm: r.cpmm?.length || 0 },
    orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
    meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
    meteora_balanced: { amm: mb.amm?.length || 0, clmm: mb.clmm?.length || 0 },
    pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
  };
  const totalFinal = Object.values(finalCounts).reduce((sum, v) => sum + v.amm + v.clmm + ((v as any).cpmm || 0), 0);
  const totalFetched = phaseStats.fetch 
    ? Object.values(phaseStats.fetch).reduce((sum, v) => sum + v.amm + v.clmm + ((v as any).cpmm || 0), 0) 
    : 0;
  
  const refreshSummary = {
    durationMs: refreshDurationMs,
    durationSec: Math.round(refreshDurationMs / 100) / 10,
    totalFetched,
    totalFinal,
    dropRate: totalFetched > 0 ? `${Math.round((1 - totalFinal / totalFetched) * 100)}%` : 'n/a',
    phases: {
      fetch: phaseStats.fetch,
      universe: phaseStats.universe ? {
        mode: phaseStats.universe.mode,
        dropped: Object.entries(phaseStats.universe.before).reduce((sum, [k, v]) => 
          sum + (v - ((phaseStats.universe?.after as any)?.[k] || 0)), 0)
      } : undefined,
      minPools1: phaseStats.minPools1 ? {
        threshold: phaseStats.minPools1.minPools,
        before: Object.values(phaseStats.minPools1.before).reduce((a, b) => a + b, 0),
        after: Object.values(phaseStats.minPools1.after).reduce((a, b) => a + b, 0),
      } : undefined,
      tvl: phaseStats.tvl ? {
        minAmm: phaseStats.tvl.minAmm,
        minClmm: phaseStats.tvl.minClmm,
        before: Object.values(phaseStats.tvl.before).reduce((sum, v) => sum + v.a + v.c, 0),
        after: Object.values(phaseStats.tvl.after).reduce((sum, v) => sum + v.a + v.c, 0),
      } : undefined,
      activity: phaseStats.activity ? {
        maxInactiveHours: Math.round((phaseStats.activity.maxInactiveMs || 0) / (60 * 60 * 1000)),
        checked: phaseStats.activity.totalChecked,
        active: phaseStats.activity.active,
        inactive: phaseStats.activity.inactive,
      } : undefined,
      minPools2: phaseStats.minPools2 ? {
        threshold: phaseStats.minPools2.minPools,
        before: Object.values(phaseStats.minPools2.before).reduce((a, b) => a + b, 0),
        after: Object.values(phaseStats.minPools2.after).reduce((a, b) => a + b, 0),
      } : undefined,
    },
    final: finalCounts,
  };
  
  logger.info('pools.refresh.summary', { ...refreshSummary, cat: 'pools' });
  
  logger.info('pools.refresh.complete', { 
    durationMs: refreshDurationMs,
    totalPools: totalFinal,
    cat: 'pools' 
  });
  
  return { raydium: r, orca: o, meteora: m, meteora_balanced: mb, pumpswap: pump };
}


export async function getMeteoraBalancedPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean; fetchV1?: boolean; fetchV2?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraBalancedPoolsCached as any).__lastForceAt = (getMeteoraBalancedPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  
  // Determine which versions to fetch (default to both)
  const fetchV1 = opts?.fetchV1 ?? true;
  const fetchV2 = opts?.fetchV2 ?? true;
  
  if (!force) {
    if (metbalCache.data && now - metbalCache.ts < ttlMs) return metbalCache.data;
    return metbalCache.data || { amm: [], clmm: [], cpmm: [] };
  }
  if (force) {
    const last = (getMeteoraBalancedPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && metbalCache.data) return metbalCache.data as any;
    (getMeteoraBalancedPoolsCached as any).__lastForceAt = now;
  }
  if (metbalCache.inflight) return metbalCache.inflight;
  metbalCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      // Use union of v2+v1 with version filtering
      const union = await fetchMeteoraBalancedAllImpl({ fetchV1, fetchV2 }).catch(async () => {
        const raw = await fetchMeteoraBalancedHttpImpl();
        return await normalizeMeteoraBalancedHttpImpl(raw);
      });
      const norm = union;
      
      // Save raw normalized pools (before filtering) for debugging/analysis
      try {
        const { saveRawNormalizedPools } = await import('./pools.persistence.js');
        await saveRawNormalizedPools('meteoraBalanced', norm);
      } catch {}
      
      const prev = metbalCache.data;
      metbalCache.data = norm; metbalCache.ts = Date.now();
      poolsMetrics.meteora_balanced.fetches = (poolsMetrics.meteora_balanced.fetches || 0) + 1;
      poolsMetrics.meteora_balanced.lastMs = Date.now();
      poolsMetrics.meteora_balanced.lastAmm = (norm.amm || []).length;
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [], cpmm: [] }, norm);
        emit('pools-update', { source: 'meteora_balanced', amm: (norm.amm || []).length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'meteora_balanced', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample: { amm: d.amm.slice(0, 50), clmm: [] }, ts: Date.now() });
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        // Skip incremental updates during startup/refresh - let refreshAllSources rebuild after filtering
        const skipIncremental = (refreshAllSources as any).__inProgress === true;
        if (!skipIncremental) {
          try {
            const gmod: any = await import('./graph.js');
            if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
              // Fire-and-forget: don't await to avoid blocking HTTP fetchers
              // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
              void gmod.applyPoolUpdates(prev || { amm: [], clmm: [], cpmm: [] }, norm, { pushToArb: false }).catch((err: any) => {
                try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'meteora_balanced', cat: 'graph' }); } catch {}
              });
            } else if (!inc && hasDelta) {
              // Non-incremental mode: schedule rebuild only (only one path)
              const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
              const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
              // Only schedule if threshold met (0 means always, but check delta > 0 to avoid empty rebuilds)
              if ((thresh === 0 && delta > 0) || delta >= thresh) {
                gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
              }
            }
          } catch {}
        } else {
          try { logger.debug('graph.update.skipped_during_refresh', { source: 'meteora_balanced', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
        }
      } catch {}
      return norm;
    } finally {
      metbalCache.inflight = undefined;
    }
  })();
  return metbalCache.inflight;
}

export async function getPumpswapPoolsCached(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  const ttlMs = Number((CONFIG as any)?.pumpswap?.cacheTtlMs || 60_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getPumpswapPoolsCached as any).__lastForceAt = (getPumpswapPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (pumpswapCache.data && now - pumpswapCache.ts < ttlMs) return pumpswapCache.data;
    return pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
  }
  if (force) {
    const last = (getPumpswapPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && pumpswapCache.data) return pumpswapCache.data as any;
    (getPumpswapPoolsCached as any).__lastForceAt = now;
  }
  if (pumpswapCache.inflight) return pumpswapCache.inflight;
  pumpswapCache.inflight = (async () => {
    try {
      const mode = 'graphql';
      try { logger.info('pumpswap.fetch start', { mode, ttlMs, shared: !!opts?.mints, cat: 'pumpswap' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools pumpswap.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      const t0 = Date.now();
      // Pass shared mints if provided (from shared universe)
      const raw = await fetchPumpswapGraphQLImpl(opts?.mints);
      
      // Enrich pools with RPC data (token account balances)
      const enrichResult = await enrichPumpswapPoolsWithRpcImpl(raw);
      const enrichedRaw = enrichResult.pools || raw;
      poolsMetrics.pumpswap.enrichmentSuccess = enrichResult.metrics?.success || 0;
      poolsMetrics.pumpswap.enrichmentFail = enrichResult.metrics?.fail || 0;
      poolsMetrics.pumpswap.enrichmentMs = enrichResult.metrics?.ms || 0;
      
      let norm = await normalizePumpswapPoolsImpl(enrichedRaw);
      
      // Save raw normalized pools (before filtering) for debugging/analysis
      try {
        const { saveRawNormalizedPools } = await import('./pools.persistence.js');
        await saveRawNormalizedPools('pumpswap', norm);
      } catch {}
      
      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeAmm = (norm.amm || []).length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if ((filtered.amm || []).length !== beforeAmm) {
            try { logger.info('pumpswap.blocklist.filter', { beforeAmm, afterAmm: filtered.amm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}
      
      // Apply TVL-based filtering (similar to Raydium)
      try {
        const globalAmm = Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0);
        const minAmmUsd = Math.max(globalAmm, Number(((CONFIG as any)?.pumpswap?.minLiqBase) || 0));
        if (minAmmUsd > 0) {
          const beforeAmm = norm.amm.length;
          const amm = norm.amm.filter(p => Number((p as any).liquidity_base || 0) >= minAmmUsd);
          if (amm.length !== beforeAmm) { 
            try { logger.info('pumpswap.filter tvl', { minAmmUsd, beforeAmm, afterAmm: amm.length, cat: 'pumpswap' }); } catch {} 
          }
          norm = { amm, clmm: [] } as any;
        }
      } catch {}
      
      // Cross-DEX price validation for Pumpswap pools
      try {
        const enableValidation = ((CONFIG as any)?.pumpswap?.validatePrices !== false);
        const maxSamples = Number(((CONFIG as any)?.pumpswap?.validationSamples || 5));
        if (enableValidation && norm.amm.length > 0) {
          // Get other DEX pools for comparison
          const rayPools = raydiumCache.data?.amm || [];
          const orcaPools = orcaCache.data?.amm || [];
          const metPools = metbalCache.data?.amm || [];
          
          // Build a map of (mint_a, mint_b) -> pools from other DEXes
          const otherDexPools = new Map<string, Array<{ dex: string; price: number; liquidity: number; pool: any }>>();
          const addPool = (pools: any[], dexName: string) => {
            for (const p of pools) {
              if (!p.mint_a || !p.mint_b || !p.price_a_per_b || p.price_a_per_b <= 0) continue;
              const key = `${p.mint_a}:${p.mint_b}`;
              if (!otherDexPools.has(key)) otherDexPools.set(key, []);
              otherDexPools.get(key)!.push({
                dex: dexName,
                price: p.price_a_per_b,
                liquidity: Number((p as any).liquidity_base || (p as any).tvl_usd || 0),
                pool: p
              });
            }
          };
          addPool(rayPools, 'Raydium');
          addPool(orcaPools, 'Orca');
          addPool(metPools, 'Meteora');
          
          // Compare Pumpswap pools against other DEXes
          let compared = 0;
          let withinTolerance = 0;
          let outsideTolerance = 0;
          const samples: any[] = [];
          
          for (const pump of norm.amm) {
            if (!pump.price_a_per_b || pump.price_a_per_b <= 0) continue;
            const key = `${pump.mint_a}:${pump.mint_b}`;
            const others = otherDexPools.get(key);
            if (!others || others.length === 0) continue;
            
            // Compare against the most liquid pool from other DEXes
            const mostLiquid = others.reduce((best, curr) => 
              curr.liquidity > best.liquidity ? curr : best
            );
            
            const pumpPrice = pump.price_a_per_b;
            const otherPrice = mostLiquid.price;
            const deviation = Math.abs(pumpPrice - otherPrice) / otherPrice;
            const deviationPct = (deviation * 100).toFixed(2);
            
            compared++;
            
            // Log if deviation exceeds 5%
            if (deviation > 0.05) {
              outsideTolerance++;
              if (samples.length < maxSamples) {
                samples.push({
                  pair: `${pump.mint_a.slice(0, 6)}.../${pump.mint_b.slice(0, 6)}...`,
                  pumpPrice: pumpPrice.toFixed(6),
                  pumpLiq: Number((pump as any).liquidity_base || 0).toFixed(2),
                  otherDex: mostLiquid.dex,
                  otherPrice: otherPrice.toFixed(6),
                  otherLiq: mostLiquid.liquidity.toFixed(2),
                  deviationPct: `${deviationPct}%`,
                  poolId: pump.id.slice(0, 8) + '...'
                });
              }
            } else {
              withinTolerance++;
            }
          }
          
          if (compared > 0) {
            try {
              logger.info('pumpswap.price.validation', {
                compared,
                withinTolerance,
                outsideTolerance,
                tolerancePct: 5,
                cat: 'pumpswap'
              });
              
              if (samples.length > 0) {
                logger.warn('pumpswap.price.deviations', {
                  count: samples.length,
                  samples,
                  cat: 'pumpswap'
                });
              }
            } catch {}
          }
        }
      } catch (e: any) {
        try { logger.warn('pumpswap.price.validation.error', { error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
      }
      
      const prev = pumpswapCache.data;
      pumpswapCache.data = norm; pumpswapCache.ts = Date.now();
      poolsMetrics.pumpswap.fetches += 1;
      poolsMetrics.pumpswap.lastMs = Date.now();
      poolsMetrics.pumpswap.lastAmm = norm.amm.length;
      try { logger.info('pumpswap.fetch normalized', { amm: norm.amm.length, ms: Date.now() - t0, cat: 'pumpswap' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools pumpswap.fetch ok amm=${norm.amm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [], cpmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: [] };
        emit('pools-update', { source: 'pumpswap', amm: norm.amm.length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'pumpswap', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        // Skip incremental updates during startup/refresh - let refreshAllSources rebuild after filtering
        const skipIncremental = (refreshAllSources as any).__inProgress === true;
        if (!skipIncremental) {
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
              // Fire-and-forget: don't await to avoid blocking HTTP fetchers
              // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
              void gmod.applyPoolUpdates(prev || { amm: [], clmm: [], cpmm: [] }, norm, { pushToArb: false }).catch((err: any) => {
                try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'pumpswap', cat: 'graph' }); } catch {}
              });
            }
          } catch {}
        } else {
          try { logger.debug('graph.update.skipped_during_refresh', { source: 'pumpswap', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
        }
      } catch {}
      return pumpswapCache.data!;
    } finally {
      pumpswapCache.inflight = undefined;
    }
  })();
  return pumpswapCache.inflight;
}
export async function getRaydiumPoolsNormalized(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(CONFIG.raydium?.cacheTtlMs || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getRaydiumPoolsNormalized as any).__lastForceAt = (getRaydiumPoolsNormalized as any).__lastForceAt || 0;
  const now = Date.now();
  // Capture opts for use in closure
  const skipUniverseFilter = opts?.skipUniverseFilter === true;
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (raydiumCache.data && now - raydiumCache.ts < ttlMs) return raydiumCache.data;
    return raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
  }
  if (force) {
    const last = (getRaydiumPoolsNormalized as any).__lastForceAt as number;
    if (now - last < minForceGap && raydiumCache.data) return raydiumCache.data;
    (getRaydiumPoolsNormalized as any).__lastForceAt = now;
  }
  if (raydiumCache.inflight) return raydiumCache.inflight;

  raydiumCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const mode = 'api';
      logger.info('raydium.fetch start', {
        mode,
        ttlMs,
        concurrency: Number(CONFIG.raydium?.sdkConcurrency || 8),
        uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
        anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
        includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
        canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
        cat: 'raydium'
      });
        try { emit('log', { level: 'info', message: `arb:pools raydium.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      const raw: any = await fetchRaydiumPoolsRawImpl();
      let norm = await normalizeRaydiumPoolsImpl(raw);
      
      // Populate execution cache with enriched pool data (including market accounts)
      // This ensures instruction builders have access to all required Serum market accounts
      try {
        const { executionCache } = await import('../execution/cache.js');
        
        // Populate AMM pools with market accounts
        for (const pool of norm.amm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: pool.dex === 'Raydium' ? '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' : (existing.programId || ''),
          };
          
          // CRITICAL: Store pool mints and decimals (required for correct Serum market orientation)
          // The pool's mint_a/mint_b must match the Serum market's base/quote orientation
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          
          // Add market accounts for Raydium AMM pools (required for swap execution)
          if (pool.market_id) staticData.market_id = pool.market_id;
          if (pool.market_program_id) staticData.market_program_id = pool.market_program_id;
          if (pool.market_bids) staticData.market_bids = pool.market_bids;
          if (pool.market_asks) staticData.market_asks = pool.market_asks;
          if (pool.market_event_queue) staticData.market_event_queue = pool.market_event_queue;
          if (pool.market_base_vault) staticData.market_base_vault = pool.market_base_vault;
          if (pool.market_quote_vault) staticData.market_quote_vault = pool.market_quote_vault;
          if (pool.market_authority) staticData.market_authority = pool.market_authority;
          // CRITICAL: Store AMM authority - required for transaction building
          // For Raydium AMM v4, the authority is hardcoded and not stored in pool data
          // Always use the hardcoded v4 authority for Raydium AMM pools
          if (staticData.programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
            staticData.amm_authority = (CONFIG as any)?.raydium?.ammV4Authority || '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
          } else {
            // For other versions, try to extract from pool data (fallback)
            if (pool.amm_authority) staticData.amm_authority = pool.amm_authority;
            if (pool.owner) staticData.owner = pool.owner; // Fallback field name
          }
          if (pool.amm_open_orders) staticData.amm_open_orders = pool.amm_open_orders;
          if (pool.amm_target_orders) staticData.amm_target_orders = pool.amm_target_orders;
          if (pool.lp_mint) staticData.lp_mint = pool.lp_mint;
          
          // DEBUG: Log authority storage for WSOL-USDC pool
          if (pool.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2') {
            try {
              logger.info('raydium.amm.cache_authority_debug', {
                cat: 'pools',
                ctx: {
                  poolId: pool.id,
                  programId: staticData.programId,
                  isV4: staticData.programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
                  ammAuthority: pool.amm_authority,
                  owner: pool.owner,
                  storedAmmAuthority: staticData.amm_authority,
                  storedOwner: staticData.owner,
                  hardcodedV4Authority: (CONFIG as any)?.raydium?.ammV4Authority || '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
                  allPoolFields: Object.keys(pool).filter(k => k.includes('auth') || k.includes('owner'))
                }
              });
            } catch {}
          }
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        // Populate CLMM pools with execution-critical accounts
        for (const pool of norm.clmm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
            dex: 'Raydium',
          };
          
          // Store pool mints and decimals
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          
          // Store execution-critical accounts (observation_state, ex_bitmap)
          if (pool.observation_state) staticData.observation_state = pool.observation_state;
          if (pool.ex_bitmap) staticData.ex_bitmap = pool.ex_bitmap;
          
          // Store vault/account references
          if (pool.account_a) staticData.account_a = pool.account_a;
          if (pool.account_b) staticData.account_b = pool.account_b;
          
          // Store tick spacing
          if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        // Log successful cache population for our target pool
        try {
          const targetPool = norm.amm?.find((p: any) => p.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
          if (targetPool) {
            logger.info('raydium.execution_cache.target_pool_populated', {
              cat: 'pools',
              ctx: {
                poolId: targetPool.id,
                hasMarketId: !!targetPool.market_id,
                hasMarketBids: !!targetPool.market_bids,
                hasMarketAsks: !!targetPool.market_asks,
                hasAmmAuthority: !!targetPool.amm_authority
              }
            });
          }
        } catch {}
        
        logger.info('raydium.execution_cache.populated', {
          cat: 'pools',
          ctx: { 
            ammCount: norm.amm?.length || 0, 
            clmmCount: norm.clmm?.length || 0,
            clmmWithExBitmap: (norm.clmm || []).filter((p: any) => p.ex_bitmap).length,
            clmmWithObservationState: (norm.clmm || []).filter((p: any) => p.observation_state).length,
          }
        });
      } catch (err) {
        logger.warn('raydium.execution_cache.populate.failed', {
          cat: 'pools',
          ctx: { error: String((err as any)?.message || err) }
        });
      }
      
      // Save raw normalized pools (before filtering) for debugging/analysis
      try {
        const { saveRawNormalizedPools } = await import('./pools.persistence.js');
        await saveRawNormalizedPools('raydium', norm);
      } catch {}
      
      // Apply universe filtering early so caches are consistent across sources
      try {
        if (!skipUniverseFilter) {
          const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
          const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
          const uni = await computeTokenUniverse(mode);
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
          if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
            poolsMetrics.raydium.filteredAmm += (beforeAmm - scoped.amm.length);
            poolsMetrics.raydium.filteredClmm += (beforeClmm - scoped.clmm.length);
            poolsMetrics.raydium.universe = String(mode);
            try { logger.info('raydium.universe.filter', { mode, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
          }
          norm = scoped as any;
        }
      } catch {}

      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
            try { logger.info('raydium.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}

      // Optional: TVL-based filtering to drop dust pools (config-driven)
      try {
        const globalAmm = Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0);
        const globalClmm = Number(((CONFIG.system as any)?.minClmmLiquidity) ?? 0);
        const minAmmUsd = Math.max(globalAmm, Number((CONFIG.raydium as any)?.minAmmLiqBase || 0));
        const minClmmUsd = Math.max(globalClmm, Number((CONFIG.raydium as any)?.minClmmLiquidity || 0));
        if (minAmmUsd > 0 || minClmmUsd > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const amm = minAmmUsd > 0 ? norm.amm.filter(p => Number((p as any).tvl_usd || 0) >= minAmmUsd) : norm.amm;
          const clmm = minClmmUsd > 0 ? norm.clmm.filter(p => Number((p as any).tvl_usd || 0) >= minClmmUsd) : norm.clmm;
          if (amm.length !== beforeAmm || clmm.length !== beforeClmm) { logger.info('raydium.filter tvl', { minAmmUsd, minClmmUsd, beforeAmm, beforeClmm, afterAmm: amm.length, afterClmm: clmm.length }); }
          norm = { amm, clmm } as any;
        }
      } catch {}

      poolsMetrics.raydium.fetches += 1;
      poolsMetrics.raydium.lastMs = Date.now();
      poolsMetrics.raydium.lastAmm = norm.amm.length;
      poolsMetrics.raydium.lastClmm = norm.clmm.length;
      logger.info('raydium.fetch normalized', { amm: norm.amm.length, clmm: norm.clmm.length, ms: Date.now() - t0, cat: 'raydium', canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
      try { emit('log', { level: 'info', message: `arb:pools raydium.fetch ok amm=${norm.amm.length} clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      // Register Raydium CLMM pools for eligibility tracking
      // This enables reactive filtering when tick moves in/out of safe range
      try {
        const { registerRaydiumPoolsForEligibility } = await import('./pools.websockets.js');
        const eligibilityStats = registerRaydiumPoolsForEligibility(norm.clmm || []);
        logger.info('raydium.eligibility.registered', {
          cat: 'pools',
          ctx: eligibilityStats
        });
      } catch (eligibilityErr) {
        // Non-fatal - log and continue
        logger.debug('raydium.eligibility.register_failed', {
          cat: 'pools',
          ctx: { error: String((eligibilityErr as any)?.message || eligibilityErr) }
        });
      }

      const prev = raydiumCache.data;
      raydiumCache.data = norm;
      raydiumCache.ts = Date.now();

      // Populate execution cache with Raydium pool data (HTTP path)
      // This ensures instruction builders have access to execution-critical accounts
      try {
        const { populateExecutionCacheFromPools } = await import('./pools.persistence.js');
        populateExecutionCacheFromPools(norm, 'Raydium');
        logger.debug('raydium.http.execution_cache.populated', {
          cat: 'pools',
          ctx: {
            amm: norm.amm.length,
            clmm: norm.clmm.length,
          }
        });
      } catch (e: any) {
        logger.warn('raydium.http.execution_cache.population.failed', {
          cat: 'pools',
          ctx: { error: String(e?.message || e) }
        });
      }

      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = norm.amm.length;
        const nextClmm = norm.clmm.length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'raydium', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=raydium amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [], cpmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        // Skip incremental updates during startup/refresh - let refreshAllSources rebuild after filtering
        const skipIncremental = (refreshAllSources as any).__inProgress === true;
        if (!skipIncremental) {
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
              // Fire-and-forget: don't await to avoid blocking HTTP fetchers
              // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
              void gmod.applyPoolUpdates(prev || { amm: [], clmm: [], cpmm: [] }, norm, { pushToArb: false }).catch((err: any) => {
                try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'raydium', cat: 'graph' }); } catch {}
              });
            }
          } catch {}
        } else {
          try { logger.debug('graph.update.skipped_during_refresh', { source: 'raydium', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
        }
        try { logger.info('pools.delta raydium', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
      } catch {}
      // Cross-DEX validation moved to refreshAllSources after all filtering (Phase 8)
      // Opportunistic price warmup (anchors + top-N pool mints) after first source completes
      try {
        const sys: any = (CONFIG as any)?.system || {};
        const enable = sys.warmPricesOnStart !== false;
        if (enable && !(refreshAllSources as any).__didWarmPricesOnce) {
          const topN = Math.max(10, Number(sys.priceWarmTopN || 200));
          const collect = (pp: { amm: any[]; clmm: any[] }) => {
            const arr = [...(pp.amm || []), ...(pp.clmm || [])];
            return arr.map(p => ({
              mints: [String(p.mint_a || ''), String(p.mint_b || '')],
              tvl: Number((p as any)?.tvl_usd ?? (p as any)?.liquidity_display ?? 0)
            }));
          };
          const items = [
            ...collect(raydiumCache.data || { amm: [], clmm: [], cpmm: [] }),
            ...collect(orcaCache.data || { amm: [], clmm: [], cpmm: [] }),
            ...collect(meteoraCache.data || { amm: [], clmm: [], cpmm: [] }),
            ...collect(metbalCache.data || { amm: [], clmm: [], cpmm: [] }),
          ];
          const ranked = items.sort((a,b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, topN);
          const set = new Set<string>();
          for (const it of ranked) { for (const m of (it.mints || [])) if (m) set.add(m); }
          // Always include anchors
          set.add('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
          set.add('So11111111111111111111111111111111111111112');
          const ids = Array.from(set);
          if (ids.length) {
            const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
            const fresh = await fetchPricesByMints(ids, { catOverride: 'priceWarm', ignorePause: true });
            const priceStore = await import('./priceStore.js');
            priceStore.setPrices(fresh as any);
            (refreshAllSources as any).__didWarmPricesOnce = true;
          }
        }
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here

      return norm;
    } finally {
      raydiumCache.inflight = undefined;
    }
  })();

  return raydiumCache.inflight;
}

export async function getRaydiumPoolsGraphQL(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  try {
    // Use provided mints if available (from shared universe), otherwise compute
    let mints: string[];
    if (opts?.mints && opts.mints.length > 0) {
      mints = opts.mints;
    } else {
      const { computeTokenUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
    }
    
    // CRITICAL: Always include anchor tokens in mints list for GraphQL queries
    // This ensures we can find pools containing SOL/USDC/USDT even if they're not in the universe
    // Anchor bridging only affects filtering AFTER fetching, not what we query
    const { getAnchorSet } = await import('./universe.js');
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    
    logger.info('raydium.graphql.fetch.start', { mintCount: mints.length, anchorCount: anchors.size, shared: !!opts?.mints, cat: 'raydium' });
    
    const { fetchRaydiumGraphQL, normalizeRaydiumGraphQL } = await import('./pools/raydiumGraphQL.js');
    const raw = await fetchRaydiumGraphQL(mints);
    const normalized = await normalizeRaydiumGraphQL(raw);
    
    // Update cache
    raydiumCache.data = normalized;
    raydiumCache.ts = Date.now();
    
    // Write to disk cache
    const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-pools-graphql.json');
    try { await writeJson(CACHE_PATH, normalized); } catch {}
    
    // Emit to websocket
    try { emit('pools:raydium', normalized); } catch {}
    
    // Populate execution cache with Raydium pool data (GraphQL path)
    try {
      const { executionCache } = await import('../execution/cache.js');
      
      // Populate AMM pools
      for (const pool of normalized.amm || []) {
        const existing = executionCache.getStatic(pool.id) || {} as any;
        const staticData: any = {
          ...existing,
          programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        };
        
        // Store pool mints and decimals
        if (pool.mint_a) staticData.mint_a = pool.mint_a;
        if (pool.mint_b) staticData.mint_b = pool.mint_b;
        if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
        if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
        
        // Store market accounts for Raydium AMM
        if (pool.market_id) staticData.market_id = pool.market_id;
        if (pool.market_program_id) staticData.market_program_id = pool.market_program_id;
        if (pool.market_bids) staticData.market_bids = pool.market_bids;
        if (pool.market_asks) staticData.market_asks = pool.market_asks;
        if (pool.market_event_queue) staticData.market_event_queue = pool.market_event_queue;
        if (pool.market_base_vault) staticData.market_base_vault = pool.market_base_vault;
        if (pool.market_quote_vault) staticData.market_quote_vault = pool.market_quote_vault;
        if (pool.market_authority) staticData.market_authority = pool.market_authority;
        
        // Store AMM authority (use hardcoded v4 authority)
        staticData.amm_authority = (CONFIG as any)?.raydium?.ammV4Authority || '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
        if ((pool as any).amm_open_orders || (pool as any).open_orders) {
          staticData.amm_open_orders = (pool as any).amm_open_orders || (pool as any).open_orders;
        }
        if ((pool as any).amm_target_orders || (pool as any).target_orders) {
          staticData.amm_target_orders = (pool as any).amm_target_orders || (pool as any).target_orders;
        }
        if (pool.lp_mint) staticData.lp_mint = pool.lp_mint;
        
        // Store vault/account references
        if (pool.account_a) staticData.account_a = pool.account_a;
        if (pool.account_b) staticData.account_b = pool.account_b;
        
        executionCache.setStatic(pool.id, staticData);
      }
      
      // Populate CLMM pools
      for (const pool of normalized.clmm || []) {
        const existing = executionCache.getStatic(pool.id) || {} as any;
        const staticData: any = {
          ...existing,
          programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          dex: 'Raydium',
        };
        
        if (pool.mint_a) staticData.mint_a = pool.mint_a;
        if (pool.mint_b) staticData.mint_b = pool.mint_b;
        if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
        if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
        if ((pool as any).observation_state) staticData.observation_state = (pool as any).observation_state;
        if ((pool as any).ex_bitmap) staticData.ex_bitmap = (pool as any).ex_bitmap;
        if (pool.account_a) staticData.account_a = pool.account_a;
        if (pool.account_b) staticData.account_b = pool.account_b;
        if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
        
        executionCache.setStatic(pool.id, staticData);
        
        // Also populate hot cache with price/tick data if available
        const hotData: any = { dex: 'raydium' };
        let hasHotData = false;
        
        if (pool.sqrt_price_x64 !== undefined) {
          hotData.sqrtPriceX64 = BigInt(String(pool.sqrt_price_x64));
          hasHotData = true;
        }
        if ((pool as any).tick_current !== undefined) {
          hotData.currentTickIndex = (pool as any).tick_current;
          hasHotData = true;
        }
        if (pool.tick_spacing) {
          hotData.tickSpacing = pool.tick_spacing;
          hasHotData = true;
        }
        if (pool.liquidity !== undefined) {
          hotData.liquidity = BigInt(String(pool.liquidity));
          hasHotData = true;
        }
        if (pool.fee_bps !== undefined) {
          hotData.feeRate = pool.fee_bps;
          hasHotData = true;
        }
        
        // Tick arrays for hot cache
        const tickArrayLower = (pool as any).tick_array_lower ?? (pool as any).tickArrayLower;
        const tickArrayCenter = (pool as any).tick_array_center ?? (pool as any).tickArrayCenter;
        const tickArrayUpper = (pool as any).tick_array_upper ?? (pool as any).tickArrayUpper;
        
        if (tickArrayCenter && tickArrayCenter !== null) {
          hotData.tickArrays = {
            center: tickArrayCenter,
            lower: (tickArrayLower && tickArrayLower !== null) ? [tickArrayLower] : undefined,
            upper: (tickArrayUpper && tickArrayUpper !== null) ? [tickArrayUpper] : undefined,
          };
          hasHotData = true;
        }
        
        if (hasHotData) {
          const existingHot = executionCache.getHot(pool.id) || {};
          executionCache.setHot(pool.id, { ...existingHot, ...hotData });
        }
      }
      
      logger.info('raydium.graphql.execution_cache.populated', {
        amm: normalized.amm.length,
        clmm: normalized.clmm.length,
        cat: 'raydium'
      });
    } catch (e: any) {
      logger.warn('raydium.graphql.execution_cache.failed', {
        error: String(e?.message || e),
        cat: 'raydium'
      });
    }
    
    logger.info('raydium.graphql.complete', { 
      amm: normalized.amm.length, 
      clmm: normalized.clmm.length, 
      cat: 'raydium' 
    });
    
    return normalized;
  } catch (error: any) {
    logger.error('raydium.graphql.failed', { 
      error: String(error?.message || error), 
      cat: 'raydium' 
    });
    
    // FALLBACK to HTTP
    logger.warn('raydium.graphql.fallback_to_http', { cat: 'raydium' });
    return getRaydiumPoolsNormalized(force);
  }
}

export async function getRaydiumClmmPoolsGraphQL(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  try {
    // Use provided mints if available (from shared universe), otherwise compute
    let mints: string[];
    if (opts?.mints && opts.mints.length > 0) {
      mints = opts.mints;
    } else {
      const { computeTokenUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
    }
    
    // CRITICAL: Always include anchor tokens in mints list for GraphQL queries
    // This ensures we can find pools containing SOL/USDC/USDT even if they're not in the universe
    // Anchor bridging only affects filtering AFTER fetching, not what we query
    const { getAnchorSet } = await import('./universe.js');
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    
    logger.info('raydium.clmm.graphql.fetch.start', { mintCount: mints.length, anchorCount: anchors.size, shared: !!opts?.mints, cat: 'raydium-clmm' });
    
    const { fetchRaydiumClmmGraphQL, normalizeRaydiumGraphQL } = await import('./pools/raydiumGraphQL.js');
    const raw = await fetchRaydiumClmmGraphQL(mints);
    
    // Normalize the CLMM pools
    const normalized = await normalizeRaydiumGraphQL(raw);
    
    // Write to disk cache
    const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-clmm-pools-graphql.json');
    try { await writeJson(CACHE_PATH, normalized); } catch {}
    
    // Emit to websocket
    try { emit('pools:raydium-clmm', normalized); } catch {}
    
    // Populate execution cache with Raydium CLMM pool data
    try {
      const { executionCache } = await import('../execution/cache.js');
      
      // Populate CLMM pools
      for (const pool of normalized.clmm || []) {
        const existing = executionCache.getStatic(pool.id) || {} as any;
        const staticData: any = {
          ...existing,
          programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          dex: 'Raydium',
        };
        
        // Store pool mints and decimals
        if (pool.mint_a) staticData.mint_a = pool.mint_a;
        if (pool.mint_b) staticData.mint_b = pool.mint_b;
        if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
        if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
        
        // Store CLMM-specific fields
        if ((pool as any).observation_state) staticData.observation_state = (pool as any).observation_state;
        if ((pool as any).ex_bitmap) staticData.ex_bitmap = (pool as any).ex_bitmap;
        if (pool.account_a) staticData.account_a = pool.account_a;
        if (pool.account_b) staticData.account_b = pool.account_b;
        if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
        if ((pool as any).sqrt_price_x64) staticData.sqrt_price_x64 = (pool as any).sqrt_price_x64;
        if ((pool as any).tick_current) staticData.tick_current = (pool as any).tick_current;
        if ((pool as any).liquidity) staticData.liquidity = (pool as any).liquidity;
        
        // Store native (pre-canonical) fields for execution
        if ((pool as any).native_mint_a) staticData.native_mint_a = (pool as any).native_mint_a;
        if ((pool as any).native_mint_b) staticData.native_mint_b = (pool as any).native_mint_b;
        if ((pool as any).native_account_a) staticData.native_account_a = (pool as any).native_account_a;
        if ((pool as any).native_account_b) staticData.native_account_b = (pool as any).native_account_b;
        
        executionCache.setStatic(pool.id, staticData);
      }
      
      logger.info('raydium.clmm.graphql.execution_cache.populated', {
        clmm: normalized.clmm.length,
        cat: 'raydium-clmm'
      });
    } catch (e: any) {
      logger.warn('raydium.clmm.graphql.execution_cache.failed', {
        error: String(e?.message || e),
        cat: 'raydium-clmm'
      });
    }
    
    logger.info('raydium.clmm.graphql.complete', { 
      clmm: normalized.clmm.length, 
      cat: 'raydium-clmm' 
    });
    
    return normalized;
  } catch (err) {
    logger.error('raydium.clmm.graphql.fetch.error', { error: String(err), cat: 'raydium-clmm' });
    return { amm: [], clmm: [], cpmm: [] };
  }
}

export async function getRaydiumCpmmPoolsGraphQL(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  try {
    // Check if CPMM is enabled
    if ((CONFIG as any)?.raydiumCpmm?.enabled === false) {
      logger.info('raydium.cpmm.graphql.skipped', { reason: 'disabled', cat: 'raydium-cpmm' });
      return { amm: [], clmm: [], cpmm: [] };
    }
    
    // Use provided mints if available (from shared universe), otherwise compute
    let mints: string[];
    if (opts?.mints && opts.mints.length > 0) {
      mints = opts.mints;
    } else {
      const { computeTokenUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
    }
    
    // CRITICAL: Always include anchor tokens in mints list for GraphQL queries
    // This ensures we can find pools containing SOL/USDC/USDT even if they're not in the universe
    // Anchor bridging only affects filtering AFTER fetching, not what we query
    const { getAnchorSet } = await import('./universe.js');
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    
    logger.info('raydium.cpmm.graphql.fetch.start', { mintCount: mints.length, anchorCount: anchors.size, shared: !!opts?.mints, cat: 'raydium-cpmm' });
    
    const { fetchRaydiumCpmmGraphQL, normalizeRaydiumCpmmGraphQL } = await import('./pools/raydiumCpmmGraphQL.js');
    const raw = await fetchRaydiumCpmmGraphQL(mints);
    
    // Normalize the CPMM pools
    const normalized = await normalizeRaydiumCpmmGraphQL(raw);
    
    // Write to disk cache
    const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-cpmm-pools-graphql.json');
    try { await writeJson(CACHE_PATH, normalized); } catch {}
    
    // Emit to websocket
    try { emit('pools:raydium-cpmm', normalized); } catch {}
    
    logger.info('raydium.cpmm.graphql.complete', { 
      cpmm: normalized.cpmm.length, 
      cat: 'raydium-cpmm' 
    });
    
    return { amm: [], clmm: [], cpmm: normalized.cpmm };
  } catch (err) {
    logger.error('raydium.cpmm.graphql.fetch.error', { error: String(err), cat: 'raydium-cpmm' });
    return { amm: [], clmm: [], cpmm: [] };
  }
}

export async function getOrcaPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = CONFIG.orca?.cacheTtlMs ?? 300_000; // 5 minutes default
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getOrcaPoolsCached as any).__lastForceAt = (getOrcaPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (orcaCache.data && now - orcaCache.ts < ttlMs) return orcaCache.data;
    return orcaCache.data || { amm: [], clmm: [], cpmm: [] };
  }
  // Debounce forced refreshes
  if (force) {
    const last = (getOrcaPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && orcaCache.data) return orcaCache.data as any;
    (getOrcaPoolsCached as any).__lastForceAt = now;
  }
  if (orcaCache.inflight) return orcaCache.inflight;
  orcaCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const data = await getOrcaPoolsNormalized(opts);
      const prev = orcaCache.data;
      orcaCache.data = data;
      orcaCache.ts = Date.now();
      poolsMetrics.orca.fetches += 1;
      poolsMetrics.orca.lastMs = Date.now();
      poolsMetrics.orca.lastAmm = (data.amm || []).length;
      poolsMetrics.orca.lastClmm = (data.clmm || []).length;
      
      // Populate execution cache with Orca pool data (HTTP path)
      // This ensures instruction builders have access to execution-critical accounts
      try {
        const { populateExecutionCacheFromPools } = await import('./pools.persistence.js');
        populateExecutionCacheFromPools(data, 'Orca');
        logger.debug('orca.http.execution_cache.populated', {
          cat: 'pools',
          ctx: {
            amm: (data.amm || []).length,
            clmm: (data.clmm || []).length,
          }
        });
      } catch (e: any) {
        logger.warn('orca.http.execution_cache.population.failed', {
          cat: 'pools',
          ctx: { error: String(e?.message || e) }
        });
      }
      
      // Register Orca pools for eligibility tracking
      // This enables reactive filtering when tick moves in/out of safe range
      try {
        const { registerOrcaPoolsForEligibility } = await import('./pools.websockets.js');
        const eligibilityStats = registerOrcaPoolsForEligibility(data.clmm || []);
        logger.info('orca.eligibility.registered', {
          cat: 'pools',
          ctx: eligibilityStats
        });
      } catch (eligibilityErr) {
        // Non-fatal - log and continue
        logger.debug('orca.eligibility.register_failed', {
          cat: 'pools',
          ctx: { error: String((eligibilityErr as any)?.message || eligibilityErr) }
        });
      }
      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = (data.amm || []).length;
        const nextClmm = (data.clmm || []).length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'orca', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=orca amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [], cpmm: [] }, data);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        try { logger.debug('pools.delta orca', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        // Skip incremental updates during startup/refresh - let refreshAllSources rebuild after filtering
        const skipIncremental = (refreshAllSources as any).__inProgress === true;
        if (!skipIncremental) {
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
              // Fire-and-forget: don't await to avoid blocking HTTP fetchers
              // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
              void gmod.applyPoolUpdates(prev || { amm: [], clmm: [], cpmm: [] }, data, { pushToArb: false }).catch((err: any) => {
                try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'orca', cat: 'graph' }); } catch {}
              });
            }
          } catch {}
        } else {
          try { logger.debug('graph.update.skipped_during_refresh', { source: 'orca', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
        }
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return data;
    } finally {
      orcaCache.inflight = undefined;
    }
  })();
  return orcaCache.inflight;
}
export async function getOrcaPoolsNormalized(opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  logger.info('orca.fetch start', {
    mode: 'http',
    uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
    anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
    includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
    canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
  });
  // Try configured mode, then fallbacks to maximize robustness
  const tried: string[] = [];
    try {
    const raw = await fetchOrcaHttpImpl();
    let norm = await normalizeOrcaHttpImpl(raw);
    
        // Save raw normalized pools (before filtering) for debugging/analysis
        try {
          const { saveRawNormalizedPools } = await import('./pools.persistence.js');
          await saveRawNormalizedPools('orca', norm);
        } catch {}
        
        // Apply token blocklist (exclude pools containing any blocked mint)
        try {
          const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
          if (blist.size > 0) {
            const beforeAmm = (norm.amm || []).length, beforeClmm = (norm.clmm || []).length;
            const filtered = applyTokenMintBlocklist(norm as any, blist);
            if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
              try { logger.info('orca.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
            }
            norm = filtered as any;
          }
        } catch {        }
        // Apply universe filtering early so caches are consistent across sources
        try {
          const skipUniverseFilter = opts?.skipUniverseFilter === true;
          if (!skipUniverseFilter) {
            const uniModeAny: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
            const isTest = String(((globalThis as any)?.process?.env?.NODE_ENV) || '') === 'test';
            const isVitest = !!((globalThis as any)?.vi || (globalThis as any)?.vitest || (String(((globalThis as any)?.process?.env?.VITEST) || '') === 'true'));
            const skipUniverseMode = isTest || isVitest || String(uniModeAny) === 'none';
            if (!skipUniverseMode) {
              const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
              const uni = await computeTokenUniverse(uniModeAny);
              const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
              const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
              if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
                poolsMetrics.orca.lastAmm = scoped.amm.length;
                poolsMetrics.orca.lastClmm = scoped.clmm.length;
                try { logger.info('orca.universe.filter', { mode: uniModeAny, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
              }
              norm = scoped as any;
            } else {
              try { logger.info('orca.universe.filter skip', { reason: isTest ? 'test' : 'mode:none' }); } catch {}
            }
          }
        } catch {}
        // Defer TVL filtering to graph-level to avoid early pruning across sources
  
  // Populate execution cache with Orca Whirlpool pool data
  try {
    const { executionCache } = await import('../execution/cache.js');
    for (const pool of norm.clmm || []) {
      const existing = executionCache.getStatic(pool.id) || {} as any;
      const staticData: any = {
        ...existing,
        programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        dex: 'Orca',
      };
      
      // Store pool mints and decimals
      if (pool.mint_a) staticData.mint_a = pool.mint_a;
      if (pool.mint_b) staticData.mint_b = pool.mint_b;
      if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
      if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
      
      // CRITICAL: Store native (on-chain) mint orientation for correct swap direction detection
      // The routerTx builder needs native_mint_a to determine isAtoB for the on-chain CPI
      if ((pool as any).native_mint_a) staticData.native_mint_a = (pool as any).native_mint_a;
      if ((pool as any).native_mint_b) staticData.native_mint_b = (pool as any).native_mint_b;
      if ((pool as any).was_swapped != null) staticData.was_swapped = (pool as any).was_swapped;
      
      // Store execution-critical accounts (oracle, vaults)
      if (pool.oracle) staticData.oracle = pool.oracle;
      if (pool.token_vault_a) staticData.token_vault_a = pool.token_vault_a;
      if (pool.token_vault_b) staticData.token_vault_b = pool.token_vault_b;
      
      // Store vault/account references
      if (pool.account_a) staticData.account_a = pool.account_a;
      if (pool.account_b) staticData.account_b = pool.account_b;
      
      // CRITICAL: Store vault addresses in the format expected by the builder (vaults.a and vaults.b)
      // Prefer token_vault_a/token_vault_b, fallback to account_a/account_b
      const vaultA = pool.token_vault_a || pool.account_a;
      const vaultB = pool.token_vault_b || pool.account_b;
      if (vaultA && vaultB) {
        staticData.vaults = {
          a: vaultA,
          b: vaultB
        };
      }
      
      // Store tick spacing
      if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
      
      executionCache.setStatic(pool.id, staticData);
    }
    
    try {
      logger.info('orca.execution_cache.populated', {
        cat: 'pools',
        ctx: {
          poolCount: (norm.clmm || []).length,
          withOracle: (norm.clmm || []).filter((p: any) => p.oracle).length,
          withVaults: (norm.clmm || []).filter((p: any) => p.token_vault_a && p.token_vault_b).length,
        }
      });
    } catch {}
  } catch (e: any) {
    try {
      logger.warn('orca.execution_cache.population.failed', {
        cat: 'pools',
        ctx: { error: String(e?.message || e) }
      });
    } catch {}
  }
  
  logger.info('orca.http normalized', { clmm: norm.clmm.length, canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        return norm;
    } catch (e: any) {
    tried.push(`http:${String(e?.message || e)}`);
    logger.warn('orca.http failed', { tried });
  return { amm: [], clmm: [], cpmm: [] };
  }
}

export async function getOrcaPoolsGraphQL(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  try {
    // Use provided mints if available (from shared universe), otherwise compute
    let mints: string[];
    if (opts?.mints && opts.mints.length > 0) {
      mints = opts.mints;
    } else {
      const { computeTokenUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
    }
    
    // CRITICAL: Always include anchor tokens in mints list for GraphQL queries
    // This ensures we can find pools containing SOL/USDC/USDT even if they're not in the universe
    // Anchor bridging only affects filtering AFTER fetching, not what we query
    const { getAnchorSet } = await import('./universe.js');
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    
    logger.info('orca.graphql.fetch.start', { mintCount: mints.length, anchorCount: anchors.size, shared: !!opts?.mints, cat: 'orca' });
    
    const { fetchOrcaGraphQL, normalizeOrcaGraphQL } = await import('./pools/orcaGraphQL.js');
    const raw = await fetchOrcaGraphQL(mints);
    const normalized = await normalizeOrcaGraphQL(raw);
    
    // Update cache
    orcaCache.data = normalized;
    orcaCache.ts = Date.now();
    
    // Write to disk cache
    const CACHE_PATH = joinPath(CONFIG.cacheDir, 'orca-pools-graphql.json');
    try { await writeJson(CACHE_PATH, normalized); } catch {}
    
    // Emit to websocket
    try { emit('pools:orca', normalized); } catch {}
    
    // Populate execution cache with Orca Whirlpool pool data (GraphQL path)
    try {
      const { executionCache } = await import('../execution/cache.js');
      for (const pool of normalized.clmm || []) {
        const existing = executionCache.getStatic(pool.id) || {} as any;
        const staticData: any = {
          ...existing,
          programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
          dex: 'Orca',
        };
        
        if (pool.mint_a) staticData.mint_a = pool.mint_a;
        if (pool.mint_b) staticData.mint_b = pool.mint_b;
        if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
        if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
        
        // CRITICAL: Store native (on-chain) mint orientation for correct swap direction detection
        // The routerTx builder needs native_mint_a to determine isAtoB for the on-chain CPI
        if ((pool as any).native_mint_a) staticData.native_mint_a = (pool as any).native_mint_a;
        if ((pool as any).native_mint_b) staticData.native_mint_b = (pool as any).native_mint_b;
        if ((pool as any).was_swapped != null) staticData.was_swapped = (pool as any).was_swapped;
        
        if ((pool as any).oracle) staticData.oracle = (pool as any).oracle;
        if ((pool as any).token_vault_a) staticData.token_vault_a = (pool as any).token_vault_a;
        if ((pool as any).token_vault_b) staticData.token_vault_b = (pool as any).token_vault_b;
        if (pool.account_a) staticData.account_a = pool.account_a;
        if (pool.account_b) staticData.account_b = pool.account_b;
        
        // CRITICAL: Store vault addresses in the format expected by the builder (vaults.a and vaults.b)
        // Prefer token_vault_a/token_vault_b, fallback to account_a/account_b
        const vaultA = (pool as any).token_vault_a || pool.account_a;
        const vaultB = (pool as any).token_vault_b || pool.account_b;
        if (vaultA && vaultB) {
          staticData.vaults = {
            a: vaultA,
            b: vaultB
          };
        }
        
        if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
        
        executionCache.setStatic(pool.id, staticData);
        
        // Also populate hot cache with price/tick data if available
        const hotData: any = { dex: 'orca' };
        let hasHotData = false;
        
        if (pool.sqrt_price_x64 !== undefined) {
          hotData.sqrtPriceX64 = BigInt(String(pool.sqrt_price_x64));
          hasHotData = true;
        }
        if ((pool as any).tick_current !== undefined) {
          hotData.currentTickIndex = (pool as any).tick_current;
          hasHotData = true;
        }
        if (pool.tick_spacing) {
          hotData.tickSpacing = pool.tick_spacing;
          hasHotData = true;
        }
        if (pool.liquidity !== undefined) {
          hotData.liquidity = BigInt(String(pool.liquidity));
          hasHotData = true;
        }
        if (pool.fee_bps !== undefined) {
          hotData.feeRate = pool.fee_bps;
          hasHotData = true;
        }
        
        // Tick arrays for hot cache
        const tickArrayLower = (pool as any).tick_array_lower ?? (pool as any).tickArrayLower;
        const tickArrayCenter = (pool as any).tick_array_center ?? (pool as any).tickArrayCenter;
        const tickArrayUpper = (pool as any).tick_array_upper ?? (pool as any).tickArrayUpper;
        
        if (tickArrayCenter && tickArrayCenter !== null) {
          hotData.tickArrays = {
            center: tickArrayCenter,
            lower: (tickArrayLower && tickArrayLower !== null) ? [tickArrayLower] : undefined,
            upper: (tickArrayUpper && tickArrayUpper !== null) ? [tickArrayUpper] : undefined,
          };
          hasHotData = true;
        }
        
        if (hasHotData) {
          const existingHot = executionCache.getHot(pool.id) || {};
          executionCache.setHot(pool.id, { ...existingHot, ...hotData });
        }
      }
      
      logger.info('orca.graphql.execution_cache.populated', {
        clmm: normalized.clmm.length,
        withOracle: (normalized.clmm || []).filter((p: any) => p.oracle).length,
        withVaults: (normalized.clmm || []).filter((p: any) => p.token_vault_a && p.token_vault_b).length,
        cat: 'orca'
      });
    } catch (e: any) {
      logger.warn('orca.graphql.execution_cache.failed', {
        error: String(e?.message || e),
        cat: 'orca'
      });
    }
    
    // Populate hot cache with pool state data from GraphQL (similar to populateOrcaPoolStates)
    // This ensures local quotes and builders have access to sqrtPrice, liquidity, etc.
    try {
      const { executionCache } = await import('../execution/cache.js');
      
      const { PublicKey } = await import('@solana/web3.js');
      const orcaProgramId = new PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'));
      const ORCA_TICK_ARRAY_SIZE = 88;
      
      let hotCached = 0;
      let tickArraysCached = 0;
      let tickArraysSkipped = 0;
      let tickArraysFailed = 0;
      let tickArraysIncomplete = 0;
      
      for (const pool of normalized.clmm || []) {
        try {
          // Extract hot data from normalized pool
          // GraphQL provides: sqrtPrice, liquidity, tickCurrentIndex, feeRate
          // Field names from orcaGraphQL.ts normalization: sqrt_price_x64, liquidity (not _raw suffix)
          const sqrtPriceX64 = (pool as any).sqrt_price_x64 
            ? BigInt((pool as any).sqrt_price_x64) 
            : undefined;
          
          const liquidity = (pool as any).liquidity 
            ? BigInt((pool as any).liquidity) 
            : undefined;
          
          // tickCurrentIndex from GraphQL:
          // - normalized pools often store tick_current_index in CANONICAL orientation
          //   (negated when was_swapped=true to match canonicalized mint ordering).
          // - HOWEVER tick array PDAs are derived from the NATIVE on-chain tick index.
          // So we cache/derive using NATIVE tick (un-negate if was_swapped=true).
          let tickIndexCanonical: number | undefined;
          if ((pool as any).tick_current_index != null) {
            tickIndexCanonical = Number((pool as any).tick_current_index);
          } else if ((pool as any).tickCurrentIndex != null) {
            tickIndexCanonical = Number((pool as any).tickCurrentIndex);
          }
          const wasSwapped = (pool as any).was_swapped === true;
          const tickIndexNative =
            tickIndexCanonical !== undefined && Number.isFinite(tickIndexCanonical)
              ? (wasSwapped ? -tickIndexCanonical : tickIndexCanonical)
              : undefined;
          
          // feeRate from GraphQL (already converted to bps in normalization)
          const feeRateBps = pool.fee_bps;
          
          // Derive tick arrays for local builder (no RPC needed - pure PDA math)
          let tickArrays: any | undefined;
          const tickSpacing = pool.tick_spacing;
          if (tickIndexNative !== undefined && tickSpacing && tickSpacing > 0) {
            try {
              const poolPk = new PublicKey(pool.id);
              
              const ticksInArray = ORCA_TICK_ARRAY_SIZE * Number(tickSpacing);
              const realIndex = Math.floor(Number(tickIndexNative) / ticksInArray);
              const deriveTickArrayPda = (startTickIndex: number): string => {
                // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
                const [pda] = PublicKey.findProgramAddressSync(
                  [Buffer.from('tick_array'), poolPk.toBuffer(), Buffer.from(startTickIndex.toString())],
                  orcaProgramId
                );
                return pda.toBase58();
              };

              const center = deriveTickArrayPda(realIndex * ticksInArray);
              const lower1 = deriveTickArrayPda((realIndex - 1) * ticksInArray);
              const lower2 = deriveTickArrayPda((realIndex - 2) * ticksInArray);
              const upper1 = deriveTickArrayPda((realIndex + 1) * ticksInArray);
              const upper2 = deriveTickArrayPda((realIndex + 2) * ticksInArray);
              
              // Store both "nearby" arrays on each side. Execution can pick the direction-specific sequence.
              tickArrays = {
                center,
                lower: [lower1, lower2],
                upper: [upper1, upper2],
              };
              tickArraysCached++;
            } catch (tickArrayErr) {
              tickArraysFailed++;
              try {
                logger.warn('orca.graphql.tick_array.derivation_failed', {
                  pool: pool.id?.slice(0, 8) + '…',
                  tickIndex: tickIndexNative,
                  tickSpacing,
                  error: String((tickArrayErr as any)?.message || tickArrayErr),
                  cat: 'orca'
                });
              } catch {}
            }
          } else {
            tickArraysSkipped++;
            // Log why tick arrays couldn't be derived (missing prerequisites)
            try {
              logger.info('orca.graphql.tick_array.skipped', {
                pool: pool.id?.slice(0, 8) + '…',
                hasTickIndex: tickIndexNative !== undefined,
                hasTickSpacing: !!tickSpacing,
                tickIndex: tickIndexNative,
                tickSpacing,
                cat: 'orca'
              });
            } catch {}
          }
          
          // Cache whatever "hot" fields we have. Even if sqrt/liquidity is missing,
          // caching tickIndexNative + tickSpacing enables tick array PDA derivation for execution.
          // Include tickSpacing for boundary crossing detection in cache.
          if (
            sqrtPriceX64 ||
            liquidity !== undefined ||
            tickIndexNative !== undefined ||
            tickArrays
          ) {
            const existing = executionCache.getHot(pool.id) || {};
            executionCache.setHot(pool.id, {
              ...existing,
              dex: 'orca',
              ...(sqrtPriceX64 ? { sqrtPriceX64 } : {}),
              ...(tickIndexNative !== undefined ? { currentTickIndex: tickIndexNative } : {}),
              ...(tickSpacing ? { tickSpacing } : {}),
              ...(liquidity !== undefined ? { liquidity } : {}),
              ...(feeRateBps ? { feeRate: feeRateBps } : {}),
              ...(tickArrays ? { tickArrays } : {}),
            });
            hotCached++;
          }
        } catch (poolErr) {
          // Log but continue - individual pool failures shouldn't stop the process
          try {
            logger.debug('orca.graphql.hot_cache.pool_failed', {
              pool: pool.id?.slice(0, 8) + '…',
              error: String((poolErr as any)?.message || poolErr),
              cat: 'orca'
            });
          } catch {}
        }
      }
      
      logger.info('orca.graphql.hot_cache.populated', {
        clmm: normalized.clmm.length,
        hotCached,
        tickArraysCached,
        tickArraysSkipped,
        tickArraysIncomplete,
        tickArraysFailed,
        cat: 'orca'
      });
    } catch (e: any) {
      logger.warn('orca.graphql.hot_cache.failed', {
        error: String(e?.message || e),
        cat: 'orca'
      });
    }
    
    logger.info('orca.graphql.complete', { 
      clmm: normalized.clmm.length, 
      cat: 'orca' 
    });
    
    return normalized;
  } catch (error: any) {
    logger.error('orca.graphql.failed', { 
      error: String(error?.message || error), 
      cat: 'orca' 
    });
    
    // FALLBACK to HTTP
    logger.warn('orca.graphql.fallback_to_http', { cat: 'orca' });
    return getOrcaPoolsNormalized();
  }
}

export async function getMeteoraPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraPoolsCached as any).__lastForceAt = (getMeteoraPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  // Capture opts for use in closure
  const skipUniverseFilter = opts?.skipUniverseFilter === true;
  if (!force) {
    if (meteoraCache.data && now - meteoraCache.ts < ttlMs) return meteoraCache.data;
    return meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
  }
  if (force) {
    const last = (getMeteoraPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && meteoraCache.data) return meteoraCache.data as any;
    (getMeteoraPoolsCached as any).__lastForceAt = now;
  }
  if (meteoraCache.inflight) return meteoraCache.inflight;
  meteoraCache.inflight = (async () => {
    try {
      const mode = 'http';
      try { logger.info('meteora.fetch start', { mode, ttlMs, uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter', anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging), includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false, canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none', cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      const t0 = Date.now();
      const raw = await fetchMeteoraHttpImpl();
      let norm = await normalizeMeteoraHttpImpl(raw);
      
      // Save raw normalized pools (before filtering) for debugging/analysis
      try {
        const { saveRawNormalizedPools } = await import('./pools.persistence.js');
        await saveRawNormalizedPools('meteora', norm);
      } catch {}
      
      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeClmm = (norm.clmm || []).length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if ((filtered.clmm || []).length !== beforeClmm) {
            try { logger.info('meteora.blocklist.filter', { beforeClmm, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}
      // Optionally apply universe filtering early (disabled by default for Meteora)
      try {
        if (!skipUniverseFilter) {
          const prefilter = !!((CONFIG as any)?.meteora?.universePrefilter);
          if (prefilter) {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
            const uni = await computeTokenUniverse(mode);
            const beforeClmm = norm.clmm.length;
            const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
            if (scoped.clmm.length !== beforeClmm) { try { logger.info('meteora.universe.filter', { mode, beforeClmm, afterClmm: scoped.clmm.length }); } catch {} }
            norm = { amm: [], clmm: scoped.clmm } as any;
          }
        }
      } catch {}
       // TVL filter (apply global thresholds on top of per-source)
      // Defer TVL filtering to graph-level to avoid early pruning across sources
      const prev = meteoraCache.data;
      meteoraCache.data = norm; meteoraCache.ts = Date.now();
      
      // Populate execution cache with Meteora DLMM pool data
      // This ensures instruction builders have access to execution-critical accounts
      try {
        const { executionCache } = await import('../execution/cache.js');
        for (const pool of norm.clmm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
            dex: 'Meteora',
          };
          
          // Store pool mints and decimals
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          if (pool.token_program_a) staticData.token_program_a = pool.token_program_a;
          if (pool.token_program_b) staticData.token_program_b = pool.token_program_b;
          
          // Store execution-critical accounts (bin_array_bitmap_extension)
          if (pool.bin_array_bitmap_extension) {
            staticData.bin_array_bitmap_extension = pool.bin_array_bitmap_extension;
          }
          if ((pool as any).bin_array_lower) staticData.bin_array_lower = (pool as any).bin_array_lower;
          if ((pool as any).bin_array_upper) staticData.bin_array_upper = (pool as any).bin_array_upper;
          
          // Store vault/reserve accounts
          if (pool.account_a) staticData.account_a = pool.account_a;
          if (pool.account_b) staticData.account_b = pool.account_b;
          
          // Store tick spacing (bin_step for Meteora)
          if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
          if ((pool as any).bin_step) staticData.binStep = (pool as any).bin_step;
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        try {
          logger.info('meteora.execution_cache.populated', {
            cat: 'pools',
            ctx: {
              poolCount: (norm.clmm || []).length,
              withBitmapExt: (norm.clmm || []).filter((p: any) => p.bin_array_bitmap_extension).length,
            }
          });
        } catch {}
        
        // Register pools for bitmap eligibility tracking
        // This enables reactive filtering when activeId moves in/out of safe range
        try {
          const { registerPoolsForBitmapWatch } = await import('./pools.websockets.js');
          const bitmapStats = registerPoolsForBitmapWatch(norm.clmm || []);
          logger.info('meteora.bitmap_eligibility.registered', {
            cat: 'pools',
            ctx: bitmapStats
          });
        } catch (bitmapErr) {
          // Non-fatal - log and continue
          logger.debug('meteora.bitmap_eligibility.register_failed', {
            cat: 'pools',
            ctx: { error: String((bitmapErr as any)?.message || bitmapErr) }
          });
        }
      } catch (e: any) {
        try {
          logger.warn('meteora.execution_cache.population.failed', {
            cat: 'pools',
            ctx: { error: String(e?.message || e) }
          });
        } catch {}
      }
      
      poolsMetrics.meteora.fetches += 1;
      poolsMetrics.meteora.lastMs = Date.now();
      poolsMetrics.meteora.lastClmm = norm.clmm.length;
      try { logger.info('meteora.fetch normalized', { clmm: norm.clmm.length, ms: Date.now() - t0, cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch ok clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [], cpmm: [] }, norm);
        const sample = { amm: [], clmm: d.clmm.slice(0, 100) };
        emit('pools-update', { source: 'meteora', amm: 0, clmm: norm.clmm.length, ts: Date.now() });
        emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        // Skip incremental updates during startup/refresh - let refreshAllSources rebuild after filtering
        const skipIncremental = (refreshAllSources as any).__inProgress === true;
        if (!skipIncremental) {
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
              // Fire-and-forget: don't await to avoid blocking HTTP fetchers
              // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
              void gmod.applyPoolUpdates(prev || { amm: [], clmm: [], cpmm: [] }, norm, { pushToArb: false }).catch((err: any) => {
                try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'meteora', cat: 'graph' }); } catch {}
              });
            }
          } catch {}
        } else {
          try { logger.debug('graph.update.skipped_during_refresh', { source: 'meteora', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
        }
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return meteoraCache.data!;
    } finally {
      meteoraCache.inflight = undefined;
    }
  })();
  return meteoraCache.inflight;
}

export async function getMeteoraPoolsGraphQL(force = false, opts?: { mints?: string[] }): Promise<PoolsPayload> {
  try {
    // Use provided mints if available (from shared universe), otherwise compute
    let mints: string[];
    if (opts?.mints && opts.mints.length > 0) {
      mints = opts.mints;
    } else {
      const { computeTokenUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
    }
    
    // CRITICAL: Always include anchor tokens in mints list for GraphQL queries
    // This ensures we can find pools containing SOL/USDC/USDT even if they're not in the universe
    // Anchor bridging only affects filtering AFTER fetching, not what we query
    const { getAnchorSet } = await import('./universe.js');
    const anchors = getAnchorSet();
    const mintsSet = new Set(mints);
    for (const anchor of anchors) {
      mintsSet.add(anchor);
    }
    mints = Array.from(mintsSet);
    
    logger.info('meteora.graphql.fetch.start', { mintCount: mints.length, anchorCount: anchors.size, shared: !!opts?.mints, cat: 'meteora' });
    
    const { fetchMeteoraGraphQL, normalizeMeteoraGraphQL } = await import('./pools/meteoraGraphQL.js');
    const raw = await fetchMeteoraGraphQL(mints);
    const normalized = await normalizeMeteoraGraphQL(raw);
    
    // Update cache
    meteoraCache.data = normalized;
    meteoraCache.ts = Date.now();
    
    // Write to disk cache
    const CACHE_PATH = joinPath(CONFIG.cacheDir, 'meteora-pools-graphql.json');
    try { await writeJson(CACHE_PATH, normalized); } catch {}
    
    // Emit to websocket
    try { emit('pools:meteora', normalized); } catch {}
    
    // Populate execution cache with Meteora DLMM pool data (GraphQL path)
    try {
      const { executionCache } = await import('../execution/cache.js');
      for (const pool of normalized.clmm || []) {
        const existing = executionCache.getStatic(pool.id) || {} as any;
        const staticData: any = {
          ...existing,
          programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
          dex: 'Meteora',
        };
        
        if (pool.mint_a) staticData.mint_a = pool.mint_a;
        if (pool.mint_b) staticData.mint_b = pool.mint_b;
        if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
        if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
        if ((pool as any).token_program_a) staticData.token_program_a = (pool as any).token_program_a;
        if ((pool as any).token_program_b) staticData.token_program_b = (pool as any).token_program_b;
        if ((pool as any).bin_array_bitmap_extension) {
          staticData.bin_array_bitmap_extension = (pool as any).bin_array_bitmap_extension;
        }
        if ((pool as any).bin_array_lower) staticData.bin_array_lower = (pool as any).bin_array_lower;
        if ((pool as any).bin_array_upper) staticData.bin_array_upper = (pool as any).bin_array_upper;
        if (pool.account_a) staticData.account_a = pool.account_a;
        if (pool.account_b) staticData.account_b = pool.account_b;
        if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
        if ((pool as any).bin_step) staticData.binStep = (pool as any).bin_step;
        
        executionCache.setStatic(pool.id, staticData);
        
        // Also populate hot cache with price/activeId data if available
        const hotData: any = { dex: 'meteora' };
        let hasHotData = false;
        
        if (pool.sqrt_price_x64 !== undefined) {
          hotData.sqrtPriceX64 = BigInt(String(pool.sqrt_price_x64));
          hasHotData = true;
        }
        if ((pool as any).active_id !== undefined) {
          hotData.activeId = (pool as any).active_id;
          hasHotData = true;
        }
        if (pool.tick_spacing) {
          hotData.binStep = pool.tick_spacing;
          hasHotData = true;
        }
        if ((pool as any).bin_step) {
          hotData.binStep = (pool as any).bin_step;
          hasHotData = true;
        }
        if (pool.liquidity !== undefined) {
          hotData.liquidity = BigInt(String(pool.liquidity));
          hasHotData = true;
        }
        if (pool.fee_bps !== undefined) {
          hotData.feeRate = pool.fee_bps;
          hasHotData = true;
        }
        
        // Bin arrays for hot cache
        const binArrayLower = (pool as any).bin_array_lower;
        const binArrayUpper = (pool as any).bin_array_upper;
        if ((binArrayLower && binArrayLower !== null) || (binArrayUpper && binArrayUpper !== null)) {
          hotData.binArrays = {
            lower: (binArrayLower && binArrayLower !== null) ? binArrayLower : undefined,
            upper: (binArrayUpper && binArrayUpper !== null) ? binArrayUpper : undefined,
          };
          hasHotData = true;
        }
        
        if (hasHotData) {
          const existingHot = executionCache.getHot(pool.id) || {};
          executionCache.setHot(pool.id, { ...existingHot, ...hotData });
        }
      }
      
      logger.info('meteora.graphql.execution_cache.populated', {
        clmm: normalized.clmm.length,
        withBitmapExt: (normalized.clmm || []).filter((p: any) => p.bin_array_bitmap_extension).length,
        withTokenPrograms: (normalized.clmm || []).filter((p: any) => p.token_program_a && p.token_program_b).length,
        cat: 'meteora'
      });
    } catch (e: any) {
      logger.warn('meteora.graphql.execution_cache.failed', {
        error: String(e?.message || e),
        cat: 'meteora'
      });
    }
    
    logger.info('meteora.graphql.complete', { 
      clmm: normalized.clmm.length, 
      cat: 'meteora' 
    });
    
    return normalized;
  } catch (error: any) {
    logger.error('meteora.graphql.failed', { 
      error: String(error?.message || error), 
      cat: 'meteora' 
    });
    
    // FALLBACK to HTTP
    logger.warn('meteora.graphql.fallback_to_http', { cat: 'meteora' });
    return getMeteoraPoolsCached(force);
  }
}

setPoolRefreshHandler(refreshAllSources);

// Orca HTTP fetcher provided in ./pools/orca.ts

// Orca normalization and fetch helpers are provided in ./pools/orca.ts