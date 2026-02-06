import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';
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
  } catch (e: any) {
    safeLog.debug('drift.infra.ip_check', { error: String(e?.message || e), cat: 'drift' });
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
  } catch (e: any) {
    safeLog.warn('drift.infra.auth_middleware', { error: String(e?.message || e), cat: 'drift' });
    return res.status(401).json({ error: 'unauthorized' });
  }
});

const emitToMain = (event: string, payload: any) => {
  try {
    if (!callbackUrl) {
      safeLog.warn('drift.infra.emit_no_callback', { event, cat: 'drift' });
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-drift-bots-secret'] = secret;
    if (basicAuth) headers['authorization'] = basicAuth;
    const body = JSON.stringify({ event, payload });
    safeLog.info('drift.infra.emit_to_main', { event, callbackUrl, payloadKeys: payload ? Object.keys(payload) : [], cat: 'drift' });
    setImmediate(async () => {
      try {
        const res = await fetch(callbackUrl, { method: 'POST', headers, body });
        if (res.ok) {
          safeLog.info('drift.infra.emit_ok', { event, status: res.status, cat: 'drift' });
        } else {
          safeLog.warn('drift.infra.emit_failed', { event, status: res.status, statusText: res.statusText, cat: 'drift' });
        }
      } catch (e: any) {
        safeLog.warn('drift.infra.emit_error', { event, error: String(e?.message || e), cat: 'drift' });
      }
    });
  } catch (e: any) {
    safeLog.error('drift.infra.emit_exception', { event, error: String(e?.message || e), cat: 'drift' });
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
  safeLog.info('drift.infra.started', { port, callbackUrl, cat: 'drift' });
});

// Optionally auto-activate infra on boot
if (cfg?.autostart) {
  setImmediate(async () => {
    try {
      const { DriftService } = await import('./client.js');
      const svc = DriftService.getInstance() as any;
      await svc.activate?.({
        includeIdle: false,
        updateFrequency: Math.max(200, Number(cfg?.updateFrequency ?? 1000)),
        preferOrderSubscriber: true
      });
    } catch (e: any) { safeLog.warn('drift.infra.autostart', { error: String(e?.message || e), cat: 'drift' }); }
  });
}

