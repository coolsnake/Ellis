import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createFillerRouter(_io: SocketIOServer): Router {
  const api = Router();
  const useManager = String(process.env.DRIFT_BOTS_MANAGER || '') === '1';

  api.get('/strategies/filler/status', async (_req: Request, res: Response) => {
    try {
      let list: any[] = [];
      if (useManager) {
        const { listBotsFresh } = await import('../../../drift/botsManager.js');
        list = await listBotsFresh('filler');
      } else {
        const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
        list = DriftFillerRegistry.list();
      }
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
      if (useManager) {
        if (!bot) return res.json({ windowMs, bot, total: 0, byBot: {} });
        const { getMetrics } = await import('../../../drift/botsManager.js');
        const m = await getMetrics('filler', bot, windowMs);
        return res.json(m || { windowMs, bot, total: 0, byBot: {} });
      }
      const { getMetrics: getMetricsLocal } = await import('../../../drift/txTracker.js');
      const m = getMetricsLocal({ windowMs, action: 'fill', bot });
      return res.json({ windowMs, bot, ...m });
    } catch (e: any) {
      logger.error('drift-filler: metrics failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/filler/start', async (req: Request, res: Response) => {
    try {
      const cfg = (req.body || {}) as any;
      const name = String(cfg?.name || '').trim() || 'default';
      const nextCfg = {
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
        // NEW heuristics
        skipYoungOrderMs: Math.max(0, Number(cfg?.skipYoungOrderMs ?? 0)),
        requireExistingMakers: (cfg?.requireExistingMakers === undefined ? true : !!cfg?.requireExistingMakers),
        minMakerCountPerNode: Math.max(0, Number(cfg?.minMakerCountPerNode ?? 1)),
        denyJitTakersTtlMs: Math.max(0, Number(cfg?.denyJitTakersTtlMs ?? 15000)),
        minTipFloorToAttemptLamports: Math.max(0, Number(cfg?.minTipFloorToAttemptLamports ?? 0)),
        // Profitability / sizing gates
        minNotionalQuote: Math.max(0, Number(cfg?.minNotionalQuote ?? 0)),
        minRemainingBase: Math.max(0, Number(cfg?.minRemainingBase ?? 0)),
        rewardShare: Math.max(0, Math.min(1, Number(cfg?.rewardShare ?? 0.5))),
        minRewardQuote: Math.max(0, Number(cfg?.minRewardQuote ?? 0)),
        minProfitQuote: Math.max(0, Number(cfg?.minProfitQuote ?? 0)),
        minRewardToCostRatio: Math.max(0, Number(cfg?.minRewardToCostRatio ?? 0)),
        maxCandidatesPerLoop: Math.max(0, Number(cfg?.maxCandidatesPerLoop ?? 0)),
        rankBy: (typeof cfg?.rankBy === 'string' ? String(cfg.rankBy) : undefined),
        // Prebuild controls
        prebuildEnabled: (cfg?.prebuildEnabled === undefined ? true : !!cfg?.prebuildEnabled),
        prebuildDistanceBps: Math.max(0, Number(cfg?.prebuildDistanceBps ?? 10)),
        prebuildTtlMs: Math.max(0, Number(cfg?.prebuildTtlMs ?? 1500)),
        prebuildMaxCandidates: Math.max(0, Number(cfg?.prebuildMaxCandidates ?? 50)),
        prebuildMaxInFlight: Math.max(0, Number(cfg?.prebuildMaxInFlight ?? 2)),
        prebuildPerLoop: Math.max(0, Number(cfg?.prebuildPerLoop ?? 2)),
      } as any;
      let key = `fil#${name}`;
      let DriftFillerRegistry: any = null;
      if (useManager) {
        const { startBot } = await import('../../../drift/botsManager.js');
        const out = await startBot('filler', nextCfg);
        key = out?.key || key;
      } else {
        DriftFillerRegistry = (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry;
        DriftFillerRegistry.upsert(nextCfg);
        key = (DriftFillerRegistry as any).keyOf({ name });
      }
      
      // Emit immediate update to show "starting" state in UI
      try {
        const listNow = (DriftFillerRegistry as any).list?.();
        logger.info('drift.filler.emit_immediate', { fillerCount: listNow?.length ?? 0, cat: 'drift' });
        _io.emit('filler-update', { fillers: listNow });
      } catch (emitErr: any) {
        logger.warn('drift.filler.emit_immediate_failed', { error: String(emitErr?.message || emitErr), cat: 'drift' });
      }
      
      setImmediate(async () => {
        try {
          if (!useManager) {
            const existing = (DriftFillerRegistry as any).get?.(key);
            if (!existing || !existing.getStatus?.().running) {
              await DriftFillerRegistry.start(key);
            }
          }
          emit('log', { level: 'info', message: `drift: filler started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('filler')
              : (DriftFillerRegistry as any).list?.();
            _io.emit('filler-update', { fillers: listNow });
          } catch {}
        } catch (e: any) {
          logger.error('drift-filler: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: filler start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('filler')
              : (DriftFillerRegistry as any).list?.();
            _io.emit('filler-update', { fillers: listNow });
          } catch {}
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
        if (name) key = useManager ? `fil#${name}` : (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.keyOf({ name });
      }
      let ok = false;
      if (useManager) {
        const { stopBot } = await import('../../../drift/botsManager.js');
        ok = await stopBot(key);
      } else {
        const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
        ok = await DriftFillerRegistry.stop(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('filler')
          : (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.list?.();
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
        if (name) key = useManager ? `fil#${name}` : (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.keyOf({ name });
      }
      let ok = false;
      if (useManager) {
        const { removeBot } = await import('../../../drift/botsManager.js');
        ok = await removeBot(key);
      } else {
        const { DriftFillerRegistry } = await import('../../../drift/fillerRunner.js');
        ok = await DriftFillerRegistry.remove(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('filler')
          : (await import('../../../drift/fillerRunner.js') as any).DriftFillerRegistry.list?.();
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


