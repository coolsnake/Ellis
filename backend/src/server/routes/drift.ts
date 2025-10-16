import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';

export function createDriftRouter(io: SocketIOServer): Router {
  const api = Router();
  // serialize subaccount mutations to reduce concurrent RPC bursts
  const subMutex = new Map<number, Promise<any>>();

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
      const out = created || { id: Number((CONFIG as any).drift?.defaultSubaccountId || 0) };
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
        const { User, BulkAccountLoader } = await import('@drift-labs/sdk');
        // Resolve the specific subaccount PDA and instantiate a User for it
        const userPk = await client?.getUserAccountPublicKey?.(Number(subId));
        if (userPk) {
          // Prefer the shared loader from client init if available; otherwise create a lightweight one
          const loader: any = (svc as any)?.loader || new BulkAccountLoader((svc as any)?.connection, 'confirmed', 1000);
          user = new User({ driftClient: client, userAccountPublicKey: userPk, accountSubscription: { type: 'polling', accountLoader: loader } });
          try { if (typeof user.subscribe === 'function') { await user.subscribe(); } } catch {}
        }
      } catch {}
      // Fallback to active user if targeted subaccount is unavailable
      if (!user) user = client?.user;
      const spotPositions = user?.getSpotPositions?.() || [];
      const out: Array<{ marketIndex: number; balance: number; amount: number; symbol?: string; mint?: string; decimals?: number }> = [];
      for (const p of spotPositions) {
        try {
          const idx = Number(p?.marketIndex ?? p?.market_index ?? 0);
          let bal = Number(p?.scaledBalance?.toString?.() || 0) || Number(p?.balance || 0);
          let symbol: string | undefined = undefined;
          let mint: string | undefined = undefined;
          let decimals: number | undefined = undefined;
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const constants: any = (sdk as any).constants || (sdk as any);
            const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
            const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
            const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
            const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === idx) : null;
            if (found) {
              symbol = String(found?.symbol || found?.name || '').trim() || undefined;
              mint = String(found?.mint || found?.mintAddress || found?.address || '');
              decimals = Number(found?.decimals ?? found?.precision ?? 6);
              if (typeof decimals === 'number' && decimals >= 0) {
                const scale = Math.pow(10, decimals);
                if (scale > 0 && isFinite(scale)) {
                  bal = bal / scale;
                }
              }
            }
          } catch {}
          out.push({ marketIndex: idx, balance: bal, amount: bal, symbol, mint, decimals });
        } catch {}
      }
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

  return api;
}


