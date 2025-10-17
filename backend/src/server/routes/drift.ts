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
      const debug = String((req.query as any)?.debug || '').trim() === '1';
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
            try { if (debug) logger.info('drift.route.user.debug', { mode: 'pda', userPk: String(inputPk?.toBase58?.() || inputPk), cat: 'drift' }); } catch {}
          }
        } catch {}
        // If not, treat input as an authority and resolve PDA (optionally using subAccountId)
        if (!sdkUser) {
          let targetUserPk: any = null;
          const q = req.query as any;
          const subId = Number(q?.subAccountId ?? q?.subaccountId ?? q?.subid ?? q?.id);
          if (Number.isFinite(subId)) {
            try { targetUserPk = await (client as any)?.getUserAccountPublicKey?.(Number(subId), inputPk) || await getUserAccountPublicKey((client as any)?.program?.programId, inputPk, Number(subId)); } catch {}
            try { if (debug && targetUserPk) logger.info('drift.route.user.debug', { mode: 'authority+subId', authority: String(inputPk?.toBase58?.() || inputPk), subId: Number(subId), resolvedPk: String(targetUserPk?.toBase58?.() || targetUserPk), cat: 'drift' }); } catch {}
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
            try { if (debug && targetUserPk) logger.info('drift.route.user.debug', { mode: 'authority+probe', authority: String(inputPk?.toBase58?.() || inputPk), resolvedPk: String(targetUserPk?.toBase58?.() || targetUserPk), cat: 'drift' }); } catch {}
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
      try { const sdk: any = await import('@drift-labs/sdk'); const cst: any = (sdk as any).constants || (sdk as any); if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION); } catch {}
      const toUi = (v: any) => Number(v?.toString?.() || v || 0) / QUOTE_PREC;
      const collateral = {
        total: Number((sdkUser as any)?.getTotalCollateral?.() || 0),
        maintenance: Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0),
        free: Number((sdkUser as any)?.getFreeCollateral?.()?.toString?.() || (sdkUser as any)?.getFreeCollateral?.() || 0),
        totalUi: toUi((sdkUser as any)?.getTotalCollateral?.()),
        maintUi: toUi((sdkUser as any)?.getMaintenanceMarginRequirement?.()),
        freeUi: toUi((sdkUser as any)?.getFreeCollateral?.()),
      } as any;
      try { if (debug) logger.info('drift.route.user.debug', { phase: 'collateral', total: collateral.totalUi, maint: collateral.maintUi, free: collateral.freeUi, cat: 'drift' }); } catch {}

      // Spot collateral
      const spotCollateral: Array<{ marketIndex: number; symbol?: string; amountUi: number; amountRaw: number; mint?: string; decimals?: number; balanceType?: 'deposit' | 'borrow' }> = [];
      try {
        const spots = (sdkUser as any)?.getSpotPositions?.() || [];
        try { if (debug) logger.info('drift.route.user.debug', { phase: 'spots_count', count: Array.isArray(spots) ? spots.length : 0, cat: 'drift' }); } catch {}
        for (const sp of (spots || [])) {
          try {
            const idx = Number(sp?.marketIndex ?? sp?.market_index ?? sp?.market?.index);
            if (!Number.isFinite(idx)) continue;
            const mktAcc = await client?.getSpotMarketAccount?.(idx);
            const decimals = Number(mktAcc?.decimals ?? 6);
            const mint = String(mktAcc?.mint ?? '');
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
            const amountUi = Number.isFinite(amountRaw) ? (amountRaw / Math.pow(10, decimals)) : 0;
            let symbol = (mktAcc?.name || mktAcc?.symbol || '')?.toString?.()?.replace?.(/\0+$/g, '') || undefined;
            if (!symbol || symbol === '0') {
              try {
                const sdk: any = await import('@drift-labs/sdk');
                const constants: any = (sdk as any).constants || (sdk as any);
                const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
                const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
                const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
                const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === idx) : null;
                if (found) {
                  symbol = String(found?.symbol || found?.name || symbol || '').replace(/\0+$/g, '') || symbol;
                }
              } catch {}
            }
            if (amountUi !== 0) {
              const balanceType: 'deposit' | 'borrow' = (amountRaw < 0 || amountUi < 0) ? 'borrow' : 'deposit';
              spotCollateral.push({ marketIndex: idx, symbol, amountUi, amountRaw, mint, decimals, balanceType });
              try { if (debug) logger.info('drift.route.user.debug', { phase: 'spot_item', idx, symbol, mint, amountUi, amountRaw, balanceType, cat: 'drift' }); } catch {}
            }
          } catch {}
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

      try { if (debug) logger.info('drift.route.user.debug', { phase: 'done', spotCount: spotCollateral.length, perpCount: perpPositions.length, cat: 'drift' }); } catch {}
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
          try { if (typeof user.subscribe === 'function') { await user.subscribe(); } } catch {}
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

  return api;
}


