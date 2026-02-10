---
name: lockstone-arb-rs
description: Lockstone arb-rs Rust service for arbitrage cycle detection using Bellman-Ford and SPFA algorithms. Use when working on the arb-rs codebase, graph algorithms, cycle detection, opportunity filtering, or the arb-rs HTTP/WebSocket API.
---

# Lockstone arb-rs

High-performance Rust service for detecting arbitrage cycles in Solana DEX liquidity pools.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         arb-rs                                   │
├─────────────────────────────────────────────────────────────────┤
│  HTTP/WS Server (Axum)                                          │
│  ├── /arb/graph/snapshot  - Replace entire graph                │
│  ├── /arb/graph/update    - Apply incremental diff              │
│  ├── /opportunities       - Get current opportunities           │
│  ├── /ws/opportunities    - Stream opportunities (WebSocket)    │
│  └── /config              - Get/set configuration               │
├─────────────────────────────────────────────────────────────────┤
│  Detection Loop                                                  │
│  ├── Wake on graph update or timeout                            │
│  ├── Snapshot live graph (double-buffer pattern)                │
│  ├── Run cycle detection (BF or SPFA)                           │
│  ├── Select best edges for cycles                               │
│  ├── Filter by profit thresholds                                │
│  └── Broadcast via WebSocket                                    │
├─────────────────────────────────────────────────────────────────┤
│  Graph Layer (petgraph::DiGraph)                                │
│  ├── Nodes: Token mints                                         │
│  └── Edges: Pool rates with metadata                            │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `main.rs` | Axum server, detection loop, config management |
| `graph.rs` | `ArbGraph` struct, edge/node operations |
| `algos.rs` | Bellman-Ford, SPFA, filtered variants |
| `edge_selection.rs` | Optimal edge combination for cycles |
| `opportunities.rs` | `Opportunity` struct, filtering |

## Core Data Structures

### EdgeData

```rust
pub struct EdgeData {
    pub rate_effective: f64,        // Exchange rate after fees
    pub fee_bps: i64,
    pub liquidity: f64,
    pub dex: String,
    pub pool_id: String,
    pub liquidity_display: f64,
    // Native pool data for execution
    pub native_mint_a: Option<String>,
    pub native_mint_b: Option<String>,
    pub native_decimals_a: Option<i64>,
    pub native_decimals_b: Option<i64>,
    pub native_account_a: Option<String>,
    pub native_account_b: Option<String>,
    pub native_reserve_a_raw: Option<String>,
    pub native_reserve_b_raw: Option<String>,
}
```

### Opportunity

```rust
pub struct Opportunity {
    pub path: Vec<String>,              // Token mints in cycle
    pub profit_bps: i64,                // Profit in basis points
    pub net_bps: Option<i64>,           // After estimated fees
    pub est_profit_usd: f64,
    pub dexes: Vec<String>,
    pub hop_dexes: Option<Vec<String>>,
    pub hop_rates: Option<Vec<f64>>,
    pub hop_pool_ids: Option<Vec<String>>,
    pub hop_fee_bps: Option<Vec<i64>>,
    pub rate_product: Option<f64>,
    pub min_edge_liquidity: Option<f64>,
    pub est_capacity: Option<f64>,
    pub bottleneck: Option<BottleneckEdge>,
    pub detected_ms: Option<u64>,
    pub is_near_miss: Option<bool>,
    // ... additional fields
}
```

### ArbConfig (Key Fields)

```rust
struct ArbConfig {
    enabled: bool,
    min_profit_bps: i64,           // Minimum profit threshold
    max_profit_bps: i64,           // Filter unrealistic profits
    max_hops: usize,               // Default: 3
    use_spfa: bool,                // Use SPFA instead of BF
    filtered_detect_enable: bool,  // Incremental detection
    start_mint_mode: String,       // "any", "sol_usdc", "anchors"
    near_miss_enable: bool,        // Track near-profitable cycles
    ws_broadcast_interval_ms: u64, // Default: 25ms
    // ... many more
}
```

## Graph Operations

### Edge Weight Formula

