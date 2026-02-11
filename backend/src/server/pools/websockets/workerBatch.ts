/**
 * Worker Batch Queue for Pool Decode Pipeline
 *
 * Batches incoming WSS pool account events and sends them to a worker thread
 * for decode. Results are applied back to caches on the main thread.
 *
 * Flow:
 *   WSS event → classifyDex → enqueueForWorkerDecode → batch timer fires
 *   → worker decodes batch → applyDecodedBatch → cache mutations + graph schedule
 *
 * Fallback: On worker failure, events are replayed through the existing
 * main-thread decoders (handleXxxUpdate).
 */

import { createWorkerClient } from "../../../workers/client.js";
import { PROGRAM_IDS } from "./filters.js";
import { logger } from "../../../utils/logger.js";
import { logCatchError } from "../../../utils/errorHandler.js";
import { CONFIG } from "../../../utils/config.js";

import type { WorkerClient } from "../../../workers/client.js";
import type {
  PoolDecodeWorkerRequest,
  PoolDecodeWorkerResponse,
  DecodeJobEvent,
  DecodeJobRequest,
  DecodedPoolResult,
  DexHint,
  PoolLookupData,
} from "../../../workers/poolDecode.types.js";

// ── State ──────────────────────────────────────────────────────────────────

let workerClient: WorkerClient<
  PoolDecodeWorkerRequest,
  PoolDecodeWorkerResponse
> | null = null;
let batchQueue: DecodeJobEvent[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchIdCounter = 0;
let initialized = false;

// ── Config helpers ─────────────────────────────────────────────────────────

function getConfig() {
  const sys = (CONFIG as any)?.system ?? {};
  return {
    enabled: sys.enableWorkerDecode === true,
    batchWindowMs: Number(sys.wsWorkerBatchWindowMs ?? 10),
    maxBatchSize: Number(sys.wsWorkerMaxBatchSize ?? 200),
    concurrency: Number(sys.wsWorkerConcurrency ?? 2),
    timeoutMs: Number(sys.wsWorkerTimeoutMs ?? 5000),
  };
}

// ── Metrics (imported lazily to avoid circular deps) ───────────────────────

let _metricsModule: any = null;
async function getMetrics() {
  if (!_metricsModule) {
    _metricsModule = await import("../../pools.metrics.js");
  }
  return _metricsModule;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the worker decode pipeline.
 * Called once during WSS setup. No-ops if disabled.
 */
export function initWorkerDecode(): void {
  if (initialized) return;
  initialized = true;

  const cfg = getConfig();
  if (!cfg.enabled) {
    logger.info("worker.decode.disabled", {
      reason: "enableWorkerDecode is false",
      cat: "pools",
    });
    return;
  }

  const workerUrl = new URL(
    "../../../workers/poolDecode.worker.js",
    import.meta.url
  );
  workerClient = createWorkerClient<
    PoolDecodeWorkerRequest,
    PoolDecodeWorkerResponse
  >({
    url: workerUrl,
    name: "pool-decode",
    maxConcurrency: cfg.concurrency,
    idleTimeoutMs: 60_000, // Keep worker alive for 60s idle
  });

  logger.info("worker.decode.initialized", {
    concurrency: cfg.concurrency,
    batchWindowMs: cfg.batchWindowMs,
    maxBatchSize: cfg.maxBatchSize,
    timeoutMs: cfg.timeoutMs,
    cat: "pools",
  });
}

/**
 * Check if worker decode is currently enabled and initialized.
 */
export function isWorkerDecodeEnabled(): boolean {
  return initialized && workerClient != null && getConfig().enabled;
}

/**
 * Classify an account owner into a DexHint for worker routing.
 * Returns null if owner is not recognized (vault updates, derived accounts).
 */
export function classifyDex(
  owner: string,
  ownerRayAmm: string,
  ownerRayClmm: string,
  ownerRayCpmm: string,
  ownerOrca: string,
  ownerMeteora: string | null
): DexHint | null {
  if (owner === ownerRayAmm || owner === ownerRayClmm) return "raydium";
  if (owner === ownerRayCpmm) return "raydium-cpmm";
  if (owner === ownerOrca) return "orca";
  if (ownerMeteora && owner === ownerMeteora) return "meteora";
  if (owner === PROGRAM_IDS.METEORA_DLMM) return "meteora";
  if (
    owner === PROGRAM_IDS.PUMPSWAP_AMM ||
    owner === PROGRAM_IDS.PUMPSWAP_BONDING
  )
    return "pumpswap";
  if (
    owner === PROGRAM_IDS.METEORA_DAMM_V1 ||
    owner === PROGRAM_IDS.METEORA_DAMM_V2
  )
    return "meteora_balanced";
  return null;
}

/**
 * Enqueue a raw account buffer for worker decode.
 * Snapshots required lookup data from caches synchronously,
 * then pushes into the batch queue. Starts/resets the batch timer.
 */
export async function enqueueForWorkerDecode(
  rawBuffer: Buffer,
  poolId: string,
  owner: string,
  dexHint: DexHint
): Promise<void> {
  const cfg = getConfig();

  // Snapshot lookup data from caches
  const lookup = await snapshotLookupData(poolId, owner, dexHint);

  batchQueue.push({
    lookup,
    rawBuffer,
  });

  // Flush immediately if batch is full
  if (batchQueue.length >= cfg.maxBatchSize) {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    void flushBatch();
    return;
  }

  // Start/reset batch timer
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      batchTimer = null;
      void flushBatch();
    }, cfg.batchWindowMs);
  }
}

