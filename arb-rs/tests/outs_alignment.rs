use arb_rs::utils::{rotate_to_start_num, compute_est_profit_usd};

#[test]
fn rotates_numeric_array_with_labels() {
    let labels_orig = vec!["C".to_string(), "A".to_string(), "B".to_string()];
    let labels_canon = vec!["A".to_string(), "B".to_string(), "C".to_string()];
    let mut s = vec![10.0, 20.0, 30.0];
    rotate_to_start_num(&labels_orig, &labels_canon, &mut s);
    assert_eq!(s, vec![20.0, 30.0, 10.0]);
}

#[test]
fn usd_profit_from_last_out_minus_notional() {
    let start_is_usdc = true;
    let notional = 50.0;
    // Suppose rates r1=1.1, r2=0.9, r3=1.01 → product ≈ 0.9999, nearly flat
    // outs compute cumulatively from 50
    let outs = vec![55.0, 49.5, 49.995];
    let usd = compute_est_profit_usd(start_is_usdc, notional, &outs);
    let expected = outs.last().unwrap() - notional;
    assert!((usd - expected).abs() < 1e-9);
}


