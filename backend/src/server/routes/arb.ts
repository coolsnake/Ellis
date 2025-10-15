import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { emit } from '../realtime.js';
import { setArbStreamEnabled } from '../realtime.js';
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
      const wantEnable: boolean = !!(body && (body as any).enable);
      // Only include graph when non-empty
      const includeGraph = !!(snap && Array.isArray((snap as any).edges) && (snap as any).edges.length > 0);
      const payload = includeGraph ? { graph: snap, ...body } : { ...body };
      const r = await fetch(`${host}/arb/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => null);
      const status = r?.status || 503;
      const j = r ? await r.json().catch(() => ({})) : { ok: false };
      // Gate streaming based on requested enable flag only when arb-rs responded OK
      try { if (r && r.ok) setArbStreamEnabled(wantEnable); } catch {}
      res.status(status).json(j);
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
      const { loadExecConfig } = await import('../execConfigStore.js');
      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      const execCfg = await loadExecConfig();
      const tBuild0 = Date.now();
      const built = await buildDirectArbTx(plan, [], {} as any);
      try { pushBounded(execStats.buildMs, Date.now() - tBuild0); } catch {}
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}
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
      const execCfg = await loadExecConfig();
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}
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
      try {
        if ((sim as any)?.err) {
          logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0, error: String((sim as any)?.err) } as any });
        } else {
          logger.info('tx.preflight.ok', { cat: 'tx', code: LogCode.TX_PREFLIGHT_OK, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0 } as any });
        }
      } catch {}
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
      try { logger.info('pretrade:arb execute start', { cat: 'arb', code: LogCode.API_REQUEST }); } catch {}
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
      const execCfg = await loadExecConfig();
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}

      const id = Math.random().toString(36).slice(2,10);
      const mode = (execCfg.mode || 'simulate');
      const forceDirect = !!(input && (input as any).forceDirect);
      if (mode !== 'direct' && !forceDirect) {
        return res.json({ id, mode, signature: null, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
      }

      // Ensure wallet is available and report address for diagnostics
      try {
        const { CONFIG } = await import('../../utils/config.js');
        const walletMod: any = await import('../../wallet/wallet.js');
        const kp = await walletMod.ensureWallet(CONFIG.walletPath);
        try { logger.info('wallet.ready', { cat: 'wallet', ctx: { address: kp.publicKey.toBase58() } as any }); } catch {}
      } catch (e: any) {
        try { logger.info('wallet.missing', { cat: 'wallet', ctx: { error: String(e?.message || e) } as any }); } catch {}
        return res.status(400).json({ id, mode, error: 'wallet_not_found' });
      }

      // Atomic only: fail if oversized
      const maxBytes = Number(execCfg.maxTxSizeBytes || 0);
      if (maxBytes > 0 && built.sizeBytes > maxBytes) {
        return res.status(400).json({ id, mode, error: 'tx_too_large', ixCount: built.ixCount, txSizeBytes: built.sizeBytes, maxTxSizeBytes: maxBytes });
      }

      // Require successful preflight before sending
      try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode } as any }); } catch {}
      let sim: any;
      try {
        sim = await assembleAndSimulate(built.tx.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: execCfg.lookupTableAddresses,
        } as any);
      } catch (e: any) {
        try { logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, error: String(e?.message || e) } as any }); } catch {}
        return res.status(400).json({ id, mode, error: 'preflight_throw' });
      }
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
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate result', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.END', mode: (execCfg as any)?.mode, ...(sim as any)?.err ? { err: String((sim as any).err) } : {} } }); } catch {}
      try {
        if ((sim as any)?.err) {
          logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0, error: String((sim as any)?.err) } as any });
        } else {
          logger.info('tx.preflight.ok', { cat: 'tx', code: LogCode.TX_PREFLIGHT_OK, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0 } as any });
        }
      } catch {}
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
        try { logger.info('tx.send.ok', { cat: 'tx', code: LogCode.TX_SEND_OK, ctx: { id, signature, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode } as any }); } catch {}
        try { emit('tx:history.updated', { id, status: signature ? 'send_ok' : 'send_err' }); } catch {}
        await addTxRecord({ id, timeMs: Date.now(), path: plan.path, hops: plan.hops.map((h:any)=>({ dex:h.dex, variant:h.variant, poolId:h.poolId })), ixCount: built.ixCount, txSizeBytes: built.sizeBytes, signature, status: signature ? 'send_ok' : 'send_err' });
        // Notify arb-rs that this opportunity path has been executed (best-effort)
        try {
          const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
          const secret = process.env.ARB_SHARED_SECRET;
          const dexes = Array.from(new Set((plan.hops || []).map((h:any) => String(h?.dex || '')))).filter(Boolean).sort();
          await fetch(`${host}/arb/opportunity/executed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
            body: JSON.stringify({ path: plan.path, dexes }),
          }).catch(() => null);
        } catch {}
        try { emit('log', { level: 'info', message: signature ? 'arb:send ok' : 'arb:send err', timestamp: new Date().toISOString(), context: { cat: 'arb', mode: forceDirect ? 'direct(force)' : mode, ...(signature ? { signature } : {}) } }); } catch {}
        res.json({ id, mode: forceDirect ? 'direct(force)' : mode, signature, signatures, ixCount: built.ixCount, txSizeBytes: built.sizeBytes });
      } catch (e: any) {
        try { execStats.sendErr += 1; } catch {}
        try {
          try { logger.info('tx.send.err', { cat: 'tx', code: LogCode.TX_SEND_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, error: String(e?.message || e) } as any }); } catch {}
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
      logger.debug(`api.request POST /arb-service/config`, { url: `${host}/config`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body || {}), signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.debug(`api.response POST /arb-service/config ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
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