/**
 * Shutdown the worker decode pipeline.
 */
export function disposeWorkerDecode(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (workerClient) {
    workerClient.dispose();
    workerClient = null;
  }
  batchQueue = [];
  initialized = false;
}

// ── Internal: Lookup snapshot ──────────────────────────────────────────────

async function snapshotLookupData(
  poolId: string,
  owner: string,
  dexHint: DexHint
): Promise<PoolLookupData> {
  // Lazy import caches to avoid circular dependencies
  const { vaultBalanceCache } = await import("../../pools.cache.js");
  const { tryResolveDecimalsPairCached } = await import("../decimals.js");

  // Base lookup
  const lookup: PoolLookupData = {
    poolId,
    owner,
    dexHint,
    decimalsA: null,
    decimalsB: null,
  };

  // Try to find existing pool data in the appropriate cache
  let existingPool: any = null;
  try {
    const cache = await getCacheForDex(dexHint);
    if (cache?.data) {
      const d = cache.data as any;
      const arrays = [...(d.clmm || []), ...(d.amm || []), ...(d.cpmm || [])];
      existingPool = arrays.find((p: any) => p.id === poolId);
    }
  } catch {
    /* Pool might be new */
  }

  if (existingPool) {
    // Use cached pool data for decimals and orientation
    lookup.decimalsA =
      existingPool.decimals_a ?? existingPool.native_decimals_a ?? null;
    lookup.decimalsB =
      existingPool.decimals_b ?? existingPool.native_decimals_b ?? null;
    lookup.cachedMintA = existingPool.native_mint_a ?? existingPool.mint_a;
    lookup.cachedMintB = existingPool.native_mint_b ?? existingPool.mint_b;
    lookup.cachedWasSwapped = existingPool.was_swapped;
    lookup.cachedFeeBps = existingPool.fee_bps;

    // Vault balances for AMM/CPMM pools
    const vaultA = existingPool.native_account_a;
    const vaultB = existingPool.native_account_b;
    if (vaultA && vaultBalanceCache.has(vaultA)) {
      lookup.vaultBalanceA = vaultBalanceCache.get(vaultA)!.toString();
      lookup.vaultAddressA = vaultA;
    }
    if (vaultB && vaultBalanceCache.has(vaultB)) {
      lookup.vaultBalanceB = vaultBalanceCache.get(vaultB)!.toString();
      lookup.vaultAddressB = vaultB;
    }
  }

  // If decimals still missing, try the decimals cache
  if (lookup.decimalsA == null || lookup.decimalsB == null) {
    if (lookup.cachedMintA && lookup.cachedMintB) {
      const resolved = tryResolveDecimalsPairCached(
        lookup.cachedMintA,
        lookup.cachedMintB,
        poolId,
        dexHint
      );
      if (lookup.decimalsA == null) lookup.decimalsA = resolved.decA;
      if (lookup.decimalsB == null) lookup.decimalsB = resolved.decB;
    }
  }

  return lookup;
}

