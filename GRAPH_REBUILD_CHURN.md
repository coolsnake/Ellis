# Graph Rebuild Churn Issue

## Problem

Even after fixing intra-cycle churn statistics, edges are still being continuously "added" but the graph size remains constant. 

## Observed Behavior

```
[INFO] graph.incremental.apply {"added":2,...}
[INFO] graph.snapshot built {"nodes":8,"edges":20}
[INFO] graph.incremental.apply {"added":4,...}  
[INFO] graph.snapshot built {"nodes":8,"edges":20}  // Same size!
```

## Root Cause: Inter-Cycle Churn

The system has **two conflicting graph update paths**:

### Path 1: Incremental Updates (Fast)
- WebSocket updates trigger `applyPoolUpdates()`
- Modifies graph in-memory using diffs
- Adds edges based on pool changes

### Path 2: Full Rebuilds (Slow, Authoritative)
- Various triggers call `getGraphSnapshot(true)`
- Rebuilds entire graph from pool caches
- Re-applies all validation and filters
- **Drops edges that fail validation**

## The Churn Cycle

```
Time 0: Graph has 20 edges (validated)
Time 1: Incremental update adds 2 edges → 22 edges in memory
Time 2: Rebuild triggered (force=true)
Time 3: Rebuild applies validation → 2 edges fail → back to 20 edges
Time 4: Same incremental update adds same 2 edges again → 22 edges
Time 5: Another rebuild → 20 edges
... cycle repeats infinitely
```

## Why Edges Fail Validation on Rebuild

From the logs:
```
"meteora": {
  "decoded": 635,
  "applied": 120,  
  "skipped": 515,  // 81% skipped!
  "skipReasons": {
    "bin_hash_aggregate_unchanged": 414
  }
}
```

Possible reasons edges added by incremental updates get dropped on rebuild:
1. **Price calculation fails** - Overflow/underflow issues (partially fixed)
2. **Missing decimals** - Token metadata not available during rebuild
3. **Validation stricter on rebuild** - Sanity checks that don't run incrementally
4. **Pool not in cache** - Temporary cache misses
5. **Edge allowlist** - Different filtering rules

## Rebuild Triggers

Sources calling `getGraphSnapshot(true)`:
- `pools.ts:4137` - Raydium updates
- `routes/arb.ts:650` - Arb route handlers
- `routes/pools.ts:234` - Pools route handlers
- `index.ts:186` - Server initialization

## Solution Needed

1. **Reduce rebuild frequency** - Only rebuild on explicit user requests or config changes
2. **Incremental updates should be authoritative** - Don't overwrite with rebuilds
3. **Harmonize validation** - Apply same validation rules in both paths
4. **Log rebuild triggers** - Added diagnostic logging to identify who's calling rebuilds

## Next Steps

1. Run with diagnostic logging to see what's triggering rebuilds every 1-3 seconds
2. Consider disabling automatic rebuilds during active trading
3. Make incremental path apply same validation as rebuild path
4. Add circuit breaker to prevent rebuild storms

