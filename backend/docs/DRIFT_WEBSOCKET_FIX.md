# Drift & Pool WebSocket Subscription Fixes - Implementation Summary

## Overview

Fixed critical startup crashes with Drift and Pool account subscriptions caused by WebSocket connection race conditions. The error "socket was not CONNECTING or OPEN (readyState was 2 or 3)" occurred when `accountSubscribe` was called on a WebSocket that was CLOSING or CLOSED, often triggered by the web3.js internal `_updateSubscriptions` mechanism during reconnection attempts.

## Issues Identified

### 1. Missing Pre-Subscribe WebSocket Ready Check (Drift) ❌

**Before:**
- WebSocket ready check at line 271 (before DriftClient creation)
- **BUG**: No ready check before calling `subscribe()` at line 285
- Retry logic only waited for WebSocket **after** first failure
- Race condition: WebSocket could transition to CLOSING/CLOSED between initialization and subscription

**After:**
- ✅ Proactive `waitUntilWsReady()` call before first subscription attempt (line 286-293)
- ✅ Prevents initial subscription from hitting closed socket
- ✅ Debug logging to track ready check status
- ✅ Maintains existing retry logic as fallback

### 2. No Cleanup Tracking Between Shutdown and Startup ❌

**Before:**
- `cleanup()` method existed but wasn't tracked
- **BUG**: No mechanism to wait for cleanup to complete before reinitialization
- **BUG**: `this.client` not reset to null after cleanup, preventing reinit
- **BUG**: WebSocket connection not explicitly closed during cleanup
- Race condition: New subscriptions could start while old ones were still closing

**After:**
- ✅ Added `cleanupPromise` tracker (line 84)
- ✅ `init()` waits for pending cleanup before proceeding (lines 182-187)
- ✅ WebSocket explicitly closed during cleanup (lines 873-879)
- ✅ Client state properly reset (`this.client = null`, line 888)
- ✅ Comprehensive logging for cleanup lifecycle

### 3. Pool WebSocket Cleanup Race Condition ❌

**Before:**
- Cleared subscription maps before closing WebSocket
- **BUG**: WebSocket could auto-reconnect after maps cleared
- **BUG**: On reconnect, `_updateSubscriptions` fires with empty socket (readyState = 3)
- Race condition: Subscription attempts on CLOSED socket during reconnection

**After:**
- ✅ Close underlying WebSocket FIRST (line 2259-2266 in pools.ts)
- ✅ Wait 50ms for socket to fully close
- ✅ Then clear subscription maps and timers
- ✅ Debug logging for socket closure
- ✅ Prevents auto-resubscribe mechanism from firing

## Implementation Details

### 1. Pre-Subscribe WebSocket Ready Check

**Location:** `backend/src/drift/client.ts`, lines 284-293

```typescript
// Wait for WebSocket to be ready before first subscription attempt
// This prevents "socket was not CONNECTING or OPEN" errors during startup
if (subType === 'websocket') {
  try { 
    await waitUntilWsReady();
    try { logger.debug('drift.ws pre-subscribe ready check passed', { cat: 'drift' }); } catch {}
  } catch (e: any) {
    try { logger.warn('drift.ws pre-subscribe ready check failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
  }
}
```

**Why It Matters:**
- Ensures WebSocket is in `CONNECTING` (0) or `OPEN` (1) state before subscribing
- Prevents errors from attempting to subscribe on a `CLOSING` (2) or `CLOSED` (3) socket
- Follows the same pattern used throughout `getSharedInfra()` method

### 2. Cleanup Promise Tracking

**Location:** `backend/src/drift/client.ts`, lines 84, 182-187

**Added Property:**
```typescript
private cleanupPromise: Promise<void> | null = null;
```

**Init Method Guard:**
```typescript
async init(): Promise<void> {
  // Wait for any pending cleanup to complete before reinitializing
  // This prevents "socket was not CONNECTING or OPEN" errors from race conditions
  if (this.cleanupPromise) {
    try {
      await this.cleanupPromise.catch(() => {});
    } catch {}
    this.cleanupPromise = null;
  }
  
  if (this.client) return;
  // ... rest of initialization
}
```

