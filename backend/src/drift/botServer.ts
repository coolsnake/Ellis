import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { setIo } from '../server/realtime.js';
import { createTriggerRouter } from '../server/routes/strategies/trigger.js';
import { createFillerRouter } from '../server/routes/strategies/filler.js';
import { createLiquidatorRouter } from '../server/routes/strategies/liquidator.js';
import { createDriftRouter } from '../server/routes/drift.js';

type IoProxy = Pick<SocketIOServer, 'emit'>;

const app = express();
app.use(express.json());

const cfg: any = (CONFIG as any)?.driftBots || {};
const port = Math.max(1, Number(process.env.DRIFT_BOTS_PORT || cfg.port || 3015));
const secret = String(process.env.DRIFT_BOTS_SECRET || cfg.secret || '');
const callbackUrl = String(
  process.env.DRIFT_BOTS_CALLBACK_URL
  || cfg.callbackUrl
  || `http://127.0.0.1:${Number(process.env.PORT || CONFIG.port || 3001)}/api/internal/drift-bots/events`
);

const authUser = String((CONFIG as any)?.auth?.user || '');
const authPass = String((CONFIG as any)?.auth?.pass || '');
const basicAuth = (authUser && authPass)
  ? `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
  : '';

const isLocalRequest = (req: express.Request): boolean => {
  try {
    const ipRaw = String(req.socket?.remoteAddress || req.ip || '');
    const ip = ipRaw.replace('::ffff:', '');
    return ip === '127.0.0.1' || ip === '::1';
  } catch {
    return false;
  }
};

app.use((req, res, next) => {
  try {
    if (secret) {
      const got = String(req.headers['x-drift-bots-secret'] || '');
      if (got !== secret) return res.status(401).json({ error: 'unauthorized' });
      return next();
    }
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
});

const emitToMain = (event: string, payload: any) => {
  try {
    if (!callbackUrl) {
      try { logger.warn('drift.bots.emit_no_callback', { event, cat: 'drift' }); } catch {}
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-drift-bots-secret'] = secret;
    if (basicAuth) headers['authorization'] = basicAuth;
    const body = JSON.stringify({ event, payload });
    // Log emit attempts at info level for visibility
    try { logger.info('drift.bots.emit_to_main', { event, callbackUrl, payloadKeys: payload ? Object.keys(payload) : [], cat: 'drift' }); } catch {}
    setImmediate(async () => {
      try {
        const res = await fetch(callbackUrl, { method: 'POST', headers, body });
        if (res.ok) {
          try { logger.info('drift.bots.emit_ok', { event, status: res.status, cat: 'drift' }); } catch {}
        } else {
          try { logger.warn('drift.bots.emit_failed', { event, status: res.status, statusText: res.statusText, cat: 'drift' }); } catch {}
        }
      } catch (e: any) {
        try { logger.warn('drift.bots.emit_error', { event, error: String(e?.message || e), cat: 'drift' }); } catch {}
      }
    });
  } catch (e: any) {
    try { logger.error('drift.bots.emit_exception', { event, error: String(e?.message || e), cat: 'drift' }); } catch {}
  }
};

const ioProxy: IoProxy = {
  emit: emitToMain as any,
};

setIo(ioProxy as any);

app.get('/health', (_req, res) => {
  res.json({ ok: true, pid: process.pid, port });
});

const api = express.Router();
api.use(createTriggerRouter(ioProxy as any));
api.use(createFillerRouter(ioProxy as any));
api.use(createLiquidatorRouter(ioProxy as any));
// Drift infrastructure routes (status, subaccounts, etc.) - handled in isolated process
api.use(createDriftRouter(ioProxy as any));

app.use('/api', api);

app.listen(port, () => {
  try {
    logger.info('drift.bots.started', { port, callbackUrl, cat: 'drift' });
  } catch {}
});
