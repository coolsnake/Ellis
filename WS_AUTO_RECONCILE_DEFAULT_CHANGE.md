# Auto-Reconciliation Default Changed to DISABLED

## Change Summary

Changed the default behavior of WebSocket auto-reconciliation from **ENABLED** to **DISABLED**.

## What Changed

### File: `backend/src/utils/config.ts` (line 142)

**Before:**
```typescript
wsAutoReconcile: process.env.WS_AUTO_RECONCILE !== 'false', // Enable by default
```

**After:**
```typescript
wsAutoReconcile: process.env.WS_AUTO_RECONCILE === 'true', // Disabled by default
```

## Impact

### Default Behavior (No .env setting)

**Before:**
- Auto-reconciliation was **ENABLED** by default
- Graph changes triggering target mismatches would cause retargets
- Required explicitly setting `WS_AUTO_RECONCILE=false` to disable

**After:**
- Auto-reconciliation is **DISABLED** by default
- Graph changes will NOT trigger retargets
- Requires explicitly setting `WS_AUTO_RECONCILE=true` to enable

### What This Means

**By default (no configuration):**
- ✅ Health monitoring retargets still work (unhealthy WebSocket after 60s idle)
- ✅ Manual retargets via API still work
- ❌ Target mismatch detection retargets are DISABLED
- ❌ Graph changes will NOT trigger retargets

**To enable auto-reconciliation:**
```bash
# Add to .env
WS_AUTO_RECONCILE=true
```

## Why This Change?

1. **Maximum Stability:** Most users want minimal automatic retargeting
2. **Graph Changes:** Frequent graph updates were causing unwanted retargets
3. **Opt-In Philosophy:** Better to require explicit enabling for potentially disruptive behavior
4. **RPC Conservation:** Reduces unnecessary accountSubscribe/unsubscribe calls

## Recommended Settings

### For Most Users (Default - Maximum Stability)
```bash
# No WS_AUTO_RECONCILE setting needed - disabled by default
# Only health-based retargets will occur
```

### For Active Monitoring (Enable Reconciliation)
```bash
WS_AUTO_RECONCILE=true
WS_RECONCILE_THRESHOLD=10         # Only retarget if 10+ pools mismatch
WS_RECONCILE_MIN_GAP_MS=60000     # Max 1 retarget per minute
```

### For Aggressive Sync (Not Recommended)
```bash
WS_AUTO_RECONCILE=true
WS_RECONCILE_THRESHOLD=5          # Retarget on 5+ pools mismatch
WS_RECONCILE_MIN_GAP_MS=30000     # Max 2 retargets per minute
```

## Migration Notes

### If you had NO configuration:
- **Before:** Auto-reconciliation was running
- **After:** Auto-reconciliation is OFF
- **Action:** If you want it, add `WS_AUTO_RECONCILE=true` to `.env`

### If you had `WS_AUTO_RECONCILE=false`:
- **Before:** Auto-reconciliation was explicitly disabled
- **After:** Auto-reconciliation is disabled (no change in behavior)
- **Action:** You can remove this setting (it's now the default)

### If you had `WS_AUTO_RECONCILE=true`:
- **Before:** Auto-reconciliation was explicitly enabled
- **After:** Auto-reconciliation is enabled (no change in behavior)
- **Action:** Keep this setting to maintain current behavior

## Testing

After deploying with default settings (no `WS_AUTO_RECONCILE`), you should **NOT** see:
```
pools.ws reconcile.triggered { ... }
```

This log message should only appear if you explicitly enable with `WS_AUTO_RECONCILE=true`.

You **WILL** still see retargets from health monitoring:
```
pools.ws unhealthy { idleMs: 65000, timeoutMs: 30000 }
pools:ws retarget.start - sequential resubscription with throttling
```

## Rollback

To revert to old behavior (auto-reconciliation enabled by default):

```typescript
// In backend/src/utils/config.ts line 142
wsAutoReconcile: process.env.WS_AUTO_RECONCILE !== 'false', // Enable by default
```

Or simply add to `.env`:
```bash
WS_AUTO_RECONCILE=true
```

