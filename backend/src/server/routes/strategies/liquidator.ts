import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../../realtime.js';
import { logger } from '../../../utils/logger.js';

export function createLiquidatorRouter(_io: SocketIOServer): Router {
  const api = Router();
  const useManager = String(process.env.DRIFT_BOTS_MANAGER || '') === '1';

  api.get('/strategies/liquidator/status', async (_req: Request, res: Response) => {
    try {
      let list: any[] = [];
      if (useManager) {
        const { listBotsFresh } = await import('../../../drift/botsManager.js');
        list = await listBotsFresh('liquidator');
      } else {
        const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
        list = DriftLiquidatorRegistry.list();
      }
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
      const nextCfg = {
        name,
        enabled: true,
        pollMs: cfg?.pollMs,
        maxConcurrentTargets: cfg?.maxConcurrentTargets,
        dryRun: cfg?.dryRun,
        subaccountId: cfg?.subaccountId,
        executeHealthThreshold: cfg?.executeHealthThreshold,
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
      } as any;
      let key = `liq#${name}`;
      let DriftLiquidatorRegistry: any = null;
      if (useManager) {
        const { startBot } = await import('../../../drift/botsManager.js');
        const out = await startBot('liquidator', nextCfg);
        key = out?.key || key;
      } else {
        DriftLiquidatorRegistry = (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry;
        DriftLiquidatorRegistry.upsert(nextCfg);
        key = (DriftLiquidatorRegistry as any).keyOf({ name });
      }
      
      // Emit immediate update to show "starting" state in UI
      try {
        const listNow = DriftLiquidatorRegistry?.list?.() ?? [];
        logger.info('drift.liquidator.emit_immediate', { liquidatorCount: listNow?.length ?? 0, cat: 'drift' });
        _io.emit('liquidator-update', { liquidators: listNow });
      } catch (emitErr: any) {
        logger.warn('drift.liquidator.emit_immediate_failed', { error: String(emitErr?.message || emitErr), cat: 'drift' });
      }
      
      // Start asynchronously to avoid proxy timeouts; report status via logs/socket
      setImmediate(async () => {
        try {
          if (!useManager) {
            const existing = (DriftLiquidatorRegistry as any).get?.(key);
            if (!existing || !existing.getStatus?.().running) {
              await DriftLiquidatorRegistry.start(key);
            }
          }
          emit('log', { level: 'info', message: `drift: liquidator started ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
              : (DriftLiquidatorRegistry as any).list?.();
            _io.emit('liquidator-update', { liquidators: listNow });
          } catch {}
        } catch (e: any) {
          logger.error('drift-liq: start async failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
          try { emit('log', { level: 'error', message: `drift: liquidator start failed ${name}: ${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
              : (DriftLiquidatorRegistry as any).list?.();
            _io.emit('liquidator-update', { liquidators: listNow });
          } catch {}
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
        if (name) key = useManager ? `liq#${name}` : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.keyOf({ name });
      }
      let ok = false;
      if (useManager) {
        const { stopBot } = await import('../../../drift/botsManager.js');
        ok = await stopBot(key);
      } else {
        const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
        ok = await DriftLiquidatorRegistry.stop(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
          : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.list?.();
        _io.emit('liquidator-update', { liquidators: listNow });
      } catch {}
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
        if (name) key = useManager ? `liq#${name}` : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.keyOf({ name });
      }
      let ok = false;
      if (useManager) {
        const { removeBot } = await import('../../../drift/botsManager.js');
        ok = await removeBot(key);
      } else {
        const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
        ok = await DriftLiquidatorRegistry.remove(key);
      }
      try {
        const listNow = useManager
          ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
          : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.list?.();
        _io.emit('liquidator-update', { liquidators: listNow });
      } catch {}
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
      const key = useManager ? `liq#${name}` : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.keyOf({ name });
      // Perform update and restart asynchronously to avoid request timeouts
      setImmediate(async () => {
        try {
          if (useManager) {
            const { stopBot, removeBot, startBot } = await import('../../../drift/botsManager.js');
            try { await stopBot(key); } catch {}
            try { await removeBot(key); } catch {}
            await startBot('liquidator', { ...(cfg || {}), name, enabled: true } as any);
          } else {
            const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
            try { await DriftLiquidatorRegistry.stop(key); } catch {}
            try { DriftLiquidatorRegistry.remove(key); } catch {}
            DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name, enabled: true } as any);
            try { await DriftLiquidatorRegistry.start(key); } catch {}
          }
          emit('log', { level: 'info', message: `drift: liquidator updated ${name}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
          try {
            const listNow = useManager
              ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
              : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.list?.();
            _io.emit('liquidator-update', { liquidators: listNow });
          } catch {}
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
      if (useManager) {
        const { testLiquidator } = await import('../../../drift/botsManager.js');
        const out = await testLiquidator(String(key), String(userPk));
        return res.json(out || { ok: false });
      }
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.get(String(key));
      if (!runner) return res.status(404).json({ error: 'liquidator not found' });
      const ok = await (runner as any).testTarget?.(String(userPk));
      return res.json({ ok: !!ok });
    } catch (e: any) {
      logger.error('drift-liq: test failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/strategies/liquidator/config', async (_req: Request, res: Response) => {
    try {
      // placeholder: no global config store exposed; return status list
      const list = useManager
        ? await (await import('../../../drift/botsManager.js')).listBotsFresh('liquidator')
        : (await import('../../../drift/liquidator.js') as any).DriftLiquidatorRegistry.list();
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
      if (useManager) {
        const { stopBot, removeBot, startBot } = await import('../../../drift/botsManager.js');
        const key = `liq#${name}`;
        try { await stopBot(key); } catch {}
        try { await removeBot(key); } catch {}
        await startBot('liquidator', { ...(cfg || {}), name, enabled: !!cfg?.enabled } as any);
        return res.json({ ok: true, key });
      }
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const key = (DriftLiquidatorRegistry as any).keyOf({ name });
      try { await DriftLiquidatorRegistry.stop(key); } catch {}
      try { DriftLiquidatorRegistry.remove(key); } catch {}
      DriftLiquidatorRegistry.upsert({ ...(cfg || {}), name, enabled: !!cfg?.enabled } as any);
      return res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: set config failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/strategies/liquidator/queue', async (req: Request, res: Response) => {
    try {
      const key = String(req.query?.key || '').trim();
      const limit = Number(req.query?.limit || 25);
      if (!key) return res.status(400).json({ error: 'key is required', queue: null });
      if (useManager) {
        const { getQueue } = await import('../../../drift/botsManager.js');
        const snapshot = await getQueue(key, Number.isFinite(limit) ? limit : 25);
        return res.json(snapshot || { queue: null });
      }
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.get(key);
      if (!runner) return res.json({ queue: null });
      const snapshot = (runner as any).getQueueSnapshot?.(Number.isFinite(limit) ? limit : 25);
      return res.json({ queue: snapshot });
    } catch (e: any) {
      logger.error('drift-liq: queue failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // One-off test liquidation for a specific user under a given liquidator key
  api.post('/strategies/liquidator/test', async (req: Request, res: Response) => {
    try {
      const { key, userPk } = req.body as { key?: string; userPk?: string };
      if (!key) return res.status(400).json({ error: 'key is required' });
      if (!userPk) return res.status(400).json({ error: 'userPk is required' });
      if (useManager) {
        const { testLiquidator } = await import('../../../drift/botsManager.js');
        const out = await testLiquidator(String(key), String(userPk));
        return res.json(out || { ok: false });
      }
      const { DriftLiquidatorRegistry } = await import('../../../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.get(String(key));
      if (!runner) return res.status(404).json({ error: 'liquidator not found' });
      try { emit('log', { level: 'info', message: `drift:liquidator test requested key=${key} user=${userPk}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
      const out = await (runner as any).testTarget?.(String(userPk));
      const ok = !!(out && (out.ok !== false));
      return res.json({ ok });
    } catch (e: any) {
      logger.error('drift-liq: test failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


