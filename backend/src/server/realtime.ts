import type { Server as SocketIOServer } from 'socket.io';
import { recordSessionLog } from '../utils/sessionLogs.js';
import { logger } from '../utils/logger.js';

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
      // If backend category filtering is configured, drop disabled categories here as well
      try {
        const { CONFIG } = await import('../utils/config.js');
        // Legacy category allowlist
        const enabled = (CONFIG as any)?.system?.enabledLogCategories as string[] | undefined;
        if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(cat)) return;
        // Structured logging rules
        const logCfg = (CONFIG as any)?.system?.log as any | undefined;
        if (logCfg) {
          const lvlOrder: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
          const minLevel = String((logCfg.level || 'info')).toLowerCase();
          if ((lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder[minLevel] ?? 2)) return;
          const catLevels = (logCfg.categories || {}) as Record<string, string>;
          const keys = Object.keys(catLevels);
          let effMin: string | undefined;
          if (keys.length) {
            let best = -1;
            for (const k of keys) {
              const kl = String(k).toLowerCase();
              if (cat === kl || cat.startsWith(kl + '.')) { if (kl.length > best) { best = kl.length; effMin = String(catLevels[k]).toLowerCase(); } }
            }
          }
          if (effMin && (lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder[effMin] ?? 2)) return;
          const toRegex = (p: string) => new RegExp('^' + String(p||'').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
          const enableCodes: string[] = Array.isArray(logCfg.enableCodes) ? logCfg.enableCodes : [];
          const disableCodes: string[] = Array.isArray(logCfg.disableCodes) ? logCfg.disableCodes : [];
          if (code && disableCodes.some((p) => toRegex(p).test(code))) return;
          if (enableCodes.length && code && (lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder['warn'] ?? 1)) {
            if (!enableCodes.some((p) => toRegex(p).test(code))) return;
          }
        }
      } catch {}
      recordSessionLog({ level, message, timestamp, context, cat });
      // Overwrite outgoing payload timestamp and normalized category
      try {
        payload = { ...payload, timestamp, cat, code, cid, context };
      } catch {}
    }
  } catch {}
  ioRef?.emit(event, payload);
}

export async function notifyArbServiceRefresh(): Promise<void> {
  try {
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    await fetch(`${host}/graph/trigger-refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'graph-diff' }) });
  } catch {}
}

// Simple sequential push queue to arb-rs with detection-run acknowledgement
type ArbJob = { kind: 'snapshot' | 'diff'; payload: any; resolve: () => void; reject: (e: any) => void };
let arbQueue: ArbJob[] = [];
let arbInFlight = false;

async function fetchArbMetrics(): Promise<{ last_detection_ms: number }> {
  try {
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
      const before = await fetchArbMetrics();
      try {
        if (job.kind === 'snapshot') {
          // eslint-disable-next-line no-undef
          await fetch(`${host}/arb/graph/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ graph: job.payload }) });
        } else {
          // eslint-disable-next-line no-undef
          await fetch(`${host}/arb/graph/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job.payload) });
        }
      } catch (e: any) {
        try { logger.warn('arb.push failed', { kind: job.kind, error: String(e?.message || e) }); } catch {}
      }
      try { await notifyArbServiceRefresh(); } catch {}
      // Wait for detection loop to complete (last_detection_ms to increase)
      const start = Date.now();
      let observed = before.last_detection_ms;
      const timeoutMs = 12_000;
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 250));
        const cur = await fetchArbMetrics();
        if (cur.last_detection_ms > observed) { observed = cur.last_detection_ms; break; }
      }
      try { logger.info('arb.push ack', { kind: job.kind, waited_ms: Date.now() - start }); } catch {}
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
    arbQueue.push({ kind: 'snapshot', payload: snapshot, resolve, reject });
    processArbQueue().catch(() => {});
  });
}

export async function pushArbGraphDiff(diff: any): Promise<void> {
  return new Promise((resolve, reject) => {
    arbQueue.push({ kind: 'diff', payload: diff, resolve, reject });
    processArbQueue().catch(() => {});
  });
}

// Lightweight readiness probe for arb-rs backend mode
export async function checkArbServiceReady(timeoutMs = 4000): Promise<boolean> {
  try {
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


