import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';

export function createGraphRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/graph', async (_req, res) => {
    try {
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(false);
      // Support lite view via query param
      try {
        const reqAny = _req as any;
        const lite = String(reqAny?.query?.lite || '') === '1';
        if (lite) {
          const { toLiteSnapshot } = await import('../graph.js');
          return res.json(toLiteSnapshot(snap) as any);
        }
      } catch {}
      res.json(snap);
    } catch (e: any) {
      logger.error('graph snapshot failed', { error: String(e?.message || e) });
      res.status(500).json({ version: 0, timestamp: Date.now(), nodes: [], edges: [] });
    }
  });

  api.get('/graph/path', async (req, res) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string };
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });
      const { findPath } = await import('../graph.js');
      const { path } = await findPath(from, to);
      res.json({ path });
    } catch (e: any) {
      res.status(500).json({ path: [] });
    }
  });

  // Runtime-only: drop a pool from the graph by id (forward and reverse). Not persisted.
  api.post('/graph/drop', async (req, res) => {
    try {
      const body = (req as any)?.body || {};
      const id = String(body?.id || body?.poolId || '').trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      const { dropPoolRuntime, rebuildGraphNow } = await import('../graph.js');
      const result = dropPoolRuntime(id);
      // Trigger a rebuild to apply removal immediately
      await rebuildGraphNow(undefined);
      return res.json({ ok: true, dropped: id, added: result.added, total: result.current.length });
    } catch (e: any) {
      try { logger.error('graph.drop failed', { error: String(e?.message || e) }); } catch {}
      return res.status(500).json({ error: 'failed' });
    }
  });

  // Return full edge details for selected edges by ids and/or pairs
  api.post('/graph/edge-details', async (req, res) => {
    try {
      const body = (req as any)?.body || {};
      const ids: string[] = Array.isArray(body?.ids) ? (body.ids as any[]).map((x) => String(x)).filter(Boolean) : [];
      const pairs: Array<{ source: string; target: string; dex?: string }> = Array.isArray(body?.pairs)
        ? (body.pairs as any[]).map((p) => ({ source: String(p?.source||''), target: String(p?.target||''), dex: p?.dex ? String(p.dex) : '' }))
        : [];
      const wantIds = new Set(ids);
      const matchPair = (e: any) => pairs.some((p) => e.source === p.source && e.target === p.target && (!p.dex || e.dex === p.dex));
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(false);
      const edges = (snap?.edges || []).filter((e: any) => wantIds.has(String(e?.id)) || matchPair(e));
      res.json({ edges });
    } catch (e: any) {
      res.status(500).json({ edges: [] });
    }
  });

  return api;
}


