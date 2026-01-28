import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { emit, setArbStreamEnabled, clearPendingGraphUpdates } from '../realtime.js';
import { writeJson, readJson } from '../../utils/fs.js';
import { logTxTrace } from '../../utils/txTrace.js';
import { CONFIG } from '../../utils/config.js';
import { getTxRelatedLogs } from '../../utils/sessionLogs.js';
import { createWorkerClient, WorkerClient } from '../../workers/client.js';
import type { ArbBuildRequest, ArbBuildResult, SerializedInstruction } from '../../workers/arbBuild.types.js';
import { buildTransactionSummary } from '../arb.build.worker.compute.js';
// Static imports for executor - avoid per-request import overhead
import { getArbExecutor, stopArbExecutor } from '../../execution/arbExecutor.js';
import { loadJitoConfig, saveJitoConfig } from '../jitoConfigStore.js';
import { getSlippageConfig, updateSlippageConfig, resetSlippageConfig, DEFAULT_SLIPPAGE_CONFIG } from '../../execution/slippage/index.js';
import { getQuarantineStats } from '../../execution/poolFailureTracker.js';

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

  const env = (typeof globalThis !== 'undefined' && (globalThis as any)?.process?.env) ? (globalThis as any).process.env : {} as Record<string, string>;
  const ARB_BUILD_WORKER_DISABLED = String(env.ARB_BUILD_WORKER_DISABLED ?? env.ARB_BUILD_TX_DISABLED ?? '').toLowerCase() === 'true';
  const ARB_BUILD_WORKER_MAX_QUEUE = Math.max(1, Number(env.ARB_BUILD_WORKER_MAX_QUEUE ?? 2));
  const ARB_BUILD_WORKER_TIMEOUT_MS = Math.max(2000, Number(env.ARB_BUILD_WORKER_TIMEOUT_MS ?? 8000));
  const ARB_BUILD_WORKER_IDLE_MS = Math.max(0, Number(env.ARB_BUILD_WORKER_IDLE_MS ?? 30_000));
  const ARB_BUILD_WORKER_CONCURRENCY = Math.max(1, Number(env.ARB_BUILD_WORKER_CONCURRENCY ?? 1));

  let arbBuildWorkerClient: WorkerClient<ArbBuildRequest, ArbBuildResult> | null = null;
  let arbBuildWorkerUnavailable = ARB_BUILD_WORKER_DISABLED;
  let arbBuildWorkerFailures = 0;

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

  // Soft assert: verify plan hops align with current graph edges (warn-only)
  async function assertPlanMatchesGraph(path: string[], hops: Array<{ poolId: string }>): Promise<void> {
    try {
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(false);
      const byPid = new Map<string, any>();
      try { for (const e of (snap?.edges || [])) { const pid = String((e as any)?.pool_id || ''); if (pid) byPid.set(pid, e); } } catch {}
      for (let i = 0; i < hops.length; i += 1) {
        const pid = String((hops[i] as any)?.poolId || '');
        const src = String(path[i] || '');
        const dst = String(path[i + 1] || '');
        if (!pid || !src || !dst) continue;
        const e = byPid.get(pid);
        if (!e) { try { logger.warn('arb.graph_plan.missing_edge', { hop: i, pid, src, dst, cat: 'arb' }); } catch {}; continue; }
        if (String((e as any).source) !== src || String((e as any).target) !== dst) {
          try { logger.warn('arb.graph_plan.mismatch', { hop: i, pid, src, dst, edgeSrc: (e as any).source, edgeDst: (e as any).target, cat: 'arb' }); } catch {}
        }
      }
    } catch {}
  }
  api.get('/arb/config', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const r = await fetch(`${host}/config`).catch(() => null);
      
      // If arb-rs returns an error (4xx/5xx), log and fallback to local config
      if (r && !r.ok) {
        const errText = await r.text().catch(() => '');
        logger.warn('arb.config.get.arb_service_error', { 
          cat: 'arb', 
          status: r.status, 
          error: errText.slice(0, 200) 
        });
      }
      
      const remote = (r && r.ok) ? await r.json().catch(() => ({})) : {};
      // Merge in locally saved UI-only fields (e.g., edge_allow)
      let local: any = {};
      try { local = await readJson('backend/config/arbConfig.json', {} as any); } catch {}
      const merged = { ...(remote || {}), ...(local || {}) };
      
      // Always return 200 with merged config (use local as fallback)
      res.status(200).json(merged);
    } catch (e: any) {
      // Fallback: serve local file if arb service unavailable
      logger.warn('arb.config.get.error', { cat: 'arb', error: String(e?.message || e) });
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

  api.get('/arb/graph/sync-status', async (_req, res) => {
    try {
      const { getGraphVersion } = await import('../graph.js');
      const { isArbStreamEnabled, getCachedArbVersion } = await import('../realtime.js');
      const { getGraphPushStats } = await import('../realtime.js');
      
      const backendVersion = getGraphVersion();
      const arbVersion = getCachedArbVersion();
      const streamEnabled = isArbStreamEnabled();
      const pushStats = getGraphPushStats();
      
      const versionLag = backendVersion.version - arbVersion.version;
      const timeLag = backendVersion.timestamp - arbVersion.timestamp;
      
      const status = {
        stream_enabled: streamEnabled,
        backend_version: backendVersion.version,
        backend_timestamp: backendVersion.timestamp,
        arb_version: arbVersion.version,
        arb_timestamp: arbVersion.timestamp,
        arb_version_age_ms: arbVersion.ageMs,
        version_lag: versionLag,
        time_lag_ms: timeLag,
        push_stats: {
          success: pushStats.success,
          failed: pushStats.failed,
          p50_ms: pushStats.p50,
          p95_ms: pushStats.p95,
        },
        sync_status: streamEnabled && versionLag === 0 && timeLag < 5000 ? 'synced' : 
                     streamEnabled && versionLag <= 2 && timeLag < 30000 ? 'lagging' : 
                     streamEnabled ? 'out_of_sync' : 'disabled',
      };
      
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/arb/detect/complete', async (req, res) => {
    try {
      const { graphVersion, completedMs } = req.body || {};
      
      // Flush pending graph updates now that detection is complete
      // This pushes the freshest consolidated update when arb-rs is ready
      const { flushPendingFromDetector } = await import('../realtime.js');
      const flushed = await flushPendingFromDetector();
      
      try {
        logger.debug('arb.detect.complete', {
          graphVersion,
          completedMs,
          flushed,
          cat: 'arb',
        });
      } catch {}
      
      res.json({ ok: true, flushed });
    } catch (err: any) {
      try {
        logger.warn('arb.detect.complete.error', {
          error: String(err?.message || err),
          cat: 'arb',
        });
      } catch {}
      res.status(400).json({ ok: false, error: String(err?.message || err) });
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
        // Add ALT status
        let altStatus: any = null;
        try {
          const { dexAltManager } = await import('../../execution/utils/altManager.js');
          altStatus = dexAltManager.getStatus();
        } catch {}
        // Add graph edge breakdown by DEX
        let graph_dex_breakdown: any = null;
        try {
          const { getGraphSnapshot } = await import('../graph.js');
          const snap = await getGraphSnapshot(false);
          const countDex = (dex: string) => {
            const pools = new Set<string>();
            (snap?.edges || []).forEach((e: any) => {
              if (e.dex === dex && e.pool_id) {
                const base = String(e.pool_id).replace(/[#-]rev$/, '');
                pools.add(base);
              }
            });
            return { edges: (snap?.edges || []).filter((e: any) => e.dex === dex).length, pools: pools.size };
          };
          graph_dex_breakdown = {
            raydium: countDex('Raydium'),
            orca: countDex('Orca'),
            meteora: countDex('Meteora'),
            pumpswap: countDex('Pumpswap'),
          };
        } catch {}
        j = { ...(j || {}), pools: { ...(j?.pools || {}), ...pm }, pools_age_ms: ages, exec, graph_push, alt_status: altStatus, graph_dex_breakdown };
      } catch {}
      res.status(r?.status || 200).json(j);
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ALT status endpoint
  api.get('/arb/alts/status', async (_req, res) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const status = dexAltManager.getStatus();
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Extend existing ALT
  api.post('/arb/alts/extend', async (req, res) => {
    try {
      const body = req.body || {};
      const category = String(body.category || '');
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];

      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }
      if (accounts.length === 0) {
        return res.status(400).json({ error: 'accounts array is required and cannot be empty' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.extendAlt(category, accounts);

      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create and extend new ALT
  api.post('/arb/alts/create', async (req, res) => {
    try {
      const body = req.body || {};
      const category = String(body.category || '');
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      const seed = body.seed ? String(body.seed) : undefined;

      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }
      if (accounts.length === 0) {
        return res.status(400).json({ error: 'accounts array is required and cannot be empty' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.createAndExtendAlt(category, accounts, seed);

      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Collect accounts for a category (preview what would be added)
  api.get('/arb/alts/collect-accounts', async (req, res) => {
    try {
      const category = String(req.query.category || 'common') as 'common' | 'pools' | 'tokens' | 'clmm' | 'all';
      const includeSystemPrograms = req.query.includeSystemPrograms !== 'false';
      const includeWalletAtas = req.query.includeWalletAtas !== 'false';
      const maxPoolAccounts = Number(req.query.maxPoolAccounts) || 50;
      const maxTokenAccounts = Number(req.query.maxTokenAccounts) || 20;

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const accounts = await dexAltManager.collectAccountsForCategory(category, {
        includeSystemPrograms,
        includeWalletAtas,
        maxPoolAccounts,
        maxTokenAccounts,
      });

      res.json({
        category,
        accountCount: accounts.length,
        accounts: accounts.map(pk => pk.toBase58()),
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Extend ALT with collected accounts for a category
  api.post('/arb/alts/extend-with-category', async (req, res) => {
    try {
      const body = req.body || {};
      const category = String(body.category || 'common');
      const accountCategory = String(body.accountCategory || 'common') as 'common' | 'pools' | 'tokens' | 'clmm' | 'all';
      const options = body.options || {};

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      // Collect accounts
      const accounts = await dexAltManager.collectAccountsForCategory(accountCategory, options);
      
      if (accounts.length === 0) {
        return res.status(400).json({ error: 'No accounts collected for the specified category' });
      }

      // Extend the ALT
      const result = await dexAltManager.extendAlt(category, accounts);

      res.json({
        ...result,
        accountsAdded: accounts.length,
        accountAddresses: accounts.map(pk => pk.toBase58()),
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get pools by DEX with liquidity data (for preview)
  api.get('/arb/alts/pools-by-dex', async (req, res) => {
    try {
      const dex = String(req.query.dex || 'raydium') as 
        'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 
        'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap';
      const poolType = String(req.query.poolType || 'both') as 'amm' | 'clmm' | 'cpmm' | 'both';
      const maxPools = Math.min(100, Math.max(1, Number(req.query.maxPools) || 30));

      // Import graph to get pool data
      const { getGraphSnapshot } = await import('../graph.js');
      const snapshot = await getGraphSnapshot();

      if (!snapshot || !snapshot.edges) {
        return res.status(503).json({ error: 'Graph snapshot not available' });
      }

      // Map frontend DEX keys to graph edge dex values
      const dexMatchFn = (edgeDex: string, edgePoolKind: string): boolean => {
        const normalizedEdgeDex = edgeDex.toLowerCase();
        
        switch (dex) {
          case 'raydium':
            // Match raydium CLMM only
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'clmm';
          case 'raydium-amm':
            // Match only raydium AMM v4 pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'amm';
          case 'raydium-cpmm':
            // Match only raydium CPMM pools
            return normalizedEdgeDex === 'raydium' && edgePoolKind === 'cpmm';
          case 'orca':
            return normalizedEdgeDex === 'orca';
          case 'meteora':
            // Match meteora DLMM only (clmm type)
            return normalizedEdgeDex === 'meteora' && edgePoolKind === 'clmm';
          case 'meteora-balanced':
            return normalizedEdgeDex === 'meteora_balanced' || normalizedEdgeDex === 'meteora-balanced';
          case 'meteora-damm-v1':
            // Match Meteora Dynamic AMM v1 pools
            return normalizedEdgeDex === 'meteora_damm_v1' || normalizedEdgeDex === 'meteora-damm-v1' ||
                   normalizedEdgeDex === 'meteorabalanced_v1' || normalizedEdgeDex === 'meteora_balanced_v1';
          case 'meteora-damm-v2':
            // Match Meteora CP-AMM v2 pools
            return normalizedEdgeDex === 'meteora_damm_v2' || normalizedEdgeDex === 'meteora-damm-v2' ||
                   normalizedEdgeDex === 'meteorabalanced_v2' || normalizedEdgeDex === 'meteora_balanced_v2';
          case 'pumpswap':
            return normalizedEdgeDex === 'pumpswap';
          default:
            return false;
        }
      };

      // Filter edges by DEX and pool type
      let filtered = snapshot.edges.filter(edge => {
        const edgeDex = String(edge.dex || '').toLowerCase();
        const edgePoolKind = String(edge.pool_kind || '');
        
        if (!dexMatchFn(edgeDex, edgePoolKind)) return false;
        
        if (poolType === 'both') return true;
        return edgePoolKind === poolType;
      });

      // Filter out reverse edges to avoid showing duplicates in preview
      const forwardEdgesOnly = filtered.filter(edge => {
        const poolId = String(edge.pool_id || '');
        return !/[#-]rev$/.test(poolId);
      });

      // Sort by liquidity metrics
      forwardEdgesOnly.sort((a, b) => {
        const getLiquidity = (edge: any): number => {
          if (edge.tvl_usd && edge.tvl_usd > 0) return edge.tvl_usd;
          if (edge.liquidity_display && edge.liquidity_display > 0) return edge.liquidity_display;
          if (edge.pool_liquidity_raw && edge.pool_liquidity_raw > 0) return edge.pool_liquidity_raw;
          if (edge.liquidity && edge.liquidity > 0) return edge.liquidity;
          return 0;
        };
        return getLiquidity(b) - getLiquidity(a);
      });

      // Deduplicate by pool_id and take top N
      const poolIds = new Set<string>();
      const pools: any[] = [];
      
      for (const edge of forwardEdgesOnly) {
        if (!edge.pool_id) continue;
        
        // Clean the pool ID to its base form (remove -fwd/-rev if present)
        const cleanPoolId = String(edge.pool_id).replace(/-(rev|fwd)$/, '');
        if (poolIds.has(cleanPoolId)) continue;
        poolIds.add(cleanPoolId);
        
        const tvl = edge.tvl_usd || edge.liquidity_display || edge.pool_liquidity_raw || edge.liquidity || 0;
        
        pools.push({
          poolId: edge.pool_id,
          dex: edge.dex,
          poolKind: edge.pool_kind,
          mintA: edge.source,
          mintB: edge.target,
          tvl,
          feeBps: edge.fee_bps,
        });
        
        if (pools.length >= maxPools) break;
      }

      res.json({
        dex,
        poolType,
        poolCount: pools.length,
        pools,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create DEX-specific ALT with top pools
  api.post('/arb/alts/create-dex-alt', async (req, res) => {
    try {
      const body = req.body || {};
      const dex = String(body.dex || 'raydium') as 
        'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' |
        'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap';
      const poolType = String(body.poolType || 'both') as 'amm' | 'clmm' | 'cpmm' | 'both';
      const maxPools = Math.min(100, Math.max(1, Number(body.maxPools) || 50));
      const category = String(body.category || `${dex}-${poolType === 'both' ? 'all' : poolType}`);

      if (!dex) {
        return res.status(400).json({ error: 'dex parameter is required' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      // Collect accounts for the DEX pools
      const accounts = await dexAltManager.collectDexPoolAccounts(dex, poolType, maxPools);

      if (accounts.length === 0) {
        return res.status(400).json({ error: 'No accounts collected for the specified DEX and pool type' });
      }

      // Create the ALT
      const result = await dexAltManager.createAndExtendAlt(category, accounts);

      res.json({
        ...result,
        dex,
        poolType,
        maxPools,
        category,
        poolCount: maxPools,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Refresh/extend existing DEX ALT with updated pool list
  api.post('/arb/alts/refresh-dex-alt', async (req, res) => {
    try {
      const body = req.body || {};
      const category = String(body.category || '');
      const maxPools = Math.min(100, Math.max(1, Number(body.maxPools) || 50));

      if (!category) {
        return res.status(400).json({ error: 'category parameter is required' });
      }

      // Parse category to get dex and poolType
      // Expected format: 'raydium-amm', 'orca-whirlpool', 'meteora-dlmm', etc.
      let dex: 'raydium' | 'orca' | 'meteora' | 'meteora-balanced' = 'raydium';
      let poolType: 'amm' | 'clmm' | 'both' = 'both';

      if (category.includes('raydium')) {
        dex = 'raydium';
        if (category.includes('amm')) poolType = 'amm';
        else if (category.includes('clmm')) poolType = 'clmm';
      } else if (category.includes('orca')) {
        dex = 'orca';
        poolType = 'clmm'; // Orca only has Whirlpool (CLMM)
      } else if (category.includes('meteora')) {
        if (category.includes('balanced')) {
          dex = 'meteora-balanced';
          poolType = 'amm';
        } else {
          dex = 'meteora';
          poolType = 'clmm'; // Meteora DLMM
        }
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      // Collect fresh accounts for the DEX pools
      const accounts = await dexAltManager.collectDexPoolAccounts(dex, poolType, maxPools);

      if (accounts.length === 0) {
        return res.status(400).json({ error: 'No accounts collected for refresh' });
      }

      // Extend the existing ALT
      const result = await dexAltManager.extendAlt(category, accounts);

      res.json({
        ...result,
        dex,
        poolType,
        maxPools,
        category,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get detailed ALT information
  api.get('/arb/alts/info/:category', async (req, res) => {
    try {
      const { category } = req.params;
      if (!category) {
        return res.status(400).json({ error: 'category parameter is required' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const info = await dexAltManager.getAltInfo(category);

      res.json({
        ...info,
        rentAmountSOL: (info.rentAmount / 1e9).toFixed(6),
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Deactivate an ALT (step 1 of deletion)
  api.post('/arb/alts/deactivate', async (req, res) => {
    try {
      const { category } = req.body;
      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.deactivateAlt(category);

      res.json({
        success: true,
        ...result,
        message: 'ALT deactivated. Wait ~5 minutes (513 slots) before closing to recover rent.',
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Close an ALT and recover rent (step 2 of deletion)
  api.post('/arb/alts/close', async (req, res) => {
    try {
      const { category } = req.body;
      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }

      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.closeAlt(category);

      res.json({
        success: true,
        ...result,
        rentRecoveredSOL: (result.rentRecovered / 1e9).toFixed(6),
        message: `ALT closed. Recovered ${(result.rentRecovered / 1e9).toFixed(6)} SOL`,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Force re-initialization of ALT manager (cleans up deleted ALTs)
  api.post('/arb/alts/reinitialize', async (req, res) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      await dexAltManager.forceReinitialize();

      res.json({
        success: true,
        message: 'ALT manager re-initialized successfully. Deleted ALTs have been cleaned up.',
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
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

  // Endpoint for arb-rs to request current graph snapshot when it detects version lag
  api.get('/arb/graph/current', async (req, res) => {
    try {
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(true);
      
      if (!snap || !Array.isArray((snap as any).edges) || (snap as any).edges.length === 0) {
        return res.status(404).json({ error: 'no_graph' });
      }
      
      try {
        logger.info('arb.graph.current', { 
          version: snap.version, 
          edges: snap.edges?.length,
          nodes: snap.nodes?.length,
          cat: 'arb' 
        });
      } catch {}
      
      return res.json({ graph: snap });
    } catch (e: any) {
      try {
        logger.error('arb.graph.current error', { error: String(e?.message || e) });
      } catch {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  api.post('/arb/start', async (req, res) => {
    try {
      const body = req.body || {};
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const wantEnable: boolean = !!(body && (body as any).enable);
      
      // When stopping, disable streaming immediately and skip graph snapshot
      if (!wantEnable) {
        setArbStreamEnabled(false);
        // Still notify arb-rs to stop, but don't wait for graph snapshot
        const r = await fetch(`${host}/arb/start`, { 
          method: 'POST', 
          headers: { 'content-type': 'application/json' }, 
          body: JSON.stringify({ enable: false }),
          signal: AbortSignal.timeout(3000) // 3 second timeout
        }).catch(() => null);
        const status = r?.status || 200; // Don't fail if arb-rs is unreachable
        const j = r ? await r.json().catch(() => ({ ok: true })) : { ok: true };
        return res.status(status).json(j);
      }
      
      // When starting, get graph snapshot and send to arb-rs
      const { getGraphSnapshot } = await import('../graph.js');
      const snap = await getGraphSnapshot(true);
      // Only include graph when non-empty
      const includeGraph = !!(snap && Array.isArray((snap as any).edges) && (snap as any).edges.length > 0);
      const payload = includeGraph ? { graph: snap, ...body } : { ...body };
      const r = await fetch(`${host}/arb/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => null);
      const status = r?.status || 503;
      const j = r ? await r.json().catch(() => ({})) : { ok: false };
      
      // Log the response for debugging
      try { 
        logger.info('arb.start.response', { 
          status, 
          ok: j?.ok, 
          wantEnable, 
          includeGraph,
          snapshot_version: snap?.version,
          snapshot_edges: snap?.edges?.length,
          cat: 'arb' 
        }); 
      } catch {}
      
      // Enable streaming if we got any response (even if not ok) - the snapshot was sent
      // This ensures updates continue to flow even if arb-rs had a transient issue
      // Only enable if we actually sent a graph (includeGraph) or got an ok response
      if (wantEnable) {
        const shouldEnable = (r !== null && (j?.ok || includeGraph));
        if (shouldEnable) {
          // Clear any pending diffs before enabling - snapshot is the source of truth
          // This prevents stale diffs from before streaming was enabled from being sent
          try { clearPendingGraphUpdates(); } catch {}
          
          setArbStreamEnabled(true);
          try { 
            logger.info('arb.stream.enabled_after_start', { 
              arb_rs_ok: j?.ok,
              includeGraph,
              cat: 'arb' 
            }); 
          } catch {}
        } else {
          try { 
            logger.warn('arb.stream.not_enabled', { 
              reason: r === null ? 'no_response' : 'no_graph_and_not_ok',
              arb_rs_ok: j?.ok,
              includeGraph,
              cat: 'arb' 
            }); 
          } catch {}
        }
      } else {
        setArbStreamEnabled(false);
      }
      
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
      // Always resolve using the quote's path/pools/dexes -> fills mints, decimals, and amounts
      const plan = await resolveDirectPlan(resolveInput as any, {} as any);
      // Apply optional per-hop overrides from the provided quote/plan
      if (basePlan) {
        for (let i = 0; i < plan.hops.length && i < basePlan.hops.length; i += 1) {
          const src = basePlan.hops[i] as any;
          if (src.inputMint)  plan.hops[i].inputMint  = String(src.inputMint);
          if (src.outputMint) plan.hops[i].outputMint = String(src.outputMint);
          // NOTE: Do NOT override amountInRaw here - it breaks amount propagation between hops.
          // The resolver already correctly sets amountInRaw based on previous hop's output.
          if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
            try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
          }
        }
      }
      // Correlate traces
      const { getGraphVersion } = await import('../graph.js');
      const graph = getGraphVersion();
      const oppKey = (() => {
        try { const fams = Array.from(new Set((plan.hops || []).map((h: any) => String(h?.dex || '')))).filter(Boolean).sort(); return `${(plan.path||[]).join('->')}|${fams.join(',')}`; } catch { return `${(plan.path||[]).join('->')}|`; }
      })();
      const execCfg = await loadExecConfig();
      const tBuild0 = Date.now();
      const built = await buildArbTransaction(plan);
      try { pushBounded(execStats.buildMs, Date.now() - tBuild0); } catch {}
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.build.ok', { cat: 'tx', code: LogCode.TX_BUILD_OK, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}
      const id = Math.random().toString(36).slice(2,10);
      await logTxTrace('simulate', {
        id, timeMs: Date.now(),
        graph,
        oppKey,
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
      const { assembleAndSimulate } = await import('../../execution/sender.js');
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
          // NOTE: Do NOT override amountInRaw here - it breaks amount propagation between hops.
          // The resolver already correctly sets amountInRaw based on previous hop's output.
          if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
            try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
          }
        }
      }
      // Build intent early so we log even if build fails
      const { executionCache } = await import('../../execution/cache.js');
      // Correlate and soft-check alignment
      try { await assertPlanMatchesGraph(plan.path, plan.hops as any); } catch {}
      const { getGraphVersion } = await import('../graph.js');
      const graph = getGraphVersion();
      const oppKey = (() => {
        try { const fams = Array.from(new Set((plan.hops || []).map((h: any) => String(h?.dex || '')))).filter(Boolean).sort(); return `${(plan.path||[]).join('->')}|${fams.join(',')}`; } catch { return `${(plan.path||[]).join('->')}|`; }
      })();
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

      const built = await buildArbTransaction(plan);
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
      const ixs = built.instructions.map((ix) => {
        try {
          const pid = String(ix.programId || '');
          const accounts = (ix.keys || []).map((k) => ({ pk: k.pubkey, s: !!k.isSigner, w: !!k.isWritable }));
          const dataLen = Buffer.from(ix.data || '', 'base64').length;
          return { pid, dataLen, accounts };
        } catch { return { pid: String((ix as any)?.programId || ''), dataLen: 0, accounts: [] }; }
      });
      // Optional: warn if built programs imply a different DEX family set than planned
      try {
        const { CONFIG } = await import('../../utils/config.js');
        const v: any = CONFIG;
        const progs = ixs.map((x: any) => String(x?.pid || '')).filter(Boolean);
        const seen = new Set<string>();
        for (const pid of progs) {
          if (pid === String(v?.raydium?.ammV4Program) || pid === String(v?.raydium?.ammV5Program) || pid === String(v?.raydium?.clmmProgram)) seen.add('raydium');
          if (pid === String(v?.orca?.programId)) seen.add('orca');
          if (pid === String(v?.meteora?.programId)) seen.add('meteora');
        }
        const planned = Array.from(new Set((plan.hops || []).map((h: any) => String(h?.dex || '')))).filter(Boolean).sort();
        const seenArr = Array.from(seen).sort();
        if (JSON.stringify(planned) !== JSON.stringify(seenArr)) {
          try { logger.warn('tx.dex_mismatch.preflight', { planned, seen: seenArr, cat: 'tx' }); } catch {}
        }
      } catch {}

      // (duplicate block removed)
      try { emit('log', { level: 'info', message: 'pretrade:arb tx built', timestamp: new Date().toISOString(), context: { cat: 'tx', code: 'PRETRADE.TX.BUILT', mode: (execCfg as any)?.mode } }); } catch {}
      try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: (execCfg as any)?.mode } as any }); } catch {}
      const tPre0 = Date.now();
      // Use ALT addresses from built transaction, fallback to exec config
      const altAddresses = built.lookupTableAddresses || execCfg.lookupTableAddresses || [];
      const sim = await assembleAndSimulate(built.instructions, {
        computeUnitLimit: execCfg.computeUnitLimit,
        computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
        lookupTableAddresses: altAddresses,
      } as any);
      try {
        const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
        const txLogs = getTxRelatedLogs(id, Date.now() - 30000, Date.now(), 200);
        const { writeTxFullDump } = await import('../../utils/txTrace.js');
        // Write single consolidated file instead of one per DEX
        await writeTxFullDump('preflight', {
          id,
          txId: id,
          path: plan.path,
          hops: plan.hops,
          plan, // Full execution plan
          dexes, // Include all DEXes involved
          exec: execCfg,
          execConfig: execCfg, // Alias for clarity
          built,
          sim,
          executorLogs: txLogs, // Include executor logs
          // Include opportunity data if available from request
          opportunity: (req.body as any)?.opportunity || {
            path: plan.path,
            hop_pool_ids: plan.hops?.map((h: any) => h.poolId),
            hop_dexes: plan.hops?.map((h: any) => h.dex),
            dexes: Array.from(new Set(plan.hops?.map((h: any) => h.dex))),
          },
        });
      } catch (logErr) {
        try { 
          logger.error('tx.log.write_failed', { 
            cat: 'tx', 
            ctx: { 
              id,
              phase: 'preflight',
              error: String(logErr?.message || logErr)
            } as any 
          }); 
        } catch {}
      }
      try { pushBounded(execStats.preflightMs, Date.now() - tPre0); } catch {}

      // reuse early id
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent } as any }); } catch {}
      try { logger.info('tx.ixs', { cat: 'tx', ctx: { id, ixCount: built.ixCount, items: ixs } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent } }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.ixs', context: { cat: 'tx', id, ixCount: built.ixCount, items: ixs } }); } catch {}
      await logTxTrace('preflight', {
        id, timeMs: Date.now(),
        graph,
        oppKey,
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
    // Generate id early so it's available in all catch blocks
    const id = Math.random().toString(36).slice(2,10);
    try {
      try { emit('log', { level: 'info', message: 'pretrade:arb execute start', timestamp: new Date().toISOString(), context: { cat: 'arb', code: 'PRETRADE.EXEC.START' } }); } catch {}
      try { logger.info('pretrade:arb execute start', { cat: 'arb', code: LogCode.API_REQUEST }); } catch {}
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ResolveDirectSchema } = await import('../routes/schemas.js');
      const { assembleAndSend, assembleAndSimulate } = await import('../../execution/sender.js');
      const { addTxRecord } = await import('../txHistory.js');
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
      // Always resolve using the quote's path/pools/dexes -> fills mints, decimals, and amounts
      const plan = await resolveDirectPlan(resolveInput as any, {} as any);
      // Apply optional per-hop overrides from the provided quote/plan
      if (basePlan) {
        for (let i = 0; i < plan.hops.length && i < basePlan.hops.length; i += 1) {
          const src = basePlan.hops[i] as any;
          if (src.inputMint)  plan.hops[i].inputMint  = String(src.inputMint);
          if (src.outputMint) plan.hops[i].outputMint = String(src.outputMint);
          // NOTE: Do NOT override amountInRaw here - it breaks amount propagation between hops.
          // The resolver already correctly sets amountInRaw based on previous hop's output.
          if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
            try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
          }
        }
      }
      // Build intent early so we log even if build fails
      const { executionCache } = await import('../../execution/cache.js');
      // Correlate and soft-check alignment (warn-only)
      try { await assertPlanMatchesGraph(plan.path, plan.hops as any); } catch {}
      const { getGraphVersion } = await import('../graph.js');
      const graph = getGraphVersion();
      const oppKey = (() => {
        try { const fams = Array.from(new Set((plan.hops || []).map((h: any) => String(h?.dex || '')))).filter(Boolean).sort(); return `${(plan.path||[]).join('->')}|${fams.join(',')}`; } catch { return `${(plan.path||[]).join('->')}|`; }
      })();
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
      try { logger.info('tx.intents', { cat: 'tx', ctx: { id, intent } as any }); } catch {}
      try { emit('log', { level: 'info', message: 'tx.intents', context: { cat: 'tx', id, intent } }); } catch {}
      
      let built: ArbBuildResult;
      let execCfg: any;
      
      try {
        built = await buildArbTransaction(plan);
        execCfg = await loadExecConfig();
      } catch (buildError: any) {
        // Log build failure to execute-attempts
        try {
          const { writeTxFullDump } = await import('../../utils/txTrace.js');
          const { getTxRelatedLogs } = await import('../../utils/sessionLogs.js');
          const dexes = Array.from(new Set((plan.hops || []).map((h: any) => h.dex)));
          const txLogs = getTxRelatedLogs(id, Date.now() - 30000, Date.now(), 200);
          
          await writeTxFullDump('preflight', {
            id,
            txId: id,
            path: plan.path,
            hops: plan.hops,
            plan,
            dexes,
            exec: null,
            execConfig: null,
            built: null, // Build failed
            err: {
              type: 'build_failed',
              message: String(buildError?.message || buildError),
              stack: buildError?.stack,
            },
            executorLogs: txLogs,
            opportunity: (req.body as any)?.opportunity || {
              path: plan.path,
              hop_pool_ids: plan.hops?.map((h: any) => h.poolId),
              hop_dexes: plan.hops?.map((h: any) => h.dex),
              dexes: Array.from(new Set(plan.hops?.map((h: any) => h.dex))),
            },
          });
        } catch (logErr) {
          // Log the logging error but don't fail
          try { 
            logger.error('tx.build.log_failed', { 
              cat: 'tx', 
              ctx: { 
                id, 
                buildError: String(buildError?.message || buildError),
                logError: String(logErr?.message || logErr)
              } as any 
            }); 
          } catch {}
        }
        throw buildError; // Re-throw to maintain existing error handling
      }

      const ixs = built.instructions.map((ix) => {
        try {
          const pid = String(ix.programId || '');
          const accounts = (ix.keys || []).map((k) => ({ pk: k.pubkey, s: !!k.isSigner, w: !!k.isWritable }));
          const dataLen = Buffer.from(ix.data || '', 'base64').length;
          return { pid, dataLen, accounts };
        } catch { return { pid: String((ix as any)?.programId || ''), dataLen: 0, accounts: [] }; }
      });
      // Optional: warn if built programs imply a different DEX family set than planned
      try {
        const { CONFIG } = await import('../../utils/config.js');
        const v: any = CONFIG;
        const progs = ixs.map((x: any) => String(x?.pid || '')).filter(Boolean);
        const seen = new Set<string>();
        for (const pid of progs) {
          if (pid === String(v?.raydium?.ammV4Program) || pid === String(v?.raydium?.ammV5Program) || pid === String(v?.raydium?.clmmProgram)) seen.add('raydium');
          if (pid === String(v?.orca?.programId)) seen.add('orca');
          if (pid === String(v?.meteora?.programId)) seen.add('meteora');
        }
        const planned = Array.from(new Set((plan.hops || []).map((h: any) => String(h?.dex || '')))).filter(Boolean).sort();
        const seenArr = Array.from(seen).sort();
        if (JSON.stringify(planned) !== JSON.stringify(seenArr)) {
          try { logger.warn('tx.dex_mismatch.preflight', { planned, seen: seenArr, cat: 'tx' }); } catch {}
        }
      } catch {}
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

      // Optional: Pre-send simulation validation (can be skipped for speed)
      // Controlled by CONFIG.execution.skipPresendSimulation (env: SKIP_PRESEND_SIMULATION=true)
      const skipPresendSim = (CONFIG as any)?.execution?.skipPresendSimulation === true;
      
      let sim: any = null;
      
      if (skipPresendSim) {
        // Skip simulation for maximum speed
        try {
          logger.info('tx.presend_simulation.skipped', {
            cat: 'tx',
            code: LogCode.TX_PREFLIGHT_START,
            ctx: {
              id,
              ixCount: built.ixCount,
              sizeBytes: built.sizeBytes,
              mode: forceDirect ? 'direct(force)' : mode,
              reason: 'SKIP_PRESEND_SIMULATION=true',
              note: '100-200ms saved, sending directly without validation'
            } as any
          });
        } catch {}
        
        // Log that we're skipping for tracing purposes
        await logTxTrace('preflight', {
          id, timeMs: Date.now(),
          graph,
          oppKey,
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
          skipped: true,
        });
        
        try { execStats.preflightOk += 1; } catch {}
      } else {
        // Require successful preflight before sending
        try { logger.info('tx.preflight.start', { cat: 'tx', code: LogCode.TX_PREFLIGHT_START, ctx: { ixCount: built.ixCount, sizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode } as any }); } catch {}
        try {
          // Use ALT addresses from built transaction, fallback to exec config
          const altAddresses = built.lookupTableAddresses || execCfg.lookupTableAddresses || [];
          sim = await assembleAndSimulate(built.instructions, {
            computeUnitLimit: execCfg.computeUnitLimit,
            computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
            lookupTableAddresses: altAddresses,
          } as any);
          try {
            const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
            const txLogs = getTxRelatedLogs(id, Date.now() - 30000, Date.now(), 200);
            const { writeTxFullDump } = await import('../../utils/txTrace.js');
            // Write single consolidated file instead of one per DEX
            await writeTxFullDump('preflight', {
              id,
              txId: id,
              path: plan.path,
              hops: plan.hops,
              plan, // Full execution plan
              dexes, // Include all DEXes involved
              exec: execCfg,
              execConfig: execCfg, // Alias for clarity
              built,
              sim,
              executorLogs: txLogs, // Include executor logs
              // Include opportunity data if available from request
              opportunity: (req.body as any)?.opportunity || {
                path: plan.path,
                hop_pool_ids: plan.hops?.map((h: any) => h.poolId),
                hop_dexes: plan.hops?.map((h: any) => h.dex),
                dexes: Array.from(new Set(plan.hops?.map((h: any) => h.dex))),
              },
            });
          } catch (logErr) {
            try { 
              logger.error('tx.log.write_failed', { 
                cat: 'tx', 
                ctx: { 
                  id,
                  phase: 'preflight',
                  error: String(logErr?.message || logErr)
                } as any 
              }); 
            } catch {}
          }
        } catch (e: any) {
          try { logger.info('tx.preflight.err', { cat: 'tx', code: LogCode.TX_PREFLIGHT_ERR, ctx: { id, ixCount: built.ixCount, txSizeBytes: built.sizeBytes, mode: forceDirect ? 'direct(force)' : mode, error: String(e?.message || e) } as any }); } catch {}
          return res.status(400).json({ id, mode, error: 'preflight_throw' });
        }
        await logTxTrace('preflight', {
          id, timeMs: Date.now(),
          graph,
          oppKey,
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
      }

      // Pre-execution slippage check: re-quote immediately before sending
      try {
        const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
        const { quoteHopOut } = await import('../../execution/resolver/quotes.js');
        const slippageCheckBps = Number(execCfg.slippageBpsDefault || 50);
        const maxSlippageBps = Number(((CONFIG as any)?.system?.maxAllowedSlippageBps) || 200); // 2% max slippage
        
        let currentAmount = plan.hops[0]?.amountInRaw || 0n;
        let originalAmountOut = 0n;
        for (let i = 0; i < plan.hops.length; i++) {
          const hop = plan.hops[i];
          const out = await quoteHopOut(hop, currentAmount);
          if (i === plan.hops.length - 1) originalAmountOut = out;
          if (out > 0n) currentAmount = out;
        }
        
        // Compare with originally planned output
        const expectedOut = plan.hops[plan.hops.length - 1]?.minOutRaw || 0n;
        if (originalAmountOut > 0n && expectedOut > 0n) {
          const actualSlippageBps = Number((expectedOut - originalAmountOut) * 10000n / expectedOut);
          if (actualSlippageBps > maxSlippageBps) {
            try { logger.warn('tx.slippage.exceeded', { cat: 'tx', ctx: { id, expectedSlippage: slippageCheckBps, actualSlippageBps, maxAllowed: maxSlippageBps } as any }); } catch {}
            return res.status(400).json({ id, mode, error: 'slippage_exceeded', actualSlippageBps, maxAllowed: maxSlippageBps });
          }
        }
      } catch (e: any) {
        try { logger.warn('tx.slippage.check.failed', { cat: 'tx', ctx: { id, error: String(e?.message || e) } as any }); } catch {}
        // Continue execution if slippage check fails (non-fatal)
      }

      // Proceed to send (no chunking)
      try {
        const tSend0 = Date.now();
        // Use ALT addresses from built transaction, fallback to exec config
        const altAddresses = built.lookupTableAddresses || execCfg.lookupTableAddresses || [];
        const sendRes = await assembleAndSend(built.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
        } as any);
        try {
          const dexes = Array.from(new Set((plan.hops || []).map((h:any)=>String(h?.dex||'').toLowerCase())));
          // Capture logs from a wider window to include preflight logs too
          const txLogs = getTxRelatedLogs(id, Date.now() - 60000, Date.now(), 300);
          const { writeTxFullDump } = await import('../../utils/txTrace.js');
          // Write single consolidated file instead of one per DEX
          await writeTxFullDump('execute', {
            id,
            txId: id,
            path: plan.path,
            hops: plan.hops,
            plan, // Full execution plan
            dexes, // Include all DEXes involved
            exec: execCfg,
            execConfig: execCfg,
            built,
            send: sendRes,
            executorLogs: txLogs, // Include executor logs
            // Include opportunity data if available from request
            opportunity: (req.body as any)?.opportunity || {
              path: plan.path,
              hop_pool_ids: plan.hops?.map((h: any) => h.poolId),
              hop_dexes: plan.hops?.map((h: any) => h.dex),
              dexes: Array.from(new Set(plan.hops?.map((h: any) => h.dex))),
            },
          });
        } catch (logErr) {
          try { 
            logger.error('tx.log.write_failed', { 
              cat: 'tx', 
              ctx: { 
                id,
                phase: 'execute',
                error: String(logErr?.message || logErr)
              } as any 
            }); 
          } catch {}
        }
        try { pushBounded(execStats.sendMs, Date.now() - tSend0); execStats.sendOk += 1; } catch {}
        const signatures: string[] = [sendRes.signature];
        const signature = signatures[signatures.length - 1] || null;
        await logTxTrace('send', {
          id, timeMs: Date.now(),
        graph,
        oppKey,
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
      // Log to execute-attempts even on failure
      try {
        const { writeTxFullDump } = await import('../../utils/txTrace.js');
        const { getTxRelatedLogs } = await import('../../utils/sessionLogs.js');
        const txLogs = getTxRelatedLogs(id, Date.now() - 60000, Date.now(), 300);
        
        // Try to get plan and built if they exist
        const plan = (e as any)?.plan || (req.body as any)?.plan || null;
        const built = (e as any)?.built || null;
        const execCfg = (e as any)?.execCfg || null;
        
        await writeTxFullDump('execute', {
          id,
          txId: id,
          path: plan?.path || (req.body as any)?.path || [],
          hops: plan?.hops || [],
          plan,
          dexes: plan ? Array.from(new Set(plan.hops.map((h: any) => h.dex))) : [],
          exec: execCfg,
          execConfig: execCfg,
          built,
          err: {
            type: 'execution_failed',
            message: String(e?.message || e),
            stack: e?.stack,
          },
          executorLogs: txLogs,
          opportunity: (req.body as any)?.opportunity || {
            path: plan?.path || (req.body as any)?.path || [],
            hop_pool_ids: plan?.hops?.map((h: any) => h.poolId) || [],
            hop_dexes: plan?.hops?.map((h: any) => h.dex) || [],
            dexes: plan ? Array.from(new Set(plan.hops?.map((h: any) => h.dex))) : [],
          },
        });
      } catch (logErr) {
        try { 
          logger.error('arb.route.log_failed', { 
            cat: 'arb', 
            ctx: { 
              id,
              executionError: String(e?.message || e),
              logError: String(logErr?.message || logErr)
            } as any 
          }); 
        } catch {}
      }
      
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: execute a single-hop Orca Whirlpool swap
  // Body accepts either:
  // - { path: [inputMint, outputMint], hopPoolIds: [poolId], size?: number, sizeUsd?: number, slippageBps?: number }
  // or
  // - { plan: { path, hops: [{ dex: 'orca', poolId }] }, ... }
  // Execute an arb-rs Opportunity directly (UI optional)
  api.post('/arb/execute/opportunity', async (req, res) => {
    try {
      const opp = req.body || {};
      const path: string[] = Array.isArray((opp as any)?.path) ? (opp as any).path : [];
      const hopPoolIds: string[] = Array.isArray((opp as any)?.hop_pool_ids) ? ((opp as any).hop_pool_ids as any[]).map((x: any) => String(x)) : [];
      const dexes: string[] = Array.isArray((opp as any)?.hop_dexes) ? ((opp as any).hop_dexes as any[]).map((x: any) => String(x)) : [];
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'invalid path' });
      // Ensure closed cycle for path/hops alignment
      const pathClosed = (path.length >= 2 && path[0] === path[path.length - 1]) ? path : [...path, path[0]];
      const expected = Math.max(0, pathClosed.length - 1);
      if (hopPoolIds.length !== expected || dexes.length !== expected) {
        return res.status(400).json({ error: `hop count mismatch: expected ${expected}, got poolIds=${hopPoolIds.length}, dexes=${dexes.length}` });
      }
      // Delegate to generic executor
      req.body = {
        path: pathClosed,
        hopPoolIds,
        dexes,
        size: Number.isFinite((opp as any)?.size as any) ? Number((opp as any).size) : undefined,
        sizeUsd: Number.isFinite((opp as any)?.sizeUsd as any) ? Number((opp as any).sizeUsd) : undefined,
        slippageBps: Number.isFinite((opp as any)?.slippageBps as any) ? Number((opp as any).slippageBps) : undefined,
        forceDirect: (opp as any)?.forceDirect === true,
      } as any;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Preflight (simulate-send) an arb-rs Opportunity directly
  api.post('/arb/simulate-send/opportunity', async (req, res) => {
    try {
      const opp = req.body || {};
      const path: string[] = Array.isArray((opp as any)?.path) ? (opp as any).path : [];
      const hopPoolIds: string[] = Array.isArray((opp as any)?.hop_pool_ids) ? ((opp as any).hop_pool_ids as any[]).map((x: any) => String(x)) : [];
      const dexes: string[] = Array.isArray((opp as any)?.hop_dexes) ? ((opp as any).hop_dexes as any[]).map((x: any) => String(x)) : [];
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'invalid path' });
      const pathClosed = (path.length >= 2 && path[0] === path[path.length - 1]) ? path : [...path, path[0]];
      const expected = Math.max(0, pathClosed.length - 1);
      if (hopPoolIds.length !== expected || dexes.length !== expected) {
        return res.status(400).json({ error: `hop count mismatch: expected ${expected}, got poolIds=${hopPoolIds.length}, dexes=${dexes.length}` });
      }
      req.body = {
        path: pathClosed,
        hopPoolIds,
        dexes,
        size: Number.isFinite((opp as any)?.size as any) ? Number((opp as any).size) : undefined,
        sizeUsd: Number.isFinite((opp as any)?.sizeUsd as any) ? Number((opp as any).sizeUsd) : undefined,
        slippageBps: Number.isFinite((opp as any)?.slippageBps as any) ? Number((opp as any).slippageBps) : undefined,
      } as any;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });
  api.post('/arb/execute/orca', async (req, res) => {
    try {
      try { logger.info('pretrade:arb execute orca start', { cat: 'arb', code: LogCode.API_REQUEST, ctx: { body: req.body } as any }); } catch {}
      
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
        
        try { logger.info('orca.execute.payload_construction', { cat: 'arb', ctx: { pathLength: path.length, hopCount, hopPoolIdsInLength: hopPoolIdsIn.length, fallbackPid, hasPath: path.length > 0 } as any }); } catch {}
        
        if (hopCount <= 0) {
          try { logger.warn('orca.execute.invalid_path', { cat: 'arb', ctx: { path, hopCount } as any }); } catch {}
          return res.status(400).json({ error: 'invalid path' });
        }
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) {
            try { logger.warn('orca.execute.missing_pool_id', { cat: 'arb', ctx: { hopCount, hopPoolIdsInLength: ids.length, body } as any }); } catch {}
            return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          }
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) {
          try { logger.warn('orca.execute.invalid_pool_ids', { cat: 'arb', ctx: { ids } as any }); } catch {}
          return res.status(400).json({ error: 'invalid hopPoolIds' });
        }
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
        
        try { logger.info('orca.execute.payload_ready', { cat: 'arb', ctx: { payloadPath: payload.path, payloadHopPoolIds: payload.hopPoolIds, payloadDexes: payload.dexes } as any }); } catch {}
      }
      // Delegate to generic executor
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/execute', originalUrl: '/arb/execute', path: '/arb/execute', method: 'POST' }, res, () => {});
    } catch (e: any) {
      try { logger.error('orca.execute.error', { cat: 'arb', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e), stack: e?.stack } as any }); } catch {}
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  // Convenience: preflight (simulate-send) a two-hop Orca Whirlpool swap
  api.post('/arb/simulate-send/orca', async (req, res) => {
    try {
      try { logger.info('pretrade:arb simulate-send orca start', { cat: 'arb', code: LogCode.API_REQUEST, ctx: { body: req.body } as any }); } catch {}
      
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'orca', variant: 'clmm' })) } };
      } else {
        const path: string[] = Array.isArray(body.path) ? body.path : [];
        const hopPoolIdsIn: string[] = Array.isArray(body.hopPoolIds) ? (body.hopPoolIds as any[]).map((x: any) => String(x)) : [];
        const fallbackPid: string | undefined = (body.poolId || body.whirlpoolId) ? String(body.poolId || body.whirlpoolId) : undefined;
        const hopCount = Math.max(0, path.length - 1);
        
        try { logger.info('orca.simulate.payload_construction', { cat: 'arb', ctx: { pathLength: path.length, hopCount, hopPoolIdsInLength: hopPoolIdsIn.length, fallbackPid, hasPath: path.length > 0 } as any }); } catch {}
        
        if (hopCount <= 0) {
          try { logger.warn('orca.simulate.invalid_path', { cat: 'arb', ctx: { path, hopCount } as any }); } catch {}
          return res.status(400).json({ error: 'invalid path' });
        }
        let ids: string[] = hopPoolIdsIn;
        if (ids.length !== hopCount) {
          if (!fallbackPid) {
            try { logger.warn('orca.simulate.missing_pool_id', { cat: 'arb', ctx: { hopCount, hopPoolIdsInLength: ids.length, body } as any }); } catch {}
            return res.status(400).json({ error: 'missing hopPoolIds and poolId' });
          }
          ids = Array.from({ length: hopCount }, () => String(fallbackPid));
        }
        if (ids.some((s) => !s)) {
          try { logger.warn('orca.simulate.invalid_pool_ids', { cat: 'arb', ctx: { ids } as any }); } catch {}
          return res.status(400).json({ error: 'invalid hopPoolIds' });
        }
        const dexes = Array.from({ length: hopCount }, () => 'orca.clmm');
        payload = {
          path,
          hopPoolIds: ids,
          dexes,
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
        
        try { logger.info('orca.simulate.payload_ready', { cat: 'arb', ctx: { payloadPath: payload.path, payloadHopPoolIds: payload.hopPoolIds, payloadDexes: payload.dexes } as any }); } catch {}
      }
      req.body = payload;
      return (api as any).handle({ ...req, url: '/arb/simulate-send', originalUrl: '/arb/simulate-send', path: '/arb/simulate-send', method: 'POST' }, res, () => {});
    } catch (e: any) {
      try { logger.error('orca.simulate.error', { cat: 'arb', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e), stack: e?.stack } as any }); } catch {}
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
        // Don't forward the plan directly - extract path/poolIds/dexes to force proper resolution
        // This ensures amount propagation works correctly for multihop
        const plan = body.plan;
        payload = {
          path: plan.path,
          hopPoolIds: (plan.hops || []).map((h: any) => String(h.poolId)),
          dexes: (plan.hops || []).map(() => 'raydium.clmm'),
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
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
        // Don't forward the plan directly - extract path/poolIds/dexes to force proper resolution
        // This ensures amount propagation works correctly for multihop
        const plan = body.plan;
        payload = {
          path: plan.path,
          hopPoolIds: (plan.hops || []).map((h: any) => String(h.poolId)),
          dexes: (plan.hops || []).map(() => 'meteora'),
          size: body.size,
          sizeUsd: body.sizeUsd,
          slippageBps: body.slippageBps,
        };
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

  // Meteora Balanced (DAMM) v1 - simulate-send
  api.post('/arb/simulate-send/meteora-balanced-v1', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora_balanced', variant: 'damm_v1' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'MeteoraBalanced_v1');
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

  // Meteora Balanced (DAMM) v2 - simulate-send
  api.post('/arb/simulate-send/meteora-balanced-v2', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora_balanced', variant: 'damm_v2' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'MeteoraBalanced_v2');
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

  // Pumpswap - simulate-send
  api.post('/arb/simulate-send/pumpswap', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'pumpswap', variant: 'amm' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'Pumpswap');
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

  // Execute endpoints for new DEXes
  api.post('/arb/execute/meteora-balanced-v1', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora_balanced', variant: 'damm_v1' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'MeteoraBalanced_v1');
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

  api.post('/arb/execute/meteora-balanced-v2', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'meteora_balanced', variant: 'damm_v2' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'MeteoraBalanced_v2');
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

  api.post('/arb/execute/pumpswap', async (req, res) => {
    try {
      const body = req.body || {};
      let payload: any = {};
      if (body && body.plan && Array.isArray(body.plan?.hops)) {
        payload = { ...body, plan: { ...body.plan, hops: (body.plan.hops || []).map((h: any) => ({ ...h, dex: 'pumpswap', variant: 'amm' })) } };
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
        const dexes = Array.from({ length: hopCount }, () => 'Pumpswap');
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

  function getArbBuildWorkerClient(): WorkerClient<ArbBuildRequest, ArbBuildResult> | null {
    if (arbBuildWorkerUnavailable) return null;
    if (arbBuildWorkerClient) return arbBuildWorkerClient;
    try {
      const url = new URL('../../workers/arbBuild.worker.js', import.meta.url);
      arbBuildWorkerClient = createWorkerClient<ArbBuildRequest, ArbBuildResult>({
        url,
        name: 'arb-build',
        maxConcurrency: ARB_BUILD_WORKER_CONCURRENCY,
        idleTimeoutMs: ARB_BUILD_WORKER_IDLE_MS,
      });
      arbBuildWorkerFailures = 0;
      return arbBuildWorkerClient;
    } catch (err: any) {
      arbBuildWorkerUnavailable = true;
      try { logger.warn('arb.build.worker.init_failed', { error: String(err?.message || err), cat: 'tx' }); } catch {}
      return null;
    }
  }

  function markArbBuildWorkerFailed(err: unknown): void {
    if (arbBuildWorkerClient) {
      try { arbBuildWorkerClient.dispose(); } catch {}
      arbBuildWorkerClient = null;
    }
    arbBuildWorkerFailures += 1;
    if (arbBuildWorkerFailures >= 3) {
      arbBuildWorkerUnavailable = true;
    }
    try { logger.debug('arb.build.worker.failed', { error: String((err as any)?.message || err), failures: arbBuildWorkerFailures, cat: 'tx' }); } catch {}
  }

  async function buildArbTransaction(plan: any): Promise<ArbBuildResult> {
    // Run directly on main thread to avoid queue saturation and worker overhead
    // Transaction builds are fast enough that worker overhead isn't worth it,
    // and this ensures immediate execution without queue delays or worker thread creation overhead
    return buildTransactionSummary(plan, undefined, undefined);
  }

  // ============================================================================
  // Arbitrage Executor API Routes
  // ============================================================================

  // Start the automatic arbitrage executor
  api.post('/arb/executor/start', async (req: Request, res: Response) => {
    try {
      // Load config from file or use provided config
      let config = req.body || {};
      if (Object.keys(config).length === 0) {
        try {
          const configPath = 'backend/config/arbExecutor.json';
          config = await readJson(configPath, {});
        } catch {}
      }
      
      // Migrate old dynamicSizing config to new sizingConfig if needed
      // This ensures the capacity-based sizing system is used
      const { migrateExecutorConfig } = await import('../../execution/capacity/configMigration.js');
      config = migrateExecutorConfig(config);
      
      const executor = getArbExecutor(config);
      await executor.start();
      
      logger.info('arb.executor.api.started', { cat: 'arb', config });
      res.json({ status: 'started', ...executor.getStatus() });
    } catch (e: any) {
      logger.error('arb.executor.api.start_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Stop the automatic arbitrage executor
  api.post('/arb/executor/stop', async (_req: Request, res: Response) => {
    try {
      stopArbExecutor();
      logger.info('arb.executor.api.stopped', { cat: 'arb' });
      res.json({ status: 'stopped' });
    } catch (e: any) {
      logger.error('arb.executor.api.stop_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get executor status - fast path, no dynamic imports
  api.get('/arb/executor/status', (_req: Request, res: Response) => {
    try {
      const executor = getArbExecutor();
      res.json(executor.getStatus());
    } catch (e: any) {
      res.json({ running: false, error: 'not initialized' });
    }
  });

  // Get executor configuration from file
  api.get('/arb/executor/config', async (_req: Request, res: Response) => {
    try {
      const configPath = 'backend/config/arbExecutor.json';
      const config = await readJson(configPath, {});
      
      // Auto-migrate old dynamicSizing config to new sizingConfig if needed
      const { migrateExecutorConfig, needsMigration } = await import('../../execution/capacity/configMigration.js');
      const migratedConfig = migrateExecutorConfig(config);
      
      // If migration was needed, save the migrated config back to file
      if (needsMigration(config)) {
        await writeJson(configPath, migratedConfig);
        logger.info('arb.executor.config_migrated', { cat: 'arb', message: 'Migrated dynamicSizing to sizingConfig' });
      }
      
      res.json(migratedConfig);
    } catch (e: any) {
      logger.error('arb.executor.api.config_read_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Update executor configuration at runtime
  api.post('/arb/executor/config', async (req: Request, res: Response) => {
    try {
      const configPath = 'backend/config/arbExecutor.json';
      
      // Read current config from file
      const currentConfig = await readJson(configPath, {});
      
      // Merge with updates
      const updatedConfig = { ...currentConfig, ...req.body };
      
      // Write back to file
      await writeJson(configPath, updatedConfig);
      
      // If executor is running, reload the FULL config from file and update runtime
      try {
        const executor = getArbExecutor();
        
        // Reload the complete config from file (not just the updates)
        // This ensures the runtime instance always matches what's saved in the file
        let fullConfig = await readJson(configPath, {});
        
        // Migrate to ensure sizingConfig is populated from dynamicSizing
        const { migrateExecutorConfig } = await import('../../execution/capacity/configMigration.js');
        fullConfig = migrateExecutorConfig(fullConfig);
        
        executor.updateConfig(fullConfig); // This will replace the entire config
        
        logger.info('arb.executor.api.config_updated', { 
          cat: 'arb', 
          updates: req.body, 
          runtime: true, 
          fullConfig 
        });
      } catch {
        // Executor not running yet, that's OK - file is updated
        logger.info('arb.executor.api.config_updated', { cat: 'arb', updates: req.body, runtime: false });
      }
      
      res.json({ status: 'updated', config: updatedConfig });
    } catch (e: any) {
      logger.error('arb.executor.api.config_update_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get slippage configuration - fast path, no dynamic imports
  api.get('/arb/slippage/config', (_req: Request, res: Response) => {
    try {
      const config = getSlippageConfig();
      res.json({ config, defaults: DEFAULT_SLIPPAGE_CONFIG });
    } catch (e: any) {
      logger.error('arb.slippage.api.config_read_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Update slippage configuration
  api.post('/arb/slippage/config', (req: Request, res: Response) => {
    try {
      updateSlippageConfig(req.body);
      const updated = getSlippageConfig();
      logger.info('arb.slippage.api.config_updated', { cat: 'arb', updates: req.body, config: updated });
      res.json({ status: 'updated', config: updated });
    } catch (e: any) {
      logger.error('arb.slippage.api.config_update_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Reset slippage configuration to defaults
  api.post('/arb/slippage/config/reset', (_req: Request, res: Response) => {
    try {
      resetSlippageConfig();
      const config = getSlippageConfig();
      logger.info('arb.slippage.api.config_reset', { cat: 'arb', config });
      res.json({ status: 'reset', config, defaults: DEFAULT_SLIPPAGE_CONFIG });
    } catch (e: any) {
      logger.error('arb.slippage.api.config_reset_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get Jito tipping configuration
  api.get('/arb/jito/config', async (_req: Request, res: Response) => {
    try {
      const config = await loadJitoConfig();
      res.json(config);
    } catch (e: any) {
      logger.error('arb.jito.api.config_read_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Update Jito tipping configuration
  api.post('/arb/jito/config', async (req: Request, res: Response) => {
    try {
      const updated = await saveJitoConfig(req.body);
      logger.info('arb.jito.api.config_updated', { cat: 'arb', updates: req.body, config: updated });
      res.json({ status: 'updated', config: updated });
    } catch (e: any) {
      logger.error('arb.jito.api.config_update_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // Pool Quarantine Management APIs
  // ============================================================================

  // Get quarantine status and statistics - fast path, no dynamic imports
  api.get('/arb/quarantine/status', (_req: Request, res: Response) => {
    try {
      const stats = getQuarantineStats();
      res.json(stats);
    } catch (e: any) {
      logger.error('arb.quarantine.api.status_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Clear all auto-quarantines
  api.post('/arb/quarantine/clear', async (_req: Request, res: Response) => {
    try {
      const { clearAllQuarantines } = await import('../../execution/poolFailureTracker.js');
      const count = clearAllQuarantines();
      logger.info('arb.quarantine.api.cleared', { cat: 'arb', count });
      res.json({ status: 'cleared', count });
    } catch (e: any) {
      logger.error('arb.quarantine.api.clear_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Remove specific pool from quarantine
  api.delete('/arb/quarantine/:poolId', async (req: Request, res: Response) => {
    try {
      const { poolId } = req.params;
      if (!poolId) {
        res.status(400).json({ error: 'poolId is required' });
        return;
      }
      
      const { removeFromQuarantine } = await import('../../execution/poolFailureTracker.js');
      const removed = removeFromQuarantine(poolId);
      
      if (removed) {
        logger.info('arb.quarantine.api.removed', { cat: 'arb', poolId });
        res.json({ status: 'removed', poolId });
      } else {
        res.json({ status: 'not_found', poolId, message: 'Pool was not quarantined' });
      }
    } catch (e: any) {
      logger.error('arb.quarantine.api.remove_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Add pool to manual blocklist
  api.post('/arb/blocklist/add', async (req: Request, res: Response) => {
    try {
      const { poolId } = req.body;
      if (!poolId || typeof poolId !== 'string') {
        res.status(400).json({ error: 'poolId (string) is required in request body' });
        return;
      }
      
      const { addToManualBlocklist, getManualBlocklist } = await import('../../execution/poolFailureTracker.js');
      addToManualBlocklist(poolId);
      
      // Also persist to config file
      const { readJson, writeJson } = await import('../../utils/fs.js');
      const configPath = 'backend/config/arbExecutor.json';
      const currentConfig: any = await readJson(configPath, {});
      const blocklist = new Set<string>(currentConfig.manualPoolBlocklist || []);
      blocklist.add(poolId);
      currentConfig.manualPoolBlocklist = Array.from(blocklist);
      await writeJson(configPath, currentConfig);
      
      logger.info('arb.blocklist.api.added', { cat: 'arb', poolId });
      res.json({ status: 'added', poolId, blocklist: getManualBlocklist() });
    } catch (e: any) {
      logger.error('arb.blocklist.api.add_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Remove pool from manual blocklist
  api.post('/arb/blocklist/remove', async (req: Request, res: Response) => {
    try {
      const { poolId } = req.body;
      if (!poolId || typeof poolId !== 'string') {
        res.status(400).json({ error: 'poolId (string) is required in request body' });
        return;
      }
      
      const { removeFromManualBlocklist, getManualBlocklist } = await import('../../execution/poolFailureTracker.js');
      removeFromManualBlocklist(poolId);
      
      // Also persist to config file
      const { readJson, writeJson } = await import('../../utils/fs.js');
      const configPath = 'backend/config/arbExecutor.json';
      const currentConfig: any = await readJson(configPath, {});
      const blocklist = new Set<string>(currentConfig.manualPoolBlocklist || []);
      blocklist.delete(poolId);
      currentConfig.manualPoolBlocklist = Array.from(blocklist);
      await writeJson(configPath, currentConfig);
      
      logger.info('arb.blocklist.api.removed', { cat: 'arb', poolId });
      res.json({ status: 'removed', poolId, blocklist: getManualBlocklist() });
    } catch (e: any) {
      logger.error('arb.blocklist.api.remove_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get manual blocklist
  api.get('/arb/blocklist', async (_req: Request, res: Response) => {
    try {
      const { getManualBlocklist } = await import('../../execution/poolFailureTracker.js');
      res.json({ blocklist: getManualBlocklist() });
    } catch (e: any) {
      logger.error('arb.blocklist.api.get_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // Pool Substitution Learning APIs
  // ============================================================================

  // Get pool substitution stats and all learned substitutions
  api.get('/arb/poolsub/status', async (_req: Request, res: Response) => {
    try {
      const { 
        getSubstitutionStats, 
        getAllSubstitutions,
        getPoolSubstitutionConfig,
      } = await import('../../execution/poolSubstitutionStore.js');
      
      const stats = getSubstitutionStats();
      const config = getPoolSubstitutionConfig();
      const substitutions = getAllSubstitutions();
      
      res.json({ 
        config,
        stats,
        substitutions: substitutions.map(s => ({
          originalPool: s.originalPoolId,
          originalDex: s.originalDex,
          alternativePool: s.alternativePoolId,
          alternativeDex: s.alternativeDex,
          inputMint: s.inputMint,
          outputMint: s.outputMint,
          successCount: s.successCount,
          failureCount: s.failureCount,
          originalFailCount: s.originalFailCount,
          avgSlippageImprovementBps: s.avgSlippageImprovementBps,
          firstLearnedMs: s.firstLearnedMs,
          lastSuccessMs: s.lastSuccessMs,
          ageMs: Date.now() - s.lastSuccessMs,
        })),
      });
    } catch (e: any) {
      logger.error('arb.poolsub.api.status_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Clear all learned substitutions
  api.post('/arb/poolsub/clear', async (_req: Request, res: Response) => {
    try {
      const { clearSubstitutions } = await import('../../execution/poolSubstitutionStore.js');
      clearSubstitutions();
      res.json({ success: true });
    } catch (e: any) {
      logger.error('arb.poolsub.api.clear_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Prune expired substitutions
  api.post('/arb/poolsub/prune', async (_req: Request, res: Response) => {
    try {
      const { pruneExpired } = await import('../../execution/poolSubstitutionStore.js');
      const pruned = pruneExpired();
      res.json({ success: true, pruned });
    } catch (e: any) {
      logger.error('arb.poolsub.api.prune_failed', { cat: 'arb', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // ALT (Address Lookup Table) Management APIs
  // ============================================================================

  // Get ALT configuration and status
  api.get('/arb/alt/config', async (_req: Request, res: Response) => {
    try {
      const { loadAltConfig } = await import('../../execution/utils/altConfig.js');
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      const config = await loadAltConfig();
      const cachedAlts = dexAltManager.getCachedAltAccounts();
      
      res.json({
        config,
        cache: {
          altCount: cachedAlts.length,
          totalAccounts: cachedAlts.reduce((sum, alt) => sum + (alt.state?.addresses?.length || 0), 0),
          isWarm: dexAltManager.isCacheWarm(),
        },
      });
    } catch (e: any) {
      logger.error('arb.alt.api.config_read_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create common ALT (programs, system accounts, mints)
  api.post('/arb/alt/create/common', async (_req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const { loadAltConfig, saveAltConfig } = await import('../../execution/utils/altConfig.js');
      const { ensureWallet } = await import('../../wallet/wallet.js');
      
      await dexAltManager.initialize();
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      // Check if common ALT already exists
      const config = await loadAltConfig();
      if (config.alts.common) {
        return res.status(400).json({ 
          error: 'Common ALT already exists', 
          address: config.alts.common,
          suggestion: 'Use /arb/alt/extend/common to add more accounts'
        });
      }
      
      // Collect common accounts and create ALT
      const accounts = await (dexAltManager as any).collectCommonAccounts();
      const address = await (dexAltManager as any).createAltOnChain(wallet, accounts, 'common');
      
      // Update config
      config.alts.common = address.toBase58();
      config.walletPublicKey = wallet.publicKey.toBase58();
      config.createdAt = Date.now();
      await saveAltConfig(config);
      
      // Refresh cache
      await dexAltManager.preloadAllAltAccounts();
      
      logger.info('arb.alt.api.common_created', { 
        cat: 'tx', 
        address: address.toBase58(),
        accountCount: accounts.length,
      });
      
      res.json({ 
        status: 'created', 
        category: 'common',
        address: address.toBase58(),
        accountCount: accounts.length,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.common_create_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create flashloan ALT (vault PDAs and token accounts)
  api.post('/arb/alt/create/flashloan', async (req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const { loadAltConfig, saveAltConfig } = await import('../../execution/utils/altConfig.js');
      const { ensureWallet } = await import('../../wallet/wallet.js');
      const { PublicKey } = await import('@solana/web3.js');
      
      await dexAltManager.initialize();
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      // Get vault owner from request or config
      const vaultOwner = req.body.vaultOwner 
        ? new PublicKey(req.body.vaultOwner) 
        : wallet.publicKey;
      
      // Get router program ID from config or request
      const routerProgramId = req.body.routerProgramId
        ? new PublicKey(req.body.routerProgramId)
        : new PublicKey((CONFIG as any)?.router?.programId || '2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw');
      
      // Check if flashloan ALT already exists
      const config = await loadAltConfig();
      if (config.alts.flashloan) {
        return res.status(400).json({ 
          error: 'Flashloan ALT already exists', 
          address: config.alts.flashloan,
        });
      }
      
      // Collect flashloan accounts
      const accounts = await dexAltManager.collectFlashloanAccounts(vaultOwner, routerProgramId);
      const address = await (dexAltManager as any).createAltOnChain(wallet, accounts, 'flashloan');
      
      // Update config
      config.alts.flashloan = address.toBase58();
      await saveAltConfig(config);
      
      // Refresh cache
      await dexAltManager.preloadAllAltAccounts();
      
      logger.info('arb.alt.api.flashloan_created', { 
        cat: 'tx', 
        address: address.toBase58(),
        accountCount: accounts.length,
        vaultOwner: vaultOwner.toBase58(),
      });
      
      res.json({ 
        status: 'created', 
        category: 'flashloan',
        address: address.toBase58(),
        accountCount: accounts.length,
        vaultOwner: vaultOwner.toBase58(),
      });
    } catch (e: any) {
      logger.error('arb.alt.api.flashloan_create_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create user PDAs ALT (wallet ATAs for common mints)
  api.post('/arb/alt/create/user-pdas', async (_req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const { loadAltConfig, saveAltConfig } = await import('../../execution/utils/altConfig.js');
      const { ensureWallet } = await import('../../wallet/wallet.js');
      
      await dexAltManager.initialize();
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      // Check if userPdas ALT already exists
      const config = await loadAltConfig();
      if (config.alts.userPdas) {
        return res.status(400).json({ 
          error: 'User PDAs ALT already exists', 
          address: config.alts.userPdas,
        });
      }
      
      // Collect user PDA accounts
      const accounts = await dexAltManager.collectUserPdaAccounts(wallet.publicKey);
      const address = await (dexAltManager as any).createAltOnChain(wallet, accounts, 'userPdas');
      
      // Update config
      config.alts.userPdas = address.toBase58();
      await saveAltConfig(config);
      
      // Refresh cache
      await dexAltManager.preloadAllAltAccounts();
      
      logger.info('arb.alt.api.userPdas_created', { 
        cat: 'tx', 
        address: address.toBase58(),
        accountCount: accounts.length,
        wallet: wallet.publicKey.toBase58(),
      });
      
      res.json({ 
        status: 'created', 
        category: 'userPdas',
        address: address.toBase58(),
        accountCount: accounts.length,
        wallet: wallet.publicKey.toBase58(),
      });
    } catch (e: any) {
      logger.error('arb.alt.api.userPdas_create_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Create DEX pool ALTs (multiple ALTs for top pools by TVL)
  api.post('/arb/alt/create/dex-pools', async (req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      await dexAltManager.initialize();
      
      type ValidDex = 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap';
      const validDexes: ValidDex[] = ['raydium', 'raydium-amm', 'raydium-cpmm', 'orca', 'meteora', 'meteora-balanced', 'meteora-damm-v1', 'meteora-damm-v2', 'pumpswap'];
      const dexParam = (req.query.dex || req.body.dex) as string;
      const maxPools = Number(req.query.maxPools || req.body.maxPools || 50);
      
      if (!dexParam || !validDexes.includes(dexParam as ValidDex)) {
        return res.status(400).json({ 
          error: `Invalid dex parameter. Must be one of: ${validDexes.join(', ')}`,
        });
      }
      
      const dex = dexParam as ValidDex;
      logger.info('arb.alt.api.dex_pools_start', { cat: 'tx', dex, maxPools });
      
      const result = await dexAltManager.createDexPoolAlts(dex, maxPools);
      
      logger.info('arb.alt.api.dex_pools_created', { 
        cat: 'tx', 
        dex,
        altsCreated: result.addresses.length,
        totalPools: result.totalPools,
        totalAccounts: result.totalAccounts,
      });
      
      res.json({ 
        status: 'created', 
        dex,
        maxPools,
        result,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.dex_pools_create_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get ALT coverage for a route
  api.post('/arb/alt/coverage', async (req: Request, res: Response) => {
    try {
      const { analyzeRouteAlts, DexType } = await import('../../execution/utils/altSelection.js');
      
      const poolIds = req.body.poolIds as string[];
      const dexTypes = (req.body.dexTypes as number[]) || poolIds.map(() => DexType.Raydium);
      
      if (!poolIds || !Array.isArray(poolIds) || poolIds.length === 0) {
        return res.status(400).json({ error: 'poolIds array required' });
      }
      
      const analysis = await analyzeRouteAlts(poolIds, dexTypes);
      
      res.json(analysis);
    } catch (e: any) {
      logger.error('arb.alt.api.coverage_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Extend an existing ALT category with more accounts
  api.post('/arb/alt/extend/:category', async (req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      await dexAltManager.initialize();
      
      const category = req.params.category;
      const accounts = req.body.accounts as string[];
      const poolIds = req.body.poolIds as string[];
      
      if (poolIds && poolIds.length > 0) {
        // Collect accounts from pools
        const dex = req.body.dex || 'raydium';
        const collectedAccounts: string[] = [];
        
        for (const poolId of poolIds) {
          const poolAccounts = await (dexAltManager as any).collectPoolSpecificAccounts(poolId, dex);
          collectedAccounts.push(...poolAccounts.map((pk: any) => pk.toBase58()));
        }
        
        const result = await dexAltManager.extendAlt(category, collectedAccounts);
        
        logger.info('arb.alt.api.extend_from_pools', { 
          cat: 'tx', 
          category,
          poolCount: poolIds.length,
          accountsAdded: collectedAccounts.length,
          newTotal: result.accountCount,
        });
        
        res.json({ 
          status: 'extended', 
          category,
          ...result,
          poolsAdded: poolIds.length,
        });
      } else if (accounts && accounts.length > 0) {
        // Extend with explicit accounts
        const result = await dexAltManager.extendAlt(category, accounts);
        
        logger.info('arb.alt.api.extend', { 
          cat: 'tx', 
          category,
          accountsAdded: accounts.length,
          newTotal: result.accountCount,
        });
        
        res.json({ 
          status: 'extended', 
          category,
          ...result,
        });
      } else {
        return res.status(400).json({ 
          error: 'Either accounts array or poolIds array required' 
        });
      }
    } catch (e: any) {
      logger.error('arb.alt.api.extend_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Refresh ALT cache
  api.post('/arb/alt/refresh', async (_req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      const result = await dexAltManager.preloadAllAltAccounts();
      
      logger.info('arb.alt.api.cache_refreshed', { cat: 'tx', ...result });
      
      res.json({ 
        status: 'refreshed', 
        loaded: result.loaded,
        failed: result.failed,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.refresh_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get pool-to-ALT mapping info
  api.get('/arb/alt/pools', async (req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const { loadAltConfig } = await import('../../execution/utils/altConfig.js');
      
      const config = await loadAltConfig();
      const poolToAlt = config.poolToAlt || {};
      const poolCount = Object.keys(poolToAlt).length;
      
      // If poolId query param, return specific pool info
      const poolId = req.query.poolId as string;
      if (poolId) {
        const altAddress = await dexAltManager.getAltForPool(poolId);
        return res.json({
          poolId,
          altAddress: altAddress || null,
          isCovered: !!altAddress,
        });
      }
      
      res.json({
        totalTrackedPools: poolCount,
        dexAlts: config.dexAlts || {},
        sampleMappings: Object.fromEntries(
          Object.entries(poolToAlt).slice(0, 20)
        ),
      });
    } catch (e: any) {
      logger.error('arb.alt.api.pools_read_failed', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // NEW ALT MANAGEMENT ENDPOINTS
  // ============================================================================

  /**
   * POST /api/arb/alts/create-all
   * Create ALTs for ALL pools in the graph for each DEX.
   * This is a long-running operation and may create multiple ALTs per DEX.
   */
  api.post('/arb/alts/create-all', async (req: Request, res: Response) => {
    try {
      logger.info('arb.alt.api.create_all.start', { cat: 'tx' });
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      // This operation can take a while - start immediately and stream progress
      const result = await dexAltManager.createAllAlts();
      
      const summary = {
        common: result.common ? { address: result.common } : null,
        raydium: {
          altsCreated: result.raydium.addresses.length,
          totalPools: result.raydium.totalPools,
          totalAccounts: result.raydium.totalAccounts,
        },
        orca: {
          altsCreated: result.orca.addresses.length,
          totalPools: result.orca.totalPools,
          totalAccounts: result.orca.totalAccounts,
        },
        meteora: {
          altsCreated: result.meteora.addresses.length,
          totalPools: result.meteora.totalPools,
          totalAccounts: result.meteora.totalAccounts,
        },
        totalAlts: 
          (result.common ? 1 : 0) +
          result.raydium.addresses.length +
          result.orca.addresses.length +
          result.meteora.addresses.length,
      };
      
      logger.info('arb.alt.api.create_all.complete', { cat: 'tx', ...summary });
      
      res.json({ 
        status: 'success',
        ...summary,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.create_all.error', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * GET /api/arb/alts/coverage
   * Get ALT coverage statistics for pools in the graph.
   */
  api.get('/arb/alts/coverage', async (req: Request, res: Response) => {
    try {
      const { loadAltConfig } = await import('../../execution/utils/altConfig.js');
      const { getGraphSnapshot } = await import('../graph.js');
      
      const config = await loadAltConfig();
      const snapshot = await getGraphSnapshot();
      
      // Count pools by DEX
      const dexPools: Record<string, Set<string>> = {
        raydium: new Set<string>(),
        orca: new Set<string>(),
        meteora: new Set<string>(),
        pumpswap: new Set<string>(),
        other: new Set<string>(),
      };
      
      if (snapshot?.edges) {
        for (const edge of snapshot.edges) {
          const poolId = String(edge.pool_id || '');
          if (!poolId || /[#-]rev$/.test(poolId)) continue;
          
          const cleanPoolId = poolId.replace(/-(rev|fwd)$/, '');
          const dex = String(edge.dex || '').toLowerCase();
          
          if (dex === 'raydium') dexPools.raydium.add(cleanPoolId);
          else if (dex === 'orca') dexPools.orca.add(cleanPoolId);
          else if (dex === 'meteora') dexPools.meteora.add(cleanPoolId);
          else if (dex === 'pumpswap') dexPools.pumpswap.add(cleanPoolId);
          else dexPools.other.add(cleanPoolId);
        }
      }
      
      // Calculate coverage
      const poolToAlt = config.poolToAlt || {};
      const coverage: Record<string, { total: number; covered: number; percent: string }> = {};
      
      for (const [dex, pools] of Object.entries(dexPools)) {
        let covered = 0;
        for (const poolId of pools) {
          if (poolToAlt[poolId]) covered++;
        }
        coverage[dex] = {
          total: pools.size,
          covered,
          percent: pools.size > 0 ? `${((covered / pools.size) * 100).toFixed(1)}%` : 'N/A',
        };
      }
      
      // Total coverage
      const allPools = Object.values(dexPools).reduce((sum, set) => sum + set.size, 0);
      const allCovered = Object.keys(poolToAlt).length;
      
      res.json({
        total: {
          pools: allPools,
          coveredInMapping: allCovered,
          percent: allPools > 0 ? `${((allCovered / allPools) * 100).toFixed(1)}%` : 'N/A',
        },
        byDex: coverage,
        alts: {
          common: config.alts.common || null,
          flashloan: config.alts.flashloan || null,
          userPdas: config.alts.userPdas || null,
        },
        dexAlts: {
          raydium: config.dexAlts?.raydium?.addresses?.length || 0,
          orca: config.dexAlts?.orca?.addresses?.length || 0,
          meteora: config.dexAlts?.meteora?.addresses?.length || 0,
        },
      });
    } catch (e: any) {
      logger.error('arb.alt.api.coverage.error', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/extend/:dex
   * Extend ALTs for a specific DEX with new pools from the graph.
   */
  api.post('/arb/alts/extend/:dex', async (req: Request, res: Response) => {
    try {
      const { dex } = req.params;
      const validDexes = ['raydium', 'raydium-amm', 'raydium-cpmm', 'orca', 'meteora', 'meteora-balanced', 'meteora-damm-v1', 'meteora-damm-v2', 'pumpswap'];
      
      if (!validDexes.includes(dex)) {
        return res.status(400).json({ error: `Invalid DEX. Must be one of: ${validDexes.join(', ')}` });
      }
      
      logger.info('arb.alt.api.extend.start', { cat: 'tx', dex });
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      const result = await dexAltManager.createAllDexPoolAlts(dex as 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap');
      
      logger.info('arb.alt.api.extend.complete', { 
        cat: 'tx', 
        dex, 
        altsCreated: result.addresses.length,
        totalPools: result.totalPools,
      });
      
      res.json({
        status: 'success',
        dex,
        altsCreated: result.addresses.length,
        totalPools: result.totalPools,
        totalAccounts: result.totalAccounts,
        altAddresses: result.addresses,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.extend.error', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/common
   * Create or update the common ALT with wallet ATAs and frequently used accounts.
   */
  api.post('/arb/alts/common', async (req: Request, res: Response) => {
    try {
      logger.info('arb.alt.api.common.start', { cat: 'tx' });
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      
      const address = await dexAltManager.createOrUpdateCommonAlt();
      
      if (!address) {
        return res.status(500).json({ error: 'Failed to create common ALT' });
      }
      
      logger.info('arb.alt.api.common.complete', { cat: 'tx', address });
      
      res.json({
        status: 'success',
        address,
      });
    } catch (e: any) {
      logger.error('arb.alt.api.common.error', { cat: 'tx', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ============================================================================
  // ALT Discovery & Management (for ALL wallet-owned ALTs, including orphaned)
  // ============================================================================

  /**
   * GET /api/arb/alts/discover
   * Discover ALL ALTs owned by the wallet on-chain.
   * Returns ALTs that may not be in our config (orphaned/untracked).
   */
  api.get('/arb/alts/discover', async (_req: Request, res: Response) => {
    try {
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const alts = await dexAltManager.discoverWalletAlts();
      
      const summary = {
        total: alts.length,
        inConfig: alts.filter(a => a.inConfig).length,
        orphaned: alts.filter(a => !a.inConfig).length,
        active: alts.filter(a => !a.isDeactivated).length,
        deactivated: alts.filter(a => a.isDeactivated && !a.canClose).length,
        closeable: alts.filter(a => a.canClose).length,
        totalRentSOL: alts.reduce((sum, a) => sum + a.rentLamports, 0) / 1e9,
        recoverableRentSOL: alts.filter(a => a.canClose).reduce((sum, a) => sum + a.rentLamports, 0) / 1e9,
      };
      
      res.json({
        status: 'success',
        summary,
        alts,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/deactivate-by-address
   * Deactivate an ALT by its address (works for orphaned ALTs not in config).
   */
  api.post('/arb/alts/deactivate-by-address', async (req: Request, res: Response) => {
    try {
      const { address } = req.body;
      if (!address) {
        return res.status(400).json({ error: 'address is required' });
      }
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.deactivateAltByAddress(address);
      
      res.json({
        status: 'success',
        ...result,
        message: 'ALT deactivated. Wait ~5 minutes before closing.',
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/close-by-address
   * Close an ALT by its address and recover rent (works for orphaned ALTs not in config).
   */
  api.post('/arb/alts/close-by-address', async (req: Request, res: Response) => {
    try {
      const { address } = req.body;
      if (!address) {
        return res.status(400).json({ error: 'address is required' });
      }
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.closeAltByAddress(address);
      
      res.json({
        status: 'success',
        ...result,
        rentRecoveredSOL: (result.rentRecovered / 1e9).toFixed(6),
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/bulk-deactivate
   * Deactivate multiple ALTs at once.
   */
  api.post('/arb/alts/bulk-deactivate', async (req: Request, res: Response) => {
    try {
      const { addresses } = req.body;
      if (!addresses || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'addresses array is required' });
      }
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.bulkDeactivate(addresses);
      
      res.json({
        status: 'success',
        ...result,
        message: `Deactivated ${result.success.length}/${addresses.length} ALTs. Wait ~5 minutes before closing.`,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * POST /api/arb/alts/bulk-close
   * Close multiple deactivated ALTs at once and recover rent.
   */
  api.post('/arb/alts/bulk-close', async (req: Request, res: Response) => {
    try {
      const { addresses } = req.body;
      if (!addresses || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'addresses array is required' });
      }
      
      const { dexAltManager } = await import('../../execution/utils/altManager.js');
      const result = await dexAltManager.bulkClose(addresses);
      
      res.json({
        status: 'success',
        successCount: result.success.length,
        failedCount: result.failed.length,
        totalRentRecoveredSOL: (result.totalRentRecovered / 1e9).toFixed(6),
        details: result,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


