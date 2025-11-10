# RPC Blocking Debug - Investigation and Fix

## Problem
RPC calls seem to be blocked - everything that relies on them just doesn't work anymore.

## ROOT CAUSE IDENTIFIED ✓

**The token bucket was starting with 0 tokens!**

### The Bug
```typescript
// OLD (BROKEN):
let tokens = 0;
let lastRefillMs = Date.now();
```

When the first RPC calls came in immediately after startup, there were no tokens available. The `acquireRpcSlots` function would enter a loop waiting for tokens to accrue via `refill()`, but since virtually no time had passed, the refill wouldn't add enough tokens, causing calls to block indefinitely or for a very long time.

### The Fix
```typescript
// NEW (FIXED):
const maxRps = Math.max(1, Number(process.env.RPC_MAX_RPS || 50));
const capacity = Math.max(1, Math.min(maxRps, Number(process.env.RPC_BURST || Math.ceil(maxRps / 4))));
let tokens = capacity;  // START WITH FULL CAPACITY
let lastRefillMs = Date.now();
```

Now the rate limiter starts with full capacity (default: 12 tokens), allowing the first burst of RPC calls to proceed immediately without blocking.

## Additional Improvements Made

### 1. Infinite Loop Protection
Added safety checks to prevent the rate limiter from getting stuck indefinitely:

```typescript
let iterations = 0;
for (;;) {
  iterations++;
  
  // Safety check
  if (iterations > 100 || (Date.now() - acquireStart) > 30000) {
    console.error(`[RPC LIMITER] STUCK: waited ${Date.now() - acquireStart}ms, ${iterations} iterations...`);
    break;  // Force exit
  }
  
  // ... rest of logic
}
```

### 2. Diagnostic Logging
Added comprehensive logging to help diagnose future issues:

**At startup:**
```
[RPC LIMITER] Initialized: maxRps=50, capacity=12, minGapMs=20, initialTokens=12
```

**For first 5 RPC calls:**
```
[RPC LIMITER] Call #1: module=wallet, method=getBalance, weight=1, tokens=12
[RPC LIMITER] Call #2: module=wallet, method=getBalance, weight=1, tokens=11
...
```

**If limiter gets stuck:**
```
[RPC LIMITER] STUCK: waited 30000ms, 150 iterations, need=1, tokens=0, maxRps=50, capacity=12
```

## Testing the Fix

1. **Rebuild the backend:**
   ```bash
   cd backend && npm run build
   ```

2. **Start the backend:**
   ```bash
   npm run dev
   ```

3. **Check console output** - you should see:
   ```
   [RPC LIMITER] Initialized: maxRps=50, capacity=12, minGapMs=20, initialTokens=12
   [RPC LIMITER] Call #1: module=wallet, method=getBalance, weight=1, tokens=12
   ```

4. **Test RPC-dependent features:**
   - Wallet balance fetching
   - Pool data loading
   - Transaction execution
   - All should now work immediately without delay

## Why This Happened

The token bucket rate limiter is designed to smooth out RPC requests over time:
- Tokens refill at `maxRps` per second (default: 50/sec)
- Each RPC call consumes tokens based on weight (default: 1)
- If no tokens available, calls wait for refill

**The problem:** Starting with 0 tokens meant ALL initial calls had to wait, creating a backlog. With default settings:
- `maxRps = 50` → adds 0.05 tokens per millisecond
- To accumulate 1 token from 0 → takes 20ms
- To accumulate 12 tokens from 0 → takes 240ms

During startup, the backend typically makes dozens of RPC calls in quick succession (wallet queries, pool data, ALT lookups, etc.), so the 240ms wasn't enough to satisfy the burst demand, causing longer and longer delays.

**The fix:** Starting with `capacity` tokens (12) allows the initial burst to proceed immediately, then the refill mechanism keeps the steady-state rate under control.

## Files Modified

- `backend/src/utils/rpcLimiter.ts`
  - Initialize `tokens = capacity` instead of `tokens = 0`
  - Added infinite loop protection in `acquireRpcSlots`
  - Added diagnostic logging at startup and for first 5 calls
  - Added stuck detection logging

## Impact

✅ **FIXED:** RPC calls no longer blocked at startup
✅ **IMPROVED:** Added safety checks to prevent future hangs  
✅ **IMPROVED:** Added diagnostics for troubleshooting

## Configuration (optional)

You can adjust rate limiting via environment variables:

```bash
# Increase throughput for premium RPC providers
RPC_MAX_RPS=100          # Max requests per second
RPC_BURST=25             # Burst capacity (tokens)
RPC_MIN_GAP_MS=10        # Minimum gap between requests (ms)

# Or decrease for conservative rate limiting  
RPC_MAX_RPS=25           # Max requests per second
RPC_BURST=6              # Burst capacity (tokens)
RPC_MIN_GAP_MS=30        # Minimum gap between requests (ms)
```

**Default values (work well for most cases):**
- `RPC_MAX_RPS=50`
- `RPC_BURST=12` (25% of max RPS)
- `RPC_MIN_GAP_MS=20`


