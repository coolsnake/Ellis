# Graph Statistics Churn Fix

## Problem

The logs showed continuous reports of edges and nodes being "added", but the graph snapshot size remained constant:

```
[INFO] graph.incremental.apply {"added":4,"updated":0,"removed":0,"nodes_add":1,...}
[INFO] graph.snapshot built {"nodes":5,"edges":8}
[INFO] graph.incremental.apply {"added":2,"updated":0,"removed":0,...}
[INFO] graph.snapshot built {"nodes":5,"edges":8}
```

This created a misleading picture where it appeared the graph was continuously growing, when in fact the same edges/nodes were being churned (removed and re-added within the same update cycle).

## Root Cause

In the incremental graph update logic (`graph.worker.compute.ts`), edges and nodes were being reported as "added" even when they were just being restored after temporary removal:

### The Churn Cycle

1. **Start of update**: Edge X exists in graph
2. **Removal phase**: Pool for edge X temporarily missing → edge X deleted from map
3. **Addition phase**: Pool data arrives → edge X re-created
4. **Stats reporting**: Since edge X not in map (step 2), it's counted as "added"
5. **Final snapshot**: Edge X exists (same as step 1)

The statistics showed additions, but the final count was the same because the "additions" were actually restorations.

### Code Issue

```typescript
// OLD CODE (lines 120-128)
if (!current) {
  edgesMap.set(edge.id, edge);
  addedEdges.push(edge);  // ❌ Reports as "added" even if it existed before
}
```

The problem: `!current` only checks if the edge is in the *current* map state, not whether it existed in the *original* snapshot. Since edges can be deleted earlier in the same update cycle, this incorrectly reports restorations as additions.

## Solution

Track which edges and nodes existed in the original snapshot, and only report truly new items as "added":

```typescript
// NEW CODE
// Track original state
const originalEdgeIds = new Set(prevSnapshot.edges.map((e) => String(e.id)));
const originalNodeIds = new Set(prevSnapshot.nodes.map((n) => String(n.id)));

// When edge not currently in map
if (!current) {
  edgesMap.set(edge.id, edge);
  if (!originalEdgeIds.has(edge.id)) {
    addedEdges.push(edge);  // ✅ Truly new
  } else {
    updatedEdges.push(edge); // ✅ Restored, count as update
  }
}
```

## Impact

### Before
- Misleading statistics showing continuous additions
- Difficulty diagnosing graph stability issues
- Stats didn't match actual graph size changes
- "Added" counts included churn from temporary removals

### After
- ✅ Accurate statistics reflecting true additions
- ✅ Churn shows as updates instead of adds
- ✅ Stats align with graph size changes
- ✅ Easier to diagnose real graph growth issues

## Example

### Before Fix
```
Cycle 1: 5 nodes, 8 edges
Update:  added=2, updated=0, removed=0
Result:  5 nodes, 8 edges (same edges that existed before)
```

### After Fix
```
Cycle 1: 5 nodes, 8 edges
Update:  added=0, updated=2, removed=0
Result:  5 nodes, 8 edges (correctly shows as updates, not additions)
```

## Files Modified

- `backend/src/server/graph.worker.compute.ts` (lines 97-159)
  - Added tracking of `originalEdgeIds` and `originalNodeIds`
  - Modified edge addition logic to distinguish new vs restored
  - Modified node addition logic to distinguish new vs restored

## Testing

After this fix, monitor logs to verify:
1. "added" counts should only increment when graph actually grows
2. "updated" counts should reflect churn and restorations
3. Graph snapshot sizes should correlate with cumulative net changes
4. No false growth signals from WebSocket update churn

