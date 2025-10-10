use arb_rs::graph::{ArbGraph, EdgeData};
use arb_rs::algos::{detect_negative_cycles, detect_near_miss_cycles};
use std::collections::HashSet;

fn edge(rate: f64, dex: &str) -> EdgeData {
    EdgeData { rate_effective: rate, fee_bps: 0, liquidity: 1.0, dex: dex.to_string(), pool_id: String::new(), liquidity_display: 1.0 }
}

#[test]
fn detects_simple_two_edge_arbitrage() {
    let mut g = ArbGraph::new();
    g.upsert_edge("D", "A", "B", edge(2.0, "D"));
    g.upsert_edge("D", "B", "A", edge(0.6, "D"));
    let cycles = detect_negative_cycles(&g);
    assert!(!cycles.is_empty());
}

#[test]
fn near_miss_finds_almost_profitable_triangle() {
    let mut g = ArbGraph::new();
    g.upsert_edge("D", "A", "B", edge(1.10, "D"));
    g.upsert_edge("D", "B", "C", edge(0.90, "D"));
    g.upsert_edge("D", "C", "A", edge(1.005, "D"));
    let near = detect_near_miss_cycles(&g, 0.02, 6, 5);
    assert!(!near.is_empty());
    // scope example (currently not used by near_miss function, but prepared for future):
    let ia = g.map.get("A").unwrap().index();
    let ib = g.map.get("B").unwrap().index();
    let ic = g.map.get("C").unwrap().index();
    let _scope: HashSet<usize> = [ia, ib, ic].into_iter().collect();
}


