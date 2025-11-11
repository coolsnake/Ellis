# WebSocket Subscription Rate Limit Fix - COMPLETE ✅

## Problem Identified

WebSocket `accountSubscribe` RPC calls were causing RPS spikes to 90-100, seemingly bypassing the RPS limiter.

## Root Cause

The codebase had **two separate, decoupled rate limiters** for WebSocket subscriptions:

1. **`waitForWsAttachSlot()`** - Custom rate limiter (10/sec by default)
   - Used simple time-based delays between calls
   - Did NOT consume from the global RPC token bucket
   - Created its own queue of delayed subscription calls

2. **`withRpcLimit()`** - Global RPC rate limiter (50/sec by default)
   - Uses token bucket algorithm
   - Shared across ALL RPC calls (subscriptions, queries, etc.)
   - Enforces minimum gap between dispatches

### The Race Condition

During pool subscription setup (especially after the account subscription fix that added 4-9 subscriptions per pool):

1. Multiple subscription calls queue up at `waitForWsAttachSlot()` (10/sec pace)
2. Each call waits its turn at the custom limiter
3. Once released, they immediately try to execute via `withRpcLimit()`
4. Multiple subscription batches happen simultaneously (different DEXes, retries, etc.)
5. When the global token bucket refills, **multiple queued calls grab tokens nearly simultaneously**
6. Result: **Burst traffic and RPS spikes to 90-100**

The two rate limiters were out of sync, causing bursty behavior rather than smooth rate limiting.

## Solution: Option 1 - Unified Rate Limiting

**Removed `waitForWsAttachSlot()` entirely and rely solely on `withRpcLimit()` for all rate limiting.**

### Changes Made

#### 1. Removed Custom Rate Limiter (backend/src/server/pools.ts, lines 1614-1626)

**Before:**
```typescript
// Shared WS attach rate limiter for all RPC operations during attachment
const wsAttachPerSec = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
const wsAttachIntervalMs = Math.floor(1000 / wsAttachPerSec);
let lastWsAttachMs = 0;
const waitForWsAttachSlot = async () => {
  const now = Date.now();
  const elapsed = now - lastWsAttachMs;
  if (elapsed < wsAttachIntervalMs) {
    await sleep(wsAttachIntervalMs - elapsed);
  }
  lastWsAttachMs = Date.now();
};
```

**After:**
```typescript
// REMOVED - rely on global RPC limiter instead
```

#### 2. Updated `subscribeAccountWithRetry` (backend/src/server/pools.ts, line 1640)

**Before:**
```typescript
await waitForWsAttachSlot(); // Rate-limit the RPC call

// Wrap subscription call with RPC tracking
const id = await withRpcLimit(
  () => conn.onAccountChange(accountPk, (info: any) => { try { cb(accountPk, info); } catch {} }),
  1,
  { module: 'pools', method: 'accountSubscribe' }
);
```

**After:**
```typescript
// Wrap subscription call with RPC tracking and rate limiting
const id = await withRpcLimit(
  () => conn.onAccountChange(accountPk, (info: any) => { try { cb(accountPk, info); } catch {} }),
  1,
  { module: 'pools', method: 'accountSubscribe' }
);
```

#### 3. Updated Meteora Bin Array Subscription (backend/src/server/pools.ts, line 1869)

**Before:**
```typescript
try {
  await waitForWsAttachSlot(); // Rate-limit subscription, but don't fetch
  logger.debug('meteora.bin.subscribed', { ... });
} catch {}
```

**After:**
```typescript
try {
  logger.debug('meteora.bin.subscribed', { ... });
} catch {}
```

#### 4. Wrapped Additional Drift Resubscribe Calls (backend/src/drift/client.ts)

Added `withRpcLimit()` wrappers to reconnection handlers:
- Slot subscriber resubscribe (lines 463-471)
- Event subscriber resubscribe (lines 475-482)
- UserMap resubscribe (lines 486-493, 547-566)
- DLOB subscriber resubscribe (lines 500-507, 597-621)

#### 5. Wrapped Drift Trigger Subscriptions (backend/src/drift/trigger.ts)

Added `withRpcLimit()` wrappers to:
- DLOB subscriber initial subscribe (lines 426-431)
- Pyth Lazer subscriber (lines 444-449)

## Why This Fix Works

### 1. **Single Source of Truth**
All RPC calls (subscriptions, queries, getAccountInfo, etc.) now share the same token bucket. No more out-of-sync rate limiters.

### 2. **Prevents Burst Traffic**
The global `withRpcLimit()` enforces:
- Token bucket rate limiting (refills at `RPC_MAX_RPS`, default 50/sec)
- Minimum gap between dispatches (`RPC_MIN_GAP_MS`, default 20ms)
- Proper queueing with FIFO order

### 3. **Eliminates Race Conditions**
No more situation where calls queue up at one limiter and rush through another. Every call waits for an available token from the shared bucket.

### 4. **Better Resource Allocation**
During high load, subscriptions and queries compete fairly for RPC slots instead of subscriptions getting their own separate quota.

