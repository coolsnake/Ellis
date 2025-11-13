# Graph Build Optimization - Defer Until After Filtering

## Problem

The system was building graph snapshots before pool filtering was complete, resulting in:
- Huge initial snapshots with thousands of unfiltered pools
- Slow startup times
- Multiple redundant graph builds
- Cross-dex price validation running with incomplete data

### Root Cause

Individual DEX fetchers (`getRaydiumPoolsNormalized`, `getOrcaPoolsCached`, etc.) were calling `applyPoolUpdates` immediately after fetching pools, **before** the filtering phases in `refreshAllSources` had run:

```
1. DEX fetcher runs (e.g., Raydium)
2. DEX fetcher triggers graph update ❌ TOO EARLY
3. refreshAllSources fetches all DEXes
4. refreshAllSources applies filtering (universe, minPools, TVL)
5. refreshAllSources rebuilds graph ✓ CORRECT TIME
```

This meant the graph was built multiple times with progressively filtered pools, wasting CPU and memory.

## Solution

**Defer all graph updates until after filtering is complete:**

1. Added `__inProgress` flag to `refreshAllSources` to signal filtering is in progress
2. Modified all DEX fetchers to check this flag and skip incremental updates during refresh
3. Moved cross-dex price validation to run after all filtering (Phase 8)
4. Only build the graph once at the end with fully filtered pools

### Changes Made

#### 1. Added Flag Management in `refreshAllSources` (lines 913-915, 1539-1540)

```typescript
export async function refreshAllSources(...) {
  // Mark that we're in a refresh cycle
  (refreshAllSources as any).__inProgress = true;
  
  try {
    // ... all fetching and filtering phases ...
  } finally {
    // Clear flag when done
    (refreshAllSources as any).__inProgress = false;
  }
}
```

#### 2. Updated DEX Fetchers to Skip Incremental Updates During Refresh

Modified the following functions to check `__inProgress` flag before calling `applyPoolUpdates`:

- **getRaydiumPoolsNormalized** (lines 4983-4997)
- **getOrcaPoolsCached** (lines 5103-5117)
- **getMeteoraPoolsCached** (lines 5358-5372)
- **getMeteoraBalancedPoolsCached** (lines 4559-4581)
- **getPumpswapPoolsCached** (lines 4759-4773)

Example pattern applied to all:

```typescript
const skipIncremental = (refreshAllSources as any).__inProgress === true;
if (!skipIncremental) {
  try {
    const gmod: any = await import('./graph.js');
    if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
      void gmod.applyPoolUpdates(...).catch(...);
    }
  } catch {}
} else {
  try { logger.debug('graph.update.skipped_during_refresh', { source: 'xxx', reason: 'filtering_in_progress', cat: 'graph' }); } catch {}
}
```

#### 3. Moved Cross-DEX Validation to Phase 8 (lines 1399-1413)

Added validation after all filtering is complete, before graph rebuild:

```typescript
// === PHASE 8: CROSS-DEX VALIDATION ===
try {
  const { validateCrossDexPrices } = await import('./pools/validation.js');
  const allPools = {
    raydium: r,
    orca: o,
    meteora: m,
    meteora_balanced: mb,
    pumpswap: pump
  };
  validateCrossDexPrices(allPools);
} catch (e: any) {
  logger.warn('pools.refresh.phase.validation.failed', { error: String(e?.message || e), cat: 'pools' });
}
```

Removed old validation that ran during Raydium fetch (was line 5029-5038).

## Expected Impact

### Performance Improvements

1. **Faster Startup**: Only one graph build with filtered pools instead of multiple builds
2. **Reduced Memory**: Smaller initial snapshot (only filtered pools)
3. **Better Logging**: Clear indication when updates are skipped during filtering

### Behavior Changes

1. **During Refresh**: Individual DEX fetchers will skip graph updates and log `graph.update.skipped_during_refresh`
2. **After Refresh**: Normal incremental updates resume for real-time pool changes
3. **Cross-DEX Validation**: Now runs with complete filtered data from all DEXes

## Logging Changes

### New Debug Logs

- `graph.update.skipped_during_refresh` - Logged when a DEX fetcher skips graph update during refresh

### Log Sequence During Startup

```
[INFO] pools.refresh.start
[INFO] pools.refresh.phase.fetch
[INFO] raydium.fetch start
[DEBUG] graph.update.skipped_during_refresh {source: 'raydium', reason: 'filtering_in_progress'}
[INFO] orca.fetch start  
[DEBUG] graph.update.skipped_during_refresh {source: 'orca', reason: 'filtering_in_progress'}
... (all DEX fetchers skip graph updates)
[INFO] pools.refresh.phase.universe_filter
[INFO] pools.refresh.phase.min_pools_filter
[INFO] pools.refresh.phase.tvl_filter
[INFO] pools.refresh.phase.complete_all_filtering
[WARN] pools.crossdex.price.mismatch (with complete data from all DEXes)
[INFO] graph.snapshot built {nodes: X, edges: Y}  ← ONLY ONE BUILD
[INFO] pools.refresh.complete
```

## Testing

To verify the optimization:

1. Start the backend and watch for logs
2. Confirm `graph.update.skipped_during_refresh` appears for each DEX during initial refresh
3. Confirm only ONE `graph.snapshot built` log appears after filtering completes
4. Monitor startup time - should be significantly faster
5. Verify cross-dex validation warnings now have complete data from all DEXes

## Rollback

If issues arise, comment out the skip logic in each fetcher:

```typescript
const skipIncremental = false; // (refreshAllSources as any).__inProgress === true;
```

This will restore the old behavior of immediate graph updates.

