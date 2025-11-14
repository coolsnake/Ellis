import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger.js';
import { LogCode } from '../utils/logging.js';
import { readJson } from '../utils/fs.js';
import { emit } from './realtime.js';
import { pushArbGraphSnapshot, pushArbGraphDiff } from './graphPushOrchestrator.js';
import { shouldPushGraphUpdate, logPushDecision } from './graph.push.coordinator.js';
import { computePriceForward } from './graph.pricing.js';
import { CONFIG } from '../utils/config.js';
import { getRaydiumPoolsNormalized, getOrcaPoolsCached, enablePoolWebsocketRefreshes, peekMeteoraPools, getMeteoraPoolsCached, peekMeteoraBalancedPools } from './pools.js';
import { loadTokenMap } from '../utils/tokens.js';
import { fetch } from 'undici';
import { calibrateMagnitude } from './priceCalib.js';
import type { GraphNode, GraphEdge, GraphSnapshot, GraphDiff } from './graph.types.js';
import { createWorkerClient, WorkerClient } from '../workers/client.js';
import type { GraphWorkerRequest, GraphWorkerResponse, GraphIncrementalRequest } from '../workers/graphDiff.types.js';
import { computeIncrementalGraphUpdate } from './graph.worker.compute.js';
import { isDexKindAllowed, type EdgeAllow } from './graph.edges.js';
export type { GraphNode, GraphEdge, GraphSnapshot, GraphDiff } from './graph.types.js';
import { diffSnapshots } from './graph.diff.js';
import { findPathInSnapshot } from './graph.path.js';
import type { PoolsPayload } from './pools/types.js';



// Lite view types and mappers (for UI payload minimization)
type GraphEdgeLite = Pick<GraphEdge, 'id' | 'source' | 'target' | 'dex' | 'pool_id' | 'weight'>;

const toLiteEdge = (e: GraphEdge): GraphEdgeLite => ({
  id: e.id,
  source: e.source,
  target: e.target,
  dex: e.dex,
  pool_id: e.pool_id,
  weight: e.weight,
});

export const toLiteSnapshot = (snap: GraphSnapshot): GraphSnapshot => ({
  version: snap.version,
  timestamp: snap.timestamp,
  nodes: snap.nodes,
  // Cast ok: GraphEdge fields are optional; lite subset is valid at runtime for UI
  edges: (snap.edges as any[]).map(toLiteEdge as any) as any,
});

export const toLiteDiff = (d: GraphDiff): GraphDiff => ({
  version: d.version,
  timestamp: d.timestamp,
  addedNodes: d.addedNodes,
  updatedNodes: d.updatedNodes,
  removedNodeIds: d.removedNodeIds,
  // Cast ok: see note above
  addedEdges: (d.addedEdges as any[]).map(toLiteEdge as any) as any,
  updatedEdges: (d.updatedEdges as any[]).map(toLiteEdge as any) as any,
  removedEdgeIds: d.removedEdgeIds,
});

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
let lastRebuildMs = 0;
let lastRebuildHadChanges = false;
const MIN_REBUILD_GAP_MS = Math.max(100, Number((CONFIG.system as any)?.graphMinRebuildGapMs || 500));

const env = (typeof globalThis !== 'undefined' && (globalThis as any)?.process?.env) ? (globalThis as any).process.env : {} as Record<string, string>;
const GRAPH_WORKER_DISABLED = String(env.GRAPH_WORKER_DISABLED ?? env.ARB_GRAPH_WORKER_DISABLED ?? '').toLowerCase() === 'true';
const GRAPH_WORKER_MAX_QUEUE = Math.max(1, Number(env.GRAPH_WORKER_MAX_QUEUE ?? env.ARB_GRAPH_WORKER_MAX_QUEUE ?? 4));
const GRAPH_WORKER_TIMEOUT_MS = Math.max(2000, Number(env.GRAPH_WORKER_TIMEOUT_MS ?? env.ARB_GRAPH_WORKER_TIMEOUT_MS ?? 8000));
const GRAPH_WORKER_IDLE_MS = Math.max(0, Number(env.GRAPH_WORKER_IDLE_MS ?? env.ARB_GRAPH_WORKER_IDLE_MS ?? 60_000));
const GRAPH_WORKER_CONCURRENCY = Math.max(1, Number(env.GRAPH_WORKER_CONCURRENCY ?? env.ARB_GRAPH_WORKER_CONCURRENCY ?? 1));

let graphWorkerClient: WorkerClient<GraphWorkerRequest, GraphWorkerResponse> | null = null;
let graphWorkerUnavailable = GRAPH_WORKER_DISABLED;
let graphWorkerFailureCount = 0;

// Runtime-only set of pool ids to drop from the graph. Not persisted across restarts.
const droppedPoolIds: Set<string> = new Set<string>();

export function dropPoolRuntime(id: string): { added: boolean; current: string[] } {
  const key = String(id || '').trim();
  if (!key) return { added: false, current: Array.from(droppedPoolIds) };
  const before = droppedPoolIds.size;
  droppedPoolIds.add(key);
  try { logger.info('graph.drop.runtime', { pool_id: key, total: droppedPoolIds.size }); } catch {}
  return { added: droppedPoolIds.size > before, current: Array.from(droppedPoolIds) };
}

export function listDroppedPools(): string[] {
  return Array.from(droppedPoolIds);
}

// Edge allowlist loaded from arb engine config (backend/config/arbConfig.json)
async function loadEdgeAllow(): Promise<EdgeAllow> {
  try {
    const cfg: any = await readJson('backend/config/arbConfig.json', {} as any);
    return (cfg && (cfg as any).edge_allow) ? (cfg as any).edge_allow as EdgeAllow : {} as EdgeAllow;
  } catch {
    return {} as EdgeAllow;
  }
}

export function getGraphVersion(): { version: number; timestamp: number } {
  const version = lastSnapshot?.version || 0;
  const timestamp = lastSnapshot?.timestamp || 0;
  try { logger.debug('graph.version.peek', { version, timestamp, cat: 'graph', code: LogCode.GRAPH_TVL_STATS }); } catch {}
  return { version, timestamp };
}

// ADD: Update queue for synchronization
let updateQueue: Array<() => Promise<void>> = [];
let updateInProgress = false;

