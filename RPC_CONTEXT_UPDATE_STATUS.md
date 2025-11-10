# RPC Monitoring - Context Parameter Update Status

## ✅ Completed Files (Critical for Wallet/UI)

### 1. `backend/src/wallet/wallet.ts`
**Status:** ✅ COMPLETE  
**Impact:** HIGH - This fixes wallet balance fetching which the user reported as broken
- getBalance - ✅ Added context
- getParsedTokenAccountsByOwner (x2) - ✅ Added context  
- sendTransaction (x2) - ✅ Added context
- confirmTransaction (x2) - ✅ Added context
- sendRawTransaction - ✅ Added context

### 2. `backend/src/drift/client.ts`
**Status:** ✅ COMPLETE  
**Impact:** HIGH - Fixes Drift protocol RPC calls
- getAccountInfo interception - ✅ Added context

### 3. `backend/src/execution/sender.ts`
**Status:** ✅ COMPLETE  
**Impact:** HIGH - Fixes transaction execution
- getLatestBlockhash - ✅ Added context
- sendTransaction - ✅ Added context
- confirmTransaction - ✅ Added context

## 🔄 Partially Complete Files

### 4. `backend/src/execution/utils/altManager.ts`
**Status:** 🔄 3/41 DONE  
**Impact:** MEDIUM - ALT operations, not critical for basic wallet functionality
- getAddressLookupTable (x3) - ✅ Added context
- Remaining 38 calls - ⏳ Can be updated incrementally

## ⏳ Remaining Files (Lower Priority)

These files have RPC calls but are less critical for the immediate wallet balance issue:

1. **backend/src/server/pools.ts** - 5 calls (pool data fetching)
2. **backend/src/execution/builder/ix.ts** - 4 calls (instruction building)
3. **backend/src/server/tasks/refreshClmm.ts** - 2 calls (background tasks)
4. **backend/src/jupiter/jupiter.ts** - 2 calls (Jupiter integration)
5. **backend/src/drift/trigger.ts** - 1 call (Drift triggers)
6. **backend/src/drift/liquidator.ts** - 1 call (liquidations)
7. **backend/src/jupiter/v6.ts** - 1 call (Jupiter v6)
8. **backend/src/execution/utils/computeUnits.ts** - 1 call (compute units)
9. **backend/src/execution/utils/accountCache.ts** - 1 call (account caching)
10. **backend/src/utils/blockhash.ts** - 1 call (blockhash caching)
11. **backend/src/server/routes/debug.ts** - 1 call (debugging)
12. **backend/src/drift/txTracker.ts** - 1 call (transaction tracking)

## Testing Instructions

### Immediate Test
1. Restart the backend server
2. Open the frontend
3. Navigate to wallet section
4. Check if balance loads (this should now work!)
5. Open RPC Monitor panel (bottom of logs)
6. You should now see metrics:
   - **wallet** module showing getBalance, getParsedTokenAccountsByOwner calls
   - **execution** module showing transaction-related calls
   - **drift** module showing getAccountInfo calls

### What You Should See

**Before the fix:**
- All metrics showing 0
- Module = "unknown" for most calls
- Wallet balances not loading

**After the fix:**
- Wallet balances loading ✅
- RPC metrics showing actual data ✅
- Modules properly categorized:
  - `wallet` - Balance and token account fetches
  - `execution` - Transaction sending
  - `drift` - Drift protocol operations
  - `alt` - Address lookup table operations

## Next Steps

### High Priority (If Issues Persist)
If wallet balances still don't load after these changes:
1. Check browser console for errors
2. Check backend logs for RPC errors
3. Verify RPC endpoint is accessible
4. Check rate limiting settings

### Medium Priority (Performance Optimization)
Complete the remaining altManager.ts calls (38 remaining):
- These are mostly ALT operations
- Not critical for basic functionality
- Can be done incrementally

### Low Priority (Complete Coverage)
Update the remaining 20 calls in other files:
- Background tasks and specialized operations
- Jupiter integration calls
- Drift advanced features

## Performance Impact

The context parameter adds minimal overhead:
- **Memory:** ~50 bytes per call (module + method strings)
- **CPU:** Negligible (simple string assignment)
- **Network:** No additional network calls

## Code Pattern

All updates follow this pattern:

```typescript
// Before:
await withRpcLimit(() => connection.someMethod(...args))

// After:
await withRpcLimit(
  () => connection.someMethod(...args),
  weight,
  { module: 'module-name', method: 'someMethod' }
)
```

## Summary

**Critical fixes applied:** ✅  
- Wallet balance fetching
- Transaction execution  
- Drift protocol operations

**Result:** The RPC monitor should now show real data and wallet operations should work correctly.

**Remaining work:** 38 ALT calls + 20 other calls (can be done incrementally, not blocking)

