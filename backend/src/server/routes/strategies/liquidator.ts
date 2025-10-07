import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createLiquidatorRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/strategies/liquidator/status', async (_req: Request, res: Response) => {
    try {
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const list = DriftLiquidatorRegistry.list();
      res.json({ liquidators: list });
    } catch (e: any) {
      logger.error('drift-liq: status failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/start', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.upsert({
        name: cfg?.name || 'default',
        enabled: true,
        pollMs: cfg?.pollMs,
        maxConcurrentTargets: cfg?.maxConcurrentTargets,
        dryRun: cfg?.dryRun,
        discoverAllUsers: cfg?.discoverAllUsers,
        maxDiscoveredUsers: cfg?.maxDiscoveredUsers,
        usersAllowlist: Array.isArray(cfg?.usersAllowlist) ? cfg?.usersAllowlist : (typeof cfg?.usersAllowlistCsv === 'string' ? String(cfg?.usersAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        scanConcurrency: cfg?.scanConcurrency,
        userCacheMax: cfg?.userCacheMax,
        riskHealthThreshold: cfg?.riskHealthThreshold,
        usePriceTriggers: cfg?.usePriceTriggers,
        priceTriggerDebounceMs: cfg?.priceTriggerDebounceMs,
        httpPollMs: cfg?.httpPollMs,
        maxUsersPerPriceTick: cfg?.maxUsersPerPriceTick,
        marketsAllowlist: Array.isArray(cfg?.marketsAllowlist) ? cfg?.marketsAllowlist : (typeof cfg?.marketsAllowlistCsv === 'string' ? String(cfg?.marketsAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        marketIndices: Array.isArray(cfg?.marketIndices) ? cfg?.marketIndices : (typeof cfg?.marketIndicesCsv === 'string' ? String(cfg?.marketIndicesCsv).split(',').map((s: string) => Number(s.trim())).filter((n: any) => Number.isFinite(n)) : undefined),
        maxCancels: cfg?.maxCancels,
        maxPerpAttempts: cfg?.maxPerpAttempts,
        perpSizeFraction: cfg?.perpSizeFraction,
        maxSpotAttempts: cfg?.maxSpotAttempts,
        spotSizeFraction: cfg?.spotSizeFraction,
        targetCooldownMs: cfg?.targetCooldownMs,
        statsIntervalMs: cfg?.statsIntervalMs,
      } as any);
      const key = (DriftLiquidatorRegistry as any).keyOf(cfg?.name ? { name: cfg.name } : { name: 'default' });
      await DriftLiquidatorRegistry.start(key);
      emit('log', { level: 'info', message: `drift: liquidator started ${cfg?.name || key}` , timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: start failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/stop', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const ok = await DriftLiquidatorRegistry.stop(key);
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-liq: stop failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/remove', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const ok = await DriftLiquidatorRegistry.remove(key);
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-liq: remove failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/update', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const key = (DriftLiquidatorRegistry as any).keyOf(cfg?.name ? { name: cfg.name } : { name: 'default' });
      // emulate update: stop, remove, upsert, start
      try { await DriftLiquidatorRegistry.stop(key); } catch {}
      try { DriftLiquidatorRegistry.remove(key); } catch {}
      const runner = DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name: cfg?.name || 'default', enabled: true } as any);
      try { await DriftLiquidatorRegistry.start(key); } catch {}
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: update failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/strategies/liquidator/config', async (_req: Request, res: Response) => {
    try {
      // placeholder: no global config store exposed; return status list
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const list = DriftLiquidatorRegistry.list();
      res.json({ liquidators: list });
    } catch (e: any) {
      logger.error('drift-liq: get config failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/config', async (req: Request, res: Response) => {
    try {
      // placeholder: no global config setter; emulate by update on default key
      const cfg = req.body as any;
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const key = (DriftLiquidatorRegistry as any).keyOf(cfg?.name ? { name: cfg.name } : { name: 'default' });
      try { await DriftLiquidatorRegistry.stop(key); } catch {}
      try { DriftLiquidatorRegistry.remove(key); } catch {}
      DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name: cfg?.name || 'default', enabled: !!cfg?.enabled } as any);
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: set config failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/strategies/liquidator/queue', async (req: Request, res: Response) => {
    try {
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const list = DriftLiquidatorRegistry.list();
      res.json({ liquidators: list });
    } catch (e: any) {
      logger.error('drift-liq: queue failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


