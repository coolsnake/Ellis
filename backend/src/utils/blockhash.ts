// @ts-nocheck
import { Connection } from '@solana/web3.js';
import { withRpcRetry, withRpcTimeout } from './rpcLimiter.js';
import { CONFIG } from './config.js';

type State = {
  conn?: Connection;
  timer?: any;
  lastBh?: string;
  lastLvb?: number;
  ts?: number;
};

const S: State = {};
const DEFAULT_INTERVAL = 300;

export function startSharedBlockhash(connection: Connection, opts?: { intervalMs?: number }): void {
  try {
    if (S.conn) return;
    S.conn = connection;
    const every = Math.max(200, Number(opts?.intervalMs ?? DEFAULT_INTERVAL));

    const step = async () => {
      if (!S.conn) return;
      try {
        const res = await fetchLatestBlockhashWithFallback(500, 'bh.shared.warm');
        const bh = String((res as any)?.blockhash || '');
        const lvb = Number((res as any)?.lastValidBlockHeight || 0);
        if (bh) {
          S.lastBh = bh;
          S.lastLvb = lvb;
          S.ts = Date.now();
        }
      } catch {}
    };

    step().catch(() => {});
    S.timer = setInterval(() => { step().catch(() => {}); }, every);
  } catch {}
}

export function stopSharedBlockhash(): void {
  try { if (S.timer) clearInterval(S.timer); } catch {}
  S.timer = undefined;
  S.conn = undefined;
}

export function getCachedBlockhash(maxAgeMs = 1000): string | undefined {
  const now = Date.now();
  try {
    if (S.lastBh && S.ts && (now - S.ts) <= Math.max(0, maxAgeMs)) return S.lastBh;
    return S.lastBh;
  } catch {
    return S.lastBh;
  }
}

export function getLastValidBlockHeight(): number | undefined {
  return S.lastLvb;
}

// Ensure we have a fresh blockhash; if missing/stale, perform a quick fetch now
export async function getFreshBlockhashOrFetch(maxAgeMs = 300): Promise<string | undefined> {
  const now = Date.now();
  try {
    if (S.lastBh && S.ts && (now - S.ts) <= Math.max(0, maxAgeMs)) return S.lastBh;
    if (!S.conn) return S.lastBh;
    const res = await fetchLatestBlockhashWithFallback(600, 'bh.shared.refresh');
    const bh = String((res as any)?.blockhash || '');
    const lvb = Number((res as any)?.lastValidBlockHeight || 0);
    if (bh) { S.lastBh = bh; S.lastLvb = lvb; S.ts = Date.now(); }
    return S.lastBh;
  } catch {
    return S.lastBh;
  }
}


async function fetchLatestBlockhashWithFallback(timeoutMs: number, label: string): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
  // Try primary connection first (rate-limited, timeout-guarded)
  try {
    const p = withRpcRetry(
      () => S.conn!.getLatestBlockhash({ commitment: 'processed' }),
      { timeoutMs: Math.max(250, Math.min(2000, timeoutMs)), retries: 0, baseMs: 80, maxMs: 200, label }
    );
    const res = await withRpcTimeout(p, Math.max(300, Math.min(2500, timeoutMs + 100)), `${label}.cap`);
    return res as any;
  } catch {}

  // Build fallback URL list: prefer read RPC, then primary RPC, then secondaries
  const candidates: string[] = [];
  try { if ((CONFIG as any)?.readRpcUrl) candidates.push(String((CONFIG as any).readRpcUrl)); } catch {}
  try { if ((CONFIG as any)?.rpcUrl) candidates.push(String((CONFIG as any).rpcUrl)); } catch {}
  try {
    const secs: string[] = Array.isArray((CONFIG as any)?.rpcSend?.secondaryRpcUrls) ? (CONFIG as any).rpcSend.secondaryRpcUrls : [];
    for (const u of secs) { candidates.push(String(u)); }
  } catch {}
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const urls = candidates.filter((u) => {
    const key = u.trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const url of urls) {
    try {
      const alt = new Connection(String(url), { commitment: 'processed', disableRetryOnRateLimit: true } as any);
      const res = await withRpcTimeout(
        alt.getLatestBlockhash({ commitment: 'processed' }),
        Math.max(250, Math.min(2000, timeoutMs)),
        `${label}.alt`
      );
      return res as any;
    } catch {}
  }
  return null;
}


