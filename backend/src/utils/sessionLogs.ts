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

const sessionEvents: SessionLogEvent[] = [];
const MAX_EVENTS = Number((globalThis as any)?.process?.env?.SESSION_LOGS_MAX ?? 5000);

export function recordSessionLog(event: SessionLogEvent): void {
  try {
    sessionEvents.push(event);
    // Bound memory: keep only the newest MAX_EVENTS
    if (sessionEvents.length > MAX_EVENTS) {
      sessionEvents.splice(0, sessionEvents.length - MAX_EVENTS);
    }
  } catch {}
}

export async function writeSessionLogAndClear(): Promise<string | null> {
  try {
    if (sessionEvents.length === 0) return null;
    const dir = CONFIG.logDir || resolve('backend', 'logs');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const file = resolve(dir, 'session.json');
    // Limit to last 2000 events
    const items = sessionEvents.slice(-2000);
    await fsp.writeFile(file, JSON.stringify(items, null, 2), 'utf-8');
    sessionEvents.length = 0;
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
    let backend = sessionEvents.slice(-max).map((e) => ({ ...e, source: 'backend' as const }));
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
    const items = merged.slice(-max);
    await fsp.writeFile(out, JSON.stringify(items, null, 2), 'utf-8');
    return out;
  } catch {
    return null;
  }
}