// ADD: Serialize graph updates to prevent race conditions
async function applyUpdateWithLock(updateFn: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    updateQueue.push(async () => {
      try {
        await updateFn();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    
    if (!updateInProgress) {
      processUpdateQueue();
    }
  });
}

async function processUpdateQueue(): Promise<void> {
  if (updateInProgress || updateQueue.length === 0) return;
  updateInProgress = true;
  
  try {
    while (updateQueue.length > 0) {
      const updateFn = updateQueue.shift()!;
      await updateFn();
    }
  } finally {
    updateInProgress = false;
    // Process any new updates that arrived while we were processing
    if (updateQueue.length > 0) {
      setImmediate(() => processUpdateQueue());
    }
  }
}

// ADD: Internal rebuild function that doesn't use the lock (for use when already locked)
async function rebuildGraphNowInternal(io?: SocketIOServer, opts?: { pushToArb?: boolean; source?: string }): Promise<void> {
  try {
    const nowMs = Date.now();
    
    // Guard: skip if last rebuild was recent and had no changes (unless force requested)
    if (!opts?.pushToArb && lastRebuildMs > 0 && lastRebuildHadChanges === false) {
      const gap = nowMs - lastRebuildMs;
      if (gap < MIN_REBUILD_GAP_MS) {
        try { logger.debug('graph.rebuild.skip_recent_no_change', { gap_ms: gap, min_gap_ms: MIN_REBUILD_GAP_MS, cat: 'graph' }); } catch {}
        return;
      }
    }

    const prev = lastSnapshot;
    const next = await getGraphSnapshot(true);
    // Skip emitting/pushing when we have no retained pools yet
    if (!prev && (!next || !Array.isArray((next as any).edges) || (next as any).edges.length === 0)) {
      try { logger.info('graph.rebuild.skip_empty', { reason: 'no_retained_pools' }); } catch {}
      lastRebuildMs = nowMs;
      lastRebuildHadChanges = false;
      return;
    }
    const diff = diffSnapshots(prev, next);
    const changed = !!(diff.addedNodes.length || diff.updatedNodes.length || diff.removedNodeIds.length || diff.addedEdges.length || diff.updatedEdges.length || diff.removedEdgeIds.length);
    
    lastRebuildMs = nowMs;
    lastRebuildHadChanges = changed;
    
    // Update lastSnapshot atomically (already within lock context)
    lastSnapshot = next;
    
    if (io) {
      if (!prev) io.emit('graph-rebase', { version: next.version, timestamp: next.timestamp }); else if (changed) io.emit('graph-update', toLiteDiff(diff));
    } else {
      try { if (!prev) emit('graph-rebase', { version: next.version, timestamp: next.timestamp }); else if (changed) emit('graph-update', toLiteDiff(diff)); } catch {}
    }
    
    // Use unified coordinator for push decision
    const decision = shouldPushGraphUpdate({ 
      force: opts?.pushToArb === true,
      source: 'rebuild_graph_now'
    });
    logPushDecision(decision, { 
      version: next.version, 
      kind: !prev ? 'snapshot' : 'diff',
      source: 'rebuild_graph_now'
    });
    
    if (!prev) {
      if (decision.shouldPush) {
        try { void pushArbGraphSnapshot(next); } catch {}
      }
      diffSinceRebase = 0; 
      lastRebaseMs = Date.now();
    } else if (changed) {
      if (decision.shouldPush) {
        const nowMs = Date.now();
        const shouldRebase = (diffSinceRebase >= REBASE_DIFF_THRESHOLD) || (nowMs - lastRebaseMs > REBASE_TIME_MS);
        if (shouldRebase) {
          try { void pushArbGraphSnapshot(next); } catch {}
          diffSinceRebase = 0; 
          lastRebaseMs = nowMs;
          try { emit('log', { level: 'info', message: `graph:push rebase v=${next.version} nodes=${next.nodes.length} edges=${next.edges.length}`, timestamp: new Date().toISOString(), context: { cat: 'graph', code: LogCode.GRAPH_PUSH_SNAPSHOT } }); } catch {}
          try { if (io) io.emit('graph-rebase', { version: next.version, timestamp: next.timestamp }); else emit('graph-rebase', { version: next.version, timestamp: next.timestamp }); } catch {}
          try { logger.info('graph.rebase', { at_ms: lastRebaseMs, version: next.version, nodes: next.nodes.length, edges: next.edges.length }); } catch {}
        } else {
          try { void pushArbGraphDiff(diff); } catch {}
          diffSinceRebase += (diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length);
          try { emit('log', { level: 'info', message: `graph:push diff v=${diff.version} changes=${(diff.addedEdges.length + diff.updatedEdges.length + diff.removedEdgeIds.length)}`, timestamp: new Date().toISOString(), context: { cat: 'graph', code: LogCode.GRAPH_PUSH_DIFF } }); } catch {}
        }
      }
    }
    try { logger.info('graph.rebuild.now', { nodes: next.nodes.length, edges: next.edges.length, changed }); } catch {}
    // Note: Graph-triggered auto-retargeting removed - WS retargets now only happen via health monitoring
  } catch (e: any) {
    logger.debug('graph.rebuild.now failed', { error: String(e?.message || e) });
  }
}

export async function rebuildGraphNow(io?: SocketIOServer, opts?: { pushToArb?: boolean }): Promise<void> {
  return applyUpdateWithLock(async () => {
    await rebuildGraphNowInternal(io, opts);
  });
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

// Incremental graph apply from pool deltas (diff-first, occasional rebase)
const priceClampMinInc = Number(((CONFIG as any)?.sanity as any)?.priceClampMin ?? 1e-12);
const priceClampMaxInc = Number(((CONFIG as any)?.sanity as any)?.priceClampMax ?? 1e12);
const clampPriceInc = (px?: number): number | undefined => {
  const v = Number(px);
  if (!Number.isFinite(v) || !(v > 0)) return undefined;
  return Math.min(priceClampMaxInc, Math.max(priceClampMinInc, v));
};
export async function applyPoolUpdates(prev: PoolsPayload, next: PoolsPayload, opts?: { pushToArb?: boolean }): Promise<void> {
  return applyUpdateWithLock(async () => {
    try {
      if (!lastSnapshot) { 
        // Use internal rebuild when already in lock context
        await rebuildGraphNowInternal(undefined); 
        return; 
      }

      const priceStore = await import('./priceStore.js');
      const edgeAllow = await loadEdgeAllow();
      const priceMap = buildPriceMap(priceStore, lastSnapshot, prev, next);
      const timestampMs = Date.now();

      const payload: GraphIncrementalRequest = {
        previousSnapshot: lastSnapshot,
        previousPools: prev,
        nextPools: next,
        droppedPoolIds: Array.from(droppedPoolIds),
        edgeAllow,
        priceMap,
        priceClampMin: priceClampMinInc,
        priceClampMax: priceClampMaxInc,
        timestampMs,
      };

      const workerRequest: GraphWorkerRequest = { kind: 'incremental', payload };

      const worker = getGraphWorkerClient();
      const queueDepth = worker ? worker.getQueueSize() : 0;
      const active = worker ? worker.getActiveCount() : 0;
      const totalPending = queueDepth + active;
      let usedWorker = false;
      let result: GraphWorkerResponse;

      const start = Date.now();
      if (worker && totalPending < GRAPH_WORKER_MAX_QUEUE) {
        try {
          usedWorker = true;
          result = await worker.run(workerRequest, { timeoutMs: GRAPH_WORKER_TIMEOUT_MS });
        } catch (err: any) {
          usedWorker = false;
          markGraphWorkerFailed(err);
          try { logger.warn('graph.worker.incremental_failed', { error: String(err?.message || err), queue: queueDepth, active, cat: 'graph' }); } catch {}
          result = computeIncrementalGraphUpdate(payload);
        }
      } else {
        if (worker && totalPending >= GRAPH_WORKER_MAX_QUEUE) {
          try { logger.warn('graph.worker.queue_saturated', { queue: queueDepth, active, limit: GRAPH_WORKER_MAX_QUEUE, cat: 'graph' }); } catch {}
        }
        result = computeIncrementalGraphUpdate(payload);
      }
      const duration = Date.now() - start;
      try { logger.debug('graph.incremental.compute', { worker: usedWorker, duration_ms: duration, stats: result?.stats, cat: 'graph' }); } catch {}

      if (!result?.changed || !result.snapshot || !result.diff) {
        return;
      }

      // CHANGED: Update lastSnapshot atomically within lock
      lastSnapshot = result.snapshot;
      const diff = result.diff;
      const ch = (result.stats?.addedEdges || 0) + (result.stats?.updatedEdges || 0) + (result.stats?.removedEdges || 0);
      const nowMs = Date.now();
      const shouldRebase = (diffSinceRebase >= REBASE_DIFF_THRESHOLD) || (nowMs - lastRebaseMs > REBASE_TIME_MS);
      
      // Use unified coordinator for push decision - incremental mode should always be allowed here
      const decision = shouldPushGraphUpdate({ 
        force: opts?.pushToArb === true,
        source: 'incremental'
      });
      logPushDecision(decision, { 
        version: diff.version, 
        kind: shouldRebase ? 'snapshot' : 'diff',
        source: 'incremental'
      });

      if (shouldRebase) {
        diffSinceRebase = 0;
        lastRebaseMs = nowMs;
        try {
          logger.info('graph.incremental.apply', {
            added: result.stats?.addedEdges,
            updated: result.stats?.updatedEdges,
            removed: result.stats?.removedEdges,
            nodes_add: result.stats?.addedNodes,
            nodes_rem: result.stats?.removedNodes,
            mode: 'rebase',
            worker: usedWorker,
            cat: 'graph',
          });
        } catch {}
        try { emit('graph-rebase', { version: diff.version, timestamp: diff.timestamp }); } catch {}
        if (decision.shouldPush) {
          try { await pushArbGraphSnapshot(result.snapshot); } catch {}
        }
      } else {
        diffSinceRebase += ch;
        try {
          logger.info('graph.incremental.apply', {
            added: result.stats?.addedEdges,
            updated: result.stats?.updatedEdges,
            removed: result.stats?.removedEdges,
            nodes_add: result.stats?.addedNodes,
            nodes_rem: result.stats?.removedNodes,
            mode: 'diff',
            worker: usedWorker,
            cat: 'graph',
          });
        } catch {}
        try { emit('graph-update', toLiteDiff(diff)); } catch {}
        if (decision.shouldPush) {
          try { await pushArbGraphDiff(diff); } catch {}
        }
      }
    } catch (e: any) {
      try { logger.warn('graph.incremental.apply failed', { error: String(e?.message || e), stack: e?.stack, cat: 'graph' }); } catch {}
      // FIX: Don't rebuild on every error - avoid deadlocks and excessive rebuilds
      // Log the error but don't cascade rebuilds which can cause deadlocks
      try { 
        logger.warn('graph.incremental.error_recovery', { 
          error: String(e?.message || e),
          will_rebuild: false, // Changed: don't auto-rebuild on errors to prevent cascading rebuilds
          cat: 'graph' 
        }); 
      } catch {}
      // REMOVED: await rebuildGraphNow(undefined); - this was causing deadlocks and excessive rebuilds
    }
  });
}

function getGraphWorkerClient(): WorkerClient<GraphWorkerRequest, GraphWorkerResponse> | null {
  if (graphWorkerUnavailable) return null;
  if (graphWorkerClient) return graphWorkerClient;
  try {
    const url = new URL('../workers/graphDiff.worker.js', import.meta.url);
    graphWorkerClient = createWorkerClient<GraphWorkerRequest, GraphWorkerResponse>({
      url,
      name: 'graph-diff',
      maxConcurrency: GRAPH_WORKER_CONCURRENCY,
      idleTimeoutMs: GRAPH_WORKER_IDLE_MS,
    });
    graphWorkerFailureCount = 0;
    return graphWorkerClient;
  } catch (err: any) {
    graphWorkerUnavailable = true;
    try { logger.warn('graph.worker.init_failed', { error: String(err?.message || err), cat: 'graph' }); } catch {}
    return null;
  }
}

function markGraphWorkerFailed(err: unknown): void {
  if (graphWorkerClient) {
    try { graphWorkerClient.dispose(); } catch {}
    graphWorkerClient = null;
  }
  graphWorkerFailureCount += 1;
  if (graphWorkerFailureCount >= 3) {
    graphWorkerUnavailable = true;
  }
  try { logger.debug('graph.worker.disabled_temp', { error: String((err as any)?.message || err), failures: graphWorkerFailureCount, cat: 'graph' }); } catch {}
}

export function isGraphWorkerBusy(): boolean {
  const worker = getGraphWorkerClient();
  if (!worker) return false;
  const queue = worker.getQueueSize();
  const active = worker.getActiveCount();
  return queue > 0 || active > 0;
}

function buildPriceMap(priceStore: any, snapshot: GraphSnapshot, prev: PoolsPayload, next: PoolsPayload): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  const getter = typeof priceStore?.getPriceByMint === 'function' ? priceStore.getPriceByMint.bind(priceStore) : undefined;

  const addMint = (mint: unknown) => {
    const key = String(mint || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!getter) return;
    try {
      const info = getter(key);
      const val = Number((info as any)?.usdc ?? (info as any)?.usd ?? (info as any)?.price);
      if (Number.isFinite(val) && val > 0) {
        out[key] = val;
      }
    } catch {}
  };

  for (const node of snapshot?.nodes || []) {
    addMint((node as any)?.id);
  }

  const collect = (pools?: PoolsPayload) => {
    if (!pools) return;
    for (const pool of pools.amm || []) {
      addMint((pool as any)?.mint_a);
      addMint((pool as any)?.mint_b);
    }
    for (const pool of pools.clmm || []) {
      addMint((pool as any)?.mint_a);
      addMint((pool as any)?.mint_b);
    }
  };

  collect(prev);
  collect(next);

  return out;
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
      const poolsMod: any = await import('./pools.js');
      const overrides: any = (globalThis as any).__graphTestPools;
      const rayRaw = overrides?.raydium ?? (typeof poolsMod.peekRaydiumPools === 'function' ? poolsMod.peekRaydiumPools() : { amm: [], clmm: [] });
      const orcRaw = overrides?.orca ?? (typeof poolsMod.peekOrcaPools === 'function' ? poolsMod.peekOrcaPools() : { amm: [], clmm: [] });
      const metRaw = overrides?.meteora ?? (typeof poolsMod.peekMeteoraPools === 'function' ? poolsMod.peekMeteoraPools() : { amm: [], clmm: [] });
      const mblRaw = overrides?.meteora_balanced ?? (typeof poolsMod.peekMeteoraBalancedPools === 'function' ? poolsMod.peekMeteoraBalancedPools() : { amm: [], clmm: [] });
      const pumpRaw = overrides?.pumpswap ?? (typeof poolsMod.peekPumpswapPools === 'function' ? poolsMod.peekPumpswapPools() : { amm: [], clmm: [] });
      
      // Pools are already filtered by universe, minPools, and TVL in refreshAllSources
      // Use the cached results directly without re-filtering
      let ray = rayRaw; let orc = orcRaw; let met = metRaw; let mbl = mblRaw; let pump = pumpRaw;
      // Before building, ensure we actually retained pools after scoping/filters
      try {
        const count =
          (ray?.amm?.length || 0) + (ray?.clmm?.length || 0) +
          (orc?.amm?.length || 0) + (orc?.clmm?.length || 0) +
          (met?.amm?.length || 0) + (met?.clmm?.length || 0) +
          (mbl?.amm?.length || 0) + (mbl?.clmm?.length || 0) +
          (pump?.amm?.length || 0) + (pump?.clmm?.length || 0);
        if (count <= 0) {
          try { logger.debug('graph.snapshot.skip', { reason: 'no_retained_pools' }); } catch {}
          if (lastSnapshot) return lastSnapshot;
          // Return an empty snapshot without updating lastSnapshot to avoid starting empty loop
          return { version: (lastSnapshot?.version || 0), timestamp: Date.now(), nodes: [], edges: [] } as GraphSnapshot;
        }
      } catch {}
      // Pools are already filtered by TVL in refreshAllSources - skip duplicate filtering
      // Pools are already filtered by minPoolsPerPair in refreshAllSources - skip duplicate filtering
      const tokenMap = await loadTokenMap().catch(() => ({} as Record<string, { mint: string; decimals: number }>));
      const labelByMint: Record<string, string> = {};
      const decimalsByMint: Record<string, number> = {};
      for (const [sym, info] of Object.entries(tokenMap || {})) {
        if (info?.mint) labelByMint[info.mint] = sym;
        if (info?.mint && Number.isFinite((info as any)?.decimals)) decimalsByMint[info.mint] = Number((info as any).decimals);
      }
      let jupiterMap: Record<string, { symbol: string; decimals: number }> = {};
      try {
        const { loadJupiterTokenMap } = await import('../utils/tokens.js');
        jupiterMap = await loadJupiterTokenMap();
        for (const [mint, meta] of Object.entries(jupiterMap)) {
          if (!labelByMint[mint] && meta?.symbol) labelByMint[mint] = meta.symbol;
          if (Number.isFinite((meta as any)?.decimals) && decimalsByMint[mint] == null) decimalsByMint[mint] = Number((meta as any).decimals);
        }
      } catch {}
      // Note: Token decimals enrichment now happens during refreshAllSources (Phase 0)
      // before normalizers run, ensuring accurate price calculations
      // Diagnostics: verify pool-reported decimals match authoritative decimals
      const diagDecimals = (
        mintA: string,
        mintB: string,
        poolDecA?: number,
        poolDecB?: number,
      ) => {
        try {
          const ga = Number(decimalsByMint[mintA]);
          const gb = Number(decimalsByMint[mintB]);
          const da = Number(poolDecA);
          const db = Number(poolDecB);
          if ([ga, gb, da, db].every((x) => Number.isFinite(x))) {
            const swapped = (da === gb && db === ga);
            const mismatch = (da !== ga || db !== gb);
            if (mismatch) {
              try { logger.info('graph.decimals.mismatch', { mintA, mintB, poolDecA: da, poolDecB: db, expectedA: ga, expectedB: gb, swapped }); } catch {}
            }
          }
        } catch {}
      };
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

      // impliedUsdViaEdges helper is defined later; reuse that one to avoid duplication

      // Load edge allowlist once per snapshot build
      const edgeAllow = await loadEdgeAllow();

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
        pool_liquidity_raw?: number,
      ) => {
        // Honor DEX/pool-kind allowlist
        try { if (!isDexKindAllowed(dex, (poolKind as any) || 'amm', edgeAllow)) return; } catch {}
        // Honor runtime pool drops: skip any edges belonging to dropped pool ids (forward or reverse)
        try {
          const pid = String(poolId || '');
          if (pid) {
            const base = pid.endsWith('-rev') ? pid.slice(0, -4) : pid;
            if (droppedPoolIds.has(base)) return;
          }
        } catch {}
        if (!mintA || !mintB || mintA === mintB) return;
        // Require a valid positive price; skip edge entirely if not present
        const priceNum = Number(price_a_per_b);
			if (!Number.isFinite(priceNum) || priceNum <= 0) return;
        // Optional pruning: drop stable<->stable edges entirely
        try {
          const dropSS = (CONFIG.system as any)?.dropStableStableEdges;
          if (dropSS) {
            const stables = new Set<string>(((CONFIG.system as any)?.stableMints || []) as string[]);
            const aStable = stables.has(mintA);
            const bStable = stables.has(mintB);
            if (aStable && bStable) return;
          }
        } catch {}
        // Sanity: for non-anchor pairs, require both sides to have USD reference; otherwise drop
        try {
          const dropNoUsdBoth = ((CONFIG as any)?.sanity as any)?.dropEdgesNoUsdBoth;
          // Default to true unless explicitly disabled
          const shouldDrop = (dropNoUsdBoth !== false);
          if (shouldDrop) {
            // Only enforce when any USD prices are available at all
            let hasAnyUsd = false;
            try {
              const all = (priceStore as any)?.getAllPrices?.();
              hasAnyUsd = !!all && Object.keys(all || {}).length > 0;
            } catch { hasAnyUsd = false; }
            if (!hasAnyUsd) {
              // Skip dropping edges; without USD refs, calibration and sanity checks will be bypassed elsewhere
            } else {
            const pa = getPriceByMintVar(mintA)?.usdc ?? null;
            const pb = getPriceByMintVar(mintB)?.usdc ?? null;
          const ANCHORS = new Set<string>([...(((CONFIG as any)?.system as any)?.anchorMints || [])]);
            const aIsAnchor = ANCHORS.has(mintA);
            const bIsAnchor = ANCHORS.has(mintB);
            const anchored = aIsAnchor || bIsAnchor;
            if (!anchored) {
              // Neither side anchored: require both USD quotes
              if (!(pa && pb)) return;
            } else {
              // Anchored pair: require the non-anchor side to have USD quote
              if (aIsAnchor && !pb) return;
              if (bIsAnchor && !pa) return;
            }
            }
          }
        } catch {}
        // Preserve pool-provided orientation for coherency
        const a = String(mintA);
        const b = String(mintB);
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
        
        // Determine pool_liquidity_raw value
        const poolLiqRaw = (() => {
          // Priority 1: Use explicitly provided pool_liquidity_raw
          if (pool_liquidity_raw != null && Number.isFinite(pool_liquidity_raw) && pool_liquidity_raw > 0) {
            return pool_liquidity_raw;
          }
          // Priority 2: Use TVL USD if available
          if (useUsd != null) {
            return useUsd;
          }
          // Priority 3: Use raw liquidity if available
          if (liqRaw > 0) {
            return liqRaw;
          }
          return undefined;
        })();
        
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
          price_a_per_b: priceNum,
          tvl_usd,
          pool_kind: poolKind,
          direction,
          pool_liquidity_raw: poolLiqRaw,
        };
        if (!nodesMap[a]) nodesMap[a] = { id: a, label: labelByMint[a] };
        if (!nodesMap[b]) nodesMap[b] = { id: b, label: labelByMint[b] };
      };
      // Backwards-compatible alias per plan
      const orientWithUsdFallbacks = (mintA: string, mintB: string, px: number | undefined): number | undefined => orientAPerB(mintA, mintB, px);

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
          const kind = String((p as any)?.pool_kind || '');
          const s64  = Number((p as any)?.sqrt_price_x64 || 0);
          const price = Number((p as any)?.price_a_per_b);
          // Allow CLMM pools that can derive price from sqrt even if price_a_per_b is missing
          if (!Number.isFinite(price) || price <= 0) {
            if (!(kind === 'clmm' && s64 > 0)) return 'nonFinitePrice';
          }
          const aUsd = getUsd(p.mint_a);
          const bUsd = getUsd(p.mint_b);
          // Avoid double-applying price deviation sanity if source already sanitized
          const avoidDouble = (sanityCfg as any).avoidDoubleApply !== false; // default on
          const dex = String((p as any)?.dex || '');
          const sourceSanitized = (
            // All CLMMs receive orientation/clamp handling in their dedicated blocks; avoid double-dropping here
            (kind === 'clmm') ||
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
        try { logger.debug('graph.sanity.filter', { feeMin, feeMax, maxDeviation, dropped: drop }); } catch {}
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
      // Dynamic stable set from config + common majors
      const STABLES = new Set<string>([
        ...(((CONFIG.system as any)?.stableMints || []) as string[]),
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
      ]);
      const priceFromUsd = (mintA: string, mintB: string): number | undefined => {
        try {
          let pa = getPriceByMintVar(mintA)?.usdc ?? null;
          let pb = getPriceByMintVar(mintB)?.usdc ?? null;
          // If missing and token is configured stable, assume 1.0
          if (!(typeof pa === 'number' && pa > 0) && STABLES.has(mintA)) pa = 1;
          if (!(typeof pb === 'number' && pb > 0) && STABLES.has(mintB)) pb = 1;
          if (pa && pb && (pa as number) > 0) return (pb as number) / (pa as number);
        } catch {}
        return undefined;
      };
      const clampPrice = (px: number | undefined): number | undefined => {
        const min = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMin)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMin) : 1e-12;
        const max = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMax)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMax) : 1e12;
        const v = Number(px);
        if (!Number.isFinite(v) || !(v > 0)) return undefined;
        if (v < min || v > max) return undefined;
        return v;
      };
      // Rescale a price from pool-reported decimals to global decimals per mint
      const rescalePriceByDecimals = (
        priceAPerB: number | undefined,
        poolDecA?: number,
        poolDecB?: number,
        globalDecA?: number,
        globalDecB?: number,
      ): number | undefined => {
        const p = Number(priceAPerB);
        if (!Number.isFinite(p) || !(p > 0)) return priceAPerB;
        const da = Number(poolDecA); const db = Number(poolDecB);
        const ga = Number(globalDecA); const gb = Number(globalDecB);
        if (![da, db, ga, gb].every((x) => Number.isFinite(x))) return priceAPerB;
        const scalePow = (ga - da) - (gb - db);
        const scaled = p * Math.pow(10, scalePow);
        return (Number.isFinite(scaled) && scaled > 0) ? scaled : priceAPerB;
      };
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
      // Simple counters for runtime monitoring of price consistency
      let consistency: any = { ray: { amm: 0, clmm: 0 }, orc: { amm: 0, clmm: 0 }, met: { clmm: 0 } };
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
        // Do not substitute USD reference; if no pool-derived price, try normalized price
        if ((!price || price <= 0) && Number.isFinite((p as any)?.price_a_per_b as any) && (p as any).price_a_per_b > 0) {
          price = Number((p as any).price_a_per_b);
        }
        // If still no price, skip this edge and log for debugging
        if (!price || price <= 0) {
          try { logger.debug('graph.skip.edge.no_price', { dex: 'Raydium', kind: 'amm', pool_id: safePoolId(p), mint_a: p.mint_a, mint_b: p.mint_b, reason: 'no_pool_price' }); } catch {}
          continue;
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
        // Incoming price is A per 1 B. Prefer a sane candidate:
        // - If USD refs exist, pick the candidate (incoming vs reserves) closer to ref
        // - If USD refs missing, prefer reserves-derived price when available
        const preferNormalized = (((CONFIG as any)?.system as any)?.preferNormalizedPriceForAmm !== false);
        const incomingRaw = Number((p as any)?.price_a_per_b || 0);
        const incomingFwd = calibratePrice(p.mint_a, p.mint_b, incomingRaw);
        let chosen: number | undefined = undefined;
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          const hasUsd = !!(pa && pb && (pa as number) > 0 && (pb as number) > 0);
          const cIn = (incomingFwd && incomingFwd > 0) ? incomingFwd : undefined;
          const cRes = (price && price > 0) ? price : undefined;
          if (preferNormalized && hasUsd && (cIn || cRes)) {
            const ref = (pb as number) / (pa as number);
            const devIn  = cIn  ? Math.max((cIn as number) / ref,  ref / (cIn as number)) : Number.POSITIVE_INFINITY;
            const devRes = cRes ? Math.max((cRes as number) / ref, ref / (cRes as number)) : Number.POSITIVE_INFINITY;
            chosen = (devIn <= devRes) ? cIn : cRes;
          } else {
            // Without USD refs, prefer reserves when available to avoid upstream drift
            chosen = cRes || cIn;
          }
        } catch {
          // Fallback: prefer reserves then incoming
          chosen = (price && price > 0) ? price : ((incomingFwd && incomingFwd > 0) ? incomingFwd : undefined);
        }
        // Ensure oriented as A per 1 B. Prefer USD-based orientation when available; otherwise triangulate.
        let oriented = chosen;
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          if (pa && pb && oriented && (oriented as number) > 0) {
            const ref = (pb as number) / (pa as number);
            const inv = 1 / (oriented as number);
            const dev  = Math.max((oriented as number) / ref,  ref / (oriented as number));
            const devI = Math.max(inv / ref, ref / inv);
            oriented = (devI + 1e-12 < dev) ? inv : (oriented as number);
          } else {
            // No USD reference: keep chosen price as-is; reciprocity tests will guard egregious cases
          }
        } catch {}
        // Unified orientation+rescale+clamp
        const ga = Number(decimalsByMint[p.mint_a] ?? decA);
        const gb = Number(decimalsByMint[p.mint_b] ?? decB);
        const poolDecA = Number((p as any)?.decimals_a ?? decA);
        const poolDecB = Number((p as any)?.decimals_b ?? decB);
        const fwdAmmRay = computePriceForward(
          p.mint_a,
          p.mint_b,
          (chosen && chosen > 0) ? (chosen as number) : undefined,
          poolDecA,
          poolDecB,
          ga,
          gb,
          (m) => { try { return getPriceByMintVar(m)?.usdc ?? undefined; } catch { return undefined; } },
          (A, B) => {
            const e = edgesMap[`${A}->${B}-Raydium`];
            const v = Number(e?.price_a_per_b);
            return Number.isFinite(v) && v > 0 ? v : undefined;
          }
        );
        const revAmmRay = (fwdAmmRay && fwdAmmRay > 0) ? (1 / fwdAmmRay) : undefined;
        const rawLiqAmm = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqParamAmm, fwdAmmRay, usd, pidAmm, (p as any).account_a, (p as any).account_b, 'amm', 'forward', rawLiqAmm);
        // Use a distinct id for reverse edge when poolId exists to avoid overwriting forward
        const pidAmmRev = pidAmm ? `${pidAmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqParamAmm, revAmmRay, usd, pidAmmRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse', rawLiqAmm);
        try { if (fwdAmmRay && revAmmRay) { const prod = fwdAmmRay * revAmmRay; if (!(prod > 1/1.02 && prod < 1.02)) { consistency.ray.amm++; logger.debug('graph.consistency.raydium.amm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdAmmRay, rev: revAmmRay, prod }); } } } catch {}
        try {
          const eid = pidAmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidAmm ? `${pidAmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          const rawLiq = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0);
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = rawLiq > 0 ? rawLiq : undefined;
        } catch {}
      }
      // Orientation correction: robust aggregation of refs (direct, implied, triangulated)
      const orientAPerB = (mintA: string, mintB: string, px: number | undefined): number | undefined => {
        const v = Number(px);
        if (!Number.isFinite(v) || !(v > 0)) return px;
        const refs: number[] = [];
        let directRef: number | undefined;
        try {
          const pa = getPriceByMintVar(mintA)?.usdc ?? null;
          const pb = getPriceByMintVar(mintB)?.usdc ?? null;
          if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
            directRef = (pb as number) / (pa as number);
            refs.push(directRef);
          }
        } catch {}
        const getDirectUsd = (m: string): number | undefined => {
          try { const p = getPriceByMintVar(m)?.usdc ?? null; return (typeof p === 'number' && p > 0) ? p : undefined; } catch { return undefined; }
        };
        const impliedUsd = (mint: string): { usd?: number; weight?: number } => {
          let best: { usd: number; weight: number } | null = null;
          for (const e of Object.values(edgesMap)) {
            const w = Number((e as any)?.weight || 1);
            const p = Number((e as any)?.price_a_per_b || 0);
            if (!(p > 0)) continue;
            if (e.source === mint && e.target === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
              const usd = 1 / p; if (usd > 0 && (!best || w > best.weight)) best = { usd, weight: w };
            } else if (e.source === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' && e.target === mint) {
              const usd = p; if (usd > 0 && (!best || w > best.weight)) best = { usd, weight: w };
            } else if (e.source === mint && e.target === 'So11111111111111111111111111111111111111112') {
              const solUsd = getDirectUsd('So11111111111111111111111111111111111111112');
              if (solUsd) { const usd = (solUsd as number) / p; if (usd > 0 && (!best || w > best.weight)) best = { usd, weight: w }; }
            } else if (e.source === 'So11111111111111111111111111111111111111112' && e.target === mint) {
              const solUsd = getDirectUsd('So11111111111111111111111111111111111111112');
              if (solUsd) { const usd = (solUsd as number) * p; if (usd > 0 && (!best || w > best.weight)) best = { usd, weight: w }; }
            }
          }
          return best || {} as any;
        };
        try {
          const paImp = impliedUsd(mintA).usd ?? getDirectUsd(mintA);
          const pbImp = impliedUsd(mintB).usd ?? getDirectUsd(mintB);
          if (typeof paImp === 'number' && paImp > 0 && typeof pbImp === 'number' && pbImp > 0) {
            refs.push((pbImp as number) / (paImp as number));
          }
        } catch {}
        try {
          const PIVOTS: string[] = Array.from(new Set<string>([
            ...((((CONFIG as any)?.system as any)?.anchorMints || []) as string[]),
            ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
          ]));
          const getAPerBFromEdges = (A: string, B: string): number | undefined => {
            let best: { v: number; w: number } | null = null;
            for (const e of Object.values(edgesMap)) {
              const w = Number((e as any)?.weight || 1);
              const p = Number((e as any)?.price_a_per_b || 0);
              if (!(p > 0)) continue;
              let cand: number | undefined;
              if (e.source === A && e.target === B) cand = p;
              else if (e.source === B && e.target === A) cand = 1 / p;
              if (cand && cand > 0) { if (!best || w > best.w) best = { v: cand, w }; }
            }
            return best?.v;
          };
          for (const C of PIVOTS) {
            if (C === mintA || C === mintB) continue;
            const aPerC = getAPerBFromEdges(mintA, C);
            const bPerC = getAPerBFromEdges(mintB, C);
            if (aPerC && bPerC && aPerC > 0 && bPerC > 0) refs.push(aPerC / bPerC);
          }
        } catch {}
        const goodRefs = refs.filter((r) => Number.isFinite(r) && r > 0);
        if (!goodRefs.length) return v;
        try {
          if (typeof directRef === 'number' && directRef > 0 && goodRefs.length >= 2) {
            const others = goodRefs.filter((r) => r !== directRef);
            if (others.length) {
              const median = [...others].sort((a,b) => a-b)[Math.floor(others.length/2)];
              const dev = Math.max((directRef as number)/median, median/(directRef as number));
              if (dev > 2) {
                const idx = goodRefs.indexOf(directRef as number);
                if (idx >= 0) goodRefs.splice(idx, 1);
              }
            }
          }
        } catch {}
        const inv = 1 / v;
        const devs = goodRefs.map((r) => { const d = Math.max(v / r, r / v); return Number.isFinite(d) ? d : Number.POSITIVE_INFINITY; });
        const devsInv = goodRefs.map((r) => { const d = Math.max(inv / r, r / inv); return Number.isFinite(d) ? d : Number.POSITIVE_INFINITY; });
        const median = [...devs].sort((a,b) => a-b)[Math.floor(devs.length/2)];
        const medianInv = [...devsInv].sort((a,b) => a-b)[Math.floor(devsInv.length/2)];
        return (medianInv + 1e-12 < median) ? inv : v;
      };
      // Triangulation helpers are defined below after we have all valid pools

      for (const p of (rayValid.clmm || [])) {
        clmmTotal++;
        let price = (p as any)?.price_a_per_b as number | undefined;
        // No USD substitution; if missing price, skip edge later after calibration/orientation attempt
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
        // CLMM: calibrate then reciprocal-only orientation via USD refs; add USD deviation clamp for robustness
        price = calibratePrice(p.mint_a, p.mint_b, price);
        price = orientWithUsdFallbacks(p.mint_a, p.mint_b, price);
        // Rescale CLMM price from pool decimals to global decimals (align across DEXes)
        try {
          const ga = Number(isFinite(Number(decimalsByMint[p.mint_a])) ? decimalsByMint[p.mint_a] : (p as any)?.decimals_a);
          const gb = Number(isFinite(Number(decimalsByMint[p.mint_b])) ? decimalsByMint[p.mint_b] : (p as any)?.decimals_b);
          const poolDecA = Number((p as any)?.decimals_a);
          const poolDecB = Number((p as any)?.decimals_b);
          diagDecimals(p.mint_a, p.mint_b, poolDecA, poolDecB);
          price = rescalePriceByDecimals(price, poolDecA, poolDecB, ga, gb);
        } catch {}
        // Orientation guard: if USD ref exists and reciprocal is closer, invert once
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          if (pa && pb && price && (price as number) > 0) {
            const ref = (pb as number) / (pa as number);
            const inv = 1 / (price as number);
            const dev  = Math.max((price as number) / ref,  ref / (price as number));
            const devI = Math.max(inv / ref, ref / inv);
            if (devI + 1e-12 < dev) price = inv;
          }
        } catch {}
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
              logger.debug('graph.calibrate.raydium.clmm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, calibrated: price, ref, dev, fwd, rev });
            }
          }
        } catch {}
        // Forward + reverse with strict reciprocal rule and consistency guard
        // If still no price, skip and log
        if (!price || !(price > 0)) { try { logger.debug('graph.skip.edge.no_price', { dex: 'Raydium', kind: 'clmm', pool_id: safePoolId(p), mint_a: p.mint_a, mint_b: p.mint_b, reason: 'no_pool_price' }); } catch {}; continue; }
        let fwdR = clampPrice(price);
        let revR = (fwdR && fwdR > 0) ? (1 / fwdR) : undefined;
        // Final reciprocity product clamp: drop if far from 1
        try {
          if (fwdR && revR) {
            const prod = fwdR * revR;
            if (!(prod > 0.98 && prod < 1.02)) {
              try { logger.debug('graph.drop.clmm.reciprocity', { dex: 'Raydium', pool: (p as any)?.id, prod, fwd: fwdR, rev: revR }); } catch {}
              fwdR = undefined; revR = undefined;
            }
          }
        } catch {}
        const rawLiqClmm = Number((p as any).pool_liquidity_raw || (p as any).liquidity || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Raydium', p.fee_bps, liqDisplay, fwdR, usd, pidClmm, (p as any).account_a, (p as any).account_b, 'clmm', 'forward', rawLiqClmm);
        const pidClmmRev = pidClmm ? `${pidClmm}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Raydium', p.fee_bps, liqDisplay, revR, usd, pidClmmRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse', rawLiqClmm);
        try {
          if (fwdR && revR) {
            const prod = fwdR * revR;
            const ok = prod > 1/1.02 && prod < 1.02;
            if (!ok) { consistency.ray.clmm++; logger.debug('graph.consistency.raydium.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdR, rev: revR, prod }); }
          }
        } catch {}
        try {
          const eid = pidClmm || `${p.mint_a}->${p.mint_b}-Raydium`;
          const rid = pidClmm ? `${pidClmm}-rev` : `${p.mint_b}->${p.mint_a}-Raydium`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
        } catch {}
      }
      // Helper: implied USD via current edges when direct priceStore lacks USD
      const impliedUsdViaEdges = (mint: string): { usd?: number; via?: 'USDC'|'SOL'; weight?: number } => {
        try {
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const getUsdDirect = (m: string): number | undefined => {
            try { const v = getPriceByMintVar(m)?.usdc ?? null; return (typeof v === 'number' && v > 0) ? v : undefined; } catch { return undefined; }
          };
          let best: { usd: number; via: 'USDC'|'SOL'; weight: number } | null = null;
          const pick = (usd: number | undefined, via: 'USDC'|'SOL', w: number) => {
            if (typeof usd === 'number' && usd > 0) { if (!best || w > best.weight) best = { usd, via, weight: w }; }
          };
          for (const e of Object.values(edgesMap)) {
            const w = Number((e as any)?.weight || 1);
            if (e.source === mint && e.target === USDC) {
              const p = Number((e as any)?.price_a_per_b || 0); // mint per 1 USDC
              if (p > 0) pick(1 / p, 'USDC', w);
            } else if (e.source === USDC && e.target === mint) {
              const p = Number((e as any)?.price_a_per_b || 0); // USDC per 1 mint
              if (p > 0) pick(p, 'USDC', w);
            } else if (e.source === mint && e.target === SOL) {
              const p = Number((e as any)?.price_a_per_b || 0); // mint per 1 SOL
              const solUsd = getUsdDirect(SOL);
              if (p > 0 && solUsd) pick((solUsd as number) / p, 'SOL', w);
            } else if (e.source === SOL && e.target === mint) {
              const p = Number((e as any)?.price_a_per_b || 0); // SOL per 1 mint
              const solUsd = getUsdDirect(SOL);
              if (p > 0 && solUsd) pick((solUsd as number) * p, 'SOL', w);
            }
          }
          return best || {};
        } catch { return {}; }
      };
      const orcValid = validatePoolsForGraph(orc as any);
      let metValid = validatePoolsForGraph(met as any);
      // Fallback: if scoping would drop all and we had some Meteora upstream, keep original Meteora
      try {
        const upstreamCount = (met.amm?.length || 0) + (met.clmm?.length || 0);
        const afterCount = (metValid.amm?.length || 0) + (metValid.clmm?.length || 0);
        if (upstreamCount > 0 && afterCount === 0) {
          metValid = met as any;
        }
      } catch {}
      const mblValid = validatePoolsForGraph(mbl as any);
      const pumpValid = validatePoolsForGraph(pump as any);
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
        // Ensure oriented as A per 1 B using USD reference when available
        priceAmmOrca = orientAPerB(p.mint_a, p.mint_b, priceAmmOrca);
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          const ref = (pa && pb && pb > 0) ? ((pb as number) / (pa as number)) : undefined;
          if (priceAmmOrca) {
            const fwd = 1 / priceAmmOrca, rev = priceAmmOrca;
            if (ref) {
              const dev = Math.max(priceAmmOrca / ref, ref / priceAmmOrca);
              if (dev > 5 || fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.debug('graph.calibrate.orca.amm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceAmmOrca, ref, dev, fwd, rev });
              }
            } else {
              if (fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.debug('graph.calibrate.orca.amm magnitude', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceAmmOrca, fwd, rev });
              }
            }
          }
        } catch {}
        // Forward + reverse with strict reciprocal rule and consistency guard
        const fwdAmm = (priceAmmOrca && priceAmmOrca > 0) ? priceAmmOrca : undefined;
        const revAmm = (fwdAmm && fwdAmm > 0) ? (1 / fwdAmm) : undefined;
        const rawLiqOrcaAmm = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaAmm, fwdAmm, undefined, pid, (p as any).account_a, (p as any).account_b, 'amm', 'forward', rawLiqOrcaAmm);
        const pidAmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaAmm, revAmm, undefined, pidAmmOrcaRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse', rawLiqOrcaAmm);
        try { if (fwdAmm && revAmm) { const prod = fwdAmm * revAmm; if (!(prod > 1/1.02 && prod < 1.02)) { consistency.orc.amm++; logger.debug('graph.consistency.orca.amm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdAmm, rev: revAmm, prod }); } } } catch {}
      }
      // (Saber removed)
      // Meteora Balanced AMM
      for (const p of (mblValid.amm || [])) {
        ammTotal++;
        const decA = Number((p as any)?.decimals_a ?? decimalsByMint[p.mint_a] ?? NaN);
        const decB = Number((p as any)?.decimals_b ?? decimalsByMint[p.mint_b] ?? NaN);
        const amtA = Number((p as any)?.amount_a ?? (p as any)?.amount_a_whole ?? NaN);
        const amtB = Number((p as any)?.amount_b ?? (p as any)?.amount_b_whole ?? NaN);
        let usd: number | undefined = (p as any)?.tvl_usd;
        let price: number | undefined = (p as any)?.price_a_per_b as number | undefined;
        // No USD substitution; compute USD TVL and keep pool price only
        if ((!usd || !(usd > 0)) && Number.isFinite(decA) && Number.isFinite(decB)) {
          // Check if amounts are already in whole units (avoid double-division)
          const areWhole = (p as any)?.amounts_are_whole === true;
          const wholeA = Number.isFinite(amtA) ? (areWhole ? amtA : (amtA / Math.pow(10, decA))) : NaN;
          const wholeB = Number.isFinite(amtB) ? (areWhole ? amtB : (amtB / Math.pow(10, decB))) : NaN;
          if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
            usd = tvlUsd(p.mint_a, p.mint_b, wholeA, wholeB);
            if ((!price || price <= 0) && (wholeB as number) > 0) price = (wholeA as number) / (wholeB as number);
          }
        }
        const pid = safePoolId(p);
        const liqBase = Number((p as any)?.liquidity_base);
        const liqDisplay = (p as any)?.liquidity_display ?? ((usd && usd > 0) ? usd : (Number.isFinite(liqBase) && liqBase > 0 ? liqBase : undefined));
        // If no pool price, skip and log; do not use USD substitution
        const dexName = (p as any)?.dex || 'MeteoraBalanced';  // Use pool's dex field (v1 vs v2)
        if (!price || !(price > 0)) { try { logger.debug('graph.skip.edge.no_price', { dex: dexName, kind: 'amm', pool_id: pid, mint_a: p.mint_a, mint_b: p.mint_b, reason: 'no_pool_price' }); } catch {}; continue; }
        const fwd = clampPrice(price);
        const rev = fwd && fwd > 0 ? (1 / fwd) : undefined;
        const rawLiqMbal = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, dexName, p.fee_bps, liqDisplay, fwd, usd, pid, (p as any).account_a, (p as any).account_b, 'amm', 'forward', rawLiqMbal);
        const pidRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, dexName, p.fee_bps, liqDisplay, rev, usd, pidRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse', rawLiqMbal);
      }
      // Pumpswap AMM
      for (const p of (pumpValid.amm || [])) {
        ammTotal++;
        const pid = safePoolId(p);
        const liqBase = Number((p as any)?.liquidity_base);
        const liqDisplay = (p as any)?.liquidity_display ?? (Number.isFinite(liqBase) && liqBase > 0 ? liqBase : undefined);
        let price: number | undefined = (p as any)?.price_a_per_b as number | undefined;
        let usd: number | undefined = (p as any)?.tvl_usd;
        // Pumpswap pools may lack price data from Shyft (need RPC for reserves)
        // For now, if no price, we skip the edge
        if (!price || !(price > 0)) {
          try { logger.debug('graph.skip.edge.no_price', { dex: 'Pumpswap', kind: 'amm', pool_id: pid, mint_a: p.mint_a, mint_b: p.mint_b, reason: 'no_pool_price' }); } catch {};
          continue;
        }
        const fwd = clampPrice(price);
        const rev = fwd && fwd > 0 ? (1 / fwd) : undefined;
        const rawLiqPump = Number((p as any).pool_liquidity_raw || (p as any).liquidity_base || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Pumpswap', p.fee_bps, liqDisplay, fwd, usd, pid, (p as any).account_a, (p as any).account_b, 'amm', 'forward', rawLiqPump);
        const pidRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Pumpswap', p.fee_bps, liqDisplay, rev, usd, pidRev, (p as any).account_b, (p as any).account_a, 'amm', 'reverse', rawLiqPump);
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
        // Prefer normalized price from source; fallback to sqrt-derived only when missing
        let priceClmmOrca: number | undefined = calibratePrice(p.mint_a, p.mint_b, (p as any).price_a_per_b);
        if (!(priceClmmOrca && priceClmmOrca > 0)) {
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
                logger.debug('graph.calibrate.orca.clmm outlier', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceClmmOrca, ref, dev, fwd, rev, decA: (p as any)?.decimals_a, decB: (p as any)?.decimals_b, sqrt_price_x64: (p as any)?.sqrt_price_x64 });
              }
            } else {
              if (fwd > 1e4 || rev > 1e4 || fwd < 1e-6 || rev < 1e-12) {
                logger.debug('graph.calibrate.orca.clmm magnitude', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, raw: (p as any)?.price_a_per_b, calibrated: priceClmmOrca, fwd, rev, decA: (p as any)?.decimals_a, decB: (p as any)?.decimals_b, sqrt_price_x64: (p as any)?.sqrt_price_x64 });
              }
            }
          }
        } catch {}
        // Orient as A per 1 B using USD reference when available
        priceClmmOrca = orientWithUsdFallbacks(p.mint_a, p.mint_b, priceClmmOrca);
        // Forward + reverse with strict reciprocal rule and consistency guard
        const fwdClmm = clampPrice((priceClmmOrca && priceClmmOrca > 0) ? priceClmmOrca : undefined);
        const revClmm = (fwdClmm && fwdClmm > 0) ? (1 / fwdClmm) : undefined;
        const rawLiqOrcaClmm = Number((p as any).pool_liquidity_raw || (p as any).liquidity || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Orca', p.fee_bps, liqParamOrcaClmm, fwdClmm, usd, pid, (p as any).account_a, (p as any).account_b, 'clmm', 'forward', rawLiqOrcaClmm);
        const pidClmmOrcaRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Orca', p.fee_bps, liqParamOrcaClmm, revClmm, usd, pidClmmOrcaRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse', rawLiqOrcaClmm);
        try { if (fwdClmm && revClmm) { const prod = fwdClmm * revClmm; if (!(prod > 1/1.02 && prod < 1.02)) { consistency.orc.clmm++; logger.debug('graph.consistency.orca.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdClmm, rev: revClmm, prod }); } } } catch {}
        try {
          const eid = pid || `${p.mint_a}->${p.mint_b}-Orca`;
          const rid = pid ? `${pid}-rev` : `${p.mint_b}->${p.mint_a}-Orca`;
          if (edgesMap[eid]) edgesMap[eid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
          if (edgesMap[rid]) edgesMap[rid].pool_liquidity_raw = Number((p as any).liquidity || 0) || undefined;
        } catch {}
      }
      // Prepare triangulation helpers now that all valid pools are available
      const PIVOTS: string[] = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (as seen in logs)
      ];
      const allPools: any[] = [
        ...(rayValid.amm || []), ...(rayValid.clmm || []),
        ...(orcValid.amm || []), ...(orcValid.clmm || []),
        ...(mblValid.amm || []),
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
        // No CLMM rescale here; rely on normalizer decode units
        // Orient using combined USD (direct or implied via edges); allow stable=1 fallback; else triangulate
        try {
          const directA = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const directB = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          let pa = (typeof directA === 'number' && directA > 0) ? directA : undefined;
          let pb = (typeof directB === 'number' && directB > 0) ? directB : undefined;
          if (!pa) { const imp = impliedUsdViaEdges(p.mint_a); if (typeof imp.usd === 'number' && imp.usd > 0) { pa = imp.usd; try { logger.debug('graph.implied.usd', { mint: p.mint_a, implied: imp.usd, via: imp.via, weight: imp.weight }); } catch {} } }
          if (!pb) { const imp = impliedUsdViaEdges(p.mint_b); if (typeof imp.usd === 'number' && imp.usd > 0) { pb = imp.usd; try { logger.debug('graph.implied.usd', { mint: p.mint_b, implied: imp.usd, via: imp.via, weight: imp.weight }); } catch {} } }
          // Prefer a USD reference whenever we can. If missing, use stable=1 fallback via priceFromUsd.
          let ref: number | undefined = undefined;
          if (pa && pb) ref = (pb as number) / (pa as number);
          if (priceMet && ref && ref > 0) {
            const inv = 1 / (priceMet as number);
            const dev = Math.max((priceMet as number) / ref, ref / (priceMet as number));
            const devI = Math.max(inv / ref, ref / inv);
            let out = (devI + 1e-12 < dev) ? inv : (priceMet as number);
            priceMet = out;
          } else {
            // No reliable USD reference: triangulate using pivot edges (SOL/USDC/WBTC) if available
            try {
              const tri = triangulateAPerB(p.mint_a, p.mint_b);
              if (typeof tri === 'number' && tri > 0) {
                if (priceMet && priceMet > 0) {
                  const dev = Math.max(priceMet / tri, tri / priceMet);
                  const inv = 1 / priceMet;
                  const devI = Math.max(inv / tri, tri / inv);
                  if (devI + 1e-12 < dev) priceMet = inv;
                } else {
                  priceMet = tri;
                }
              }
            } catch {}
          }
        } catch {}
        // Rescale Meteora CLMM to global decimals prior to clamp/edge emission
        try {
          const ga = Number(decimalsByMint[p.mint_a] ?? (p as any)?.decimals_a);
          const gb = Number(decimalsByMint[p.mint_b] ?? (p as any)?.decimals_b);
          const poolDecA = Number((p as any)?.decimals_a);
          const poolDecB = Number((p as any)?.decimals_b);
          diagDecimals(p.mint_a, p.mint_b, poolDecA, poolDecB);
          priceMet = rescalePriceByDecimals(priceMet, poolDecA, poolDecB, ga, gb);
        } catch {}
        // Forward edge must carry A per 1 B; reverse is strict reciprocal
        const pid = String((p as any)?.id || undefined) || undefined;
        const liqParam = (p as any)?.liquidity_display ?? (usd && usd > 0 ? usd : (p as any)?.pool_liquidity_raw);
        // Do not substitute with USD fallback; require a pool-derived price
        let chosenMet: number | undefined = (priceMet && priceMet > 0) ? priceMet : undefined;
        // Orientation guard for Meteora: ensure USD-oriented before emission
        try {
          const pa = getPriceByMintVar(p.mint_a)?.usdc ?? null;
          const pb = getPriceByMintVar(p.mint_b)?.usdc ?? null;
          if (pa && pb && chosenMet && (chosenMet as number) > 0) {
            const ref = (pb as number) / (pa as number);
            const inv = 1 / (chosenMet as number);
            const dev  = Math.max((chosenMet as number) / ref,  ref / (chosenMet as number));
            const devI = Math.max(inv / ref, ref / inv);
            if (devI + 1e-12 < dev) chosenMet = inv;
          }
        } catch {}
        if (!(chosenMet && chosenMet > 0)) { try { logger.debug('graph.skip.edge.no_price', { dex: 'Meteora', kind: 'clmm', pool_id: pid, mint_a: p.mint_a, mint_b: p.mint_b, reason: 'no_pool_price' }); } catch {}; continue; }
        let fwdMet = clampPrice(chosenMet);
        let revMet = (fwdMet && fwdMet > 0) ? (1 / fwdMet) : undefined;
        try {
          if (fwdMet && revMet) {
            const prod = fwdMet * revMet;
            if (!(prod > 0.98 && prod < 1.02)) {
              try { logger.debug('graph.drop.clmm.reciprocity', { dex: 'Meteora', pool: (p as any)?.id, prod, fwd: fwdMet, rev: revMet }); } catch {}
              fwdMet = undefined; revMet = undefined;
            }
          }
        } catch {}
        const rawLiqMet = Number((p as any).pool_liquidity_raw || (p as any).liquidity || 0) || undefined;
        addEdge(p.mint_a, p.mint_b, 'Meteora', p.fee_bps, liqParam, fwdMet, usd, pid, (p as any).account_a, (p as any).account_b, 'clmm', 'forward', rawLiqMet);
        const pidRev = pid ? `${pid}-rev` : undefined;
        addEdge(p.mint_b, p.mint_a, 'Meteora', p.fee_bps, liqParam, revMet, usd, pidRev, (p as any).account_b, (p as any).account_a, 'clmm', 'reverse', rawLiqMet);
        try { if (fwdMet && revMet) { const prod = fwdMet * revMet; if (!(prod > 1/1.02 && prod < 1.02)) { consistency.met.clmm++; logger.debug('graph.consistency.meteora.clmm', { pool: (p as any)?.id, mintA: p.mint_a, mintB: p.mint_b, fwd: fwdMet, rev: revMet, prod }); } } } catch {}
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
      // Also log per-DEX edge counts to aid debugging of visibility in the viewer
      try {
        const all = Object.values(edgesMap);
        // Diagnostics: compare SOL/USDC AMM vs CLMM magnitudes
        try {
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const amm = all.find((e: any) => e.dex === 'Raydium' && e.pool_kind === 'amm' && ((e.source === USDC && e.target === SOL) || (e.source === SOL && e.target === USDC)));
          const clmm = all.find((e: any) => e.dex === 'Raydium' && e.pool_kind === 'clmm' && ((e.source === USDC && e.target === SOL) || (e.source === SOL && e.target === USDC)));
          if (amm && clmm && amm.price_a_per_b && clmm.price_a_per_b) {
            const ratio = Number(clmm.price_a_per_b) / Number(amm.price_a_per_b);
            if (!(ratio > 0.5 && ratio < 2.0)) {
              logger.debug('graph.diagnostic.amm_vs_clmm', {
                ratio,
                amm: { id: amm.id, price: amm.price_a_per_b },
                clmm: { id: clmm.id, price: clmm.price_a_per_b },
              });
            }
          }
        } catch {}
        // Triangle diagnostics: for any token X, compare (USDC->X)*(X->SOL) to (USDC->SOL)
        try {
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const getEdge = (a: string, b: string) => all.find((e: any) => e.source === a && e.target === b && e.price_a_per_b && e.price_a_per_b > 0);
          const usdcSol = getEdge(USDC, SOL);
          if (usdcSol) {
            const nodes = new Set<string>(all.flatMap((e: any) => [e.source, e.target]));
            for (const X of nodes) {
              if (X === USDC || X === SOL) continue;
              const usdcX = getEdge(USDC, X);
              const xSol = getEdge(X, SOL);
              if (usdcX && xSol) {
                const product = (usdcX.price_a_per_b as number) * (xSol.price_a_per_b as number);
                const ref = usdcSol.price_a_per_b as number;
                const dev = Math.max(product / ref, ref / product);
                if (!(dev < 2.0)) {
                  logger.debug('graph.diagnostic.triangle', { X, usdcX: usdcX.id, xSol: xSol.id, usdcSol: usdcSol.id, product, ref, dev });
                }
              }
            }
          }
        } catch {}
        const countDex = (dex: string) => all.filter((e: any) => e.dex === dex).length;
        const sample = (dex: string) => all
          .filter((e: any) => e.dex === dex)
          .slice(0, 5)
          .map((e: any) => ({ id: e.id, source: e.source, target: e.target, pool_id: (e as any)?.pool_id, kind: (e as any)?.pool_kind, direction: (e as any)?.direction }));
        logger.debug('graph.edges.count', {
          raydium: { count: countDex('Raydium'), sample: sample('Raydium') },
          orca: { count: countDex('Orca'), sample: sample('Orca') },
          meteora: { count: countDex('Meteora'), sample: sample('Meteora') },
        });
      } catch {}
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
        logger.debug('graph.edges sample', { amm: sampleAmm, clmm: sampleClmm, cat: 'graph' });
      } catch {}

      // CRITICAL: Clean up nodes that have no incident edges (respecting token universe)
      // This prevents orphan tokens from Jupiter token lists or previous pool fetches
      // from lingering in the graph when they no longer have any pools
      const incident = new Map<string, number>();
      for (const edge of Object.values(edgesMap)) {
        incident.set(edge.source, (incident.get(edge.source) || 0) + 1);
        incident.set(edge.target, (incident.get(edge.target) || 0) + 1);
      }
      let removedOrphanNodes = 0;
      for (const nodeId of Object.keys(nodesMap)) {
        if (!incident.has(nodeId)) {
          delete nodesMap[nodeId];
          removedOrphanNodes++;
        }
      }
      if (removedOrphanNodes > 0) {
        try { 
          logger.info('graph.cleanup.orphan_nodes', { 
            removed: removedOrphanNodes, 
            reason: 'no_incident_edges', 
            cat: 'graph' 
          }); 
        } catch {}
      }

      const snapshot: GraphSnapshot = {
        version: (lastSnapshot?.version || 0) + 1,
        timestamp: Date.now(),
        nodes: Object.values(nodesMap),
        edges: Object.values(edgesMap),
      };
      try { logger.debug('graph.consistency.summary', { ray: consistency.ray, orc: consistency.orc, met: consistency.met, cat: 'graph' }); } catch {}
      lastSnapshot = snapshot;
      lastAt = now;
      try { logger.debug('graph.tvl.stats', { amm: { total: ammTotal, usd: ammUsd }, clmm: { total: clmmTotal, usd: clmmUsd, missingAmounts: clmmMissingAmounts, missingDecimals: clmmMissingDecimals } }); } catch {}
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
  // Periodic graph stream removed - using event-driven updates only
  // This function kept for backward compatibility but does nothing
  try { logger.debug('graph.stream.disabled', { reason: 'event_driven_only', cat: 'graph' }); } catch {}
}

export async function findPath(fromMint: string, toMint: string): Promise<{ path: string[] }> {
  const snap = await getGraphSnapshot(false);
  return findPathInSnapshot(snap, fromMint, toMint);
}


