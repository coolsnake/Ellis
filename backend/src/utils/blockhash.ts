// @ts-nocheck
import { Connection } from '@solana/web3.js';
import { withRpcRetry, withRpcTimeout } from './rpcLimiter.js';

type State = {
  conn?: Connection;
  timer?: any;
  lastBh?: string;
  lastLvb?: number;
  ts?: number;
};

const S: State = {};
const DEFAULT_INTERVAL = 400;

export function startSharedBlockhash(connection: Connection, opts?: { intervalMs?: number }): void {
  try {
    if (S.conn) return;
    S.conn = connection;
    const every = Math.max(200, Number(opts?.intervalMs ?? DEFAULT_INTERVAL));

    const step = async () => {
      if (!S.conn) return;
      try {
        const p = withRpcRetry(
          () => S.conn!.getLatestBlockhash({ commitment: 'confirmed' }),
          { timeoutMs: 700, retries: 0, baseMs: 100, maxMs: 300, label: 'bh.shared.warm' }
        );
        const res = await withRpcTimeout(p, 900, 'bh.shared.cap');
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


