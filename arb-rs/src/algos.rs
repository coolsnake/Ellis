use crate::graph::ArbGraph;
use petgraph::visit::EdgeRef;
use std::collections::HashSet;

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
            // Found a cycle, backtrack
            let mut x = v;
            // Limit backtracking to max_hops to find the cycle start
            let max_backtrack = max_hops.min(n);
            for _ in 0..max_backtrack {
                if let Some(p) = pred[x] {
                    x = p;
                } else {
                    break;
                }
            }
            // collect cycle
            let mut cycle = Vec::new();
            let mut cur = x;
            loop {
                cycle.push(cur);
                // Early exit if cycle exceeds max_hops
                if cycle.len() > max_hops {
                    break;
                }
                if let Some(p) = pred[cur] {
                    cur = p;
                } else {
                    // No predecessor means we can't continue the cycle
                    break;
                }
                if cur == x || cycle.len() > max_hops {
                    break;
                }
            }
            // Only add cycles that respect max_hops (and are at least 2 nodes)
            if cycle.len() >= 2 && cycle.len() <= max_hops {
                cycle.reverse();
                cycles.push(DetectedCycle {
                    nodes: cycle,
                    log_sum: 0.0,
                });
            }
        }
    }
    cycles
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
            // Found a cycle, backtrack
            let mut x = v;
            // Limit backtracking to max_hops
            let max_backtrack = max_hops.min(n);
            for _ in 0..max_backtrack {
                if let Some(p) = pred[x] {
                    x = p;
                } else {
                    break;
                }
            }
            // collect cycle
            let mut cycle = Vec::new();
            let mut cur = x;
            loop {
                cycle.push(cur);
                // Early exit if cycle exceeds max_hops
                if cycle.len() > max_hops {
                    break;
                }
                if let Some(p) = pred[cur] {
                    cur = p;
                } else {
                    break;
                }
                if cur == x || cycle.len() > max_hops {
                    break;
                }
            }
            // Only add cycles that respect max_hops
            if cycle.len() >= 2 && cycle.len() <= max_hops {
                cycle.reverse();
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
                // Found a negative cycle, backtrack to find the cycle
                let mut x = v;
                let max_backtrack = max_hops.min(n);
                for _ in 0..max_backtrack {
                    if let Some(p) = pred[x] {
                        x = p;
                    } else {
                        break;
                    }
                }
                
                // Collect the cycle starting from x
                let mut cycle = Vec::new();
                let mut cur = x;
                loop {
                    cycle.push(cur);
                    if cycle.len() > max_hops {
                        break;
                    }
                    if let Some(p) = pred[cur] {
                        cur = p;
                    } else {
                        break;
                    }
                    if cur == x || cycle.len() > max_hops {
                        break;
                    }
                }
                
                if cycle.len() >= 2 && cycle.len() <= max_hops {
                    cycle.reverse();
                    
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
}
