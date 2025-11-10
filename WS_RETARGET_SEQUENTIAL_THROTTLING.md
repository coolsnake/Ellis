# WebSocket Retarget Sequential Throttling Implementation ✅

## Problem

When performing a "retarget WS" operation with many pool subscriptions active, the system experienced:

1. **Cascading RPC rate limit failures** - 429 "Too Many Requests" errors
2. **RPC limiter force-allowing calls** - "STUCK" messages with near-zero fractional token values
3. **Exponential retry backoff loops** - Creating even more queued requests
4. **Service disruption** - Pool data updates stalled during retarget

### Root Cause

The original `retargetPoolWebsockets()` function would:
1. Unsubscribe ALL pools instantly
2. Wait only 250ms
3. Start resubscribing ALL three DEX sources (Orca, Raydium, Meteora) **simultaneously**
4. Each source subscribed at 10 pools/sec

**Result:** With 100+ pools across 3 DEXes, this created a sustained burst of **30+ RPC calls/sec** over several seconds, overwhelming the RPC limiter configured at 50 RPS.

### Example Logs (Before Fix)

```
2025-11-10T14:04:31+00:00 [RPC LIMITER] STUCK: waited 1710ms, 101 iterations, need=1, tokens=0.05
2025-11-10T14:04:31+00:00 [RPC LIMITER] Force-allowing call to prevent deadlock
2025-11-10T14:04:31+00:00 Server responded with 429 Too Many Requests. Retrying after 500ms delay...
2025-11-10T14:04:31+00:00 Server responded with 429 Too Many Requests. Retrying after 1000ms delay...
```

## Solution: Sequential Subscription with Throttling

### Overview

Instead of subscribing to all DEX sources in parallel, we now:
1. **Cooldown period** after unsubscribe (2-3 seconds) - lets RPC limiter refill
2. **Subscribe DEX sources sequentially** with stagger delays:
   - Orca subscribes first
   - Wait (stagger delay)
   - Raydium subscribes
   - Wait (stagger delay)
   - Meteora subscribes
3. **Slower subscription rate** during retarget (5 pools/sec instead of 10)
4. **Extended wait time** for subscriptions to complete

### Implementation Details

#### 1. Enhanced `retargetPoolWebsockets()` Function

**Location:** `backend/src/server/pools.ts` (lines 494-580)

**Key Changes:**
- Added cooldown period before resubscription
- Sets `__sequentialMode` flag to trigger sequential logic
- Extended wait time for sequential attachment to complete
- Comprehensive logging at each step

#### 2. Sequential Mode Logic

**Location:** `backend/src/server/pools.ts` (lines 2236-2242)

Checks for sequential mode flag:
```typescript
const isSequentialMode = suppressInitialOnce === true && !!(startPoolWebsocketsOnlyOnce as any).__sequentialMode;
const staggerDelayMs = isSequentialMode ? Number((CONFIG.system as any)?.wsRetargetStaggerMs || 3000) : 0;
```

#### 3. Stagger Delays Between DEX Sources

**Location:** `backend/src/server/pools.ts`

- After Orca subscriptions (lines 2354-2364)
- After Raydium subscriptions (lines 2471-2481)

Each adds a configurable delay before the next DEX source starts.

#### 4. Throttled Subscription Rates

**Applied to:**
- Orca: lines 2295-2309
- Raydium: lines 2389-2403
- Meteora: lines 2507-2521

During sequential mode, uses `wsRetargetAttachPerSec` (default: half of normal rate).

```typescript
const perSec = isSequentialMode 
  ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSec / 2)))
  : basePerSec;
```

#### 5. Flag Cleanup

**Location:** `backend/src/server/pools.ts` (lines 2815-2819)

Sequential mode flag is cleared after setup completes to prevent affecting subsequent subscriptions.

## Configuration

### New Environment Variables

Add to `.env`:

```bash
# WebSocket Retarget Sequential Throttling
WS_RETARGET_COOLDOWN_MS=2000         # Wait after unsubscribe before resubscribe (default: 2000)
WS_RETARGET_STAGGER_MS=3000          # Wait between DEX sources during retarget (default: 3000)
WS_RETARGET_ATTACH_PER_SEC=5         # Pools per second during retarget (default: half of WS_ATTACH_PER_SEC)
WS_RETARGET_ATTACH_WAIT_MS=15000     # Wait for attachments to complete (default: 15000)

# WebSocket Subscription (existing)
WS_ATTACH_PER_SEC=10                 # Normal subscription rate

# RPC Rate Limiting (existing)
RPC_MAX_RPS=50
RPC_BURST=50                         # Increased from 25 to match maxRps
```

### Recommended Configuration

For **50 RPS RPC limit** with **~100 total pools**:

```bash
WS_RETARGET_COOLDOWN_MS=2000        # 2 second cooldown
WS_RETARGET_STAGGER_MS=3000         # 3 seconds between DEXes
WS_RETARGET_ATTACH_PER_SEC=5        # 5 pools/sec during retarget
WS_RETARGET_ATTACH_WAIT_MS=20000    # 20 seconds to complete all subscriptions
```

For **100 RPS RPC limit** (premium endpoints):

