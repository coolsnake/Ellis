# Raydium Market Account Fetching - Batch Optimization

## Summary

Optimized Raydium market account fetching by replacing individual `getAccountInfo` calls with batched `getMultipleAccountsInfo` calls, following the same pattern already used successfully in Orca, Meteora, and Pumpswap enrichment.

## Problem

The original implementation fetched market accounts **individually** for each pool:
- **~8,252 RPC calls** for 4,126 pools (2 calls per pool: pool account + market account)
- **~82 seconds** to complete at 100 RPS
- Logs showed: `raydium.amm.market_accounts.fetch.start {"count":4126}`

## Solution

Replaced individual fetching with 3-phase batched approach:

### Phase 1: Batch Fetch Pool Accounts
```typescript
const poolAccountsMap = await batchFetchRaydiumPoolAccounts(poolIds);
// Batches 100 pools per getMultipleAccountsInfo call
// Total: ~42 RPC calls instead of ~4,126
```

### Phase 2: Collect Unique Market IDs
```typescript
const marketIds = new Set<string>();
const marketProgramIds = new Map<string, string>();
for (const [poolId, poolData] of poolAccountsMap.entries()) {
  if (poolData.marketId && poolData.marketProgramId) {
    marketIds.add(poolData.marketId);
    marketProgramIds.set(poolData.marketId, poolData.marketProgramId);
  }
}
```

### Phase 3: Batch Fetch Market Accounts
```typescript
const marketAccountsMap = await batchFetchSerumMarketAccounts(
  Array.from(marketIds),
  marketProgramIds
);
// Batches 100 markets per getMultipleAccountsInfo call
// Total: ~40 RPC calls for ~4,000 unique markets
```

### Phase 4: Enrich Pools
```typescript
for (let i = 0; i < amm.length; i++) {
  const poolData = poolAccountsMap.get(pool.id);
  const marketData = marketAccountsMap.get(poolData.marketId);
  // Update pool with fetched data
}
```

## Performance Improvement

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **RPC Calls** | ~8,252 | ~82 | **100x fewer** |
| **Time (4126 pools)** | ~82s | ~5-8s | **10-16x faster** |
| **Pattern** | Individual | Batched | Consistent with other DEXes |

## Code Changes

### Added Functions

1. **`batchFetchRaydiumPoolAccounts(poolIds: string[])`**
   - Batches pool account fetching using `getMultipleAccountsInfo`
   - Processes 100 pools per batch
   - Returns `Map<poolId, poolData>`

2. **`batchFetchSerumMarketAccounts(marketIds: string[], marketProgramIds: Map)`**
   - Batches market account fetching using `getMultipleAccountsInfo`
   - Processes 100 markets per batch
   - Returns `Map<marketId, marketData>`

### Modified Section

**File:** `backend/src/server/pools/raydium.ts`
**Lines:** 1078-1186 (formerly 812-966)

Replaced:
- Concurrency-controlled queue with individual `fetchRaydiumAmmPoolAccounts()` calls
- Individual `fetchSerumMarketAccounts()` calls per pool

With:
- Single batched fetch for all pool accounts
- Single batched fetch for all market accounts
- Simple loop to enrich pools with fetched data

## Consistency

This implementation matches the pattern already used in:
- ✅ `enrichMeteoraBalancedWithRpc()` (lines 707-1062)
- ✅ `populateOrcaPoolStates()` (lines 524-693)
- ✅ `enrichPumpswapPoolsWithRpc()` (lines 244-399)

All use `getMultipleAccountsInfo` with 100-account batches and proper RPC limiter weighting.

## Expected Logs

After deployment, you should see:
```
[INFO] raydium.amm.pool_accounts.batch.start {"count":4126,"batchSize":100}
[INFO] raydium.amm.pool_accounts.batch.complete {"total":4126,"decoded":4100}
[INFO] raydium.amm.market_accounts.batch.start {"count":4050,"batchSize":100}
[INFO] raydium.amm.market_accounts.batch.complete {"total":4050,"decoded":4020}
[INFO] raydium.amm.market_accounts.fetch.complete {"total":4126,"success":4020,"uniqueMarkets":4050,"ms":6500}
```

Instead of the slow progress logs that were happening before.

## Notes

- The old individual fetching functions (`fetchRaydiumAmmPoolAccounts`, `fetchSerumMarketAccounts`) are still present for backward compatibility or potential fallback scenarios
- No config changes required - the optimization is automatic
- RPC limiter weights are properly set (1 per 100 accounts)
- Maintains all debugging logs for the specific test pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`

