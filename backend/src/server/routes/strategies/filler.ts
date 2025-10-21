import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createFillerRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/strategies/filler/status', async (_req: Request, res: Response) => {
    try {
      const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
      const list = DriftFillerRegistry.list();
      res.json({ fillers: list });
    } catch (e: any) {
      logger.error('drift-filler: status failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Metrics endpoint (1m window by default)
  api.get('/strategies/filler/metrics', async (req: Request, res: Response) => {
    try {
      const windowMs = Number.isFinite(Number(req.query.windowMs)) ? Number(req.query.windowMs) : 60_000;
      const bot = String(req.query.bot || '').trim() || undefined;
      const { getMetrics } = await import('../../../drift/txTracker.js');
      const m = getMetrics({ windowMs, action: 'fill', bot });
      res.json({ windowMs, bot, ...m });
    } catch (e: any) {
      logger.error('drift-filler: metrics failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/filler/start', async (req: Request, res: Response) => {
    try {
      const cfg = (req.body || {}) as any;
      const name = String(cfg?.name || '').trim() || 'default';
      const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
      DriftFillerRegistry.upsert({
        name,
        enabled: true,
        dryRun: !!cfg?.dryRun,
        subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : undefined,
        intervalMs: Math.max(200, Number(cfg?.intervalMs ?? 300)),
        cuLimit: Math.max(220_000, Math.min(800_000, Number(cfg?.cuLimit ?? 600_000))),
        priorityFeeMicroLamports: Math.max(0, Number(cfg?.priorityFeeMicroLamports ?? 15_000)),
        marketsAllowlist: Array.isArray(cfg?.marketsAllowlist)
          ? cfg.marketsAllowlist : (typeof cfg?.marketsAllowlistCsv === 'string'
            ? String(cfg?.marketsAllowlistCsv).split(',').map((s: string) => Number(s.trim())).filter((n: any) => Number.isFinite(n))
            : undefined),
        maxMakersPerFill: Math.max(0, Number(cfg?.maxMakersPerFill ?? 1)),
        allowAmmFills: (cfg?.allowAmmFills === undefined ? true : !!cfg?.allowAmmFills),
      } as any);
      const key = (DriftFillerRegistry as any).keyOf({ name });
      setImmediate(async () => {
        try {
          const existing = (DriftFillerRegistry as any).get?.(key);
          if (!existing || !existing.getStatus?.().running) {
            await DriftFillerRegistry.start(key);
          }
          emit('log', { level: 'info', message: `drift: filler started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
          try {
            const listNow = (DriftFillerRegistry as any).list?.();
            _io.emit('filler-update', { fillers: listNow });
          } catch {}
        } catch (e: any) {
          logger.error('drift-filler: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: filler start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
        }
      });
      res.status(202).json({ ok: true, key, starting: true });
    } catch (e: any) {
      logger.error('drift-filler: start failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/filler/stop', async (req: Request, res: Response) => {
    try {
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.keyOf({ name });
      }
      const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
      const ok = await DriftFillerRegistry.stop(key);
      try {
        const listNow = (DriftFillerRegistry as any).list?.();
        _io.emit('filler-update', { fillers: listNow });
      } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-filler: stop failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/filler/remove', async (req: Request, res: Response) => {
    try {
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.keyOf({ name });
      }
      const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
      const ok = await DriftFillerRegistry.remove(key);
      try {
        const listNow = (DriftFillerRegistry as any).list?.();
        _io.emit('filler-update', { fillers: listNow });
      } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-filler: remove failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


