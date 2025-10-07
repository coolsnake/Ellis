import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';

export function createGraphRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/graph', async (_req, res) => {
    try {
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(false);
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

  return api;
}


