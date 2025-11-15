# Graph Synchronization Resync Implementation

## Problem Statement

The arb-rs service was falling behind when receiving graph updates from the backend. When the backend sends version 470 but arb-rs is still at version 463, timeouts occur and the services fall out of sync with no automatic recovery mechanism.

## Solution Overview

Implemented a dual-approach automatic resync mechanism:

1. **arb-rs Detection** - Proactively detects when it's falling behind
2. **Backend Safety Net** - Forces resync after excessive failures

## Implementation Details

### 1. arb-rs Changes (`arb-rs/src/main.rs`)

#### Added State Tracking Fields:
```rust
consecutive_empty_cycles: AtomicU64,     // Track detection cycles with no updates
last_resync_attempt_ms: AtomicU64,       // Prevent too-frequent resync attempts
```

#### Detection Logic (Lines 3016-3100):
After each detection cycle, arb-rs now:
- Tracks "empty cycles" where no pending graph updates are received
- After 5 consecutive empty cycles, checks if we're out of sync with backend
- Queries backend for current version via `/api/arb/graph/version`
- If 5+ versions behind, requests full snapshot via `/api/arb/graph/current`
- Rate-limited to max one resync attempt per 30 seconds

**Triggers:**
- 5 consecutive empty cycles (no pending updates)
- Version gap ≥ 5 between arb-rs and backend
- Minimum 30 seconds between resync attempts

### 2. Backend Endpoint (`backend/src/server/routes/arb.ts`)

#### New Endpoint: `GET /api/arb/graph/current` (Lines 627-653)
Returns the current graph snapshot for resync requests.

**Response:**
```json
{
  "graph": {
    "version": 470,
    "timestamp": 1731704923000,
    "nodes": [...],
    "edges": [...]
  }
}
```

**Error Handling:**
- 404 if no graph available
- 500 on internal errors

### 3. Backend Orchestrator Safety Net (`backend/src/server/graphPushOrchestrator.ts`)

#### Excessive Failure Detection (Lines 499-524):
After each failed acknowledgment:
- Tracks consecutive failures
- If 10+ failures with <3 successes, triggers emergency resync
- Clears push queue
- Sends fresh snapshot
- Resets failure counters

**Triggers:**
- 10+ consecutive failed acknowledgments
- Less than 3 successful acknowledgments in the period

## How It Works

### Normal Operation:
```
Backend (v470) → Push Diff → arb-rs (v470)
                            ↓ Apply
                            ✓ Ack within 2.5s
```

### Out-of-Sync Scenario:
```
Backend (v470) → Push Diff → arb-rs (v463, stuck)
                            ↓ Timeout (can't process fast enough)
                            ✗ No ack

After 5 empty cycles in arb-rs:
arb-rs → GET /api/arb/graph/version → Backend
       ← {"version": 470}
       
Gap detected (470 - 463 = 7 ≥ 5):
arb-rs → GET /api/arb/graph/current → Backend
       ← Full snapshot at v470
       ✓ Applied immediately
       ✓ Back in sync
```

### Backend Safety Net:
```
After 10 failed push attempts:
Backend orchestrator:
  1. Clears push queue
  2. Gets fresh snapshot
  3. Enqueues snapshot (overrides diffs)
  4. Resets counters
  5. Retry with clean slate
```

## Configuration Parameters

### arb-rs:
- `BACKEND_API_BASE`: Backend API URL (default: `http://127.0.0.1:3001/api`)
- Empty cycle threshold: 5 cycles
- Version gap threshold: 5 versions
- Resync cooldown: 30 seconds

### Backend:
- Failure threshold: 10 consecutive failures
- Success requirement: <3 successes to trigger resync
- ACK timeout: 2.5 seconds (existing)

## Benefits

1. **Self-Healing**: System automatically recovers from sync loss
2. **Prevents Cascading Failures**: Catches issues before they compound
3. **Minimal Overhead**: Only activates when problems detected
4. **Rate-Limited**: Prevents resync storms
5. **Dual Protection**: Both services can initiate recovery

## Monitoring

Key log messages to watch:

**arb-rs:**
- `arb.resync: detected version lag, requesting snapshot` - Resync triggered
- `arb.resync: snapshot applied` - Recovery successful
- `arb.resync: minor version lag, waiting for push` - Small gap detected

**Backend:**
- `arb.push excessive failures, triggering resync` - Safety net activated
- `arb.graph.current` - Snapshot served to arb-rs
- `arb.push resync failed` - Recovery attempt failed

## Testing

To test the resync mechanism:
1. Stop arb-rs temporarily while backend continues updating
2. Restart arb-rs - it will be behind
3. Watch logs for automatic resync after ~5 detection cycles
4. Verify version synchronization restored

## Future Improvements

Potential enhancements:
- Configurable thresholds via environment variables
- Metrics/telemetry for resync events
- Exponential backoff for repeated failures
- Health check endpoint showing sync status

