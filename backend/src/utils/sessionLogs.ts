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
    const iso = new Date().toISOString().replace(/[:]/g, '-');
    const file = resolve(dir, `session-${iso}.jsonl`);
    const lines = sessionEvents.map((e) => JSON.stringify(e));
    await fsp.writeFile(file, lines.join('\n') + '\n', 'utf-8');
    sessionEvents.length = 0;
    return file;
  } catch {
    return null;
  }
}


