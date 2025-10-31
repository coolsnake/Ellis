## Detect-driven graph push

When detect-driven mode is enabled, the backend applies pool updates incrementally but defers pushing graph diffs to the arb service until a detection run completes. This keeps arb-rs aligned to a consistent latest graph per cycle while avoiding push storms under high churn.

### Enable/disable

- Backend env (defaults shown):

```bash
# Enable detect-driven push cadence
DETECT_DRIVEN_GRAPH_PUSH=true

# Enable incremental graph updates locally
GRAPH_INCREMENTAL_MODE=true

# Optional: coalesce diff pushes (ms)
ARB_DIFF_COALESCE_MS=50
```

### Arb-rs filtered detection (recommended)

Reduce per-iteration work by scanning only nodes touched by recent diffs.

```bash
# POST to arb service config
curl -s -X POST http://127.0.0.1:4010/config \
  -H 'content-type: application/json' \
  -d '{"filtered_detect_enable":true,"filtered_node_ratio":0.5,"filtered_expand_hops":4}'
```

Fields:
- filtered_detect_enable: enable filtered detection
- filtered_node_ratio: max fraction of nodes to scan when filtering
- filtered_expand_hops: expand scope by this many hops from changed nodes

### Rebase policy

Tune these to balance payload size vs. drift:

```bash
# Rebuild debounce and threshold (backend)
GRAPH_REBUILD_DEBOUNCE_MS=25
GRAPH_DELTA_REBUILD_THRESHOLD=0

# Periodic rebase controls
GRAPH_REBASE_DIFF_THRESHOLD=2000
GRAPH_REBASE_TIME_MS=300000
```

### Notes
- Raydium, Orca, and Meteora all use incremental apply in the backend.
- Snapshots supersede queued diffs; coalescing merges rapid diffs into one.

