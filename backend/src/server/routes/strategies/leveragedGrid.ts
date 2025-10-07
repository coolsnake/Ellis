import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../../utils/config.js';
import { emit } from '../../realtime.js';
import { getStrategies } from '../../../utils/strategies.js';
import { logger } from '../../../utils/logger.js';

export function createLeveragedGridRouter(io: SocketIOServer): Router {
  const api = Router();

  api.get('/strategies/leveraged-grid/status', async (_req: Request, res: Response) => {
    try {
      const { DriftGridRegistry } = await import('../../../drift/execution.js');
      const list = DriftGridRegistry.list();
      res.json({ strategies: list });
    } catch (e: any) {
      logger.error('drift-grid: status failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/start', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftGridRegistry } = await import('../../../drift/execution.js');
      const runner = DriftGridRegistry.upsert(cfg);
      const key = (DriftGridRegistry as any).keyOf(cfg);
      await DriftGridRegistry.start(key, (CONFIG as any).system?.targetTickTimeMs || 1500);
      emit('log', { level: 'info', message: `drift: grid started ${cfg?.name || key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-grid: start failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/stop', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftGridRegistry } = await import('../../../drift/execution.js');
      const ok = DriftGridRegistry.remove(key);
      if (ok) emit('log', { level: 'info', message: `drift: grid removed ${key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-grid: stop failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/update', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftGridRegistry } = await import('../../../drift/execution.js');
      const key = (DriftGridRegistry as any).keyOf(cfg);
      try { DriftGridRegistry.remove(key); } catch {}
      const runner = DriftGridRegistry.upsert(cfg);
      await DriftGridRegistry.start(key, (CONFIG as any).system?.targetTickTimeMs || 1500);
      emit('log', { level: 'info', message: `drift-grid: updated ${cfg?.name || key}`, timestamp: new Date().toISOString(), context: { cat: 'strategy' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-grid: update failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


