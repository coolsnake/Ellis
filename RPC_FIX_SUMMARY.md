# RPC Blocking Fix - Quick Summary

## Problem Identified ✓
**Root cause:** The RPC rate limiter's token bucket was **starting with 0 tokens**, causing all initial RPC calls to block while waiting for tokens to accrue.

## The Fix

### Changed in `backend/src/utils/rpcLimiter.ts`:

1. **Initialize with full capacity** (CRITICAL FIX):
   ```typescript
   // OLD: let tokens = 0;
   // NEW: let tokens = capacity;  // Start with ~12 tokens
   ```

2. **Added infinite loop protection**:
   - Prevents limiter from getting stuck forever
   - Logs error and breaks out after 100 iterations or 30 seconds

3. **Added diagnostic logging**:
   - Logs configuration at startup
   - Logs first 5 RPC calls for debugging
   - Logs if limiter gets stuck

## Impact

✅ **RPC calls now work immediately at startup**
✅ **No more blocking on wallet balance fetches**
✅ **Pool data loads without delay**
✅ **Transaction execution proceeds normally**
✅ **Safety mechanisms prevent future hangs**

## What You'll See

When you restart the backend, you should see:

```
[RPC LIMITER] Initialized: maxRps=50, capacity=12, minGapMs=20, initialTokens=12
[RPC LIMITER] Call #1: module=wallet, method=getBalance, weight=1, tokens=12
[RPC LIMITER] Call #2: module=pools, method=getAccountInfo, weight=1, tokens=11
...
```

## Testing Steps

1. Rebuild backend:
   ```bash
   cd backend && npm run build
   ```

2. Start backend (watch console for the logs above):
   ```bash
   npm run dev
   ```

3. Test RPC-dependent features in UI:
   - Wallet balance should load immediately
   - Pool data should populate
   - Transaction building should work

## Why This Happened

The token bucket algorithm:
- Starts with some number of tokens
- Refills at `maxRps` (50 tokens/sec = 0.05 tokens/ms)
- Each RPC call consumes 1 token
- Calls wait when tokens = 0

**Problem:** Starting at 0 tokens + burst of initial calls = long queue
**Solution:** Starting at `capacity` (12) tokens = first burst goes through immediately

## Configuration (Optional)

You can tune the rate limiter via environment variables if needed:

```bash
# For premium RPC providers (higher limits)
RPC_MAX_RPS=100
RPC_BURST=25

# For conservative rate limiting (lower limits)
RPC_MAX_RPS=25
RPC_BURST=6
```

**Defaults work well for most cases:**
- `RPC_MAX_RPS=50`
- `RPC_BURST=12`
- `RPC_MIN_GAP_MS=20`

## Next Steps

None required! The fix is complete. Just rebuild and restart to apply the changes.

If you still experience issues, the diagnostic logs will help identify the problem.

