import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger.js';
import { setLogLevel } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { registerRoutes } from './routes.js';
import { createPriceFeed } from './priceFeed.js';
import { setPriceFeedRef, enablePriceFeed, isPriceFeedEnabled } from './feedRegistry.js';
import { createWalletFeed } from './walletFeed.js';
import { systemStatus } from './status.js';
import { setIo, emit } from './realtime.js';
import { startGraphStream } from './graph.js';
import { setWalletHistorySocket, initWalletHistory, getWalletHistory } from './walletHistory.js';
import { apiStop, setTargetTickTimeMs } from '../jupiter/rateLimiter.js';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { recordSessionLog, writeSessionLogAndClear } from '../utils/sessionLogs.js';
import { readJson } from '../utils/fs.js';
import { startRaydiumRefreshLoop } from './pools.js';
import util from 'util';

const app = express();
// Respect X-Forwarded-* from Nginx
try { app.set('trust proxy', 1); } catch {}
// Optionally enforce HTTPS (behind reverse proxy)
app.use((req: Request, res: Response, next: NextFunction) => {
  try {
    const requireHttps = !!((CONFIG as any)?.system?.requireHttps);
    if (requireHttps) {
      const xfProto = (req.headers['x-forwarded-proto'] as string) || '';
      if (xfProto && xfProto !== 'https') {
        const host = String(req.headers.host || '');
        const url = `https://${host}${req.originalUrl || ''}`;
        return res.redirect(301, url);
      }
    }
  } catch {}
  next();
});
// Allow restricting CORS via env; default to permissive during development
const corsOrigin = (CONFIG as any)?.system?.corsOrigin || process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin, credentials: true } as any));
app.use(express.json());

//

//

//

// Optional Basic Auth for API
function unauthorized(res: Response) {
  // Do not set WWW-Authenticate to avoid triggering browser credential popups
  try { res.removeHeader('WWW-Authenticate'); } catch {}
  return res.status(401).json({ error: 'Unauthorized' });
}
function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  try {
    if (!header) return null;
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return { user, pass };
  } catch {
    return null;
  }
}
function checkBasicAuth(header: string | undefined): boolean {
  try {
    const parsed = parseBasicAuth(header);
    if (!parsed) return false;
    const { user, pass } = parsed;
    const expectUser = String(((CONFIG as any)?.auth?.user) || '');
    const expectPass = String(((CONFIG as any)?.auth?.pass) || '');
    return !!(user && pass && user === expectUser && pass === expectPass);
  } catch {
    return false;
  }
}
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const ok = checkBasicAuth(req.headers['authorization'] as string | undefined);
  if (ok) {
    // Log a single clear login event when frontend probes /api/system during login
    try {
      if (req.method === 'GET' && (req.path === '/system' || req.originalUrl?.includes('/system'))) {
        const parsed = parseBasicAuth(req.headers['authorization'] as string | undefined);
        const user = parsed?.user || '(unknown)';
        const ip = (req.headers['x-forwarded-for'] as string) || req.ip;
        const ua = (req.headers['user-agent'] as string) || '';
        logger.info('auth.login', { user, ip, ua, cat: 'auth' });
      }
    } catch {}
    return next();
  }
  return unauthorized(res);
});

// API request/response logging with timestamps
app.use((req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  (req as any).reqId = reqId;
  logger.info(`api.request ${req.method} ${req.path}`, { reqId, cid: reqId, method: req.method, path: req.path, query: req.query, body: req.body, ip: req.ip, ua: req.headers['user-agent'], cat: 'api', subcat: 'http', code: 'API.REQUEST', span: 'start' });
  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    logger.info(`api.response ${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`, { reqId, cid: reqId, method: req.method, path: req.path, status: res.statusCode, durationMs, cat: 'api', subcat: 'http', code: 'API.RESPONSE', span: 'end' });
  });
  next();
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  path: (CONFIG as any).socketIoPath || '/socket.io',
  cors: { origin: corsOrigin === '*' ? true : corsOrigin }
});

