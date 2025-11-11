// Simple token-bucket RPC rate limiter shared process-wide
// Goal: keep aggregate JSON-RPC calls under provider limit (e.g., 50 RPS) with buffer

// Parse environment variables with defensive fallbacks
function parseEnvNumber(key: string, defaultValue: number): number {
  try {
    const val = process?.env?.[key];
    if (!val) return defaultValue;
    const parsed = Number(val);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}

const maxRps = parseEnvNumber('RPC_MAX_RPS', 50);
const burstEnv = parseEnvNumber('RPC_BURST', 0);
const capacity = burstEnv > 0 ? burstEnv : Math.max(1, Math.ceil(maxRps / 4));
const minGapMs = parseEnvNumber('RPC_MIN_GAP_MS', 20);

// Validate all values are finite numbers
if (!Number.isFinite(maxRps) || !Number.isFinite(capacity) || !Number.isFinite(minGapMs)) {
  console.error('[RPC LIMITER] FATAL: Invalid configuration', { maxRps, capacity, minGapMs });
  throw new Error('RPC Limiter: Invalid numeric configuration');
}

// Start with full capacity so first requests don't block
let tokens = capacity;
let lastRefillMs = Date.now();
let lastDispatchMs = 0;
let gapChain: Promise<void> = Promise.resolve();
let queueDepth = 0;

// Log initial configuration
console.log(`[RPC LIMITER] Initialized: maxRps=${maxRps}, capacity=${capacity}, minGapMs=${minGapMs}, initialTokens=${tokens}`);
if (process.env.RPC_MAX_RPS || process.env.RPC_BURST || process.env.RPC_MIN_GAP_MS) {
  console.log(`[RPC LIMITER] Custom config detected:`, {
    RPC_MAX_RPS: process.env.RPC_MAX_RPS,
    RPC_BURST: process.env.RPC_BURST,
    RPC_MIN_GAP_MS: process.env.RPC_MIN_GAP_MS
  });
}

// RPC Metrics tracking
interface RpcCallRecord {
  timestamp: number;
  module: string;
  method: string;
  duration: number;
  weight: number;
  success: boolean;
  error?: string;
}

interface MethodStats {
  count: number;
  errors: number;
  latencies: number[];
  weights: number[];
  lastCall: number;
}

interface ModuleStats {
  count: number;
  errors: number;
  latencies: number[];
  lastCall: number;
}

interface ErrorRecord {
  timestamp: number;
  method: string;
  module: string;
  error: string;
  duration: number;
}

const rpcMetrics = {
  totalCalls: 0,
  totalErrors: 0,
  callsByMethod: new Map<string, MethodStats>(),
  callsByModule: new Map<string, ModuleStats>(),
  recentErrors: [] as ErrorRecord[],
  timestamps: [] as number[], // Rolling window for RPS calculation
  startTime: Date.now(),
};

const MAX_LATENCY_SAMPLES = 1000; // Keep last N latencies per method/module
const MAX_TIMESTAMPS = 3600; // Keep last hour of timestamps for RPS calc
const MAX_RECENT_ERRORS = 50; // Keep last N errors

function refill(): void {
  const now = Date.now();
  const elapsedMs = now - lastRefillMs;
  if (elapsedMs <= 0) return;
  const add = (elapsedMs / 1000) * maxRps;
  
  // Defensive check - if we get NaN, reset to capacity
  if (!Number.isFinite(add) || !Number.isFinite(tokens)) {
    console.error('[RPC LIMITER] NaN detected in refill, resetting to capacity', { tokens, add, elapsedMs, maxRps });
    tokens = capacity;
    lastRefillMs = now;
    return;
  }
  
  tokens = Math.min(capacity, tokens + add);
  
  // Fix floating point precision errors - round to 6 decimal places
  // This prevents accumulation of tiny residual values like 1.021e-14
  tokens = Math.round(tokens * 1000000) / 1000000;
  
  // Treat anything below 0.000001 as zero
  if (tokens < 0.000001) {
    tokens = 0;
  }
  
  lastRefillMs = now;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Helper to calculate percentile from sorted array
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// Record an RPC call for metrics
function recordRpcCall(record: RpcCallRecord): void {
  const now = Date.now();
  rpcMetrics.totalCalls++;
  rpcMetrics.timestamps.push(now);
  
  // Trim old timestamps (keep last hour)
  if (rpcMetrics.timestamps.length > MAX_TIMESTAMPS) {
    rpcMetrics.timestamps = rpcMetrics.timestamps.slice(-MAX_TIMESTAMPS);
  }
  
  // Record by method
  if (!rpcMetrics.callsByMethod.has(record.method)) {
    rpcMetrics.callsByMethod.set(record.method, {
      count: 0,
      errors: 0,
      latencies: [],
      weights: [],
      lastCall: 0,
    });
  }
  const methodStats = rpcMetrics.callsByMethod.get(record.method)!;
  methodStats.count++;
  methodStats.lastCall = now;
  methodStats.latencies.push(record.duration);
  methodStats.weights.push(record.weight);
  if (methodStats.latencies.length > MAX_LATENCY_SAMPLES) {
    methodStats.latencies = methodStats.latencies.slice(-MAX_LATENCY_SAMPLES);
    methodStats.weights = methodStats.weights.slice(-MAX_LATENCY_SAMPLES);
  }
  if (!record.success) {
    methodStats.errors++;
  }
  
  // Record by module
  if (!rpcMetrics.callsByModule.has(record.module)) {
    rpcMetrics.callsByModule.set(record.module, {
      count: 0,
      errors: 0,
      latencies: [],
      lastCall: 0,
    });
  }
  const moduleStats = rpcMetrics.callsByModule.get(record.module)!;
  moduleStats.count++;
  moduleStats.lastCall = now;
  moduleStats.latencies.push(record.duration);
  if (moduleStats.latencies.length > MAX_LATENCY_SAMPLES) {
    moduleStats.latencies = moduleStats.latencies.slice(-MAX_LATENCY_SAMPLES);
  }
  if (!record.success) {
    moduleStats.errors++;
  }
  
  // Record errors
  if (!record.success && record.error) {
    rpcMetrics.totalErrors++;
    rpcMetrics.recentErrors.push({
      timestamp: now,
      method: record.method,
      module: record.module,
      error: record.error,
      duration: record.duration,
    });
    if (rpcMetrics.recentErrors.length > MAX_RECENT_ERRORS) {
      rpcMetrics.recentErrors = rpcMetrics.recentErrors.slice(-MAX_RECENT_ERRORS);
    }
  }
}

// Calculate RPS for various time windows
function calculateRps(windowMs: number): number {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = rpcMetrics.timestamps.filter(t => t >= cutoff);
  return recent.length / (windowMs / 1000);
}

// Get comprehensive RPC metrics snapshot
export function getRpcMetrics(): any {
  refill(); // Update token bucket state
  const now = Date.now();
  
  // Calculate RPS for different windows
  const rps = {
    current: calculateRps(1000),
    avg1s: calculateRps(1000),
    avg5s: calculateRps(5000),
    avg30s: calculateRps(30000),
    avg60s: calculateRps(60000),
  };
  
  // Build method breakdown
  const byMethod: Record<string, any> = {};
  for (const [method, stats] of rpcMetrics.callsByMethod.entries()) {
    const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
    const avgWeight = stats.weights.length > 0
      ? stats.weights.reduce((a, b) => a + b, 0) / stats.weights.length
      : 1;
    const totalWeight = stats.weights.reduce((a, b) => a + b, 0);
    
    byMethod[method] = {
      count: stats.count,
      errors: stats.errors,
      latency: {
        p50: percentile(sortedLatencies, 50),
        p90: percentile(sortedLatencies, 90),
        p95: percentile(sortedLatencies, 95),
        p99: percentile(sortedLatencies, 99),
      },
      weight: Math.round(avgWeight * 100) / 100,
      costTotal: totalWeight,
      lastCall: stats.lastCall === 0 ? 0 : now - stats.lastCall,
    };
  }
  
  // Build module breakdown
  const byModule: Record<string, any> = {};
  for (const [module, stats] of rpcMetrics.callsByModule.entries()) {
    const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
    
    byModule[module] = {
      count: stats.count,
      errors: stats.errors,
      latency: {
        p50: percentile(sortedLatencies, 50),
        p90: percentile(sortedLatencies, 90),
        p95: percentile(sortedLatencies, 95),
        p99: percentile(sortedLatencies, 99),
      },
      lastCall: stats.lastCall === 0 ? 0 : now - stats.lastCall,
    };
  }
  
  // Calculate overall latency percentiles
  const allLatencies: number[] = [];
  for (const stats of rpcMetrics.callsByModule.values()) {
    allLatencies.push(...stats.latencies);
  }
  const sortedAll = [...allLatencies].sort((a, b) => a - b);
  
  return {
    overall: {
      rps,
      rateLimiter: {
        availableTokens: Math.floor(tokens * 100) / 100,
        capacity,
        maxRps,
        queueDepth,
      },
      success: {
        total: rpcMetrics.totalCalls - rpcMetrics.totalErrors,
        rate: rpcMetrics.totalCalls > 0
          ? Math.round(((rpcMetrics.totalCalls - rpcMetrics.totalErrors) / rpcMetrics.totalCalls) * 10000) / 100
          : 100,
      },
      errors: {
        total: rpcMetrics.totalErrors,
        rate: rpcMetrics.totalCalls > 0
          ? Math.round((rpcMetrics.totalErrors / rpcMetrics.totalCalls) * 10000) / 100
          : 0,
      },
      latency: {
        p50: percentile(sortedAll, 50),
        p90: percentile(sortedAll, 90),
        p95: percentile(sortedAll, 95),
        p99: percentile(sortedAll, 99),
      },
      totalCalls: rpcMetrics.totalCalls,
    },
    byModule,
    byMethod,
    recentErrors: rpcMetrics.recentErrors.slice(-10).reverse(),
    timestamp: now,
    uptimeMs: now - rpcMetrics.startTime,
  };
}

export async function acquireRpcSlots(weight = 1): Promise<void> {
  const need = Math.max(1, Math.floor(weight));
  queueDepth++;
  const acquireStart = Date.now();
  
  try {
    let iterations = 0;
    for (;;) {
      iterations++;
      refill();
      
      // Safety check: if we've been waiting too long, force through
      if (iterations > 100 || (Date.now() - acquireStart) > 30000) {
        console.error(`[RPC LIMITER] STUCK: waited ${Date.now() - acquireStart}ms, ${iterations} iterations, need=${need}, tokens=${tokens}, maxRps=${maxRps}, capacity=${capacity}`);
        console.error('[RPC LIMITER] Force-allowing call to prevent deadlock');
        // Force consume whatever tokens we have and allow the call through
        // This is better than blocking forever or throwing an error
        tokens = Math.max(0, tokens - need);
        
        // Fix floating point precision errors
        tokens = Math.round(tokens * 1000000) / 1000000;
        if (tokens < 0.000001) {
          tokens = 0;
        }
        
        return; // EXIT AFTER FORCE-ALLOWING
      }
      
      if (tokens >= need) {
        tokens -= need;
        
        // Fix floating point precision errors after subtraction
        tokens = Math.round(tokens * 1000000) / 1000000;
        if (tokens < 0.000001) {
          tokens = 0;
        }
        
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
  } finally {
    queueDepth--;
  }
}

export async function withRpcLimit<T>(
  fn: () => Promise<T>,
  weight = 1,
  context?: { module?: string; method?: string }
): Promise<T> {
  const startTime = Date.now();
  const module = context?.module || 'unknown';
  const method = context?.method || 'unknown';
  
  // Log first few RPC calls for debugging
  if (rpcMetrics.totalCalls < 5) {
    console.log(`[RPC LIMITER] Call #${rpcMetrics.totalCalls + 1}: module=${module}, method=${method}, weight=${weight}, tokens=${Math.floor(tokens * 100) / 100}`);
  }
  
  try {
    await acquireRpcSlots(weight);
    const result = await fn();
    const duration = Date.now() - startTime;
    
    recordRpcCall({
      timestamp: Date.now(),
      module,
      method,
      duration,
      weight,
      success: true,
    });
    
    return result;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    recordRpcCall({
      timestamp: Date.now(),
      module,
      method,
      duration,
      weight,
      success: false,
      error: String(error?.message || error),
    });
    
    throw error;
  }
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
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    weight?: number;
    timeoutMs?: number;
    retries?: number;
    baseMs?: number;
    maxMs?: number;
    classify?: (err: unknown) => boolean;
    label?: string;
    module?: string;
    method?: string;
  }
): Promise<T> {
  const retries = Math.max(0, Number(opts?.retries ?? 3));
  const baseMs = Math.max(100, Number(opts?.baseMs ?? 300));
  const maxMs = Math.max(baseMs, Number(opts?.maxMs ?? 4000));
  const timeoutMs = Math.max(250, Number(opts?.timeoutMs ?? 2500));
  const weight = Math.max(1, Number(opts?.weight ?? 1));
  const module = opts?.module || opts?.label || 'unknown';
  const method = opts?.method || opts?.label || 'unknown';
  
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
  
  const startTime = Date.now();
  let lastErr: any;
  
  for (let i = 0; i <= retries; i += 1) {
    try {
      await acquireRpcSlots(weight);
      const res = await withRpcTimeout(fn(), timeoutMs, opts?.label);
      const duration = Date.now() - startTime;
      
      recordRpcCall({
        timestamp: Date.now(),
        module,
        method,
        duration,
        weight,
        success: true,
      });
      
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
  
  const duration = Date.now() - startTime;
  recordRpcCall({
    timestamp: Date.now(),
    module,
    method,
    duration,
    weight,
    success: false,
    error: String(lastErr?.message || lastErr),
  });
  
  throw lastErr;
}



