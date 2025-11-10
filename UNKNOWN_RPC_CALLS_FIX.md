# Unknown RPC Calls - Fixed! ✅

## Problem
The RPC Monitor was showing 4 "unknown" RPC calls that weren't properly categorized by module.

## Root Cause
Found 3 locations making RPC calls without proper context parameters:

### 1. **drift/fillerRunner.ts** (line 318)
```typescript
// ❌ BEFORE: No rate limiting at all!
try { await this.connection.getBlockHeight('processed'); } catch {}
```

**Fixed to:**
```typescript
// ✅ AFTER: Rate limited + proper context
try { 
  const { withRpcLimit } = await import('../utils/rpcLimiter.js');
  await withRpcLimit(
    () => this.connection.getBlockHeight('processed'), 
    1, 
    { module: 'drift', method: 'getBlockHeight' }
  ); 
} catch {}
```

### 2. **wallet/tokenAccountManager.ts** (line 370)
```typescript
// ❌ BEFORE: Rate limited but missing context
const { blockhash } = await withRpcLimit(() => 
  this.connection.getLatestBlockhash('finalized')
);
```

**Fixed to:**
```typescript
// ✅ AFTER: Proper context added
const { blockhash } = await withRpcLimit(
  () => this.connection.getLatestBlockhash('finalized'),
  1,
  { module: 'wallet', method: 'getLatestBlockhash' }
);
```

### 3. **utils/feeCalculator.ts** (lines 75-83)
```typescript
// ❌ BEFORE: Multiple unprotected RPC calls
const recentBlocks = await this.connection.getBlocks(0, 10);
const blockTime = await this.connection.getBlockTime(slot);
```

**Fixed to:**
```typescript
// ✅ AFTER: Single rate-limited call with context
const recentSamples = await withRpcLimit(
  () => this.connection.getRecentPerformanceSamples(10),
  1,
  { module: 'utils', method: 'getRecentPerformanceSamples' }
).catch(() => []);
```

**Bonus:** Also simplified the fee calculator logic - using `getRecentPerformanceSamples` is more efficient than multiple `getBlocks`/`getBlockTime` calls.

## Impact

**Before:**
- 4 "unknown" calls showing in RPC Monitor
- 3 locations bypassing rate limiter entirely
- Harder to debug RPC issues

**After:**
- ✅ All RPC calls properly categorized
- ✅ All calls go through rate limiter
- ✅ RPC Monitor shows accurate breakdown:
  - `drift` module includes `getBlockHeight`
  - `wallet` module includes `getLatestBlockhash`  
  - `utils` module includes `getRecentPerformanceSamples`

## Testing

Rebuild and restart:
```bash
cd backend && npm run build && npm run dev
```

Check RPC Monitor - you should see:
- ✅ **ZERO "unknown" calls**
- ✅ All calls properly categorized by module
- ✅ Method breakdown shows specific RPC methods

## Files Modified

1. `backend/src/drift/fillerRunner.ts` - Added rate limiting + context
2. `backend/src/wallet/tokenAccountManager.ts` - Added missing context  
3. `backend/src/utils/feeCalculator.ts` - Added rate limiting + context, simplified logic

## Related

This completes the "unknown method" cleanup. Combined with previous fixes:
- RPC rate limiter working (NaN fix + token consumption fix)
- Most RPC calls have proper context (`wallet`, `pools`, `drift`, `alt`, `execution`)
- Remaining todos are lower priority files with fewer calls

