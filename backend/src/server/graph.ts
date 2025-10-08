import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger.js';
import { LogCode } from '../utils/logging.js';
import { readJson } from '../utils/fs.js';
import { notifyArbServiceRefresh, emit, pushArbGraphSnapshot, pushArbGraphDiff } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { getRaydiumPoolsNormalized, getOrcaPoolsCached, enablePoolWebsocketRefreshes, peekMeteoraPools, getMeteoraPoolsCached } from './pools.js';
import { loadTokenMap } from '../utils/tokens.js';
import { fetch } from 'undici';
import { calibrateMagnitude } from './priceCalib.js';
import type { GraphNode, GraphEdge, GraphSnapshot, GraphDiff } from './graph.types.js';
export type { GraphNode, GraphEdge, GraphSnapshot, GraphDiff } from './graph.types.js';
import { diffSnapshots } from './graph.diff.js';
import { findPathInSnapshot } from './graph.path.js';



let lastSnapshot: GraphSnapshot | null = null;
let inflight: Promise<GraphSnapshot> | null = null;
const SNAPSHOT_TTL_MS = Math.max(1000, Number((CONFIG.system as any)?.graphSnapshotTtlMs || 30_000));
let lastAt = 0;
let rebuildTimer: any | null = null;
let pendingUpdates = 0;
let diffSinceRebase = 0;
// Allow rebase policy to be configured via CONFIG.system
const REBASE_DIFF_THRESHOLD = Math.max(0, Number((CONFIG.system as any)?.graphRebaseDiffThreshold || 2000));
const REBASE_TIME_MS = Math.max(0, Number((CONFIG.system as any)?.graphRebaseTimeMs || (5 * 60 * 1000)));
let lastRebaseMs = 0;

export function getGraphVersion(): { version: number; timestamp: number } {
  const version = lastSnapshot?.version || 0;
  const timestamp = lastSnapshot?.timestamp || 0;
  try { logger.debug('graph.version.peek', { version, timestamp, cat: 'graph', code: LogCode.GRAPH_TVL_STATS }); } catch {}
  return { version, timestamp };
}

export async function rebuildGraphNow(io?: SocketIOServer): Promise<void> {
  try {
    const prev = lastSnapshot;
    const next = await getGraphSnapshot(true);
    const diff = diffSnapshots(prev, next);
    const changed = diff.addedNodes.length || diff.updatedNodes.length || diff.removedNodeIds.length || diff.addedEdges.length || diff.updatedEdges.length || diff.removedEdgeIds.length;
    if (io) {
      if (!prev) io.emit('graph-snapshot', next); else if (changed) io.emit('graph-update', diff);
    } else {
      // If no io is provided, emit via realtime emitter to reach clients
      try { if (!prev) emit('graph-snapshot', next); else if (changed) emit('graph-update', diff); } catch {}
    }
    if (!prev) {
      try { await pushArbGraphSnapshot(next); } catch {}
      try { await notifyArbServiceRefresh(); } catch {}
      diffSinceRebase = 0; lastRebaseMs = Date.now();
    } else if (changed) {
      const nowMs = Date.now();
      const shouldRebase = (diffSinceRebase >= REBASE_DIFF_THRESHOLD) || (nowMs - lastRebaseMs > REBASE_TIME_MS);
      if (shouldRebase) {
        try { await pushArbGraphSnapshot(next); } catch {}
        diffSinceRebase = 0; lastRebaseMs = nowMs;
        try { emit('log', { level: 'info', message: `graph:push snapshot v=${next.version} nodes=${next.nodes.length} edges=${next.edges.length}`, timestamp: new Date().toISOString(), context: { cat: 'graph', code: LogCode.GRAPH_PUSH_SNAPSHOT } }); } catch {}
        // Also emit snapshot to clients to ensure they rebase in lockstep
        try { if (io) io.emit('graph-snapshot', next); else emit('graph-snapshot', next); } catch {}
        try { logger.info('graph.rebase', { at_ms: lastRebaseMs, version: next.version, nodes: next.nodes.length, edges: next.edges.length }); } catch {}
      } else {
        try { await pushArbGraphDiff(diff); } catch {}
        diffSinceRebase += (diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length);
        try { emit('log', { level: 'info', message: `graph:push diff v=${diff.version} changes=${(diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length)}`, timestamp: new Date().toISOString(), context: { cat: 'graph', code: LogCode.GRAPH_PUSH_DIFF } }); } catch {}
      }
      try { await notifyArbServiceRefresh(); } catch {}
    }
    try { logger.info('graph.rebuild.now', { nodes: next.nodes.length, edges: next.edges.length, changed }); } catch {}
    // Optional: auto-retarget WS if many edges changed
    try {
      const auto = !!((CONFIG.system as any)?.autoRetargetOnGraph);
      const ch = (diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length);
      const big = ch >= Math.max(50, Number((CONFIG.system as any)?.autoRetargetEdgeThreshold || 200));
      if (auto && (big || !prev)) {
        const pools = await import('./pools.js');
        try { await (pools as any).retargetPoolWebsockets?.(); } catch {}
      }
    } catch {}
  } catch (e: any) {
    logger.warn('graph.rebuild.now failed', { error: String(e?.message || e) });
  }
}

export function scheduleGraphRebuild(io?: SocketIOServer, debounceMs = 200): void {
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
  pendingUpdates += 1;
  // Allow very low debounce when explicitly configured
  const minDebounce = Math.max(5, Number((CONFIG.system as any)?.graphRebuildMinDebounceMs || 50));
  const wait = Math.max(minDebounce, debounceMs);
  rebuildTimer = setTimeout(() => { rebuildTimer = null; const pending = pendingUpdates; pendingUpdates = 0; try { logger.debug('graph.rebuild.batch', { pending, code: LogCode.GRAPH_REBUILD_BATCH }); } catch {}; rebuildGraphNow(io).catch(() => {}); }, wait);
  try { logger.debug('graph.rebuild.scheduled', { debounceMs, code: LogCode.GRAPH_REBUILD_SCHEDULED }); } catch {}
}

