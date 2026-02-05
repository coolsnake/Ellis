import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

type BotKind = 'trigger' | 'filler' | 'liquidator';

type WorkerInfo = {
  key: string;
  kind: BotKind;
  name: string;
  config: any;
  proc: ChildProcessWithoutNullStreams;
  startedAtMs: number;
  status?: any;
  lastSeenMs?: number;
};

type PendingReq = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timeout: any;
};

const workers = new Map<string, WorkerInfo>();
const pending = new Map<string, PendingReq>();

function splitLines(buf: any): string[] {
  let s: string;
  try {
    if (typeof buf === 'string') s = buf;
    else if (buf && typeof (buf as any).toString === 'function') s = (buf as any).toString('utf8');
    else s = String(buf);
  } catch {
    s = String(buf);
  }
  return s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function parseChildLog(line: string): { raw: string; isFormatted: boolean; level: string } {
  const match = /^\[(INFO|WARN|ERROR|DEBUG)\]\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)\s+\[[\w.]+\]\s*(.*)$/i.exec(line);
  if (match) {
    return { raw: match[2] || line, isFormatted: true, level: match[1].toLowerCase() };
  }
  return { raw: line, isFormatted: false, level: 'info' };
}

function keyOf(kind: BotKind, name: string): string {
  const n = String(name || 'default');
  if (kind === 'trigger') return `trg#${n}`;
  if (kind === 'filler') return `fil#${n}`;
  return `liq#${n}`;
}

function resolveWorkerEntry(): { entry: string; useTsx: boolean; bin: string } | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const BACKEND_ROOT = resolve(__dirname, '..', '..');
  const devEntry = resolve(BACKEND_ROOT, 'src/drift/botWorker.ts');
  const prodEntry = resolve(BACKEND_ROOT, 'dist/drift/botWorker.js');
  const devExists = existsSync(devEntry);
  const prodExists = existsSync(prodEntry);
  const preferDev = !!((CONFIG as any)?.driftBots?.useTsx);
  const tsxBinCandidates = [
    resolve(BACKEND_ROOT, 'node_modules/.bin/tsx'),
    resolve(BACKEND_ROOT, 'node_modules/.bin/tsx.cmd'),
  ];
  const tsxBin = tsxBinCandidates.find((p) => existsSync(p)) || '';
  const canUseTsx = preferDev && devExists && !!tsxBin;
  const absEntry = canUseTsx ? devEntry : (prodExists ? prodEntry : '');
  if (!absEntry) return null;
  const useTsx = absEntry === devEntry && canUseTsx;
  const bin = useTsx ? tsxBin : 'node';
  return { entry: absEntry, useTsx, bin };
}

function buildInfraUrl(): string {
  const cfg: any = (CONFIG as any)?.driftInfra || {};
  if (cfg.baseUrl) return String(cfg.baseUrl);
  const port = Math.max(1, Number(process.env.DRIFT_INFRA_PORT || cfg.port || 3020));
  return `http://127.0.0.1:${port}`;
}

function sendRequest(worker: WorkerInfo, type: string, payload?: any, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    try {
      worker.proc.send({ id, type, payload });
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(e);
    }
  });
}

function attachWorkerHandlers(info: WorkerInfo): void {
  info.proc.on('message', (msg: any) => {
    try {
      if (msg && typeof msg === 'object') {
        if (msg.id && pending.has(String(msg.id))) {
          const p = pending.get(String(msg.id))!;
          clearTimeout(p.timeout);
          pending.delete(String(msg.id));
          if (msg.ok === false) p.reject(new Error(String(msg.error || 'error')));
          else p.resolve(msg.data);
          return;
        }
        if (msg.type === 'status' && msg.key === info.key) {
          info.status = msg.status;
          info.lastSeenMs = Date.now();
        }
      }
    } catch {}
  });
  info.proc.stdout.on('data', (buf) => {
    for (const line of splitLines(buf)) {
      try {
        const parsed = parseChildLog(line);
        const ctx = { cat: 'drift.worker', kind: info.kind, key: info.key, fromChild: true };
        if (parsed.isFormatted) {
          if (parsed.level === 'warn') logger.warn(parsed.raw, ctx);
          else if (parsed.level === 'error') logger.error(parsed.raw, ctx);
          else logger.info(parsed.raw, ctx);
        } else {
          logger.info(line, ctx);
        }
      } catch {}
    }
  });
  info.proc.stderr.on('data', (buf) => {
    for (const line of splitLines(buf)) {
      try {
        const parsed = parseChildLog(line);
        logger.warn(parsed.raw, { cat: 'drift.worker', kind: info.kind, key: info.key, fromChild: parsed.isFormatted });
      } catch {}
    }
  });
  info.proc.on('exit', (code, signal) => {
    try { logger.warn('drift.worker.exit', { key: info.key, kind: info.kind, code, signal }); } catch {}
    workers.delete(info.key);
  });
  info.proc.on('error', (err) => {
    try { logger.error('drift.worker.error', { key: info.key, kind: info.kind, error: String(err?.message || err) }); } catch {}
    workers.delete(info.key);
  });
}

