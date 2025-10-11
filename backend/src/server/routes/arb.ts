import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { writeJson } from '../../utils/fs.js';
import { logTxTrace } from '../../utils/txTrace.js';

export function createArbRouter(io: SocketIOServer): Router {
  const api = Router();

  // In-memory execution timing rings and counters (bounded)
  const execStats: {
    buildMs: number[];
    preflightMs: number[];
    sendMs: number[];
    preflightOk: number; preflightErr: number;
    sendOk: number; sendErr: number;
  } = { buildMs: [], preflightMs: [], sendMs: [], preflightOk: 0, preflightErr: 0, sendOk: 0, sendErr: 0 };
  const pushBounded = (arr: number[], v: number, cap = 200) => { if (Number.isFinite(v)) { arr.push(v); if (arr.length > cap) arr.shift(); } };
  const pct = (arr: number[], p: number): number | null => { if (!arr.length) return null; const a = arr.slice().sort((x,y)=>x-y); const i = Math.min(a.length-1, Math.max(0, Math.floor((p/100)*(a.length-1)))); return a[i] ?? null; };
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
      let j: any = r ? await r.json().catch(() => ({})) : {};
      try {
        const { getPoolsMetrics, getPoolCacheAges } = await import('../pools.js');
        const pm = getPoolsMetrics();
        const ages = getPoolCacheAges();
        // Merge exec stats and graph push stats
        const { getGraphPushStats } = await import('../realtime.js');
        const exec = {
          build_ms: { p50: pct(execStats.buildMs, 50), p95: pct(execStats.buildMs, 95) },
          preflight_ms: { p50: pct(execStats.preflightMs, 50), p95: pct(execStats.preflightMs, 95) },
          send_ms: { p50: pct(execStats.sendMs, 50), p95: pct(execStats.sendMs, 95) },
          counts: { preflight_ok: execStats.preflightOk, preflight_err: execStats.preflightErr, send_ok: execStats.sendOk, send_err: execStats.sendErr },
        };
        const graph_push = getGraphPushStats();
        j = { ...(j || {}), pools: { ...(j?.pools || {}), ...pm }, pools_age_ms: ages, exec, graph_push };
      } catch {}
      res.status(r?.status || 200).json(j);
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
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate start', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.START' } }); } catch {}
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { buildDirectArbTx } = await import('../../execution/builder/tx.js');
      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const tBuild0 = Date.now();
      const built = await buildDirectArbTx(plan, [], {} as any);
      try { pushBounded(execStats.buildMs, Date.now() - tBuild0); } catch {}
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT' } }); } catch {}
      const id = Math.random().toString(36).slice(2,10);
      await logTxTrace('simulate', {
        id, timeMs: Date.now(),
        path: plan.path,
        hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })),
        ixCount: built.ixCount, txSizeBytes: built.sizeBytes,
      });
      res.json({ id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // New endpoint: simulate fully assembled tx on-chain and return logs (no send)
  api.post('/arb/simulate-send', async (req, res) => {
    try {
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate start', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.START' } }); } catch {}
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { buildDirectArbTx } = await import('../../execution/builder/tx.js');
      const { assembleAndSimulate } = await import('../../execution/sender.js');
      const { loadExecConfig } = await import('../execConfigStore.js');

      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const built = await buildDirectArbTx(plan, [], {} as any);
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT' } }); } catch {}

      const execCfg = await loadExecConfig();
      const tPre0 = Date.now();
      const sim = await assembleAndSimulate(built.tx.instructions, {
        computeUnitLimit: execCfg.computeUnitLimit,
        computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
        lookupTableAddresses: execCfg.lookupTableAddresses,
      } as any);
      try { pushBounded(execStats.preflightMs, Date.now() - tPre0); } catch {}

      const id = Math.random().toString(36).slice(2,10);
      await logTxTrace('preflight', {
        id, timeMs: Date.now(),
        path: plan.path,
        hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })),
        ixCount: built.ixCount, txSizeBytes: built.sizeBytes,
        exec: {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: execCfg.lookupTableAddresses,
        },
        wireBase64: (sim as any)?.wireBase64,
        logs: sim.logs || [],
        err: sim.err || null,
      });
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate result', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.END', ...(sim as any)?.err ? { err: String((sim as any).err) } : {} } }); } catch {}
      try {
        const { addTxRecord } = await import('../txHistory.js');
        await addTxRecord({
          id,
          timeMs: Date.now(),
          path: plan.path,
          hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })),
          ixCount: built.ixCount,
          txSizeBytes: built.sizeBytes,
          signature: null,
          status: (sim as any)?.err ? 'sim_err' : 'sim_ok',
          error: (sim as any)?.err ? String((sim as any)?.err) : undefined,
        });
        try { emit('tx:history.updated', { id, status: (sim as any)?.err ? 'sim_err' : 'sim_ok' }); } catch {}
      } catch {}
      res.json({ id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, logs: sim.logs || [], err: sim.err || null });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/execute', async (req, res) => {
    try {
      try { emit('log', { level: 'info', message: 'pretrade:arb execute start', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.EXEC.START' } }); } catch {}
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { buildDirectArbTx } = await import('../../execution/builder/tx.js');
      const { assembleAndSend, assembleAndSimulate } = await import('../../execution/sender.js');
      const { addTxRecord } = await import('../txHistory.js');
      const { loadExecConfig } = await import('../execConfigStore.js');

      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const built = await buildDirectArbTx(plan, [], {} as any);
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT' } }); } catch {}

      const id = Math.random().toString(36).slice(2,10);

      const execCfg = await loadExecConfig();
      const mode = (execCfg.mode || 'simulate');
      if (mode !== 'direct') {
        return res.json({ id, mode, signature: null, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
      }

      // Atomic only: fail if oversized
      const maxBytes = Number(execCfg.maxTxSizeBytes || 0);
      if (maxBytes > 0 && built.sizeBytes > maxBytes) {
        return res.status(400).json({ id, mode, error: 'tx_too_large', ixCount: built.ixCount, txSizeBytes: built.sizeBytes, maxTxSizeBytes: maxBytes });
      }

      // Require successful preflight before sending
      const sim = await assembleAndSimulate(built.tx.instructions, {
        computeUnitLimit: execCfg.computeUnitLimit,
        computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
        lookupTableAddresses: execCfg.lookupTableAddresses,
      } as any);
      await logTxTrace('preflight', {
        id, timeMs: Date.now(),
        path: plan.path,
        hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })),
        ixCount: built.ixCount, txSizeBytes: built.sizeBytes,
        exec: {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: execCfg.lookupTableAddresses,
        },
        wireBase64: (sim as any)?.wireBase64,
        logs: (sim as any)?.logs || [],
        err: (sim as any)?.err || null,
      });
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate result', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.END', ...(sim as any)?.err ? { err: String((sim as any).err) } : {} } }); } catch {}
      if ((sim as any)?.err) {
        try { execStats.preflightErr += 1; } catch {}
        try {
          await addTxRecord({ id, timeMs: Date.now(), path: plan.path, hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })), ixCount: built.ixCount, txSizeBytes: built.sizeBytes, signature: null, status: 'sim_err', error: String((sim as any)?.err) });
          try { emit('tx:history.updated', { id, status: 'sim_err' }); } catch {}
        } catch {}
        return res.status(400).json({ id, mode, error: 'preflight_failed', logs: (sim as any)?.logs || [], ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
      }
      try { execStats.preflightOk += 1; } catch {}

      // Proceed to send (no chunking)
      try {
        const tSend0 = Date.now();
        const sendRes = await assembleAndSend(built.tx.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: execCfg.lookupTableAddresses,
        } as any);
        try { pushBounded(execStats.sendMs, Date.now() - tSend0); execStats.sendOk += 1; } catch {}
        const signatures: string[] = [sendRes.signature];
        const signature = signatures[signatures.length - 1] || null;
        await logTxTrace('send', {
          id, timeMs: Date.now(),
          path: plan.path,
          hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })),
          ixCount: built.ixCount, txSizeBytes: built.sizeBytes,
          exec: {
            computeUnitLimit: execCfg.computeUnitLimit,
            computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
            lookupTableAddresses: execCfg.lookupTableAddresses,
          },
          wireBase64: (sendRes as any)?.wireBase64,
          signature,
        });
        try { emit('tx:history.updated', { id, status: signature ? 'send_ok' : 'send_err' }); } catch {}
        await addTxRecord({ id, timeMs: Date.now(), path: plan.path, hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })), ixCount: built.ixCount, txSizeBytes: built.sizeBytes, signature, status: signature ? 'send_ok' : 'send_err' });
        try { emit('log', { level: 'info', message: signature ? 'arb:send ok' : 'arb:send err', timestamp: new Date().toISOString(), context: { cat: 'arb', ...(signature ? { signature } : {}) } }); } catch {}
        res.json({ id, mode, signature, signatures, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
      } catch (e: any) {
        try { execStats.sendErr += 1; } catch {}
        try {
          await addTxRecord({ id, timeMs: Date.now(), path: plan.path, hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })), ixCount: built.ixCount, txSizeBytes: built.sizeBytes, signature: null, status: 'send_err', error: String(e?.message || e) });
          try { emit('tx:history.updated', { id, status: 'send_err' }); } catch {}
        } catch {}
        return res.status(400).json({ id, mode, error: 'send_failed' });
      }
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


