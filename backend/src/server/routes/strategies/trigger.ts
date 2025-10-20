import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createTriggerRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/strategies/trigger/status', async (_req: Request, res: Response) => {
    try {
      const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
      const list = DriftTriggerRegistry.list();
      res.json({ triggers: list });
    } catch (e: any) {
      logger.error('drift-trigger: status failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/trigger/start', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      let name = String(cfg?.name || '').trim();
      if (!name) {
        const keyIn = String(cfg?.key || '').trim();
        if (keyIn) name = keyIn.startsWith('trg#') ? keyIn.slice(4) : keyIn;
      }
      if (!name) return res.status(400).json({ error: 'name is required' });
      const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');

      const marketsAllowlist: number[] | undefined = Array.isArray(cfg?.marketsAllowlist)
        ? (cfg?.marketsAllowlist as any[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : (typeof cfg?.marketsAllowlistCsv === 'string'
            ? String(cfg?.marketsAllowlistCsv)
                .split(',')
                .map((s: string) => Number(s.trim()))
                .filter((n: any) => Number.isFinite(n))
            : undefined);

      DriftTriggerRegistry.upsert({
        name,
        enabled: true,
        dryRun: !!cfg?.dryRun,
        subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : undefined,
        intervalMs: Number.isFinite(Number(cfg?.intervalMs)) ? Number(cfg?.intervalMs) : undefined,
        cuLimit: Number.isFinite(Number(cfg?.cuLimit)) ? Number(cfg?.cuLimit) : undefined,
        priorityFeeMicroLamports: Number.isFinite(Number(cfg?.priorityFeeMicroLamports)) ? Number(cfg?.priorityFeeMicroLamports) : undefined,
        marketsAllowlist,
      });

      const key = (DriftTriggerRegistry as any).keyOf({ name });
      setImmediate(async () => {
        try {
          const existing = (DriftTriggerRegistry as any).get?.(key);
          if (!existing || !existing.getStatus?.().running) {
            await DriftTriggerRegistry.start(key);
          }
          emit('log', { level: 'info', message: `drift: trigger started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
        } catch (e: any) {
          logger.error('drift-trigger: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: trigger start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
        }
      });

      res.status(202).json({ ok: true, key, starting: true });
    } catch (e: any) {
      logger.error('drift-trigger: start failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/trigger/stop', async (req: Request, res: Response) => {
    try {
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.keyOf({ name });
      }
      const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
      const ok = await DriftTriggerRegistry.stop(key);
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-trigger: stop failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/trigger/remove', async (req: Request, res: Response) => {
    try {
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.keyOf({ name });
      }
      const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
      const ok = await DriftTriggerRegistry.remove(key);
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-trigger: remove failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/trigger/update', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const name = String(cfg?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
      const key = (DriftTriggerRegistry as any).keyOf({ name });
      setImmediate(async () => {
        try {
          try { await DriftTriggerRegistry.stop(key); } catch {}
          try { DriftTriggerRegistry.remove(key); } catch {}

          const marketsAllowlist: number[] | undefined = Array.isArray(cfg?.marketsAllowlist)
            ? (cfg?.marketsAllowlist as any[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
            : (typeof cfg?.marketsAllowlistCsv === 'string'
                ? String(cfg?.marketsAllowlistCsv)
                    .split(',')
                    .map((s: string) => Number(s.trim()))
                    .filter((n: any) => Number.isFinite(n))
                : undefined);

          DriftTriggerRegistry.upsert({
            name,
            enabled: true,
            dryRun: !!cfg?.dryRun,
            subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : undefined,
            intervalMs: Number.isFinite(Number(cfg?.intervalMs)) ? Number(cfg?.intervalMs) : undefined,
            cuLimit: Number.isFinite(Number(cfg?.cuLimit)) ? Number(cfg?.cuLimit) : undefined,
            priorityFeeMicroLamports: Number.isFinite(Number(cfg?.priorityFeeMicroLamports)) ? Number(cfg?.priorityFeeMicroLamports) : undefined,
            marketsAllowlist,
          });
          try { await DriftTriggerRegistry.start(key); } catch {}
          emit('log', { level: 'info', message: `drift: trigger updated ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
        } catch (e: any) {
          logger.error('drift-trigger: update async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: trigger update failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
        }
      });
      res.status(202).json({ ok: true, key, updating: true });
    } catch (e: any) {
      logger.error('drift-trigger: update failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


