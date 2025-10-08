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

export function recordSessionLog(event: SessionLogEvent): void {
  try {
    sessionEvents.push(event);
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


