# WebSocket Retarget Configuration Update

## Changes Made

### 1. Added WebSocket Configuration to `backend/src/utils/config.ts`

All WebSocket retarget settings are now exposed as environment variables with increased defaults to reduce retarget frequency.

### 2. Removed Graph-Triggered Retargeting from `backend/src/server/graph.ts`

The automatic retargeting based on graph edge changes has been removed. WebSocket retargets now only occur through health monitoring.

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

## What Triggers Retargets Now?

### Only Health Monitoring (Automatic Recovery)

The health check timer runs every **10 seconds** and checks:
- Has the WebSocket been idle (no events) for more than **60 seconds**?
- If yes AND at least **15 seconds** since last retarget → trigger retarget

### Manual Triggers

You can still manually trigger retargets via:
- API endpoint: `POST /pools/retarget`
- Direct function call: `retargetPoolWebsockets()`

## What Was Removed

### Graph-Based Retargeting ❌

The following settings are **no longer used**:
- `AUTO_RETARGET_ON_GRAPH` - Removed
- `AUTO_RETARGET_EDGE_THRESHOLD` - Removed

Retargets no longer trigger based on graph edge changes. This prevents unnecessary retargets when pools are frequently updated via HTTP polling.

## Expected Behavior

### Before Changes
- Retargets could occur every **5 seconds** if WebSocket was unhealthy
- Idle threshold was **30 seconds** (health timeout 15s × 2)
- Graph rebuilds with 200+ edge changes could trigger retargets
- Total retarget process took ~**15-20 seconds**

### After Changes
- Retargets can occur at most every **15 seconds**
- Idle threshold is **60 seconds** (health timeout 30s × 2)
- Graph rebuilds **never** trigger retargets
- Total retarget process takes ~**25-35 seconds** (more graceful)

## Testing

After deploying these changes, monitor your logs for:

```
pools:ws retarget.start - sequential resubscription with throttling
pools.ws retarget.cooldown { ms: 3000 }
pools.ws sequential.mode { enabled: true, staggerMs: 5000 }
pools:ws retarget.waiting 25000ms for sequential attachment
pools:ws retarget.complete healthy=true
```

These messages indicate retargets are happening with the new timing values.

## Rollback

If you need to revert to more aggressive retargeting:

```bash
# Revert to previous aggressive defaults
WS_HEALTH_TIMEOUT_MS=15000
WS_RECONNECT_MIN_GAP_MS=5000
WS_RETARGET_COOLDOWN_MS=2000
WS_RETARGET_STAGGER_MS=3000
WS_RETARGET_ATTACH_WAIT_MS=15000
WS_SETUP_MAX_WAIT_MS=10000
```

## Related Files

- `backend/src/utils/config.ts` - Configuration definitions
- `backend/src/server/pools.ts` - Health monitoring and retarget logic (lines 2730-2750)
- `backend/src/server/graph.ts` - Graph rebuild (retarget code removed)