async function getCacheForDex(dexHint: DexHint) {
  const caches = await import("../../pools.cache.js");
  switch (dexHint) {
    case "raydium":
      return caches.raydiumCache;
    case "raydium-cpmm":
      return caches.cpmmCache;
    case "orca":
      return caches.orcaCache;
    case "meteora":
      return caches.meteoraCache;
    case "pumpswap":
      return caches.pumpswapCache;
    case "meteora_balanced":
      return caches.metbalCache;
    default:
      return null;
  }
}

// ── Internal: Flush and send batch ─────────────────────────────────────────

async function flushBatch(): Promise<void> {
  if (batchQueue.length === 0) return;
  if (!workerClient) {
    // Worker not available — fallback
    const events = batchQueue.splice(0);
    await fallbackDecodeOnMainThread(events);
    return;
  }

  const events = batchQueue.splice(0);
  const batchId = ++batchIdCounter;
  const cfg = getConfig();

  const request: DecodeJobRequest = {
    events,
    batchId,
    batchTimestampMs: Date.now(),
  };

  try {
    // Update metrics
    const metrics = await getMetrics();
    if (metrics.wsWorkerStats) {
      metrics.wsWorkerStats.batchesSent++;
      metrics.wsWorkerStats.eventsSent += events.length;
    }

    const response = await workerClient.run(
      { kind: "decodeBatch", payload: request },
      { timeoutMs: cfg.timeoutMs }
    );

    if (metrics.wsWorkerStats) {
      metrics.wsWorkerStats.batchesCompleted++;
      metrics.wsWorkerStats.totalDecodeTimeMs += response.decodeTimeMs;
    }

    // Apply results on main thread
    const applyT0 = performance.now();
    await applyDecodedBatch(response, events);
    if (metrics.wsWorkerStats) {
      metrics.wsWorkerStats.totalApplyTimeMs += performance.now() - applyT0;
    }
  } catch (err) {
    try {
      const metrics = await getMetrics();
      if (metrics.wsWorkerStats) {
        metrics.wsWorkerStats.batchesFailed++;
      }
      logger.warn("worker.decode.batch_failed", {
        batchId,
        eventCount: events.length,
        error: String((err as any)?.message || err),
        cat: "pools",
      });
    } catch {
      /* ignore logging errors */
    }

    // Fallback: decode on main thread
    await fallbackDecodeOnMainThread(events);
  }
}

// ── Internal: Apply decoded results ────────────────────────────────────────

