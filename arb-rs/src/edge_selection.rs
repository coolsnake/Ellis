//! Exhaustive edge combination selection for arbitrage cycles.
//!
//! This module provides functions to find the globally optimal combination of edges
//! for a detected cycle, rather than greedily selecting the best edge at each hop.

use crate::graph::{ArbGraph, EdgeData};
use petgraph::graph::NodeIndex;

/// Represents a selected edge for one hop in a cycle
#[derive(Clone, Debug)]
pub struct SelectedEdge {
    pub dex: String,
    pub pool_id: String,
    pub rate_effective: f64,
    pub liquidity: f64,
    pub liquidity_display: f64,
    pub fee_bps: i64,
}

impl From<&EdgeData> for SelectedEdge {
    fn from(data: &EdgeData) -> Self {
        SelectedEdge {
            dex: data.dex.clone(),
            pool_id: data.pool_id.clone(),
            rate_effective: data.rate_effective,
            liquidity: data.liquidity,
            liquidity_display: data.liquidity_display,
            fee_bps: data.fee_bps,
        }
    }
}

/// Result of selecting the best edge combination for a cycle
#[derive(Clone, Debug)]
pub struct CycleEdgeSelection {
    pub edges: Vec<SelectedEdge>,
    pub rate_product: f64,
    pub min_liquidity: f64,
}

/// Internal struct to hold edge data during enumeration
#[derive(Clone)]
struct EdgeCandidate {
    data: SelectedEdge,
}

