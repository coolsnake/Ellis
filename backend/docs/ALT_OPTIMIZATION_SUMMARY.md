# ALT Optimization Summary

## Changes Implemented

### 1. Reverse Edge Filtering
**Problem**: The graph contains both forward (`-fwd`) and reverse (`-rev`) edges for each pool, effectively counting the same pool twice and wasting ALT capacity.

**Solution**: Added filtering to remove `-rev` edges **before** applying the `maxPools` limit:

```typescript
// Filter out reverse edges to avoid counting the same pool twice
const forwardEdgesOnly = filtered.filter(edge => {
  const poolId = String(edge.pool_id || '');
  return !poolId.endsWith('-rev');
});
```

This ensures we maximize unique pools in each ALT.

### 2. Increased Pool Limits
**Changes**:
- **Default maxPools**: 30 → **50**
- **Maximum maxPools cap**: 50 → **100**

**Files Updated**:
- `backend/src/server/routes/arb.ts`: Updated both `create-dex-alt` and `refresh-dex-alt` endpoints
- `frontend/src/components/AltManagementModal.tsx`: Updated default pool counts and UI validation

### 3. Enhanced Logging
**Added**: Detailed logging to show the filtering process:

```typescript
logger.info('alt.manager.collect.dex.filtered', {
  cat: 'tx',
  ctx: {
    dex,
    poolType,
    totalEdges: snapshot.edges.length,
    filteredByDex: filtered.length,
    afterRemovingRev: forwardEdgesOnly.length,
    revEdgesRemoved: filtered.length - forwardEdgesOnly.length,
  },
});
```

This helps track:
- Total edges in the graph
- Edges after DEX/pool type filtering
- Unique pools after removing reverse edges
- Number of duplicate reverse edges removed

### 4. Improved Deduplication
**Added**: Extra safety to handle edge cases where pool IDs might have variations:

```typescript
// Clean the pool ID to its base form (remove -fwd/-rev if present)
const cleanPoolId = String(edge.pool_id).replace(/-(rev|fwd)$/, '');
if (poolIds.has(cleanPoolId)) continue;
poolIds.add(cleanPoolId);
```

## Expected Impact

### Before Optimization
- **30 pools requested** → ~15 unique pools (due to rev/fwd duplication)
- **Wasted ALT space**: ~50% capacity used for duplicate accounts

### After Optimization
- **50 pools requested** → **50 unique pools** (duplicates filtered)
- **Maximum capacity**: Up to **100 unique pools** per ALT
- **Better ALT utilization**: Each slot contains unique pool accounts

## Testing

To test the improvements:

1. **Check logs** when creating/refreshing ALTs to see filtering stats
2. **Create ALT with 50 pools** (new default):
   ```bash
   curl -X POST http://localhost:3000/arb/alts/create-dex-alt \
     -H "Content-Type: application/json" \
     -d '{"dex": "raydium", "poolType": "both", "maxPools": 50}'
   ```

3. **Test maximum capacity** (100 pools):
   ```bash
   curl -X POST http://localhost:3000/arb/alts/create-dex-alt \
     -H "Content-Type: application/json" \
     -d '{"dex": "raydium", "poolType": "both", "maxPools": 100}'
   ```

4. **Verify ALT contents** using the UI or API to ensure all accounts are unique

## Benefits

1. ✅ **2x more unique pools** per ALT (previously limited by duplicate edges)
2. ✅ **Better transaction compression** with more relevant accounts
3. ✅ **Reduced transaction size** for multi-DEX arbitrage
4. ✅ **Flexible scaling** from 1-100 pools per DEX
5. ✅ **Better observability** with detailed filtering logs

## Files Modified

- `backend/src/execution/utils/altManager.ts`
  - Enhanced `collectDexPoolAccounts()` with rev-edge filtering
  - Added comprehensive logging
  
- `backend/src/server/routes/arb.ts`
  - Updated default: 30 → 50
  - Updated max cap: 50 → 100
  
- `frontend/src/components/AltManagementModal.tsx`
  - Updated default pool counts to 50
  - Updated UI validation range to 1-100

## Related Documentation

- [ALT Manager Guide](./ALT_MANAGER_GUIDE.md)
- [ALT Implementation Summary](./ALT_IMPLEMENTATION_SUMMARY.md)
- [ALT Deletion Guide](./ALT_DELETION_GUIDE.md)

