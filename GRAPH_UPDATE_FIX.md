# Graph Update Fix - Proper Incremental Application for WebSocket Pool Updates

## Issues Discovered

From the logs, two critical bugs were identified:

1. **Graph removing instead of updating**: `"removed":132,"nodes_rem":61` 
2. **No graph updates for decoded pumpswap pools**: 22 pool updates applied but no corresponding graph incremental updates

## Root Cause

Both **pumpswap** and **meteora_balanced** WebSocket decoders had the same critical bug when applying pool updates to the graph:

### Bug 1: Wrong Function Call (Line 2603, 2754)
```typescript
// WRONG - calling wrong scheduler with wrong data
await scheduleDexApply('raydium', prev as any); // Reuse raydium scheduler for now
```

**Problems:**
1. Calling `scheduleDexApply` (deprecated/wrong function)
2. Passing 'raydium' as the source (should be 'pumpswap' or 'meteora_balanced')
3. Passing `prev` (old data) instead of both prev and next
4. Using `await` (blocks WebSocket handler)

### Bug 2: Wrong Data
The function was receiving the old pool state (`prev`) instead of the proper `(prev, next)` pair needed for incremental graph updates.

## The Fix

Changed both decoders to use the correct `applyPoolUpdates` function with proper parameters:

### Pumpswap Fix (Line 2600-2616)
```typescript
// CORRECT - proper incremental update
try {
  const gmod: any = await import('./graph.js');
  if (typeof gmod.applyPoolUpdates === 'function') {
    // Fire-and-forget: don't await to avoid blocking WebSocket handler
    void gmod.applyPoolUpdates(prev, next, { pushToArb: true }).catch((err: any) => {
      try { 
        logger.warn('graph.update.fire_forget_failed', { 
          error: String(err?.message || err), 
          source: 'pumpswap',  // ← Correct source
          pool: pk58.slice(0,8) + '…',
          cat: 'graph' 
        }); 
      } catch {}
    });
  }
} catch {}
```

### Meteora Balanced Fix (Line 2751-2767)
```typescript
// CORRECT - proper incremental update
try {
  const gmod: any = await import('./graph.js');
  if (typeof gmod.applyPoolUpdates === 'function') {
    // Fire-and-forget: don't await to avoid blocking WebSocket handler
    void gmod.applyPoolUpdates(prev, next, { pushToArb: true }).catch((err: any) => {
      try { 
        logger.warn('graph.update.fire_forget_failed', { 
          error: String(err?.message || err), 
          source: 'meteora_balanced',  // ← Correct source
          pool: pk58.slice(0,8) + '…',
          cat: 'graph' 
        }); 
      } catch {}
    });
  }
} catch {}
```

## Key Changes

1. ✅ **Correct Function**: `applyPoolUpdates` (not `scheduleDexApply`)
2. ✅ **Correct Parameters**: `(prev, next, options)` (not just `prev`)
3. ✅ **Correct Source**: `'pumpswap'` or `'meteora_balanced'` (not `'raydium'`)
4. ✅ **Non-blocking**: `void gmod.applyPoolUpdates(...)` with `.catch()` (not `await`)
5. ✅ **Push to Arb**: `{ pushToArb: true }` option to trigger downstream updates

## How applyPoolUpdates Works

From `graph.ts` (line 261-390):

```typescript
export async function applyPoolUpdates(
  prev: PoolsPayload,    // ← Old pool state
  next: PoolsPayload,    // ← New pool state
  opts?: { pushToArb?: boolean }  // ← Options
): Promise<void>
```

**Process:**
1. Calculates diff between prev and next
2. Computes incremental graph update (adds/updates/removes edges)
3. Updates `lastSnapshot` atomically
4. Pushes graph diff to arb-rs (if `pushToArb: true`)
5. Emits WebSocket events for frontend

**Key Benefit**: Incremental updates are much faster than full rebuilds!

## Expected Behavior After Fix

### Before (Broken)
```
[INFO] pools.ws.event_received
[DEBUG] pumpswap.ws.decode.success
[INFO] pools.ws aggregate {"pumpswap":{"decoded":25,"applied":22}}
[INFO] graph.incremental.apply {"removed":132,"nodes_rem":61}  ← WRONG!
```

### After (Working)
```
[INFO] pools.ws.event_received
[DEBUG] pumpswap.ws.decode.success
[INFO] pools.ws aggregate {"pumpswap":{"decoded":25,"applied":22}}
[INFO] graph.incremental.apply {"added":0,"updated":22,"removed":0}  ← CORRECT!
```

## Pattern Consistency

This fix brings pumpswap and meteora_balanced in line with how other DEXes handle graph updates:

**Raydium** (line 4949):
```typescript
void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true })
```

**Orca** (line 5063):
```typescript
void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, data, { pushToArb: true })
```

**Pumpswap** (NOW FIXED - line 2605):
```typescript
void gmod.applyPoolUpdates(prev, next, { pushToArb: true })
```

**Meteora Balanced** (NOW FIXED - line 2756):
```typescript
void gmod.applyPoolUpdates(prev, next, { pushToArb: true })
```

All DEXes now use the same pattern!

## Why This Matters

1. **Proper Graph Updates**: Edges are updated, not removed
2. **Fast Updates**: Incremental updates are much faster than full rebuilds
3. **Arb Notifications**: Arb-rs receives price updates immediately
4. **Frontend Updates**: UI shows real-time price changes
5. **Accurate Opportunities**: Graph reflects current pool states

## Files Modified

- `backend/src/server/pools.ts`:
  - Lines 2600-2616: Fixed pumpswap graph update application
  - Lines 2751-2767: Fixed meteora_balanced graph update application

## Testing Checklist

After restarting, verify:
1. ✅ WebSocket events arrive and decode successfully
2. ✅ Graph updates show `"updated":N` instead of `"removed":132`
3. ✅ Graph node/edge count remains stable (not decreasing)
4. ✅ Arb-rs receives graph updates (check arb logs)
5. ✅ Frontend shows live price updates for pumpswap pools
6. ✅ No `graph.update.fire_forget_failed` errors in logs

## Key Takeaway

**Copy-paste carefully!** The comment "Reuse raydium scheduler for now" was a TODO that never got fixed. When WebSocket decoders were added for pumpswap and meteora_balanced, they copied the wrong pattern from an older part of the codebase instead of the correct pattern used by HTTP fetchers.

Always look at the most recent, production-tested code when adding new features!

