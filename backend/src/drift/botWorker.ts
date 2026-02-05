import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { setIo } from '../server/realtime.js';

type BotKind = 'trigger' | 'filler' | 'liquidator';
type IoProxy = Pick<SocketIOServer, 'emit'>;

const kind = String(process.env.DRIFT_WORKER_KIND || '').trim() as BotKind;
const rawCfg = String(process.env.DRIFT_WORKER_CONFIG || '{}');
let cfg: any = {};
try { cfg = JSON.parse(rawCfg || '{}'); } catch {}
const name = String(process.env.DRIFT_WORKER_NAME || cfg?.name || 'default').trim() || 'default';

const secret = String(process.env.DRIFT_BOTS_SECRET || (CONFIG as any)?.driftBots?.secret || '');
const callbackUrl = String(
  process.env.DRIFT_BOTS_CALLBACK_URL
  || (CONFIG as any)?.driftBots?.callbackUrl
  || `http://127.0.0.1:${Number(process.env.PORT || CONFIG.port || 3001)}/api/internal/drift-bots/events`
);

const authUser = String((CONFIG as any)?.auth?.user || '');
const authPass = String((CONFIG as any)?.auth?.pass || '');
const basicAuth = (authUser && authPass)
  ? `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
  : '';

const emitToMain = (event: string, payload: any) => {
  try {
    if (!callbackUrl) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-drift-bots-secret'] = secret;
    if (basicAuth) headers['authorization'] = basicAuth;
    const body = JSON.stringify({ event, payload });
    setImmediate(async () => {
      try { await fetch(callbackUrl, { method: 'POST', headers, body }); } catch {}
    });
  } catch {}
};

const ioProxy: IoProxy = { emit: emitToMain as any };
setIo(ioProxy as any);

let runner: any = null;
let key = '';

async function start(): Promise<void> {
  if (!kind) throw new Error('missing_kind');
  if (kind === 'trigger') {
    const mod: any = await import('./triggerRunner.js');
    cfg = { ...(cfg || {}), name, enabled: true };
    key = mod.DriftTriggerRegistry.keyOf(cfg);
    runner = mod.DriftTriggerRegistry.upsert(cfg);
    await mod.DriftTriggerRegistry.start(key);
  } else if (kind === 'filler') {
    const mod: any = await import('./fillerRunner.js');
    cfg = { ...(cfg || {}), name, enabled: true };
    key = mod.DriftFillerRegistry.keyOf(cfg);
    runner = mod.DriftFillerRegistry.upsert(cfg);
    await mod.DriftFillerRegistry.start(key);
  } else if (kind === 'liquidator') {
    const mod: any = await import('./liquidator.js');
    cfg = { ...(cfg || {}), name, enabled: true };
    key = mod.DriftLiquidatorRegistry.keyOf(cfg);
    runner = mod.DriftLiquidatorRegistry.upsert(cfg);
    await mod.DriftLiquidatorRegistry.start(key);
  } else {
    throw new Error(`unsupported_kind_${kind}`);
  }
  try { logger.info('drift.worker.started', { kind, key, cat: 'drift' }); } catch {}
}

function getStatus(): any {
  try { return runner?.getStatus?.(); } catch {}
  return { running: true, name };
}

function sendStatus(): void {
  try { (process as any).send?.({ type: 'status', key, kind, status: getStatus() }); } catch {}
}

const statusTimer = setInterval(() => { sendStatus(); }, 5000);

process.on('message', async (msg: any) => {
  try {
    const id = msg?.id ? String(msg.id) : '';
    const respond = (ok: boolean, data?: any, error?: any) => {
      try { (process as any).send?.({ id, ok, data, error: error ? String(error) : undefined }); } catch {}
    };
    if (msg?.type === 'status') {
      respond(true, getStatus());
      return;
    }
    if (msg?.type === 'stop') {
      try { runner?.stop?.(); } catch {}
      respond(true, { ok: true });
      try { clearInterval(statusTimer); } catch {}
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (msg?.type === 'metrics') {
      try {
        const { getMetrics } = await import('./txTracker.js');
        const windowMs = Number.isFinite(Number(msg?.payload?.windowMs)) ? Number(msg.payload.windowMs) : 60_000;
        const action = kind === 'trigger' ? 'trigger' : (kind === 'filler' ? 'fill' : 'liquidate');
        const data = getMetrics({ windowMs, action, bot: key });
        respond(true, { windowMs, bot: key, ...data });
        return;
      } catch (e: any) {
        respond(false, null, e?.message || e);
        return;
      }
    }
    if (msg?.type === 'queue') {
      if (kind !== 'liquidator') return respond(true, { queue: null });
      try {
        const limit = Number.isFinite(Number(msg?.payload?.limit)) ? Number(msg.payload.limit) : 25;
        const snapshot = runner?.getQueueSnapshot?.(limit);
        respond(true, { queue: snapshot });
        return;
      } catch (e: any) {
        respond(false, null, e?.message || e);
        return;
      }
    }
    if (msg?.type === 'test') {
      if (kind !== 'liquidator') return respond(false, null, 'unsupported');
      try {
        const userPk = String(msg?.payload?.userPk || '');
        const ok = await runner?.testTarget?.(userPk);
        respond(true, { ok: !!ok });
        return;
      } catch (e: any) {
        respond(false, null, e?.message || e);
        return;
      }
    }
    if (id) respond(false, null, 'unknown_request');
  } catch {}
});

process.on('SIGTERM', () => {
  try { runner?.stop?.(); } catch {}
  try { clearInterval(statusTimer); } catch {}
  setTimeout(() => process.exit(0), 50);
});

start()
  .then(() => { sendStatus(); })
  .catch((e) => {
    try { logger.error('drift.worker.start_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    sendStatus();
  });

