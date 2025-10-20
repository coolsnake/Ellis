// Simple token-bucket RPC rate limiter shared process-wide
// Goal: keep aggregate JSON-RPC calls under provider limit (e.g., 50 RPS) with buffer

let tokens = 0;
let lastRefillMs = Date.now();
const maxRps = Math.max(1, Number(process.env.RPC_MAX_RPS || 35)); // leave buffer under 50 RPS
const capacity = Math.max(maxRps, Number(process.env.RPC_BURST || 50));

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


