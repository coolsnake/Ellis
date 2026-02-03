use crate::graph::ArbGraph;
use petgraph::visit::EdgeRef;
use petgraph::graph::NodeIndex;
use std::collections::{HashSet, VecDeque};

pub struct DetectedCycle {
    pub nodes: Vec<usize>,
    #[allow(dead_code)]
    pub log_sum: f64,
}

pub fn detect_negative_cycles(g: &ArbGraph, max_hops: usize) -> Vec<DetectedCycle> {
    // Bellman-Ford on -log(rate_effective) weights
    let n = g.g.node_count();
    if n == 0 {
        return vec![];
    }
    // Ensure max_hops is at least 2 and not larger than graph
    let max_hops = max_hops.max(2).min(n);
    
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    // Relax edges V-1 times
    for _ in 0..(n - 1) {
        let mut updated = false;
        for e in g.g.edge_references() {
            let u = e.source().index();
            let v = e.target().index();
            let w = -(e.weight().rate_effective.max(1e-12)).ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                updated = true;
            }
        }
        if !updated {
            break;
        }
    }
    let mut cycles = Vec::new();
    // One more pass to find negative cycles
    for e in g.g.edge_references() {
        let u = e.source().index();
        let v = e.target().index();
        let w = -(e.weight().rate_effective.max(1e-12)).ln();
        if dist[u] + w < dist[v] - 1e-12 {
            // Found a negative cycle - use Floyd's algorithm to extract it properly
            let cycle = extract_cycle_from_node(v, &pred, max_hops);
            if !cycle.is_empty() {
                cycles.push(DetectedCycle {
                    nodes: cycle,
                    log_sum: 0.0,
                });
            }
        }
    }
    cycles
}

/// SPFA (Shortest Path Faster Algorithm) based negative cycle detection.
/// 
/// SPFA is an optimization of Bellman-Ford that uses a queue to process only
/// nodes whose distances have been updated. This is typically O(E) on average
/// for sparse graphs but degrades to O(VE) in worst case.
/// 
/// The algorithm detects negative cycles by counting relaxations per node.
/// If a node is relaxed more than n times, there must be a negative cycle.
/// 
/// Additionally uses SLF (Small Label First) optimization: when a node is 
/// added to the queue, if its distance is smaller than the front of the queue,
/// push it to the front instead of the back.
pub fn detect_negative_cycles_spfa(g: &ArbGraph, max_hops: usize) -> Vec<DetectedCycle> {
    let n = g.g.node_count();
    if n == 0 {
        return vec![];
    }
    
    let max_hops = max_hops.max(2).min(n);
    
    // Distance and predecessor arrays
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    
    // SPFA bookkeeping
    let mut in_queue = vec![false; n];
    let mut relax_count = vec![0usize; n];
    let mut queue: VecDeque<usize> = VecDeque::with_capacity(n);
    
    // Initialize: all nodes start in queue with distance 0
    // This is equivalent to starting from a virtual super-source
    for i in 0..n {
        queue.push_back(i);
        in_queue[i] = true;
    }
    
    let mut cycles = Vec::new();
    
    while let Some(u) = queue.pop_front() {
        in_queue[u] = false;
        
        // Skip nodes already confirmed in a cycle - they have unbounded negative distance
        if relax_count[u] > n {
            continue;
        }
        
        // Process all outgoing edges from u
        for e in g.g.edges(NodeIndex::new(u)) {
            let v = e.target().index();
            let w = -(e.weight().rate_effective.max(1e-12)).ln();
            
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                relax_count[v] += 1;
                
                // Negative cycle detected if relaxed > n times
                if relax_count[v] > n {
                    // Extract cycle starting from v
                    let extracted = extract_cycle_from_node(v, &pred, max_hops);
                    if !extracted.is_empty() {
                        cycles.push(DetectedCycle {
                            nodes: extracted,
                            log_sum: 0.0,
                        });
                    }
                    // Don't re-queue v - it's in a cycle with unbounded negative distance
                    continue;
                }
                
                if !in_queue[v] {
                    // SLF optimization: if new distance is smaller than front, push to front
                    if !queue.is_empty() && dist[v] < dist[*queue.front().unwrap()] {
                        queue.push_front(v);
                    } else {
                        queue.push_back(v);
                    }
                    in_queue[v] = true;
                }
            }
        }
    }
    
    cycles
}

