# Arb Detector Event-Driven Refactor

## Summary

Refactored the arb detector loop from a **time-based polling** approach to a **purely event-driven** architecture to eliminate redundant "none pending" iterations and improve efficiency.

## Problem

Previously, the detector would wake up every 100ms (default `max_idle_ms`) to check for updates, even when no updates were available. This caused:

1. **Redundant iterations**: Loop would wake, find "none pending", and sleep again
2. **Confused responsibilities**: `max_idle_ms` was being misused as both:
   - Loop polling interval 
   - Base TTL for opportunity persistence calculation
3. **Unnecessary CPU usage**: Polling every 100ms when idle
4. **Delayed response**: Updates had to wait up to 100ms before being processed

## Solution

### 1. New Configuration Field: `opportunity_base_ttl_ms`

Added a dedicated field for opportunity persistence TTL calculation, separate from loop timing:

```rust
// In ArbConfig struct (line 45)
opportunity_base_ttl_ms: u64,

// In default_config() (line 2400)
opportunity_base_ttl_ms: std::env::var("ARB_OPPORTUNITY_BASE_TTL_MS")
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(5_000),  // 5 seconds base
```

### 2. Changed `max_idle_ms` to Long Fallback Timeout

Changed from 100ms polling to 1-hour fallback (effectively infinite):

```rust
// In default_config() (line 2394)
max_idle_ms: std::env::var("ARB_IDLE_MS")
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(3_600_000), // 1 hour default
```

### 3. Updated TTL Calculation

Changed from using `max_idle_ms` to using dedicated `opportunity_base_ttl_ms`:

```rust
// Lines 1506-1510 (previously used max_idle_ms.max(5_000))
let base_ttl = {
    // Use dedicated config for opportunity base TTL (independent of loop timing)
    let s = loop_state.read().await;
    s.config.opportunity_base_ttl_ms
};
```

### 4. Updated Sleep Logic Comments

Updated comments to clarify the event-driven nature:

```rust
// Lines 1777-1792
// Event-driven wait: wake on notify or after fallback timeout
// max_idle_ms is now a long fallback timeout (default 1 hour)
tokio::select! {
    _ = wake.notified() => {
        tracing::info!("arb.loop.woken");
    },
    _ = tokio::time::sleep(timeout) => {
        // This should rarely happen in event-driven mode
        tracing::info!("arb.loop.timeout_fallback");
    },
}
```

### 5. Updated Config API

Added support for the new field in the config update endpoint:

- Added to `ConfigReq` struct (line 2305)
- Added to logging (line 2341)
- Added to assignment logic (line 2359)

## Benefits

✅ **No redundant iterations**: Loop only runs when there are actual updates  
✅ **Immediate response**: Updates trigger immediate wakeup via `wake.notify_one()`  
✅ **Lower CPU usage**: No polling when idle  
✅ **Cleaner separation**: Loop timing and TTL logic are independent  
✅ **Semantic clarity**: TTL logic now makes sense without artificial dependency on polling interval  

## Behavior Changes

### Before:
```
Update arrives → Buffer → Sleep 100ms → Wake → Apply → Detect
(Sometimes: Wake → "none pending" → Sleep 100ms → ...)
```

### After:
```
Update arrives → Buffer → Wake immediately → Apply → Detect → Sleep until next update
```

## Configuration

### New Environment Variable:
- `ARB_OPPORTUNITY_BASE_TTL_MS` - Base TTL for opportunity persistence (default: 5000ms / 5s)

### Changed Default:
- `ARB_IDLE_MS` - Now defaults to 3,600,000ms (1 hour) instead of 100ms

### Backward Compatibility:
- Existing `ARB_IDLE_MS` environment variable still works if set
- All other behavior remains identical

## Testing Notes

1. Verify "none pending" messages no longer appear in logs (or very rarely)
2. Confirm immediate response to graph updates (no 100ms delay)
3. Check CPU usage is lower when idle
4. Verify opportunity TTL behavior is unchanged despite refactored calculation

## Files Modified

- `arb-rs/src/main.rs`:
  - Line 45: Added `opportunity_base_ttl_ms` field to `ArbConfig`
  - Line 1493: Updated comment about TTL calculation
  - Line 1506-1510: Changed to use `opportunity_base_ttl_ms`
  - Line 1777-1791: Updated sleep logic comments
  - Line 2305: Added field to `ConfigReq`
  - Line 2341: Added to config logging
  - Line 2359: Added assignment logic
  - Line 2394: Changed `max_idle_ms` default to 3,600,000
  - Line 2400: Added `opportunity_base_ttl_ms` default

## Implementation Date

2025-11-10