async function applyDecodedBatch(
  response: PoolDecodeWorkerResponse,
  originalEvents: DecodeJobEvent[]
): Promise<void> {
  const metrics = await getMetrics();
  const { tryActivatePool } = await import("../../pools.activation.js");
  const { onPoolTickUpdate } = await import("../../pools.websockets.js");
  const { recordPoolActivity } = await import("./staleness.js");
  const { executionCache } = await import("../../../execution/cache.js");
  const { tryResolveDecimalsPairCached } = await import("../decimals.js");

  // Determine which dexes have successful results so we can snapshot BEFORE mutating
  const affectedDexes = new Set<DexHint>();
  for (const result of response.results) {
    if (result.success && result.pool && result.pool.price_a_per_b > 0) {
      affectedDexes.add(result.dexHint);
    }
  }

  // Snapshot affected caches BEFORE applying any mutations
  // This is critical: applyPoolUpdates diffs prev vs next to find changes
  const caches = await import("../../pools.cache.js");
  const preSnapshots = new Map<DexHint, any>();
  for (const dex of affectedDexes) {
    const cache = getCacheForDexSync(dex, caches);
    if (cache?.data) {
      try {
        preSnapshots.set(dex, structuredClone(cache.data));
      } catch {
        // structuredClone may fail on certain data; skip graph update for this dex
      }
    }
  }

  for (const result of response.results) {
    try {
      if (!result.success) {
        // Handle specific skip reasons
        if (result.skipReason === "decimals_pending") {
          // Queue background RPC resolution — next event will have decimals cached
          const lookup = originalEvents[result.rawBufferIndex]?.lookup;
          if (lookup?.cachedMintA && lookup?.cachedMintB) {
            tryResolveDecimalsPairCached(
              lookup.cachedMintA,
              lookup.cachedMintB,
              result.poolId,
              result.dexHint
            );
          }
          if (metrics.wsWorkerStats) metrics.wsWorkerStats.eventsSkipped++;
        } else if (result.skipReason === "discriminator_mismatch") {
          // Expected for non-pool accounts — not an error
          if (metrics.wsWorkerStats) metrics.wsWorkerStats.eventsSkipped++;
        } else {
          // Actual decode error — log it
          if (metrics.wsWorkerStats) metrics.wsWorkerStats.eventsSkipped++;
          logger.debug("worker.decode.event_failed", {
            poolId: result.poolId?.slice(0, 8),
            dex: result.dexHint,
            error: result.error,
            skipReason: result.skipReason,
            cat: "pools",
          });
        }
        continue;
      }

      const pool = result.pool;
      if (!pool || pool.price_a_per_b <= 0) {
        // Pool decoded but no valid price (e.g., vault balance missing)
        // Still apply structural data to execution cache
        if (pool) {
          applyStructuralData(pool, result.dexHint, executionCache);
        }
        if (metrics.wsWorkerStats) metrics.wsWorkerStats.eventsDecoded++;
        continue;
      }

      // Apply to pool cache (mutates the live cache)
      await applyToPoolCache(pool, result.dexHint);

      // Apply to execution cache
      applyStructuralData(pool, result.dexHint, executionCache);

      // Update metrics
      if (metrics.wsWorkerStats) metrics.wsWorkerStats.eventsDecoded++;
      const statsDex = dexHintToStatsDex(result.dexHint, pool.pool_kind);
      if (statsDex && metrics.wsDeltaStats?.[statsDex]) {
        metrics.wsDeltaStats[statsDex].decoded++;
        metrics.wsDeltaStats[statsDex].applied++;
      }
      if (statsDex && metrics.wsDecodeStats?.[statsDex]) {
        metrics.wsDecodeStats[statsDex].attempts++;
        metrics.wsDecodeStats[statsDex].successes++;
      }

      // Activation
      tryActivatePool(result.poolId, pool.dex, true);

      // Tick/bin update for CLMM/DLMM
      if (pool.native_tick_current_index != null) {
        onPoolTickUpdate(result.poolId, pool.native_tick_current_index);
      }

      // Activity tracking
      recordPoolActivity(result.poolId, pool.dex as any, result.poolId);
    } catch (err) {
      logCatchError("worker.decode.apply", err);
    }
  }

  // Schedule graph updates for each affected dex using the pre-mutation snapshots
  for (const dex of affectedDexes) {
    const prev = preSnapshots.get(dex);
    if (prev) {
      scheduleGraphUpdate(dex, prev);
    }
  }
}

// ── Internal: Apply to pool cache ──────────────────────────────────────────

async function applyToPoolCache(
  pool: NonNullable<DecodedPoolResult["pool"]>,
  dexHint: DexHint
): Promise<void> {
  const caches = await import("../../pools.cache.js");
  const cache = getCacheForDexSync(dexHint, caches);
  if (!cache?.data) return;

  const arrayName =
    pool.pool_kind === "clmm"
      ? "clmm"
      : pool.pool_kind === "dlmm"
      ? "clmm"
      : pool.pool_kind === "cpmm"
      ? "cpmm"
      : "amm";

  const arr = (cache.data as any)[arrayName];
  if (!arr) return;

  const idx = arr.findIndex((p: any) => p.id === pool.id);
  if (idx >= 0) {
    // Merge into existing — preserve fields not returned by worker
    const existing = arr[idx];
    arr[idx] = { ...existing, ...pool, updated_ms: Date.now() };
  } else {
    arr.push({ ...pool });
  }

  cache.ts = Date.now();
}

