import type { Server as SocketIOServer } from 'socket.io';
import { recordSessionLog } from '../utils/sessionLogs.js';
import { logger } from '../utils/logger.js';
import { WebSocket } from 'ws';
import { CONFIG } from '../utils/config.js';

let ioRef: SocketIOServer | null = null;

export function setIo(io: SocketIOServer) {
  ioRef = io;
}

export async function emit(event: string, payload: any) {
  try {
    if (event === 'log' && payload) {
      const level = String(payload?.level || 'info');
      const message = String(payload?.message || '');
      // Normalize to short local time for UI display consistency
      const timestamp = new Date().toLocaleTimeString();
      const context = (payload?.context && typeof payload.context === 'object') ? payload.context as Record<string, unknown> : undefined;
      let cat = ((payload?.cat as string) || (context as any)?.cat || 'other').toLowerCase();
      let code: string | undefined = (payload?.code as string) || (context as any)?.code as string | undefined;
      // Derive cid from message if present
      let cid: string | undefined = (payload?.cid as string) || (context as any)?.cid as string | undefined;
      try { if (!cid) { const m = /\bcid=([a-zA-Z0-9_-]+)/.exec(message); if (m) cid = m[1]; } } catch {}
      // Derive basic code when not provided to aid UI filtering
      if (!code) {
        const m = message.toLowerCase();
        if (/^pretrade:arb simulate start\b/.test(m)) code = 'PRETRADE.SIM.START';
        else if (/^pretrade:arb simulate result\b/.test(m)) code = 'PRETRADE.SIM.END';
        else if (/^pretrade:arb execute start\b/.test(m)) code = 'PRETRADE.EXEC.START';
        else if (/^pretrade:arb tx built\b/.test(m)) code = 'PRETRADE.TX.BUILT';
        else if (/^pretrade:arb (send|simulate) logs\b/.test(m)) code = 'PRETRADE.LOGS';
        else if (/^pools:subscribe ok\b/.test(m)) code = 'POOLS.SUBSCRIBE.OK';
        else if (/^pools:unsubscribe ok\b/.test(m)) code = 'POOLS.UNSUBSCRIBE.OK';
        else if (/^graph:push diff\b/.test(m)) code = 'GRAPH.PUSH.DIFF';
        else if (/^graph:push snapshot\b/.test(m)) code = 'GRAPH.PUSH.SNAPSHOT';
        else if (/^arb:push snapshot\b/.test(m)) code = 'ARB.PUSH.SNAPSHOT';
        else if (/^api\.request\b/.test(m)) code = 'API.REQUEST';
        else if (/^api\.response\b/.test(m)) code = 'API.RESPONSE';
      }
      // Do not drop logs in emitter; let frontend handle visibility based on System Config
      recordSessionLog({ level, message, timestamp, context, cat });
      // Overwrite outgoing payload timestamp and normalized category
      try {
        payload = { ...payload, timestamp, cat, code, cid, context };
      } catch {}
    }
  } catch {}
  // Gate high-volume UI logs by category and level per CONFIG.system
  try {
    if (event === 'log') {
      const cfg: any = (CONFIG as any)?.system || {};
      const allowCats: string[] = Array.isArray(cfg.logAllowCats) ? (cfg.logAllowCats as string[]).map((s) => String(s).toLowerCase()) : [];
      const minLevel: string = String(cfg.logMinLevel || 'info').toLowerCase();
      const order: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
      const cat: string = String(((payload as any)?.cat || (payload as any)?.context?.cat || '')).toLowerCase();
      const lvl: string = String((payload as any)?.level || 'info').toLowerCase();
      const catAllowed: boolean = allowCats.length === 0 || (!!cat && allowCats.includes(cat));
      const meetsLevel: boolean = (order[minLevel] ?? 2) >= (order[lvl] ?? 2);
      if (!(catAllowed && meetsLevel)) return; // drop to UI when not allowed
    }
  } catch {}
  ioRef?.emit(event, payload);
}

// Gate: only push graph updates to arb-rs after user presses Start Arb
let arbStreamEnabled = false;
export function setArbStreamEnabled(enabled: boolean): void {
  try { emit('log', { level: 'info', message: `arb:stream ${enabled ? 'enabled' : 'disabled'}`, context: { cat: 'arb', code: enabled ? 'ARB.STREAM.ENABLE' : 'ARB.STREAM.DISABLE' } }); } catch {}
  arbStreamEnabled = !!enabled;
}
export function isArbStreamEnabled(): boolean { return arbStreamEnabled; }