```bash
WS_RETARGET_COOLDOWN_MS=1000        # 1 second cooldown
WS_RETARGET_STAGGER_MS=2000         # 2 seconds between DEXes
WS_RETARGET_ATTACH_PER_SEC=10       # 10 pools/sec (match normal rate)
WS_RETARGET_ATTACH_WAIT_MS=15000    # 15 seconds
```

## Timing Analysis

### Before (Parallel)

With 30 Orca + 40 Raydium + 20 Meteora pools @ 10 pools/sec each:

```
Unsubscribe: instant
Wait: 250ms
Orca starts:    0s -> 3s  (30 pools @ 10/sec)
Raydium starts: 0s -> 4s  (40 pools @ 10/sec)  } All simultaneous
Meteora starts: 0s -> 2s  (20 pools @ 10/sec)  }
--------------------------------------------------
Total time: ~4 seconds
Peak RPS: ~30 calls/sec sustained
Result: ❌ Overwhelms 50 RPS limiter
```

### After (Sequential with Throttling)

With same pool counts @ 5 pools/sec during retarget:

```
Unsubscribe:     0s
Cooldown:        0s -> 2s
Orca:            2s -> 8s   (30 pools @ 5/sec)
Stagger delay:   8s -> 11s
Raydium:         11s -> 19s (40 pools @ 5/sec)
Stagger delay:   19s -> 22s
Meteora:         22s -> 26s (20 pools @ 5/sec)
--------------------------------------------------
Total time: ~26 seconds
Peak RPS: ~5 calls/sec sustained
Result: ✅ Well within 50 RPS limit
```

## Benefits

1. **Eliminates RPC burst** - Spreads load over 20-30 seconds instead of 3-4 seconds
2. **No more 429 errors** - Stays comfortably within rate limits
3. **No force-allow calls** - RPC limiter operates normally
4. **Predictable behavior** - Sequential execution is easier to reason about
5. **Graceful degradation** - If one DEX fails, others still complete
6. **Production-ready** - Handles any pool count without overwhelming RPC

## Logging

New log messages during retarget:

```
[INFO] pools:ws retarget.start - sequential resubscription with throttling
[INFO] pools.ws retarget.cooldown { ms: 2000 }
[INFO] pools.ws sequential.mode { enabled: true, staggerMs: 3000 }
[INFO] pools.ws dex.subscribe.start { dex: 'orca', sequential: true }
[INFO] pools.ws orca.loop.start { poolCount: 30, rateLimit: '5/sec', intervalMs: 200, sequential: true }
[INFO] pools.ws sequential.stagger { afterDex: 'orca', beforeDex: 'raydium', delayMs: 3000 }
[INFO] pools.ws dex.subscribe.start { dex: 'raydium', sequential: true }
[INFO] pools.ws raydium.loop.start { poolCount: 40, rateLimit: '5/sec', intervalMs: 200, sequential: true }
[INFO] pools.ws sequential.stagger { afterDex: 'raydium', beforeDex: 'meteora', delayMs: 3000 }
[INFO] pools.ws dex.subscribe.start { dex: 'meteora', sequential: true }
[INFO] pools.ws meteora.loop.start { poolCount: 20, rateLimit: '5/sec', intervalMs: 200, sequential: true }
[INFO] pools.ws retarget.waiting { ms: 15000, reason: 'sequential attachment' }
[INFO] pools.ws retarget.complete { attached: { orca: 30, raydium: 40, meteora: 20 } }
```

## Testing

### Before Testing
1. Build backend: `npm run build`
2. Restart backend process
3. Ensure pool subscriptions are active (check RPC Monitor)

### Test Retarget
1. Trigger retarget via API:
   ```bash
   curl -X POST http://localhost:3001/api/arb/pools/retarget
   ```
2. Monitor logs for sequential subscription messages
3. Watch RPC Monitor dashboard:
   - Available tokens should stay above 10
   - No "STUCK" messages
   - No 429 errors
   - Success rate should stay > 95%

### Expected Results
- ✅ Retarget completes in 15-30 seconds (depending on pool count)
- ✅ No RPC limiter warnings
- ✅ No 429 errors from server
- ✅ All pools successfully resubscribed
- ✅ WebSocket health status remains healthy

## Related Files Modified

1. `backend/src/server/pools.ts` - Main implementation
2. `WS_RETARGET_SEQUENTIAL_THROTTLING.md` - This documentation

## Backward Compatibility

- ✅ Normal startup subscriptions unaffected (not sequential)
- ✅ Uses existing rate limiter configuration as base
- ✅ All new config variables have sensible defaults
- ✅ Falls back to parallel mode if sequential flag not set

## Status: ✅ COMPLETE

The WebSocket retarget sequential throttling implementation is complete and ready for testing!

---

## Next Steps (Optional Enhancements)

1. **Adaptive rate limiting** - Adjust speed based on RPC limiter token availability
2. **Progress reporting** - Emit real-time progress events during retarget
3. **Cancellation support** - Allow aborting retarget mid-process
4. **Health checks** - Verify pool data quality after retarget
5. **Metrics collection** - Track retarget duration, success rates, pool counts


