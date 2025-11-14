# RPC Limiter and Debouncing Improvements

**Date:** 2025-11-14  
**Status:** ✅ Complete

## Overview

Enhanced RPC rate limiting and added debouncing to prevent subscription storms and rapid-fire RPC calls that could overwhelm the RPC provider.

---

## Changes Made

### 1. ✅ Added Debouncing Utilities to RPC Limiter

**File:** `backend/src/utils/rpcLimiter.ts`

**New Functions:**

#### `withDebounce<T>(key, fn, delayMs)`
- Prevents rapid-fire calls by enforcing a minimum delay between executions
- Uses a state management system to track last call time per unique key
- Automatically cancels pending timers and schedules new calls
- Default delay: 100ms

```typescript
export async function withDebounce<T>(
  key: string,
  fn: () => Promise<T> | T,
  delayMs = 100
): Promise<T>
```

#### `withSubscriptionRateLimit<T>(key, fn, context)`
- Specialized wrapper for subscription calls
- Combines debouncing (250ms) with RPC rate limiting
- Provides proper metrics tracking for subscriptions
- Uses unique keys per subscription to prevent duplicate rapid subscriptions

```typescript
export async function withSubscriptionRateLimit<T>(
  key: string,
  fn: () => Promise<T>,
  context?: { module?: string; method?: string }
): Promise<T>
```

---

### 2. ✅ Fixed Missing RPC Limiter Usage in Enrichment Functions

**Files Fixed:**

#### `backend/src/server/pools/meteoraBalanced.ts`
- **Before:** Using `await new Promise(r => setTimeout(r, 50))` for manual rate limiting
- **After:** Using `withRpcLimit()` with proper weight calculation
- **Lines:** 898-905, 953-958, 1016-1021
- **Impact:** 3 batch fetch loops now properly rate limited

```typescript
// Before
await new Promise(r => setTimeout(r, 50));
const accounts = await conn.getMultipleAccountsInfo(pubkeys);

// After
const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
const accounts = await withRpcLimit(
  () => conn.getMultipleAccountsInfo(pubkeys),
  weight,
  { module: 'pools', method: 'getMultipleAccountsInfo' }
);
```

#### `backend/src/server/pools.ts`
- **Functions:** `preloadPumpswapVaultCache()`, `preloadMeteoraBalancedVaultCache()`
- **Before:** Manual delays with `setTimeout`
- **After:** Proper RPC rate limiting with weight calculation
- **Lines:** 503-510, 585-592
- **Impact:** Vault cache preloading now properly tracked and rate limited

---

### 3. ✅ Added Debouncing to All Account Subscriptions

**Pattern Applied:** All subscription calls now use `withDebounce()` wrapped around `withRpcLimit()`

#### Pool Subscriptions (`backend/src/server/pools.ts`)

**Account Subscriptions:**
- `subscribeAccountWithRetry()` - Lines 2991-3039
- Added 150ms debounce per account pubkey
- Debounce key: `pools:accountSubscribe:{pubkey}`

**Program Subscriptions:**
- `subscribeProgramWithRetry()` - Lines 3065-3090
- Added 150ms debounce per program pubkey
- Debounce key: `pools:programSubscribe:{pubkey}`

```typescript
// Pattern used
const debounceKey = `pools:accountSubscribe:${accountPk.toBase58()}`;

const id = await withDebounce(
  debounceKey,
  async () => {
    return await withRpcLimit(
      () => conn.onAccountChange(accountPk, callback),
      1,
      { module: 'pools', method: 'accountSubscribe' }
    );
  },
  150 // 150ms debounce
);
```

#### Drift Subscriptions

**File: `backend/src/drift/client.ts`**
- UserMap subscriptions (resubscribe stage) - Lines 485-500
- DLOB subscriptions (resubscribe stage) - Lines 502-522
- UserMap initial subscriptions - Lines 558-591
- DLOB main subscriptions - Lines 631-645
- DLOB resubscriptions - Lines 653-670
- Added 200ms debounce for all

**File: `backend/src/drift/trigger.ts`**
- DLOB subscriber - Lines 425-437
- Pyth Lazer client - Lines 449-461
- Added 200ms debounce for all

**File: `backend/src/drift/liquidator.ts`**
- User subscriptions (enqueueIfUnhealthy) - Lines 735-750
- User subscriptions (probeQueue) - Lines 2017-2033
- Added 200ms debounce per user pubkey