function getCacheForDexSync(dexHint: DexHint, caches: any) {
  switch (dexHint) {
    case "raydium":
      return caches.raydiumCache;
    case "raydium-cpmm":
      return caches.cpmmCache;
    case "orca":
      return caches.orcaCache;
    case "meteora":
      return caches.meteoraCache;
    case "pumpswap":
      return caches.pumpswapCache;
    case "meteora_balanced":
      return caches.metbalCache;
    default:
      return null;
  }
}

// ── Internal: Apply structural data to execution cache ─────────────────────

function applyStructuralData(
  pool: NonNullable<DecodedPoolResult["pool"]>,
  dexHint: DexHint,
  executionCache: any
): void {
  try {
    const staticData: Record<string, any> = {
      dex: pool.dex,
      pool_kind: pool.pool_kind,
      mint_a: pool.mint_a,
      mint_b: pool.mint_b,
      decimals_a: pool.decimals_a,
      decimals_b: pool.decimals_b,
      native_mint_a: pool.native_mint_a,
      native_mint_b: pool.native_mint_b,
      native_decimals_a: pool.native_decimals_a,
      native_decimals_b: pool.native_decimals_b,
      was_swapped: pool.was_swapped,
    };

    // Vault addresses
    if (pool.native_account_a)
      staticData.native_account_a = pool.native_account_a;
    if (pool.native_account_b)
      staticData.native_account_b = pool.native_account_b;
    if (pool.token_vault_a) {
      staticData.native_account_a = pool.token_vault_a;
      staticData.vault_a = pool.was_swapped
        ? pool.token_vault_b
        : pool.token_vault_a;
      staticData.vault_b = pool.was_swapped
        ? pool.token_vault_a
        : pool.token_vault_b;
    }
    if (pool.token_vault_b) {
      staticData.native_account_b = pool.token_vault_b;
    }

    // CLMM-specific
    if (pool.amm_config) staticData.amm_config = pool.amm_config;
    if (pool.observation_state)
      staticData.observation_state = pool.observation_state;
    if (pool.oracle) staticData.oracle = pool.oracle;

    // Meteora-specific
    if (pool.bin_step) staticData.binStep = pool.bin_step;

    executionCache.setStatic(pool.id, staticData);

    // Hot data (tick/liquidity)
    const hotData: Record<string, any> = { dex: pool.dex };
    if (pool.sqrt_price_x64 != null)
      hotData.sqrtPriceX64 = BigInt(
        pool.sqrt_price_x64_raw || pool.sqrt_price_x64
      );
    if (pool.tick_current_index != null)
      hotData.currentTickIndex = pool.tick_current_index;
    if (pool.tick_spacing != null) hotData.tickSpacing = pool.tick_spacing;
    if (pool.liquidity != null)
      hotData.liquidity = pool.liquidity_raw
        ? BigInt(pool.liquidity_raw)
        : BigInt(pool.liquidity);
    if (pool.fee_bps != null) hotData.feeRate = pool.fee_bps;
    if (pool.active_id != null) hotData.activeId = pool.active_id;
    if (pool.bin_step != null) hotData.binStep = pool.bin_step;

    if (Object.keys(hotData).length > 1) {
      // more than just 'dex'
      executionCache.setHot(pool.id, hotData);
    }
  } catch (err) {
    logCatchError("worker.decode.applyStructural", err);
  }
}

// ── Internal: Graph update scheduling (debounced per-dex) ──────────────────

const graphUpdateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// Store the earliest pre-mutation snapshot per dex for the pending timer
const pendingSnapshots: Map<string, any> = new Map();
const GRAPH_UPDATE_DEBOUNCE_MS = 50;

