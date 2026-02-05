import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';

export function createDriftRouter(io: SocketIOServer): Router {
  const api = Router();
  // serialize subaccount mutations to reduce concurrent RPC bursts
  const subMutex = new Map<number, Promise<any>>();

  api.get('/drift/infra/status', async (_req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      const s = svc.getInfraStatus?.() || { active: false, forceActive: false, bots: 0, has: {} };
      let userCount: any = null;
      try { if (typeof svc.getUserCountCached === 'function') userCount = await svc.getUserCountCached({ wait: false }); } catch {}
      // Include event index stats (users/markets/orders tracked)
      let indexStats: { users: number; markets: number; marketToOrders: number } | null = null;
      try {
        const { driftEventIndex } = await import('../../drift/eventIndex.js');
        indexStats = driftEventIndex.getStats();
      } catch {}
      res.json({ ...s, userCount, indexStats });
    } catch (e: any) {
      logger.error('drift: infra status failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/infra/event-index', async (req: Request, res: Response) => {
    try {
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query?.limit) : 50;
      const { driftEventIndex } = await import('../../drift/eventIndex.js');
      const stats = driftEventIndex.getStats();
      const condMarkets = driftEventIndex.getMarketsWithConditionalOrders(Math.max(1, limit));
      const activeMarkets = driftEventIndex.getActiveMarkets(Math.max(1, limit));
      res.json({ stats, condMarkets, activeMarkets });
    } catch (e: any) {
      logger.error('drift: infra event-index failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/infra/slot', async (_req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      const infra = await svc.getSharedInfra?.({ includeIdle: true });
      const slot = Number(infra?.slotSubscriber?.getSlot?.() ?? 0);
      res.json({ slot });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/infra/users/keys', async (req: Request, res: Response) => {
    try {
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query?.limit) : 1000;
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      const infra = await svc.getSharedInfra?.({ includeIdle: true });
      const userMap = infra?.userMap;
      let keys: string[] = [];
      try {
        if (userMap && typeof userMap.entries === 'function') {
          const entries = Array.from(userMap.entries());
          keys = entries.map(([k]) => String((k as any)?.toBase58?.() || k)).filter(Boolean);
        } else if (userMap && typeof userMap.values === 'function') {
          const vals = Array.from(userMap.values());
          keys = vals.map((u: any) => String(u?.getUserAccountPublicKey?.()?.toBase58?.() || '')).filter(Boolean);
        }
      } catch {}
      res.json({ keys: keys.slice(0, Math.max(1, limit)) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/infra/users/accounts', async (req: Request, res: Response) => {
    try {
      const pubkeys: string[] = Array.isArray(req.body?.pubkeys) ? req.body.pubkeys : [];
      const uniq = Array.from(new Set(pubkeys.map((p) => String(p || '').trim()).filter(Boolean)));
      const out: Record<string, { data: string | null; slot?: number }> = {};
      if (uniq.length === 0) return res.json({ accounts: out });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      const conn = svc.getReadConnection?.() || svc.connection;
      const { PublicKey } = await import('@solana/web3.js');
      const chunkSize = Math.max(1, Math.min(100, Number(req.body?.chunkSize || 50)));
      for (let i = 0; i < uniq.length; i += chunkSize) {
        const slice = uniq.slice(i, i + chunkSize);
        const keys = slice.map((k) => new PublicKey(k));
        const infos = await conn.getMultipleAccountsInfo(keys, { commitment: 'processed' } as any);
        infos.forEach((info: any, idx: number) => {
          const pk = slice[idx];
          out[pk] = { data: info?.data ? Buffer.from(info.data).toString('base64') : null };
        });
      }
      res.json({ accounts: out });
    } catch (e: any) {
      logger.error('drift: infra user accounts failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Helper: yield to the event loop so one heavy DLOB scan cannot starve
  // concurrent requests (trigger-nodes vs fill-nodes).
  const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

  // Helper: get infra fast — check readiness first, only fall through to
  // the full getSharedInfra() call if subscribers are already wired up.
  // Returns null when infra is not ready yet (caller should 503).
  const getInfraFast = async (): Promise<{ svc: any; infra: any; dlob: any } | null> => {
    const { DriftService } = await import('../../drift/client.js');
    const svc = DriftService.getInstance() as any;
    const status = svc.getInfraStatus?.();
    // If warmup hasn't completed or the DLOB subscriber isn't attached yet,
    // return null immediately instead of entering the subscription waterfall
    // which would block this request for many seconds.
    if (!status?.has?.dlobSubscriber || !status?.has?.slotSubscriber) return null;
    const infra = await svc.getSharedInfra?.({ includeIdle: true, preferOrderSubscriber: true });
    const dlob = infra?.dlobSubscriber?.getDLOB?.();
    if (!dlob) return null;
    return { svc, infra, dlob };
  };

  api.post('/drift/infra/dlob/trigger-nodes', async (req: Request, res: Response) => {
    try {
      const markets: Array<{ marketIndex: number; marketType?: any; triggerPrice?: string }> = Array.isArray(req.body?.markets) ? req.body.markets : [];
      const limitPerMarket = Number.isFinite(Number(req.body?.limitPerMarket)) ? Number(req.body.limitPerMarket) : undefined;
      if (markets.length === 0) return res.json({ results: [] });
      const ctx = await getInfraFast();
      if (!ctx) return res.status(503).json({ error: 'dlob_unavailable' });
      const { svc, infra, dlob } = ctx;
      const { BN, MarketType, getVariant, isVariant, getTriggerPrice, useMedianTriggerPrice } = await import('@drift-labs/sdk');
      const stateAcc = svc?.client?.getStateAccount?.();
      const slot = Number(infra?.slotSubscriber?.getSlot?.() ?? 0);
      const results: any[] = [];
      let iter = 0;
      for (const m of markets) {
        // Yield every 10 markets so fill-nodes (or other requests) aren't starved
        iter += 1;
        if ((iter % 10) === 0) await yieldLoop();
        const idx = Number((m as any)?.marketIndex ?? m);
        if (!Number.isFinite(idx)) continue;
        const mType = (m as any)?.marketType;
        const marketType = (mType && typeof mType === 'object')
          ? mType
          : (String(mType || '').toLowerCase() === 'spot' ? MarketType.SPOT : MarketType.PERP);
        let triggerPx: any = null;
        if ((m as any)?.triggerPrice) {
          try { triggerPx = new BN(String((m as any).triggerPrice)); } catch {}
        }
        if (!triggerPx) {
          try {
            const oracleData = isVariant(marketType, 'perp')
              ? svc.client.getOracleDataForPerpMarket(idx)
              : svc.client.getOracleDataForSpotMarket(idx);
            const freshest = oracleData?.price as any;
            const nowSec = new BN(Math.floor(Date.now() / 1000));
            if (isVariant(marketType, 'perp')) {
              const market = svc.client.getPerpMarketAccount?.(idx);
              triggerPx = getTriggerPrice(market, freshest, nowSec, useMedianTriggerPrice(svc.client.getStateAccount()));
            } else {
              triggerPx = freshest;
            }
          } catch {}
        }
        if (!triggerPx) continue;
        const nodes = dlob.findNodesToTrigger(idx, slot, triggerPx, marketType, stateAcc) || [];
        const trimmed = (limitPerMarket && nodes.length > limitPerMarket) ? nodes.slice(0, limitPerMarket) : nodes;
        const serialized = trimmed.map((n: any) => ({
          node: {
            userAccount: String(n?.node?.userAccount || ''),
            order: {
              orderId: Number(n?.node?.order?.orderId ?? 0),
              marketIndex: Number(n?.node?.order?.marketIndex ?? idx),
              marketType: n?.node?.order?.marketType,
              orderType: n?.node?.order?.orderType,
              triggerCondition: n?.node?.order?.triggerCondition,
            },
          },
        }));
        results.push({ marketIndex: idx, marketType: String(getVariant(marketType)), nodes: serialized });
      }
      res.json({ slot, results });
    } catch (e: any) {
      logger.error('drift: infra trigger nodes failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/infra/dlob/fill-nodes', async (req: Request, res: Response) => {
    try {
      const markets: number[] = Array.isArray(req.body?.markets) ? req.body.markets : [];
      const limitPerMarket = Number.isFinite(Number(req.body?.limitPerMarket)) ? Number(req.body.limitPerMarket) : undefined;
      if (markets.length === 0) return res.json({ results: [] });
      const ctx = await getInfraFast();
      if (!ctx) return res.status(503).json({ error: 'dlob_unavailable' });
      const { svc, infra, dlob } = ctx;
      const { MarketType, BN, calculateAskPrice, calculateBidPrice } = await import('@drift-labs/sdk');
      const slot = Number(infra?.slotSubscriber?.getSlot?.() ?? 0);
      const slotBn = new BN(slot);
      const stateAcc = svc?.client?.getStateAccount?.();
      const ts = Math.floor(Date.now() / 1000) - 60;
      const driftCfg: any = (CONFIG as any)?.drift || {};
      const maxDelay = Math.max(0, Number(driftCfg?.maxOracleDelaySlots ?? 40));
      const results: any[] = [];
      let iter = 0;
      for (const rawIdx of markets) {
        // Yield every 10 markets so trigger-nodes (or other requests) aren't starved
        iter += 1;
        if ((iter % 10) === 0) await yieldLoop();
        const idx = Number(rawIdx);
        if (!Number.isFinite(idx)) continue;
        const market = svc.client.getPerpMarketAccount?.(idx);
        const mmOraclePriceData = svc.client.getMMOracleDataForPerpMarket?.(idx);
        if (!market || !mmOraclePriceData) continue;
        const vAsk = calculateAskPrice(market, mmOraclePriceData, slotBn);
        const vBid = calculateBidPrice(market, mmOraclePriceData, slotBn);
        let oracleDelay: number | undefined = undefined;
        let oracleStale: boolean | undefined = undefined;
        let oraclePx: string | undefined = undefined;
        try {
          const od = svc.client.getOracleDataForPerpMarket?.(idx);
          const odSlot = Number((od as any)?.slot?.toString?.() || 0);
          oraclePx = String((od as any)?.price?.toString?.() || '');
          if (odSlot > 0) {
            oracleDelay = Math.max(0, slot - odSlot);
            oracleStale = oracleDelay > maxDelay;
          }
        } catch {}
        const nodes = dlob.findNodesToFill(
          idx,
          vBid,
          vAsk,
          slot,
          ts,
          MarketType.PERP,
          mmOraclePriceData,
          stateAcc,
          market
        ) || [];
        const trimmed = (limitPerMarket && nodes.length > limitPerMarket) ? nodes.slice(0, limitPerMarket) : nodes;
        const serialized = trimmed.map((n: any) => ({
          node: {
            userAccount: String(n?.node?.userAccount || ''),
            order: {
              orderId: Number(n?.node?.order?.orderId ?? 0),
              marketIndex: Number(n?.node?.order?.marketIndex ?? idx),
              orderType: n?.node?.order?.orderType,
            },
          },
          makerNodes: Array.isArray(n?.makerNodes)
            ? n.makerNodes.map((mn: any) => ({
                userAccount: String(mn?.userAccount || ''),
                order: {
                  orderId: Number(mn?.order?.orderId ?? 0),
                  marketIndex: Number(mn?.order?.marketIndex ?? idx),
                  orderType: mn?.order?.orderType,
                },
              }))
            : [],
        }));
        results.push({
          marketIndex: idx,
          vBid: String((vBid as any)?.toString?.() || vBid || ''),
          vAsk: String((vAsk as any)?.toString?.() || vAsk || ''),
          oracle: oraclePx,
          oracleDelay,
          oracleStale,
          nodes: serialized,
        });
      }
      res.json({ slot, results });
    } catch (e: any) {
      logger.error('drift: infra fill nodes failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/infra/prices', async (req: Request, res: Response) => {
    try {
      const markets: number[] = Array.isArray(req.body?.markets) ? req.body.markets : [];
      const pollMs = Number.isFinite(Number(req.body?.pollMs)) ? Number(req.body.pollMs) : undefined;
      if (markets.length === 0) return res.json({ prices: {} });
      const { DriftPriceService } = await import('../../drift/price.js');
      const svc = DriftPriceService.getInstance();
      const out: Record<string, any> = {};
      for (const m of markets) {
        const idx = Number(m);
        if (!Number.isFinite(idx)) continue;
        try { svc.trackMarket(idx, Math.max(500, Number(pollMs || 500))); } catch {}
        const sample = svc.getPrice(idx);
        if (sample) out[String(idx)] = sample;
      }
      res.json({ prices: out });
    } catch (e: any) {
      logger.error('drift: infra prices failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/infra/activate', async (req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      const opts = (req.body || {}) as any;
      await svc.activate?.({
        includeIdle: !!opts?.includeIdle,
        updateFrequency: Number.isFinite(Number(opts?.updateFrequency)) ? Number(opts.updateFrequency) : undefined,
        preferOrderSubscriber: (opts?.preferOrderSubscriber === undefined ? true : !!opts?.preferOrderSubscriber),
      });
      try { emit('log', { level: 'info', message: 'drift: infra activated', timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('drift: infra activate failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/infra/deactivate', async (_req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance() as any;
      svc.deactivate?.();
      try { emit('log', { level: 'info', message: 'drift: infra deactivated', timestamp: new Date().toISOString(), context: { cat: 'drift' } }); } catch {}
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('drift: infra deactivate failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/status', async (_req: Request, res: Response) => {
    try {
      const t0 = Date.now();
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const status = await svc.getStatus();
      try { logger.info('drift.route.status', { subaccounts: status?.subaccounts?.length || 0, markets: status?.markets?.length || 0, ms: Date.now() - t0, cat: 'drift' }); } catch {}
      res.json(status);
    } catch (e: any) {
      logger.error('drift: status failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/switch', async (req: Request, res: Response) => {
    try {
      const t0 = Date.now();
      const { id } = req.body as { id: number };
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const ok = await svc.switchSubaccount(Number(id));
      try { logger.info('drift.route.sub.switch', { id, ok, ms: Date.now() - t0, cat: 'drift' }); } catch {}
      try {
        const { readJson, writeJson } = await import('../../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
        const store = await readJson<any>(storePath, { names: {}, selectedId: Number(id) });
        store.selectedId = Number(id);
        await writeJson(storePath, store);
      } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift: switch subaccount failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/subaccounts', async (_req: Request, res: Response) => {
    try {
      const t0 = Date.now();
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const subs = await svc.getSubaccounts();
      try { logger.info('drift.route.sub.list', { count: subs?.length || 0, ms: Date.now() - t0, cat: 'drift' }); } catch {}
      const { readJson } = await import('../../utils/fs.js');
      const pathMod = await import('path');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: subs?.[0]?.id ?? 0 });
      const subaccounts = subs.map((s: any) => ({ ...s, name: (store.names?.[String(s.id)] || null) }));
      res.json({ subaccounts, selectedId: store.selectedId });
    } catch (e: any) {
      logger.error('drift: subaccounts failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccounts', async (req: Request, res: Response) => {
    try {
      const t0 = Date.now();
      const refresh = !!(req.body?.refresh) || String(req.query?.refresh || '') === '1';
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      if (refresh) svc.invalidateSubaccountsCache();
      const subs = await svc.getSubaccounts();
      try { logger.info('drift.route.sub.refresh', { refresh, count: subs?.length || 0, ms: Date.now() - t0, cat: 'drift' }); } catch {}
      const { readJson } = await import('../../utils/fs.js');
      const pathMod = await import('path');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: subs?.[0]?.id ?? 0 });
      const subaccounts = subs.map((s: any) => ({ ...s, name: (store.names?.[String(s.id)] || null) }));
      res.json({ subaccounts, selectedId: store.selectedId, refreshed: refresh });
    } catch (e: any) {
      logger.error('drift: subaccounts refresh failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/create', async (req: Request, res: Response) => {
    try {
      const { name } = (req.body || {}) as { name?: string };
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const created = await svc.createSubaccount(name);
      if (!created) return res.status(500).json({ error: 'create subaccount unavailable' });
      const out = created;
      try {
        const { readJson, writeJson } = await import('../../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
        const store = await readJson<any>(storePath, { names: {}, selectedId: out.id });
        if (name && String(name).trim()) {
          store.names[String(out.id)] = String(name).trim();
        }
        store.selectedId = out.id;
        await writeJson(storePath, store);
      } catch {}
      res.json(out);
    } catch (e: any) {
      logger.error('drift: create subaccount failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/name', async (req: Request, res: Response) => {
    try {
      const { id, name } = req.body as { id: number; name: string };
      const pathMod = await import('path');
      const { readJson, writeJson } = await import('../../utils/fs.js');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: Number(id) });
      if (Number.isFinite(Number(id)) && String(name).trim()) {
        store.names[String(id)] = String(name).trim();
        await writeJson(storePath, store);
      }
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('drift: subaccount name failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/deposit', async (req: Request, res: Response) => {
    try {
      const body = req.body as { subaccountId: number; amount: number; spotMarketIndex?: number };
      const subaccountId = Number(body?.subaccountId);
      const amount = Number(body?.amount);
      const spotMarketIndex = body?.spotMarketIndex;
      if (!Number.isFinite(subaccountId) || subaccountId < 0) return res.status(400).json({ error: 'invalid subaccountId' });
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const last = subMutex.get(subaccountId) || Promise.resolve();
      let resolveNext: (v?: any) => void;
      const next = new Promise((r) => (resolveNext = r));
      subMutex.set(subaccountId, last.then(() => next));
      await last.catch(() => {});
      try {
        const out = await svc.depositToSubaccount({ subaccountId, amount, spotMarketIndex });
        try { emit('drift:user:balances', { subaccountId }); } catch {}
        res.json(out);
      } finally {
        resolveNext!();
        if (subMutex.get(subaccountId) === next) subMutex.delete(subaccountId);
      }
    } catch (e: any) {
      logger.error('drift: deposit failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/withdraw', async (req: Request, res: Response) => {
    try {
      const body = req.body as { subaccountId: number; amount: number; spotMarketIndex?: number };
      const subaccountId = Number(body?.subaccountId);
      const amount = Number(body?.amount);
      const spotMarketIndex = body?.spotMarketIndex;
      if (!Number.isFinite(subaccountId) || subaccountId < 0) return res.status(400).json({ error: 'invalid subaccountId' });
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const last = subMutex.get(subaccountId) || Promise.resolve();
      let resolveNext: (v?: any) => void;
      const next = new Promise((r) => (resolveNext = r));
      subMutex.set(subaccountId, last.then(() => next));
      await last.catch(() => {});
      try {
        const out = await svc.withdrawFromSubaccount({ subaccountId, amount, spotMarketIndex });
        try { emit('drift:user:balances', { subaccountId }); } catch {}
        res.json(out);
      } finally {
        resolveNext!();
        if (subMutex.get(subaccountId) === next) subMutex.delete(subaccountId);
      }
    } catch (e: any) {
      logger.error('drift: withdraw failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/transfer', async (req: Request, res: Response) => {
    try {
      const body = req.body as { amount: number; spotMarketIndex: number; fromSubaccountId: number; toSubaccountId: number };
      const amount = Number(body?.amount);
      const spotMarketIndex = Number(body?.spotMarketIndex);
      const fromSubaccountId = Number(body?.fromSubaccountId);
      const toSubaccountId = Number(body?.toSubaccountId);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      if (!Number.isFinite(spotMarketIndex)) return res.status(400).json({ error: 'invalid spotMarketIndex' });
      if (!Number.isFinite(fromSubaccountId) || fromSubaccountId < 0) return res.status(400).json({ error: 'invalid fromSubaccountId' });
      if (!Number.isFinite(toSubaccountId) || toSubaccountId < 0) return res.status(400).json({ error: 'invalid toSubaccountId' });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const out = await svc.transferBetweenSubaccounts({ amount, spotMarketIndex, fromSubaccountId, toSubaccountId });
      res.json(out);
    } catch (e: any) {
      logger.error('drift: transfer failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/spot-markets', async (_req: Request, res: Response) => {
    try {
      const sdk: any = await import('@drift-labs/sdk');
      const constants: any = (sdk as any).constants || (sdk as any);
      const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
      const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
      const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
      const out = Array.isArray(list) ? list.map((m: any) => ({
        marketIndex: Number(m?.marketIndex ?? m?.index ?? m?.market_index),
        symbol: String(m?.symbol || m?.name || '').trim() || undefined,
        mint: String(m?.mint || m?.mintAddress || m?.address || ''),
        decimals: Number(m?.decimals ?? m?.precision ?? 6),
      })).filter((m: any) => Number.isFinite(m.marketIndex)) : [];
      res.json({ markets: out });
    } catch (e: any) {
      logger.error('drift: spot-markets failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Detailed user snapshot (collateral + spot collateral + perp positions)
  api.get('/drift/user/:pubkey', async (req: Request, res: Response) => {
    try {
      const pkStr = String(req.params.pubkey || '').trim();
      if (!pkStr) return res.status(400).json({ error: 'pubkey required' });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      await svc.init();
      const client: any = (svc as any)?.client;
      let sdkUser: any = null;
      try {
        const { User, getUserAccountPublicKey } = await import('@drift-labs/sdk');
        const { PublicKey } = await import('@solana/web3.js');
        const inputPk = new PublicKey(pkStr);
        // First, try treating input as a user account PDA directly
        try {
          const candidate = new User({ driftClient: client, userAccountPublicKey: inputPk, accountSubscription: { type: 'websocket' } });
          try { await (candidate as any)?.subscribe?.(); } catch {}
          let exists = false;
          try { exists = await (candidate as any)?.exists?.(); } catch {}
          if (exists) {
            sdkUser = candidate;
            try { logger.info('drift.route.user.debug', { mode: 'pda', userPk: String(inputPk?.toBase58?.() || inputPk), cat: 'drift' }); } catch {}
          }
        } catch {}
        // If not, treat input as an authority and resolve PDA (optionally using subAccountId)
        if (!sdkUser) {
          let targetUserPk: any = null;
          const q = req.query as any;
          const subId = Number(q?.subAccountId ?? q?.subaccountId ?? q?.subid ?? q?.id);
          if (Number.isFinite(subId)) {
            try { targetUserPk = await (client as any)?.getUserAccountPublicKey?.(Number(subId), inputPk) || await getUserAccountPublicKey((client as any)?.program?.programId, inputPk, Number(subId)); } catch {}
            try { if (targetUserPk) logger.info('drift.route.user.debug', { mode: 'authority+subId', authority: String(inputPk?.toBase58?.() || inputPk), subId: Number(subId), resolvedPk: String(targetUserPk?.toBase58?.() || targetUserPk), cat: 'drift' }); } catch {}
          }
          // Probe a few subaccounts if none specified or not found
          if (!targetUserPk) {
            for (let i = 0; i < 4; i++) {
              try {
                const p = await getUserAccountPublicKey((client as any)?.program?.programId, inputPk, i);
                const candidate = new User({ driftClient: client, userAccountPublicKey: p, accountSubscription: { type: 'websocket' } });
                try { await (candidate as any)?.subscribe?.(); } catch {}
                let exists = false;
                try { exists = await (candidate as any)?.exists?.(); } catch {}
                if (exists) { targetUserPk = p; break; }
              } catch {}
            }
            try { if (targetUserPk) logger.info('drift.route.user.debug', { mode: 'authority+probe', authority: String(inputPk?.toBase58?.() || inputPk), resolvedPk: String(targetUserPk?.toBase58?.() || targetUserPk), cat: 'drift' }); } catch {}
          }
          if (targetUserPk) {
            sdkUser = new User({ driftClient: client, userAccountPublicKey: targetUserPk, accountSubscription: { type: 'websocket' } });
            try { await (sdkUser as any)?.subscribe?.(); } catch {}
          }
        }
      } catch {}
      if (!sdkUser) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      try { await (sdkUser as any)?.fetchAccounts?.(); } catch {}

      // Collateral (quote precision)
      let QUOTE_PREC = 1_000_000;
      let QUOTE_INDEX = 0;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION);
        if (Number.isFinite(Number(cst?.QUOTE_SPOT_MARKET_INDEX))) QUOTE_INDEX = Number(cst.QUOTE_SPOT_MARKET_INDEX);
      } catch {}
      const toUi = (v: any) => Number(v?.toString?.() || v || 0) / QUOTE_PREC;
      const collateral = {
        total: Number((sdkUser as any)?.getTotalCollateral?.('Maintenance') || 0),
        maintenance: Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0),
        free: Number((sdkUser as any)?.getFreeCollateral?.()?.toString?.() || (sdkUser as any)?.getFreeCollateral?.() || 0),
        totalUi: toUi((sdkUser as any)?.getTotalCollateral?.('Maintenance')),
        maintUi: toUi((sdkUser as any)?.getMaintenanceMarginRequirement?.()),
        freeUi: toUi((sdkUser as any)?.getFreeCollateral?.()),
      } as any;
      try { logger.info('drift.route.user.debug', { phase: 'collateral', total: collateral.totalUi, maint: collateral.maintUi, free: collateral.freeUi, cat: 'drift' }); } catch {}

      // Helper to robustly decode market symbol/name
      const decodeSym = (val: any): string | undefined => {
        try {
          if (!val) return undefined;
          if (typeof val === 'string') return val.replace(/\0+$/g, '').trim() || undefined;
          if (Array.isArray(val)) return Buffer.from(val).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
          if (val?.data && Array.isArray(val.data)) return Buffer.from(Uint8Array.from(val.data)).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
          if (val?.byteLength && typeof val?.slice === 'function') return Buffer.from(Uint8Array.from(val)).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
        } catch {}
        return undefined;
      };

      // Spot collateral
      const spotCollateral: Array<{ marketIndex: number; symbol?: string; amountUi: number; amountRaw: number; mint?: string; decimals?: number; balanceType?: 'deposit' | 'borrow' }> = [];
      try {
        let spots = (sdkUser as any)?.getSpotPositions?.() || [];
        try { logger.info('drift.route.user.debug', { phase: 'spots_count', count: Array.isArray(spots) ? spots.length : 0, cat: 'drift' }); } catch {}
        // Fallback: raw userAccount spotPositions if filtered list is empty
        if (!Array.isArray(spots) || spots.length === 0) {
          try {
            const ua = (sdkUser as any)?.getUserAccount?.();
            const rawSpots = Array.isArray(ua?.spotPositions) ? ua.spotPositions : [];
            try { logger.info('drift.route.user.debug', { phase: 'spots_raw_count', count: rawSpots.length, cat: 'drift' }); } catch {}
            spots = rawSpots;
          } catch {}
        }
        for (const sp of (spots || [])) {
          try {
            const idx = Number(sp?.marketIndex ?? sp?.market_index ?? sp?.market?.index);
            if (!Number.isFinite(idx)) continue;
            const mktAcc = await client?.getSpotMarketAccount?.(idx);
            let decimals = Number(mktAcc?.decimals ?? mktAcc?.precision ?? 6);
            let mint = String(mktAcc?.mint || mktAcc?.mintAddress || '');
            // Prefer SDK helper returning raw integer token amount
            let raw = 0;
            try {
              if (typeof (sdkUser as any)?.getTokenAmount === 'function') {
                const v = (sdkUser as any).getTokenAmount(idx);
                raw = Number(v?.toString?.() || v || 0);
              }
            } catch {}
            if (!Number.isFinite(raw) || raw === 0) {
              raw = Number(sp?.scaledBalance?.toString?.() || sp?.balance || sp?.depositBalance || sp?.borrowBalance || 0);
            }
            const amountRaw = raw;
            // Scale amount using quote precision if quote index, else token decimals
            let amountUi = 0;
            if (Number.isFinite(amountRaw)) {
              if (Number(idx) === Number(QUOTE_INDEX)) amountUi = amountRaw / QUOTE_PREC; else amountUi = amountRaw / Math.pow(10, Number(decimals));
            }
            // Decode symbol from account, with robust decoding
            let symbol = decodeSym((mktAcc as any)?.name || (mktAcc as any)?.symbol) || undefined;
            if (!symbol || symbol === '0') {
              try {
                const sdk: any = await import('@drift-labs/sdk');
                const constants: any = (sdk as any).constants || (sdk as any);
                const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
                const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
                const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
                // Try by index first
                let found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === idx) : null;
                // If not found, try by mint match
                if (!found && mint) {
                  found = Array.isArray(list) ? list.find((m: any) => String(m?.mint || m?.mintAddress || m?.address || '').toLowerCase() === String(mint).toLowerCase()) : null;
                }
                if (found) {
                  symbol = decodeSym(found?.symbol || found?.name) || symbol;
                  if (!Number.isFinite(decimals)) decimals = Number(found?.decimals ?? found?.precision ?? decimals ?? 6);
                  if (!mint) mint = String(found?.mint || found?.mintAddress || found?.address || mint || '');
                  // Recompute UI if decimals changed
                  if (Number(idx) !== Number(QUOTE_INDEX)) amountUi = Number.isFinite(amountRaw) ? amountRaw / Math.pow(10, Number(decimals)) : amountUi;
                }
              } catch {}
            }
      // Log raw entries even if zero to diagnose
            try {
              const scaled = String(sp?.scaledBalance?.toString?.() || sp?.scaledBalance || sp?.balance || sp?.depositBalance || sp?.borrowBalance || '0');
              logger.info('drift.route.user.debug', { phase: 'spot_raw', idx, decimals, mint, symbol, scaledBalance: scaled, computedAmountRaw: amountRaw, computedAmountUi: amountUi, cat: 'drift' });
            } catch {}
            if (amountUi !== 0) {
              const balanceType: 'deposit' | 'borrow' = (amountRaw < 0 || amountUi < 0) ? 'borrow' : 'deposit';
              spotCollateral.push({ marketIndex: idx, symbol, amountUi, amountRaw, mint, decimals, balanceType });
              try { logger.info('drift.route.user.debug', { phase: 'spot_item', idx, symbol, mint, amountUi, amountRaw, balanceType, cat: 'drift' }); } catch {}
            }
          } catch {}
        }
      } catch {}

      // Deduplicate by marketIndex (sum signed raw amounts), then recompute UI and balanceType
      try {
        if (Array.isArray(spotCollateral) && spotCollateral.length > 1) {
          const before = spotCollateral.length;
          const byIdx = new Map<number, { marketIndex: number; symbol?: string; mint?: string; decimals?: number; amountRaw: number }>();
          for (const e of spotCollateral) {
            try {
              const idx = Number(e.marketIndex);
              if (!Number.isFinite(idx)) continue;
              const cur = byIdx.get(idx) || { marketIndex: idx, symbol: undefined, mint: undefined, decimals: e.decimals, amountRaw: 0 };
              // Prefer non-empty symbol/mint/decimals from latest non-empty
              cur.symbol = cur.symbol || e.symbol;
              cur.mint = cur.mint || e.mint;
              if (!Number.isFinite(cur.decimals as any)) cur.decimals = e.decimals;
              cur.amountRaw += Number(e.amountRaw || 0);
              byIdx.set(idx, cur);
            } catch {}
          }
          const dedup: Array<{ marketIndex: number; symbol?: string; amountUi: number; amountRaw: number; mint?: string; decimals?: number; balanceType?: 'deposit' | 'borrow' }> = [];
          for (const v of Array.from(byIdx.values())) {
            try {
              const idx = v.marketIndex;
              const decimals = Number(v.decimals ?? 6);
              const raw = Number(v.amountRaw || 0);
              const ui = Number.isFinite(raw) ? (Number(idx) === Number(QUOTE_INDEX) ? raw / QUOTE_PREC : raw / Math.pow(10, decimals)) : 0;
              const balanceType: 'deposit' | 'borrow' = (raw < 0 || ui < 0) ? 'borrow' : 'deposit';
              dedup.push({ marketIndex: idx, symbol: v.symbol, amountUi: ui, amountRaw: raw, mint: v.mint, decimals, balanceType });
            } catch {}
          }
          spotCollateral.splice(0, spotCollateral.length, ...dedup);
          try { logger.info('drift.route.user.debug', { phase: 'spot_dedup', before, after: spotCollateral.length, cat: 'drift' }); } catch {}
        }
      } catch {}

      // Perp positions (raw base)
      const perpPositions: Array<{ marketIndex: number; baseRaw: number }> = [];
      try {
        let positions = (sdkUser as any)?.getPerpPositions?.() || [];
        try { if (!Array.isArray(positions) || positions.length === 0) { const raw = (sdkUser as any)?.getUserAccount?.()?.perpPositions; if (Array.isArray(raw)) positions = raw; } } catch {}
        for (const p of (positions || [])) {
          try {
            const rawBase = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
            const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
            if (!Number.isFinite(m) || rawBase === 0) continue;
            perpPositions.push({ marketIndex: m, baseRaw: rawBase });
          } catch {}
        }
      } catch {}

      try { logger.info('drift.route.user.debug', { phase: 'done', spotCount: spotCollateral.length, perpCount: perpPositions.length, cat: 'drift' }); } catch {}
      res.json({ collateral, spotCollateral, perpPositions });
    } catch (e: any) {
      logger.error('drift: user snapshot failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/subaccount/balances', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const subId = Number(q?.subaccountId ?? q?.id ?? 0);
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      await svc.init();
      const client: any = (svc as any)?.client;
      let user: any = null;
      try {
        const { User } = await import('@drift-labs/sdk');
        // Resolve the specific subaccount PDA and instantiate a User for it via websocket subscription
        const userPk = await client?.getUserAccountPublicKey?.(Number(subId));
        if (userPk) {
          user = new User({ driftClient: client, userAccountPublicKey: userPk, accountSubscription: { type: 'websocket' } });
          try { 
            if (typeof user.subscribe === 'function') { 
              const { waitUntilWsReady } = await import('../../drift/wsHelper.js');
              const conn = (svc as any)?.connection;
              if (conn) await waitUntilWsReady(conn, 'routes.drift.balances');
              
              // Import RPC limiter and debouncing
              const { withRpcLimit, withDebounce } = await import('../../utils/rpcLimiter.js');
              
              // Wrap subscribe call with debouncing and RPC tracking
              await withDebounce(
                `routes.drift.balances:user:subscribe:${userPk.toBase58()}`,
                async () => {
                  return await withRpcLimit(
                    () => user.subscribe(),
                    1,
                    { module: 'drift', method: 'accountSubscribe' }
                  );
                },
                200
              );
            } 
          } catch {}
        }
      } catch {}
      // Fallback to active user if targeted subaccount is unavailable
      if (!user) user = client?.user;
      const spotPositions = user?.getSpotPositions?.() || [];
      const out: Array<{ marketIndex: number; balance: number; amount: number; amountRaw?: number; balanceType?: 'deposit' | 'borrow'; symbol?: string; mint?: string; decimals?: number }> = [];
      // Load constants for correct scaling
      let QUOTE_PREC = 1_000_000;
      let QUOTE_INDEX = 0;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        QUOTE_PREC = Number(cst?.QUOTE_PRECISION ?? 1_000_000);
        QUOTE_INDEX = Number(cst?.QUOTE_SPOT_MARKET_INDEX ?? 0);
      } catch {}
      const decodeSym = (val: any): string | undefined => {
        try {
          if (!val) return undefined;
          if (typeof val === 'string') return val.replace(/\0+$/g, '').trim() || undefined;
          if (Array.isArray(val)) return Buffer.from(val).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
          if (val?.data && Array.isArray(val.data)) return Buffer.from(Uint8Array.from(val.data)).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
          if (val?.byteLength && typeof val?.slice === 'function') return Buffer.from(Uint8Array.from(val)).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
        } catch {}
        return undefined;
      };
      const pushFrom = async (posList: any[], userRef: any) => {
        for (const p of posList) {
          try {
            const idx = Number(p?.marketIndex ?? p?.market_index ?? 0);
            // Prefer SDK helper returning raw integer token amount (signed)
            let raw = 0;
            try {
              if (typeof (userRef as any)?.getTokenAmount === 'function') {
                const v = (userRef as any).getTokenAmount(idx);
                raw = Number(v?.toString?.() || v || 0);
              }
            } catch {}
            if (!Number.isFinite(raw)) { raw = 0; }
            if (raw === 0) { raw = Number(p?.scaledBalance?.toString?.() || 0) || Number(p?.balance || 0); }
            let symbol: string | undefined = undefined;
            let mint: string | undefined = undefined;
            let decimals: number | undefined = undefined;
            try {
              const acct = typeof (client as any)?.getSpotMarketAccount === 'function' ? (client as any).getSpotMarketAccount(idx) : null;
              if (acct) {
                decimals = Number(acct?.decimals ?? acct?.precision ?? acct?.tokenPrecision ?? 6);
                symbol = decodeSym(acct?.name || acct?.symbol) || symbol;
                mint = String(acct?.mint || acct?.mintAddress || acct?.tokenMint || mint || '');
              }
            } catch {}
            if (!Number.isFinite(decimals)) {
              try {
                const sdk: any = await import('@drift-labs/sdk');
                const constants: any = (sdk as any).constants || (sdk as any);
                const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
                const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
                const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
                const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === idx) : null;
                if (found) {
                  symbol = symbol || decodeSym(found?.symbol || found?.name);
                  mint = mint || String(found?.mint || found?.mintAddress || found?.address || '');
                  decimals = Number(found?.decimals ?? found?.precision ?? 6);
                }
              } catch {}
            }
            let amount = raw;
            if (Number(idx) === Number(QUOTE_INDEX)) amount = amount / QUOTE_PREC; else if (Number.isFinite(decimals)) { const scale = Math.pow(10, Number(decimals)); if (scale > 0 && isFinite(scale)) amount = amount / scale; }
            const balanceType: 'deposit' | 'borrow' = (amount < 0 || raw < 0) ? 'borrow' : 'deposit';
            // Include both deposits and borrows when non-zero
            if (amount !== 0 || raw !== 0) out.push({ marketIndex: idx, balance: amount, amount, amountRaw: raw, balanceType, symbol, mint, decimals });
          } catch {}
        }
      };
      await pushFrom(spotPositions, user);
      // Fallback: switch and read from active user
      if (out.length === 0) {
        try { const svc2 = DriftService.getInstance(); await svc2.switchSubaccount(Number(subId)); } catch {}
        const activeUser = client?.user;
        const alt = activeUser?.getSpotPositions?.() || [];
        await pushFrom(alt, activeUser);
      }
      // Final fallback: probe all spot indices
      if (out.length === 0) {
        try {
          const sdk: any = await import('@drift-labs/sdk');
          const constants: any = (sdk as any).constants || (sdk as any);
          const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
          const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
          const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
          const indices: number[] = Array.isArray(list) ? list.map((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index)).filter((n: any) => Number.isFinite(n)) : [];
          const tempPos = indices.map((i) => ({ marketIndex: i }));
          await pushFrom(tempPos as any[], user);
        } catch {}
      }
      try { logger.info('drift.route.sub.balances', { subaccountId: subId, count: out.length, cat: 'drift' }); } catch {}
      res.json({ balances: out });
    } catch (e: any) {
      logger.error('drift: subaccount balances failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/l2', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const marketIndex = Number(q.marketIndex ?? q.marketindex ?? q.index);
      if (!Number.isFinite(marketIndex)) return res.status(400).json({ error: 'marketIndex required' });
      const { fetchDlobL2 } = await import('../../drift/marketdata.js');
      const l2 = await fetchDlobL2(marketIndex);
      res.json(l2 || { bid: [], ask: [] });
    } catch (e: any) {
      logger.error('drift: l2 failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/funding', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const marketIndex = Number(q.marketIndex ?? q.marketindex ?? q.index);
      if (!Number.isFinite(marketIndex)) return res.status(400).json({ error: 'marketIndex required' });
      const { DriftService } = await import('../../drift/client.js');
      const svc = DriftService.getInstance();
      const fr = await svc.getFundingRate(marketIndex);
      res.json(fr || { lastFundingRate: 0, cumulativeFunding: 0 });
    } catch (e: any) {
      logger.error('drift: funding failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift tx history from JSONL
  api.get('/drift/tx-history', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const limit = Math.max(1, Math.min(5000, Number(q.limit ?? 200)));
      const maxBytes = Math.max(64 * 1024, Number(q.maxBytes ?? ((CONFIG as any)?.drift?.txHistoryMaxBytes ?? 2_000_000)));
      const sinceMs = Number(q.sinceMs ?? 0);
      const action = (typeof q.action === 'string' ? String(q.action) : undefined) as any;
      const bot = (typeof q.bot === 'string' ? String(q.bot) : undefined);
      const includeStatus = String(q.includeStatus ?? '1') !== '0';
      const { readAttemptHistory } = await import('../../drift/txTracker.js');
      const items = await readAttemptHistory({ limit, maxBytes, sinceMs, action, bot });

      let statusMap: Record<string, any> = {};
      if (includeStatus && items.length > 0) {
        try {
          const { DriftService } = await import('../../drift/client.js');
          const svc = DriftService.getInstance() as any;
          const conn = svc.getReadConnection?.() || svc.connection;
          const sigs = Array.from(new Set(items.map((r: any) => String(r.sig || '')).filter((s: string) => s && s !== 'FAILED')));
          if (conn && sigs.length > 0) {
            const st = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true });
            const vals = (st as any)?.value || [];
            for (let i = 0; i < sigs.length; i += 1) {
              statusMap[sigs[i]] = vals[i] || null;
            }
          }
        } catch {}
      }

      const out = items.map((r: any) => ({
        ...r,
        status: statusMap[String(r.sig || '')] || null,
      }));
      res.json({ items: out });
    } catch (e: any) {
      logger.error('drift: tx-history failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift tx summary (JSONL-based)
  api.get('/drift/tx-summary', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const maxBytes = Math.max(256 * 1024, Number(q.maxBytes ?? ((CONFIG as any)?.drift?.txSummaryMaxBytes ?? 10_000_000)));
      const limit = Math.max(1000, Number(q.limit ?? 50_000));
      const { readAttemptHistory, summarizeAttemptRecords } = await import('../../drift/txTracker.js');
      const records = await readAttemptHistory({ limit, maxBytes });
      const windows: Record<string, number> = {
        '5m': 5 * 60_000,
        '1h': 60 * 60_000,
        '24h': 24 * 60 * 60_000,
      };
      const actions = ['fill', 'trigger', 'liquidate'] as const;
      const summary: any = {};
      for (const [label, ms] of Object.entries(windows)) {
        const byAction: any = { all: summarizeAttemptRecords(records, ms) };
        for (const a of actions) {
          byAction[a] = summarizeAttemptRecords(records, ms, a);
        }
        summary[label] = byAction;
      }
      res.json({ summary, count: records.length });
    } catch (e: any) {
      logger.error('drift: tx-summary failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


