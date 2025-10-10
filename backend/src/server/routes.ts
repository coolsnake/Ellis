// @ts-nocheck
import type { Express, Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger, setLogLevel, setLoggingEnabled, setFileLogging } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { ensureWallet, getBalances, getPublicKey, generateAndSaveWallet, signAndSendSerializedTransaction, getConnection } from '../wallet/wallet.js';
import { getPriceByMint } from './priceStore.js';
import { readJson, writeJson, joinPath, ensureDir } from '../utils/fs.js';
import { searchTokens } from '../jupiter/tokenApi.js';
import { tradingController } from './tradingController.js';
import { systemStatus } from './status.js';
import { emit } from './realtime.js';
import { getStrategies, upsertStrategy, removeStrategy, migrateSingleStrategy, STRATEGY_LIST_PATH } from '../utils/strategies.js';
import { resolveMint } from '../utils/tokens.js';
import { executeSwap } from '../jupiter/jupiter.js';
import { enablePriceFeed, setPriceFeedInterval, pollPriceFeedNow } from './feedRegistry.js';
import { addWalletHistory, getWalletHistory } from './walletHistory.js';
import { apiStart, apiStop, apiReset, setTargetTickTimeMs } from '../jupiter/rateLimiter.js';
// priceFeed is started in index.ts and broadcasts via websocket
import { getRaydiumPoolsNormalized, getOrcaPoolsCached, startRaydiumRefreshLoop, getPoolsMetrics, getMeteoraPoolsCached } from './pools.js';
import { writeSessionLogAndClear } from '../utils/sessionLogs.js';
import { ResolveDirectSchema } from './routes/schemas.js';
import { createSystemRouter } from './routes/system.js';
import { createTokensRouter } from './routes/tokens.js';
import { createFeesRouter } from './routes/fees.js';
import { createWatchlistRouter } from './routes/watchlist.js';
import { createPricesRouter } from './routes/prices.js';
import { createGraphRouter } from './routes/graph.js';
import { createDebugRouter } from './routes/debug.js';
import { createWalletRouter } from './routes/wallet.js';
import { createSwapRouter } from './routes/swap.js';
import { createDriftRouter } from './routes/drift.js';
import { createLeveragedGridRouter } from './routes/strategies/leveragedGrid.js';
import { createLiquidatorRouter } from './routes/strategies/liquidator.js';
import { createPoolsRouter } from './routes/pools.js';
import { createArbRouter } from './routes/arb.js';

// Opportunity sampling (env knobs + helper)
const OPP_SAMPLE_DIR = process.env.OPP_SAMPLE_DIR || joinPath(CONFIG.logDir, 'opportunity-samples');
const OPP_SAMPLE_RATE = Number(process.env.OPP_SAMPLE_RATE || 1);
const OPP_SAMPLE_THRESHOLD_BPS = Number(process.env.OPP_SAMPLE_THRESHOLD_BPS || 0);
const OPP_SAMPLE_RETENTION_HOURS = Number(process.env.OPP_SAMPLE_RETENTION_HOURS || 1);
const OPP_SAMPLE_RETENTION_MS = Math.max(0, Math.floor(OPP_SAMPLE_RETENTION_HOURS * 60 * 60 * 1000));
const OPP_SAMPLE_MAX_FILES_PER_KIND = Math.max(0, Number(process.env.OPP_SAMPLE_MAX_FILES_PER_KIND || 500));
const OPP_SAMPLE_PRUNE_INTERVAL_MS = Math.max(30000, Number(process.env.OPP_SAMPLE_PRUNE_INTERVAL_MS || 300000));

async function saveOpportunitySampleOnce(kind: 'detected'|'near_miss', o: any): Promise<void> {
  try {
    const { createHash } = await import('crypto');
    const fs = await import('fs/promises');
    const sig = createHash('sha1').update(JSON.stringify({
      path: Array.isArray(o?.path) ? o.path : [],
      dexes: Array.isArray(o?.hop_dexes) ? o.hop_dexes : (Array.isArray(o?.dexes) ? o.dexes : []),
      pools: Array.isArray(o?.hop_pool_ids) ? o.hop_pool_ids : [],
      bps_bucket: Math.round((Number(o?.net_bps ?? o?.profit_bps ?? 0)) / 5) * 5,
    })).digest('hex');
    const dir = joinPath(OPP_SAMPLE_DIR, kind);
    await ensureDir(dir);
    const fp = joinPath(dir, `${sig}.json`);
    try { await fs.access(fp); return; } catch {}
    const bps = Math.round(Number(o?.net_bps ?? o?.profit_bps ?? 0) || 0);
    if (!(bps >= OPP_SAMPLE_THRESHOLD_BPS) && Math.random() >= OPP_SAMPLE_RATE) return;
    await fs.writeFile(fp, JSON.stringify({ saved_at_ms: Date.now(), kind, opportunity: o }, null, 2), 'utf-8');
  } catch {}
}

async function pruneKindDir(kind: 'detected'|'near_miss'): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const dir = joinPath(OPP_SAMPLE_DIR, kind);
    await ensureDir(dir);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { names = []; }
    const paths = names.filter(n => n.toLowerCase().endsWith('.json')).map(n => joinPath(dir, n));
    if (!paths.length) return;
    const stats = await Promise.all(paths.map(async (p) => {
      try { const s = await fs.stat(p); return { path: p, mtimeMs: s.mtimeMs || 0, size: s.size || 0 }; } catch { return null; }
    }));
    const files = stats.filter(Boolean) as { path: string; mtimeMs: number; size: number }[];
    const now = Date.now();
    const cutoff = now - OPP_SAMPLE_RETENTION_MS;
    // Delete by age first
    for (const f of files) {
      if (OPP_SAMPLE_RETENTION_MS > 0 && f.mtimeMs > 0 && f.mtimeMs < cutoff) {
        try { await fs.unlink(f.path); } catch {}
      }
    }
    // Refresh file list after age-based deletes
    let remainingNames: string[] = [];
    try { remainingNames = await fs.readdir(dir); } catch { remainingNames = []; }
    const remainingPaths = remainingNames.filter(n => n.toLowerCase().endsWith('.json')).map(n => joinPath(dir, n));
    if (OPP_SAMPLE_MAX_FILES_PER_KIND > 0 && remainingPaths.length > OPP_SAMPLE_MAX_FILES_PER_KIND) {
      const restats = await Promise.all(remainingPaths.map(async (p) => {
        try { const s = await fs.stat(p); return { path: p, mtimeMs: s.mtimeMs || 0 }; } catch { return null; }
      }));
      const order = (restats.filter(Boolean) as { path: string; mtimeMs: number }[])
        .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      const toDelete = Math.max(0, order.length - OPP_SAMPLE_MAX_FILES_PER_KIND);
      for (let i = 0; i < toDelete; i += 1) {
        try { await fs.unlink(order[i].path); } catch {}
      }
    }
  } catch {}
}

async function pruneOpportunitySamples(): Promise<void> {
  await pruneKindDir('detected');
  await pruneKindDir('near_miss');
}

// Kick off periodic pruning and run once on boot
try { pruneOpportunitySamples().catch(()=>{}); } catch {}
try { setInterval(() => { pruneOpportunitySamples().catch(()=>{}); }, OPP_SAMPLE_PRUNE_INTERVAL_MS); } catch {}

