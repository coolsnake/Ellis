use petgraph::visit::EdgeRef;
use crate::graph::{ArbGraph};

pub struct DetectedCycle {
    pub nodes: Vec<usize>,
    #[allow(dead_code)] pub log_sum: f64,
}

pub fn detect_negative_cycles(g: &ArbGraph) -> Vec<DetectedCycle> {
    // Bellman-Ford on -log(rate_effective) weights
    let n = g.g.node_count();
    if n == 0 { return vec![]; }
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    // Relax edges V-1 times
    for _ in 0..(n-1) {
        let mut updated = false;
        for e in g.g.edge_references() {
            let u = e.source().index();
            let v = e.target().index();
            let w = - (e.weight().rate_effective.max(1e-12)).ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                updated = true;
            }
        }
        if !updated { break; }
    }
    let mut cycles = Vec::new();
    // One more pass to find negative cycles
    for e in g.g.edge_references() {
        let u = e.source().index();
        let v = e.target().index();
        let w = - (e.weight().rate_effective.max(1e-12)).ln();
        if dist[u] + w < dist[v] - 1e-12 {
            // Found a cycle, backtrack
            let mut x = v;
            for _ in 0..n { x = pred[x].unwrap_or(x); }
            // collect cycle
            let mut cycle = Vec::new();
            let mut cur = x;
            loop {
                cycle.push(cur);
                cur = pred[cur].unwrap_or(cur);
                if cur == x || cycle.len() > n+5 { break; }
            }
            if cycle.len() >= 2 {
                cycle.reverse();
                cycles.push(DetectedCycle { nodes: cycle, log_sum: 0.0 });
            }
        }
    }
    cycles
}


#[derive(Clone, Debug)]
pub struct NearMissCycle {
    pub nodes: Vec<usize>,
    pub slack: f64,
    pub close_u: usize,
    pub close_v: usize,
}

/// Detect near-miss cycles using Bellman-Ford slack on the final pass.
/// Collect edges with small negative slack in [-epsilon, 0), and for each such edge (u->v)
/// attempt to backtrack predecessor chain from v to u (bounded by max_hops-1).
/// If a simple path v <- ... <- u exists within the bound, produce a cycle represented
/// by the forward path [u, ..., v] (the closing edge v->u is implied by cycle semantics).
pub fn detect_near_miss_cycles(g: &ArbGraph, epsilon: f64, max_hops: usize, top_k: usize) -> Vec<NearMissCycle> {
    let n = g.g.node_count();
    if n == 0 || max_hops < 3 { return vec![]; }
    let mut dist = vec![0.0f64; n];
    let mut pred: Vec<Option<usize>> = vec![None; n];
    // Standard BF relax V-1 times on -ln(rate)
    for _ in 0..(n.saturating_sub(1)) {
        let mut updated = false;
        for e in g.g.edge_references() {
            let u = e.source().index();
            let v = e.target().index();
            let w = - (e.weight().rate_effective.max(1e-12)).ln();
            if dist[u] + w < dist[v] - 1e-12 {
                dist[v] = dist[u] + w;
                pred[v] = Some(u);
                updated = true;
            }
        }
        if !updated { break; }
    }
    // Gather candidate edges with small negative slack
    let mut cand: Vec<(usize, usize, f64)> = Vec::new(); // (u,v,slack)
    for e in g.g.edge_references() {
        let u = e.source().index();
        let v = e.target().index();
        let w = - (e.weight().rate_effective.max(1e-12)).ln();
        let slack = (dist[u] + w) - dist[v];
        if slack < 0.0 && slack >= -epsilon {
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
        if out.len() >= limit { break; }
        // Backtrack pred from v to reach u within max_hops-1 steps
        let mut path_rev: Vec<usize> = Vec::new();
        let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut cur = v;
        path_rev.push(cur);
        visited.insert(cur);
        let mut ok = false;
        for _ in 0..max_hops.saturating_sub(1) {
            if cur == u { ok = true; break; }
            if let Some(p) = pred[cur] {
                if visited.contains(&p) { break; }
                path_rev.push(p);
                visited.insert(p);
                cur = p;
            } else {
                break;
            }
        }
        if !ok { continue; }
        // Build forward path [u, ..., v]
        path_rev.reverse();
        if path_rev.first().copied() != Some(u) || path_rev.last().copied() != Some(v) { continue; }
        // Enforce simple cycle length bounds (cycle length equals path_len)
        let clen = path_rev.len();
        if clen < 3 || clen > max_hops { continue; }
        // Deduplicate by canonical string of indices (rotation + direction agnostic)
        let canon = |v: &Vec<usize>| -> Vec<usize> {
            if v.is_empty() { return v.clone(); }
            let n = v.len();
            let to_key = |arr: &Vec<usize>| -> (String, Vec<usize>) {
                let s = arr.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("->");
                (s, arr.clone())
            };
            let mut best: Option<(String, Vec<usize>)> = None;
            for i in 0..n {
                let mut r = Vec::with_capacity(n);
                for k in 0..n { r.push(v[(i+k)%n]); }
                let (key, arr) = to_key(&r);
                if best.as_ref().map(|(s,_)| &key < s).unwrap_or(true) { best = Some((key, arr)); }
            }
            let mut vrev = v.clone(); vrev.reverse();
            for i in 0..n {
                let mut r = Vec::with_capacity(n);
                for k in 0..n { r.push(vrev[(i+k)%n]); }
                let (key, arr) = to_key(&r);
                if best.as_ref().map(|(s,_)| &key < s).unwrap_or(true) { best = Some((key, arr)); }
            }
            best.unwrap().1
        };
        let canon_nodes = canon(&path_rev);
        let key = canon_nodes.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("->");
        if seen_keys.contains(&key) { continue; }
        seen_keys.insert(key);
        out.push(NearMissCycle { nodes: canon_nodes, slack: s, close_u: u, close_v: v });
        if out.len() >= limit { break 'outer; }
    }
    out
}


