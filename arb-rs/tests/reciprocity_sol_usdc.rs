use arb_rs::graph::{ArbGraph, EdgeData};

#[test]
fn reciprocity_sol_usdc() {
    // Build a tiny graph with two edges (USDC->SOL and SOL->USDC) as if ingested from backend
    let mut g = ArbGraph::new();
    let a = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(); // USDC
    let b = "So11111111111111111111111111111111111111112".to_string(); // SOL
                                                                       // Backend sends A-per-1-B; here we set both orientations:
                                                                       // USDC->SOL: price_a_per_b = 200 (USDC per 1 SOL) => base B/A = 1/200
    let fee_a = 10i64; // 10 bps
    let fee_b = 10i64;
    let liq = 1.0;
    g.upsert_edge(
        "Raydium",
        &a,
        &b,
        EdgeData {
            rate_effective: (1.0 / 200.0) * (1.0 - (fee_a as f64) / 10_000.0),
            fee_bps: fee_a,
            liquidity: liq,
            dex: "Raydium".into(),
            pool_id: "pid".into(),
            liquidity_display: liq,
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
        },
    );
    g.upsert_edge(
        "Raydium",
        &b,
        &a,
        EdgeData {
            rate_effective: 200.0 * (1.0 - (fee_b as f64) / 10_000.0),
            fee_bps: fee_b,
            liquidity: liq,
            dex: "Raydium".into(),
            pool_id: "pid-rev".into(),
            liquidity_display: liq,
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
        },
    );
    // Product should match (1-fees)
    let mut fwd = 0.0;
    let mut rev = 0.0;
    for e in g.g.edge_references() {
        let w = e.weight();
        if w.pool_id == "pid" {
            fwd = w.rate_effective;
        }
        if w.pool_id == "pid-rev" {
            rev = w.rate_effective;
        }
    }
    let exp = (1.0 - (fee_a as f64) / 10_000.0) * (1.0 - (fee_b as f64) / 10_000.0);
    let prod = fwd * rev;
    assert!(
        prod / exp > 0.99 && prod / exp < 1.01,
        "prod={}, exp={}",
        prod,
        exp
    );
}
