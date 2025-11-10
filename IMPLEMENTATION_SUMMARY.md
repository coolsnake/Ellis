# Sequential WebSocket Retarget - Implementation Summary

## What Was Implemented

Successfully implemented sequential WebSocket subscription during pool retarget to prevent RPC rate limiting errors.

## Problem Solved

**Before:** During "retarget WS" with many pools subscribed:
- All 3 DEX sources (Orca, Raydium, Meteora) resubscribed **simultaneously** at 10 pools/sec each
- Created sustained burst of 30+ RPC calls/sec for several seconds  
- Overwhelmed RPC limiter (50 RPS) causing:
  - 429 "Too Many Requests" errors
  - RPC limiter "STUCK" warnings with force-allow bypasses
  - Exponential retry backoff loops
  - Service disruption

**After:** Sequential resubscription with throttling:
- Cooldown period after unsubscribe (2s default)
- Orca subscribes first at 5 pools/sec
- Stagger delay (3s default)
- Raydium subscribes at 5 pools/sec  
- Stagger delay (3s default)
- Meteora subscribes at 5 pools/sec
- **Result:** Smooth 5 RPC/sec sustained load, well within limits

## Files Modified

### 1. `backend/src/server/pools.ts`

**Function: `retargetPoolWebsockets()`** (lines 494-580)
- Added cooldown period after unsubscribe
- Set sequential mode flag before starting subscriptions
- Extended wait time for sequential completion
- Enhanced logging for monitoring

**Sequential Mode Logic** (lines 2236-2242)
- Check for `__sequentialMode` flag
- Calculate stagger delay based on config

**Stagger Delays** (lines 2354-2364, 2471-2481)
- Added delays between Orca → Raydium and Raydium → Meteora
- Only active when in sequential mode

**Throttled Rates** (lines 2295-2309, 2389-2403, 2507-2521)
- Applied slower subscription rate during retarget
- Each DEX checks `isSequentialMode` and adjusts rate accordingly
- Defaults to half of normal rate

**Flag Cleanup** (lines 2815-2819)
- Clear sequential mode flag after setup completes
- Prevents affecting subsequent subscriptions

## Configuration Added

New environment variables (all optional with sensible defaults):

```bash
WS_RETARGET_COOLDOWN_MS=2000        # Cooldown after unsubscribe
WS_RETARGET_STAGGER_MS=3000         # Delay between DEX sources
WS_RETARGET_ATTACH_PER_SEC=5        # Pools/sec during retarget
WS_RETARGET_ATTACH_WAIT_MS=15000    # Wait for completion
```

## Documentation Created

1. **`WS_RETARGET_SEQUENTIAL_THROTTLING.md`**
   - Complete implementation details
   - Timing analysis (before/after)
   - Testing procedures
   - Logging reference

2. **`CONFIGURATION_WS_RETARGET.md`**
   - Environment variable guide
   - Configuration scenarios for different RPC limits
   - Tuning guidelines
   - Troubleshooting tips
   - Best practices

3. **`IMPLEMENTATION_SUMMARY.md`** (this file)
   - Quick reference for what changed
   - Files modified with line numbers
   - Testing instructions

## Testing Instructions

### 1. Build Backend

```bash
cd backend
npm run build
```

### 2. Update .env

Add configuration (or use defaults):

```bash
# Optional: customize throttling
WS_RETARGET_COOLDOWN_MS=2000
WS_RETARGET_STAGGER_MS=3000
WS_RETARGET_ATTACH_PER_SEC=5
WS_RETARGET_ATTACH_WAIT_MS=15000
```

### 3. Restart Backend

Restart your backend process to load the changes.

### 4. Verify Active Subscriptions

Check RPC Monitor dashboard to confirm pools are subscribed.

### 5. Trigger Retarget

```bash
curl -X POST http://localhost:3001/api/arb/pools/retarget
```

### 6. Monitor Logs

Watch for sequential subscription messages:

```bash
# Should see:
[INFO] pools:ws retarget.start - sequential resubscription with throttling
[INFO] pools.ws retarget.cooldown { ms: 2000 }
[INFO] pools.ws sequential.mode { enabled: true, staggerMs: 3000 }
[INFO] pools.ws dex.subscribe.start { dex: 'orca', sequential: true }
[INFO] pools.ws orca.loop.start { poolCount: 30, rateLimit: '5/sec', ... }
[INFO] pools.ws sequential.stagger { afterDex: 'orca', beforeDex: 'raydium', ... }
[INFO] pools.ws dex.subscribe.start { dex: 'raydium', sequential: true }
...
[INFO] pools.ws retarget.complete { attached: { orca: X, raydium: Y, meteora: Z } }
```

### 7. Check RPC Monitor

Verify during retarget:
- ✅ Available tokens stay above 10
- ✅ No "STUCK" messages
- ✅ No 429 errors
- ✅ Success rate > 95%
- ✅ Queue depth stays low

## Expected Behavior

### Timing (with defaults and ~100 pools)

```
Phase               Duration    Activity
------------------  ----------  ---------------------------------
Unsubscribe         instant     All pools unsubscribe
Cooldown            2s          RPC limiter refills
Orca subscribe      6s          30 pools @ 5/sec
Stagger delay       3s          Wait before next DEX
Raydium subscribe   8s          40 pools @ 5/sec
Stagger delay       3s          Wait before next DEX
Meteora subscribe   4s          20 pools @ 5/sec
Completion          instant     Final health check
------------------  ----------  ---------------------------------
Total               ~26s        Complete retarget
```

### RPC Metrics

- **Peak RPS:** 5-8 calls/sec (well under 50 RPS limit)
- **Token consumption:** Gradual, allows continuous refill
- **Queue depth:** Minimal (< 3)
- **Success rate:** > 99%

## Success Criteria

✅ **Must have:**
- No 429 "Too Many Requests" errors
- No RPC limiter "STUCK" messages
- All pools successfully resubscribed
- WebSocket health status remains healthy

✅ **Should have:**
- Retarget completes in 15-30 seconds
- RPC available tokens never drop below 5
- Logs show sequential subscription pattern
- Success rate stays above 95%

## Rollback Plan

If issues occur, you can temporarily disable the sequential throttling by:

1. **Remove or comment out the sequential mode flag:**

In `backend/src/server/pools.ts`, modify `retargetPoolWebsockets()`:

```typescript
// Comment out this line:
// (startPoolWebsocketsOnlyOnce as any).__sequentialMode = true;
```

2. **Rebuild and restart:**

```bash
cd backend
npm run build
# Restart backend
```

This reverts to the original parallel behavior (faster but may cause 429 errors).

## Future Enhancements

Potential improvements to consider:

1. **Adaptive rate limiting** - Adjust speed based on RPC limiter state
2. **Progress API** - Real-time retarget progress events
3. **Partial retarget** - Retarget only specific DEX sources
4. **Cancellation** - Abort retarget mid-process
5. **Health validation** - Verify pool data quality after retarget
6. **Metrics collection** - Track retarget duration, success rates over time

## Support

If you encounter issues:

1. Check logs for error messages
2. Review RPC Monitor metrics
3. Verify `.env` configuration
4. Consult `CONFIGURATION_WS_RETARGET.md` for tuning
5. Try more conservative settings (slower rates, longer delays)

## Status

✅ **Implementation Complete**
✅ **Documentation Complete**  
⏳ **Testing Required** - Needs real-world retarget test

---

**Implementation Date:** 2025-11-10
**Modified Files:** 1 (backend/src/server/pools.ts)
**Documentation Files:** 3 (this file + 2 guides)
**Configuration Variables:** 4 new optional vars