// Optional Basic Auth for Socket.IO (works when browser sends Authorization, e.g., via Nginx Basic Auth)
io.use((socket, next) => {
  try {
    const header = (socket.request.headers['authorization'] as string) || '';
    // Support client-provided auth via handshake payload when running in browser
    const hAuth: any = (socket.handshake && (socket.handshake as any).auth) || {};
    const user: string | undefined = (typeof hAuth?.user === 'string') ? hAuth.user : undefined;
    const pass: string | undefined = (typeof hAuth?.pass === 'string') ? hAuth.pass : undefined;
    const expectUser = String(((CONFIG as any)?.auth?.user) || '');
    const expectPass = String(((CONFIG as any)?.auth?.pass) || '');
    if (user && pass && user === expectUser && pass === expectPass) return next();
    if (checkBasicAuth(header)) return next();
    return next(new Error('unauthorized'));
  } catch (e) {
    return next(new Error('unauthorized'));
  }
});

setIo(io);
setWalletHistorySocket(io);
// Graph stream will be started after first socket connection or after a delay (below)
io.on('connection', (socket) => {
  logger.info('server: socket client connected', { id: socket.id, cat: 'server' });
  try {
    const hAuth: any = (socket.handshake && (socket.handshake as any).auth) || {};
    const user: string | undefined = (typeof hAuth?.user === 'string') ? hAuth.user : undefined;
    const ua: string = (socket.handshake && (socket.handshake.headers && (socket.handshake.headers['user-agent'] as string))) || '';
    // Prefer X-Forwarded-For from reverse proxy when present
    const forwarded = (socket.handshake && socket.handshake.headers && (socket.handshake.headers['x-forwarded-for'] as string)) || '';
    const ip = forwarded || (socket.handshake && (socket.handshake.address as any)) || (socket.conn && (socket.conn.remoteAddress as any)) || '';
    logger.info('auth.socket_connected', { user: user || '(unknown)', ip, ua, id: socket.id, cat: 'auth' });
  } catch {}
  socket.emit('system', { status: 'connected', version: '1.0.0', uptimeMs: Date.now() - systemStatus.startTimeMs, lastPriceUpdateMs: systemStatus.lastPriceUpdateMs });
  try {
    const hist = getWalletHistory();
    socket.emit('wallet-history', hist);
  } catch {}
  try {
    // Debounced graph rebuild on pool updates
    socket.on('connect_ack', () => {});
  } catch {}
});

// Bridge logger to websocket with local-time timestamp (no ms)
const ts = () => new Date().toLocaleTimeString();

