export type RetryOptions = {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = Math.max(0, Number(opts.maxRetries ?? 5));
  const baseMs = Math.max(100, Number(opts.baseMs ?? 300));
  const maxMs = Math.max(baseMs, Number(opts.maxMs ?? 8000));
  const jitter = !!opts.jitter;
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i === maxRetries) break;
      const msg = String(e?.message || e || '').toLowerCase();
      // backoff with cap and jitter
      const delay = Math.min(maxMs, baseMs * Math.pow(2, i)) + (jitter ? Math.floor(Math.random() * Math.min(250, baseMs)) : 0);
      await sleep(delay);
      continue;
    }
  }
  throw lastErr;
}


