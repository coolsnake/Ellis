# DEX Integration Sequencing Refactor

## Overview

This document describes the refactoring of DEX pool fetching, filtering, enrichment, and subscription operations to ensure proper sequencing and eliminate concurrent execution issues.

## Problem

Previously, DEX operations were not properly sequenced:
- Universe filtering happened independently in each `getDexPoolsCached` function (early, per-DEX)
- TVL filtering happened in `graph.ts` (late, during graph build)
- Minimum pools filtering only happened in `graph.ts`
- No explicit sequencing between fetch, filter, enrich, and subscribe operations
- Filtering logic was duplicated across multiple locations

## Solution

Centralized all filtering logic in `refreshAllSources()` with explicit sequential phases:

### Phase-Based Sequencing

```
PHASE 1: FETCH ALL DEXES IN SEQUENCE
├── Raydium (with skipUniverseFilter: true)
├── Orca (with skipUniverseFilter: true)
├── Meteora (with skipUniverseFilter: true)
├── MeteoraBalanced (with skipUniverseFilter: true)
└── Pumpswap

PHASE 2: FILTER BY UNIVERSE (across all DEXes)
├── Compute token universe once
├── Apply filterPoolsByUniverse to all DEXes
└── Log before/after counts

PHASE 3: FILTER BY MINIMUM POOLS PER PAIR (first pass)
├── Count pools per pair across ALL DEXes
├── Filter out pairs with < minPoolsPerPair
└── Log before/after counts

PHASE 4: ENRICH ALL DEXES IN SEQUENCE
└── (Currently embedded in normalizers)

PHASE 5: FILTER BY TVL/LIQUIDITY
├── Apply minAmmLiqBase threshold
├── Apply minClmmLiquidity threshold
└── Log before/after counts

PHASE 6: FILTER BY MINIMUM POOLS PER PAIR (second pass)
├── Re-count pools per pair after TVL filtering
├── Filter again to ensure pairs still meet threshold
└── Log before/after counts

PHASE 7: SUBSCRIBE TO RETAINED POOLS PER DEX IN SEQUENCE
├── Wait for WS cleanup if needed
├── Enable WebSocket refreshes
├── Start Raydium refresh loop (triggers sequential subscription)
└── Log subscription progress
```

## Key Changes

### 1. Function Signature Updates

All DEX pool fetching functions now accept an optional `opts` parameter:

```typescript
export async function getRaydiumPoolsNormalized(
  force = false, 
  opts?: { skipUniverseFilter?: boolean }
): Promise<PoolsPayload>

export async function getOrcaPoolsCached(
  force = false, 
  opts?: { skipUniverseFilter?: boolean }
): Promise<PoolsPayload>

export async function getMeteoraPoolsCached(
  force = false, 
  opts?: { skipUniverseFilter?: boolean }
): Promise<PoolsPayload>

export async function getMeteoraBalancedPoolsCached(
  force = false, 
  opts?: { skipUniverseFilter?: boolean }
): Promise<PoolsPayload>
```

### 2. Centralized Filtering in `refreshAllSources()`

All filtering logic moved from individual functions and `graph.ts` to `refreshAllSources()`:

- **Universe filtering**: Moved from individual `getDexPoolsCached` functions
- **TVL filtering**: Moved from `graph.ts` 
- **Minimum pools filtering**: Moved from `graph.ts` (now runs twice: before and after TVL filtering)

### 3. Graph.ts Simplification

`graph.ts` now uses pre-filtered pools from caches without re-filtering:

```typescript
// OLD: Re-filtering in graph.ts
const ray = filterPoolsByUniverse(rayRaw, universe, ...)
const ray = filterByTVL(ray, ...)
const ray = filterByMinPools(ray, ...)

// NEW: Use pre-filtered pools directly
let ray = rayRaw; // Already filtered by refreshAllSources
```

### 4. Cache Updates

Filtered results are written back to caches after all filtering completes:

```typescript
raydiumCache.data = r;
raydiumCache.ts = Date.now();
orcaCache.data = o;
orcaCache.ts = Date.now();
// ... etc
```

## Benefits

1. **Deterministic Sequencing**: Operations now happen in a predictable order
2. **No Duplicate Filtering**: Each filter runs once, in the right place
3. **Better Logging**: Detailed phase-by-phase logging shows exactly what's happening
4. **Proper Minimum Pools Logic**: Filter runs twice (before and after TVL filtering) to ensure pairs always meet threshold
5. **Sequential Subscriptions**: WebSocket subscriptions happen after all filtering, using only retained pools
6. **Cache Consistency**: All consumers (graph, execution, UI) see the same filtered results

## Configuration

The sequencing respects all existing configuration options:

- `CONFIG.system.scopePools`: Enable/disable universe filtering
- `CONFIG.system.scopePoolsMode`: Universe mode ('jupiter', 'none', etc.)
- `CONFIG.system.minPoolsPerPair`: Minimum pools required per token pair
- `CONFIG.system.minAmmLiqBase`: Minimum TVL for AMM pools
- `CONFIG.system.minClmmLiquidity`: Minimum liquidity for CLMM pools
- `CONFIG.system.enableAnchorBridging`: Allow bridging via anchor tokens

## Logging

Each phase logs detailed metrics:

```
pools.refresh.phase.fetch.complete: { counts: { raydium: {...}, orca: {...}, ... } }
pools.refresh.phase.universe_filter.complete: { mode, before, after }
pools.refresh.phase.min_pools_filter.complete: { minPools, before, after }
pools.refresh.phase.tvl_filter.complete: { minAmm, minClmm, before, after }
pools.refresh.phase.min_pools_filter_2nd.complete: { minPools, before, after }
pools.refresh.phase.subscribe.complete
pools.refresh.phase.complete_all_filtering: { finalCounts }
```

## Testing

To verify the refactoring:

1. **Check sequencing**: Look for phase logs in order during refresh
2. **Verify filtering**: Compare before/after counts in logs
3. **Test subscriptions**: Ensure WS subscriptions attach only to retained pools
4. **Check graph**: Verify graph uses filtered pools without re-filtering

## Migration Notes

- **Backward Compatible**: All existing code continues to work
- **Optional Parameter**: `skipUniverseFilter` is optional, defaults to `false`
- **Cache Behavior**: Caches now store post-filtered results
- **Graph Build**: Graph builds use pre-filtered pools from caches

## Future Improvements

1. Make enrichment explicit in Phase 4 (currently embedded in normalizers)
2. Add filtering metrics to `/arb/pools/metrics` endpoint
3. Expose phase timings for performance monitoring
4. Add circuit breakers if filtering removes too many pools


