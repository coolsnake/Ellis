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
      const prevAnchors = Array.isArray((CONFIG.raydium as any)?.anchorMints) ? ([...((CONFIG.raydium as any).anchorMints as string[])]) : undefined;
      const prevUseAnchor = (CONFIG.raydium as any)?.useAnchorDiscovery;
      let restore = false;
      try {
        if (q.minAmm != null) { (CONFIG.raydium as any).minAmmLiqBase = Math.max(0, Number(q.minAmm)); restore = true; }
        if (q.minClmm != null) { (CONFIG.raydium as any).minClmmLiquidity = Math.max(0, Number(q.minClmm)); restore = true; }
        if (typeof q.anchor === 'string' && q.anchor.trim()) {
          const list = q.anchor.split(',').map(s => s.trim()).filter(Boolean);
          if (list.length) { (CONFIG.raydium as any).anchorMints = list; (CONFIG.raydium as any).useAnchorDiscovery = true; restore = true; }
        }
      } catch {}
      const { getRaydiumPoolsNormalized } = await import('../pools.js');
      const pools = await getRaydiumPoolsNormalized(false);
      try { if (restore) { (CONFIG.raydium as any).minAmmLiqBase = prevAmm; (CONFIG.raydium as any).minClmmLiquidity = prevClmm; if (prevAnchors) (CONFIG.raydium as any).anchorMints = prevAnchors; if (prevUseAnchor !== undefined) (CONFIG.raydium as any).useAnchorDiscovery = prevUseAnchor; } } catch {}
      let out = pools;
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

  api.get('/arb/pools/orca', async (_req, res) => {
    try {
      const { getOrcaPoolsCached } = await import('../pools.js');
      const pools = await getOrcaPoolsCached(false);
      let out = pools;
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

  api.get('/arb/pools/meteora', async (_req, res) => {
    try {
      const { getMeteoraPoolsCached } = await import('../pools.js');
      const pools = await getMeteoraPoolsCached(false);
      res.json(pools);
    } catch (e: any) {
      logger.error('meteora pools fetch failed', { error: String(e?.message || e) });
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
      const { refreshAllSources } = await import('../pools.js');
      const { getGraphSnapshot } = await import('../graph.js');
      const { enablePoolWebsocketRefreshes, getWsActivity, getPoolCacheAges } = await import('../pools.js');
      const out = await refreshAllSources(!!cfg.force, !!cfg.subscribe);
      const snap = await getGraphSnapshot(true);
      const ws = getWsActivity();
      const ages = getPoolCacheAges();
      res.json({ ok: true, counts: { raydium: out.raydium, orca: out.orca, meteora: out.meteora }, graph: { nodes: (snap.nodes || []).length, edges: (snap.edges || []).length }, ws, ages });
      emit('log', { level: 'info', message: 'pools:refresh triggered', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/subscribe', async (_req, res) => {
    try {
      const { enablePoolWebsocketRefreshes, startRaydiumRefreshLoop } = await import('../pools.js');
      enablePoolWebsocketRefreshes();
      startRaydiumRefreshLoop();
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
      const { getPoolWsStatus, getWsActivity } = await import('../pools.js');
      const st = getPoolWsStatus();
      const ws = getWsActivity();
      res.json({ wsEnabled: st.enabled, wsHealthy: st.healthy, lastEventMs: st.lastEventMs, ws });
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

  return api;
}