export function listBots(kind: BotKind): Array<{ key: string; status: any }> {
  const out: Array<{ key: string; status: any }> = [];
  for (const [key, w] of workers.entries()) {
    if (w.kind !== kind) continue;
    out.push({ key, status: w.status || { running: true, name: w.name } });
  }
  return out;
}

export async function listBotsFresh(kind: BotKind): Promise<Array<{ key: string; status: any }>> {
  const out: Array<{ key: string; status: any }> = [];
  for (const w of workers.values()) {
    if (w.kind !== kind) continue;
    try {
      const status = await sendRequest(w, 'status', null, 2000).catch(() => w.status);
      if (status) w.status = status;
    } catch {}
    out.push({ key: w.key, status: w.status || { running: true, name: w.name } });
  }
  return out;
}

export async function startBot(kind: BotKind, cfg: any): Promise<{ key: string; pid?: number; already?: boolean }> {
  const name = String(cfg?.name || 'default').trim() || 'default';
  const key = keyOf(kind, name);
  const existing = workers.get(key);
  if (existing) return { key, pid: existing.proc.pid, already: true };

  const resolved = resolveWorkerEntry();
  if (!resolved) throw new Error('worker_entry_missing');
  const { entry, useTsx, bin } = resolved;

  const env: Record<string, string> = {
    ...process.env,
    DRIFT_BOT_WORKER: '1',
    DRIFT_WORKER_KIND: kind,
    DRIFT_WORKER_NAME: name,
    DRIFT_WORKER_CONFIG: JSON.stringify(cfg || {}),
    DRIFT_INFRA_URL: process.env.DRIFT_INFRA_URL || buildInfraUrl(),
    // Ensure workers never initialize shared infra locally
    DRIFT_WARMUP_ENABLED: 'false',
    DRIFT_PREFETCH_ENABLED: 'false',
  };
  const infraCfg: any = (CONFIG as any)?.driftInfra || {};
  if (process.env.DRIFT_INFRA_SECRET || infraCfg.secret) {
    env.DRIFT_INFRA_SECRET = String(process.env.DRIFT_INFRA_SECRET || infraCfg.secret || '');
  }
  const botsCfg: any = (CONFIG as any)?.driftBots || {};
  if (process.env.DRIFT_BOTS_SECRET || botsCfg.secret) {
    env.DRIFT_BOTS_SECRET = String(process.env.DRIFT_BOTS_SECRET || botsCfg.secret || '');
  }
  if (process.env.DRIFT_BOTS_CALLBACK_URL || botsCfg.callbackUrl) {
    env.DRIFT_BOTS_CALLBACK_URL = String(process.env.DRIFT_BOTS_CALLBACK_URL || botsCfg.callbackUrl || '');
  }
  if (useTsx) env.DRIFT_BOTS_USE_TSX = 'true';

  const child = spawn(bin, [entry], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const info: WorkerInfo = {
    key,
    kind,
    name,
    config: cfg,
    proc: child,
    startedAtMs: Date.now(),
  };
  workers.set(key, info);
  attachWorkerHandlers(info);
  try { logger.info('drift.worker.spawn', { key, kind, pid: child.pid, entry }); } catch {}
  return { key, pid: child.pid };
}

export async function stopBot(key: string): Promise<boolean> {
  const w = workers.get(key);
  if (!w) return false;
  try { await sendRequest(w, 'stop', null, 2000).catch(() => {}); } catch {}
  try { w.proc.kill('SIGTERM'); } catch {}
  workers.delete(key);
  return true;
}

export async function removeBot(key: string): Promise<boolean> {
  return stopBot(key);
}

export async function getMetrics(kind: BotKind, key: string, windowMs?: number): Promise<any> {
  const w = workers.get(key);
  if (!w) return null;
  return await sendRequest(w, 'metrics', { windowMs, kind, key }, 4000).catch(() => null);
}

export async function getQueue(key: string, limit?: number): Promise<any> {
  const w = workers.get(key);
  if (!w) return null;
  return await sendRequest(w, 'queue', { limit }, 4000).catch(() => null);
}

export async function testLiquidator(key: string, userPk: string): Promise<any> {
  const w = workers.get(key);
  if (!w) return null;
  return await sendRequest(w, 'test', { userPk }, 8000).catch(() => null);
}