**File: `backend/src/drift/fillerRunner.ts`**
- Priority fee subscriber - Lines 290-304
- Added 200ms debounce

**File: `backend/src/drift/triggerRunner.ts`**
- Priority fee subscriber - Lines 192-206
- Added 200ms debounce

**File: `backend/src/server/routes/drift.ts`**
- User balance subscriptions - Lines 518-532
- Added 200ms debounce per user pubkey

---

## Debounce Timing Strategy

| Use Case | Delay | Rationale |
|----------|-------|-----------|
| Pool Account Subscriptions | 150ms | Fast pool updates needed for MEV/arbitrage |
| Pool Program Subscriptions | 150ms | Program-level updates less frequent |
| Drift Service Subscriptions | 200ms | Drift updates less time-sensitive |
| User-specific Subscriptions | 200ms | Per-user keys prevent user-level spam |

---

## Benefits

### 1. **Prevents Subscription Storms**
- Rapid retry loops now properly throttled
- Duplicate subscription attempts debounced
- Per-key debouncing prevents cross-contamination

### 2. **Better RPC Tracking**
- All enrichment calls now tracked in RPC metrics
- Proper weight calculation for batch operations
- Accurate rate limiting for all subscription types

### 3. **Reduced RPC Load**
- Eliminated manual delays that weren't tracked
- Proper backpressure via token bucket + debouncing
- Prevents rapid-fire retries on transient errors

### 4. **Improved Reliability**
- Subscriptions less likely to fail due to rate limits
- Debouncing prevents thundering herd on reconnects
- Better handling of WebSocket state transitions

---

## Testing Recommendations

1. **Monitor RPC Metrics Dashboard**
   - Check that subscription calls are properly tracked
   - Verify rate limiter tokens not depleting too fast
   - Confirm no subscription-related RPC errors

2. **Test Reconnection Scenarios**
   - Kill/restart RPC connection
   - Verify subscriptions don't rapid-fire on reconnect
   - Check logs for debounce behavior

3. **Load Testing**
   - High pool count scenarios (100+ pools)
   - Multiple simultaneous users/subaccounts
   - Verify debouncing prevents storms

4. **Metrics to Monitor**
   ```
   - RPC calls by method: accountSubscribe
   - RPC calls by module: pools, drift
   - Success rate for subscriptions
   - Rate limiter queue depth
   - Available tokens
   ```

---

## Configuration

### Environment Variables (existing)
```bash
RPC_MAX_RPS=50          # Max requests per second
RPC_BURST=12            # Token bucket capacity
RPC_MIN_GAP_MS=20       # Minimum gap between dispatches
```

### Debounce Timing (hardcoded in improvements)
- Pool subscriptions: 150ms
- Drift subscriptions: 200ms
- Can be made configurable if needed

---

## Migration Notes

### Breaking Changes
None - All changes are additive and backward compatible.

### Deprecations
None - Manual delays were replaced but not formally deprecated.

### Performance Impact
- Slight latency increase (150-200ms) on first subscription attempt
- Net reduction in RPC load due to prevented rapid-fire calls
- Better overall throughput due to proper rate limiting

---

## Related Files

- `backend/src/utils/rpcLimiter.ts` - Core debouncing utilities
- `backend/src/server/pools.ts` - Pool subscription debouncing
- `backend/src/server/pools/meteoraBalanced.ts` - Meteora enrichment fixes
- `backend/src/drift/client.ts` - Drift service subscriptions
- `backend/src/drift/trigger.ts` - Trigger bot subscriptions
- `backend/src/drift/liquidator.ts` - Liquidator subscriptions
- `backend/src/drift/fillerRunner.ts` - Filler runner subscriptions
- `backend/src/drift/triggerRunner.ts` - Trigger runner subscriptions
- `backend/src/server/routes/drift.ts` - API route subscriptions

---

## Summary

✅ **Added debouncing utilities** to `rpcLimiter.ts`  
✅ **Fixed 3 enrichment functions** to use `withRpcLimit`  
✅ **Added debouncing to 15+ subscription sites** across 9 files  
✅ **Improved RPC tracking** for all subscription types  
✅ **Prevented subscription storms** with per-key debouncing  

**Result:** More reliable RPC usage, better rate limiting, and prevention of rapid-fire subscription attempts.