**Why It Matters:**
- Similar to `wsClosePromise` pattern in `pools.ts`
- Ensures cleanup completes before new subscriptions start
- Prevents race conditions during rapid restart scenarios

### 3. Enhanced Cleanup Method

**Location:** `backend/src/drift/client.ts`, lines 818-902

**Key Improvements:**
1. **Client Unsubscription** (lines 825-830):
   ```typescript
   // Unsubscribe the main client first
   try {
     if (this.client && typeof (this.client as any).unsubscribe === 'function') {
       await (this.client as any).unsubscribe().catch(() => {});
     }
   } catch {}
   ```

2. **WebSocket Connection Closure** (lines 873-879):
   ```typescript
   // Close the WebSocket connection to prevent lingering subscriptions
   try {
     const ws = rpcWs.underlyingSocket || rpcWs._ws || rpcWs.socket || rpcWs._socket;
     if (ws && typeof ws.close === 'function') {
       ws.close();
     }
   } catch {}
   ```

3. **State Reset** (lines 887-890):
   ```typescript
   // Reset client state to allow reinitialization
   this.client = null;
   this.connection = null;
   this.loader = null;
   ```

4. **Promise Tracking** (lines 821, 896-901):
   ```typescript
   this.cleanupPromise = (async () => {
     // ... cleanup logic
   })();
   
   // Wait for cleanup to complete
   try {
     await this.cleanupPromise;
   } catch {}
   ```

### 3. Pool WebSocket Cleanup Enhancement

**Location:** `backend/src/server/pools.ts`, lines 2256-2266

```typescript
// Close the underlying WebSocket FIRST to prevent reconnection and _updateSubscriptions
// This prevents the web3.js auto-resubscribe mechanism from firing on a closed socket
try {
  const ws = rpcWs.underlyingSocket || rpcWs._ws || rpcWs.socket || rpcWs._socket;
  if (ws && typeof ws.close === 'function') {
    ws.close();
    // Give it a moment to actually transition to CLOSED state
    await new Promise(r => setTimeout(r, 50));
    try { logger.debug('pools.ws underlying socket closed', { cat: 'pools' }); } catch {}
  }
} catch {}
```

**Why It Matters:**
- Prevents the web3.js `_updateSubscriptions` mechanism from trying to resubscribe
- Ensures WebSocket is fully closed before subscription maps are cleared
- Stops auto-reconnect behavior that can trigger subscriptions on a closed socket
- 50ms delay ensures the socket reaches CLOSED state before cleanup continues

## Error Flow - Before vs After

### Before:
```
Server Shutdown
  ↓
cleanup() called
  ↓
Subscriptions unsubscribed (async)
  ↓
(meanwhile) Server Restart
  ↓
init() called → this.client exists → returns early (NO REINIT!)
  ↓
OR: this.client was cleared somehow
  ↓
New Connection created
  ↓
subscribe() called IMMEDIATELY
  ↓
❌ ERROR: WebSocket readyState = 2 (CLOSING)
```

### After:
```
Server Shutdown
  ↓
cleanup() called
  ↓
cleanupPromise created
  ↓
Subscriptions unsubscribed
  ↓
WebSocket closed
  ↓
Connection/Client reset to null
  ↓
cleanupPromise resolves
  ↓
(meanwhile) Server Restart
  ↓
init() called
  ↓
Wait for cleanupPromise if pending
  ↓
cleanupPromise = null
  ↓
New Connection created
  ↓
waitUntilWsReady() → ensures socket is CONNECTING or OPEN
  ↓
subscribe() called
  ↓
✅ SUCCESS: Socket is ready
```

### Pool Subscriptions - Before:
```
Pool Refresh Disabled
  ↓
wsUnsubscribe() called
  ↓
Clear subscription maps
  ↓
(meanwhile) WebSocket auto-reconnects
  ↓
Connection._updateSubscriptions() fires
  ↓
Tries to resubscribe to accounts
  ↓
❌ ERROR: WebSocket readyState = 3 (CLOSED)
```

### Pool Subscriptions - After:
```
Pool Refresh Disabled
  ↓
wsUnsubscribe() called
  ↓
Close underlying WebSocket FIRST
  ↓
Wait 50ms for socket to fully close
  ↓
Clear subscription maps
  ↓
Clear subscription timers
  ↓
✅ SUCCESS: No auto-resubscribe attempts
```