export async function notifyArbServiceRefresh(): Promise<void> {
  try {
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    // Use a lightweight ping to a valid arb-rs endpoint to nudge the loop without assuming custom routes
    // eslint-disable-next-line no-undef
    await fetch(`${host}/arb/graph/version`, { method: 'GET', headers: { 'accept': 'application/json' } });
  } catch {}
}

// Simple sequential push queue to arb-rs with detection-run acknowledgement
type ArbJob = { kind: 'snapshot' | 'diff'; payload: any; resolve: () => void; reject: (e: any) => void };
let arbQueue: ArbJob[] = [];
let arbInFlight = false;
let lastRebaseAt = 0;
let pushSuccess = 0;
let pushFailed = 0;

// Lightweight graph push ack statistics (bounded in-memory)
const graphPushStats = {
  ackMs: [] as number[],
  success: 0,
  failed: 0,
};
function pushBounded(arr: number[], v: number, cap = 200): void {
  if (!Number.isFinite(v)) return;
  arr.push(v);
  if (arr.length > cap) arr.shift();
}
function pct(arr: number[], p: number): number | null {
  if (!arr || arr.length === 0) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(((p / 100) * (a.length - 1)))));
  return a[i] ?? null;
}
export function getGraphPushStats(): { count: number; p50: number | null; p95: number | null; success: number; failed: number } {
  return { count: graphPushStats.ackMs.length, p50: pct(graphPushStats.ackMs, 50), p95: pct(graphPushStats.ackMs, 95), success: graphPushStats.success, failed: graphPushStats.failed };
}
export function getGraphPushStatsRaw(): { ackMs: number[]; success: number; failed: number } {
  return { ackMs: graphPushStats.ackMs.slice(), success: graphPushStats.success, failed: graphPushStats.failed };
}

async function fetchArbMetrics(): Promise<{ last_detection_ms: number }> {
  try {
    // Skip network during unit tests to avoid timeouts
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'test') {
      return { last_detection_ms: 0 };
    }
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), 3000);
    const r = await fetch(`${host}/metrics/json`, { headers: { accept: 'application/json' }, signal: ac.signal }).finally(() => clearTimeout(t));
    const j: any = await r.json().catch(() => ({}));
    return { last_detection_ms: Number(j?.last_detection_ms || 0) };
  } catch {
    return { last_detection_ms: 0 };
  }
}