function scheduleGraphUpdate(dexHint: DexHint, prevSnapshot: any): void {
  // Keep the EARLIEST snapshot — subsequent batches within the debounce window
  // should diff against the state before any of them mutated the cache
  if (!pendingSnapshots.has(dexHint)) {
    pendingSnapshots.set(dexHint, prevSnapshot);
  }

  if (graphUpdateTimers.has(dexHint)) return; // Already scheduled

  graphUpdateTimers.set(
    dexHint,
    setTimeout(async () => {
      graphUpdateTimers.delete(dexHint);
      const prev = pendingSnapshots.get(dexHint);
      pendingSnapshots.delete(dexHint);
      try {
        const gmod: any = await import("../../graph.js");
        const cache = await getCacheForDex(dexHint);
        if (
          prev &&
          cache?.data &&
          typeof gmod?.applyPoolUpdates === "function"
        ) {
          // prev = snapshot BEFORE mutations, cache.data = live state AFTER mutations
          await gmod.applyPoolUpdates(prev, cache.data, {
            pushToArb: false,
          });
        }
      } catch (err) {
        logCatchError("worker.decode.graphUpdate", err);
      }
    }, GRAPH_UPDATE_DEBOUNCE_MS)
  );
}

// ── Internal: Fallback to main-thread decoders ─────────────────────────────

async function fallbackDecodeOnMainThread(
  events: DecodeJobEvent[]
): Promise<void> {
  const metrics = await getMetrics();
  if (metrics.wsWorkerStats) {
    metrics.wsWorkerStats.fallbackEvents += events.length;
  }

  // Lazy-import the modular decoders
  const { handleRaydiumUpdate } = await import("./decoders/raydium.js");
  const { handleRaydiumCpmmUpdate } = await import("./decoders/raydiumCpmm.js");
  const { handleOrcaUpdate } = await import("./decoders/orca.js");
  const { handleMeteoraUpdate } = await import("./decoders/meteora.js");
  const { handlePumpswapUpdate } = await import("./decoders/pumpswap.js");
  const { handleMeteoraBalancedUpdate } = await import(
    "./decoders/meteoraBalanced.js"
  );

  for (const event of events) {
    try {
      const { lookup, rawBuffer } = event;
      const accountInfo = {
        data: Buffer.from(rawBuffer),
        executable: false,
        lamports: 0,
        owner: lookup.owner,
      };

      const emptyMap = new Map();
      switch (lookup.dexHint) {
        case "raydium":
          await handleRaydiumUpdate(
            accountInfo as any,
            lookup.poolId,
            emptyMap
          );
          break;
        case "raydium-cpmm":
          await handleRaydiumCpmmUpdate(
            accountInfo as any,
            lookup.poolId,
            emptyMap
          );
          break;
        case "orca":
          await handleOrcaUpdate(accountInfo as any, lookup.poolId, emptyMap);
          break;
        case "meteora":
          await handleMeteoraUpdate(
            accountInfo as any,
            lookup.poolId,
            emptyMap
          );
          break;
        case "pumpswap":
          await handlePumpswapUpdate(
            accountInfo as any,
            lookup.poolId,
            emptyMap
          );
          break;
        case "meteora_balanced":
          await handleMeteoraBalancedUpdate(
            accountInfo as any,
            lookup.poolId,
            emptyMap
          );
          break;
      }
    } catch (err) {
      logCatchError("worker.decode.fallback", err);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

type WsStatsDex =
  | "raydium_amm"
  | "raydium_clmm"
  | "raydium_cpmm"
  | "orca"
  | "meteora_dlmm"
  | "meteora_damm_v1"
  | "meteora_damm_v2"
  | "pumpswap";

function dexHintToStatsDex(
  dexHint: DexHint,
  poolKind: string
): WsStatsDex | null {
  switch (dexHint) {
    case "raydium":
      return poolKind === "clmm" ? "raydium_clmm" : "raydium_amm";
    case "raydium-cpmm":
      return "raydium_cpmm";
    case "orca":
      return "orca";
    case "meteora":
      return "meteora_dlmm";
    case "pumpswap":
      return "pumpswap";
    case "meteora_balanced": {
      // Distinguish V1/V2 based on the pool's owner program
      // Default to v1 since we can't easily distinguish here
      return "meteora_damm_v1";
    }
    default:
      return null;
  }
}
