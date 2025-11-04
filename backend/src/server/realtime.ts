import type { Server as SocketIOServer } from 'socket.io';
import { recordSessionLog } from '../utils/sessionLogs.js';
import { logger } from '../utils/logger.js';
import { WebSocket } from 'ws';
import { CONFIG } from '../utils/config.js';
import {
  setArbStreamEnabled as orchestratorSetArbStreamEnabled,
  isArbStreamEnabled as orchestratorIsArbStreamEnabled,
  getGraphPushStats as orchestratorGetGraphPushStats,
  getGraphPushStatsRaw as orchestratorGetGraphPushStatsRaw,
  hasDetectDrivenDirty,
  flushPendingFromDetector as orchestratorFlushPendingFromDetector,
  markDetectorCompleteFromAck,
} from './graphPushOrchestrator.js';

export { pushArbGraphSnapshot, pushArbGraphDiff, notifyArbServiceRefresh, markDetectorCompleteFromAck } from './graphPushOrchestrator.js';

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

// Convenience emitter for live per-user summaries
export function emitUserSummary(summary: any): void {
  try { emit('drift-liquidation', { type: 'user_summary', summary }); } catch {}
}

// Gate: only push graph updates to arb-rs after user presses Start Arb
export function setArbStreamEnabled(enabled: boolean): void {
  try { emit('log', { level: 'info', message: `arb:stream ${enabled ? 'enabled' : 'disabled'}`, context: { cat: 'arb', code: enabled ? 'ARB.STREAM.ENABLE' : 'ARB.STREAM.DISABLE' } }); } catch {}
  orchestratorSetArbStreamEnabled(enabled);
}
export function isArbStreamEnabled(): boolean { return orchestratorIsArbStreamEnabled(); }

export const getGraphPushStats = () => orchestratorGetGraphPushStats();

export const getGraphPushStatsRaw = () => orchestratorGetGraphPushStatsRaw();

export const flushPendingFromDetector = () => orchestratorFlushPendingFromDetector();

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
const getDetectDrivenPushCoalesceMs = (): number => {
  try { const v = Number(((globalThis as any)?.process?.env?.DETECT_DRIVEN_PUSH_COALESCE_MS) || 75); return Number.isFinite(v) ? Math.max(0, v) : 0; } catch { return 0; }
};

let lastDetectSeen = 0;
let detectDebounceTimer: NodeJS.Timeout | null = null;

const fetchArbMetrics = async (): Promise<{ last_detection_ms: number }> => {
  try {
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'test') {
      return { last_detection_ms: 0 };
    }
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), 3000);
    const r = await fetch(`${host}/metrics/json`, { headers: { accept: 'application/json' }, signal: ac.signal }).finally(() => clearTimeout(t));
    const j: any = await r.json().catch(() => ({}));
    return { last_detection_ms: Number(j?.last_detection_ms || 0) };
  } catch {
    return { last_detection_ms: 0 };
  }
};

export function startDetectDrivenGraphPush(debounceMs = 0): void {
  try {
    // Avoid duplicate timers
    let timer: NodeJS.Timeout | null = null;
    const period = Math.max(100, Number((CONFIG as any)?.system?.graphRebuildMinDebounceMs || 100));
    const tick = async () => {
      try {
        const m = await fetchArbMetrics();
        const currentDetectionMs = Number(m.last_detection_ms || 0);
        const previousSeen = lastDetectSeen || 0;
        
        // Diagnostic logging to verify polling is active
        try {
          logger.debug('graph.push detect_driven_poll', {
            current_detection_ms: currentDetectionMs,
            previous_seen: previousSeen,
            has_new_detection: currentDetectionMs > previousSeen,
            cat: 'graph',
          });
        } catch {}
        
        if (currentDetectionMs > previousSeen) {
          lastDetectSeen = currentDetectionMs;
          try { 
            logger.info('graph.rebuild.detect_driven', { 
              last_detection_ms: lastDetectSeen, 
              previous_seen: previousSeen,
              delta_ms: currentDetectionMs - previousSeen,
              code: 'GRAPH.REBUILD.DETECT_DRIVEN',
              cat: 'graph',
            }); 
          } catch {}
          
          // CRITICAL FIX: Mark detection complete first to unblock any waiting flush
          // This allows the existing flush (if any) to proceed
          try {
            markDetectorCompleteFromAck({ completedMs: currentDetectionMs });
            try {
              logger.debug('graph.push detect_marked_complete', {
                last_detection_ms: currentDetectionMs,
                cat: 'graph',
              });
            } catch {}
          } catch (err) {
            try { 
              logger.warn('graph.push detect_mark_complete_failed', { 
                error: String((err as any)?.message || err),
                last_detection_ms: currentDetectionMs,
                cat: 'graph',
              }); 
            } catch {}
          }
          
          // Then check if we need to flush new updates
          try {
            const hasDirty = hasDetectDrivenDirty();
            if (!hasDirty) { 
              try { logger.debug('graph.push detect_driven no_dirty', { cat: 'graph' }); } catch {}
              return; 
            }
            const wait = getDetectDrivenPushCoalesceMs();
            if (detectDebounceTimer) { clearTimeout(detectDebounceTimer); detectDebounceTimer = null; }
            detectDebounceTimer = setTimeout(async () => {
              detectDebounceTimer = null;
              const stillDirty = hasDetectDrivenDirty();
              if (!stillDirty) {
                try { logger.debug('graph.push detector_flush cancelled_no_dirty', { cat: 'graph' }); } catch {}
                return;
              }
              try {
                logger.info('graph.push detector_flush_pending', {
                  last_detection_ms: lastDetectSeen,
                  coalesce_ms: wait,
                  cat: 'graph',
                });
              } catch {}
              try {
                const flushed = await orchestratorFlushPendingFromDetector();
                try {
                  logger.info('graph.push detector_flush_complete', { 
                    flushed,
                    last_detection_ms: lastDetectSeen,
                    cat: 'graph',
                  });
                } catch {}
              } catch (err) {
                try { 
                  logger.warn('graph.push detector_flush_failed', { 
                    error: String((err as any)?.message || err),
                    last_detection_ms: lastDetectSeen,
                    cat: 'graph',
                  }); 
                } catch {}
              }
            }, wait);
          } catch (err) {
            try { 
              logger.warn('graph.push detect_driven_error', { 
                error: String((err as any)?.message || err),
                cat: 'graph',
              }); 
            } catch {}
          }
        } else {
          // Log when polling but no new detection (for debugging)
          try {
            const hasDirty = hasDetectDrivenDirty();
            if (hasDirty && currentDetectionMs === previousSeen && previousSeen > 0) {
              // Have dirty updates but detection hasn't progressed
              logger.debug('graph.push detect_driven_no_progress', {
                last_detection_ms: currentDetectionMs,
                previous_seen: previousSeen,
                has_dirty: hasDirty,
                cat: 'graph',
              });
            }
          } catch {}
        }
      } catch (err) {
        try { 
          logger.warn('graph.push detect_driven_poll_error', { 
            error: String((err as any)?.message || err),
            cat: 'graph',
          }); 
        } catch {}
      }
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

