import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createTriggerRouter(_io: SocketIOServer): Router {
  const api = Router();
  const useManager = String(process.env.DRIFT_BOTS_MANAGER || '') === '1';

  api.get('/strategies/trigger/status', async (_req: Request, res: Response) => {
    try {
      let list: any[] = [];
      if (useManager) {
        const { listBotsFresh } = await import('../../../drift/botsManager.js');
        list = await listBotsFresh('trigger');
      } else {
        const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
        list = DriftTriggerRegistry.list();
      }
      res.json({ triggers: list });
    } catch (e: any) {
      logger.error('drift-trigger: status failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Metrics endpoint (1m window by default)
  api.get('/strategies/trigger/metrics', async (req: Request, res: Response) => {
    try {
      const windowMs = Number.isFinite(Number(req.query.windowMs)) ? Number(req.query.windowMs) : 60_000;
      const bot = String(req.query.bot || '').trim() || undefined;
      if (useManager) {
        if (!bot) return res.json({ windowMs, bot, total: 0, byBot: {} });
        const { getMetrics } = await import('../../../drift/botsManager.js');
        const m = await getMetrics('trigger', bot, windowMs);
        return res.json(m || { windowMs, bot, total: 0, byBot: {} });
      }
      const { getMetrics: getMetricsLocal } = await import('../../../drift/txTracker.js');
      const m = getMetricsLocal({ windowMs, action: 'trigger', bot });
      return res.json({ windowMs, bot, ...m });
    } catch (e: any) {
      logger.error('drift-trigger: metrics failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
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
      const { DriftTriggerRegistry } = useManager ? ({ DriftTriggerRegistry: null } as any) : await import('../../../drift/triggerRunner.js');

      const marketsAllowlist: number[] | undefined = Array.isArray(cfg?.marketsAllowlist)
        ? (cfg?.marketsAllowlist as any[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : (typeof cfg?.marketsAllowlistCsv === 'string'
            ? String(cfg?.marketsAllowlistCsv)
                .split(',')
                .map((s: string) => Number(s.trim()))
                .filter((n: any) => Number.isFinite(n))
            : undefined);

      const nextCfg = {
        name,
        enabled: true,
        dryRun: !!cfg?.dryRun,
        subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : undefined,
        intervalMs: Number.isFinite(Number(cfg?.intervalMs)) ? Number(cfg?.intervalMs) : undefined,
        cuLimit: Number.isFinite(Number(cfg?.cuLimit)) ? Number(cfg?.cuLimit) : undefined,
        priorityFeeMicroLamports: Number.isFinite(Number(cfg?.priorityFeeMicroLamports)) ? Number(cfg?.priorityFeeMicroLamports) : undefined,
        marketsAllowlist,
      };
      let key = `trg#${name}`;
      if (useManager) {
        const { startBot } = await import('../../../drift/botsManager.js');
        const out = await startBot('trigger', nextCfg);
        key = out?.key || key;
      } else {
        DriftTriggerRegistry.upsert(nextCfg);
        key = (DriftTriggerRegistry as any).keyOf({ name });
      }
      
      // Emit immediate update to show "starting" state in UI
      try {
        const listNow = (DriftTriggerRegistry as any).list?.();
        logger.info('drift.trigger.emit_immediate', { triggerCount: listNow?.length ?? 0, cat: 'drift' });
        _io.emit('trigger-update', { triggers: listNow });
      } catch (emitErr: any) {
        logger.warn('drift.trigger.emit_immediate_failed', { error: String(emitErr?.message || emitErr), cat: 'drift' });
      }
      
      setImmediate(async () => {
        try {
          if (!useManager) {
            const existing = (DriftTriggerRegistry as any).get?.(key);
            if (!existing || !existing.getStatus?.().running) {
              await DriftTriggerRegistry.start(key);
            }
          }
          emit('log', { level: 'info', message: `drift: trigger started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('trigger')
              : (DriftTriggerRegistry as any).list?.();
            logger.info('drift.trigger.emit_after_start', { triggerCount: listNow?.length ?? 0, name, cat: 'drift' });
            _io.emit('trigger-update', { triggers: listNow });
          } catch (emitErr: any) {
            logger.warn('drift.trigger.emit_after_start_failed', { error: String(emitErr?.message || emitErr), cat: 'drift' });
          }
        } catch (e: any) {
          logger.error('drift-trigger: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: trigger start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('trigger')
              : (DriftTriggerRegistry as any).list?.();
            _io.emit('trigger-update', { triggers: listNow });
          } catch {}
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
        if (name) {
          key = useManager ? `trg#${name}` : (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.keyOf({ name });
        }
      }
      let ok = false;
      if (useManager) {
        const { stopBot } = await import('../../../drift/botsManager.js');
        ok = await stopBot(key);
      } else {
        const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
        ok = await DriftTriggerRegistry.stop(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('trigger')
          : (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.list?.();
        _io.emit('trigger-update', { triggers: listNow });
      } catch {}
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
        if (name) {
          key = useManager ? `trg#${name}` : (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.keyOf({ name });
        }
      }
      let ok = false;
      if (useManager) {
        const { removeBot } = await import('../../../drift/botsManager.js');
        ok = await removeBot(key);
      } else {
        const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
        ok = await DriftTriggerRegistry.remove(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('trigger')
          : (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.list?.();
        _io.emit('trigger-update', { triggers: listNow });
      } catch {}
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
      const key = useManager ? `trg#${name}` : (await import('../../../drift/triggerRunner.js') as any).DriftTriggerRegistry.keyOf({ name });
      setImmediate(async () => {
        try {
          if (useManager) {
            const { stopBot, removeBot, startBot } = await import('../../../drift/botsManager.js');
            try { await stopBot(key); } catch {}
            try { await removeBot(key); } catch {}
            const marketsAllowlist: number[] | undefined = Array.isArray(cfg?.marketsAllowlist)
              ? (cfg?.marketsAllowlist as any[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
              : (typeof cfg?.marketsAllowlistCsv === 'string'
                  ? String(cfg?.marketsAllowlistCsv)
                      .split(',')
                      .map((s: string) => Number(s.trim()))
                      .filter((n: any) => Number.isFinite(n))
                  : undefined);
            await startBot('trigger', {
              name,
              enabled: true,
              dryRun: !!cfg?.dryRun,
              subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : undefined,
              intervalMs: Number.isFinite(Number(cfg?.intervalMs)) ? Number(cfg?.intervalMs) : undefined,
              cuLimit: Number.isFinite(Number(cfg?.cuLimit)) ? Number(cfg?.cuLimit) : undefined,
              priorityFeeMicroLamports: Number.isFinite(Number(cfg?.priorityFeeMicroLamports)) ? Number(cfg?.priorityFeeMicroLamports) : undefined,
              marketsAllowlist,
            });
          } else {
            const { DriftTriggerRegistry } = await import('../../../drift/triggerRunner.js');
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
          }
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