/// SPFA-based negative cycle detection on a filtered subgraph.
/// Only considers edges where both endpoints are in the `nodes` set.
pub fn detect_negative_cycles_spfa_filtered(
    g: &ArbGraph,
    nodes: &HashSet<usize>,
    max_hops: usize,
) -> Vec<DetectedCycle> {
    let n = g.g.node_count();
    if n == 0 || nodes.is_empty() {
        return vec![];
    }
    
    let max_hops = max_hops.max(2).min(n);
    
    // Pre-filter edges to only those with both endpoints in nodes
    let filtered_edges: Vec<(usize, usize, f64)> = g.g
        .edge_references()
        .filter_map(|e| {
            let u = e.source().index();
            let v = e.target().index();
            if nodes.contains(&u) && nodes.contains(&v) {
                Some((u, v, e.weight().rate_effective))
            } else {
                None
            }
        })
        .collect();
    
    if filtered_edges.is_empty() {
        return vec![];
    }
    
    // Build adjacency list from filtered edges for efficient iteration
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for &(u, v, rate) in &filtered_edges {
        adj[u].push((v, rate));
    }
    
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    let mut in_queue = vec![false; n];
    let mut relax_count = vec![0usize; n];
    let mut queue: VecDeque<usize> = VecDeque::new();
    
    // Only initialize nodes that are in the subgraph
    for &node in nodes {
        if node < n {
            queue.push_back(node);
            in_queue[node] = true;
        }
    }
    
    let mut cycles = Vec::new();
    
    while let Some(u) = queue.pop_front() {
        in_queue[u] = false;
        
        // Skip nodes already confirmed in a cycle
        if relax_count[u] > nodes.len() {
            continue;
        }
        
        for &(v, rate) in &adj[u] {
            let w = -(rate.max(1e-12)).ln();
            
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                relax_count[v] += 1;
                
                if relax_count[v] > nodes.len() {
                    let extracted = extract_cycle_from_node(v, &pred, max_hops);
                    if !extracted.is_empty() {
                        cycles.push(DetectedCycle {
                            nodes: extracted,
                            log_sum: 0.0,
                        });
                    }
                    // Don't re-queue - cycle detected
                    continue;
                }
                
                if !in_queue[v] {
                    if !queue.is_empty() && dist[v] < dist[*queue.front().unwrap()] {
                        queue.push_front(v);
                    } else {
                        queue.push_back(v);
                    }
                    in_queue[v] = true;
                }
            }
        }
    }
    
    cycles
}

/// Helper function to extract a cycle starting from a node using predecessor chain.
/// Uses Floyd's tortoise-and-hare algorithm for efficient cycle detection in O(cycle_length)
/// rather than O(n) predecessor walks.
fn extract_cycle_from_node(start: usize, pred: &[Option<usize>], max_hops: usize) -> Vec<usize> {
    // Phase 1: Use Floyd's tortoise-and-hare to find a meeting point in the cycle
    // Tortoise moves 1 step, hare moves 2 steps
    let mut tortoise = start;
    let mut hare = start;

    // Move until they meet (guaranteed to meet in a cycle)
    let mut steps = 0;
    let max_steps = pred.len().min(max_hops * 2); // Limit to avoid infinite loops on broken data
    loop {
        steps += 1;
        if steps > max_steps {
            return vec![]; // Safety limit reached
        }

        // Tortoise takes 1 step
        tortoise = match pred[tortoise] {
            Some(p) => p,
            None => return vec![],
        };

        // Hare takes 2 steps
        hare = match pred[hare] {
            Some(p) => match pred[p] {
                Some(pp) => pp,
                None => return vec![],
            },
            None => return vec![],
        };

        if tortoise == hare {
            break; // Found meeting point inside the cycle
        }
    }

    // Phase 2: Find the cycle starting from the meeting point
    // The meeting point is guaranteed to be in the cycle
    let cycle_start = tortoise;
    let mut cycle = vec![cycle_start];
    let mut cur = match pred[cycle_start] {
        Some(p) => p,
        None => return vec![],
    };

    while cur != cycle_start && cycle.len() <= max_hops {
        cycle.push(cur);
        cur = match pred[cur] {
            Some(p) => p,
            None => break,
        };
    }

    if cycle.len() >= 2 && cycle.len() <= max_hops {
        cycle.reverse();
        cycle
    } else {
        vec![]
    }
}

