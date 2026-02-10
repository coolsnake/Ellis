# Cycle Detection Algorithms

## Graph Construction

Transform DEX pools into weighted directed graph for negative cycle detection.

### Edge Weight Formula

For a pool with reserves `(R_in, R_out)` and fee `f` (as decimal, e.g., 0.003 for 0.3%):

```
weight = -log(R_out / R_in × (1 - f))
```

**Why logarithms?**
- Converts multiplication to addition: `∏(rates)` → `Σ(log_rates)`
- Arbitrage profit condition `∏rates > 1` becomes `Σweights < 0`
- Enables shortest-path algorithms to find arbitrage cycles

### Bidirectional Edges

Each pool creates two directed edges:
- A→B: `weight = -log(R_B / R_A × (1 - f))`
- B→A: `weight = -log(R_A / R_B × (1 - f))`

### Edge Weight Precision

Use high-precision arithmetic (f64 minimum, consider fixed-point for determinism):

```rust
fn edge_weight(reserve_in: f64, reserve_out: f64, fee_bps: u16) -> f64 {
    let fee_mult = 1.0 - (fee_bps as f64 / 10000.0);
    let rate = (reserve_out / reserve_in) * fee_mult;
    -rate.ln()
}
```

---

## Bellman-Ford Algorithm

Classic algorithm for single-source shortest paths with negative edge detection.

### Standard Implementation

```python
def bellman_ford(graph, source):
    """
    Find shortest paths and detect negative cycles.
    
    Args:
        graph: Dict[vertex, List[(neighbor, weight)]]
        source: Starting vertex
    
    Returns:
        (distances, predecessors, negative_cycle_vertex or None)
    """
    vertices = list(graph.keys())
    n = len(vertices)
    
    # Initialize
    dist = {v: float('inf') for v in vertices}
    pred = {v: None for v in vertices}
    dist[source] = 0
    
    # Relax edges V-1 times
    for iteration in range(n - 1):
        updated = False
        for u in vertices:
            if dist[u] == float('inf'):
                continue
            for v, weight in graph[u]:
                if dist[u] + weight < dist[v]:
                    dist[v] = dist[u] + weight
                    pred[v] = u
                    updated = True
        # Early exit if no updates
        if not updated:
            break
    
    # V-th iteration: check for negative cycles
    for u in vertices:
        if dist[u] == float('inf'):
            continue
        for v, weight in graph[u]:
            if dist[u] + weight < dist[v]:
                return dist, pred, v  # Negative cycle found
    
    return dist, pred, None
```

### Cycle Reconstruction

```python
def reconstruct_negative_cycle(pred, start_vertex, n):
    """
    Reconstruct the negative cycle given a vertex on it.
    
    The start_vertex may not be ON the cycle, so we first
    traverse n edges to guarantee we're on the cycle.
    """
    # Move n steps to ensure we're on the cycle
    v = start_vertex
    for _ in range(n):
        v = pred[v]
    
    # Now reconstruct the cycle
    cycle = [v]
    current = pred[v]
    while current != v:
        cycle.append(current)
        current = pred[current]
    cycle.append(v)  # Close the cycle
    
    return list(reversed(cycle))
```

### Complexity
- Time: O(V × E)
- Space: O(V)

---

## SPFA (Shortest Path Faster Algorithm)

Queue-based optimization that's faster in practice for sparse graphs.

### Standard SPFA

```python
from collections import deque

def spfa(graph, source):
    """
    SPFA for shortest paths. Faster than Bellman-Ford on average.
    """
    vertices = list(graph.keys())
    dist = {v: float('inf') for v in vertices}
    in_queue = {v: False for v in vertices}
    
    dist[source] = 0
    queue = deque([source])
    in_queue[source] = True
    
    while queue:
        u = queue.popleft()
        in_queue[u] = False
        
        for v, weight in graph[u]:
            if dist[u] + weight < dist[v]:
                dist[v] = dist[u] + weight
                if not in_queue[v]:
                    queue.append(v)
                    in_queue[v] = True
    
    return dist
```

### SPFA with Negative Cycle Detection

```python
def spfa_detect_negative_cycle(graph):
    """
    SPFA variant for detecting ANY negative cycle in graph.
    
    Key insight: Initialize all distances to 0 (not inf).
    This finds negative cycles reachable from any vertex.
    """
    vertices = list(graph.keys())
    n = len(vertices)
    
    dist = {v: 0 for v in vertices}  # Init to 0!
    path_len = {v: 0 for v in vertices}
    pred = {v: None for v in vertices}
    in_queue = {v: True for v in vertices}
    
    queue = deque(vertices)  # Start with all vertices
    
    while queue:
        u = queue.popleft()
        in_queue[u] = False
        
        for v, weight in graph[u]:
            if dist[u] + weight < dist[v]:
                dist[v] = dist[u] + weight
                pred[v] = u
                path_len[v] = path_len[u] + 1
                
                # Negative cycle detected when path length >= n
                if path_len[v] >= n:
                    return reconstruct_negative_cycle(pred, v, n)
                
                if not in_queue[v]:
                    queue.append(v)
                    in_queue[v] = True
    
    return None  # No negative cycle
```

