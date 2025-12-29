import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';

export function createPoolsRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/arb/pools/raydium', async (req, res) => {
    try {
      const q = (req.query || {}) as { minUsd?: string; minAmm?: string; minClmm?: string; unknown?: string; anchor?: string };
      const prevAmm = Number((CONFIG.raydium as any)?.minAmmLiqBase || 0);
      const prevClmm = Number((CONFIG.raydium as any)?.minClmmLiquidity || 0);
      // Anchor discovery/deprecation: ignore route-level anchor overrides (HTTP fetcher only)
      let restore = false;
      try {
        if (q.minAmm != null) { (CONFIG.raydium as any).minAmmLiqBase = Math.max(0, Number(q.minAmm)); restore = true; }
        if (q.minClmm != null) { (CONFIG.raydium as any).minClmmLiquidity = Math.max(0, Number(q.minClmm)); restore = true; }
        // Ignore q.anchor for Raydium; retained only for backward compatibility
      } catch {}
      const { getRaydiumPoolsNormalized } = await import('../pools.js');
      const pools = await getRaydiumPoolsNormalized(false);
      try { if (restore) { (CONFIG.raydium as any).minAmmLiqBase = prevAmm; (CONFIG.raydium as any).minClmmLiquidity = prevClmm; } } catch {}
      let out = pools;
      // Optional harmonized TVL filters/sorting via query: minUsd, limit, sort=tvl
      try {
        const extra = (req.query || {}) as { minUsd?: string; limit?: string; sort?: string };
        const val = (p: any) => {
          const tvl = Number((p as any)?.tvl_usd ?? 0);
          if (Number.isFinite(tvl) && tvl > 0) return tvl;
          const disp = Number((p as any)?.liquidity_display ?? 0);
          if (Number.isFinite(disp) && disp > 0) return disp;
          const liq = Number((p as any)?.liquidity ?? (p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_base ?? 0);
          return Number.isFinite(liq) && liq > 0 ? liq : 0;
        };
        const minUsd = Math.max(0, Number(extra.minUsd ?? NaN));
        const limit = Math.max(0, Number(extra.limit ?? NaN));
        const sortTvl = String(extra.sort || '').toLowerCase() === 'tvl';
        const filt = (arr: any[]) => (Number.isFinite(minUsd) && minUsd > 0) ? arr.filter(p => val(p) >= minUsd) : arr;
        let amm = filt(pools.amm || []);
        let clmm = filt(pools.clmm || []);
        if (sortTvl) { amm = [...amm].sort((a,b) => val(b) - val(a)); clmm = [...clmm].sort((a,b) => val(b) - val(a)); }
        if (Number.isFinite(limit) && limit > 0) { amm = amm.slice(0, limit); clmm = clmm.slice(0, limit); }
        out = { amm, clmm } as any;
      } catch {}
      const routeScope = !!((CONFIG.system as any)?.routeLevelScoping);
      if (routeScope) {
        try {
          const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
          if (mode !== 'none') {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('../universe.js');
            const universe = await computeTokenUniverse(mode as any);
            const filtered = filterPoolsByUniverse(pools as any, universe, !!((CONFIG.system as any)?.enableAnchorBridging));
            const upstreamCount = (pools.amm?.length || 0) + (pools.clmm?.length || 0);
            const scopedCount = (filtered.amm.length || 0) + (filtered.clmm.length || 0);
            out = (upstreamCount > 0 && scopedCount === 0) ? pools : (filtered as any);
          }
        } catch {}
      }
      res.json(out);
    } catch (e: any) {
      logger.error('raydium pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  api.get('/arb/pools/orca', async (req, res) => {
    try {
      const { getOrcaPoolsCached } = await import('../pools.js');
      const pools = await getOrcaPoolsCached(false);
      let out = pools;
      // Optional harmonized TVL filters/sorting via query: minUsd, limit, sort=tvl
      try {
        const q = (req.query || {}) as { minUsd?: string; limit?: string; sort?: string };
        const val = (p: any) => {
          const tvl = Number((p as any)?.tvl_usd ?? 0);
          if (Number.isFinite(tvl) && tvl > 0) return tvl;
          const disp = Number((p as any)?.liquidity_display ?? 0);
          if (Number.isFinite(disp) && disp > 0) return disp;
          const liq = Number((p as any)?.liquidity ?? (p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_base ?? 0);
          return Number.isFinite(liq) && liq > 0 ? liq : 0;
        };
        const minUsd = Math.max(0, Number(q.minUsd ?? NaN));
        const limit = Math.max(0, Number(q.limit ?? NaN));
        const sortTvl = String(q.sort || '').toLowerCase() === 'tvl';
        const filt = (arr: any[]) => (Number.isFinite(minUsd) && minUsd > 0) ? arr.filter(p => val(p) >= minUsd) : arr;
        let amm = filt(pools.amm || []);
        let clmm = filt(pools.clmm || []);
        if (sortTvl) { amm = [...amm].sort((a,b) => val(b) - val(a)); clmm = [...clmm].sort((a,b) => val(b) - val(a)); }
        if (Number.isFinite(limit) && limit > 0) { amm = amm.slice(0, limit); clmm = clmm.slice(0, limit); }
        out = { amm, clmm } as any;
      } catch {}
      const routeScope = !!((CONFIG.system as any)?.routeLevelScoping);
      if (routeScope) {
        try {
          const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
          if (mode !== 'none') {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('../universe.js');
            const universe = await computeTokenUniverse(mode as any);
            const filtered = filterPoolsByUniverse(pools as any, universe, !!((CONFIG.system as any)?.enableAnchorBridging));
            const upstreamCount = (pools.amm?.length || 0) + (pools.clmm?.length || 0);
            const scopedCount = (filtered.amm.length || 0) + (filtered.clmm.length || 0);
            out = (upstreamCount > 0 && scopedCount === 0) ? pools : (filtered as any);
          }
        } catch {}
      }
      res.json(out);
    } catch (e: any) {
      logger.error('orca pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  api.get('/arb/pools/meteora', async (req, res) => {
    try {
      const { getMeteoraPoolsCached } = await import('../pools.js');
      const pools = await getMeteoraPoolsCached(false);
      let out = pools;
      // Optional harmonized TVL filters/sorting via query: minUsd, limit, sort=tvl
      try {
        const q = (req.query || {}) as { minUsd?: string; limit?: string; sort?: string };
        const val = (p: any) => {
          const tvl = Number((p as any)?.tvl_usd ?? 0);
          if (Number.isFinite(tvl) && tvl > 0) return tvl;
          const disp = Number((p as any)?.liquidity_display ?? 0);
          if (Number.isFinite(disp) && disp > 0) return disp;
          const liq = Number((p as any)?.liquidity ?? (p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_base ?? 0);
          return Number.isFinite(liq) && liq > 0 ? liq : 0;
        };
        const minUsd = Math.max(0, Number(q.minUsd ?? NaN));
        const limit = Math.max(0, Number(q.limit ?? NaN));
        const sortTvl = String(q.sort || '').toLowerCase() === 'tvl';
        let amm: any[] = [];
        let clmm = (pools.clmm || []);
        if (Number.isFinite(minUsd) && minUsd > 0) clmm = clmm.filter(p => val(p) >= minUsd);
        if (sortTvl) clmm = [...clmm].sort((a,b) => val(b) - val(a));
        if (Number.isFinite(limit) && limit > 0) clmm = clmm.slice(0, limit);
        out = { amm, clmm } as any;
      } catch {}
      res.json(out);
    } catch (e: any) {
      logger.error('meteora pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  // (Saber route removed)

  api.get('/arb/pools/meteora-balanced', async (req, res) => {
    try {
      const { getMeteoraBalancedPoolsCached } = await import('../pools.js');
      const pools = await getMeteoraBalancedPoolsCached(false);
      const q = (req.query || {}) as { minUsd?: string; limit?: string; sort?: string };
      const val = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const liq = Number((p as any)?.liquidity ?? (p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_base ?? 0);
        return Number.isFinite(liq) && liq > 0 ? liq : 0;
      };
      let amm = pools.amm || [];
      const minUsd = Math.max(0, Number(q.minUsd ?? NaN));
      const limit = Math.max(0, Number(q.limit ?? NaN));
      const sortTvl = String(q.sort || '').toLowerCase() === 'tvl';
      if (Number.isFinite(minUsd) && minUsd > 0) amm = amm.filter(p => val(p) >= minUsd);
      if (sortTvl) amm = [...amm].sort((a,b) => val(b) - val(a));
      if (Number.isFinite(limit) && limit > 0) amm = amm.slice(0, limit);
      res.json({ amm, clmm: [] });
    } catch (e: any) {
      logger.error('meteora balanced pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  api.get('/arb/pools/pumpswap', async (req, res) => {
    try {
      const { getPumpswapPoolsCached } = await import('../pools.js');
      const pools = await getPumpswapPoolsCached(false);
      const q = (req.query || {}) as { minUsd?: string; limit?: string; sort?: string };
      const val = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const liq = Number((p as any)?.liquidity ?? (p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_base ?? 0);
        return Number.isFinite(liq) && liq > 0 ? liq : 0;
      };
      let amm = pools.amm || [];
      const minUsd = Math.max(0, Number(q.minUsd ?? NaN));
      const limit = Math.max(0, Number(q.limit ?? NaN));
      const sortTvl = String(q.sort || '').toLowerCase() === 'tvl';
      if (Number.isFinite(minUsd) && minUsd > 0) amm = amm.filter(p => val(p) >= minUsd);
      if (sortTvl) amm = [...amm].sort((a,b) => val(b) - val(a));
      if (Number.isFinite(limit) && limit > 0) amm = amm.slice(0, limit);
      res.json({ amm, clmm: [] });
    } catch (e: any) {
      logger.error('pumpswap pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  api.get('/arb/pools/universe/diagnostics', async (_req, res) => {
    try {
      const { getSourceTokenSet, getWatchlistTokenSet, getJupiterTokenSet, computeTokenUniverse } = await import('../universe.js');
      const ray = await getSourceTokenSet('raydium');
      const orc = await getSourceTokenSet('orca');
      const wl = await getWatchlistTokenSet();
      const jup = await getJupiterTokenSet();
      const uni = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      res.json({ raydium: ray.size, orca: orc.size, watchlist: wl.size, jupiter: jup.size, universe: uni.size });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/refresh', async (req, res) => {
    try {
      const cfg = req.body || {};
      if (cfg.force == null) cfg.force = true;
      if (cfg.subscribe == null) cfg.subscribe = true;
      
      // Parse sources configuration from request body
      // Example: { sources: { raydium: true, orca: false, meteora: true } }
      // Or granular: { sources: { raydium: { amm: true, clmm: false } } }
      const sources = cfg.sources || undefined;
      
      const { refreshAllSources } = await import('../pools.js');
      const { getGraphSnapshot } = await import('../graph.js');
      const { enablePoolWebsocketRefreshes, getWsActivity, getPoolCacheAges } = await import('../pools.js');
      
      const out = await refreshAllSources(!!cfg.force, !!cfg.subscribe, { sources });
      const snap = await getGraphSnapshot(true);
      const ws = getWsActivity();
      const ages = getPoolCacheAges();
      
      res.json({ 
        ok: true, 
        counts: { 
          raydium: { amm: out.raydium?.amm?.length || 0, clmm: out.raydium?.clmm?.length || 0 },
          orca: { amm: out.orca?.amm?.length || 0, clmm: out.orca?.clmm?.length || 0 },
          meteora: { clmm: out.meteora?.clmm?.length || 0 },
          meteora_balanced: { amm: out.meteora_balanced?.amm?.length || 0 },
          pumpswap: { amm: out.pumpswap?.amm?.length || 0 },
        }, 
        graph: { nodes: (snap.nodes || []).length, edges: (snap.edges || []).length }, 
        ws, 
        ages 
      });
      emit('log', { level: 'info', message: 'pools:refresh triggered', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/subscribe', async (_req, res) => {
    try {
      const { enablePoolWebsocketRefreshes, startPoolWebsocketsOnlyOnce } = await import('../pools.js');
      enablePoolWebsocketRefreshes();
      startPoolWebsocketsOnlyOnce();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/unsubscribe', async (_req, res) => {
    try {
      const { disablePoolWebsocketRefreshes } = await import('../pools.js');
      disablePoolWebsocketRefreshes();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.get('/arb/pools/subscriptions', async (_req, res) => {
    try {
      const { getPoolWsStatus, getWsActivity, getWsTargets } = await import('../pools.js');
      const st = getPoolWsStatus();
      const ws = getWsActivity();
      const defaultTargets = {
        orca: { target: 0 },
        raydium: { target: 0 },
        meteora: { target: 0 },
        meteora_balanced: { target: 0 },
        pumpswap: { target: 0 },
      };
      let targets: any = defaultTargets;
      try { targets = await getWsTargets(); } catch {}
      res.json({ wsEnabled: st.enabled, wsHealthy: st.healthy, lastEventMs: st.lastEventMs, ws, targets });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/retarget', async (_req, res) => {
    try {
      const { retargetPoolWebsockets } = await import('../pools.js');
      const r = await retargetPoolWebsockets();
      res.json({ ok: true, attached: r.attached });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/revalidate
   * Validates tick/bin arrays for CLMM pools using SDKs and refreshes invalid ones.
   * This is the preferred method for ensuring cached pools have valid tick/bin arrays.
   * 
   * Body params:
   * - dex: 'orca' | 'raydium' | 'meteora' (optional - if not provided, validates all)
   * - limit: number of pools per DEX to validate (default: 50, max: 200)
   * - concurrency: parallel refresh operations (default: 10)
   */
  api.post('/arb/pools/revalidate', async (req, res) => {
    try {
      const { dex, limit = 50, concurrency = 10 } = req.body || {};
      const { revalidateDex, revalidateAllPools } = await import('../pools.revalidate.js');
      
      const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
      const safeConcurrency = Math.min(Math.max(1, Number(concurrency) || 10), 20);
      
      let result;
      if (dex && ['orca', 'raydium', 'meteora'].includes(dex)) {
        result = await revalidateDex(dex, { limit: safeLimit, concurrency: safeConcurrency });
      } else {
        result = await revalidateAllPools({ limit: safeLimit, concurrency: safeConcurrency });
      }
      
      res.json({ 
        success: true, 
        ...result,
        message: `Validated ${result.totalPools} pools, ${result.healthPercent}% healthy, refreshed ${result.refreshed}`,
      });
    } catch (e: any) {
      logger.error('pools.revalidate.endpoint.failed', { error: String(e?.message || e), cat: 'pools' });
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * GET /arb/pools/persistence-status
   * Returns the current pool persistence configuration and status
   */
  api.get('/arb/pools/persistence-status', async (_req, res) => {
    try {
      const { 
        isPersistenceEnabled, 
        shouldAutoStartSubscriptions, 
        snapshotExists,
        getSnapshotFilePath 
      } = await import('../pools.persistence.js');
      
      const exists = await snapshotExists();
      
      res.json({
        enabled: isPersistenceEnabled(),
        autoStartSubscriptions: shouldAutoStartSubscriptions(),
        snapshotExists: exists,
        snapshotPath: getSnapshotFilePath(),
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/save-snapshot
   * Manually trigger saving the current pool caches to disk
   */
  api.post('/arb/pools/save-snapshot', async (_req, res) => {
    try {
      const { savePoolsSnapshot } = await import('../pools.persistence.js');
      const saved = await savePoolsSnapshot();
      res.json({ success: saved, message: saved ? 'Snapshot saved' : 'No pools to save or persistence disabled' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/load-snapshot
   * Manually trigger loading pools from disk snapshot
   */
  api.post('/arb/pools/load-snapshot', async (_req, res) => {
    try {
      const { initializeFromSnapshot } = await import('../pools.persistence.js');
      const loaded = await initializeFromSnapshot();
      res.json({ 
        success: loaded, 
        message: loaded ? 'Snapshot loaded and graph built' : 'No snapshot found or persistence disabled' 
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // NAMED SNAPSHOT MANAGEMENT
  // ============================================================================

  /**
   * GET /arb/pools/snapshots
   * List all available named snapshots
   */
  api.get('/arb/pools/snapshots', async (_req, res) => {
    try {
      const { listSnapshots, getActiveSnapshotName } = await import('../pools.persistence.js');
      const snapshots = await listSnapshots();
      const activeSnapshot = await getActiveSnapshotName();
      res.json({ 
        success: true, 
        snapshots,
        activeSnapshot,
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/snapshot/save
   * Save current pools as a named snapshot
   * Body: { name: string, description?: string }
   */
  api.post('/arb/pools/snapshot/save', async (req, res) => {
    try {
      const { name, description } = req.body || {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      
      const { saveNamedSnapshot } = await import('../pools.persistence.js');
      const result = await saveNamedSnapshot(name, { description });
      
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/snapshot/load
   * Load a named snapshot
   * Body: { name: string }
   */
  api.post('/arb/pools/snapshot/load', async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      
      const { loadNamedSnapshot } = await import('../pools.persistence.js');
      const result = await loadNamedSnapshot(name, { buildGraph: true, setActive: true });
      
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * DELETE /arb/pools/snapshot/:name
   * Delete a named snapshot
   */
  api.delete('/arb/pools/snapshot/:name', async (req, res) => {
    try {
      const { name } = req.params;
      if (!name) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      
      const { deleteNamedSnapshot } = await import('../pools.persistence.js');
      const result = await deleteNamedSnapshot(name);
      
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/snapshot/merge
   * Merge multiple snapshots together
   * Body: { names: string[], mode?: 'union' | 'intersection', saveTo?: string }
   */
  api.post('/arb/pools/snapshot/merge', async (req, res) => {
    try {
      const { names, mode = 'union', saveTo } = req.body || {};
      if (!names || !Array.isArray(names) || names.length === 0) {
        return res.status(400).json({ success: false, error: 'Names array is required' });
      }
      
      const { mergeSnapshots } = await import('../pools.persistence.js');
      const result = await mergeSnapshots(names, { 
        mode: mode === 'intersection' ? 'intersection' : 'union',
        buildGraph: true,
        saveTo,
      });
      
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * GET /arb/pools/validate-cache
   * Validate tick/bin array cache entries against on-chain state
   * 
   * Query params:
   * - dex: 'orca' | 'raydium' | 'meteora' | 'all' (default: 'all')
   * - limit: number of pools per DEX to validate (default: 20, max: 100)
   * - poolId: specific pool ID to validate (optional)
   */
  api.get('/arb/pools/validate-cache', async (req, res) => {
    try {
      const { getConnection } = await import('../../wallet/wallet.js');
      const { 
        validatePoolCache, 
        validatePoolCacheBatch, 
        getCacheHealthSummary 
      } = await import('../../execution/cacheValidator.js');
      
      const connection = getConnection();
      const dex = String(req.query.dex || 'all').toLowerCase();
      // Use limit=0 or all=true to validate all pools
      const validateAll = req.query.all === 'true' || req.query.limit === '0';
      const limit = validateAll ? Infinity : Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
      const poolId = req.query.poolId as string | undefined;
      
      // Single pool validation
      if (poolId) {
        const poolDex = req.query.dex as 'orca' | 'raydium' | 'meteora';
        if (!poolDex || !['orca', 'raydium', 'meteora'].includes(poolDex)) {
          return res.status(400).json({ 
            error: 'dex query param required (orca, raydium, or meteora) when validating single pool' 
          });
        }
        const result = await validatePoolCache(connection, poolId, poolDex);
        return res.json({ success: true, result });
      }
      
      // Batch validation by DEX
      if (dex === 'all') {
        const summary = await getCacheHealthSummary(connection, { 
          poolsPerDex: validateAll ? Infinity : limit, 
          validateAll 
        });
        return res.json({ 
          success: true, 
          summary: {
            overallHealthPercent: summary.overallHealthPercent,
            timestamp: summary.timestamp,
            orca: {
              totalPools: summary.orca.totalPools,
              validPools: summary.orca.validPools,
              invalidPools: summary.orca.invalidPools,
              poolsWithMissingCenter: summary.orca.poolsWithMissingCenter,
              poolsWithMissingArrays: summary.orca.poolsWithMissingArrays,
              poolsWithNoCacheEntry: summary.orca.poolsWithNoCacheEntry,
              durationMs: summary.orca.durationMs,
            },
            raydium: {
              totalPools: summary.raydium.totalPools,
              validPools: summary.raydium.validPools,
              invalidPools: summary.raydium.invalidPools,
              poolsWithMissingCenter: summary.raydium.poolsWithMissingCenter,
              poolsWithMissingArrays: summary.raydium.poolsWithMissingArrays,
              poolsWithNoCacheEntry: summary.raydium.poolsWithNoCacheEntry,
              durationMs: summary.raydium.durationMs,
            },
            meteora: {
              totalPools: summary.meteora.totalPools,
              validPools: summary.meteora.validPools,
              invalidPools: summary.meteora.invalidPools,
              poolsWithMissingCenter: summary.meteora.poolsWithMissingCenter,
              poolsWithMissingArrays: summary.meteora.poolsWithMissingArrays,
              poolsWithNoCacheEntry: summary.meteora.poolsWithNoCacheEntry,
              durationMs: summary.meteora.durationMs,
            },
          },
          // Include detailed results for invalid pools only to keep response size manageable
          invalidPools: [
            ...summary.orca.results.filter(r => !r.valid),
            ...summary.raydium.results.filter(r => !r.valid),
            ...summary.meteora.results.filter(r => !r.valid),
          ],
        });
      }
      
      // Single DEX validation
      if (!['orca', 'raydium', 'meteora'].includes(dex)) {
        return res.status(400).json({ error: 'Invalid dex. Must be: orca, raydium, meteora, or all' });
      }
      
      const result = await validatePoolCacheBatch(connection, dex as 'orca' | 'raydium' | 'meteora', { limit });
      return res.json({ 
        success: true, 
        dex,
        summary: {
          totalPools: result.totalPools,
          validPools: result.validPools,
          invalidPools: result.invalidPools,
          poolsWithMissingCenter: result.poolsWithMissingCenter,
          poolsWithMissingArrays: result.poolsWithMissingArrays,
          poolsWithNoCacheEntry: result.poolsWithNoCacheEntry,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
        },
        results: result.results,
      });
    } catch (e: any) {
      logger.error('cache validation failed', { error: String(e?.message || e) });
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/refresh-invalid
   * Refresh invalid pools by fetching validated tick/bin arrays via SDK
   * Body: { dex?: 'orca' | 'raydium' | 'meteora' | 'all', limit?: number }
   */
  api.post('/arb/pools/refresh-invalid', async (req, res) => {
    try {
      const { validatePoolCacheBatch, getCacheHealthSummary, refreshInvalidPools } = await import('../../execution/cacheValidator.js');
      const { getConnection } = await import('../../wallet/wallet.js');
      const connection = getConnection();
      
      const dex = (req.body?.dex || 'all').toLowerCase();
      const validateAll = req.body?.all === true || req.body?.limit === 0;
      const limit = validateAll ? Infinity : Math.min(Math.max(1, Number(req.body?.limit || 50)), 100);
      
      // First, find invalid pools
      let invalidPools: any[] = [];
      
      if (dex === 'all') {
        const summary = await getCacheHealthSummary(connection, { 
          poolsPerDex: validateAll ? Infinity : limit, 
          validateAll 
        });
        invalidPools = [
          ...summary.orca.results.filter(r => !r.valid),
          ...summary.raydium.results.filter(r => !r.valid),
          ...summary.meteora.results.filter(r => !r.valid),
        ];
      } else if (['orca', 'raydium', 'meteora'].includes(dex)) {
        const result = await validatePoolCacheBatch(connection, dex as 'orca' | 'raydium' | 'meteora', { limit });
        invalidPools = result.results.filter(r => !r.valid);
      } else {
        return res.status(400).json({ error: 'Invalid dex. Must be: orca, raydium, meteora, or all' });
      }
      
      if (invalidPools.length === 0) {
        return res.json({ 
          success: true, 
          message: 'No invalid pools to refresh',
          refreshed: 0,
          failed: 0,
        });
      }
      
      // Refresh invalid pools
      const refreshResult = await refreshInvalidPools(connection, invalidPools);
      
      return res.json({
        success: true,
        message: `Refreshed ${refreshResult.refreshed} of ${invalidPools.length} invalid pools`,
        refreshed: refreshResult.refreshed,
        failed: refreshResult.failed,
        errors: refreshResult.errors.slice(0, 10), // Limit error messages
      });
    } catch (e: any) {
      logger.error('cache refresh failed', { error: String(e?.message || e) });
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/validate-bitmap-extensions
   * Validate and refresh Meteora DLMM bitmap extensions.
   * 
   * Derives correct PDAs, checks on-chain existence, and updates caches.
   * Use this when bitmap extension errors occur (error code 6036).
   * 
   * Query params:
   * - limit: number of pools to check (default 100)
   * - dryRun: if 'true', only report what would be updated without changing caches
   */
  api.post('/arb/pools/validate-bitmap-extensions', async (req, res) => {
    try {
      const { validateAndRefreshBitmapExtensions } = await import('../../execution/cacheValidator.js');
      const { getConnection } = await import('../../wallet/wallet.js');
      const connection = getConnection();
      
      const limit = Number(req.query.limit) || 100;
      const dryRun = req.query.dryRun === 'true';
      
      const result = await validateAndRefreshBitmapExtensions(connection, { limit, dryRun });
      
      return res.json({
        success: true,
        message: dryRun 
          ? `Dry run: ${result.poolsNeedingUpdate} pools would be updated`
          : `Updated ${result.poolsUpdated} of ${result.poolsNeedingUpdate} pools needing update`,
        totalPools: result.totalPools,
        poolsChecked: result.poolsChecked,
        poolsWithPdaOnChain: result.poolsWithPdaOnChain,
        poolsNeedingUpdate: result.poolsNeedingUpdate,
        poolsUpdated: result.poolsUpdated,
        poolsSkipped: result.poolsSkipped,
        dryRun,
        durationMs: result.durationMs,
        // Include details for pools that needed updates
        updatedPools: result.results
          .filter(r => r.wasUpdated || r.issue?.includes('Would update'))
          .map(r => ({
            poolId: r.poolId,
            previousValue: r.previousValue?.slice(0, 8) + '...',
            newValue: r.newValue?.slice(0, 8) + '...',
            pdaExistsOnChain: r.pdaExistsOnChain,
          })),
      });
    } catch (e: any) {
      logger.error('bitmap extension validation failed', { error: String(e?.message || e) });
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  /**
   * POST /arb/pools/validate-bitmap-extension/:poolId
   * Validate and refresh a single pool's bitmap extension.
   * Useful for just-in-time validation before a swap.
   */
  api.post('/arb/pools/validate-bitmap-extension/:poolId', async (req, res) => {
    try {
      const { validatePoolBitmapExtension } = await import('../../execution/cacheValidator.js');
      const { getConnection } = await import('../../wallet/wallet.js');
      const connection = getConnection();
      
      const poolId = req.params.poolId;
      if (!poolId) {
        return res.status(400).json({ error: 'poolId is required' });
      }
      
      const result = await validatePoolBitmapExtension(connection, poolId);
      
      return res.json({
        success: true,
        poolId: result.poolId,
        previousValue: result.previousValue,
        newValue: result.newValue,
        derivedPda: result.derivedPda,
        pdaExistsOnChain: result.pdaExistsOnChain,
        wasUpdated: result.wasUpdated,
        issue: result.issue,
      });
    } catch (e: any) {
      logger.error('single bitmap extension validation failed', { error: String(e?.message || e) });
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  return api;
}