/// Variant of negative cycle detection limited to an induced subgraph defined by `nodes`.
/// Only edges whose endpoints are both in `nodes` are considered. This is useful to scope
/// detection work to areas impacted by recent graph diffs.
pub fn detect_negative_cycles_filtered(
    g: &ArbGraph, 
    nodes: &HashSet<usize>,
    max_hops: usize
) -> Vec<DetectedCycle> {
    let n = g.g.node_count();
    if n == 0 || nodes.is_empty() {
        return vec![];
    }
    // Ensure max_hops is at least 2 and not larger than graph
    let max_hops = max_hops.max(2).min(n);

    // OPTIMIZATION: Pre-filter edges once instead of checking membership in every iteration
    // This changes complexity from O(V * E) to O(V * filtered_E), typically 10-100x faster
    let filtered_edges: Vec<(usize, usize, f64)> =
        g.g.edge_references()
            .filter_map(|e| {
                let u = e.source().index();
                let v = e.target().index();
                if nodes.contains(&u) && nodes.contains(&v) {
                    Some((u, v, e.weight().rate_effective))
                } else {
                    None
                }
            })
            .collect();

    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];

    // Relax edges V-1 times on filtered edges only
    for _ in 0..(n.saturating_sub(1)) {
        let mut updated = false;
        for &(u, v, rate) in filtered_edges.iter() {
            let w = -(rate.max(1e-12)).ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                updated = true;
            }
        }
        if !updated {
            break;
        }
    }

    let mut cycles = Vec::new();
    // One more pass to find negative cycles on filtered edges
    for &(u, v, rate) in filtered_edges.iter() {
        let w = -(rate.max(1e-12)).ln();
        if dist[u] + w < dist[v] - 1e-12 {
            // Found a negative cycle - use Floyd's algorithm to extract it properly
            let cycle = extract_cycle_from_node(v, &pred, max_hops);
            if !cycle.is_empty() {
                cycles.push(DetectedCycle {
                    nodes: cycle,
                    log_sum: 0.0,
                });
            }
        }
    }
    cycles
}

