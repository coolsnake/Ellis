import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { setIo } from '../server/realtime.js';
import { createDriftRouter } from '../server/routes/drift.js';

type IoProxy = Pick<SocketIOServer, 'emit'>;

const app = express();
app.use(express.json());

const cfg: any = (CONFIG as any)?.driftInfra || {};
const port = Math.max(1, Number(process.env.DRIFT_INFRA_PORT || cfg.port || 3020));
const secret = String(process.env.DRIFT_INFRA_SECRET || cfg.secret || '');
const callbackUrl = String(
  process.env.DRIFT_INFRA_CALLBACK_URL
  || cfg.callbackUrl
  || process.env.DRIFT_BOTS_CALLBACK_URL
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
      const got = String(req.headers['x-drift-infra-secret'] || req.headers['x-drift-bots-secret'] || '');
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
      try { logger.warn('drift.infra.emit_no_callback', { event, cat: 'drift' }); } catch {}
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-drift-bots-secret'] = secret;
    if (basicAuth) headers['authorization'] = basicAuth;
    const body = JSON.stringify({ event, payload });
    try { logger.info('drift.infra.emit_to_main', { event, callbackUrl, payloadKeys: payload ? Object.keys(payload) : [], cat: 'drift' }); } catch {}
    setImmediate(async () => {
      try {
        const res = await fetch(callbackUrl, { method: 'POST', headers, body });
        if (res.ok) {
          try { logger.info('drift.infra.emit_ok', { event, status: res.status, cat: 'drift' }); } catch {}
        } else {
          try { logger.warn('drift.infra.emit_failed', { event, status: res.status, statusText: res.statusText, cat: 'drift' }); } catch {}
        }
      } catch (e: any) {
        try { logger.warn('drift.infra.emit_error', { event, error: String(e?.message || e), cat: 'drift' }); } catch {}
      }
    });
  } catch (e: any) {
    try { logger.error('drift.infra.emit_exception', { event, error: String(e?.message || e), cat: 'drift' }); } catch {}
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
api.use(createDriftRouter(ioProxy as any));
app.use('/api', api);

app.listen(port, () => {
  try { logger.info('drift.infra.started', { port, callbackUrl, cat: 'drift' }); } catch {}
});

// Activate shared infra + price service on boot
setImmediate(async () => {
  try {
    const { DriftService } = await import('./client.js');
    const svc = DriftService.getInstance() as any;
    await svc.activate?.({ includeIdle: true, updateFrequency: Math.max(200, Number(cfg?.updateFrequency ?? 1000)), preferOrderSubscriber: true });
    try {
      const infra = await svc.getSharedInfra?.({ includeIdle: true, updateFrequency: Math.max(200, Number(cfg?.updateFrequency ?? 1000)), preferOrderSubscriber: true });
      const { driftEventIndex } = await import('./eventIndex.js');
      try { driftEventIndex.bindEventSubscriber(infra?.eventSubscriber); } catch {}
      try {
        const limit = Math.max(100, Number(((CONFIG as any)?.drift?.eventIndexBootstrapUsers ?? 2000)));
        driftEventIndex.bootstrapFromUserMap(infra?.userMap, { limit, includeOrders: true, reason: 'infra_bootstrap' });
      } catch {}
    } catch {}
    try {
      const { DriftPriceService } = await import('./price.js');
      DriftPriceService.getInstance();
    } catch {}
  } catch {}
});

