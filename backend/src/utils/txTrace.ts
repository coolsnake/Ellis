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
  const file = FILES[kind];
  await appendJsonl(file, entry);
}

// New: write per-dex full dumps (separate file for each attempt)
export async function writeDexFullDump(dex: 'raydium' | 'orca' | 'meteora', phase: 'preflight' | 'execute', payload: Record<string, any>): Promise<void> {
  const dir = resolve(LOG_DIR_SAFE, `${dex}-${phase}-attempts`);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  
  // Extract identifiers for filename
  const id = payload.id || payload.txId || payload.txLogs?.[0]?.txId || 'unknown';
  const signature = payload.signature || payload.send?.signature || null;
  const hasError = !!(payload.err || payload.sim?.value?.err || payload.send?.err);
  const status = hasError ? 'failed' : 'success';
  
  // Create unique filename: timestamp-id-signature-status.json
  const timestamp = Date.now();
  const idPart = String(id).slice(0, 16); // Truncate long IDs
  const sigPart = signature ? `-${String(signature).slice(0, 8)}` : '';
  const filename = `${timestamp}-${idPart}${sigPart}-${status}.json`;
  const file = resolve(dir, filename);
  
  // Include metadata in the payload
  const enrichedPayload = {
    ...payload,
    _metadata: {
      timestamp,
      dex,
      phase,
      status,
      id,
      signature: signature || null,
      hasError,
    },
  };
  
  const data = JSON.stringify(enrichedPayload, null, 2);
  await writeFile(file, data, { encoding: 'utf8' });
}


