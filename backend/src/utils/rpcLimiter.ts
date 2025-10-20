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