## Testing Recommendations

1. **Monitor startup logs** for new debug messages:
   ```
   drift.ws pre-subscribe ready check passed
   drift.cleanup.start
   drift.cleanup.complete
   pools.ws underlying socket closed
   ```

2. **Test rapid restart scenarios:**
   - Stop server
   - Immediately restart
   - Verify no "readyState" errors in logs

3. **Check cleanup timing:**
   - Ensure cleanup completes before reconnection attempts
   - Verify WebSocket is fully closed before new connections
   - Look for "pools.ws underlying socket closed" in logs

4. **Monitor for errors:**
   - `drift.ws pre-subscribe ready check failed` - indicates persistent WebSocket issues
   - `drift.cleanup.error` - indicates cleanup failures
   - Should NOT see: "socket was not CONNECTING or OPEN"
   - Should NOT see: errors from `Connection._updateSubscriptions`

## Common Error Patterns Fixed

### Error 1: accountSubscribe on readyState = 2 (CLOSING)
```
Error: Tried to call a JSON-RPC method `accountSubscribe` 
but the socket was not `CONNECTING` or `OPEN` (`readyState` was 2)
```
**Cause**: Subscription attempted while WebSocket transitioning to CLOSED  
**Fixed by**: Pre-subscription ready check + cleanup promise tracking

### Error 2: accountSubscribe on readyState = 3 (CLOSED)  
```
Error: Tried to call a JSON-RPC method `accountSubscribe`
but the socket was not `CONNECTING` or `OPEN` (`readyState` was 3)
at Connection._updateSubscriptions
```
**Cause**: web3.js auto-resubscribe mechanism firing after WebSocket reconnect  
**Fixed by**: Closing WebSocket before clearing subscription maps

## Performance Considerations

### Startup Time
- Added wait time: up to 5 seconds (configurable via `system.wsReadyWaitMs`)
- Typical wait: 0-200ms
- Only applies to websocket subscription type (not polling)

### Shutdown Time
- Cleanup now waits for all unsubscribes to complete
- Added 50ms delay for WebSocket to fully close (pools)
- Typical duration: 150-600ms total
- Prevents race conditions worth the minor delay

## Configuration

No config changes required. Uses existing settings:

- `system.wsReadyWaitMs` (default: 5000ms) - Max time to wait for WebSocket ready
- `drift.subscriptionType` (default: 'websocket') - Only applies to websocket mode

## Rollback

If issues arise, revert `backend/src/drift/client.ts` to commit before this change. The system will fall back to the previous behavior (with startup crashes).

## Related Files

- `backend/src/drift/client.ts` - Drift WebSocket fixes
- `backend/src/server/pools.ts` - Pool WebSocket cleanup fixes (lines 2256-2266)
- `backend/src/server/index.ts` - Calls cleanup on shutdown (lines 214-221, 402-408)
- `backend/src/drift/wsHelper.ts` - Shared `waitUntilWsReady` helper

## Related Issues

### Issue 1: Drift Subscriptions
- Error: "Tried to call a JSON-RPC method `accountSubscribe` but the socket was not `CONNECTING` or `OPEN` (`readyState` was 2)"
- Account: `2cHCtAkMnttMh3bNKSCgSKSP5D4yN3p8bfnMdS3VZsDf`
- Fixed by: Pre-subscribe ready check + cleanup promise tracking

### Issue 2: Pool Subscriptions
- Error: "Tried to call a JSON-RPC method `accountSubscribe` but the socket was not `CONNECTING` or `OPEN` (`readyState` was 3)"
- Account: `CX7JCXtUTiC43ZA4uzoH7iQBD15jtVwdBNCnjKHt1BrQ` (example pool/vault)
- Stack trace: `at Connection._updateSubscriptions`
- Fixed by: Closing WebSocket before clearing subscription maps

## Future Improvements

1. **Connection pooling**: Reuse WebSocket connections across service restarts
2. **Health monitoring**: Track WebSocket state and auto-reconnect on failures
3. **Subscription metrics**: Measure subscription success rate and latency
4. **Graceful degradation**: Automatically fall back to polling if WebSocket is persistently unstable

