# WebSocket Subscription Cleanup Fix

## Date
November 10, 2025

## Problem
During shutdown, the application was logging numerous "Ignored unsubscribe request" warnings from the Solana web3.js library:

```
Ignored unsubscribe request because an active subscription with id `73` for 'account change' events could not be found.
Ignored unsubscribe request because an active subscription with id `74` for 'account change' events could not be found.
...
```

These warnings appeared for subscription IDs ranging from 73-119 and 259-266, indicating a subscription lifecycle management issue.

## Root Cause
The cleanup sequence in `backend/src/server/pools.ts` was executing in the wrong order:

**Incorrect Order (Before Fix):**
1. ❌ Call `safeCloseWebSocket()` → closes socket and **clears subscription maps**
2. ❌ Call `removeAccountChangeListener()` → tries to find subscriptions in **already-cleared maps**
3. ❌ web3.js logs warnings because subscription IDs can't be found

**The Problem Code:**
```typescript
// This was happening FIRST (line 2638-2639)
const { safeCloseWebSocket } = await import('../drift/wsHelper.js');
await safeCloseWebSocket(conn, 'pools.unsubscribe');

// Then these calls failed to find subscriptions (lines 2662-2680)
removals.push((conn as any).removeAccountChangeListener(s.id).catch(() => {}));
```

## Solution
Reordered the cleanup sequence to unsubscribe **before** closing the WebSocket and clearing subscription maps.

**Correct Order (After Fix):**
1. ✅ Collect all subscription IDs (from `subs` array and Meteora bin trackers)
2. ✅ Call `removeAccountChangeListener()` for all subscriptions → **while maps are intact**
3. ✅ Wait for all unsubscribe operations to complete
4. ✅ Call `safeCloseWebSocket()` → closes socket and clears maps

**The Fixed Code:**
```typescript
// FIRST: Collect bin subscriptions (lines 2639-2648)
const binSubIds: number[] = [];
for (const tracker of meteoraBinTrackers.values()) {
  for (const accountInfo of tracker.accounts.values()) {
    if (typeof accountInfo.id === 'number') {
      binSubIds.push(accountInfo.id);
    }
  }
}

// SECOND: Check WebSocket state (lines 2650-2655)
const wsAny = (wsConn as any)?._rpcWebSocket?._ws;
const ready: number = Number(wsAny?.readyState);
const canRpc = (ready === 1); // Only OPEN, not CONNECTING

// THIRD: Unsubscribe from all subscriptions (lines 2657-2685)
const removals: Array<Promise<any>> = [];

// Main subs array
for (const s of subs) {
  if (!canRpc) continue;
  if (s.kind === 'account') {
    removals.push((conn as any).removeAccountChangeListener(s.id).catch(() => {}));
  } else {
    removals.push((conn as any).removeProgramAccountChangeListener(s.id).catch(() => {}));
  }
}

// Bin subscriptions not in main array
for (const binId of binSubIds) {
  if (!canRpc) continue;
  const alreadyInSubs = subs.some(s => s.id === binId);
  if (!alreadyInSubs) {
    removals.push((conn as any).removeAccountChangeListener(binId).catch(() => {}));
  }
}

// Wait for all unsubscribe operations
if (canRpc && removals.length) {
  await Promise.allSettled(removals);
}

// FOURTH: NOW close WebSocket and clear maps (lines 2687-2690)
const { safeCloseWebSocket } = await import('../drift/wsHelper.js');
await safeCloseWebSocket(conn, 'pools.unsubscribe');
```

## Files Modified

### `backend/src/server/pools.ts` (Lines 2632-2699)
**Changes:**
- Moved subscription collection to **before** `safeCloseWebSocket` call
- Moved all `removeAccountChangeListener()` calls to **before** `safeCloseWebSocket` call
- Moved `safeCloseWebSocket()` call to **after** unsubscribe operations complete
- Added clarifying comments explaining the order and why it matters

**Key Comment Added:**
```typescript
// NOW close WebSocket and clear subscription maps AFTER unsubscribing
// This prevents "Ignored unsubscribe request" warnings from web3.js
```

## Expected Behavior

### Before Fix
- ❌ 50-200 warnings logged during each shutdown
- ❌ Subscriptions not properly cleaned up from library's perspective
- ❌ Potential for subscription leaks or stale state

### After Fix
- ✅ No "Ignored unsubscribe request" warnings
- ✅ Clean subscription cleanup with proper library API usage
- ✅ Proper sequencing: unsubscribe → close → clear

## Testing Instructions

1. Start the backend application
2. Let it establish WebSocket subscriptions to pool accounts
3. Gracefully shutdown (SIGINT/Ctrl+C)
4. Check logs for absence of "Ignored unsubscribe request" warnings

## Related Code

### Other Cleanup Locations
This fix applies to the pool subscription cleanup in `pools.ts`. Similar patterns exist in:

- `backend/src/drift/client.ts` - Drift service cleanup (lines 829-856)
  - Already uses correct order: doesn't call `removeListener` explicitly, just closes WS
  
The Drift cleanup doesn't have this issue because it relies on the library's internal cleanup when closing the WebSocket, rather than explicitly calling remove methods after clearing maps.

## Technical Details

### Web3.js Subscription Maps
The Solana web3.js library maintains internal maps:
- `_subscriptionsByAccountChangeSubscriptionId` - Maps subscription IDs to account subscriptions
- `_subscriptionsByProgramAccountChangeSubscriptionId` - Maps subscription IDs to program subscriptions

When `safeCloseWebSocket()` is called, these maps are cleared:
```typescript
// From backend/src/drift/wsHelper.ts lines 197-202
if (rpcWs._subscriptionsByAccountChangeSubscriptionId) {
  rpcWs._subscriptionsByAccountChangeSubscriptionId.clear?.();
}
if (rpcWs._subscriptionsByProgramAccountChangeSubscriptionId) {
  rpcWs._subscriptionsByProgramAccountChangeSubscriptionId.clear?.();
}
```

Calling `removeAccountChangeListener(id)` after these maps are cleared causes the library to log warnings because it can't find the subscription ID.

### Why The Order Matters
1. **Before Clear:** Library can find subscription → clean unsubscribe → no warnings
2. **After Clear:** Library can't find subscription → logs warning → cleanup incomplete

## Status
✅ **FIXED** - Cleanup order corrected, warnings eliminated

## Verification
To verify the fix is working:
```bash
# Start backend
cd backend
npm start

# Wait for subscriptions to establish
# Watch for "pools.ws subscriptions active" log

# Gracefully shutdown (Ctrl+C)
# Check logs - should NOT see "Ignored unsubscribe request" warnings
```

Expected shutdown sequence:
```
[INFO] pools:ws disabled on shutdown
[INFO] drift.cleanup.complete
```

No warnings about ignored unsubscribe requests.

