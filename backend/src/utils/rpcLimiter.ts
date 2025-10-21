// Simple token-bucket RPC rate limiter shared process-wide
// Goal: keep aggregate JSON-RPC calls under provider limit (e.g., 50 RPS) with buffer

let tokens = 0;
let lastRefillMs = Date.now();
const maxRps = Math.max(1, Number(process.env.RPC_MAX_RPS || 35)); // leave buffer under 50 RPS
// Limit burst capacity to at most maxRps; default to ~25% of maxRps to avoid flushes
const capacity = Math.max(
  1,
  Math.min(
    maxRps,
    Number(process.env.RPC_BURST || Math.ceil(maxRps / 4))
  )
);
// Enforce a small inter-request gap to avoid micro-bursts when tokens accrue
const minGapMs = Math.max(0, Number(process.env.RPC_MIN_GAP_MS || 20));
let lastDispatchMs = 0;
let gapChain: Promise<void> = Promise.resolve();

function refill(): void {
  const now = Date.now();
  const elapsedMs = now - lastRefillMs;
  if (elapsedMs <= 0) return;
  const add = (elapsedMs / 1000) * maxRps;
  tokens = Math.min(capacity, tokens + add);
  lastRefillMs = now;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function acquireRpcSlots(weight = 1): Promise<void> {
  const need = Math.max(1, Math.floor(weight));
  // Fast path: attempt up to one immediate refill
  for (;;) {
    refill();
    if (tokens >= need) {
      tokens -= need;
      // Sequence callers to preserve a minimum gap between dispatches
      const prev = gapChain;
      gapChain = (async () => {
        try { await prev; } catch {}
        const now = Date.now();
        const waitMs = Math.max(0, (lastDispatchMs + minGapMs) - now);
        if (waitMs > 0) await sleep(waitMs);
        lastDispatchMs = Date.now();
      })();
      await gapChain;
      return;
    }
    // Compute wait until enough tokens accrue
    const deficit = need - tokens;
    const waitMs = Math.ceil((deficit / maxRps) * 1000);
    await sleep(Math.max(5, Math.min(250, waitMs)));
  }
}

export async function withRpcLimit<T>(fn: () => Promise<T>, weight = 1): Promise<T> {
  await acquireRpcSlots(weight);
  return await fn();
}

// Wrap a promise with a timeout guard. Note: this does not cancel the underlying request.
export async function withRpcTimeout<T>(p: Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  if (!(Number.isFinite(timeoutMs) && timeoutMs! > 0)) return p;
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`RPC_TIMEOUT${label ? `:${label}` : ''}`)), Number(timeoutMs));
    }),
  ]);
}

// Retry helper for RPC calls combining rate limit, timeout, and backoff retries
export async function withRpcRetry<T>(fn: () => Promise<T>, opts?: { weight?: number; timeoutMs?: number; retries?: number; baseMs?: number; maxMs?: number; classify?: (err: unknown) => boolean; label?: string }): Promise<T> {
  const retries = Math.max(0, Number(opts?.retries ?? 3));
  const baseMs = Math.max(100, Number(opts?.baseMs ?? 300));
  const maxMs = Math.max(baseMs, Number(opts?.maxMs ?? 4000));
  const timeoutMs = Math.max(250, Number(opts?.timeoutMs ?? 2500));
  const weight = Math.max(1, Number(opts?.weight ?? 1));
  const classify = opts?.classify || ((e: unknown) => {
    const msg = String((e as any)?.message || e || '').toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('rpc_timeout') ||
      msg.includes('fetch failed') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504')
    );
  });
  let lastErr: any;
  for (let i = 0; i <= retries; i += 1) {
    try {
      await acquireRpcSlots(weight);
      const res = await withRpcTimeout(fn(), timeoutMs, opts?.label);
      return res;
    } catch (e: any) {
      lastErr = e;
      if (i === retries) break;
      if (!classify(e)) break;
      const delay = Math.min(maxMs, baseMs * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
  }
  throw lastErr;
}