### Complexity
- Average: O(E) — empirically, often near-linear
- Worst: O(V × E) — when negative cycles cause repeated relaxations

### Performance Notes

1. **SPFA slows with negative cycles**: When a negative cycle exists, SPFA may repeatedly relax edges before detecting it. Consider:
   - Early termination when `path_len[v] >= n`
   - Limiting total relaxations

2. **SLF Optimization** (Small Label First):
   ```python
   # When adding to queue, add to front if smaller than front
   if dist[v] < dist[queue[0]]:
       queue.appendleft(v)
   else:
       queue.append(v)
   ```

3. **LLL Optimization** (Large Label Last):
   - Track average distance in queue
   - Move large-distance vertices to back

---

## Multi-Source Cycle Detection

To find ALL negative cycles efficiently:

### Approach 1: Virtual Super-Source

```python
def find_all_negative_cycles(graph):
    """
    Add virtual source connected to all vertices with weight 0.
    Single Bellman-Ford run finds any reachable negative cycle.
    """
    augmented = dict(graph)
    augmented['__super__'] = [(v, 0) for v in graph.keys()]
    
    _, pred, cycle_vertex = bellman_ford(augmented, '__super__')
    if cycle_vertex:
        return reconstruct_negative_cycle(pred, cycle_vertex, len(graph))
    return None
```

### Approach 2: Parallel Per-Token

```python
from concurrent.futures import ThreadPoolExecutor

def find_cycles_parallel(graph, max_workers=8):
    """
    Run SPFA from each token in parallel.
    Collect and deduplicate cycles.
    """
    def detect_from_source(source):
        return spfa_detect_negative_cycle_from(graph, source)
    
    cycles = set()
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = executor.map(detect_from_source, graph.keys())
        for cycle in results:
            if cycle:
                # Canonicalize cycle for deduplication
                canonical = canonicalize_cycle(cycle)
                cycles.add(canonical)
    
    return list(cycles)

def canonicalize_cycle(cycle):
    """Rotate cycle to start with smallest element for deduplication."""
    min_idx = cycle.index(min(cycle[:-1]))  # Exclude closing vertex
    rotated = cycle[min_idx:-1] + cycle[:min_idx] + [cycle[min_idx]]
    return tuple(rotated)
```

---

## Finding Top-K Profitable Cycles

For ranking opportunities by profitability:

```python
def find_top_k_cycles(graph, k=10):
    """
    Find k most profitable cycles using modified Bellman-Ford.
    
    Profit = -sum(edge_weights) = sum(log(rates))
    More negative sum = more profitable.
    """
    cycles = []
    
    # Find cycles from each source
    for source in graph.keys():
        dist, pred, cycle_v = bellman_ford(graph, source)
        if cycle_v:
            cycle = reconstruct_negative_cycle(pred, cycle_v, len(graph))
            profit = calculate_cycle_profit(graph, cycle)
            cycles.append((profit, cycle))
    
    # Sort by profit (descending) and deduplicate
    cycles.sort(key=lambda x: -x[0])
    seen = set()
    unique_cycles = []
    
    for profit, cycle in cycles:
        canonical = canonicalize_cycle(cycle)
        if canonical not in seen:
            seen.add(canonical)
            unique_cycles.append((profit, cycle))
            if len(unique_cycles) >= k:
                break
    
    return unique_cycles

def calculate_cycle_profit(graph, cycle):
    """Calculate profit multiplier for a cycle."""
    total_weight = 0
    for i in range(len(cycle) - 1):
        u, v = cycle[i], cycle[i + 1]
        for neighbor, weight in graph[u]:
            if neighbor == v:
                total_weight += weight
                break
    # profit_multiplier = e^(-total_weight)
    return math.exp(-total_weight)
```

---

## Rust Implementation Notes

For high-performance implementation in Rust (like arb-rs):

```rust
use std::collections::VecDeque;

/// SPFA with negative cycle detection
pub fn detect_arbitrage_cycle(
    adj: &[Vec<(usize, f64)>],  // adjacency list
) -> Option<Vec<usize>> {
    let n = adj.len();
    let mut dist = vec![0.0; n];  // Init to 0 for any-cycle detection
    let mut path_len = vec![0usize; n];
    let mut pred = vec![usize::MAX; n];
    let mut in_queue = vec![true; n];
    
    let mut queue: VecDeque<usize> = (0..n).collect();
    
    while let Some(u) = queue.pop_front() {
        in_queue[u] = false;
        
        for &(v, weight) in &adj[u] {
            if dist[u] + weight < dist[v] {
                dist[v] = dist[u] + weight;
                pred[v] = u;
                path_len[v] = path_len[u] + 1;
                
                if path_len[v] >= n {
                    return Some(reconstruct_cycle(&pred, v, n));
                }
                
                if !in_queue[v] {
                    queue.push_back(v);
                    in_queue[v] = true;
                }
            }
        }
    }
    
    None
}
```

### Performance Optimizations

1. **Use indices, not strings**: Map token addresses to `usize` indices
2. **Pre-allocate vectors**: Avoid allocations in hot path
3. **SIMD for edge relaxation**: Batch process edges where possible
4. **Incremental updates**: When pool state changes, only update affected edges
