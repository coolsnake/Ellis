import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { emit } from '../realtime.js';
import { setArbStreamEnabled } from '../realtime.js';
import { writeJson, readJson } from '../../utils/fs.js';
import { logTxTrace } from '../../utils/txTrace.js';

export function createArbRouter(io: SocketIOServer): Router {
  const api = Router();

  const toErrString = (e: any): string => {
    try {
      if (!e) return 'null';
      if (typeof e === 'string') return e;
      if (e instanceof Error) return e.message;
      // Prefer InstructionError / logs details when present
      const obj: any = e;
      if (obj.InstructionError) {
        try { return JSON.stringify(obj); } catch {}
        return String(obj.InstructionError);
      }
      try { return JSON.stringify(obj); } catch {}
      return String(obj);
    } catch {
      return 'err_format_failed';
    }
  };

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
      const remote = r ? await r.json().catch(() => ({})) : {};
      // Merge in locally saved UI-only fields (e.g., edge_allow)
      let local: any = {};
      try { local = await readJson('backend/config/arbConfig.json', {} as any); } catch {}
      const merged = { ...(remote || {}), ...(local || {}) };
      res.status(r?.status || 200).json(merged);
    } catch {
      // Fallback: serve local file if arb service unavailable
      try {
        const local = await readJson('backend/config/arbConfig.json', {} as any);
        return res.status(200).json(local || {});
      } catch {}
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

  // Trigger a one-off Raydium CLMM static precompute for a pool id
  api.post('/arb/clmm/refresh', async (req: Request, res: Response) => {
    try {
      const poolId = String((req.body && (req.body as any).poolId) || (req.query && (req.query as any).poolId) || '');
      if (!poolId) return res.status(400).json({ error: 'poolId required' });
      const { refreshRaydiumClmm } = await import('../tasks/refreshClmm.js');
      await refreshRaydiumClmm(poolId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
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
      // Build a resolve input from provided plan (if any), otherwise use parsed arrays
      const basePlan = (input && (input as any).plan && Array.isArray((input as any).plan?.hops)) ? (input as any).plan : undefined;
      const resolveInput = basePlan
        ? {
            path: basePlan.path,
            hopPoolIds: basePlan.hops.map((h: any) => String(h.poolId)),
            dexes: basePlan.hops.map((h: any) => String(h.dex)),
            size: (input as any).size,
            sizeUsd: (input as any).sizeUsd,
            slippageBps: (input as any).slippageBps,
          }
        : (parsed as any);
      // Always resolve using the quote’s path/pools/dexes -> fills mints, decimals, and amounts
      const plan = await resolveDirectPlan(resolveInput as any, {} as any);
      // Apply optional per-hop overrides from the provided quote/plan
      if (basePlan) {
        for (let i = 0; i < plan.hops.length && i < basePlan.hops.length; i += 1) {
          const src = basePlan.hops[i] as any;
          if (src.inputMint)  plan.hops[i].inputMint  = String(src.inputMint);
          if (src.outputMint) plan.hops[i].outputMint = String(src.outputMint);
          if (src.amountInRaw !== undefined && src.amountInRaw !== null) {
            try {
              const v = BigInt(String(src.amountInRaw));
              if (v > 0n) plan.hops[i].amountInRaw = v; // ignore zero overrides
            } catch {}
          }
          if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
            try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
          }
        }
      }
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
      const { writeDexFullDump } = await import('../../utils/txTrace.js');
      const { loadExecConfig } = await import('../execConfigStore.js');

      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const basePlan = (input && (input as any).plan && Array.isArray((input as any).plan?.hops)) ? (input as any).plan : undefined;
      const resolveInput = basePlan
        ? {
            path: basePlan.path,
            hopPoolIds: basePlan.hops.map((h: any) => String(h.poolId)),
            dexes: basePlan.hops.map((h: any) => String(h.dex)),
            size: (input as any).size,
            sizeUsd: (input as any).sizeUsd,
            slippageBps: (input as any).slippageBps,
          }
        : (parsed as any);
      const plan = await resolveDirectPlan(resolveInput as any, {} as any);
      if (basePlan) {
        for (let i = 0; i < plan.hops.length && i < basePlan.hops.length; i += 1) {
          const src = basePlan.hops[i] as any;
          if (src.inputMint)  plan.hops[i].inputMint  = String(src.inputMint);
          if (src.outputMint) plan.hops[i].outputMint = String(src.outputMint);
          if (src.amountInRaw !== undefined && src.amountInRaw !== null) {
            try {
              const v = BigInt(String(src.amountInRaw));
              if (v > 0n) plan.hops[i].amountInRaw = v; // ignore zero overrides
            } catch {}
          }
          if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
            try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
          }
        }
      }
      // Build intent early so we log even if build fails
      const { executionCache } = await import('../../execution/cache.js');
      const earlyIntent = {
        path: plan.path,
        hops: (plan.hops || []).map((h: any) => ({
          dex: h.dex, variant: h.variant, poolId: h.poolId, programId: h.programId,
          inputMint: h.inputMint, outputMint: h.outputMint,
          inputDecimals: h.inputDecimals, outputDecimals: h.outputDecimals,
          inputTokenProgram: h.inputTokenProgram, outputTokenProgram: h.outputTokenProgram,
          amountInRaw: (typeof h.amountInRaw === 'bigint') ? h.amountInRaw.toString() : String(h.amountInRaw || 0),
          minOutRaw: (typeof h.minOutRaw === 'bigint') ? h.minOutRaw.toString() : String(h.minOutRaw || 0),
          userSourceAta: h.userSourceAta, userDestAta: h.userDestAta,
          ...(h.vaultA ? { vaultA: h.vaultA } : {}),
          ...(h.vaultB ? { vaultB: h.vaultB } : {}),
          ...(h.tickSpacing ? { tickSpacing: h.tickSpacing } : {}),
          ...(h.sqrtPriceLimitX64 ? { sqrtPriceLimitX64: String(h.sqrtPriceLimitX64) } : {}),
          ...(h.oracle ? { oracle: h.oracle } : {}),
          ...(h.tickArrayLower ? { tickArrayLower: h.tickArrayLower } : {}),
          ...(h.tickArrayCenter ? { tickArrayCenter: h.tickArrayCenter } : {}),
          ...(h.tickArrayUpper ? { tickArrayUpper: h.tickArrayUpper } : {}),
          ...(h.binStep ? { binStep: h.binStep } : {}),
          ...(h.activeId ? { activeId: h.activeId } : {}),
          ...(h.binArrayLower ? { binArrayLower: h.binArrayLower } : {}),
          ...(h.binArrayUpper ? { binArrayUpper: h.binArrayUpper } : {}),
          ...(h.reserveX ? { reserveX: h.reserveX } : {}),
          ...(h.reserveY ? { reserveY: h.reserveY } : {}),
        })),
        poolCache: (plan.hops || []).map((h: any) => {
          const st = executionCache.getStatic(h.poolId) || null;
          const hotRaw: any = executionCache.getHot(h.poolId) || null;
          const hot = hotRaw ? {
            sqrtPriceX64: (typeof hotRaw.sqrtPriceX64 === 'bigint') ? hotRaw.sqrtPriceX64.toString() : hotRaw.sqrtPriceX64,
            currentTickIndex: hotRaw.currentTickIndex,
            activeId: hotRaw.activeId,
            tickArrays: hotRaw.tickArrays,
            binArrays: hotRaw.binArrays,
          } : null;
          return { poolId: h.poolId, programId: h.programId, static: st, hot };
        }),
      } as any;
      const id = Math.random().toString(36).slice(2,10);
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent: earlyIntent } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent: earlyIntent } }); } catch {}

      // use early id

      const built = await buildDirectArbTx(plan, [], {} as any);
      const execCfg = await loadExecConfig();

      // Build intent + pool cache + ix summaries for tracing
      const intent = {
        path: plan.path,
        hops: (plan.hops || []).map((h: any) => ({
          dex: h.dex, variant: h.variant, poolId: h.poolId, programId: h.programId,
          inputMint: h.inputMint, outputMint: h.outputMint,
          inputDecimals: h.inputDecimals, outputDecimals: h.outputDecimals,
          inputTokenProgram: h.inputTokenProgram, outputTokenProgram: h.outputTokenProgram,
          amountInRaw: (typeof h.amountInRaw === 'bigint') ? h.amountInRaw.toString() : String(h.amountInRaw || 0),
          minOutRaw: (typeof h.minOutRaw === 'bigint') ? h.minOutRaw.toString() : String(h.minOutRaw || 0),
          userSourceAta: h.userSourceAta, userDestAta: h.userDestAta,
          ...(h.vaultA ? { vaultA: h.vaultA } : {}),
          ...(h.vaultB ? { vaultB: h.vaultB } : {}),
          ...(h.tickSpacing ? { tickSpacing: h.tickSpacing } : {}),
          ...(h.sqrtPriceLimitX64 ? { sqrtPriceLimitX64: String(h.sqrtPriceLimitX64) } : {}),
          ...(h.oracle ? { oracle: h.oracle } : {}),
          ...(h.tickArrayLower ? { tickArrayLower: h.tickArrayLower } : {}),
          ...(h.tickArrayCenter ? { tickArrayCenter: h.tickArrayCenter } : {}),
          ...(h.tickArrayUpper ? { tickArrayUpper: h.tickArrayUpper } : {}),
          // Raydium AMM/Serum
          ...(h.ammAuthority ? { ammAuthority: h.ammAuthority } : {}),
          ...(h.ammOpenOrders ? { ammOpenOrders: h.ammOpenOrders } : {}),
          ...(h.ammTargetOrders ? { ammTargetOrders: h.ammTargetOrders } : {}),
          ...(h.serumProgramId ? { serumProgramId: h.serumProgramId } : {}),
          ...(h.market ? { market: h.market } : {}),
          ...(h.bids ? { bids: h.bids } : {}),
          ...(h.asks ? { asks: h.asks } : {}),
          ...(h.eventQueue ? { eventQueue: h.eventQueue } : {}),
          ...(h.coinVault ? { coinVault: h.coinVault } : {}),
          ...(h.pcVault ? { pcVault: h.pcVault } : {}),
          ...(h.vaultSigner ? { vaultSigner: h.vaultSigner } : {}),
          // Meteora DLMM
          ...(h.binStep ? { binStep: h.binStep } : {}),
          ...(h.activeId ? { activeId: h.activeId } : {}),
          ...(h.binArrayLower ? { binArrayLower: h.binArrayLower } : {}),
          ...(h.binArrayUpper ? { binArrayUpper: h.binArrayUpper } : {}),
          ...(h.reserveX ? { reserveX: h.reserveX } : {}),
          ...(h.reserveY ? { reserveY: h.reserveY } : {}),
        })),
        poolCache: (plan.hops || []).map((h: any) => {
          const st = executionCache.getStatic(h.poolId) || null;
          const hotRaw: any = executionCache.getHot(h.poolId) || null;
          const hot = hotRaw ? {
            sqrtPriceX64: (typeof hotRaw.sqrtPriceX64 === 'bigint') ? hotRaw.sqrtPriceX64.toString() : hotRaw.sqrtPriceX64,
            currentTickIndex: hotRaw.currentTickIndex,
            activeId: hotRaw.activeId,
            tickArrays: hotRaw.tickArrays,
            binArrays: hotRaw.binArrays,
          } : null;
          return { poolId: h.poolId, programId: h.programId, static: st, hot };
        }),
      } as any;
      const ixs = (Array.isArray((built as any)?.tx?.instructions) ? (built as any).tx.instructions : []).map((ix: any) => {
        try {
          const pidLike = (ix?.programId) ?? (ix?.programAddress) ?? (ix?.program && (ix.program.address || ix.program));
          const pid = (pidLike && typeof pidLike.toBase58 === 'function') ? pidLike.toBase58() : String(pidLike || '');
          const keysSrc: any[] = Array.isArray(ix?.keys) ? ix.keys : [];
          const accounts = keysSrc.map((k: any) => {
            const pkLike = (k?.pubkey) ?? (k?.pubKey) ?? (k?.address);
            const pk = (pkLike && typeof pkLike.toBase58 === 'function') ? pkLike.toBase58() : String(pkLike || '');
            return { pk, s: !!k?.isSigner, w: !!k?.isWritable };
          });
          const dataLen = (ix?.data && typeof (ix.data as any).length === 'number') ? Number((ix.data as any).length) : 0;
          return { pid, dataLen, accounts };
        } catch { return { pid: String(ix?.programId || ''), dataLen: 0, accounts: [] }; }
      });

      // (duplicate block removed)
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}
      const tPre0 = Date.now();
      const sim = await assembleAndSimulate(built.tx.instructions, {
        computeUnitLimit: execCfg.computeUnitLimit,
        computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
        lookupTableAddresses: execCfg.lookupTableAddresses,
      } as any);
      try {
        const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
        for (const d of dexes) {
          if (d === 'raydium' || d === 'orca' || d === 'meteora') {
            await writeDexFullDump(d as any, 'preflight', {
              id: Math.random().toString(36).slice(2,10),
              path: plan.path,
              hops: plan.hops,
              exec: execCfg,
              built,
              sim,
            });
          }
        }
      } catch {}
      try { pushBounded(execStats.preflightMs, Date.now() - tPre0); } catch {}

      // reuse early id
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent } as any }); } catch {}
      try { logger.info('tx.ixs', { cat: 'tx', ctx: { id, ixCount: built.ixCount, items: ixs } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent } }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.ixs', context: { cat: 'tx', id, ixCount: built.ixCount, items: ixs } }); } catch {}
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
        intent,
        ixs,
        wireBase64: (sim as any)?.wireBase64,
        logs: sim.logs || [],
        err: sim.err || null,
      });
      try {
        if ((sim as any)?.err) {
          const errStr = toErrString((sim as any)?.err);
          logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0, error: errStr } as any });
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

  // Jupiter: atomic roundtrip SOL->USDC->SOL
  api.post('/arb/jupiter/roundtrip', async (req, res) => {
    try {
      const body = req.body || {};
      const sizeSol = Number.isFinite(body?.sizeSol) ? Number(body.sizeSol) : 0.01;
      const slippageBps = Number.isFinite(body?.slippageBps) ? Number(body.slippageBps) : 50;
      try { logger.info('jupiter.trade.api.roundtrip', { cat: 'jupiter', sizeSol, slippageBps }); } catch {}
      const { executeRoundtripWithJupiter } = await import('../../jupiter/arbExecutor.js');
      const r = await executeRoundtripWithJupiter({ sizeSol, slippageBps });
      res.json({ signature: r.signature });
    } catch (e: any) {
      try { logger.info('jupiter.trade.api.roundtrip.err', { cat: 'jupiter', error: String(e?.message || e) }); } catch {}
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Jupiter: atomic path execute with per-hop DEX enforcement and strict min-outs
  api.post('/arb/jupiter/execute', async (req, res) => {
    try {
      const body = req.body || {};
      const path: string[] = Array.isArray(body.path) ? body.path : [];
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'invalid path' });
      const sizeTokens = Number.isFinite(body.size) ? Number(body.size) : undefined;
      const sizeUsd = Number.isFinite(body.sizeUsd) ? Number(body.sizeUsd) : undefined;
      const slippageBps = Number.isFinite(body.slippageBps) ? Number(body.slippageBps) : undefined;
      const hopDexes: string[] | undefined = Array.isArray(body.hopDexes) ? body.hopDexes : undefined;
      const hopRatesUi: number[] | undefined = Array.isArray(body.hopRates) ? body.hopRates : undefined;
      const hopMinOutsAtoms: number[] | undefined = Array.isArray(body.hopMinOutsAtoms) ? body.hopMinOutsAtoms : undefined;
      const strictMinOut = body.strictMinOut !== false;
      // Convert token size to atoms
      let sizeAtoms: number | undefined = undefined;
      if (Number.isFinite(sizeTokens)) {
        try { const { resolveMint } = await import('../../utils/tokens.js'); const dec0 = (await resolveMint(path[0])).decimals ?? 6; sizeAtoms = Math.max(0, Math.floor(Number(sizeTokens) * Math.pow(10, dec0))); } catch {}
      }
      try { logger.info('jupiter.trade.api.execute', { cat: 'jupiter', pathLen: path.length, size: sizeTokens, sizeUsd, slippageBps, strictMinOut, hopDexesLen: Array.isArray(hopDexes) ? hopDexes.length : 0 }); } catch {}
      const { executePlanWithJupiterStrict } = await import('../../jupiter/arbExecutor.js');
      const r = await executePlanWithJupiterStrict({ plan: { path }, sizeAtoms, sizeUsd, slippageBps, hopDexes, hopRatesUi, hopMinOutsAtoms, strictMinOut });
      res.json({ signature: r.signature });
    } catch (e: any) {
      try { logger.info('jupiter.trade.api.execute.err', { cat: 'jupiter', error: String(e?.message || e) }); } catch {}
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Jupiter: aggregate end-to-end execution (single aggregator instruction)
  api.post('/arb/jupiter/aggregate-execute', async (req, res) => {
    try {
      const body = req.body || {};
      const path: string[] = Array.isArray(body.path) ? body.path : [];
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'invalid path' });
      const inputMint = String(path[0]);
      const outputMint = String(path[path.length - 1]);

      // Convert token size (if provided) to atoms using input mint decimals
      let sizeAtoms: number | undefined;
      if (Number.isFinite(body.size)) {
        try { const { resolveMint } = await import('../../utils/tokens.js'); const dec0 = (await resolveMint(inputMint)).decimals ?? 6; sizeAtoms = Math.max(0, Math.floor(Number(body.size) * Math.pow(10, dec0))); } catch {}
      }
      const sizeUsd = Number.isFinite(body.sizeUsd) ? Number(body.sizeUsd) : undefined;
      const slippageBps = Number.isFinite(body.slippageBps) ? Number(body.slippageBps) : undefined;

      // Derive DEX family whitelist from hopDexes (Raydium/Orca/Meteora)
      const hopDexes: string[] = Array.isArray(body.hopDexes) ? body.hopDexes : [];
      const families = Array.from(new Set(hopDexes.map((x: string) => {
        const v = String(x || '').toLowerCase();
        if (v.includes('ray')) return 'Raydium';
        if (v.includes('orca')) return 'Orca';
        if (v.includes('meteora')) return 'Meteora';
        return x;
      })));

      const { executeAggregateWithJupiter } = await import('../../jupiter/arbExecutor.js');
      const r = await executeAggregateWithJupiter({ inputMint, outputMint, sizeAtoms, sizeUsd, slippageBps, dexWhitelist: families, wrapAndUnwrapSol: (body.wrapAndUnwrapSol !== false) });
      res.json({ signature: r.signature });
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
      const { writeDexFullDump } = await import('../../utils/txTrace.js');
      const { addTxRecord } = await import('../txHistory.js');
      const { loadExecConfig } = await import('../execConfigStore.js');

      const input = req.body || {};
      const parsed = ResolveDirectSchema.parse(input);
      const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
      // Build intent early so we log even if build fails
      const { executionCache } = await import('../../execution/cache.js');
      const intent = {
        path: plan.path,
        hops: (plan.hops || []).map((h: any) => ({
          dex: h.dex, variant: h.variant, poolId: h.poolId, programId: h.programId,
          inputMint: h.inputMint, outputMint: h.outputMint,
          inputDecimals: h.inputDecimals, outputDecimals: h.outputDecimals,
          inputTokenProgram: h.inputTokenProgram, outputTokenProgram: h.outputTokenProgram,
          amountInRaw: (typeof h.amountInRaw === 'bigint') ? h.amountInRaw.toString() : String(h.amountInRaw || 0),
          minOutRaw: (typeof h.minOutRaw === 'bigint') ? h.minOutRaw.toString() : String(h.minOutRaw || 0),
          userSourceAta: h.userSourceAta, userDestAta: h.userDestAta,
          ...(h.vaultA ? { vaultA: h.vaultA } : {}),
          ...(h.vaultB ? { vaultB: h.vaultB } : {}),
          ...(h.tickSpacing ? { tickSpacing: h.tickSpacing } : {}),
          ...(h.sqrtPriceLimitX64 ? { sqrtPriceLimitX64: String(h.sqrtPriceLimitX64) } : {}),
          ...(h.oracle ? { oracle: h.oracle } : {}),
          ...(h.tickArrayLower ? { tickArrayLower: h.tickArrayLower } : {}),
          ...(h.tickArrayCenter ? { tickArrayCenter: h.tickArrayCenter } : {}),
          ...(h.tickArrayUpper ? { tickArrayUpper: h.tickArrayUpper } : {}),
          ...(h.binStep ? { binStep: h.binStep } : {}),
          ...(h.activeId ? { activeId: h.activeId } : {}),
          ...(h.binArrayLower ? { binArrayLower: h.binArrayLower } : {}),
          ...(h.binArrayUpper ? { binArrayUpper: h.binArrayUpper } : {}),
          ...(h.reserveX ? { reserveX: h.reserveX } : {}),
          ...(h.reserveY ? { reserveY: h.reserveY } : {}),
        })),
        poolCache: (plan.hops || []).map((h: any) => {
          const st = executionCache.getStatic(h.poolId) || null;
          const hotRaw: any = executionCache.getHot(h.poolId) || null;
          const hot = hotRaw ? {
            sqrtPriceX64: (typeof hotRaw.sqrtPriceX64 === 'bigint') ? hotRaw.sqrtPriceX64.toString() : hotRaw.sqrtPriceX64,
            currentTickIndex: hotRaw.currentTickIndex,
            activeId: hotRaw.activeId,
            tickArrays: hotRaw.tickArrays,
            binArrays: hotRaw.binArrays,
          } : null;
          return { poolId: h.poolId, programId: h.programId, static: st, hot };
        }),
      } as any;
      const id = Math.random().toString(36).slice(2,10);
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent } }); } catch {}
      const built = await buildDirectArbTx(plan, [], {} as any);
      const execCfg = await loadExecConfig();
      
      const ixs = (Array.isArray((built as any)?.tx?.instructions) ? (built as any).tx.instructions : []).map((ix: any) => {
        try {
          const pidLike = (ix?.programId) ?? (ix?.programAddress) ?? (ix?.program && (ix.program.address || ix.program));
          const pid = (pidLike && typeof pidLike.toBase58 === 'function') ? pidLike.toBase58() : String(pidLike || '');
          const keysSrc: any[] = Array.isArray(ix?.keys) ? ix.keys : [];
          const accounts = keysSrc.map((k: any) => {
            const pkLike = (k?.pubkey) ?? (k?.pubKey) ?? (k?.address);
            const pk = (pkLike && typeof pkLike.toBase58 === 'function') ? pkLike.toBase58() : String(pkLike || '');
            return { pk, s: !!k?.isSigner, w: !!k?.isWritable };
          });
          const dataLen = (ix?.data && typeof (ix.data as any).length === 'number') ? Number((ix.data as any).length) : 0;
          return { pid, dataLen, accounts };
        } catch { return { pid: String(ix?.programId || ''), dataLen: 0, accounts: [] }; }
      });
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}

      // id already defined above
      const mode = (execCfg.mode || 'simulate');
      const forceDirect = !!(input && (input as any).forceDirect);
      // Jupiter execution mode: build and send via Jupiter v6 strict legs
      if (mode === 'jupiter' && !forceDirect) {
        try {
          const { executePlanWithJupiterStrict } = await import('../../jupiter/arbExecutor.js');
          const hopDexes: string[] = Array.isArray((input as any)?.dexes)
            ? (input as any).dexes
            : (Array.isArray((plan as any)?.hops) ? (plan as any).hops.map((h: any) => String(h?.dex || '')) : []);
          // Convert size (tokens) to atoms for plan start mint
          let sizeAtoms: number | undefined = undefined;
          try {
            if (Number.isFinite((input as any)?.size as any)) {
              const { resolveMint } = await import('../../utils/tokens.js');
              const dec0 = (await resolveMint(plan.path[0])).decimals ?? 6;
              sizeAtoms = Math.max(0, Math.floor(Number((input as any).size) * Math.pow(10, dec0)));
            }
          } catch {}
          const signature = (await executePlanWithJupiterStrict({
            plan,
            sizeAtoms,
            sizeUsd: Number.isFinite((input as any)?.sizeUsd as any) ? Number((input as any).sizeUsd) : undefined,
            slippageBps: Number.isFinite((input as any)?.slippageBps as any) ? Number((input as any).slippageBps) : undefined,
            hopDexes,
            strictMinOut: true,
          })).signature;
          return res.json({ id, mode, signature, ixCount: 0, txSizeBytes: 0 });
        } catch (e: any) {
          return res.status(400).json({ id, mode, error: 'jupiter_exec_failed' });
        }
      }
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

      // Size gate: warn only; let v0 serialization/RPC enforce true limits
      const maxBytes = Number(execCfg.maxTxSizeBytes || 0);
      if (maxBytes > 0 && built.sizeBytes > maxBytes) {
        try { logger.info('tx.size.warn', { cat: 'tx', ctx: { ixCount: built.ixCount, txSizeBytes: built.sizeBytes, maxTxSizeBytes: maxBytes } as any }); } catch {}
      }

      // Log intent and ix summary for execution path
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent } as any }); } catch {}
      try { logger.info('tx.ixs', { cat: 'tx', ctx: { id, ixCount: built.ixCount, items: ixs } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent } }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.ixs', context: { cat: 'tx', id, ixCount: built.ixCount, items: ixs } }); } catch {}

      // Require successful preflight before sending
      try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode } as any }); } catch {}
      let sim: any;
      try {
        sim = await assembleAndSimulate(built.tx.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: execCfg.lookupTableAddresses,
        } as any);
        try {
          const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
          for (const d of dexes) {
            if (d === 'raydium' || d === 'orca' || d === 'meteora') {
              await writeDexFullDump(d as any, 'preflight', {
                id,
                path: plan.path,
                hops: plan.hops,
                exec: execCfg,
                built,
                sim,
              });
            }
          }
        } catch {}
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
        intent,
        ixs,
        wireBase64: (sim as any)?.wireBase64,
        logs: (sim as any)?.logs || [],
        err: (sim as any)?.err || null,
      });
      try { emit('log', { level: 'info', message: 'pretrade:arb simulate result', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.SIM.END', mode: (execCfg as any)?.mode, ...(sim as any)?.err ? { err: String((sim as any).err) } : {} } }); } catch {}
      try {
        if ((sim as any)?.err) {
          const errStr = toErrString((sim as any)?.err);
          logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, logCount: Array.isArray((sim as any)?.logs) ? (sim as any).logs.length : 0, error: errStr } as any });
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
        try {
          const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
          for (const d of dexes) {
            if (d === 'raydium' || d === 'orca' || d === 'meteora') {
              await writeDexFullDump(d as any, 'execute', {
                id,
                path: plan.path,
                hops: plan.hops,
                exec: execCfg,
                built,
                send: sendRes,
              });
            }
          }
        } catch {}
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
          intent,
          ixs,
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

  // Convenience: execute a single-hop Orca Whirlpool swap
  // Body accepts either:
  // - { path: [inputMint, outputMint], hopPoolIds: [poolId], size?: number, sizeUsd?: number, slippageBps?: number }
  // or
  // - { plan: { path, hops: [{ dex: 'orca', poolId }] }, ... }
  api.post('/arb/execute/orca', async (req, res) => {
    try {
      const body = req.body || {};
      // Normalize into generic /arb/execute input with dex set to orca.clmm
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'orca', variant: 'clmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = (body.poolId || body.whirlpoolId) ? String(body.poolId || body.whirlpoolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'orca.clmm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
          forceDirect: body.forceDirect,
        };
      }
      // Delegate to generic executor
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: preflight (simulate-send) a two-hop Orca Whirlpool swap
  api.post('/arb/simulate-send/orca', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'orca', variant: 'clmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = (body.poolId || body.whirlpoolId) ? String(body.poolId || body.whirlpoolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'orca.clmm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: execute a single-hop Raydium AMM swap
  api.post('/arb/execute/raydium-amm', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'raydium', variant: 'amm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'raydium.amm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
          forceDirect: body.forceDirect,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: preflight (simulate-send) a single-hop Raydium AMM swap
  api.post('/arb/simulate-send/raydium-amm', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'raydium', variant: 'amm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'raydium.amm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: execute a single-hop Raydium CLMM swap
  api.post('/arb/execute/raydium-clmm', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'raydium', variant: 'clmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'raydium.clmm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
          forceDirect: body.forceDirect,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: preflight (simulate-send) a single-hop Raydium CLMM swap
  api.post('/arb/simulate-send/raydium-clmm', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'raydium', variant: 'clmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'raydium.clmm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: execute a single-hop Meteora DLMM swap
  api.post('/arb/execute/meteora', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora', variant: 'dlmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'meteora');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
          forceDirect: body.forceDirect,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: preflight (simulate-send) a single-hop Meteora DLMM swap
  api.post('/arb/simulate-send/meteora', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora', variant: 'dlmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = body.poolId ? String(body.poolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        if (hopCount <= 0) return res.status(400).json({ error: 'invalid path' });
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) return res.status(400).json({ error: 'invalid hopPoolIds' });
        const dexes = Array.from({ length: hopCount }, () => 'meteora');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
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
      const toSend: any = { ...(req.body || {}) };
      // Do not forward UI-only fields to arb-service
      try { delete toSend.edge_allow; } catch {}
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toSend), signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.debug(`api.response POST /arb-service/config ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      let json: any = {};
      try { json = await r.json(); } catch { json = {}; }
      try {
        const changedKeys = Object.keys(req.body || {});
        emit('log', { level: r.ok ? 'info' : 'warn', message: `arb:config update keys=[${changedKeys.join(',')}] status=${r.status}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
        emit('log', { level: r.ok ? 'info' : 'warn', message: `terminal: Arbitrage configuration ${r.ok ? 'updated' : 'update failed'} (${r.status})`, timestamp: new Date().toISOString() });
      } catch {}
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      // Trigger graph rebuild to apply edge_allow immediately
      try { const g = await import('../graph.js'); (g as any).scheduleGraphRebuild?.(undefined, 50); } catch {}
      res.status(r.status).json(json);
    } catch (e: any) {
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      // Apply locally even if arb service unreachable
      try { const g = await import('../graph.js'); (g as any).scheduleGraphRebuild?.(undefined, 50); } catch {}
      res.status(503).json({ ok: false, error: 'arb service unreachable; config saved locally' });
    }
  });

  return api;
}