// Ensure WS subscriptions are cancelled on graceful shutdown
const shutdownWs = async () => {
  try {
    const { disablePoolWebsocketRefreshes } = await import('./pools.js');
    disablePoolWebsocketRefreshes();
    try { (await import('./realtime.js')).emit('log', { level: 'info', message: 'pools:ws disabled on shutdown', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  } catch {}
  try { io.close(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdownWs);
process.on('SIGTERM', shutdownWs);
let lastLogSig: { msg: string; level: string; ts: number } | null = null;

// Capture selected third-party console logs (e.g., Raydium SDK) into session logs without looping
try {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const maybeRecord = (level: 'info'|'warn'|'error', args: any[]) => {
    try {
      const text = util.format.apply(null, args as any);
      // Heuristic: capture Raydium SDK logs only; avoid duplicating our own logger output
      if (/Raydium[_:\s]/i.test(text)) {
        recordSessionLog({ level, message: text, timestamp: new Date().toISOString(), context: { cat: 'raydium' } });
      }
    } catch {}
  };
  console.log = (...args: any[]) => { maybeRecord('info', args); origLog(...args); };
  console.warn = (...args: any[]) => { maybeRecord('warn', args); origWarn(...args); };
  console.error = (...args: any[]) => { maybeRecord('error', args); origError(...args); };
} catch {}

logger.on('log', (event: any) => {
  const msg: string = event?.message || '';
  const level = String(event?.level || 'info').toLowerCase();
  // Only suppress debug in non-debug mode; when system logLevel is debug, forward all
  const systemLevel = String(((CONFIG as any)?.system?.log?.level || (CONFIG as any)?.system?.logLevel || process.env.LOG_LEVEL || 'info')).toLowerCase();
  if (level === 'debug' && systemLevel !== 'debug') return;
  // Prefer provided cat/subcat/code; compute cat only if missing
  let cat: string | undefined = (event?.cat || event?.context?.cat);
  if (!cat) {
    if (/^api[.:]\b|^api\b/i.test(msg)) cat = 'api';
    else if (/^(jup|jupiter)[.:]\b|^(jup|jupiter)\b/i.test(msg)) cat = 'jupiter';
    else if (/^raydium[.:]\b|^raydium\b/i.test(msg)) cat = 'raydium';
    else if (/^orca[.:]\b|^orca\b/i.test(msg)) cat = 'orca';
    else if (/^arb[.:]\b|\barb\b/i.test(msg)) cat = 'arb';
    else if (/^opportunity[.:]\b|^opportunity\b|opps?:update|near[_-]?miss|arb\.opportunity|arb\.near_miss/i.test(msg)) cat = 'opportunity';
    else if (/^drift[.:]\b|^drift\b/i.test(msg)) cat = 'drift';
    else if (/^strategy[.:]\b|^strategy\b/i.test(msg)) cat = 'strategy';
    else if (/^pretrade[.:]\b|^pretrade\b/i.test(msg)) cat = 'pretrade';
    else if (/^trade[.:]\b|^trade\b/i.test(msg)) cat = 'trade';
    else if (/^terminal[.:]\b|^terminal\b/i.test(msg)) cat = 'terminal';
    else if (/^graph[.:]\b|^graph\b/i.test(msg)) cat = 'graph';
    else if (/^pools?[.:]\b|^pools?\b/i.test(msg)) cat = 'pools';
    else if (/^price[.:]\b|^price\b/i.test(msg)) cat = 'price';
    else if (/^wallet[.:]\b|^wallet\b/i.test(msg)) cat = 'wallet';
    else if (/^server[.:]\b|^server\b/i.test(msg)) cat = 'server';
  }
  // Secondary heuristics based on substrings when no prefix matched
  if (!cat && /wallet|watchlist|token account|token search/i.test(msg)) cat = 'wallet';
  if (!cat && /graph/i.test(msg)) cat = 'graph';
  if (!cat && /pools?/i.test(msg)) cat = 'pools';
  if (!cat && /price/i.test(msg)) cat = 'price';
  if (!cat && /swap|trade/i.test(msg)) cat = 'trade';
  if (!cat && /drift|dlob|perp|subaccount|funding/i.test(msg)) cat = 'drift';
  if (!cat && /grid|strategy/i.test(msg)) cat = 'strategy';
  if (!cat && /server|backend|routes registered|listening on/i.test(msg)) cat = 'server';
  const enriched = { ...event, timestamp: ts(), cat: (cat || 'other').toLowerCase() } as any;
  // Category filtering (legacy): if disabled, drop entirely at backend
  try {
    const enabled: string[] | undefined = (CONFIG as any)?.system?.enabledLogCategories;
    if (Array.isArray(enabled) && enabled.length > 0) {
      const name = String(enriched.cat || 'other').toLowerCase();
      if (!enabled.includes(name)) return;
    }
  } catch {}
  try { recordSessionLog({ level: String(event?.level || 'info'), message: msg, timestamp: enriched.timestamp, context: event?.context, cat: enriched.cat }); } catch {}
  // simple de-dup: drop identical consecutive messages within 800ms
  const now = Date.now();
  if (lastLogSig && lastLogSig.msg === msg && lastLogSig.level === (event?.level || 'info') && (now - lastLogSig.ts) < 800) {
    return;
  }
  lastLogSig = { msg, level: event?.level || 'info', ts: now };
  io.emit('log', enriched);
});

registerRoutes(app, io);

// On startup, broadcast current watchlist and enable price feed if not empty
try {
  const currentWatchlist = await readJson(CONFIG.watchlistPath, [] as any[]);
  io.emit('watchlist-update', currentWatchlist);
  if (currentWatchlist.length > 0) {
    enablePriceFeed(true);
  }
} catch {}

// Periodic watchdog: ensure price feed is enabled when watchlist non-empty
setInterval(async () => {
  try {
    const wl = await readJson(CONFIG.watchlistPath, [] as any[]);
    if (Array.isArray(wl) && wl.length > 0 && !isPriceFeedEnabled()) {
      enablePriceFeed(true);
      io.emit('watchlist-update', wl);
    }
  } catch {}
}, 5000);

// Global error handler to log unhandled errors
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const message = String(err?.message || err);
  logger.error(`api.error ${req.method} ${req.path}: ${message}`, { error: String(err?.stack || err) });
  if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
});

const priceFeed = createPriceFeed(io);
priceFeed.setEnabled(false);
// Initialize target tick time basis
setTargetTickTimeMs(systemStatus.targetTickTimeMs || 2000);
priceFeed.start(systemStatus.targetTickTimeMs || CONFIG.websocketIntervalMs);
setPriceFeedRef(priceFeed);

// Default: API started (allow Jupiter API calls immediately)
const walletFeed = createWalletFeed(io);
setTimeout(() => walletFeed.startEvery(10000), 1500);

// Emit system heartbeat for live uptime/last update
setInterval(() => {
  io.emit('system', {
    uptimeMs: Date.now() - systemStatus.startTimeMs,
    lastPriceUpdateMs: systemStatus.lastPriceUpdateMs,
    rateLimitActive: systemStatus.rateLimitActive,
    cooldownUntilMs: systemStatus.cooldownUntilMs,
    botName: systemStatus.botName,
  });
}, 1000);

// Periodic heartbeat log to reassure the user the program is running
setInterval(() => {
  const last = systemStatus.lastPriceUpdateMs ? new Date(systemStatus.lastPriceUpdateMs).toLocaleTimeString() : '-';
  emit('log', {
    level: 'info',
    message: `heartbeat: ${systemStatus.bot || 'idle'} lastPrice=${last}`,
    timestamp: ts(),
    context: { cat: 'system' }
  });
}, 15000);

// Graceful shutdown: write session logs
async function shutdown() {
  try {
    // Stop timers and clear in-memory caches to force fresh pools/graph on next boot
    try { const pools = await import('./pools.js'); (pools as any).stopPoolRefreshLoop?.(); (pools as any).disablePoolWebsocketRefreshes?.(); (pools as any).clearAllPoolCaches?.(); } catch {}
    // Reset in-memory graph snapshot so nothing is reused
    try { const graph = await import('./graph.js'); (graph as any).rebuildGraphNow?.(undefined); } catch {}
    const file = await writeSessionLogAndClear();
    if (file) { try { console.log('Session log written:', file); } catch {} }
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(CONFIG.port, () => {
  logger.info(`Backend listening on http://localhost:${CONFIG.port}`);
  // Temporarily reduce log verbosity during initial boot, then restore
  try {
    const finalLevel = (CONFIG as any)?.system?.logLevel || 'info';
    setLogLevel('warn' as any);
    setTimeout(() => { try { setLogLevel(finalLevel as any); } catch {} }, 10000);
  } catch {}

  // Post-listen initialization: run migrations and history load without blocking readiness
  setImmediate(async () => {
    try { await initWalletHistory(); } catch {}
    try {
      // One-time migration: move nested resources from backend/backend/* to backend/* if present
      const migratedMarker = resolve('backend', 'logs', '.migrated');
      const alreadyMigrated = await fsp.stat(migratedMarker).then(() => true).catch(() => false);
      // Logs
      if (!alreadyMigrated) {
        try {
          const oldDir = resolve('backend', 'backend', 'logs');
          const newDir = resolve('backend', 'logs');
          const exists = await fsp.stat(oldDir).then(() => true).catch(() => false);
          if (exists) {
            await fsp.mkdir(newDir, { recursive: true });
            const files = await fsp.readdir(oldDir);
            for (const f of files) {
              const src = resolve(oldDir, f);
              const dst = resolve(newDir, f);
              const dstExists = await fsp.stat(dst).then(() => true).catch(() => false);
              if (!dstExists) { try { await fsp.copyFile(src, dst); } catch {} }
            }
            // write marker to avoid re-copying in future boots
            try { await fsp.writeFile(migratedMarker, String(Date.now()), 'utf-8'); } catch {}
          }
        } catch {}
      }
      // Config files
      try {
        const oldCfg = resolve('backend', 'backend', 'config');
        const newCfg = resolve('backend', 'config');
        const cfgExists = await fsp.stat(oldCfg).then(() => true).catch(() => false);
        if (cfgExists) {
          await fsp.mkdir(newCfg, { recursive: true });
          const cfgFiles = ['watchlist.json', 'strategies.json', 'walletTokens.json', 'walletHistory.json', 'tokens.json', 'appInfo.json'];
          for (const f of cfgFiles) {
            const src = resolve(oldCfg, f);
            const dst = resolve(newCfg, f);
            const srcExists = await fsp.stat(src).then(() => true).catch(() => false);
            const dstExists = await fsp.stat(dst).then(() => true).catch(() => false);
            if (srcExists && !dstExists) { try { await fsp.copyFile(src, dst); } catch {} }
          }
        }
      } catch {}
      // Graph highlight diagnostics: log CLMM/AMM pool math when requested from UI
      try {
        io.on('connection', (socket) => {
          socket.on('graph-highlight', async (payload: any) => {
            try {
              const ids: string[] = (payload?.edgeIds || []).filter((x: any) => typeof x === 'string');
              if (!ids.length) return;
              const { peekOrcaPools, peekRaydiumPools } = await import('./pools.js');
              const orc = peekOrcaPools();
              const ray = peekRaydiumPools();
              const all = [...(ray.amm||[]), ...(ray.clmm||[]), ...(orc.amm||[]), ...(orc.clmm||[])];
              for (const id of ids) {
                const base = String(id).replace(/-rev$/,'');
                const p = all.find((x: any) => String(x?.id||'') === base);
                if (!p) continue;
                const mintA = String(p.mint_a); const mintB = String(p.mint_b);
                const decA = Number((p as any)?.decimals_a ?? NaN);
                const decB = Number((p as any)?.decimals_b ?? NaN);
                const s64 = Number((p as any)?.sqrt_price_x64 ?? 0);
                const ratio = s64 > 0 ? (s64 / Math.pow(2,64)) : 0;
                let computed = Number((p as any)?.price_a_per_b || 0);
                try {
                  if (s64 > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
                    // A per 1 B
                    computed = Math.pow(10, (decB as number) - (decA as number)) / (ratio * ratio);
                  }
                } catch {}
                try {
                  logger.info('graph.highlight.pool', { id: base, dex: p.dex, kind: p.pool_kind || 'unknown', mintA, mintB, decA, decB, sqrt_price_x64: s64, ratio, price_a_per_b: (p as any)?.price_a_per_b, computed });
                } catch {}
              }
            } catch {}
          });
        });
      } catch {}
      // Wallet keypair
      try {
        const oldWallet = resolve('backend', 'backend', 'wallet', 'keypair.json');
        const newWalletDir = resolve('backend', 'wallet');
        const newWallet = resolve(newWalletDir, 'keypair.json');
        const oldWalletExists = await fsp.stat(oldWallet).then(() => true).catch(() => false);
        const newWalletExists = await fsp.stat(newWallet).then(() => true).catch(() => false);
        if (oldWalletExists && !newWalletExists) {
          try { await fsp.mkdir(newWalletDir, { recursive: true }); await fsp.copyFile(oldWallet, newWallet); } catch {}
        }
      } catch {}
    } catch {}
  });

  // Background: start periodic pool refresh (includes immediate warmup) if enabled
  // DEPRECATED: avoid auto-starting loops; use /arb/pools/refresh to coordinate fetch+subscribe
  // try { if ((CONFIG as any)?.system?.autoStartPools) { startRaydiumRefreshLoop(); } } catch {}

  // Background: fetch Jupiter token list now and daily refresh
  try {
    import('../utils/tokens.js')
      .then(({ fetchAndCacheJupiterTokens }) => {
        // initial warmup
        try { fetchAndCacheJupiterTokens().catch(() => {}); } catch {}
        // daily refresh
        const dayMs = 24 * 60 * 60 * 1000;
        setInterval(() => { try { fetchAndCacheJupiterTokens().catch(() => {}); } catch {} }, dayMs);
      })
      .catch(() => {});
  } catch {}

  // Start graph stream on first socket connect, or after configured delay
  try {
    let graphStarted = false;
    const startGraph = () => { if (!graphStarted) { try { startGraphStream(io); } catch {} graphStarted = true; } };
    const delayMs = Math.max(0, Number((CONFIG as any)?.system?.graphStartDelayMs || process.env.GRAPH_START_DELAY_MS || 5000));
    setTimeout(startGraph, delayMs);
    io.on('connection', () => startGraph());
  } catch {}
});