async function processArbQueue(): Promise<void> {
  if (arbInFlight) return;
  arbInFlight = true;
  try {
    while (arbQueue.length) {
      const job = arbQueue.shift()!;
      const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
      // In test, simulate immediate success without network
      if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'test') {
        try { logger.info('arb.push ack', { kind: job.kind, acked: true, waited_ms: 0, wantVersion: Number((job as any)?.payload?.version || 0), queue_depth: arbQueue.length }); } catch {}
        job.resolve();
        continue;
      }
      const before = await fetchArbMetrics();
      // Retry with exponential backoff
      const auth = String(((globalThis as any)?.process?.env?.ARB_SHARED_SECRET) || '');
      const headers: any = { 'content-type': 'application/json' };
      if (auth) headers['authorization'] = `Bearer ${auth}`;
      const url = job.kind === 'snapshot' ? `${host}/arb/graph/snapshot` : `${host}/arb/graph/update`;
      const body = job.kind === 'snapshot' ? JSON.stringify({ graph: job.payload }) : JSON.stringify(job.payload);
      let attempt = 0;
      const maxAttempts = 5;
      let sent = false;
      while (attempt < maxAttempts && !sent) {
        try {
          // eslint-disable-next-line no-undef
          const r = await fetch(url, { method: 'POST', headers, body });
          if (!r || !r.ok) throw new Error(`status ${r && (r as any).status}`);
          sent = true;
          break;
        } catch (e: any) {
          attempt += 1;
          const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
          try { logger.warn('arb.push retry', { kind: job.kind, attempt, wait_ms: wait, error: String(e?.message || e) }); } catch {}
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      if (!sent) {
        try { logger.error('arb.push giveup', { kind: job.kind, attempts: attempt }); } catch {}
      }
      // Ack by polling /arb/graph/version until target version observed or timeout
      const wantVersion: number = Number((job.kind === 'snapshot' ? job.payload?.version : job.payload?.version) || 0);
      const start = Date.now();
      const timeoutMs = Number((((globalThis as any)?.process?.env?.ARB_ACK_TIMEOUT_MS) || 2500));
      let acked = false;
      while (Date.now() - start < timeoutMs) {
        try {
          // eslint-disable-next-line no-undef
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort('timeout'), 2000);
          const r = await fetch(`${host}/arb/graph/version`, { headers: { accept: 'application/json' }, signal: ac.signal }).finally(() => clearTimeout(t));
          if (r?.ok) {
            const j: any = await r.json().catch(() => ({}));
            const cur = Number(j?.version || 0);
            if (wantVersion > 0 && cur >= wantVersion) { acked = true; break; }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      try {
        if (acked) pushSuccess += 1; else pushFailed += 1;
        logger.info('arb.push ack', { kind: job.kind, acked, waited_ms: Date.now() - start, wantVersion, queue_depth: arbQueue.length, push_success: pushSuccess, push_failed: pushFailed });
        // Record stats
        const waited = Date.now() - start;
        if (acked) graphPushStats.success += 1; else graphPushStats.failed += 1;
        pushBounded(graphPushStats.ackMs, waited);
      } catch {}

      // Optionally wait for a fresh detection to complete after applying this graph update (bounded wait)
      try {
        const waitForDetect = String((((globalThis as any)?.process?.env?.ARB_WAIT_FOR_DETECT) || 'false')).toLowerCase() === 'true';
        if (waitForDetect && String((((globalThis as any)?.process?.env?.NODE_ENV) || '')).toLowerCase() !== 'test') {
          const detectDeadline = Date.now() + 8000;
          while (Date.now() < detectDeadline) {
            const cur = await fetchArbMetrics();
            if (cur.last_detection_ms > before.last_detection_ms) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      } catch {}
      job.resolve();
      // If a snapshot was pushed, it supersedes any pending diffs built from older state; drop consecutive diffs until next rebuild
      if (job.kind === 'snapshot' && arbQueue.length) {
        arbQueue = arbQueue.filter((j) => j.kind === 'snapshot');
      }
    }
  } finally {
    arbInFlight = false;
  }
}

export async function pushArbGraphSnapshot(snapshot: any): Promise<void> {
  return new Promise((resolve, reject) => {
    // Suppress until explicitly enabled and skip empties
    try {
      if (!arbStreamEnabled) { logger.debug('arb.push gated', { kind: 'snapshot' }); resolve(); return; }
      if (!snapshot || !Array.isArray((snapshot as any).edges) || (snapshot as any).edges.length === 0) { logger.debug('arb.push skip empty snapshot'); resolve(); return; }
    } catch {}
    arbQueue.push({ kind: 'snapshot', payload: snapshot, resolve, reject });
    processArbQueue().catch(() => {});
  });
}

export async function pushArbGraphDiff(diff: any): Promise<void> {
  return new Promise((resolve, reject) => {
    // Suppress until explicitly enabled
    try { if (!arbStreamEnabled) { logger.debug('arb.push gated', { kind: 'diff' }); resolve(); return; } } catch {}
    // Coalesce pending diffs to avoid backlog under high churn; keep snapshots
    try {
      arbQueue = arbQueue.filter((j) => j.kind === 'snapshot');
    } catch {}
    arbQueue.push({ kind: 'diff', payload: diff, resolve, reject });
    try { logger.debug('arb.queue enq', { kind: 'diff', size: arbQueue.length }); } catch {}
    processArbQueue().catch(() => {});
  });
}

// Optional: basic retry with backoff for failed pushes is handled implicitly by queue re-enqueue if needed in future

// Lightweight readiness probe for arb-rs backend mode
export async function checkArbServiceReady(timeoutMs = 4000): Promise<boolean> {
  try {
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'test') return true;
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), Math.max(1000, timeoutMs));
    try {
      const r = await fetch(`${host}/arb/graph/version`, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal });
      clearTimeout(t);
      if (r && r.ok) return true;
      // Fallback to /health if version endpoint not available
      const r2 = await fetch(`${host}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal });
      return !!r2 && r2.ok;
    } catch {
      clearTimeout(t);
      return false;
    }
  } catch {
    return false;
  }
}

let arbVersionCache: { version: number; timestamp: number; ts: number } = { version: 0, timestamp: 0, ts: 0 };
export function getCachedArbVersion(): { version: number; timestamp: number; ageMs: number } {
  const age = Math.max(0, Date.now() - (arbVersionCache.ts || 0));
  return { version: arbVersionCache.version || 0, timestamp: arbVersionCache.timestamp || 0, ageMs: age };
}

// Detect-driven trigger: rebuild graph right after each detection finishes
let lastDetectSeen = 0;
export function startDetectDrivenGraphPush(debounceMs = 0): void {
  try {
    // Avoid duplicate timers
    let timer: NodeJS.Timeout | null = null;
    const period = Math.max(100, Number((CONFIG as any)?.system?.graphRebuildMinDebounceMs || 100));
    const tick = async () => {
      try {
        const m = await fetchArbMetrics();
        if (Number(m.last_detection_ms || 0) > Number(lastDetectSeen || 0)) {
          lastDetectSeen = Number(m.last_detection_ms || 0);
          try { logger.info('graph.rebuild.detect_driven', { last_detection_ms: lastDetectSeen, code: 'GRAPH.REBUILD.DETECT_DRIVEN' }); } catch {}
          try {
            const gmod: any = await import('./graph.js');
            gmod.scheduleGraphRebuild(undefined, Math.max(0, debounceMs));
          } catch {}
        }
      } catch {}
    };
    timer = setInterval(tick, period);
  } catch {}
}
(async function pollArbVersionLoop(){
  try {
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    setInterval(async () => {
      try {
        // eslint-disable-next-line no-undef
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort('timeout'), 2000);
        const r = await fetch(`${host}/arb/graph/version`, { headers: { 'accept': 'application/json' }, signal: ac.signal }).finally(() => clearTimeout(t));
        if (r?.ok) {
          const j: any = await r.json().catch(() => ({}));
          arbVersionCache = { version: Number(j?.version || 0), timestamp: Number(j?.timestamp || 0), ts: Date.now() };
        }
      } catch {}
    }, 1000);
  } catch {}
})();


let arbOppsWs: WebSocket | null = null;
let arbOppsReconnectTimer: NodeJS.Timeout | null = null;

function makeArbWsUrl(): string {
  try {
    const http = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    if (http.startsWith('https://')) return http.replace('https://', 'wss://') + '/ws/opportunities';
    if (http.startsWith('http://')) return http.replace('http://', 'ws://') + '/ws/opportunities';
    return `ws://${http.replace(/^wss?:\/\//, '')}/ws/opportunities`;
  } catch {
    return 'ws://127.0.0.1:4010/ws/opportunities';
  }
}

function scheduleArbOppsReconnect(ms = 1500) {
  try { if (arbOppsReconnectTimer) clearTimeout(arbOppsReconnectTimer); } catch {}
  arbOppsReconnectTimer = setTimeout(() => {
    try { startArbOpportunitiesBridge(); } catch {}
  }, ms);
}

export function startArbOpportunitiesBridge(): void {
  try {
    if (arbOppsWs && (arbOppsWs.readyState === WebSocket.OPEN || arbOppsWs.readyState === WebSocket.CONNECTING)) return;
  } catch {}
  const url = makeArbWsUrl();
  try {
    const ws = new WebSocket(url, { handshakeTimeout: 3000 });
    arbOppsWs = ws;

    ws.on('open', () => {
      try { emit('log', { level: 'info', message: `arb:ws connected ${url}`, context: { cat: 'arb' } }); } catch {}
    });

    ws.on('message', (data) => {
      try {
        let text: string = '';
        if (typeof data === 'string') {
          text = data;
        } else if (Array.isArray(data)) {
          try { text = Buffer.concat(data as unknown as Buffer[]).toString(); } catch { text = String(data); }
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
          text = (data as Buffer).toString();
        } else if (data && typeof (data as any).byteLength === 'number') {
          try { text = Buffer.from(data as ArrayBuffer).toString(); } catch { text = String(data); }
        } else {
          text = String(data);
        }
        const payload = JSON.parse(text);
        emit('arb:opportunities', payload);
      } catch (e: any) {
        try { emit('log', { level: 'warn', message: `arb:ws parse error ${String(e?.message || e)}`, context: { cat: 'arb' } }); } catch {}
      }
    });

    ws.on('close', () => {
      try { emit('log', { level: 'warn', message: 'arb:ws closed; reconnecting…', context: { cat: 'arb' } }); } catch {}
      scheduleArbOppsReconnect(1500);
    });

    ws.on('error', (e) => {
      try { emit('log', { level: 'warn', message: `arb:ws error ${String((e as any)?.message || e)}`, context: { cat: 'arb' } }); } catch {}
      try { ws.close(); } catch {}
    });
  } catch (e: any) {
    try { emit('log', { level: 'warn', message: `arb:ws connect failed ${String(e?.message || e)}`, context: { cat: 'arb' } }); } catch {}
    scheduleArbOppsReconnect(2000);
  }
}

