# Data Flows

## Arbitrage
1. Pool discovery/refresh per source (timers/websockets).
2. Normalize pools → build graph snapshot.
3. Find candidate routes; apply minProfitBps.
4. Simulate with slippage; estimate fees and impact.
5. Execute with risk caps (slippage, notional, hops).
6. Emit tx events; record fills; update history.

## Drift
1. Market data (ladders, funding) fetched.
2. Strategy decides placements based on presets.
3. Orders placed under leverage/liq buffers.
4. Monitor fills and risk; pause on guards.

## Graph snapshots and incremental diffs

- Backend maintains an in-memory graph snapshot (`lastSnapshot`).
- On pool updates, the backend computes normalized deltas and, when enabled, applies them incrementally to `lastSnapshot` (diff-first):
  - Add/Update/Remove edges derived from pool id changes (forward and reverse edges per pool).
  - Prune orphan nodes (no incident edges).
  - Push a GraphDiff to clients and arb-rs.
- Periodically (time-based or change-count-based), the backend performs a rebase:
  - Rebuilds a full snapshot from current caches and pushes a full snapshot to arb-rs.
  - Rebases refresh labels/metadata and enforce invariants (e.g., forward/reverse reciprocity).

### Controls

- `GRAPH_INCREMENTAL_MODE` (default: true): when true, apply pool deltas directly to the in-memory graph and push diffs; otherwise schedule full rebuilds.
- `GRAPH_REBASE_DIFF_THRESHOLD`: after this many edge changes since last rebase, push a full snapshot.
- `GRAPH_REBASE_TIME_MS`: maximum time between forced rebases.
- `GRAPH_STREAM_INTERVAL_MS`: periodic rebuild/check interval. Set to `0` to disable periodic stream (rely on event-driven updates).