## Outer Loop Rate Limiting (Still Present)

Note: The subscription setup loops for each DEX still have their own sleep delays:

```typescript
// Orca loop (line 2310)
const basePerSec = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
const intervalMs = Math.floor(1000 / perSec);
for (let i = 0; i < uniq.length; i++) {
  await subscribeAccountWithRetry(pk, handle); // Goes through withRpcLimit()
  if (i < uniq.length - 1 && intervalMs > 0) { 
    await sleep(intervalMs); 
  }
}
```

**This is fine and actually beneficial!** These outer sleep delays:
- Pace the loop iterations to prevent overwhelming the subscription queue
- Don't actually do RPC calls - just control loop timing
- Work in harmony with `withRpcLimit()` inside `subscribeAccountWithRetry`

The outer loops say "don't submit more than 10 subscription requests per second" while the inner `withRpcLimit()` says "don't actually execute more than 50 RPC calls per second total (including subscriptions and everything else)".

This creates a **two-tier rate limiting system** where:
1. **Outer tier (wsAttachPerSec):** Controls subscription request submission rate
2. **Inner tier (withRpcLimit):** Controls actual RPC execution rate across all calls

## Expected Behavior After Fix

### Before (with dual rate limiters)
- RPS spikes to 90-100 during subscription setup
- Bursty traffic pattern
- Subscriptions could overwhelm other RPC calls

### After (unified rate limiting)
- Smooth RPS capped at `RPC_MAX_RPS` (default 50)
- Even distribution of RPC calls
- Subscriptions and queries share bandwidth fairly

## Configuration

All existing config values still apply:

### RPC Limiter (affects all RPC calls including subscriptions)
- `RPC_MAX_RPS`: Maximum RPC calls per second (default: 50)
- `RPC_BURST`: Token bucket capacity (default: RPC_MAX_RPS/4 = 12)
- `RPC_MIN_GAP_MS`: Minimum time between RPC calls (default: 20ms)

### Outer Loop Pacing (still used for loop iteration control)
- `system.wsAttachPerSec`: Subscription request submission rate (default: 10/sec)
- `system.wsRetargetAttachPerSec`: Slower rate during retarget (default: wsAttachPerSec/2)

The key difference: `wsAttachPerSec` now only controls loop pacing, NOT actual RPC execution. All RPC execution goes through the global limiter.

## Testing Recommendations

1. **Monitor RPS in production:**
   - Should see smooth RPS around 40-50 during subscription setup
   - No more spikes to 90-100

2. **Check subscription timing:**
   - Subscriptions may take slightly longer due to unified rate limiting
   - This is expected and prevents provider rate limit errors

3. **Watch for 429 errors:**
   - Should decrease significantly since subscriptions now respect global limit

4. **Verify pool updates:**
   - Pool data should update normally
   - No functional changes to subscription behavior, only timing

## Files Modified

### Primary Changes (Removed `waitForWsAttachSlot`)
- `backend/src/server/pools.ts` - Removed `waitForWsAttachSlot()` and all calls to it

### Additional Changes (Wrapped Previously Unwrapped Subscriptions)
- `backend/src/drift/client.ts` - Wrapped reconnection handler subscriptions
- `backend/src/drift/trigger.ts` - Wrapped initial subscriptions

## Verification Complete ✅

All WebSocket subscription calls in the codebase are now properly wrapped with `withRpcLimit()`:

### Pools Module (backend/src/server/pools.ts)
- ✅ `subscribeAccountWithRetry` - `conn.onAccountChange()` wrapped
- ✅ `subscribeProgramWithRetry` - `conn.onProgramAccountChange()` wrapped

### Drift Client (backend/src/drift/client.ts)
- ✅ Main drift client subscribe
- ✅ Slot subscriber (initial + resubscribe)
- ✅ Event subscriber (initial + resubscribe)
- ✅ UserMap (initial + resubscribe)
- ✅ DLOB subscriber (initial + resubscribe)
- ✅ User account subscribe (getSubaccounts)

### Drift Liquidator (backend/src/drift/liquidator.ts)
- ✅ User subscribe (enqueueIfUnhealthy)
- ✅ User subscribe (probeQueue)

### Drift Trigger (backend/src/drift/trigger.ts)
- ✅ DLOB subscriber
- ✅ Pyth Lazer subscriber

### Drift Trigger Runner (backend/src/drift/triggerRunner.ts)
- ✅ Priority fee subscriber

### Drift Filler Runner (backend/src/drift/fillerRunner.ts)
- ✅ Blockhash subscriber
- ✅ Priority fee subscriber

### Drift Routes (backend/src/server/routes/drift.ts)
- ✅ User subscribe

## Related Documentation

- `backend/docs/ACCOUNT_SUBSCRIPTION_FIX.md` - Account subscription improvements
- `WSS_RPC_TRACKING_COMPLETE.md` - RPC monitoring implementation
- `RPC_BLOCKING_DEBUG.md` - RPC limiter initialization fixes