// Lightweight timing gauges for build and push latencies
let lastBuildStart = 0;
let lastPushStart = 0;
export function markGraphBuildStart(): void { lastBuildStart = Date.now(); }
export function markGraphPushStart(): void { lastPushStart = Date.now(); }
export function getGraphTimings(): { graph_build_ms?: number; graph_push_latency_ms?: number } {
  const build = lastBuildStart ? (Date.now() - lastBuildStart) : undefined;
  const push = lastPushStart ? (Date.now() - lastPushStart) : undefined;
  return { graph_build_ms: build, graph_push_latency_ms: push };
}

export async function getGraphSnapshot(force = false): Promise<GraphSnapshot> {
  const now = Date.now();
  if (!force && lastSnapshot && now - lastAt < SNAPSHOT_TTL_MS) return lastSnapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Build graph from whatever is in caches right now; do not trigger source fetches here
      const { peekRaydiumPools, peekOrcaPools, peekMeteoraPools } = await import('./pools.js');
      const rayRaw = peekRaydiumPools();
      const orcRaw = peekOrcaPools();
      const metRaw = peekMeteoraPools();
      // Apply scoping according to CONFIG.system.scopePools and scopePoolsMode via universe helper
      const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
      const scoped = CONFIG.system.scopePools !== false && mode !== 'none';
      let ray = rayRaw; let orc = orcRaw; let met = metRaw;
      if (scoped) {
        try {
          const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
          const universe = await computeTokenUniverse(mode as any);
          const anchorBridging = !!((CONFIG.system as any)?.enableAnchorBridging);
          const rScoped = filterPoolsByUniverse(rayRaw as any, universe, anchorBridging);
          const oScoped = filterPoolsByUniverse(orcRaw as any, universe, anchorBridging);
          const mScoped = filterPoolsByUniverse(metRaw as any, universe, anchorBridging);
          const upstreamR = (rayRaw.amm?.length || 0) + (rayRaw.clmm?.length || 0);
          const scopedR = (rScoped.amm.length || 0) + (rScoped.clmm.length || 0);
          const upstreamO = (orcRaw.amm?.length || 0) + (orcRaw.clmm?.length || 0);
          const scopedO = (oScoped.amm.length || 0) + (oScoped.clmm.length || 0);
          const upstreamM = (metRaw.amm?.length || 0) + (metRaw.clmm?.length || 0);
          const scopedM = (mScoped.amm.length || 0) + (mScoped.clmm.length || 0);
          ray = (upstreamR > 0 && scopedR === 0) ? rayRaw : rScoped as any;
          orc = (upstreamO > 0 && scopedO === 0) ? orcRaw : oScoped as any;
          met = (upstreamM > 0 && scopedM === 0) ? metRaw : mScoped as any;
        } catch {}
      }
      // Apply global TVL/liquidity thresholds after scoping, before graph build
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
          const filt = (norm: { amm: any[]; clmm: any[] }) => ({
            amm: minAmm > 0 ? (norm.amm || []).filter((p: any) => valAmm(p) >= minAmm) : (norm.amm || []),
            clmm: minClmm > 0 ? (norm.clmm || []).filter((p: any) => valClmm(p) >= minClmm) : (norm.clmm || []),
          });
          const before = {
            ray: { a: ray.amm?.length || 0, c: ray.clmm?.length || 0 },
            orc: { a: orc.amm?.length || 0, c: orc.clmm?.length || 0 },
            met: { a: met.amm?.length || 0, c: met.clmm?.length || 0 },
          };
          ray = filt(ray) as any;
          orc = filt(orc) as any;
          met = filt(met) as any;
          const after = {
            ray: { a: ray.amm?.length || 0, c: ray.clmm?.length || 0 },
            orc: { a: orc.amm?.length || 0, c: orc.clmm?.length || 0 },
            met: { a: met.amm?.length || 0, c: met.clmm?.length || 0 },
          };
          if (before.ray.a !== after.ray.a || before.ray.c !== after.ray.c || before.orc.a !== after.orc.a || before.orc.c !== after.orc.c || before.met.c !== after.met.c) {
            try { logger.info('graph.filter tvl', { minAmm, minClmm, before, after }); } catch {}
          }
        }
      } catch {}
      // Optional DEX overlap filter (retain pairs present on at least N sources)
      try {
        const minOverlap = Math.max(1, Number(((CONFIG.system as any)?.minDexOverlap) || 1));
        if (minOverlap > 1) {
          const setRay = new Set<string>();
          for (const p of (ray.amm || [])) setRay.add(`${p.mint_a}-${p.mint_b}`);
          for (const p of (ray.clmm || [])) setRay.add(`${p.mint_a}-${p.mint_b}`);
          const setOrc = new Set<string>();
          for (const p of (orc.amm || [])) setOrc.add(`${p.mint_a}-${p.mint_b}`);
          for (const p of (orc.clmm || [])) setOrc.add(`${p.mint_a}-${p.mint_b}`);
          const setMet = new Set<string>();
          for (const p of (met.amm || [])) setMet.add(`${p.mint_a}-${p.mint_b}`);
          for (const p of (met.clmm || [])) setMet.add(`${p.mint_a}-${p.mint_b}`);
          const counts = new Map<string, number>();
          const bump = (k: string, has: boolean) => { if (!has) return; counts.set(k, (counts.get(k) || 0) + 1); };
          const all = new Set<string>([...setRay, ...setOrc, ...setMet]);
          for (const k of all) { bump(k, setRay.has(k)); bump(k, setOrc.has(k)); bump(k, setMet.has(k)); }
          const allow = new Set<string>();
          for (const [k, v] of counts.entries()) if (v >= minOverlap) allow.add(k);
          const filt = <T extends { mint_a: string; mint_b: string }>(arr: T[]) => (arr || []).filter(p => allow.has(`${p.mint_a}-${p.mint_b}`));
          ray = { amm: filt(ray.amm), clmm: filt(ray.clmm) } as any;
          orc = { amm: filt(orc.amm), clmm: filt(orc.clmm) } as any;
          met = { amm: filt(met.amm), clmm: filt(met.clmm) } as any;
        }
      } catch {}
      const tokenMap = await loadTokenMap().catch(() => ({} as Record<string, { mint: string; decimals: number }>));
      const labelByMint: Record<string, string> = {};
      const decimalsByMint: Record<string, number> = {};
      for (const [sym, info] of Object.entries(tokenMap || {})) {
        if (info?.mint) labelByMint[info.mint] = sym;
        if (info?.mint && Number.isFinite((info as any)?.decimals)) decimalsByMint[info.mint] = Number((info as any).decimals);
      }
      try {
        const { loadJupiterTokenMap } = await import('../utils/tokens.js');
        const jmap = await loadJupiterTokenMap();
        for (const [mint, meta] of Object.entries(jmap)) {
          if (!labelByMint[mint] && meta?.symbol) labelByMint[mint] = meta.symbol;
          if (Number.isFinite((meta as any)?.decimals) && decimalsByMint[mint] == null) decimalsByMint[mint] = Number((meta as any).decimals);
        }
      } catch {}
      // Also map watchlist entries to labels
      try {
        const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
        for (const t of wl) {
          const mint = typeof t === 'string' ? t : (t?.id || '');
          const sym = typeof t === 'string' ? t.toUpperCase() : (t?.symbol || '').toUpperCase();
          if (mint && sym && !labelByMint[mint]) labelByMint[mint] = sym;
        }
      } catch {}

      const nodesMap: Record<string, GraphNode> = {};
      const edgesMap: Record<string, GraphEdge> = {};
      // TVL diagnostics
      let ammTotal = 0, ammUsd = 0;
      let clmmTotal = 0, clmmUsd = 0, clmmMissingAmounts = 0, clmmMissingDecimals = 0;

      const addEdge = (
        mintA: string,
        mintB: string,
        dex: string,
        fee_bps?: number,
        liquidity?: number,
        price_a_per_b?: number,
        tvl_usd?: number,
        poolId?: string,
        accountA?: string,
        accountB?: string,
        poolKind?: 'amm' | 'clmm',
        direction?: 'forward' | 'reverse',
      ) => {
        if (!mintA || !mintB || mintA === mintB) return;
        // Preserve pool-provided orientation for coherency
        const a = String(mintA);
        const b = String(mintB);
        const price = Number(price_a_per_b || 0) || undefined as any;
        // Prefer pool address for edge id when available; otherwise include orientation
        const id = poolId || `${a}->${b}-${dex}`;
        // Normalize liquidity: prefer USD TVL when available, otherwise use log10(raw)
        const liqRawNum = Number(liquidity);
        const liqRaw = Number.isFinite(liqRawNum) && liqRawNum > 0 ? liqRawNum : 0;
        const tvlNum = Number(tvl_usd);
        const useUsd = Number.isFinite(tvlNum) && tvlNum > 0 ? tvlNum : undefined;
        const liq = useUsd !== undefined ? useUsd : Math.log10(Math.max(10, liqRaw));
        const weight = Math.max(1, liq) / Math.max(1, Number(fee_bps || 1));
        const feeRounded = Number.isFinite(Number(fee_bps)) ? Math.round(Number(fee_bps)) : undefined;
        edgesMap[id] = {
          id,
          source: a,
          target: b,
          dex,
          pool_id: poolId,
          source_account: accountA,
          target_account: accountB,
          fee_bps: feeRounded,
          liquidity: liq,
          liquidity_display: (useUsd ?? liqRaw) || undefined,
          weight,
          price_a_per_b: price,
          tvl_usd,
          pool_kind: poolKind,
          direction,
        };
        if (!nodesMap[a]) nodesMap[a] = { id: a, label: labelByMint[a] };
        if (!nodesMap[b]) nodesMap[b] = { id: b, label: labelByMint[b] };
      };

      // Pre-graph validator: fee bounds and price deviation vs USD references
      const sanityCfg = (CONFIG as any)?.sanity || {};
      const feeMin = Number.isFinite(Number(sanityCfg.feeMin)) ? Number(sanityCfg.feeMin) : 0;
      const feeMax = Number.isFinite(Number(sanityCfg.feeMax)) ? Number(sanityCfg.feeMax) : 10000;
      const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 10;
      const sanityEnabled = sanityCfg.enabled !== false;

      type NormPools = { amm: any[]; clmm: any[] };
      const validatePoolsForGraph = (norm: NormPools): NormPools => {
        const applyAtGraph = (sanityCfg as any).applyAtGraph !== false; // default on
        if (!sanityEnabled || !applyAtGraph) return norm;
        const out: NormPools = { amm: [], clmm: [] };
        const drop = { badFees: 0, priceOutliers: 0, nonFinitePrice: 0 } as any;
        const getUsd = (mint: string): number | undefined => {
          try { return priceStore.getPriceByMint(mint)?.usdc ?? undefined; } catch { return undefined; }
        };
        const isOk = (p: any): string | null => {
          const fb = Number(p?.fee_bps);
          if (Number.isFinite(fb) && (fb < feeMin || fb > feeMax)) return 'badFees';
          const price = Number((p as any)?.price_a_per_b);
          if (!Number.isFinite(price) || price <= 0) return 'nonFinitePrice';
          const aUsd = getUsd(p.mint_a);
          const bUsd = getUsd(p.mint_b);
          // Avoid double-applying price deviation sanity if source already sanitized
          const avoidDouble = (sanityCfg as any).avoidDoubleApply !== false; // default on
          const dex = String((p as any)?.dex || '');
          const kind = String((p as any)?.pool_kind || '');
          const sourceSanitized = (
            (dex === 'Orca' && kind === 'clmm' && ((CONFIG as any)?.sanity?.sanity_applyOrcaClmm ?? true) === true) ||
            (dex === 'Raydium' && kind === 'amm' && ((CONFIG as any)?.sanity?.sanity_applyRaydiumAmm ?? true) === true)
          );
          const skipDeviation = avoidDouble && sourceSanitized;
          if (!skipDeviation && Number.isFinite(aUsd as any) && Number.isFinite(bUsd as any) && (aUsd as number) > 0 && (bUsd as number) > 0) {
            // price is A per 1 B, USD ref should be USD(B)/USD(A)
            const ref = (bUsd as number) / (aUsd as number);
            const dev = Math.max(price / ref, ref / price);
            if (dev > maxDeviation) return 'priceOutliers';
          }
          return null;
        };
        for (const p of (norm.amm || [])) { const r = isOk(p); if (r) drop[r] = (drop[r] || 0) + 1; else out.amm.push(p); }
        for (const p of (norm.clmm || [])) { const r = isOk(p); if (r) drop[r] = (drop[r] || 0) + 1; else out.clmm.push(p); }
        try { logger.info('graph.sanity.filter', { feeMin, feeMax, maxDeviation, dropped: drop }); } catch {}
        try { emit('sanity-update', { ts: Date.now(), scope: 'graph', feeMin, feeMax, maxDeviation, dropped: drop }); } catch {}
        return out;
      };

      // Helper for TVL using USD prices if available
      const priceStore = await import('./priceStore.js');
      const getPriceByMintVar = (m: string) => {
        try { return priceStore.getPriceByMint(m); } catch { return undefined as any; }
      };
      const calibratePrice = (mintA: string, mintB: string, raw: number | undefined): number | undefined => {
        const getUsd = (m: string) => {
          try { return getPriceByMintVar(m)?.usdc ?? undefined; } catch { return undefined; }
        };
        return calibrateMagnitude(mintA, mintB, raw, getUsd);
      };
      const tvlUsd = (mintA: string, mintB: string, amountA?: number, amountB?: number): number | undefined => {
        try {
          const pa = getPriceByMintVar(mintA)?.usdc ?? null;
          const pb = getPriceByMintVar(mintB)?.usdc ?? null;
          const aUsd = (pa && amountA != null) ? pa * amountA : 0;
          const bUsd = (pb && amountB != null) ? pb * amountB : 0;
          const sum = aUsd + bUsd;
          return sum > 0 ? sum : undefined;
        } catch {
          return undefined;
        }
      };

      // Helper: fallback price using USD quotes if pool price missing
      const priceFromUsd = (mintA: string, mintB: string): number | undefined => {
        try {
          const pa = getPriceByMintVar(mintA)?.usdc ?? null;
          const pb = getPriceByMintVar(mintB)?.usdc ?? null;
          // We need A per 1 B; using USD prices => price = USD(B) / USD(A)
          if (pa && pb && pa > 0) return (pb as number) / (pa as number);
        } catch {}
        return undefined;
      };
      // Helper: stablecoin-aware TVL when one side is a stable (no external price needed)
      const STABLES = new Set<string>([
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
      ]);
      // Add reverse visualization edges so graph reflects tradable paths in both directions
      const rayValid = validatePoolsForGraph(ray as any);
      const safePoolId = (p: any): string | undefined => {
        try {
          const pid = String(p?.id || '');
          const ma = String((p as any)?.mint_a || '');
          const mb = String((p as any)?.mint_b || '');
          const aa = String((p as any)?.account_a || '');
          const ab = String((p as any)?.account_b || '');
          if (!pid) return undefined;
          if (pid === ma || pid === mb || pid === aa || pid === ab) return undefined;
          return pid;
        } catch { return undefined; }
      };
      for (const p of (rayValid.amm || [])) {
        ammTotal++;
        const decA = Number((p as any)?.decimals_a ?? decimalsByMint[p.mint_a] ?? NaN);
        const decB = Number((p as any)?.decimals_b ?? decimalsByMint[p.mint_b] ?? NaN);
        const amtAwhole = Number((p as any)?.amount_a_whole ?? NaN);
        const amtBwhole = Number((p as any)?.amount_b_whole ?? NaN);
        const amtA = Number((p as any)?.amount_a ?? NaN);
        const amtB = Number((p as any)?.amount_b ?? NaN);
        let usd: number | undefined = (p as any)?.tvl_usd;
        // Ensure forward price is strictly mint_a per 1 mint_b. Prefer whole amounts, else USD ref, else incoming price.
        let price: number | undefined = undefined;
        if (((p as any)?.amounts_are_whole && (Number.isFinite(amtAwhole) || Number.isFinite(amtBwhole))) || (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(amtA) && Number.isFinite(amtB))) {
          const wholeA = (p as any)?.amounts_are_whole ? amtAwhole : (amtA / Math.pow(10, decA));
          const wholeB = (p as any)?.amounts_are_whole ? amtBwhole : (amtB / Math.pow(10, decB));
          // Prefer external USD TVL if available
          usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
          // Primary: compute A per 1 B from amounts
          if (wholeB && (wholeB as number) > 0 && Number.isFinite(wholeA as any)) {
            price = (wholeA as number) / (wholeB as number);
          }
          // If only one side has a USD price, infer the other using pool price
          if ((usd == null || !(usd > 0)) && price && price > 0) {
            try {
              const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
              const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
              if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
                if (pa && !pb) {
                  // price = A per 1 B => 1 B in USD = price * pa
                  const bUsdPx = price * pa;
                  usd = (pa * (wholeA as number)) + (bUsdPx * (wholeB as number));
                } else if (pb && !pa) {
                  // price = A per 1 B => 1 A in B = 1/price, so A USD = pb / price
                  const aUsdPx = pb / price;
                  usd = (aUsdPx * (wholeA as number)) + (pb * (wholeB as number));
                }
              }
            } catch {}
          }
          // If no external USD prices, derive USD TVL when a stable is present
          if (usd == null || !(usd > 0)) {
            if (STABLES.has(p.mint_a) && price && price > 0) {
              // price = A per 1 B; A is stable (USDC). USD TVL = wholeA + price*wholeB
              usd = wholeA + price * wholeB;
            } else if (STABLES.has(p.mint_b) && price && price > 0) {
              // B is stable; price = A per 1 B => 1 B = 1 USD; A in USD = wholeA / price
              usd = wholeB + (wholeA / price);
            }
          }
        }
        if (Number.isFinite(usd as any) && (usd as number) > 0) ammUsd++;
        if (!price || price <= 0) price = priceFromUsd(p.mint_a, p.mint_b);
        // Fallback: if still missing, use incoming pool price when valid (assumed A per 1 B from normalization)
        if ((!price || price <= 0) && Number.isFinite((p as any)?.price_a_per_b as any) && (p as any).price_a_per_b > 0) {
          price = Number((p as any).price_a_per_b);
        }
        // Prefer notional (in B units) when USD TVL is missing
        let notionalB: number | undefined;
        try {
          // Prefer precomputed whole amounts when present
          const wholeA = Number.isFinite(amtAwhole) ? amtAwhole : (Number.isFinite(amtA) && Number.isFinite(decA) ? (amtA / Math.pow(10, decA)) : NaN);
          const wholeB = Number.isFinite(amtBwhole) ? amtBwhole : (Number.isFinite(amtB) && Number.isFinite(decB) ? (amtB / Math.pow(10, decB)) : NaN);
          // Derive price from whole amounts if still missing
          if ((!price || price <= 0) && Number.isFinite(wholeA) && Number.isFinite(wholeB) && (wholeB as number) > 0) {
            price = (wholeA as number) / (wholeB as number);
          }
          const contribB = Number.isFinite(wholeB) ? (wholeB as number) : 0;
          const contribA = (Number.isFinite(wholeA) && price && price > 0) ? ((wholeA as number) / (price as number)) : 0;
          const sum = contribA + contribB;
          if (sum > 0) notionalB = sum;
        } catch {}
        const pidAmm = safePoolId(p);
        const liqBase = Number((p as any)?.liquidity_base);
        const liqDisplayAmm = (usd && usd > 0) ? usd : (Number.isFinite(notionalB as any) && (notionalB as number) > 0 ? (notionalB as number) : (Number.isFinite(liqBase) && liqBase > 0 ? liqBase : undefined));
        const liqParamAmm = (p as any)?.liquidity_display ?? liqDisplayAmm;
        // Incoming price is A per 1 B.
        // Store display price consistently as A per 1 B for the edge direction.
        const fwdAmmRay = (price && price > 0) ? price : undefined;
        const revAmmRay = (fwdAmmRay && fwdAmmRay > 0) ? (1 / fwdAmmRay) : undefined;
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqParamAmm, fwdAmmRay, usd, pidAmm, (p as any).account_a, (p as any).account_b, 'amm', 'forward');
        // Use a distinct id for reverse edge when poolId exists to avoid overwriting forward
        const pidAmmRev = pidAmm ? `${pidAmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqParamAmm, revAmmRay, usd, pidAmmRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse');
        try { if (fwdAmmRay && revAmmRay) { const prod = fwdAmmRay * revAmmRay; if (!(prod > 1/1.02 && prod < 1.02)) logger.warn('graph.consistency.raydium.amm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdAmmRay, rev: revAmmRay, prod }); } } catch {}
        try {
          const eid = pidAmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidAmm ? `${pidAmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          const rawLiq = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0);
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
        } catch {}
      }
      const clampPrice = (px: number | undefined): number | undefined => {
        const min = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMin)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMin) : 1e-12;
        const max = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMax)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMax) : 1e12;
        const v = Number(px);
        if (!Number.isFinite(v) || !(v > 0)) return undefined;
        if (v < min || v > max) return undefined;
        return v;
      };
      for (const p of (rayValid.clmm || [])) {
        clmmTotal++;
        let price = (p as any)?.price_a_per_b as number | undefined;
        if (!price || !(price > 0)) price = priceFromUsd(p.mint_a, p.mint_b);
        // Compute USD TVL if we have vault amounts and decimals
        const decA = Number((p as any)?.decimals_a ?? decimalsByMint[p.mint_a] ?? NaN);
        const decB = Number((p as any)?.decimals_b ?? decimalsByMint[p.mint_b] ?? NaN);
        const amtA = Number((p as any)?.amount_a ?? NaN);
        const amtB = Number((p as any)?.amount_b ?? NaN);
        let usd: number | undefined = (p as any)?.tvl_usd;
        let liqRaw = Number(p.liquidity || 0);
        if ((!usd || !(usd > 0)) && Number.isFinite(decA) && Number.isFinite(decB)) {
          const wholeA = Number.isFinite(amtA) ? (amtA / Math.pow(10, decA)) : NaN;
          const wholeB = Number.isFinite(amtB) ? (amtB / Math.pow(10, decB)) : NaN;
          if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
            usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
          }
          // If no external USD prices, but we have pool price + a stable side, compute USD locally
          if ((!usd || !(usd > 0)) && price && price > 0) {
            // General inference: if exactly one side has USD price, derive the other using pool price
            try {
              const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
              const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
              if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
                if (pa && !pb) {
                  const bUsdPx = price * pa; // 1 B = price A; A USD = pa
                  usd = (pa * (wholeA as number)) + (bUsdPx * (wholeB as number));
                } else if (pb && !pa) {
                  const aUsdPx = pb / price; // 1 A = (1/price) B; B USD = pb
                  usd = (aUsdPx * (wholeA as number)) + (pb * (wholeB as number));
                }
              }
            } catch {}
            if (STABLES.has(p.mint_a) && Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
              // A is stable (1 USD each). price = A per 1 B.
              // USD TVL = wholeA + price * wholeB
              usd = wholeA + price * wholeB;
            } else if (STABLES.has(p.mint_b) && Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
              // B is stable. price = A per 1 B => A in USD = wholeA / price
              usd = wholeB + (wholeA / price);
            }
          }
          // If still no USD, set a reasonable notional (in units of B) as display fallback
          if ((!usd || !(usd > 0)) && price && price > 0) {
            // Notional in B units: B + A/price
            if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
              liqRaw = wholeB + (wholeA / price);
            }
          }
        } else {
          if (!Number.isFinite(amtA) || !Number.isFinite(amtB)) clmmMissingAmounts++;
          if (!Number.isFinite(decA) || !Number.isFinite(decB)) clmmMissingDecimals++;
        }
        if (Number.isFinite(usd as any) && (usd as number) > 0) clmmUsd++;
        const pidClmm = safePoolId(p);
        const liqDisplay = (p as any)?.liquidity_display ?? ((usd && usd > 0) ? usd : liqRaw);
        // CLMM: calibrate then apply orientation rule
        price = calibratePrice(p.mint_a, p.mint_b, price);
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          const ref = (pa && pb && pb > 0) ? ((pb as number) / (pa as number)) : undefined;
          if (price && ref) {
            const dev = Math.max(price / ref, ref / price);
            const fwd = 1 / price, rev = price;
            const clampMin = Number(((CONFIG as any)?.sanity as any)?.priceClampMin) || 1e-12;
            const clampMax = Number(((CONFIG as any)?.sanity as any)?.priceClampMax) || 1e12;
            if (dev > 5 || fwd > 1e4 || rev > 1e4 || price < clampMin || price > clampMax) {
              logger.warn('graph.calibrate.raydium.clmm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, calibrated: price, ref, dev, fwd, rev });
            }
          }
        } catch {}
        // Forward + reverse with strict reciprocal rule and consistency guard
        const fwdR = clampPrice((price && price > 0) ? price : undefined);
        const revR = (fwdR && fwdR > 0) ? (1 / fwdR) : undefined;
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqDisplay, fwdR, usd, pidClmm, (p as any).account_a, (p as any).account_b, 'clmm', 'forward');
        const pidClmmRev = pidClmm ? `${pidClmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqDisplay, revR, usd, pidClmmRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse');
        try {
          if (fwdR && revR) {
            const prod = fwdR * revR;
            const ok = prod > 1/1.02 && prod < 1.02;
            if (!ok) logger.warn('graph.consistency.raydium.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdR, rev: revR, prod });
          }
        } catch {}
        try {
          const eid = pidClmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidClmm ? `${pidClmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
        } catch {}
      }
      const orcValid = validatePoolsForGraph(orc as any);
      const metValid = validatePoolsForGraph(met as any);
      // Helper: triangulate A per B using a pivot C present in pools (no USD refs needed)
      const PIVOTS: string[] = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (as seen in logs)
      ];
      const allPools: any[] = [
        ...(rayValid.amm || []), ...(rayValid.clmm || []),
        ...(orcValid.amm || []), ...(orcValid.clmm || []),
      ];
      const getPriceAPerBFromPools = (A: string, B: string): number | undefined => {
        let best: { v: number; w: number } | null = null;
        for (const p of allPools) {
          const w = Number((p as any)?.liquidity_display || (p as any)?.tvl_usd || 0) || 1;
          const px = Number((p as any)?.price_a_per_b || 0);
          if (!(px > 0)) continue;
          let cand: number | undefined;
          if (p.mint_a === A && p.mint_b === B) cand = px; else if (p.mint_a === B && p.mint_b === A) cand = 1 / px;
          if (cand && cand > 0) {
            if (!best || w > best.w) best = { v: cand, w };
          }
        }
        return best?.v;
      };
      const triangulateAPerB = (A: string, B: string): number | undefined => {
        for (const C of PIVOTS) {
          if (C === A || C === B) continue;
          const aPerC = getPriceAPerBFromPools(A, C);
          const bPerC = getPriceAPerBFromPools(B, C);
          if (aPerC && bPerC && aPerC > 0 && bPerC > 0) {
            const implied = aPerC / bPerC;
            if (isFinite(implied) && implied > 0) return implied;
          }
        }
        return undefined;
      };
      const adjustByPowerOfTen = (val: number, target: number): number => {
        if (!(val > 0) || !(target > 0)) return val;
        const ratio = target / val;
        // choose k in [-8,8] minimizing |log10(val*10^k/target)|
        let best = val; let bestErr = Number.POSITIVE_INFINITY;
        for (let k = -8; k <= 8; k++) {
          const cand = val * Math.pow(10, k);
          const err = Math.abs(Math.log10(cand / target));
          if (err < bestErr) { bestErr = err; best = cand; }
        }
        return best;
      };
      for (const p of (orcValid.amm || [])) {
        const pid = safePoolId(p);
        const liqParamOrcaAmm = (p as any)?.liquidity_display ?? (p as any).liquidity_base;
        // Orca AMM: incoming price is A per 1 B. Calibrate then apply orientation rule.
        let priceAmmOrca = calibratePrice(p.mint_a, p.mint_b, (p as any).price_a_per_b);
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          const ref = (pa && pb && pb > 0) ? ((pb as number) / (pa as number)) : undefined;
          if (priceAmmOrca) {
            const fwd = 1 / priceAmmOrca, rev = priceAmmOrca;
            if (ref) {
              const dev = Math.max(priceAmmOrca / ref, ref / priceAmmOrca);
              if (dev > 5 || fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.warn('graph.calibrate.orca.amm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceAmmOrca, ref, dev, fwd, rev });
              }
            } else {
              if (fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.warn('graph.calibrate.orca.amm magnitude', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceAmmOrca, fwd, rev });
              }
            }
          }
        } catch {}
        // Forward + reverse with strict reciprocal rule and consistency guard
        const fwdAmm = (priceAmmOrca && priceAmmOrca > 0) ? priceAmmOrca : undefined;
        const revAmm = (fwdAmm && fwdAmm > 0) ? (1 / fwdAmm) : undefined;
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaAmm, fwdAmm, undefined, pid, (p as any).account_a, (p as any).account_b, 'amm', 'forward');
        const pidAmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaAmm, revAmm, undefined, pidAmmOrcaRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse');
        try { if (fwdAmm && revAmm) { const prod = fwdAmm * revAmm; if (!(prod > 1/1.02 && prod < 1.02)) logger.warn('graph.consistency.orca.amm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdAmm, rev: revAmm, prod }); } } catch {}
      }
      for (const p of (orcValid.clmm || [])) {
        // amounts from HTTP (raw token units) need decimals to convert to whole tokens for USD TVL
        const decA = Number((p as any)?.decimals_a ?? NaN);
        const decB = Number((p as any)?.decimals_b ?? NaN);
        const amtA = Number((p as any)?.amount_a ?? NaN);
        const amtB = Number((p as any)?.amount_b ?? NaN);
        let usd: number | undefined = (p as any)?.tvl_usd;
        if ((!usd || !(usd > 0)) && Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(amtA) && Number.isFinite(amtB)) {
          const wholeA = amtA / Math.pow(10, decA);
          const wholeB = amtB / Math.pow(10, decB);
          usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
        }
        const pid = safePoolId(p);
        const liqParamOrcaClmm = (p as any)?.liquidity_display ?? p.liquidity;
        // Prefer recomputing A-per-B from sqrtPrice and decimals for Orca CLMM
        let priceClmmOrca: number | undefined = undefined;
        try {
          const s64 = Number((p as any)?.sqrt_price_x64 || 0);
          const decA = Number((p as any)?.decimals_a ?? decimalsByMint[p.mint_a] ?? NaN);
          const decB = Number((p as any)?.decimals_b ?? decimalsByMint[p.mint_b] ?? NaN);
          if (s64 > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
            const ratio = s64 / Math.pow(2, 64);
            const scale = Math.pow(10, decB - decA);
            const derived = scale / (ratio * ratio); // A per 1 B
            if (Number.isFinite(derived) && derived > 0) priceClmmOrca = derived;
          }
        } catch {}
        if (!(priceClmmOrca && priceClmmOrca > 0)) {
          priceClmmOrca = calibratePrice(p.mint_a, p.mint_b, (p as any).price_a_per_b);
        }
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          const ref = (pa && pb && pb > 0) ? ((pb as number) / (pa as number)) : undefined;
          if (priceClmmOrca) {
            const fwd = 1 / priceClmmOrca, rev = priceClmmOrca;
            if (ref) {
              const dev = Math.max(priceClmmOrca / ref, ref / priceClmmOrca);
              if (dev > 5 || fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.warn('graph.calibrate.orca.clmm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceClmmOrca, ref, dev, fwd, rev, decA: (p as any)?.decimals_a, decB: (p as any)?.decimals_b, sqrt_price_x64: (p as any)?.sqrt_price_x64 });
              }
            } else {
              if (fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.warn('graph.calibrate.orca.clmm magnitude', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceClmmOrca, fwd, rev, decA: (p as any)?.decimals_a, decB: (p as any)?.decimals_b, sqrt_price_x64: (p as any)?.sqrt_price_x64 });
              }
            }
          }
        } catch {}
        // Forward + reverse with strict reciprocal rule and consistency guard
        const fwdClmm = clampPrice((priceClmmOrca && priceClmmOrca > 0) ? priceClmmOrca : undefined);
        const revClmm = (fwdClmm && fwdClmm > 0) ? (1 / fwdClmm) : undefined;
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaClmm, fwdClmm, usd, pid, (p as any).account_a, (p as any).account_b, 'clmm', 'forward');
        const pidClmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaClmm, revClmm, usd, pidClmmOrcaRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse');
        try { if (fwdClmm && revClmm) { const prod = fwdClmm * revClmm; if (!(prod > 1/1.02 && prod < 1.02)) logger.warn('graph.consistency.orca.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdClmm, rev: revClmm, prod }); } } catch {}
        try {
          const eid = pid || `${p.mint_a}->${p.mint_b}-Orca`;
          const rid = pid ? `${pid}-rev` : `${p.mint_b}->${p.mint_a}-Orca`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
        } catch {}
      }
      // Meteora CLMM (DLMM) edges: treat like CLMM; incoming price is A per 1 B
      for (const p of (metValid.clmm || [])) {
        // Compute USD TVL if amounts/decimals present
        const decA = Number((p as any)?.decimals_a ?? NaN);
        const decB = Number((p as any)?.decimals_b ?? NaN);
        const amtA = Number((p as any)?.amount_a ?? NaN);
        const amtB = Number((p as any)?.amount_b ?? NaN);
        let usd: number | undefined = (p as any)?.tvl_usd;
        if ((!usd || !(usd > 0)) && Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(amtA) && Number.isFinite(amtB)) {
          const wholeA = amtA / Math.pow(10, decA);
          const wholeB = amtB / Math.pow(10, decB);
          usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
        }
        // Calibrate price; for DLMM we only have price_a_per_b, no sqrt
        let priceMet: number | undefined = calibratePrice(p.mint_a, p.mint_b, (p as any).price_a_per_b);
        // Forward edge must carry A per 1 B; reverse is strict reciprocal
        const pid = String((p as any)?.id || undefined) || undefined;
        const liqParam = (p as any)?.liquidity_display ?? (usd && usd > 0 ? usd : (p as any)?.pool_liquidity_raw);
        const fwdMet = clampPrice((priceMet && priceMet > 0) ? priceMet : undefined);
        const revMet = (fwdMet && fwdMet > 0) ? (1 / fwdMet) : undefined;
        addEdge(p.mint_a, p.mint_b, 'Meteora', p.fee_bps, liqParam, fwdMet, usd, pid, (p as any).account_a, (p as any).account_b, 'clmm', 'forward');
        const pidRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Meteora', p.fee_bps, liqParam, revMet, usd, pidRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse');
        try { if (fwdMet && revMet) { const prod = fwdMet * revMet; if (!(prod > 1/1.02 && prod < 1.02)) logger.warn('graph.consistency.meteora.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdMet, rev: revMet, prod }); } } catch {}
        try {
          const eid = pid || `${p.mint_a}->${p.mint_b}-Meteora`;
          const rid = pid ? `${pid}-rev` : `${p.mint_b}->${p.mint_a}-Meteora`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).pool_liquidity_raw || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).pool_liquidity_raw || 0) || undefined;
        } catch {}
      }

      // Compute degree (optional)
      const degree: Record<string, number> = {};
      for (const e of Object.values(edgesMap)) {
        degree[e.source] = (degree[e.source] || 0) + 1;
        degree[e.target] = (degree[e.target] || 0) + 1;
      }
      for (const n of Object.values(nodesMap)) n.degree = degree[n.id] || 0;

      // Emit sample edges for inspection (both AMM and CLMM), prefer canonical SOL/USDC if present
      try {
        const allEdges = Object.values(edgesMap);
        const SOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const isSolUsdc = (e: any) => (e.source === SOL && e.target === USDC) || (e.source === USDC && e.target === SOL);
        const pick = (kind: 'amm'|'clmm') => {
          const list = allEdges.filter((e) => (e as any).pool_kind === kind);
          const pref = list.find(isSolUsdc);
        const sample = pref ? [pref] : list.slice(0, 5);
          return sample.map((e) => ({ id: e.id, dex: e.dex, source: e.source, target: e.target, pool_kind: (e as any).pool_kind, direction: (e as any).direction, fee_bps: e.fee_bps, price_a_per_b: e.price_a_per_b, inverse_per_source: (e as any)?.price_a_per_b && (e as any).price_a_per_b > 0 ? (1 / (e as any).price_a_per_b) : undefined, tvl_usd: e.tvl_usd, liquidity_display: e.liquidity_display }));
        };
        const sampleAmm = pick('amm');
        const sampleClmm = pick('clmm');
        logger.info('graph.edges sample', { amm: sampleAmm, clmm: sampleClmm, cat: 'graph' });
      } catch {}

      const snapshot: GraphSnapshot = {
        version: (lastSnapshot?.version || 0) + 1,
        timestamp: Date.now(),
        nodes: Object.values(nodesMap),
        edges: Object.values(edgesMap),
      };
      lastSnapshot = snapshot;
      lastAt = now;
      try { logger.info('graph.tvl.stats', { amm: { total: ammTotal, usd: ammUsd }, clmm: { total: clmmTotal, usd: clmmUsd, missingAmounts: clmmMissingAmounts, missingDecimals: clmmMissingDecimals } }); } catch {}
      logger.info('graph.snapshot built', { nodes: snapshot.nodes.length, edges: snapshot.edges.length });
      return snapshot;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export { diffSnapshots };

export function startGraphStream(io: SocketIOServer): void {
  // Emit initial snapshot periodically and diffs when changed
  let last: GraphSnapshot | null = null;
  const period = Math.max(1000, Number((CONFIG.system as any)?.graphStreamIntervalMs || 5000));
  const tick = async () => {
    try {
      // Do not auto-refresh pool sources here; rely on explicit /arb/pools/refresh
      const snap = await getGraphSnapshot(true);
      if (!last) {
        io.emit('graph-snapshot', snap);
        // Push initial snapshot to arb-rs to enter backend-graph mode immediately
        try { await pushArbGraphSnapshot(snap); } catch {}
        try { await notifyArbServiceRefresh(); } catch {}
        try { logger.info('graph.push initial snapshot', { version: snap.version, nodes: snap.nodes.length, edges: snap.edges.length, cat: 'graph' }); } catch {}
        try { emit('log', { level: 'info', message: `graph:push snapshot v=${snap.version} nodes=${snap.nodes.length} edges=${snap.edges.length}`, timestamp: new Date().toISOString(), context: { cat: 'graph' } }); } catch {}
        try { enablePoolWebsocketRefreshes(); } catch {}
        last = snap;
        return;
      }
      const diff = diffSnapshots(last, snap);
      const changed = diff.addedNodes.length || diff.updatedNodes.length || diff.removedNodeIds.length || diff.addedEdges.length || diff.updatedEdges.length || diff.removedEdgeIds.length;
      if (changed) {
        io.emit('graph-update', diff);
        // Push diff to arb-rs; occasionally rebase with full snapshot per rebase policy
        try {
          const nowMs = Date.now();
          const shouldRebase = (diffSinceRebase >= REBASE_DIFF_THRESHOLD) || (nowMs - lastRebaseMs > REBASE_TIME_MS);
          if (shouldRebase) {
            try { await pushArbGraphSnapshot(snap); } catch {}
            diffSinceRebase = 0; lastRebaseMs = nowMs;
      try { logger.info('graph.push rebase snapshot', { version: snap.version, nodes: snap.nodes.length, edges: snap.edges.length, cat: 'graph', code: LogCode.GRAPH_PUSH_SNAPSHOT }); } catch {}
            try { emit('log', { level: 'info', message: `graph:push rebase v=${snap.version} nodes=${snap.nodes.length} edges=${snap.edges.length}`, timestamp: new Date().toISOString(), context: { cat: 'graph' } }); } catch {}
          } else {
            try { await pushArbGraphDiff(diff); } catch {}
            diffSinceRebase += (diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length);
            try {
              const ch = diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length;
              logger.info('graph.push diff', { version: diff.version, changes: ch, cat: 'graph', code: LogCode.GRAPH_PUSH_DIFF });
              emit('log', { level: 'info', message: `graph:push diff v=${diff.version} changes=${ch}`, timestamp: new Date().toISOString(), context: { cat: 'graph' } });
            } catch {}
          }
          try { await notifyArbServiceRefresh(); } catch {}
        } catch {}
        last = snap;
      }
    } catch (e: any) {
      logger.warn('graph.stream tick failed', { error: String(e?.message || e) });
    }
  };
  setInterval(tick, period);
  // Initial tick is delayed/controlled by index.ts (post-listen) via GRAPH_START_DELAY_MS or first socket connection
}

export async function findPath(fromMint: string, toMint: string): Promise<{ path: string[] }> {
  const snap = await getGraphSnapshot(false);
  return findPathInSnapshot(snap, fromMint, toMint);
}


