# WebSocket Retarget Configuration Update

## Changes Made

### 1. Added WebSocket Configuration to `backend/src/utils/config.ts`

All WebSocket retarget settings are now exposed as environment variables with increased defaults to reduce retarget frequency.

### 2. Removed Graph-Triggered Retargeting from `backend/src/server/graph.ts`

The automatic retargeting based on graph edge changes has been removed. WebSocket retargets now only occur through health monitoring and reconciliation checks.

### 3. Made Auto-Reconciliation Less Aggressive in `backend/src/server/pools.ts`

The automatic reconciliation (which triggers when attached pools don't match target pools) now:
- Can be disabled entirely via config flag
- Requires a larger threshold before triggering (10 pools by default)
- Has a much longer minimum gap between reconciliations (60s instead of 5s)

## New Configuration Values

### WebSocket Health Monitoring

These control when the system detects unhealthy WebSocket connections and triggers a retarget:

```bash
# Health check interval = WS_HEALTH_TIMEOUT_MS / 3 (runs every 10 seconds)
# Idle threshold = WS_HEALTH_TIMEOUT_MS * 2 (triggers if no events for 60 seconds)
WS_HEALTH_TIMEOUT_MS=30000        # Default: 30000 (was 15000)

# Minimum gap between consecutive retargets (prevents rapid retargeting)
WS_RECONNECT_MIN_GAP_MS=15000     # Default: 15000 (was 5000)

# Aggregate logging period for WebSocket activity
WS_AGG_LOG_PERIOD_MS=20000        # Default: 20000 (was 15000)
```

**Effect:** 
- Health checks run every **10 seconds** (down from 5 seconds)
- Retarget triggers only if **no WS events for 60 seconds** (up from 30 seconds)
- Minimum **15 seconds between retargets** (up from 5 seconds)

### WebSocket Retarget Process Timing

These control the retarget process itself (sequential throttling to avoid RPC rate limits):

```bash
# Cooldown after unsubscribing all pools before starting resubscription
WS_RETARGET_COOLDOWN_MS=3000      # Default: 3000 (was 2000)

# Stagger delay between each DEX source during retarget
# Orca completes → wait → Raydium starts → wait → Meteora starts
WS_RETARGET_STAGGER_MS=5000       # Default: 5000 (was 3000)

# Subscription rate during retarget (pools per second)
WS_RETARGET_ATTACH_PER_SEC=5      # Default: 5 (unchanged)

# How long to wait for all subscriptions to complete
WS_RETARGET_ATTACH_WAIT_MS=25000  # Default: 25000 (was 15000)

# Maximum wait for previous setup to clear before starting new one
WS_SETUP_MAX_WAIT_MS=15000        # Default: 15000 (was 10000)
```

**Effect:**
- Longer cooldowns and staggers make the retarget process less aggressive
- More time allowed for subscriptions to complete
- Safer for rate-limited RPC endpoints

### WebSocket Auto-Reconciliation (NEW)

These control automatic retargeting when attached pools don't match target pools:

```bash
# Enable/disable auto-reconciliation (disabled by default - set to 'true' to enable)
WS_AUTO_RECONCILE=false           # Default: false (DISABLED)

# Minimum gap between reconciliation-triggered retargets
WS_RECONCILE_MIN_GAP_MS=60000     # Default: 60000 (was 5000)

# Minimum number of missing/excess pools required to trigger reconciliation
WS_RECONCILE_THRESHOLD=10         # Default: 10 (was 0 - any mismatch)
```

**Effect:**
- Auto-reconciliation is **DISABLED by default** - graph changes will NOT trigger retargets
- If enabled, reconciliation requires **10+ missing/excess pools** before triggering
- If enabled, minimum **60 seconds between reconciliation retargets** (was 5 seconds)
- Set `WS_AUTO_RECONCILE=true` to enable auto-reconciliation

## What Triggers Retargets Now?

### 1. Health Monitoring (Automatic Recovery)

The health check timer runs every **10 seconds** and checks:
- Has the WebSocket been idle (no events) for more than **60 seconds**?
- If yes AND at least **15 seconds** since last retarget → trigger retarget

### 2. Auto-Reconciliation (Target Mismatch Detection) - DISABLED BY DEFAULT

**Note: This is DISABLED by default. To enable, set `WS_AUTO_RECONCILE=true`**

When enabled, the aggregate timer runs every **20 seconds** and checks:
- Are there **10+ missing subscriptions** (attached < target)?
- Are there **50%+ excess subscriptions** (attached > 1.5× target)?
- If yes AND at least **60 seconds** since last retarget → trigger retarget

To enable:
```bash
WS_AUTO_RECONCILE=true
```

### 3. Manual Triggers

You can still manually trigger retargets via:
- API endpoint: `POST /arb/pools/retarget`
- Direct function call: `retargetPoolWebsockets()`

## What Was Removed

### Graph-Based Retargeting ❌

The following settings are **no longer used**:
- `AUTO_RETARGET_ON_GRAPH` - Removed
- `AUTO_RETARGET_EDGE_THRESHOLD` - Removed

Retargets no longer trigger directly from graph rebuilds. Graph changes may still cause retargets indirectly via auto-reconciliation if they change targets significantly.

## Expected Behavior

### Before Changes
- Retargets could occur every **5 seconds** if WebSocket was unhealthy or targets changed
- Idle threshold was **30 seconds** (health timeout 15s × 2)
- Graph rebuilds with 200+ edge changes could trigger retargets
- Any target mismatch (even 1 pool) triggered immediate reconciliation
- Total retarget process took ~**15-20 seconds**

### After Changes
- Retargets can occur at most every **15 seconds** (health only, since reconciliation is disabled by default)
- Idle threshold is **60 seconds** (health timeout 30s × 2)
- Graph rebuilds **never** directly trigger retargets
- Auto-reconciliation is **DISABLED by default** - no retargets from target mismatches unless enabled
- If reconciliation enabled: target mismatches require **10+ pools** difference and **60 second gap**
- Total retarget process takes ~**25-35 seconds** (more graceful)

## Common Scenarios

### Scenario 1: Graph adds 5 new pools
- **Before:** Immediate retarget within 5 seconds
- **After:** No retarget (reconciliation disabled by default)

### Scenario 2: Graph adds 15 new pools
- **Before:** Immediate retarget within 5 seconds
- **After:** No retarget (reconciliation disabled by default)
- **If reconciliation enabled:** Retarget after 20-60 seconds (next aggregate check + 60s minimum gap)

### Scenario 3: WebSocket becomes unhealthy
- **Before:** Retarget within 5 seconds of detection
- **After:** Retarget within 15 seconds of detection (respects 15s minimum gap)

### Scenario 4: Frequent graph updates
- **Before:** Multiple retargets every 5 seconds (disruptive)
- **After:** No retargets from graph changes (reconciliation disabled by default)

## Testing

After deploying these changes, monitor your logs for:

```
pools:ws retarget.start - sequential resubscription with throttling
pools.ws retarget.cooldown { ms: 3000 }
pools.ws sequential.mode { enabled: true, staggerMs: 5000 }
pools:ws retarget.waiting 25000ms for sequential attachment
pools:ws retarget.complete healthy=true

# New reconciliation trigger log:
pools.ws reconcile.triggered { 
  reason: 'missing_subscriptions',
  missing: { total: 15, raydium: 5, orca: 10, meteora: 0 },
  threshold: 10,
  minGapMs: 60000
}
```

These messages indicate retargets are happening with the new timing values.

## Disabling Auto-Reconciliation

**Auto-reconciliation is DISABLED by default.** This means:
- Only health monitoring will trigger retargets (unhealthy WebSocket after 60s idle)
- Manual retargets via API will still work
- Graph changes will NOT trigger any retargets

### Enabling Auto-Reconciliation

If you want to enable automatic retargeting based on target mismatches:

```bash
# Add to .env
WS_AUTO_RECONCILE=true
```

With this setting enabled:
- Retargets will trigger when 10+ pools are missing or excess
- Minimum 60 seconds between reconciliation retargets
- Useful for environments where graph changes frequently and you want subscriptions to stay in sync

This is useful if:
- Your graph changes frequently but subscriptions remain stable
- You prefer to manually control retargeting
- You want maximum stability

## Tuning Recommendations

### For Stable Graphs (Infrequent Changes)
```bash
WS_AUTO_RECONCILE=true
WS_RECONCILE_THRESHOLD=5          # Lower threshold (more responsive)
WS_RECONCILE_MIN_GAP_MS=30000     # Shorter gap (more frequent checks)
```

### For Dynamic Graphs (Frequent Changes)
```bash
WS_AUTO_RECONCILE=true
WS_RECONCILE_THRESHOLD=20         # Higher threshold (less sensitive)
WS_RECONCILE_MIN_GAP_MS=120000    # Longer gap (2 minutes - very stable)
```

### For Maximum Stability (Minimal Retargets)
```bash
WS_AUTO_RECONCILE=false           # Disable auto-reconciliation entirely
WS_HEALTH_TIMEOUT_MS=60000        # 60s health timeout (120s idle threshold)
WS_RECONNECT_MIN_GAP_MS=30000     # 30s minimum between health retargets
```

## Rollback

If you need to revert to previous aggressive retargeting:

```bash
# Revert to previous aggressive defaults
WS_HEALTH_TIMEOUT_MS=15000
WS_RECONNECT_MIN_GAP_MS=5000
WS_RETARGET_COOLDOWN_MS=2000
WS_RETARGET_STAGGER_MS=3000
WS_RETARGET_ATTACH_WAIT_MS=15000
WS_SETUP_MAX_WAIT_MS=10000
WS_AUTO_RECONCILE=true
WS_RECONCILE_MIN_GAP_MS=5000
WS_RECONCILE_THRESHOLD=0
```

## Related Files

- `backend/src/utils/config.ts` - Configuration definitions (lines 128-144)
- `backend/src/server/pools.ts` - Health monitoring (lines 2730-2750), reconciliation (lines 2789-2832)
- `backend/src/server/graph.ts` - Graph rebuild (retarget code removed from line 231)


