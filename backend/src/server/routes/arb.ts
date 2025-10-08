import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { writeJson } from '../../utils/fs.js';

export function createArbRouter(io: SocketIOServer): Router {
  const api = Router();
  api.get('/arb/config', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/config`).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch {
      res.status(503).json({ ok: false });
    }
  });


  api.get('/arb/graph/version', async (_req, res) => {
    try {
      const { getGraphVersion } = await import('../graph.js');
      const v = getGraphVersion();
      res.json(v);
    } catch {
      res.json({ version: 0 });
    }
  });

  api.get('/arb/opportunities', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const started = Date.now();
      const r = await fetch(`${host}/opportunities`).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  api.get('/arb/health', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/health`).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  api.get('/arb/metrics', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/metrics`).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  api.get('/arb/metrics/json', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/metrics/json`).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  api.post('/arb/start', async (req, res) => {
    try {
      const body = req.body || {};
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(true);
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/arb/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ graph: snap, ...body }) }).catch(() => null);
      res.status(r?.status || 503).json(r ? await r.json().catch(() => ({})) : { ok: false });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.post('/arb/simulate', async (req, res) => {
    try {
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { buildDirectArbTx } = await import('../../execution/builder/tx.js');
      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const built = await buildDirectArbTx(plan, [], {} as any);
      res.json({ ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/execute', async (req, res) => {
    try {
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { buildDirectArbTx } = await import('../../execution/builder/tx.js');
      const { addTxRecord } = await import('../txHistory.js');
      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const built = await buildDirectArbTx(plan, [], {} as any);
      await addTxRecord({ id: Math.random().toString(36).slice(2,10), timeMs: Date.now(), path: plan.path, hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })), ixCount: built.ixCount, txSizeBytes: built.sizeBytes, signature: null, status: 'sim_ok' });
      res.json({ signature: null, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  api.get('/arb/tx-history', async (_req: Request, res: Response) => {
    try {
      const { getTxHistory } = await import('../txHistory.js');
      const items = await getTxHistory(50);
      res.json({ items });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/config', async (req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request POST /arb-service/config`, { url: `${host}/config`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body || {}), signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.info(`api.response POST /arb-service/config ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      let json: any = {};
      try { json = await r.json(); } catch { json = {}; }
      try {
        const changedKeys = Object.keys(req.body || {});
        emit('log', { level: r.ok ? 'info' : 'warn', message: `arb:config update keys=[${changedKeys.join(',')}] status=${r.status}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
        emit('log', { level: r.ok ? 'info' : 'warn', message: `terminal: Arbitrage configuration ${r.ok ? 'updated' : 'update failed'} (${r.status})`, timestamp: new Date().toISOString() });
      } catch {}
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      res.status(r.status).json(json);
    } catch (e: any) {
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      res.status(503).json({ ok: false, error: 'arb service unreachable; config saved locally' });
    }
  });

  return api;
}


