import { writeFile, mkdir, stat, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { CONFIG } from './config.js';

const LOG_DIR_SAFE = (CONFIG as any)?.logDir || resolve('backend', 'logs');

const FILES = {
  simulate: resolve(LOG_DIR_SAFE, 'tx-sims.jsonl'),
  preflight: resolve(LOG_DIR_SAFE, 'tx-preflights.jsonl'),
  send: resolve(LOG_DIR_SAFE, 'tx-sends.jsonl'),
} as const;

async function appendJsonl(path: string, entry: Record<string, any>): Promise<void> {
  // lightweight rotation by size
  try {
    const maxBytes = Number(process.env.TX_TRACE_MAX_BYTES || 50_000_000);
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      try {
        const s = await stat(path);
        if (s?.size && s.size > maxBytes) {
          const rotated = `${path}.${Date.now()}.bak`;
          await rename(path, rotated).catch(() => {});
        }
      } catch {}
    }
  } catch {}
  const line = JSON.stringify(entry) + '\n';
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, line, { encoding: 'utf8', flag: 'a' });
}

export type TraceKind = keyof typeof FILES;

export async function logTxTrace(kind: TraceKind, entry: Record<string, any>): Promise<void> {
  const path = FILES[kind];
  const payload = {
    _kind: kind,
    _ts: new Date().toISOString(),
    ...entry,
  };
  await appendJsonl(path, payload);
}


