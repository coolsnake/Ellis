use arb_rs::graph::{ArbGraph, EdgeData};

#[test]
fn triangle_consistency() {
    // USDC -> SOL -> X -> USDC should yield product near (1 - sum fees) within tolerance
    let mut g = ArbGraph::new();
    let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string();
    let sol  = "So11111111111111111111111111111111111111112".to_string();
    let x    = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn".to_string();
    let f1 = 10i64; let f2 = 20i64; let f3 = 5i64; let liq = 1.0;
    // Use post-inversion effective rates directly
    g.upsert_edge("Raydium", &usdc, &sol, EdgeData{ rate_effective: 200.0*(1.0-(f1 as f64)/10_000.0), fee_bps: f1, liquidity: liq, dex: "Raydium".into(), pool_id: "t1".into(), liquidity_display: liq });
    g.upsert_edge("Raydium", &sol, &x,     EdgeData{ rate_effective: 1000.0*(1.0-(f2 as f64)/10_000.0), fee_bps: f2, liquidity: liq, dex: "Raydium".into(), pool_id: "t2".into(), liquidity_display: liq });
    g.upsert_edge("Raydium", &x,    &usdc,  EdgeData{ rate_effective: 0.0005*(1.0-(f3 as f64)/10_000.0), fee_bps: f3, liquidity: liq, dex: "Raydium".into(), pool_id: "t3".into(), liquidity_display: liq });
    let mut prod = 1.0;
    for (u,v) in vec![(&usdc,&sol), (&sol,&x), (&x,&usdc)] { for e in g.g.edges_connecting(g.node_index(u), g.node_index(v)) { prod *= e.weight().rate_effective; } }
    let exp = (1.0-(f1 as f64)/10_000.0) * (1.0-(f2 as f64)/10_000.0) * (1.0-(f3 as f64)/10_000.0);
    assert!(prod/exp > 0.98 && prod/exp < 1.02, "prod={}, exp={}", prod, exp);
}