/// Select the best combination of edges for a cycle by checking all (or top-K) combinations.
///
/// # Arguments
/// * `graph` - The arbitrage graph
/// * `cycle_nodes` - Node indices forming the cycle (e.g., [0, 5, 12] for a 3-hop cycle)
/// * `min_liquidity_threshold` - Minimum liquidity required for an edge to be considered
/// * `max_combinations` - Safety cap on total combinations to enumerate
/// * `top_k_per_hop` - When combinations exceed max, keep only top-K edges per hop
///
/// # Returns
/// The best edge combination if one exists, or None if no valid path exists
pub fn select_best_edge_combination(
    graph: &ArbGraph,
    cycle_nodes: &[usize],
    min_liquidity_threshold: f64,
    max_combinations: usize,
    top_k_per_hop: usize,
) -> Option<CycleEdgeSelection> {
    let cycle_len = cycle_nodes.len();
    if cycle_len < 2 {
        return None;
    }

    // 1. Collect all valid edges for each hop
    let mut edges_per_hop: Vec<Vec<EdgeCandidate>> = Vec::with_capacity(cycle_len);

    for i in 0..cycle_len {
        let u_idx = cycle_nodes[i];
        let v_idx = cycle_nodes[(i + 1) % cycle_len];

        // Validate indices
        if u_idx >= graph.g.node_count() || v_idx >= graph.g.node_count() {
            return None;
        }

        let u = NodeIndex::new(u_idx);
        let v = NodeIndex::new(v_idx);

        let mut hop_edges: Vec<EdgeCandidate> = graph
            .g
            .edges_connecting(u, v)
            .filter(|e| e.weight().liquidity > min_liquidity_threshold)
            .filter(|e| e.weight().rate_effective > 0.0)
            .map(|e| EdgeCandidate {
                data: SelectedEdge::from(e.weight()),
            })
            .collect();

        if hop_edges.is_empty() {
            return None; // No valid path
        }

        // Sort by rate descending for consistent ordering
        hop_edges.sort_by(|a, b| {
            b.data
                .rate_effective
                .partial_cmp(&a.data.rate_effective)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        edges_per_hop.push(hop_edges);
    }

    // 2. Calculate total combinations
    let total_combinations: usize = edges_per_hop
        .iter()
        .map(|v| v.len())
        .fold(1usize, |acc, len| acc.saturating_mul(len));

    // 3. If too many combinations, truncate to top-K per hop
    if total_combinations > max_combinations {
        for hop_edges in &mut edges_per_hop {
            hop_edges.truncate(top_k_per_hop);
        }
    }

    // 4. Enumerate all combinations using odometer-style iteration
    let mut best_product = 0.0f64;
    let mut best_selection: Option<CycleEdgeSelection> = None;

    let mut indices = vec![0usize; cycle_len];

    loop {
        // Check for duplicate pool_ids in this combination
        // Using the same pool on multiple hops is impossible to execute atomically
        let mut pool_ids_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut has_duplicate_pool = false;

        for (hop, &edge_idx) in indices.iter().enumerate() {
            let pool_id = &edges_per_hop[hop][edge_idx].data.pool_id;
            
            // Skip empty pool_ids (Link edges don't have real pool_ids)
            if !pool_id.is_empty() {
                // Strip #rev suffix to treat forward/reverse as same pool
                let base_pool_id = pool_id.strip_suffix("#rev").unwrap_or(pool_id.as_str()).to_string();
                if !pool_ids_seen.insert(base_pool_id) {
                    has_duplicate_pool = true;
                    break;
                }
            }
        }

        // Skip combinations with duplicate pools
        if has_duplicate_pool {
            // Increment indices (odometer style) and continue
            let mut carry = true;
            for i in 0..cycle_len {
                if carry {
                    indices[i] += 1;
                    if indices[i] >= edges_per_hop[i].len() {
                        indices[i] = 0;
                    } else {
                        carry = false;
                    }
                }
            }
            if carry {
                break;
            }
            continue;
        }

        // Calculate product and min liquidity for this combination
        let mut product = 1.0f64;
        let mut min_liq = f64::MAX;

        for (hop, &edge_idx) in indices.iter().enumerate() {
            let edge = &edges_per_hop[hop][edge_idx];
            product *= edge.data.rate_effective;
            min_liq = min_liq.min(edge.data.liquidity);
        }

        // Update best if this combination is better
        if product > best_product {
            best_product = product;
            let edges: Vec<SelectedEdge> = indices
                .iter()
                .enumerate()
                .map(|(hop, &edge_idx)| edges_per_hop[hop][edge_idx].data.clone())
                .collect();

            best_selection = Some(CycleEdgeSelection {
                edges,
                rate_product: product,
                min_liquidity: if min_liq == f64::MAX { 0.0 } else { min_liq },
            });
        }

        // Increment indices (odometer style)
        let mut carry = true;
        for i in 0..cycle_len {
            if carry {
                indices[i] += 1;
                if indices[i] >= edges_per_hop[i].len() {
                    indices[i] = 0;
                } else {
                    carry = false;
                }
            }
        }

        // All combinations exhausted
        if carry {
            break;
        }
    }

    best_selection
}

/// Quick check if a cycle has any valid edges (used for early rejection)
pub fn cycle_has_valid_path(
    graph: &ArbGraph,
    cycle_nodes: &[usize],
    min_liquidity_threshold: f64,
) -> bool {
    let cycle_len = cycle_nodes.len();
    if cycle_len < 2 {
        return false;
    }

    for i in 0..cycle_len {
        let u_idx = cycle_nodes[i];
        let v_idx = cycle_nodes[(i + 1) % cycle_len];

        if u_idx >= graph.g.node_count() || v_idx >= graph.g.node_count() {
            return false;
        }

        let u = NodeIndex::new(u_idx);
        let v = NodeIndex::new(v_idx);

        let has_valid_edge = graph
            .g
            .edges_connecting(u, v)
            .any(|e| e.weight().liquidity > min_liquidity_threshold && e.weight().rate_effective > 0.0);

        if !has_valid_edge {
            return false;
        }
    }

    true
}

/// Get the best rate between two nodes (for compatibility with existing code patterns)
pub fn best_rate_between(
    graph: &ArbGraph,
    u_idx: usize,
    v_idx: usize,
    min_liquidity_threshold: f64,
) -> f64 {
    if u_idx >= graph.g.node_count() || v_idx >= graph.g.node_count() {
        return 0.0;
    }

    let u = NodeIndex::new(u_idx);
    let v = NodeIndex::new(v_idx);

    graph
        .g
        .edges_connecting(u, v)
        .filter(|e| e.weight().liquidity > min_liquidity_threshold)
        .map(|e| e.weight().rate_effective.max(1e-12))
        .fold(0.0f64, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeData;

    fn make_edge(rate: f64, liquidity: f64, dex: &str, pool_id: &str) -> EdgeData {
        EdgeData {
            rate_effective: rate,
            fee_bps: 30,
            liquidity,
            dex: dex.to_string(),
            pool_id: pool_id.to_string(),
            liquidity_display: liquidity,
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
        }
    }

    #[test]
    fn test_single_edge_per_hop() {
        let mut g = ArbGraph::new();
        // Simple 3-hop cycle: A -> B -> C -> A
        g.upsert_edge("D1", "A", "B", make_edge(1.01, 1000.0, "D1", "P1"));
        g.upsert_edge("D1", "B", "C", make_edge(1.02, 1000.0, "D1", "P2"));
        g.upsert_edge("D1", "C", "A", make_edge(0.99, 1000.0, "D1", "P3"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();
        let c = g.map.get("C").unwrap().index();

        let result = select_best_edge_combination(&g, &[a, b, c], 0.0, 10000, 5);
        assert!(result.is_some());

        let sel = result.unwrap();
        assert_eq!(sel.edges.len(), 3);
        // 1.01 * 1.02 * 0.99 ≈ 1.0199
        assert!((sel.rate_product - 1.0199).abs() < 0.001);
    }

    #[test]
    fn test_multiple_edges_finds_best_combination() {
        let mut g = ArbGraph::new();
        // A -> B: Two pools
        //   Pool 1: rate 1.01, low liquidity
        //   Pool 2: rate 1.005, high liquidity
        g.upsert_edge("D1", "A", "B", make_edge(1.01, 100.0, "D1", "P1"));
        g.upsert_edge("D2", "A", "B", make_edge(1.005, 10000.0, "D2", "P2"));

        // B -> C: Two pools
        g.upsert_edge("D1", "B", "C", make_edge(1.008, 100.0, "D1", "P3"));
        g.upsert_edge("D2", "B", "C", make_edge(1.004, 10000.0, "D2", "P4"));

        // C -> A: Single pool
        g.upsert_edge("D1", "C", "A", make_edge(0.998, 5000.0, "D1", "P5"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();
        let c = g.map.get("C").unwrap().index();

        let result = select_best_edge_combination(&g, &[a, b, c], 0.0, 10000, 5);
        assert!(result.is_some());

        let sel = result.unwrap();
        // Should find: P1 (1.01) -> P3 (1.008) -> P5 (0.998) = 1.01598
        // Better than: P2 (1.005) -> P4 (1.004) -> P5 (0.998) = 1.00699
        assert_eq!(sel.edges.len(), 3);
        assert_eq!(sel.edges[0].pool_id, "P1");
        assert_eq!(sel.edges[1].pool_id, "P3");
        assert_eq!(sel.edges[2].pool_id, "P5");
    }

    #[test]
    fn test_respects_liquidity_threshold() {
        let mut g = ArbGraph::new();
        // A -> B: High rate but below liquidity threshold
        g.upsert_edge("D1", "A", "B", make_edge(1.05, 10.0, "D1", "P1"));
        // A -> B: Lower rate but above threshold
        g.upsert_edge("D2", "A", "B", make_edge(1.01, 1000.0, "D2", "P2"));

        g.upsert_edge("D1", "B", "A", make_edge(0.99, 1000.0, "D1", "P3"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();

        // With threshold 100, should only see P2
        let result = select_best_edge_combination(&g, &[a, b], 100.0, 10000, 5);
        assert!(result.is_some());
        let sel = result.unwrap();
        assert_eq!(sel.edges[0].pool_id, "P2");
    }

    #[test]
    fn test_combination_cap() {
        let mut g = ArbGraph::new();
        // Create many parallel edges
        for i in 0..10 {
            let rate = 1.0 + (i as f64) * 0.001;
            g.upsert_edge(
                &format!("D{}", i),
                "A",
                "B",
                make_edge(rate, 1000.0, &format!("D{}", i), &format!("P{}", i)),
            );
        }
        g.upsert_edge("D1", "B", "A", make_edge(0.99, 1000.0, "D1", "PX"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();

        // With max_combinations=5, top_k=3, should limit to top 3 edges
        let result = select_best_edge_combination(&g, &[a, b], 0.0, 5, 3);
        assert!(result.is_some());
        // Should still find the best (D9 has highest rate 1.009)
        let sel = result.unwrap();
        assert_eq!(sel.edges[0].pool_id, "P9");
    }

    #[test]
    fn test_no_valid_path() {
        let mut g = ArbGraph::new();
        g.upsert_edge("D1", "A", "B", make_edge(1.01, 1000.0, "D1", "P1"));
        // No edge B -> A

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();

        let result = select_best_edge_combination(&g, &[a, b], 0.0, 10000, 5);
        assert!(result.is_none());
    }

    #[test]
    fn test_cycle_has_valid_path() {
        let mut g = ArbGraph::new();
        g.upsert_edge("D1", "A", "B", make_edge(1.01, 1000.0, "D1", "P1"));
        g.upsert_edge("D1", "B", "A", make_edge(0.99, 1000.0, "D1", "P2"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();

        assert!(cycle_has_valid_path(&g, &[a, b], 0.0));
        assert!(!cycle_has_valid_path(&g, &[a, b], 5000.0)); // Above liquidity threshold
    }

    #[test]
    fn test_rejects_duplicate_pool_in_cycle() {
        let mut g = ArbGraph::new();
        // Create a cycle where the same pool (P1) would be used on multiple hops
        // This is impossible to execute atomically
        // A -> B via P1, B -> C via P1 (same pool!), C -> A via P3
        g.upsert_edge("D1", "A", "B", make_edge(1.5, 1000.0, "D1", "P1"));  // Best rate for A->B
        g.upsert_edge("D1", "B", "C", make_edge(1.5, 1000.0, "D1", "P1"));  // Same pool P1!
        g.upsert_edge("D1", "C", "A", make_edge(0.5, 1000.0, "D1", "P3"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();
        let c = g.map.get("C").unwrap().index();

        // Should return None because the only available combination uses P1 twice
        let result = select_best_edge_combination(&g, &[a, b, c], 0.0, 10000, 5);
        assert!(result.is_none(), "Should reject cycle with duplicate pool");
    }

    #[test]
    fn test_selects_alternative_when_best_has_duplicate_pool() {
        let mut g = ArbGraph::new();
        // A -> B: Two options
        //   P1 with best rate 1.5
        //   P2 with lower rate 1.1
        g.upsert_edge("D1", "A", "B", make_edge(1.5, 1000.0, "D1", "P1"));
        g.upsert_edge("D2", "A", "B", make_edge(1.1, 1000.0, "D2", "P2"));

        // B -> C: Only P1 available (would cause duplicate if P1 used on first hop)
        g.upsert_edge("D1", "B", "C", make_edge(1.2, 1000.0, "D1", "P1"));

        // C -> A: P3
        g.upsert_edge("D1", "C", "A", make_edge(0.8, 1000.0, "D1", "P3"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();
        let c = g.map.get("C").unwrap().index();

        let result = select_best_edge_combination(&g, &[a, b, c], 0.0, 10000, 5);
        assert!(result.is_some(), "Should find valid combination using P2 instead of P1");

        let sel = result.unwrap();
        // Should use P2 for A->B (even though P1 has better rate) to avoid duplicate
        assert_eq!(sel.edges[0].pool_id, "P2");
        assert_eq!(sel.edges[1].pool_id, "P1");
        assert_eq!(sel.edges[2].pool_id, "P3");
        // Product: 1.1 * 1.2 * 0.8 = 1.056
        assert!((sel.rate_product - 1.056).abs() < 0.001);
    }

    #[test]
    fn test_rejects_duplicate_pool_with_rev_suffix() {
        let mut g = ArbGraph::new();
        // Test that P1 and P1#rev are treated as the same pool
        g.upsert_edge("D1", "A", "B", make_edge(1.5, 1000.0, "D1", "P1"));
        g.upsert_edge("D1", "B", "C", make_edge(1.5, 1000.0, "D1", "P1#rev")); // Same pool, reverse direction
        g.upsert_edge("D1", "C", "A", make_edge(0.5, 1000.0, "D1", "P3"));

        let a = g.map.get("A").unwrap().index();
        let b = g.map.get("B").unwrap().index();
        let c = g.map.get("C").unwrap().index();

        // Should return None because P1 and P1#rev are the same pool
        let result = select_best_edge_combination(&g, &[a, b, c], 0.0, 10000, 5);
        assert!(result.is_none(), "Should reject cycle with P1 and P1#rev as duplicate");
    }
}