```rust
// Weight = -log(rate_effective)
// Negative cycle in log-space = profitable arbitrage
fn edge_weight(reserve_in: f64, reserve_out: f64, fee_bps: i64) -> f64 {
    let fee_mult = 1.0 - (fee_bps as f64 / 10000.0);
    let rate = (reserve_out / reserve_in) * fee_mult;
    -rate.ln()
}
```

### Edge ID Convention

- Pool-based: Uses `pool_id` directly
- Synthetic: `"{mint_a}->{mint_b}-{dex}"` if no pool_id
- Reverse: Suffix `#rev` for reverse direction

### Graph Update Pattern

1. Backend sends diff via `/arb/graph/update`
2. Updates applied to `live_graph` immediately
3. Version incremented atomically
4. Detection creates snapshot from `live_graph` (double-buffer)
5. Detection runs on immutable snapshot

## API Endpoints

### HTTP

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/arb/graph/snapshot` | POST | Replace entire graph |
| `/arb/graph/update` | POST | Apply incremental diff |
| `/opportunities` | GET | Current opportunities |
| `/config` | GET/POST | Configuration |
| `/health` | GET | Health check |

### WebSocket

| Endpoint | Purpose |
|----------|---------|
| `/ws/opportunities` | Real-time opportunity stream |

### Graph Update Request

```json
{
  "version": 123,
  "timestamp": 1706889600000,
  "added_edges": [...],
  "updated_edges": [{
    "source": "So11111111111111111111111111111111111111112",
    "target": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "dex": "Raydium",
    "pool_id": "...",
    "fee_bps": 25,
    "liquidity": 1000000,
    "price_a_per_b": 150.5,
    "native_mint_a": "...",
    "native_reserve_a_raw": "..."
  }],
  "removed_edge_ids": [...]
}
```

## Detection Algorithms

### Bellman-Ford (Standard)

- Function: `detect_negative_cycles()`
- Complexity: O(V × E)
- Use when: correctness paramount, dense graph

### SPFA (Shortest Path Faster)

- Function: `detect_negative_cycles_spfa()`
- Complexity: O(E) average
- Use when: sparse graph, need speed
- Includes SLF optimization

### Filtered Detection

- Functions: `detect_negative_cycles_filtered()`, `detect_negative_cycles_spfa_filtered()`
- Only considers edges where both endpoints in affected set
- Use for: incremental updates after graph changes

### Anchor-Based Detection

- Function: `detect_negative_cycles_from_anchors()`
- Runs from each anchor mint (SOL, USDC)
- Use when: focusing on high-liquidity paths

## Edge Selection

```rust
// Find optimal edge combination for a cycle
fn select_best_edge_combination(
    graph: &ArbGraph,
    cycle: &[String],
    config: &EdgeSelectionConfig,
) -> Option<CycleEdgeSelection>
```

- Exhaustive enumeration up to `max_edge_combinations` (default: 10,000)
- Top-K per hop truncation when limit exceeded
- Rejects duplicate pools in same cycle
- Returns: selected edges, rate product, min liquidity

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARB_HOST` | `127.0.0.1` | Bind address |
| `ARB_PORT` | `4010` | Server port |
| `ARB_SHARED_SECRET` | - | Auth token |
| `BACKEND_DETECT_ACK` | `true` | ACK completion to backend |

## Performance Patterns

1. **Double-buffer**: Live graph for updates, snapshot for detection
2. **Edge insertion**: `edges_connecting()` instead of scanning (O(degree) vs O(E))
3. **Filtered detection**: Pre-filter edges once, not per iteration
4. **Log-space arithmetic**: Numerical stability for rate products
5. **Snapshot reuse**: Skip if version unchanged

## Common Tasks

### Adding a New Algorithm Variant

1. Add function in `algos.rs`
2. Follow signature pattern: `fn detect_*(...) -> Vec<Vec<NodeIndex>>`
3. Respect `max_hops` parameter
4. Use `-log(rate_effective)` weights
5. Wire into detection loop in `main.rs`

### Modifying Opportunity Filtering

1. Edit `opportunities.rs`
2. Update `filter_opportunities()` or add new filters
3. Respect `ArbConfig` thresholds

### Adding a New Config Field

1. Add to `ArbConfig` struct in `main.rs`
2. Add default in `Default` impl
3. Wire into detection loop if needed
