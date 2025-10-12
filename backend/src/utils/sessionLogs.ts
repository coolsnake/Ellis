import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { CONFIG } from './config.js';

export type SessionLogEvent = {
  level: string;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  cat?: string;
};

// In-memory buffer of session events. Module-private; mutate via helpers below.
const _sessionEvents: SessionLogEvent[] = [];

// Test-only helper to seed/override session events without relying on CommonJS exports.
export function setSessionEventsForTest(events: SessionLogEvent[]): void {
  try {
    _sessionEvents.length = 0;
    if (Array.isArray(events)) _sessionEvents.push(...events);
  } catch {}
}
const MAX_EVENTS = Number((globalThis as any)?.process?.env?.SESSION_LOGS_MAX ?? 5000);

export function recordSessionLog(event: SessionLogEvent): void {
  try {
    _sessionEvents.push(event);
    // Bound memory: keep only the newest MAX_EVENTS
    if (_sessionEvents.length > MAX_EVENTS) {
      _sessionEvents.splice(0, _sessionEvents.length - MAX_EVENTS);
    }
  } catch {}
}

export async function writeSessionLogAndClear(): Promise<string | null> {
  try {
    if (_sessionEvents.length === 0) return null;
    const dir = CONFIG.logDir || resolve('backend', 'logs');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const file = resolve(dir, 'session.json');
    // Limit to last 2000 events
    const items = _sessionEvents.slice(-2000);
    await fsp.writeFile(file, JSON.stringify(items, null, 2), 'utf-8');
    _sessionEvents.length = 0;
    return file;
  } catch {
    return null;
  }
}


export async function writeConsolidatedSessionLog(): Promise<string | null> {
  try {
    const dir = CONFIG.logDir || resolve('backend', 'logs');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const out = (CONFIG as any)?.consolidated?.path || resolve(dir, 'consolidated-session.json');
    const max = Number((CONFIG as any)?.consolidated?.max || 2000);

    // Backend session events (prefer in-memory; if empty, fall back to last written session.json)
    let backend = _sessionEvents.slice(-max).map((e) => ({ ...e, source: 'backend' as const }));
    if (!backend.length) {
      try {
        const sessionFile = resolve(dir, 'session.json');
        const text = await fsp.readFile(sessionFile, 'utf-8').catch(() => null);
        if (text) {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            backend = arr.slice(-max).map((e: any) => ({ ...(e || {}), source: 'backend' as const }));
          }
        }
      } catch {}
    }

    // Arb session: read if configured
    let arb: any[] = [];
    try {
      const arbPath = (CONFIG as any)?.consolidated?.arbSessionPath
        || (((CONFIG as any)?.consolidated?.arbLogDir) && resolve((CONFIG as any).consolidated.arbLogDir, 'session.json'))
        || null;
      if (arbPath) {
        const text = await fsp.readFile(arbPath, 'utf-8').catch(() => null);
        if (text) {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            arb = arr.slice(-max).map((line: any) => ({
              source: 'arb', level: 'info', message: String(line), timestamp: null, cat: 'rust' as const,
            }));
          }
        }
      }
    } catch {}

    const merged = [...backend, ...arb];
    // Interleave tails to preserve both sources when present
    const cap = Math.max(1, max);
    const backTail = backend.slice(-cap);
    const arbTail = arb.slice(-cap);
    const outArr: any[] = [];
    let i = backTail.length - 1, j = arbTail.length - 1;
    while (outArr.length < cap && (i >= 0 || j >= 0)) {
      if (i >= 0) outArr.push(backTail[i--]);
      if (outArr.length < cap && j >= 0) outArr.push(arbTail[j--]);
    }
    const items = outArr.reverse();
    await fsp.writeFile(out, JSON.stringify(items, null, 2), 'utf-8');
    return out;
  } catch {
    return null;
  }
}