/// Detect negative cycles starting only from anchor nodes.
/// This restricts the search space to cycles that begin with high-liquidity anchor tokens.
pub fn detect_negative_cycles_from_anchors(
    g: &ArbGraph,
    anchor_mints: &HashSet<String>,
    max_hops: usize
) -> Vec<DetectedCycle> {
    let n = g.g.node_count();
    if n == 0 || anchor_mints.is_empty() {
        return vec![];
    }
    
    // Convert anchor mints to node indices
    let anchor_indices: HashSet<usize> = anchor_mints
        .iter()
        .filter_map(|mint| g.map.get(mint).map(|idx| idx.index()))
        .collect();
    
    if anchor_indices.is_empty() {
        return vec![];
    }
    
    let max_hops = max_hops.max(2).min(n);
    let mut all_cycles = Vec::new();
    let mut seen_cycles: HashSet<String> = HashSet::new();
    
    // Run Bellman-Ford starting from each anchor
    for &anchor_idx in &anchor_indices {
        let mut dist = vec![f64::INFINITY; n];
        let mut pred: Vec<Option<usize>> = vec![None; n];
        dist[anchor_idx] = 0.0;
        
        // Relax edges V-1 times
        for _ in 0..(n - 1) {
            let mut updated = false;
            for e in g.g.edge_references() {
                let u = e.source().index();
                let v = e.target().index();
                let w = -(e.weight().rate_effective.max(1e-12)).ln();
                if dist[u] != f64::INFINITY && dist[u] + w < dist[v] - 1e-12 {
                    dist[v] = dist[u] + w;
                    pred[v] = Some(u);
                    updated = true;
                }
            }
            if !updated {
                break;
            }
        }
        
        // Find cycles that start from this anchor
        // Only consider edges where source is reachable from anchor
        for e in g.g.edge_references() {
            let u = e.source().index();
            let v = e.target().index();
            let w = -(e.weight().rate_effective.max(1e-12)).ln();
            
            // Only process if u is reachable from anchor and forms a negative cycle
            if dist[u] != f64::INFINITY && dist[u] + w < dist[v] - 1e-12 {
                // Found a negative cycle - use Floyd's algorithm to extract it properly
                let cycle = extract_cycle_from_node(v, &pred, max_hops);
                
                if !cycle.is_empty() {
                    // Check if cycle contains the anchor
                    if let Some(anchor_pos) = cycle.iter().position(|&node| node == anchor_idx) {
                        // Rotate cycle to start from anchor
                        let mut rotated_cycle = Vec::new();
                        rotated_cycle.extend_from_slice(&cycle[anchor_pos..]);
                        rotated_cycle.extend_from_slice(&cycle[..anchor_pos]);
                        
                        // Deduplicate by canonical string representation
                        let cycle_key = rotated_cycle.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("->");
                        if !seen_cycles.contains(&cycle_key) {
                            seen_cycles.insert(cycle_key);
                            all_cycles.push(DetectedCycle {
                                nodes: rotated_cycle,
                                log_sum: 0.0,
                            });
                        }
                    }
                }
            }
        }
    }
    
    all_cycles
}

#[derive(Clone, Debug)]
pub struct NearMissCycle {
    pub nodes: Vec<usize>,
    pub slack: f64,
}