export function registerRoutes(app: Express, io: SocketIOServer): void {
  const api = Router();
  // Removed auto-start of pool refresh loop; use explicit /arb/pools/refresh or /arb/pools/subscribe
  // Arb service observability state
  let lastArbHealthStatus: string | null = null;
  const arbLatency: { metrics: number[]; opps: number[]; lastSummaryAt: number } = { metrics: [], opps: [], lastSummaryAt: 0 };

  // Mount system routes
  api.use(createSystemRouter(io));
  // Mount basic feature routes
  api.use(createTokensRouter(io));
  api.use(createFeesRouter(io));
  api.use(createWatchlistRouter(io));
  api.use(createPricesRouter(io));
  api.use(createGraphRouter(io));
  api.use(createDebugRouter(io));
  api.use(createWalletRouter(io));
  api.use(createSwapRouter(io));
  api.use(createDriftRouter(io));
  api.use(createLeveragedGridRouter(io));
  api.use(createLiquidatorRouter(io));
  api.use(createPoolsRouter(io));
  api.use(createArbRouter(io));

  // --- Direct execution config and routes ---
  api.get('/exec/config', async (_req, res) => {
    try {
      const { loadExecConfig } = await import('./execConfigStore.js');
      const cfg = await loadExecConfig();
      res.json(cfg);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/exec/config', async (req, res) => {
    try {
      const body = req.body || {};
      const { saveExecConfig } = await import('./execConfigStore.js');
      const saved = await saveExecConfig(body);
      // Forward near-miss and debug settings to arb-rs if provided
      try {
        const forward: any = {};
        if (typeof body?.near_miss_enable === 'boolean') forward.near_miss_enable = !!body.near_miss_enable;
        if (typeof body?.debug_top_n === 'number') forward.debug_top_n = Number(body.debug_top_n);
        if (Object.keys(forward).length) {
          const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
          await fetch(`${host}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forward) }).catch(()=>{});
        }
      } catch {}
      res.json(saved);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Fee configuration endpoints
  api.get('/fees/config', async (_req, res) => {
    try {
      const { CONFIG } = await import('../utils/config.js');
      res.json({ fees: CONFIG.fees });
    } catch (e: any) {
      logger.error('Failed to get fee config', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  api.post('/fees/config', async (req, res) => {
    try {
      const { 
        baseFee, priorityFee, maxFee, dynamicFees, feeMultiplier, minFee, maxFeeMultiplier,
        feeUpdateInterval, networkCongestionThreshold, jupiterPriorityFee, jupiterMaxAccounts,
        jupiterDynamicCompute, jupiterLegacyTransaction, jupiterSlippageBps, jupiterMaxSlippageBps
      } = req.body as {
        baseFee?: number;
        priorityFee?: number;
        maxFee?: number;
        dynamicFees?: boolean;
        feeMultiplier?: number;
        minFee?: number;
        maxFeeMultiplier?: number;
        feeUpdateInterval?: number;
        networkCongestionThreshold?: number;
        jupiterPriorityFee?: number;
        jupiterMaxAccounts?: number;
        jupiterDynamicCompute?: boolean;
        jupiterLegacyTransaction?: boolean;
        jupiterSlippageBps?: number;
        jupiterMaxSlippageBps?: number;
      };
      
      // Update CONFIG.fees
      if (baseFee !== undefined) CONFIG.fees.baseFee = Math.max(0, baseFee);
      if (priorityFee !== undefined) CONFIG.fees.priorityFee = Math.max(0, priorityFee);
      if (maxFee !== undefined) CONFIG.fees.maxFee = Math.max(0, maxFee);
      if (dynamicFees !== undefined) CONFIG.fees.dynamicFees = dynamicFees;
      if (feeMultiplier !== undefined) CONFIG.fees.feeMultiplier = Math.max(0.1, Math.min(10, feeMultiplier));
      if (minFee !== undefined) CONFIG.fees.minFee = Math.max(0, minFee);
      if (maxFeeMultiplier !== undefined) CONFIG.fees.maxFeeMultiplier = Math.max(1, Math.min(100, maxFeeMultiplier));
      if (feeUpdateInterval !== undefined) CONFIG.fees.feeUpdateInterval = Math.max(5000, Math.min(300000, feeUpdateInterval));
      if (networkCongestionThreshold !== undefined) CONFIG.fees.networkCongestionThreshold = Math.max(0.1, Math.min(1.0, networkCongestionThreshold));
      
      // Update Jupiter-specific settings
      if (jupiterPriorityFee !== undefined) CONFIG.fees.jupiterPriorityFee = Math.max(0, jupiterPriorityFee);
      if (jupiterMaxAccounts !== undefined) CONFIG.fees.jupiterMaxAccounts = Math.max(1, Math.min(256, jupiterMaxAccounts));
      if (jupiterDynamicCompute !== undefined) CONFIG.fees.jupiterDynamicCompute = jupiterDynamicCompute;
      if (jupiterLegacyTransaction !== undefined) CONFIG.fees.jupiterLegacyTransaction = jupiterLegacyTransaction;
      if (jupiterSlippageBps !== undefined) CONFIG.fees.jupiterSlippageBps = Math.max(1, Math.min(1000, jupiterSlippageBps));
      if (jupiterMaxSlippageBps !== undefined) CONFIG.fees.jupiterMaxSlippageBps = Math.max(1, Math.min(10000, jupiterMaxSlippageBps));
      
      res.json({ fees: CONFIG.fees });
      emit('log', { level: 'info', message: 'Fee configuration updated', timestamp: new Date().toISOString(), context: { ...CONFIG.fees, cat: 'terminal' } });
    } catch (e: any) {
      logger.error('server: failed to update fee config', { error: String(e), cat: 'server' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get('/fees/calculate', async (req, res) => {
    try {
      const { transactionType } = req.query as { transactionType?: 'swap' | 'send' | 'strategy' };
      const { getFeeCalculator } = await import('../utils/feeCalculator.js');
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const calculator = getFeeCalculator(connection);
      
      const fees = await calculator.calculateFees();
      const recommendation = calculator.getFeeRecommendation(transactionType || 'strategy');
      
      res.json({ 
        current: fees, 
        recommendation,
        transactionType: transactionType || 'strategy'
      });
    } catch (e: any) {
      logger.error('server: failed to calculate fees', { error: String(e), cat: 'server' });
      res.status(500).json({ error: String(e) });
    }
  });

  // Wrap / Unwrap SOL
  api.post('/wallet/wrap', async (req, res) => {
    try {
      const { amount } = req.body as { amount: number };
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount > 0 required' });
      const { wrapSol } = await import('../wallet/wallet.js');
      const sig = await wrapSol(Number(amount));
      emit('log', { level: 'info', message: `terminal: wrap SOL success ${amount} sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
  api.post('/wallet/unwrap', async (_req, res) => {
    try {
      const { unwrapSol } = await import('../wallet/wallet.js');
      const sig = await unwrapSol();
      emit('log', { level: 'info', message: `terminal: unwrap SOL success sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // (removed) Duplicate /arb/graph/version route; use routes/arb.ts version

    // Background: poll arb metrics and emit log snapshots
  try {
    let lastActive = -1;
    let lastDet = -1;
    let lastOppSig = '';
    let lastDetWarnAt = 0;
    const stallThresholdMs = 30_000;
    let lastHeartbeatAt = 0;
    let lastConfigAt = 0;
    let zeroDetWarnedAt = 0;
    let lastDeltaWarnAt = 0;
    setInterval(async () => {
      try {
        const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
        const t0 = Date.now();
        const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/metrics/json`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
        const dur = Date.now() - t0;
        if (!r.ok) {
          emit('log', { level: 'warn', message: `pretrade:arb metrics http ${r.status} durMs=${dur}`, timestamp: new Date().toISOString() });
          return;
        }
        let m: any = {};
        try { m = await r.json(); } catch (e: any) {
          emit('log', { level: 'warn', message: `pretrade:arb metrics json parse error: ${String(e?.message || e)}`, timestamp: new Date().toISOString() });
          return;
        }
        try { arbLatency.metrics.push(dur); if (arbLatency.metrics.length > 200) arbLatency.metrics.shift(); } catch {}
        if (typeof m?.opportunities_active === 'number' && m.opportunities_active !== lastActive) {
          lastActive = m.opportunities_active;
          emit('log', { level: 'info', message: `pretrade:arb opps=${lastActive} maxBps=${m?.max_profit_bps ?? 0} nodes=${m?.graph_nodes ?? 0} edges=${m?.graph_edges ?? 0}`, timestamp: new Date().toISOString() });
        }
        // Version delta monitoring
        try {
          const be = await (async () => { try { const { getGraphVersion } = await import('./graph.js'); return getGraphVersion(); } catch { return { version: 0, timestamp: 0 }; } })();
          const arb = { version: Number(m?.arb_graph_version || 0), timestamp: Number(m?.arb_graph_timestamp || 0) };
          const delta = Math.max(0, Number(be.version || 0) - Number(arb.version || 0));
          const ageMs = Math.max(0, Date.now() - Number(arb.timestamp || 0));
          if ((delta > 1 || ageMs > 200) && (Date.now() - lastDeltaWarnAt > 200)) {
            lastDeltaWarnAt = Date.now();
            emit('log', { level: 'warn', message: `graph:version delta=${delta} arbAgeMs=${ageMs}`, timestamp: new Date().toISOString(), context: { cat: 'graph' } });
          }
        } catch {}
        if (typeof m?.last_detection_ms === 'number') {
          if (m.last_detection_ms !== lastDet) {
            lastDet = m.last_detection_ms;
            emit('log', { level: 'info', message: `pretrade:arb lastDetection=${new Date(m.last_detection_ms).toLocaleTimeString()}`, timestamp: new Date().toISOString() });
            lastDetWarnAt = 0; // reset stall warning on fresh detection
          }
          const age = Date.now() - m.last_detection_ms;
          if (age > stallThresholdMs && Date.now() - lastDetWarnAt > stallThresholdMs) {
            lastDetWarnAt = Date.now();
            emit('log', { level: 'warn', message: `pretrade:arb stalled ageMs=${age}`, timestamp: new Date().toISOString() });
          }
          if ((m.last_detection_ms === 0) && (Date.now() - zeroDetWarnedAt > 20000)) {
            zeroDetWarnedAt = Date.now();
            emit('log', { level: 'warn', message: `pretrade:arb no detections yet (last_detection_ms=0). Verify arb service is enabled and pools available.`, timestamp: new Date().toISOString() });
          }
          if (Date.now() - lastHeartbeatAt > 15000) {
            lastHeartbeatAt = Date.now();
            emit('log', { level: 'info', message: `pretrade:arb heartbeat ageMs=${age} active=${m?.opportunities_active ?? 0}`, timestamp: new Date().toISOString() });
          }
        }
        // Poll opportunities and emit summary if changed
        try {
          const o0 = Date.now();
          const or = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 4000); try { return await fetch(`${host}/opportunities`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
          const odur = Date.now() - o0;
          if (or.ok) {
            const payload: unknown = await or.json();
            type ArbOpportunity = { profit_bps?: number; net_bps?: number; path?: string[] };
            type ArbOpportunityFull = ArbOpportunity & {
              est_profit_usd?: number;
              hop_rates?: number[];
              hop_outs?: number[];
              hop_pool_ids?: string[];
              hop_fee_bps?: number[];
              hop_liquidity_display?: number[];
              hop_dexes?: string[];
              dexes?: string[];
              est_capacity?: number;
              bottleneck?: { from?: string; to?: string; dex?: string; rate?: number; liquidity?: number; fee_bps?: number };
            };
            const items: ArbOpportunity[] = Array.isArray((payload as any)?.items)
              ? ((payload as any).items as ArbOpportunity[])
              : (Array.isArray(payload) ? (payload as ArbOpportunity[]) : []);
            const nearItems: ArbOpportunityFull[] = Array.isArray((payload as any)?.near_items)
              ? ((payload as any).near_items as ArbOpportunityFull[])
              : [];
            // Sample and dedupe-save top detected opportunities (best-effort)
            try {
              for (const o of items.slice(0, 3)) {
                saveOpportunitySampleOnce('detected', o as any).catch(()=>{});
              }
            } catch {}
            // richer signature + periodic emit fallback to avoid UI appearing stuck when lower-ranked items change
            (registerRoutes as any)._lastOppEmitAt = (registerRoutes as any)._lastOppEmitAt || 0;
            const richSig = JSON.stringify({
              count: items.length,
              top5: items.slice(0, 5).map((o: ArbOpportunity) => [
                Math.round((o.net_bps ?? o.profit_bps ?? 0)),
                (o.path || []).join('>')
              ]),
              near: (((payload as any)?.summary?.near_miss?.path || []) as string[]).join('>'),
              nearSig: nearItems.slice(0, 3).map(o => [(o.net_bps ?? o.profit_bps ?? 0), (o.path||[]).join('>')])
            });
            const nowMsSig = Date.now();
            const sinceLast = nowMsSig - Number((registerRoutes as any)._lastOppEmitAt || 0);
            if (richSig !== lastOppSig || sinceLast > 2000) {
              lastOppSig = richSig;
              (registerRoutes as any)._lastOppEmitAt = nowMsSig;
              // Avoid emitting arb:opportunities here; the WS bridge forwards live updates to clients
              const lines = items.slice(0, 3).map((o: ArbOpportunity, i: number) => `#${i+1} bps=${Math.round((o.profit_bps ?? o.net_bps ?? 0))} hops=${(o.path || []).length-1} path=${(o.path || []).join('->')}`);
              const nearLine = nearItems?.[0] ? ` | near#1 bps=${Math.round((nearItems[0].profit_bps ?? nearItems[0].net_bps ?? 0))} hops=${(nearItems[0].path||[]).length-1} path=${(nearItems[0].path||[]).join('->')}` : '';
              emit('log', { level: 'info', message: `pretrade:arb opps:update ${Math.min(3, items.length)} top=${lines.join(' | ')}${nearLine} oMs=${odur}`, timestamp: new Date().toISOString() });
              try { arbLatency.opps.push(odur); if (arbLatency.opps.length > 200) arbLatency.opps.shift(); } catch {}
              const topBps = Math.round((items?.[0]?.profit_bps ?? items?.[0]?.net_bps ?? 0));
              if (topBps >= 30) {
                emit('log', { level: 'info', message: `pretrade:arb top>=30bps bps=${topBps} hops=${(items?.[0]?.path||[]).length-1}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              }
              // Emit detailed logs for identified opportunities (top N)
              try {
                const detailed: ArbOpportunityFull[] = (Array.isArray((payload as any)?.items) ? (payload as any).items : []).slice(0, 3);
                for (const [i, o] of detailed.entries()) {
                  const { formatOpportunityLog } = await import('./utils/opportunityLog.js');
                  const msg = formatOpportunityLog(o, i);
                  emit('log', { level: 'info', message: msg, timestamp: new Date().toISOString(), context: { cat: 'opportunity' } });
                }
              } catch {}
            }
            // Emit detailed log for near-miss opportunities when present
            try {
              const summary: any = (payload as any)?.summary || {};
              const near: ArbOpportunityFull | undefined = summary?.near_miss || nearItems?.[0];
              const shortfallBps: number | undefined = summary?.near_miss_shortfall_bps;
              // Keep a signature to avoid spamming identical near-miss logs
              (registerRoutes as any)._lastNearSig = (registerRoutes as any)._lastNearSig || '';
              if (near && typeof shortfallBps === 'number') {
                // Sample and dedupe-save near-miss opportunity (best-effort)
                try { saveOpportunitySampleOnce('near_miss', near as any).catch(()=>{}); } catch {}
                const nearSig = `${Math.round(shortfallBps)}:${(near.path||[]).join('>')}`;
                if ((registerRoutes as any)._lastNearSig !== nearSig) {
                  (registerRoutes as any)._lastNearSig = nearSig;
                  const bps = Math.round((near.profit_bps ?? near.net_bps ?? 0));
                  const path = (near.path || []).join('->');
                  const dexes = (near.hop_dexes || near.dexes || []).join('>');
                  const rates = (near.hop_rates || []).map(v => Number.isFinite(v) ? Number(v).toFixed(8) : String(v)).join(',');
                  const outs = (near.hop_outs || []).map(v => Number.isFinite(v) ? Number(v).toFixed(6) : String(v)).join(',');
                  const fees = (near.hop_fee_bps || []).join(',');
                  const pools = (near.hop_pool_ids || []).join(',');
                  const liqs = (near.hop_liquidity_display || []).map(v => Number.isFinite(v) ? Number(v).toFixed(2) : String(v)).join(',');
                  const cap = (near.est_capacity ?? undefined);
                  const bn = near.bottleneck ? ` from=${near.bottleneck.from} to=${near.bottleneck.to} dex=${near.bottleneck.dex} rate=${near.bottleneck.rate} liq=${near.bottleneck.liquidity} fee_bps=${near.bottleneck.fee_bps}` : '';
                  const msg = `opportunity:near_miss shortfall_bps=${Math.round(shortfallBps)} bps=${bps} hops=${(near.path||[]).length-1} path=${path} dexes=${dexes} rates=[${rates}] outs=[${outs}] fees=[${fees}] pools=[${pools}] liq=[${liqs}] est_capacity=${cap ?? '-'} bottleneck{${bn.trim()}}`;
                  emit('log', { level: 'info', message: msg, timestamp: new Date().toISOString(), context: { cat: 'opportunity' } });
                }
              }
            } catch {}
          }
        } catch {}
        // Periodic latency summary (once per 60s)
        if (Date.now() - arbLatency.lastSummaryAt > 60000) {
          arbLatency.lastSummaryAt = Date.now();
          const summarize = (arr: number[]) => {
            if (!arr.length) return { n: 0 } as any;
            const sorted = [...arr].sort((a, b) => a - b);
            const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
            const sum = arr.reduce((a, b) => a + b, 0);
            return { n: arr.length, min: sorted[0], p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1], avg: Math.round((sum / arr.length) * 10) / 10 };
          };
          const m = summarize(arbLatency.metrics);
          const o = summarize(arbLatency.opps);
          emit('log', { level: 'info', message: `arb:latency metrics n=${m.n||0}${m.n?` min=${m.min} p50=${m.p50} p95=${m.p95} max=${m.max} avg=${m.avg}`:''} | opps n=${o.n||0}${o.n?` min=${o.min} p50=${o.p50} p95=${o.p95} max=${o.max} avg=${o.avg}`:''}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
        }
        // Sample arb config occasionally to report enabled state
        try {
          if (Date.now() - lastConfigAt > 30000) {
            lastConfigAt = Date.now();
            const rc = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/config`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
            if (rc.ok) {
              const cj: any = await rc.json().catch(() => ({}));
              if (typeof cj?.enabled === 'boolean') emit('log', { level: 'info', message: `pretrade:arb config enabled=${cj.enabled}`, timestamp: new Date().toISOString() });
            }
          }
        } catch {}
      } catch {}
    }, 3000);
  } catch {}

  
  api.post('/bot/start', async (_req, res) => {
    try {
      // Resume API and price feed (if watchlist has items)
      apiStart();
      try {
        const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
        enablePriceFeed(Array.isArray(wl) && wl.length > 0);
      } catch {}
      await tradingController.start();
      res.json({ status: 'started' });
      io.emit('system', { bot: 'started' });
      emit('log', { level: 'info', message: 'Bot started', timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('failed to start bot', { error: String(e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
  api.post('/bot/stop', async (_req, res) => {
    try {
      tradingController.stop();
      // Pause API and stop price feed
      apiStop();
      enablePriceFeed(false);
      res.json({ status: 'stopped' });
      io.emit('system', { bot: 'stopped' });
      emit('log', { level: 'info', message: 'Bot stopped', timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('failed to stop bot', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  // Strategy endpoints (multi)
  api.get('/strategy', async (_req, res) => {
    await migrateSingleStrategy();
    const list = await getStrategies();
    res.json({ strategies: list });
    emit('log', { level: 'info', message: `Strategies: ${list.map(s => s.name).join(', ') || '(none)'}`, timestamp: new Date().toISOString() });
  });

  api.post('/strategy', async (req, res) => {
    const item = req.body as any;
    if (!item?.name) return res.status(400).json({ error: 'name required' });
    const name = String(item.name);
    const list = await getStrategies();
    const idx = list.findIndex((s) => s.name === name);
    const existing: any = idx >= 0 ? list[idx] : {};
    const updated: any = { ...existing, name };
    // Map and merge only provided keys
    const has = (k: string) => Object.prototype.hasOwnProperty.call(item, k);
    if (has('token') || has('toToken')) updated.token = String(item.toToken ?? item.token ?? updated.token ?? '');
    if (has('fromToken')) updated.fromToken = item.fromToken ? String(item.fromToken) : undefined;
    if (has('toToken')) updated.toToken = item.toToken ? String(item.toToken) : undefined;
    const toNum = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    if (has('buyPct')) { const n = toNum(item.buyPct); if (n === undefined) return res.status(400).json({ error: 'buyPct must be a number' }); updated.buyPct = n; }
    if (has('sellPct')) { const n = toNum(item.sellPct); if (n === undefined) return res.status(400).json({ error: 'sellPct must be a number' }); updated.sellPct = n; }
    // Accept BPS for thresholds as well (converted to fractions)
    if (has('buyBps')) { const n = toNum(item.buyBps); if (n === undefined) return res.status(400).json({ error: 'buyBps must be a number' }); updated.buyPct = Number(n) / 10000; }
    if (has('sellBps')) { const n = toNum(item.sellBps); if (n === undefined) return res.status(400).json({ error: 'sellBps must be a number' }); updated.sellPct = Number(n) / 10000; }
    if (has('amount')) { const n = toNum(item.amount); if (n === undefined || n <= 0) return res.status(400).json({ error: 'amount must be > 0' }); updated.amount = n; }
    if (has('testMode')) updated.testMode = !!item.testMode;
    if (has('inputMintUSDC')) updated.inputMintUSDC = item.inputMintUSDC;
    if (has('tokenMint')) updated.tokenMint = item.tokenMint;
    if (has('active')) updated.active = item.active !== false;
    if (has('marketEnter')) updated.marketEnter = (item.marketEnter === 'long' || item.marketEnter === 'short') ? item.marketEnter : null;
    if (has('fixedAnchor')) updated.fixedAnchor = item.fixedAnchor === true;
    if (has('anchorPairAtSetup')) updated.anchorPairAtSetup = (typeof item.anchorPairAtSetup === 'number') ? item.anchorPairAtSetup : updated.anchorPairAtSetup;
    if (has('scaleAggressiveness')) { const n = toNum(item.scaleAggressiveness); if (n === undefined || n < 0) return res.status(400).json({ error: 'scaleAggressiveness must be >= 0' }); updated.scaleAggressiveness = n; }
    if (has('scaleStepPct')) { const n = toNum(item.scaleStepPct); if (n === undefined || n < 0) return res.status(400).json({ error: 'scaleStepPct must be >= 0' }); updated.scaleStepPct = n; }
    if (has('slippageBps')) { const n = toNum(item.slippageBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'slippageBps must be >= 0' }); updated.slippageBps = n; }
    if (has('maxOpenPositions')) { const n = toNum(item.maxOpenPositions); if (n === undefined || n < 0) return res.status(400).json({ error: 'maxOpenPositions must be >= 0' }); updated.maxOpenPositions = n; }
    if (has('maxPositionSize')) { const n = toNum(item.maxPositionSize); if (n === undefined || n < 0) return res.status(400).json({ error: 'maxPositionSize must be >= 0' }); updated.maxPositionSize = n; }
    if (has('lst')) updated.lst = item.lst === true;
    if (has('navSource')) updated.navSource = (item.navSource === 'protocol' || item.navSource === 'ema') ? item.navSource : updated.navSource;
    if (has('hysteresisBps')) { const n = toNum(item.hysteresisBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'hysteresisBps must be >= 0' }); updated.hysteresisBps = n; }
    if (has('cooldownMs')) { const n = toNum(item.cooldownMs); if (n === undefined || n < 0) return res.status(400).json({ error: 'cooldownMs must be >= 0' }); updated.cooldownMs = n; }
    if (has('feeBps')) { const n = toNum(item.feeBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'feeBps must be >= 0' }); updated.feeBps = n; }
    if (has('extraSlippageBps')) { const n = toNum(item.extraSlippageBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'extraSlippageBps must be >= 0' }); updated.extraSlippageBps = n; }
    if (has('minEdgeBps')) { const n = toNum(item.minEdgeBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'minEdgeBps must be >= 0' }); (updated as any).minEdgeBps = n; }
    // Sliding anchor
    if (has('slidingAnchor')) updated.slidingAnchor = !!item.slidingAnchor;
    if (has('slideRateBpsPerSec')) { const n = toNum(item.slideRateBpsPerSec); if (n === undefined || n < 0) return res.status(400).json({ error: 'slideRateBpsPerSec must be >= 0' }); (updated as any).slideRateBpsPerSec = n; }
    if (has('slideMaxPct')) { const n = toNum(item.slideMaxPct); if (n === undefined || n < 0) return res.status(400).json({ error: 'slideMaxPct must be >= 0' }); (updated as any).slideMaxPct = n; }

    // Grid strategy parameters
    if (has('gridType')) updated.gridType = String(item.gridType);
    if (has('gridSpacing')) { const n = toNum(item.gridSpacing); if (n === undefined) return res.status(400).json({ error: 'gridSpacing must be a number' }); updated.gridSpacing = n; }
    if (has('gridLevels')) { const n = toNum(item.gridLevels); if (n === undefined) return res.status(400).json({ error: 'gridLevels must be a number' }); updated.gridLevels = n; }
    if (has('centerPrice')) { const n = toNum(item.centerPrice); if (n !== undefined) updated.centerPrice = n; }
    if (has('totalAmount')) { const n = toNum(item.totalAmount); if (n === undefined) return res.status(400).json({ error: 'totalAmount must be a number' }); updated.totalAmount = n; }
    if (has('levelAmount')) { const n = toNum(item.levelAmount); if (n === undefined) return res.status(400).json({ error: 'levelAmount must be a number' }); updated.levelAmount = n; }
    if (has('initialBuyRange')) { const n = toNum(item.initialBuyRange); if (n !== undefined) updated.initialBuyRange = n; }
    if (has('initialSellRange')) { const n = toNum(item.initialSellRange); if (n !== undefined) updated.initialSellRange = n; }
    if (has('maxPositions')) { const n = toNum(item.maxPositions); if (n !== undefined) updated.maxPositions = n; }
    if (has('stopLoss')) { const n = toNum(item.stopLoss); if (n !== undefined) updated.stopLoss = n; }
    if (has('takeProfit')) { const n = toNum(item.takeProfit); if (n !== undefined) updated.takeProfit = n; }
    if (has('rebalanceThreshold')) { const n = toNum(item.rebalanceThreshold); if (n !== undefined) updated.rebalanceThreshold = n; }
    if (has('adaptiveSpacing')) updated.adaptiveSpacing = !!item.adaptiveSpacing;
    if (has('volatilityPeriod')) { const n = toNum(item.volatilityPeriod); if (n !== undefined) updated.volatilityPeriod = n; }
    if (has('minLevelSpacing')) { const n = toNum(item.minLevelSpacing); if (n !== undefined) updated.minLevelSpacing = n; }
    if (has('maxLevelSpacing')) { const n = toNum(item.maxLevelSpacing); if (n !== undefined) updated.maxLevelSpacing = n; }
    // Grid control flags
    if (has('onlyClose')) updated.onlyClose = !!item.onlyClose;
    // Grid bias parameters
    if (has('bias')) {
      const v = String(item.bias);
      if (v === 'neutral' || v === 'long' || v === 'short') updated.bias = v;
    }
    if (has('biasStrength')) {
      const n = toNum(item.biasStrength);
      if (n !== undefined) updated.biasStrength = Math.max(0, Math.min(1, n));
    }
    
    // Sliding center price parameters
    if (has('slidingCenter')) updated.slidingCenter = !!item.slidingCenter;
    if (has('slideRate')) { const n = toNum(item.slideRate); if (n !== undefined) updated.slideRate = n; }
    if (has('slideMaxDistance')) { const n = toNum(item.slideMaxDistance); if (n !== undefined) updated.slideMaxDistance = n; }

    // If fixedAnchor newly requested and no anchor set, capture current pair at setup
    if (has('fixedAnchor') && updated.fixedAnchor && typeof updated.anchorPairAtSetup !== 'number') {
      try {
        if (updated.fromToken && updated.toToken) {
          const fromInfo = await resolveMint(updated.fromToken);
          const toInfo = await resolveMint(updated.toToken);
          const prices = await (await import('../jupiter/jupiter.js')).fetchPricesByMints([fromInfo.mint, toInfo.mint]);
          const fromUsd = prices[fromInfo.mint]?.usdc || null;
          const toUsd = prices[toInfo.mint]?.usdc || null;
          if (fromUsd && toUsd) updated.anchorPairAtSetup = toUsd / fromUsd;
        }
      } catch {}
    }

    // Write back
    if (idx >= 0) list[idx] = updated; else list.push(updated);
    await writeJson(STRATEGY_LIST_PATH, list);
    
    // Process the strategy in trading controller
    try {
      await tradingController.addOrUpdateStrategy();
    } catch (e: any) {
      logger.error('Failed to process strategy in trading controller', { error: String(e) });
    }
    
    res.json({ ok: true, strategies: list });
    emit('log', { level: 'info', message: `Strategy upserted: ${name}`, timestamp: new Date().toISOString(), context: { ...updated, cat: 'terminal' } });
    io.emit('strategies-update', list);
    // Optimistically emit activity stub for UI immediacy
    emit('activity', { strategy: name, status: 'waiting', pair: `${updated.fromToken || 'USDC'}/${updated.toToken || updated.token || 'SOL'}`, trades: [] });
    // Auto-add fromToken/toToken to watchlist
    try {
      const wl = await readJson(CONFIG.watchlistPath, [] as any[]);
      const toAdd: string[] = [];
      if (updated.fromToken) toAdd.push(updated.fromToken);
      if (updated.toToken) toAdd.push(updated.toToken);
      const existingIds = new Set((wl.map((t: any) => (typeof t === 'string' ? t : t.id)) as string[]));
      for (const q of toAdd) {
        if (!q) continue;
        let entry: any | null = null;
        if (q.length > 30) {
          entry = { id: q, symbol: q.slice(0, 4).toUpperCase(), name: q, decimals: 6 };
        } else {
          let r: any[] = [];
          try { r = await searchTokens(q, true); } catch {}
          entry = r[0] || null;
          if (!entry) {
            try {
              const rm = await resolveMint(q);
              if (rm?.mint) entry = { id: rm.mint, symbol: q.toUpperCase(), name: q, decimals: (rm as any).decimals ?? 6 };
            } catch {}
          }
        }
        if (entry && !existingIds.has(entry.id)) {
          wl.push(entry);
          existingIds.add(entry.id);
        }
      }
      await writeJson(CONFIG.watchlistPath, wl);
      io.emit('watchlist-update', wl);
      enablePriceFeed(wl.length > 0);
    } catch {}

    // Incremental trader add/update for immediacy
    try {
      await tradingController.addOrUpdateStrategy();
    } catch {}
  });

  api.delete('/strategy', async (req, res) => {
    const { name } = req.body as { name: string };
    if (!name) return res.status(400).json({ error: 'name required' });
    const list = await removeStrategy(name);
    res.json({ ok: true, strategies: list });
    emit('log', { level: 'info', message: `Strategy removed: ${name}`, timestamp: new Date().toISOString(), context: { cat: 'terminal' } });
    io.emit('strategies-update', list);
    // Clear positions and activity for removed strategy
    try {
      const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      let walletKey: string | null = null;
      try {
        walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      } catch {}
      const instanceKey = `${walletKey}:${name}`;
      // Clear open positions for this strategy
      if (walletKey && (ThresholdTrader as any).positionsFor?.[instanceKey]) {
        (ThresholdTrader as any).positionsFor[instanceKey] = [];
        emit('positions', []);
      }
      // Clear last entry for PnL tracking
      if (walletKey && (ThresholdTrader as any).lastEntryPair?.[instanceKey]) {
        delete (ThresholdTrader as any).lastEntryPair[instanceKey];
      }
      // Clear state (anchor/holding and scale levels)
      if (walletKey && (ThresholdTrader as any).stateFor?.[instanceKey]) {
        delete (ThresholdTrader as any).stateFor[instanceKey];
      }
      // Clear inflight locks for safety
      const inflight = (ThresholdTrader as any).inflightByWallet;
      if (walletKey && inflight && inflight[walletKey]) {
        for (const pairKey of Object.keys(inflight[walletKey] || {})) {
          // delete specific kinds to be safe
          const kinds = inflight[walletKey][pairKey];
          delete kinds.openLong; delete kinds.openShort; delete kinds.closeLong; delete kinds.closeShort; delete kinds.scaleLong; delete kinds.scaleShort;
        }
      }
      emit('activity', { strategy: name, status: 'idle', trades: [] });
      tradingController.removeStrategy(name);
    } catch {}

    // Refresh traders if bot is running
    try {
      const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
      if (!(ThresholdTrader as any).globalHalt) {
        tradingController.stop();
        await tradingController.init();
        await tradingController.start();
      }
    } catch {}
  });

  // Activate/deactivate strategy
  api.post('/strategy/status', async (req, res) => {
    const { name, active } = req.body as { name: string; active: boolean };
    if (!name || typeof active !== 'boolean') return res.status(400).json({ error: 'name and active required' });
    const list = await getStrategies();
    const idx = list.findIndex((s) => s.name === name);
    if (idx < 0) return res.status(404).json({ error: 'strategy not found' });
    (list[idx] as any).active = active;
    await writeJson(STRATEGY_LIST_PATH, list);
    res.json({ ok: true, strategies: list });
    io.emit('strategies-update', list);
    emit('log', { level: 'info', message: `Strategy ${active ? 'activated' : 'deactivated'}: ${name}`, timestamp: new Date().toISOString(), context: { cat: 'terminal' } });
  });

  // Grid strategy specific routes
  api.get('/grid/levels/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Clean up closed positions and their corresponding levels
      GridTrader.cleanupClosedPositions(instanceKey);
      
      // Update grid level statuses based on active positions
      GridTrader.updateGridLevelStatuses(instanceKey);
      
      const levels = GridTrader.getGridLevels(instanceKey);
      let positions = GridTrader.getSuccessfulPositions(instanceKey);
      let activePositions = GridTrader.getActivePositions(instanceKey);
      let tradeHistory = GridTrader.getTradeHistory(instanceKey);
      const state = GridTrader.getGridState(instanceKey);
      
      // Get token information for display using the strategy-specific config
      const strategies = await getStrategies();
      const strat = strategies.find((s) => s.name === strategyName);
      const config = {
        fromToken: (strat as any)?.fromToken || (await GridTrader.prototype.loadConfig.call({})).fromToken || 'USDC',
        toToken: (strat as any)?.toToken || (await GridTrader.prototype.loadConfig.call({})).toToken || 'SOL',
      } as any;
      // Resolve USD prices for tokens (if available) with fetch fallback
      let fromUsd: number | null = null;
      let toUsd: number | null = null;
      try {
        const fromInfo = await resolveMint(config.fromToken || 'USDC');
        const toInfo = await resolveMint(config.toToken || 'SOL');
        fromUsd = getPriceByMint(fromInfo.mint)?.usdc || null;
        toUsd = getPriceByMint(toInfo.mint)?.usdc || null;
        if (!fromUsd || !toUsd) {
          try {
            const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
            const fresh = await fetchPricesByMints([fromInfo.mint, toInfo.mint]);
            fromUsd = fromUsd ?? (fresh[fromInfo.mint]?.usdc ?? null);
            toUsd = toUsd ?? (fresh[toInfo.mint]?.usdc ?? null);
          } catch {}
        }
      } catch {}
      
      // Backfill missing USD fields using current prices as last resort to stabilize display for historical entries
      const backfillUsd = (p: any) => {
        try {
          const from = (state?.fromToken || (p.strategyName ? undefined : undefined)) as string | undefined;
          const entryPair = p.entryPrice;
          if (typeof p.entryUsdPerTo !== 'number' && typeof entryPair === 'number' && typeof fromUsd === 'number' && entryPair > 0) {
            p.entryUsdPerTo = fromUsd / entryPair;
          }
          const exitPair = p.exitPrice;
          if (typeof p.exitUsdPerTo !== 'number' && typeof exitPair === 'number' && typeof fromUsd === 'number' && exitPair > 0) {
            p.exitUsdPerTo = fromUsd / exitPair;
          }
          const plannedPair = p.plannedExitPrice;
          if (typeof p.plannedExitUsdPerTo !== 'number' && typeof plannedPair === 'number' && typeof fromUsd === 'number' && plannedPair > 0) {
            // pair is to per from; USD per to = fromUsd * (to/from)
            p.plannedExitUsdPerTo = fromUsd * plannedPair;
          }
        } catch {}
        return p;
      };

      // Expose stored USD fields transparently
      const mapUsdFields = (p: any) => backfillUsd({
        ...p,
        entryUsdPerTo: p.entryUsdPerTo,
        exitUsdPerTo: p.exitUsdPerTo,
        plannedExitUsdPerTo: p.plannedExitUsdPerTo,
      });

      res.json({ 
        levels, 
        positions: (positions || []).map(mapUsdFields), 
        activePositions: (activePositions || []).map(mapUsdFields),
        tradeHistory: (tradeHistory || []).map(mapUsdFields),
        state,
        strategyName,
        tokens: {
          fromToken: config.fromToken || 'USDC',
          toToken: config.toToken || 'SOL',
          fromSymbol: config.fromToken || 'USDC',
          toSymbol: config.toToken || 'SOL',
          fromUsd,
          toUsd
        },
        // include strategy controls for UI (if present)
        controls: (() => {
          try {
            const item = (strategies || []).find((s) => (s as any)?.name === strategyName) as any;
            return { onlyClose: !!item?.onlyClose };
          } catch { return { onlyClose: false }; }
        })()
      });
    } catch (e: any) {
      logger.error('Failed to get grid levels', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/grid/rebalance/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { centerPrice } = req.body as { centerPrice?: number };
      
      // Get the grid trader instance
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Update center price if provided
      if (centerPrice && GridTrader.getGridState(instanceKey)) {
        GridTrader.getGridState(instanceKey).centerPrice = centerPrice;
        GridTrader.getGridState(instanceKey).lastRebalance = Date.now();
      }
      
      // Trigger rebalancing by clearing existing levels
      GridTrader.getGridLevels(instanceKey).length = 0;
      
      res.json({ ok: true, message: 'Grid rebalancing triggered' });
      emit('log', { 
        level: 'info', 
        message: `Grid rebalancing triggered for ${strategyName}`, 
        timestamp: new Date().toISOString(),
        context: { cat: 'terminal' }
      });
    } catch (e: any) {
      logger.error('Failed to rebalance grid', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/grid/close-position/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { positionId } = req.body as { positionId: string };
      
      if (!positionId) {
        return res.status(400).json({ error: 'Position ID is required' });
      }
      
      // Get the grid trader instance
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Find the position
      const positions = GridTrader.getGridPositions(instanceKey);
      const position = positions.find(p => p.id === positionId && !p.closedAt);
      
      if (!position) {
        return res.status(404).json({ error: 'Position not found or already closed' });
      }
      
      // Get the grid configuration for this specific strategy (not the prototype defaults)
      const listForClose = await getStrategies();
      const stratForClose = listForClose.find((s) => s.name === strategyName);
      const protoCfgForClose = await GridTrader.prototype.loadConfig.call({});
      const config = {
        fromToken: (stratForClose as any)?.fromToken || protoCfgForClose.fromToken || 'USDC',
        toToken: (stratForClose as any)?.toToken || protoCfgForClose.toToken || 'SOL',
      } as any;
      const fromInfo = await resolveMint(config.fromToken || 'USDC');
      const toInfo = await resolveMint(config.toToken || 'SOL');
      
      // Determine swap parameters based on position side
      let inputMint: string, outputMint: string, amount: number;
      
      if (position.side === 'buy') {
        // If it's a buy position, sell the received toToken back to fromToken
        inputMint = toInfo.mint; // sell toToken
        outputMint = fromInfo.mint; // receive fromToken
        // Prefer the actual received toToken amount from the buy fill; fallback to paired sell level amount; lastly to configured amount
        let sellAmountTo = position.filledAmount || 0;
        if (!(sellAmountTo > 0)) {
          try {
            const levels = GridTrader.getGridLevels(instanceKey) || [];
            const pairedSell = levels.find((l: any) => l.side === 'sell' && l.pairedLevelId === (position as any).levelId);
            if (pairedSell && typeof pairedSell.amount === 'number' && pairedSell.amount > 0) sellAmountTo = pairedSell.amount;
          } catch {}
        }
        amount = sellAmountTo || position.amount; // still fallback if needed
      } else {
        // If it's a sell position, we need to buy back the tokens
        inputMint = fromInfo.mint; // spend fromToken
        outputMint = toInfo.mint; // receive toToken
        // For closing a sell, we spend fromToken. Prefer using the intended spend amount from the UI (position.amount is the toToken size at entry),
        // but the actual sent will be read from swap result; use amount here as a ceiling for quote build.
        amount = position.amount || position.filledAmount || 0;
      }
      
      // Get the wallet keypair for signing
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      // In-flight guard for manual close to avoid duplicates
      const inflightKey = `close:${walletKey}:${strategyName}:${positionId}`;
      const now = Date.now();
      (global as any).__inflightClose = (global as any).__inflightClose || new Map<string, number>();
      const inflightMap: Map<string, number> = (global as any).__inflightClose;
      const prev = inflightMap.get(inflightKey);
      if (prev && (now - prev) < 20000) {
        return res.status(429).json({ error: 'Close already in-flight' });
      }
      inflightMap.set(inflightKey, now);

      // Execute the swap to close the position (use high slippage and priority to ensure fill)
      const slippageForClose = Math.max(Number(CONFIG.fees?.jupiterMaxSlippageBps || 500), Number(config.slippageBps || 0));
      const swapResult: any = await executeSwap(
        {
          inputMint,
          outputMint,
          amount: Math.round(amount * Math.pow(10, position.side === 'buy' ? toInfo.decimals : fromInfo.decimals)),
          userPublicKey: walletKey,
          slippageBps: slippageForClose,
          prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
          maxAccounts: CONFIG.fees.jupiterMaxAccounts,
          dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
          asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
        },
        (serialized) => signAndSendSerializedTransaction(serialized, wallet, undefined, 'swap'),
        true, // priority: manual closes should be sent ASAP
        position.side === 'buy' ? fromInfo.decimals : toInfo.decimals // output decimals
      );
      
      // Compute actual exit price from actual amounts when available
      const actualOut = (swapResult as any)?.receivedAmountActual ?? (swapResult as any)?.receivedAmount;
      const actualSent = swapResult.sentAmountActual; // prefer on-chain sent amount when available
      let exitPrice: number | undefined;
      if (position.side === 'buy') {
        // Sold toToken back to fromToken: maintain to per from orientation
        // to per from = soldTo / receivedFrom
        const soldTo = (typeof actualSent === 'number' && actualSent > 0)
          ? actualSent
          : (position.filledAmount || 0);
        const receivedFrom = actualOut;
        if (soldTo > 0 && typeof receivedFrom === 'number' && receivedFrom > 0) exitPrice = soldTo / receivedFrom;
      } else {
        // Bought toToken using fromToken: to per from = receivedTo / spentFrom
        const spentFrom = (typeof actualSent === 'number' && actualSent > 0)
          ? actualSent
          : (position.filledAmount || position.amount || 0);
        const receivedTo = actualOut;
        if (spentFrom > 0 && typeof receivedTo === 'number' && receivedTo > 0) exitPrice = receivedTo / spentFrom;
      }

      // Update the position as closed
      position.closedAt = Date.now();
      position.exitPrice = Math.abs(exitPrice ?? position.entryPrice);
      position.exitTransactionSignature = swapResult.signature;
      position.status = 'closed';
      position.timeSinceOpen = Date.now() - (position.openedAt || Date.now());
      
      // Calculate PNL if we have an exitPrice
      if (position.exitPrice !== undefined) {
        const qty = position.side === 'buy' ? (position.filledAmount || 0) : (position.amount || 0);
        const priceDiff = (position.side === 'buy') ? (position.exitPrice - position.entryPrice) : (position.entryPrice - position.exitPrice);
        position.pnl = priceDiff * qty;
      } else {
        position.pnl = 0;
      }
      
      // Update Grid state and levels to reflect manual close
      try {
        GridTrader.manualClosePosition(
          instanceKey,
          position.id,
          exitPrice,
          swapResult.signature,
          actualOut,
          amount
        );
        GridTrader.cleanupClosedPositions(instanceKey);
        GridTrader.updateGridLevelStatuses(instanceKey);
      } catch {}

      // Emit user-facing trade log for manual close (User Log)
      try {
        const fromSym = config.fromToken || 'FROM';
        const toSym = config.toToken || 'TO';
        const inputAmt = amount; // amount of input token spent/sold
        const outputAmt = swapResult.receivedAmountActual ?? swapResult.receivedAmount;
        const msg = position.side === 'buy'
          // we sold toToken back to fromToken
          ? `trade: manual-close ${strategyName} sell ${inputAmt} ${toSym} -> ${outputAmt} ${fromSym}${exitPrice ? ` @ ${exitPrice}` : ''}`
          // we bought toToken back using fromToken
          : `trade: manual-close ${strategyName} buy ${inputAmt} ${fromSym} -> ${outputAmt} ${toSym}${exitPrice ? ` @ ${exitPrice}` : ''}`;
        emit('log', { level: 'info', message: msg, timestamp: new Date().toLocaleTimeString(), context: { cat: 'trade', strategy: strategyName } });
      } catch {}

      res.json({ 
        ok: true, 
        message: 'Position closed successfully',
        signature: swapResult.signature,
        receivedAmount: swapResult.receivedAmount,
        receivedAmountActual: swapResult.receivedAmountActual,
        sentAmountActual: swapResult.sentAmountActual
      });
      
      emit('log', { 
        level: 'info', 
        message: `Position ${positionId} closed manually`, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (e: any) {
      logger.error('Failed to close position', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      try {
        const { strategyName } = req.params as any;
        const { positionId } = (req.body || {}) as any;
        const wallet = await ensureWallet(CONFIG.walletPath);
        const walletKey = wallet.publicKey.toBase58();
        const inflightKey = `close:${walletKey}:${strategyName}:${positionId}`;
        (global as any).__inflightClose?.delete?.(inflightKey);
      } catch {}
    }
  });

  api.get('/grid/performance/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      const levels = GridTrader.getGridLevels(instanceKey);
      const positions = GridTrader.getGridPositions(instanceKey);
      const state = GridTrader.getGridState(instanceKey);
      
      // Calculate performance metrics
      const totalLevels = levels.length;
      const filledLevels = levels.filter(l => l.filled).length;
      const activePositions = positions.filter(p => !p.closedAt).length;
      const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
      const winRate = positions.length > 0 ? 
        positions.filter(p => (p.pnl || 0) > 0).length / positions.length : 0;
      
      res.json({
        strategyName,
        totalLevels,
        filledLevels,
        activePositions,
        totalPnl,
        winRate,
        state,
        recentTrades: positions.slice(-10)
      });
    } catch (e: any) {
      logger.error('Failed to get grid performance', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/terminal/log', async (req, res) => {
    const { level = 'info', message, cat } = req.body as { level?: string; message: string; cat?: string };
    const normalizedCat = typeof cat === 'string' && cat.trim() ? String(cat).toLowerCase() : undefined;
    emit('log', { level, message, timestamp: new Date().toISOString(), cat: normalizedCat, context: normalizedCat ? { cat: normalizedCat } : undefined });
    res.json({ ok: true });
  });

  api.post('/api/stop', async (_req, res) => {
    apiStop();
    enablePriceFeed(false);
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API paused', timestamp: new Date().toISOString() });
  });

  api.post('/api/start', async (_req, res) => {
    apiStart();
    // do not auto-enable price feed; user must add watchlist or run apistart + enable watchlist
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API resumed', timestamp: new Date().toISOString() });
  });

  api.post('/api/reset', async (_req, res) => {
    apiReset();
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API window reset', timestamp: new Date().toISOString() });
  });

  // Configure Target Tick Time (TTT) in ms; updates rate limiter, price feed, and traders
  api.post('/ticktime', async (req, res) => {
    try {
      const { ms } = req.body as { ms: number };
      const value = Math.max(200, Math.floor(Number(ms) || 0));
      setTargetTickTimeMs(value);
      setPriceFeedInterval(value);
      tradingController.setTickTimeMs(value);
      res.json({ ok: true, targetTickTimeMs: value });
      emit('log', { level: 'info', message: `terminal: ticktime set to ${value} ms`, timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(400).json({ error: 'invalid ms' });
    }
  });

	// Reset configurable parameters (watchlist, strategies, wallet tokens), preserving wallet key
	api.post('/config/reset', async (_req, res) => {
		try {
			// Halt trading and clear traders first
			try { tradingController.stop(); } catch {}
            await writeJson(CONFIG.watchlistPath, []);
            await writeJson(STRATEGY_LIST_PATH, []);
            await writeJson(CONFIG.walletTokensPath, []);
			io.emit('watchlist-update', []);
			io.emit('strategies-update', []);
			// Stop trading and clear all in-memory strategy/position state
			try {
				const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
				// Clear all positions/state/entries for every instance key
				for (const key of Object.keys((ThresholdTrader as any).positionsFor || {})) {
					(ThresholdTrader as any).positionsFor[key] = [];
				}
				for (const key of Object.keys((ThresholdTrader as any).stateFor || {})) {
					delete (ThresholdTrader as any).stateFor[key];
				}
				for (const key of Object.keys((ThresholdTrader as any).lastEntryPair || {})) {
					delete (ThresholdTrader as any).lastEntryPair[key];
				}
				// Clear inflight locks
				const inflight = (ThresholdTrader as any).inflightByWallet || {};
				for (const w of Object.keys(inflight)) {
					for (const pairKey of Object.keys(inflight[w] || {})) {
						delete inflight[w][pairKey].openLong;
						delete inflight[w][pairKey].openShort;
						delete inflight[w][pairKey].closeLong;
						delete inflight[w][pairKey].closeShort;
						delete inflight[w][pairKey].scaleLong;
						delete inflight[w][pairKey].scaleShort;
					}
				}
				// Broadcast cleared positions and stopped bot status
				emit('positions', []);
				io.emit('system', { bot: 'stopped' });
			} catch {}
			enablePriceFeed(false);
			res.json({ ok: true });
			emit('log', { level: 'info', message: 'Config reset (watchlist, strategies, wallet tokens) — trading halted and positions cleared', timestamp: new Date().toISOString() });
		} catch (e: any) {
			logger.error('config reset failed', { error: String(e) });
			res.status(500).json({ error: String(e) });
		}
	});

  app.use('/api', api);

  logger.info('API routes registered');
}


