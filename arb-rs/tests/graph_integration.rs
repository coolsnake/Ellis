use arb_rs::algos::{detect_near_miss_cycles, detect_negative_cycles};
use arb_rs::graph::{ArbGraph, EdgeData};
use arb_rs::opportunities::{OpportunitiesResponse, OpportunitiesSummary, Opportunity};
use std::collections::HashSet;

fn edge(rate: f64, dex: &str) -> EdgeData {
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
        capacity_input_raw: None,
        pool_kind: None,
        slippage_curve: None,
        source_price_usd: None,
        target_price_usd: None,
    }
}

#[test]
fn detects_simple_two_edge_arbitrage() {
    let mut g = ArbGraph::new();
    g.upsert_edge("D", "A", "B", edge(2.0, "D"));
    g.upsert_edge("D", "B", "A", edge(0.6, "D"));
    let cycles = detect_negative_cycles(&g, 4);
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

    // Sanity: build a minimal near-miss opportunity and ensure tagging field is available
    let o = Opportunity {
        path: vec!["A".into(), "B".into(), "C".into(), "A".into()],
        profit_bps: 5,
        net_bps: Some(5),
        est_profit_usd: 1.0,
        size_usd: None,
        size_tokens: None,
        size_tokens_raw: None,
        start_decimals: None,
        dexes: vec!["X".into(), "Y".into(), "Z".into()],
        hop_dexes: None,
        hop_rates: None,
        hop_outs: None,
        hop_pool_ids: None,
        hop_fee_bps: None,
        hop_liquidity_display: None,
        hop_count: Some(3),
        rate_product: None,
        link_edges_used: None,
        link_penalty_bps_total: None,
        min_edge_liquidity: None,
        est_capacity: None,
        bottleneck: None,
        detected_ms: None,
        first_seen_ms: None,
        last_verified_ms: None,
        detections: None,
        bf_slack_log: None,
        bf_required_rate: None,
        bf_rate_delta_bps: None,
        is_near_miss: Some(true),
    };
    let resp = OpportunitiesResponse {
        items: vec![],
        near_items: Some(vec![o.clone()]),
        summary: Some(OpportunitiesSummary {
            count: 0,
            max_profit_bps: 0,
            avg_profit_bps: 0.0,
            avg_net_bps: 0.0,
            avg_hop_count: 0.0,
            avg_link_edges_used: 0.0,
            min_edge_liquidity_avg: 0.0,
            min_edge_liquidity_min: 0.0,
            last_detection_ms: 0,
            detection_duration_ms: 0,
            diff_to_detect_ms: 0,
            graph_nodes: 0,
            graph_edges: 0,
            near_miss: None,
            near_miss_shortfall_bps: None,
            near_misses: None,
            rejected_opportunities: None,
        }),
    };
    assert!(resp.near_items.unwrap()[0].is_near_miss.unwrap());
}
