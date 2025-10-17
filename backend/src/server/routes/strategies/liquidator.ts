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
      let name = String(cfg?.name || '').trim();
      if (!name) {
        const keyIn = String(cfg?.key || '').trim();
        if (keyIn) {
          // accept liq#<name> or raw name
          name = keyIn.startsWith('liq#') ? keyIn.slice(4) : keyIn;
        }
      }
      if (!name) return res.status(400).json({ error: 'name is required' });
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      DriftLiquidatorRegistry.upsert({
        name,
        enabled: true,
        pollMs: cfg?.pollMs,
        maxConcurrentTargets: cfg?.maxConcurrentTargets,
        dryRun: cfg?.dryRun,
        subaccountId: cfg?.subaccountId,
        maxAttemptNotional: cfg?.maxAttemptNotional,
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
      const key = (DriftLiquidatorRegistry as any).keyOf({ name });
      // Start asynchronously to avoid proxy timeouts; report status via logs/socket
      setImmediate(async () => {
        try {
          const existing = (DriftLiquidatorRegistry as any).get?.(key);
          if (!existing || !existing.getStatus?.().running) {
            await DriftLiquidatorRegistry.start(key);
          }
          emit('log', { level: 'info', message: `drift: liquidator started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
        } catch (e: any) {
          logger.error('drift-liq: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: liquidator start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
        }
      });
      res.status(202).json({ ok: true, key, starting: true });
    } catch (e: any) {
      logger.error('drift-liq: start failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/stop', async (req: Request, res: Response) => {
    try {
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.keyOf({ name });
      }
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
      const body = req.body as { key?: string; name?: string };
      let key = String(body?.key || '').trim();
      if (!key) {
        const name = String(body?.name || '').trim();
        if (name) key = (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.keyOf({ name });
      }
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
      const name = String(cfg?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const key = (DriftLiquidatorRegistry as any).keyOf({ name });
      // Perform update and restart asynchronously to avoid request timeouts
      setImmediate(async () => {
        try {
          try { await DriftLiquidatorRegistry.stop(key); } catch {}
          try { DriftLiquidatorRegistry.remove(key); } catch {}
          DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name, enabled: true } as any);
          try { await DriftLiquidatorRegistry.start(key); } catch {}
          emit('log', { level: 'info', message: `drift: liquidator updated ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
        } catch (e: any) {
          logger.error('drift-liq: update async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: liquidator update failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
        }
      });
      res.status(202).json({ ok: true, key, updating: true });
    } catch (e: any) {
      logger.error('drift-liq: update failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Trigger a one-off test liquidation attempt for a specific user under a given liquidator
  api.post('/strategies/liquidator/test', async (req: Request, res: Response) => {
    try {
      const { key, userPk } = req.body as { key?: string; userPk?: string };
      if (!key) return res.status(400).json({ error: 'key is required' });
      if (!userPk) return res.status(400).json({ error: 'userPk is required' });
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.get(String(key));
      if (!runner) return res.status(404).json({ error: 'liquidator not found' });
      const ok = await (runner as any).testTarget?.(String(userPk));
      res.json({ ok: !!ok });
    } catch (e: any) {
      logger.error('drift-liq: test failed', { error: String(e?.message || e) });
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
      const name = String(cfg?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const key = (DriftLiquidatorRegistry as any).keyOf({ name });
      try { await DriftLiquidatorRegistry.stop(key); } catch {}
      try { DriftLiquidatorRegistry.remove(key); } catch {}
      DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name, enabled: !!cfg?.enabled } as any);
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: set config failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/strategies/liquidator/queue', async (req: Request, res: Response) => {
    try {
      const key = String(req.query?.key || '').trim();
      const limit = Number(req.query?.limit || 25);
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      if (!key) return res.status(400).json({ error: 'key is required', queue: null });
      const runner = DriftLiquidatorRegistry.get(key);
      if (!runner) return res.json({ queue: null });
      const snapshot = (runner as any).getQueueSnapshot?.(Number.isFinite(limit) ? limit : 25);
      res.json({ queue: snapshot });
    } catch (e: any) {
      logger.error('drift-liq: queue failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


