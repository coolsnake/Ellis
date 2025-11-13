# Diagnostic Logging Added for WebSocket Event Debugging

## Problem
WebSocket subscriptions were being established successfully, but the system was still going "unhealthy" after ~22 seconds with no events, suggesting that either:
1. No WebSocket events are arriving at all
2. Events are arriving but failing to decode
3. Events are being silently dropped

## Diagnostic Logging Added

### 1. **Subscription Success Tracking** (Line ~2796)
Logs when each account subscription is successfully established:

```typescript
logger.debug('pools.ws subscribe.success', {
  account: accountPk.toBase58().slice(0,8) + '…',
  subscriptionId: id,
  cat: 'pools'
});
```

**What to look for:**
- Should see 192 log entries for pumpswap (64 pools × 3 accounts each: pool + vault_a + vault_b)
- Each should have a unique subscriptionId
- If you see these, subscriptions are working

### 2. **WebSocket Event Reception** (Line ~2771)
Logs EVERY WebSocket event that arrives, before any processing:

```typescript
logger.debug('pools.ws event.received', {
  account: accountPk.toBase58().slice(0,8) + '…',
  subscriptionId: id,
  dataLength: info?.data?.length || 0,
  cat: 'pools'
});
```

**What to look for:**
- If you see ZERO of these logs, no WebSocket events are arriving (pools are inactive)
- If you see these but no decode logs, events are being dropped in routing
- Compare event count to expected activity level

### 3. **Event Handler Entry** (Line ~1688)
Logs when the handle callback is invoked and tracks routing:

```typescript
logger.debug('pools.ws handle.entry', {
  account: pk58.slice(0,8) + '…',
  dataLength: info?.data?.length || 0,
  isDerived: derivedAccountToPool.has(pk58),
  isTargeted: targetedSourceByAccount.has(pk58),
  cat: 'pools'
});
```

**What to look for:**
- `isDerived: true` = vault/reserve account (should return early without decoding)
- `isDerived: false, isTargeted: true` = pool account (should route to pumpswap decoder)
- `isDerived: false, isTargeted: false` = unknown account (should be logged as unmapped)

### 4. **Pumpswap Decode Start** (Line ~2457)
Logs when an event is routed to the pumpswap decoder:

```typescript
logger.debug('pools.ws pumpswap.decode.start', {
  pool: pk58.slice(0,8) + '…',
  dataLength: info?.data?.length || 0,
  cat: 'pools'
});
```

**What to look for:**
- Should only see this for pool account events (not vault events)
- If count is zero but events are arriving, routing is broken
- If count is high but no successes, decode logic is failing

### 5. **Pumpswap Decode Success** (Line ~2581)
Logs successful pool decoding with calculated price:

```typescript
logger.debug('pumpswap.ws.decode.success', {
  pool: pk58.slice(0,8) + '…',
  baseReserve: baseReserve.toString(),
  quoteReserve: quoteReserve.toString(),
  price: price_a_per_b,
  cat: 'pools'
});
```

**What to look for:**
- This means vault cache is working and pool was decoded successfully
- Price should be reasonable for the token pair
- Should see graph updates shortly after

### 6. **Pumpswap Decode Failure** (Line ~2609) - ENHANCED
Enhanced error logging with detailed context:

```typescript
logger.warn('pumpswap.ws.decode failed', { 
  id: pk58.slice(0,8) + '…', 
  error: String(e?.message || e),
  dataLength: info?.data?.length || 0,
  hasVaultA: !!(account_a),
  hasVaultB: !!(account_b),
  vaultACached: account_a ? vaultBalanceCache.has(account_a) : false,
  vaultBCached: account_b ? vaultBalanceCache.has(account_b) : false,
  cat: 'pools' 
});
```

**What to look for:**
- `error: "vault balances not in cache"` = vault cache preload failed or vault addresses wrong
- `error: "failed to parse pool pubkeys"` = account data layout is wrong (bad offsets)
- `error: "pumpswap account data too short"` = not a valid pool account
- `vaultACached: false` or `vaultBCached: false` = vault balances missing from cache

### 7. **Callback Errors** (Line ~2781)
Logs any errors in the event callback itself (should never happen):

```typescript
logger.warn('pools.ws event.callback_error', {
  account: accountPk.toBase58().slice(0,8) + '…',
  error: String(callbackErr?.message || callbackErr),
  cat: 'pools'
});
```

**What to look for:**
- If you see this, there's a bug in the handle function that's crashing
- Should NEVER see this in normal operation

## How to Use This Logging

### Step 1: Enable Debug Logging
Set log level to debug in your environment or config to see all diagnostic logs.

### Step 2: Check Subscription Success
Look for 192 "pools.ws subscribe.success" entries for pumpswap (64 pools × 3):
```
[DEBUG] pools.ws subscribe.success {"account":"ABC123…","subscriptionId":12345}
```

### Step 3: Monitor Event Reception
Watch for "pools.ws event.received" entries. If none appear after 30 seconds:
- **Cause**: Pumpswap pools are genuinely inactive (no trades happening)
- **Solution**: This is normal for low-volume pools

### Step 4: Check Event Routing
For each event, verify:
- Vault events: `isDerived: true` → should process and return
- Pool events: `isDerived: false, isTargeted: true` → should route to decoder

### Step 5: Check Decode Success Rate
Compare counts:
- `pumpswap.decode.start` = attempts
- `pumpswap.ws.decode.success` = successes
- `pumpswap.ws.decode failed` = failures

**Success Rate = successes / attempts**

### Step 6: Diagnose Failures
If decode failures are happening, check the error messages:
- **"vault balances not in cache"**: Vault cache preload failed
- **"failed to parse pool pubkeys"**: Account data offsets are wrong
- **"account data too short"**: Not a valid pool account

## Expected Behavior

### Inactive Pools (Current Situation)
```
[DEBUG] pools.ws subscribe.success × 192  // Subscriptions established
[INFO] pools.ws subscriptions active
... silence for 22+ seconds ...
[WARN] pools.ws unhealthy {"idleMs":22000}  // No events = unhealthy
```

This is **EXPECTED** if pumpswap pools have no trading activity.

### Active Pools (With Trading)
```
[DEBUG] pools.ws subscribe.success × 192
[INFO] pools.ws subscriptions active
[DEBUG] pools.ws event.received {"account":"...","dataLength":400}  // Vault event
[DEBUG] pools.ws handle.entry {"isDerived":true}
[DEBUG] pools.ws vault.balance_cached
[DEBUG] pools.ws event.received {"account":"...","dataLength":500}  // Pool event
[DEBUG] pools.ws handle.entry {"isDerived":false,"isTargeted":true}
[DEBUG] pools.ws pumpswap.decode.start
[DEBUG] pumpswap.ws.decode.success {"price":0.00123}
[INFO] pools.ws healthy  // System stays healthy
```

## Next Steps

1. **Deploy with debug logging enabled**
2. **Watch for "event.received" logs**
   - If NONE: Pools are inactive (normal for low-volume)
   - If SOME: Check routing and decode success rate
3. **If decode failures**: Check error messages for root cause
4. **If successful decodes but still unhealthy**: Check `lastWsEventMs` updates

## Files Modified
- `backend/src/server/pools.ts`:
  - Line ~2771: Event reception logging
  - Line ~2796: Subscription success logging
  - Line ~1688: Handle entry logging
  - Line ~2457: Decode start logging
  - Line ~2581: Decode success logging
  - Line ~2609: Enhanced decode failure logging
  - Line ~2781: Callback error logging

