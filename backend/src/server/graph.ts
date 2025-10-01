import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger.js';
import { readJson } from '../utils/fs.js';
import { notifyArbServiceRefresh, emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { getRaydiumPoolsNormalized, getOrcaPoolsCached, enablePoolWebsocketRefreshes } from './pools.js';
import { loadTokenMap } from '../utils/tokens.js';

export type GraphNode = {
  id: string;            // mint address (base58)
  label?: string;        // symbol if known
  degree?: number;       // computed degree (optional)
};

export type GraphEdge = {
  id: string;            // `${source}-${target}-${dex}` stable
  source: string;        // mint
  target: string;        // mint
  dex: string;           // Raydium | Orca | ...
  pool_id?: string;      // underlying pool address when available
  source_account?: string; // token account/vault corresponding to source
  target_account?: string; // token account/vault corresponding to target
  fee_bps?: number;
  liquidity?: number;    // normalized liquidity signal (used for layout/weight)
  liquidity_display?: number; // display: prefer USD TVL, else raw pool liquidity
  weight?: number;       // layout weight (derived from liquidity / fee)
  price_a_per_b?: number; // A per 1 B
  tvl_usd?: number;       // approximate TVL in USD for layout/inspection
  pool_kind?: 'amm' | 'clmm'; // explicit pool kind
  direction?: 'forward' | 'reverse'; // edge direction relative to pool orientation
  pool_liquidity_raw?: number; // raw pool liquidity metric when provided by the source (e.g., CLMM liquidity)
};

export type GraphSnapshot = {
  version: number;
  timestamp: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphDiff = {
  version: number;
  timestamp: number;
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodeIds: string[];
  addedEdges: GraphEdge[];
  updatedEdges: GraphEdge[];
  removedEdgeIds: string[];
};

let lastSnapshot: GraphSnapshot | null = null;
let inflight: Promise<GraphSnapshot> | null = null;
const SNAPSHOT_TTL_MS = 30_000;
let lastAt = 0;

export async function getGraphSnapshot(force = false): Promise<GraphSnapshot> {
  const now = Date.now();
  if (!force && lastSnapshot && now - lastAt < SNAPSHOT_TTL_MS) return lastSnapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Do not trigger background fetching unless explicitly requested by refresh API
      // Build graph from whatever is in caches right now
      const { peekRaydiumPools, peekOrcaPools } = await import('./pools.js');
      const rayRaw = peekRaydiumPools();
      const orcRaw = peekOrcaPools();
      // Apply scoping according to CONFIG.system.scopePools and scopePoolsMode
      const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
      const scoped = CONFIG.system.scopePools !== false && mode !== 'none';
      let ray = rayRaw; let orc = orcRaw;
      if (scoped) {
        const set = new Set<string>();
        if (mode === 'watchlist') {
          try { const wl = await readJson<any[]>(CONFIG.watchlistPath, []); for (const t of wl) set.add(typeof t === 'string' ? t : String(t?.id || '')); } catch {}
        } else if (mode === 'jupiter') {
          try { const { loadJupiterTokenMap } = await import('../utils/tokens.js'); const jmap = await loadJupiterTokenMap(); for (const k of Object.keys(jmap)) set.add(k); } catch {}
        }
        const scope = (p: any) => ({
          amm: (p?.amm || []).filter((x: any) => set.size === 0 || set.has(x.mint_a) || set.has(x.mint_b)),
          clmm: (p?.clmm || []).filter((x: any) => set.size === 0 || set.has(x.mint_a) || set.has(x.mint_b)),
        });
        const rScoped = scope(rayRaw);
        const oScoped = scope(orcRaw);
        // If scoping drops everything but upstream has pools, fall back to unscoped to avoid empty graph
        const upstreamR = (rayRaw.amm?.length || 0) + (rayRaw.clmm?.length || 0);
        const scopedR = (rScoped.amm.length || 0) + (rScoped.clmm.length || 0);
        const upstreamO = (orcRaw.amm?.length || 0) + (orcRaw.clmm?.length || 0);
        const scopedO = (oScoped.amm.length || 0) + (oScoped.clmm.length || 0);
        ray = (upstreamR > 0 && scopedR === 0) ? rayRaw : rScoped;
        orc = (upstreamO > 0 && scopedO === 0) ? orcRaw : oScoped;
      }
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
      const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
      const sanityEnabled = sanityCfg.enabled !== false;

      type NormPools = { amm: any[]; clmm: any[] };
      const validatePoolsForGraph = (norm: NormPools): NormPools => {
        if (!sanityEnabled) return norm;
        const out: NormPools = { amm: [], clmm: [] };
        const drop = { badFees: 0, priceOutliers: 0, nonFinitePrice: 0 } as any;
        const getUsd = (mint: string): number | undefined => {
          try { return (require('./priceStore.js') as any).getPriceByMint(mint)?.usdc ?? undefined; } catch { return undefined; }
        };
        const isOk = (p: any): string | null => {
          const fb = Number(p?.fee_bps);
          if (Number.isFinite(fb) && (fb < feeMin || fb > feeMax)) return 'badFees';
          const price = Number((p as any)?.price_a_per_b);
          if (!Number.isFinite(price) || price <= 0) return 'nonFinitePrice';
          const aUsd = getUsd(p.mint_a);
          const bUsd = getUsd(p.mint_b);
          if (Number.isFinite(aUsd as any) && Number.isFinite(bUsd as any) && (aUsd as number) > 0 && (bUsd as number) > 0) {
            const ref = (aUsd as number) / (bUsd as number);
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
      const { getPriceByMint } = await import('./priceStore.js');
      const tvlUsd = (mintA: string, mintB: string, amountA?: number, amountB?: number): number | undefined => {
        try {
          const pa = getPriceByMint(mintA)?.usdc ?? null;
          const pb = getPriceByMint(mintB)?.usdc ?? null;
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
          const { getPriceByMint } = require('./priceStore.js');
          const pa = getPriceByMint(mintA)?.usdc ?? null;
          const pb = getPriceByMint(mintB)?.usdc ?? null;
          if (pa && pb && pb > 0) return pa / pb;
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
        let price: number | undefined = Number((p as any)?.price_a_per_b || 0) || undefined;
        if (((p as any)?.amounts_are_whole && (Number.isFinite(amtAwhole) || Number.isFinite(amtBwhole))) || (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(amtA) && Number.isFinite(amtB))) {
          const wholeA = (p as any)?.amounts_are_whole ? amtAwhole : (amtA / Math.pow(10, decA));
          const wholeB = (p as any)?.amounts_are_whole ? amtBwhole : (amtB / Math.pow(10, decB));
          // Prefer external USD TVL if available
          usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
          if (!price || price <= 0) { if (wholeB > 0) price = wholeA / wholeB; }
          // If only one side has a USD price, infer the other using pool price
          if ((usd == null || !(usd > 0)) && price && price > 0) {
            try {
              const pa = getPriceByMint(p.mint_a)?.usdc ?? null;
              const pb = getPriceByMint(p.mint_b)?.usdc ?? null;
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
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqParamAmm, price, usd, pidAmm, (p as any).account_a, (p as any).account_b, 'amm', 'forward');
        // Use a distinct id for reverse edge when poolId exists to avoid overwriting forward
        const pidAmmRev = pidAmm ? `${pidAmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqParamAmm, price ? (1 / price) : undefined, usd, pidAmmRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse');
        try {
          const eid = pidAmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidAmm ? `${pidAmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          const rawLiq = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0);
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
        } catch {}
      }
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
              const pa = getPriceByMint(p.mint_a)?.usdc ?? null;
              const pb = getPriceByMint(p.mint_b)?.usdc ?? null;
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
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqDisplay, price, usd, pidClmm, (p as any).account_a, (p as any).account_b, 'clmm', 'forward');
        const pidClmmRev = pidClmm ? `${pidClmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqDisplay, (price && price > 0) ? (1 / price) : undefined, usd, pidClmmRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse');
        try {
          const eid = pidClmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidClmm ? `${pidClmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
        } catch {}
      }
      const orcValid = validatePoolsForGraph(orc as any);
      for (const p of (orcValid.amm || [])) {
        const pid = safePoolId(p);
        const liqParamOrcaAmm = (p as any)?.liquidity_display ?? (p as any).liquidity_base;
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaAmm, p.price_a_per_b, undefined, pid, (p as any).account_a, (p as any).account_b, 'amm', 'forward');
        const pidAmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaAmm, p.price_a_per_b ? (1 / p.price_a_per_b) : undefined, undefined, pidAmmOrcaRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse');
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
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaClmm, p.price_a_per_b, usd, pid, (p as any).account_a, (p as any).account_b, 'clmm', 'forward');
        const pidClmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaClmm, p.price_a_per_b ? (1 / p.price_a_per_b) : undefined, usd, pidClmmOrcaRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse');
        try {
          const eid = pid || `${p.mint_a}->${p.mint_b}-Orca`;
          const rid = pid ? `${pid}-rev` : `${p.mint_b}->${p.mint_a}-Orca`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
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
          return sample.map((e) => ({ id: e.id, dex: e.dex, source: e.source, target: e.target, pool_kind: (e as any).pool_kind, direction: (e as any).direction, fee_bps: e.fee_bps, price_a_per_b: e.price_a_per_b, tvl_usd: e.tvl_usd, liquidity_display: e.liquidity_display }));
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

export function diffSnapshots(prev: GraphSnapshot | null, next: GraphSnapshot): GraphDiff {
  const pNodes = new Map(prev?.nodes.map(n => [n.id, n]) || []);
  const pEdges = new Map(prev?.edges.map(e => [e.id, e]) || []);
  const nNodes = new Map(next.nodes.map(n => [n.id, n]));
  const nEdges = new Map(next.edges.map(e => [e.id, e]));

  const addedNodes: GraphNode[] = [];
  const updatedNodes: GraphNode[] = [];
  const removedNodeIds: string[] = [];
  for (const [id, n] of nNodes) {
    const p = pNodes.get(id);
    if (!p) addedNodes.push(n);
    else if (JSON.stringify(p) !== JSON.stringify(n)) updatedNodes.push(n);
  }
  for (const [id] of pNodes) if (!nNodes.has(id)) removedNodeIds.push(id);

  const addedEdges: GraphEdge[] = [];
  const updatedEdges: GraphEdge[] = [];
  const removedEdgeIds: string[] = [];
  for (const [id, e] of nEdges) {
    const p = pEdges.get(id);
    if (!p) addedEdges.push(e);
    else if (JSON.stringify(p) !== JSON.stringify(e)) updatedEdges.push(e);
  }
  for (const [id] of pEdges) if (!nEdges.has(id)) removedEdgeIds.push(id);

  return {
    version: next.version,
    timestamp: next.timestamp,
    addedNodes, updatedNodes, removedNodeIds,
    addedEdges, updatedEdges, removedEdgeIds,
  };
}

export function startGraphStream(io: SocketIOServer): void {
  // Emit initial snapshot periodically and diffs when changed
  let last: GraphSnapshot | null = null;
  const period = 30_000;
  const tick = async () => {
    try {
      const snap = await getGraphSnapshot(false);
      if (!last) {
        io.emit('graph-snapshot', snap);
        try { enablePoolWebsocketRefreshes(); } catch {}
        last = snap;
        return;
      }
      const diff = diffSnapshots(last, snap);
      const changed = diff.addedNodes.length || diff.updatedNodes.length || diff.removedNodeIds.length || diff.addedEdges.length || diff.updatedEdges.length || diff.removedEdgeIds.length;
      if (changed) {
        io.emit('graph-update', diff);
        try { await notifyArbServiceRefresh(); } catch {}
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
  const adj = new Map<string, Set<string>>();
  for (const n of snap.nodes) adj.set(n.id, new Set());
  for (const e of snap.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  const start = fromMint; const goal = toMint;
  if (!adj.has(start) || !adj.has(goal)) return { path: [] };
  const queue: string[] = [start];
  const prev = new Map<string, string | null>();
  prev.set(start, null);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    for (const nxt of (adj.get(cur) || [])) {
      if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
    }
  }
  if (!prev.has(goal)) return { path: [] };
  const out: string[] = [];
  let cur: string | null = goal;
  while (cur) { out.push(cur); cur = prev.get(cur) || null; }
  out.reverse();
  return { path: out };
}