/// Detect near-miss cycles using Bellman-Ford slack on the final pass.
/// Collect edges with small negative slack in [-epsilon, 0), and for each such edge (u->v)
/// attempt to backtrack predecessor chain from v to u (bounded by max_hops-1).
/// If a simple path v <- ... <- u exists within the bound, produce a cycle represented
/// by the forward path [u, ..., v] (the closing edge v->u is implied by cycle semantics).
pub fn detect_near_miss_cycles(
    g: &ArbGraph,
    epsilon: f64,
    max_hops: usize,
    top_k: usize,
) -> Vec<NearMissCycle> {
    let n = g.g.node_count();
    if n == 0 || max_hops < 3 {
        return vec![];
    }
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    // Standard BF relax V-1 times on -ln(rate)
    for _ in 0..(n.saturating_sub(1)) {
        let mut updated = false;
        for e in g.g.edge_references() {
            let u = e.source().index();
            let v = e.target().index();
            let w = -(e.weight().rate_effective.max(1e-12)).ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                updated = true;
            }
        }
        if !updated {
            break;
        }
    }
    // Gather candidate edges with small negative slack
    let mut cand: Vec<(usize, usize, f64)> = Vec::new(); // (u,v,slack)
    for e in g.g.edge_references() {
        let u = e.source().index();
        let v = e.target().index();
        let w = -(e.weight().rate_effective.max(1e-12)).ln();
        let slack = (dist[u] + w) - dist[v];
        // Consider small-magnitude slack in either direction as near-miss
        if slack != 0.0 && slack.abs() <= epsilon {
            cand.push((u, v, slack));
        }
    }
    // Sort by slack descending (closest to zero first)
    cand.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    cand.reverse();

    let mut out: Vec<NearMissCycle> = Vec::new();
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let limit = top_k.max(1).min(50);
    'outer: for (u, v, s) in cand.into_iter() {
        if out.len() >= limit {
            break;
        }
        // Backtrack pred from v to reach u within max_hops-1 steps
        let mut path_rev: Vec<usize> = Vec::new();
        let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut cur = v;
        path_rev.push(cur);
        visited.insert(cur);
        let mut ok = false;
        // First try strict predecessor backtrack
        for _ in 0..max_hops.saturating_sub(1) {
            if cur == u {
                ok = true;
                break;
            }
            if let Some(p) = pred[cur] {
                if visited.contains(&p) {
                    break;
                }
                path_rev.push(p);
                visited.insert(p);
                cur = p;
            } else {
                break;
            }
        }
        // If pred chain failed, attempt greedy backtrack over incoming edges minimizing slack
        if !ok {
            use petgraph::Direction::Incoming;
            path_rev.clear();
            visited.clear();
            cur = v;
            path_rev.push(cur);
            visited.insert(cur);
            for _ in 0..max_hops.saturating_sub(1) {
                if cur == u {
                    ok = true;
                    break;
                }
                let mut best_p: Option<(usize, f64)> = None;
                for e_in in
                    g.g.edges_directed(petgraph::graph::NodeIndex::new(cur), Incoming)
                {
                    let p = e_in.source().index();
                    if visited.contains(&p) {
                        continue;
                    }
                    let w = -(e_in.weight().rate_effective.max(1e-12)).ln();
                    let slack_here = (dist[p] + w) - dist[cur];
                    let score = slack_here.abs();
                    if best_p.as_ref().map(|(_, s)| score < *s).unwrap_or(true) {
                        best_p = Some((p, score));
                    }
                }
                if let Some((p, _)) = best_p {
                    path_rev.push(p);
                    visited.insert(p);
                    cur = p;
                } else {
                    break;
                }
            }
            if cur == u {
                ok = true;
            }
        }
        if !ok {
            continue;
        }
        // Build forward path [u, ..., v]
        path_rev.reverse();
        if path_rev.first().copied() != Some(u) || path_rev.last().copied() != Some(v) {
            continue;
        }
        // Enforce simple cycle length bounds (cycle length equals path_len)
        let clen = path_rev.len();
        if clen < 3 || clen > max_hops {
            continue;
        }
        // Deduplicate by canonical string of indices (rotation + direction agnostic)
        let canon = |v: &Vec<usize>| -> Vec<usize> {
            if v.is_empty() {
                return v.clone();
            }
            let n = v.len();
            let to_key = |arr: &Vec<usize>| -> (String, Vec<usize>) {
                let s = arr
                    .iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join("->");
                (s, arr.clone())
            };
            let mut best: Option<(String, Vec<usize>)> = None;
            for i in 0..n {
                let mut r = Vec::with_capacity(n);
                for k in 0..n {
                    r.push(v[(i + k) % n]);
                }
                let (key, arr) = to_key(&r);
                if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                    best = Some((key, arr));
                }
            }
            let mut vrev = v.clone();
            vrev.reverse();
            for i in 0..n {
                let mut r = Vec::with_capacity(n);
                for k in 0..n {
                    r.push(vrev[(i + k) % n]);
                }
                let (key, arr) = to_key(&r);
                if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                    best = Some((key, arr));
                }
            }
            best.unwrap().1
        };
        let canon_nodes = canon(&path_rev);
        let key = canon_nodes
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join("->");
        if seen_keys.contains(&key) {
            continue;
        }
        seen_keys.insert(key);
        out.push(NearMissCycle {
            nodes: canon_nodes,
            slack: s,
        });
        if out.len() >= limit {
            break 'outer;
        }
    }
    // If BF-based near-miss detection found nothing, fall back to simple triangle search
    if out.is_empty() && max_hops >= 3 {
        use petgraph::Direction::Outgoing;
        let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
        'tri: for u in g.g.node_indices() {
            for v in g.g.neighbors_directed(u, Outgoing) {
                for w in g.g.neighbors_directed(v, Outgoing) {
                    // Check closing edge w -> u
                    let mut r_uv = 0.0f64;
                    let mut r_vw = 0.0f64;
                    let mut r_wu = 0.0f64;
                    for e in g.g.edges_connecting(u, v) {
                        r_uv = r_uv.max(e.weight().rate_effective.max(0.0));
                    }
                    for e in g.g.edges_connecting(v, w) {
                        r_vw = r_vw.max(e.weight().rate_effective.max(0.0));
                    }
                    for e in g.g.edges_connecting(w, u) {
                        r_wu = r_wu.max(e.weight().rate_effective.max(0.0));
                    }
                    if r_uv <= 0.0 || r_vw <= 0.0 || r_wu <= 0.0 {
                        continue;
                    }
                    let prod = r_uv * r_vw * r_wu;
                    if prod >= 1.0 {
                        continue;
                    }
                    let shortfall = 1.0 - prod;
                    if shortfall <= epsilon {
                        let cyc = vec![u.index(), v.index(), w.index()];
                        // Canonicalize and dedupe (rotation+direction agnostic)
                        let canon = |v: &Vec<usize>| -> Vec<usize> {
                            if v.is_empty() {
                                return v.clone();
                            }
                            let n = v.len();
                            let to_key = |arr: &Vec<usize>| -> (String, Vec<usize>) {
                                let s = arr
                                    .iter()
                                    .map(|x| x.to_string())
                                    .collect::<Vec<_>>()
                                    .join("->");
                                (s, arr.clone())
                            };
                            let mut best: Option<(String, Vec<usize>)> = None;
                            for i in 0..n {
                                let mut r = Vec::with_capacity(n);
                                for k in 0..n {
                                    r.push(v[(i + k) % n]);
                                }
                                let (key, arr) = to_key(&r);
                                if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                                    best = Some((key, arr));
                                }
                            }
                            let mut vrev = v.clone();
                            vrev.reverse();
                            for i in 0..n {
                                let mut r = Vec::with_capacity(n);
                                for k in 0..n {
                                    r.push(vrev[(i + k) % n]);
                                }
                                let (key, arr) = to_key(&r);
                                if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                                    best = Some((key, arr));
                                }
                            }
                            best.unwrap().1
                        };
                        let canon_nodes = canon(&cyc);
                        let key = canon_nodes
                            .iter()
                            .map(|x| x.to_string())
                            .collect::<Vec<_>>()
                            .join("->");
                        if seen_keys.contains(&key) {
                            continue;
                        }
                        seen_keys.insert(key);
                        out.push(NearMissCycle {
                            nodes: canon_nodes,
                            slack: -shortfall.max(0.0),
                        });
                        if out.len() >= limit {
                            break 'tri;
                        }
                    }
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeData;

    fn mk_edge(dex: &str, rate: f64) -> EdgeData {
        EdgeData {
            rate_effective: rate,
            fee_bps: 0,
            liquidity: 1.0,
            dex: dex.to_string(),
            pool_id: String::new(),
            liquidity_display: 1.0,
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
            pool_kind: None,
        }
    }

    #[test]
    fn negative_cycle_detects_simple_two_edge_loop() {
        let mut g = ArbGraph::new();
        // A <-> B with product > 1.0 (2.0 * 0.6 = 1.2)
        g.upsert_edge("D", "A", "B", mk_edge("D", 2.0));
        g.upsert_edge("D", "B", "A", mk_edge("D", 0.6));
        let cycles = detect_negative_cycles(&g, 4);
        assert!(!cycles.is_empty());
    }

    #[test]
    fn filtered_detection_respects_scope() {
        use std::collections::HashSet;
        let mut g = ArbGraph::new();
        // A <-> B negative, plus C isolated chain
        g.upsert_edge("D", "A", "B", mk_edge("D", 2.0));
        g.upsert_edge("D", "B", "A", mk_edge("D", 0.6));
        g.upsert_edge("D", "B", "C", mk_edge("D", 1.0));
        // Map names to indices
        let ia = g.map.get("A").unwrap().index();
        let ib = g.map.get("B").unwrap().index();
        let ic = g.map.get("C").unwrap().index();
        let mut ab: HashSet<usize> = HashSet::new();
        ab.insert(ia);
        ab.insert(ib);
        let mut ac: HashSet<usize> = HashSet::new();
        ac.insert(ia);
        ac.insert(ic);
        let c_ab = detect_negative_cycles_filtered(&g, &ab, 4);
        assert!(!c_ab.is_empty());
        let c_ac = detect_negative_cycles_filtered(&g, &ac, 4);
        assert!(c_ac.is_empty());
    }

    #[test]
    fn detection_terminates_on_medium_graph() {
        let mut g = ArbGraph::new();
        let dex = "D";
        // Build a bidirectional chain with no arbitrage
        let n = 300usize;
        for i in 0..(n - 1) {
            let a = format!("N{}", i);
            let b = format!("N{}", i + 1);
            g.upsert_edge(dex, &a, &b, mk_edge(dex, 1.0));
            g.upsert_edge(dex, &b, &a, mk_edge(dex, 1.0));
        }
        let full = detect_negative_cycles(&g, 4);
        assert!(full.is_empty());
        // Filtered to a small subset should also terminate and be empty
        use std::collections::HashSet;
        let ia = g.map.get("N10").unwrap().index();
        let ib = g.map.get("N11").unwrap().index();
        let mut scope: HashSet<usize> = HashSet::new();
        scope.insert(ia);
        scope.insert(ib);
        let part = detect_negative_cycles_filtered(&g, &scope, 4);
        assert!(part.is_empty());
    }

    #[test]
    fn spfa_detects_simple_cycle() {
        let mut g = ArbGraph::new();
        // A <-> B with product > 1.0 (2.0 * 0.6 = 1.2)
        g.upsert_edge("D", "A", "B", mk_edge("D", 2.0));
        g.upsert_edge("D", "B", "A", mk_edge("D", 0.6));
        let cycles = detect_negative_cycles_spfa(&g, 4);
        assert!(!cycles.is_empty(), "SPFA should detect the negative cycle");
    }

    #[test]
    fn spfa_no_false_positives() {
        let mut g = ArbGraph::new();
        // A <-> B with product < 1.0 (0.9 * 0.9 = 0.81)
        g.upsert_edge("D", "A", "B", mk_edge("D", 0.9));
        g.upsert_edge("D", "B", "A", mk_edge("D", 0.9));
        let cycles = detect_negative_cycles_spfa(&g, 4);
        assert!(cycles.is_empty(), "SPFA should not detect false positive cycles");
    }

    #[test]
    fn spfa_filtered_respects_scope() {
        use std::collections::HashSet;
        let mut g = ArbGraph::new();
        // A <-> B negative cycle, C is isolated
        g.upsert_edge("D", "A", "B", mk_edge("D", 2.0));
        g.upsert_edge("D", "B", "A", mk_edge("D", 0.6));
        g.upsert_edge("D", "B", "C", mk_edge("D", 1.0));
        
        let ia = g.map.get("A").unwrap().index();
        let ib = g.map.get("B").unwrap().index();
        let ic = g.map.get("C").unwrap().index();
        
        // Scope to A and B - should find cycle
        let mut ab: HashSet<usize> = HashSet::new();
        ab.insert(ia);
        ab.insert(ib);
        let c_ab = detect_negative_cycles_spfa_filtered(&g, &ab, 4);
        assert!(!c_ab.is_empty(), "SPFA filtered should find cycle in A-B scope");
        
        // Scope to A and C - no cycle
        let mut ac: HashSet<usize> = HashSet::new();
        ac.insert(ia);
        ac.insert(ic);
        let c_ac = detect_negative_cycles_spfa_filtered(&g, &ac, 4);
        assert!(c_ac.is_empty(), "SPFA filtered should not find cycle in A-C scope");
    }

    #[test]
    fn spfa_terminates_on_large_graph() {
        let mut g = ArbGraph::new();
        let dex = "D";
        // Build a bidirectional chain with no arbitrage
        let n = 300usize;
        for i in 0..(n - 1) {
            let a = format!("N{}", i);
            let b = format!("N{}", i + 1);
            g.upsert_edge(dex, &a, &b, mk_edge(dex, 1.0));
            g.upsert_edge(dex, &b, &a, mk_edge(dex, 1.0));
        }
        let cycles = detect_negative_cycles_spfa(&g, 4);
        assert!(cycles.is_empty(), "SPFA should terminate and find no cycles in neutral graph");
    }
}
