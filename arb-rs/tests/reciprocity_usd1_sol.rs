use arb_rs::graph::{ArbGraph, EdgeData};

#[test]
fn reciprocity_usd1_sol() {
    let mut g = ArbGraph::new();
    let usd1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB".to_string();
    let sol = "So11111111111111111111111111111111111111112".to_string();
    // Assume backend oriented forward SOL->USD1 ~ 1/200; here we store detector rates directly
    let fee_a = 5i64; let fee_b = 5i64; let liq = 1.0;
    g.upsert_edge("Meteora", &sol, &usd1, EdgeData { rate_effective: (1.0/200.0)*(1.0 - (fee_a as f64)/10_000.0), fee_bps: fee_a, liquidity: liq, dex: "Meteora".into(), pool_id: "m1".into(), liquidity_display: liq });
    g.upsert_edge("Meteora", &usd1, &sol, EdgeData { rate_effective: 200.0*(1.0 - (fee_b as f64)/10_000.0), fee_bps: fee_b, liquidity: liq, dex: "Meteora".into(), pool_id: "m1-rev".into(), liquidity_display: liq });
    let mut fwd = 0.0; let mut rev = 0.0;
    for e in g.g.edge_references() { let w = e.weight(); if w.pool_id=="m1" { fwd = w.rate_effective; } if w.pool_id=="m1-rev" { rev = w.rate_effective; } }
    let exp = (1.0 - (fee_a as f64)/10_000.0) * (1.0 - (fee_b as f64)/10_000.0);
    let prod = fwd * rev;
    assert!(prod/exp > 0.99 && prod/exp < 1.01, "prod={}, exp={}", prod, exp);
}


