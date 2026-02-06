//! Slippage-aware output computation for multi-hop trades.
//!
//! This module provides functions to compute actual output amounts
//! accounting for price impact (slippage) based on reserves and trade size.
//!
//! Currently supports:
//! - AMM/CPMM (constant product xy=k) - full support
//! - CLMM/DLMM - adaptive blend using trade-size-weighted AMM approximation

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct SlippageCurve {
    pub unit: Option<String>, // expected "usd" or "source"
    pub sizes: Option<Vec<f64>>,
    pub mults: Option<Vec<f64>>,
    pub computed_at: Option<u64>,
    pub confidence: Option<String>,
    pub source: Option<String>,
}

/// Parse reserve string to f64, accounting for decimals.
/// Raw reserves are stored as string to preserve precision for large values.
///
/// # Arguments
/// * `raw` - Optional string representation of the raw reserve
/// * `decimals` - Number of decimal places for the token
///
/// # Returns
/// Reserve amount as f64, or 0.0 if parsing fails
pub fn parse_reserve(raw: &Option<String>, decimals: i64) -> f64 {
    match raw {
        Some(s) => {
            // Try parsing as u128 first for large values
            if let Ok(val) = s.parse::<u128>() {
                let divisor = 10u128.pow(decimals.max(0) as u32);
                (val as f64) / (divisor as f64)
            } else if let Ok(val) = s.parse::<f64>() {
                // Fallback to f64 parsing
                val / 10f64.powi(decimals.max(0) as i32)
            } else {
                0.0
            }
        }
        None => 0.0,
    }
}

/// Compute output for a constant-product AMM (xy=k).
///
/// Formula: output = reserve_out * effective_input / (reserve_in + effective_input)
/// where effective_input = input * (1 - fee_bps / 10000)
///
/// For constant product AMM:
/// - After trade: (reserve_in + input)(reserve_out - output) = k = reserve_in * reserve_out
/// - Solving: output = reserve_out * input / (reserve_in + input)
/// - With fee applied to input
///
/// # Arguments
/// * `input` - Input amount (in same units as reserves)
/// * `reserve_in` - Reserve of input token
/// * `reserve_out` - Reserve of output token
/// * `fee_bps` - Fee in basis points
///
/// # Returns
/// Output amount after slippage and fees
pub fn compute_amm_output(input: f64, reserve_in: f64, reserve_out: f64, fee_bps: i64) -> f64 {
    if input <= 0.0 || reserve_in <= 0.0 || reserve_out <= 0.0 {
        return 0.0;
    }

    // Apply fee to input
    let fee_multiplier = 1.0 - (fee_bps as f64) / 10_000.0;
    let effective_input = input * fee_multiplier.max(0.0);

    // Constant product formula
    let output = (reserve_out * effective_input) / (reserve_in + effective_input);

    output.max(0.0)
}

/// Blend spot and AMM outputs using an adaptive weight based on trade size.
///
/// This provides a more accurate slippage approximation for CLMM/DLMM than
/// fixed ratios by scaling the AMM contribution with trade size vs reserves.
fn blend_spot_amm_output(
    input: f64,
    reserve_in: f64,
    reserve_out: f64,
    fee_bps: i64,
    spot_rate: f64,
    curve_exponent: f64,
) -> f64 {
    if input <= 0.0 || reserve_in <= 0.0 || reserve_out <= 0.0 || spot_rate <= 0.0 {
        return input * spot_rate;
    }

    let spot_output = input * spot_rate;
    let amm_output = compute_amm_output(input, reserve_in, reserve_out, fee_bps);

    // Trade ratio normalized to [0,1): larger trades get more AMM-like slippage.
    let ratio = (input / (reserve_in + input)).max(0.0).min(1.0);
    let weight = ratio.powf(curve_exponent).min(1.0);

    spot_output * (1.0 - weight) + amm_output * weight
}

fn interpolate_curve(curve: &SlippageCurve, input: f64) -> Option<f64> {
    if !(input.is_finite() && input > 0.0) {
        return None;
    }
    let sizes = curve.sizes.as_ref()?;
    let mults = curve.mults.as_ref()?;
    if sizes.len() < 2 || sizes.len() != mults.len() {
        return None;
    }

    // Assume sizes are sorted ascending in backend
    if input <= sizes[0] {
        return Some(mults[0]);
    }
    let last = sizes.len() - 1;
    if input >= sizes[last] {
        // Beyond the curve range — return None so the caller falls through to
        // the reserve-based AMM formula which handles arbitrary sizes correctly.
        // Previously this returned the last multiplier (flat extrapolation),
        // which severely underestimated slippage for large trades.
        return None;
    }

    for i in 0..last {
        let s0 = sizes[i];
        let s1 = sizes[i + 1];
        if input <= s1 {
            let m0 = mults[i];
            let m1 = mults[i + 1];
            let denom = (s1 - s0);
            if denom.abs() < f64::EPSILON {
                return Some(m0);
            }
            let t = (input - s0) / denom;
            return Some(m0 + t * (m1 - m0));
        }
    }

    None
}

fn compute_curve_output(
    input: f64,
    curve: &SlippageCurve,
    spot_rate: f64,
    source_price_usd: f64,
    target_price_usd: f64,
) -> Option<f64> {
    if !(input.is_finite() && input > 0.0) {
        return None;
    }
    match curve.unit.as_deref() {
        Some("source") => {
            if !(spot_rate.is_finite() && spot_rate > 0.0) {
                return None;
            }
            let mult = interpolate_curve(curve, input)?;
            if !(mult.is_finite() && mult > 0.0) {
                return None;
            }
            let output = input * spot_rate * mult;
            if output.is_finite() && output > 0.0 {
                Some(output)
            } else {
                None
            }
        }
        Some("usd") => {
            if !(source_price_usd.is_finite() && source_price_usd > 0.0) {
                return None;
            }
            if !(target_price_usd.is_finite() && target_price_usd > 0.0) {
                return None;
            }
            let input_usd = input * source_price_usd;
            let mult = interpolate_curve(curve, input_usd)?;
            if !(mult.is_finite() && mult > 0.0) {
                return None;
            }
            let output_usd = input_usd * mult;
            let output = output_usd / target_price_usd;
            if output.is_finite() && output > 0.0 {
                Some(output)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Compute the slippage multiplier for an AMM trade.
/// Returns the ratio: actual_output / theoretical_output
/// where theoretical_output = input * (reserve_out / reserve_in) * (1 - fee)
#[allow(dead_code)]
pub fn compute_amm_slippage_multiplier(
    input: f64,
    reserve_in: f64,
    reserve_out: f64,
    fee_bps: i64,
) -> f64 {
    if input <= 0.0 || reserve_in <= 0.0 || reserve_out <= 0.0 {
        return 1.0;
    }

    let fee_multiplier = 1.0 - (fee_bps as f64) / 10_000.0;
    
    // Theoretical output (spot rate * fee)
    let spot_rate = reserve_out / reserve_in;
    let theoretical_output = input * spot_rate * fee_multiplier;
    
    // Actual output with slippage
    let actual_output = compute_amm_output(input, reserve_in, reserve_out, fee_bps);
    
    if theoretical_output > 0.0 {
        actual_output / theoretical_output
    } else {
        1.0
    }
}

/// Main entry point: compute hop output with slippage.
///
/// Routes to the appropriate pool-type-specific function.
/// Falls back to spot rate if reserves are unavailable.
///
/// # Arguments
/// * `input` - Input amount (in token units, same denomination as reserves)
/// * `pool_kind` - Pool type: "amm", "cpmm", "clmm", "dlmm"
/// * `reserve_a_raw` - Raw reserve of token A as string
/// * `reserve_b_raw` - Raw reserve of token B as string
/// * `decimals_a` - Decimals for token A
/// * `decimals_b` - Decimals for token B
/// * `fee_bps` - Fee in basis points
/// * `spot_rate` - Fallback spot rate (rate_effective) if slippage can't be computed
/// * `is_a_to_b` - Direction: true if trading A->B, false if B->A
///
/// # Returns
/// Output amount after slippage and fees
pub fn compute_hop_output(
    input: f64,
    pool_kind: &Option<String>,
    reserve_a_raw: &Option<String>,
    reserve_b_raw: &Option<String>,
    decimals_a: Option<i64>,
    decimals_b: Option<i64>,
    fee_bps: i64,
    spot_rate: f64,
    is_a_to_b: bool,
    slippage_curve: &Option<SlippageCurve>,
    source_price_usd: Option<f64>,
    target_price_usd: Option<f64>,
) -> f64 {
    if input <= 0.0 {
        return 0.0;
    }

    // Prefer slippage curve when available (native or USD-based)
    if let Some(curve) = slippage_curve.as_ref() {
        let sp = source_price_usd.unwrap_or(0.0);
        let tp = target_price_usd.unwrap_or(0.0);
        if let Some(out) = compute_curve_output(input, curve, spot_rate, sp, tp) {
            return out;
        }
    }

    // Parse reserves
    let reserve_a = parse_reserve(reserve_a_raw, decimals_a.unwrap_or(9));
    let reserve_b = parse_reserve(reserve_b_raw, decimals_b.unwrap_or(9));

    // Determine input/output reserves based on direction
    let (reserve_in, reserve_out) = if is_a_to_b {
        (reserve_a, reserve_b)
    } else {
        (reserve_b, reserve_a)
    };

    // Check if we have valid reserves for slippage computation
    let has_reserves = reserve_in > 0.0 && reserve_out > 0.0;

    let kind = pool_kind.as_ref().map(|s| s.as_str()).unwrap_or("");

    match kind {
        "amm" | "cpmm" => {
            if has_reserves {
                compute_amm_output(input, reserve_in, reserve_out, fee_bps)
            } else {
                // Fallback to spot rate
                input * spot_rate
            }
        }
        "clmm" => {
            if has_reserves {
                // CLMM: within a tick range, slippage is linear; approximate by
                // blending spot vs AMM based on trade size vs reserves.
                // Lower exponent -> closer to spot for small trades.
                blend_spot_amm_output(input, reserve_in, reserve_out, fee_bps, spot_rate, 0.7)
            } else {
                input * spot_rate
            }
        }
        "dlmm" => {
            if has_reserves {
                // DLMM: even less slippage than CLMM within active bin; use
                // a higher exponent to bias toward spot unless trade is large.
                blend_spot_amm_output(input, reserve_in, reserve_out, fee_bps, spot_rate, 1.5)
            } else {
                input * spot_rate
            }
        }
        _ => {
            // Unknown pool type - use spot rate (fee already included in rate_effective)
            input * spot_rate
        }
    }
}

/// Simplified compute_hop_output that doesn't require direction.
/// Uses the edge's rate_effective to determine direction implicitly.
///
/// This version is used in the detection loop where we don't have explicit
/// direction information but the rate_effective already encodes A->B.
pub fn compute_hop_output_simple(
    input: f64,
    pool_kind: &Option<String>,
    reserve_a_raw: &Option<String>,
    reserve_b_raw: &Option<String>,
    decimals_a: Option<i64>,
    decimals_b: Option<i64>,
    fee_bps: i64,
    spot_rate: f64,
    slippage_curve: &Option<SlippageCurve>,
    source_price_usd: Option<f64>,
    target_price_usd: Option<f64>,
) -> f64 {
    // For edges, the rate_effective is already A->B direction
    // So we use A as input reserve, B as output reserve
    compute_hop_output(
        input,
        pool_kind,
        reserve_a_raw,
        reserve_b_raw,
        decimals_a,
        decimals_b,
        fee_bps,
        spot_rate,
        true, // A->B direction (matching rate_effective convention)
        slippage_curve,
        source_price_usd,
        target_price_usd,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_reserve() {
        // Standard case
        assert!((parse_reserve(&Some("1000000000".to_string()), 9) - 1.0).abs() < 1e-9);
        
        // Large value
        assert!((parse_reserve(&Some("1000000000000".to_string()), 9) - 1000.0).abs() < 1e-6);
        
        // Different decimals
        assert!((parse_reserve(&Some("1000000".to_string()), 6) - 1.0).abs() < 1e-9);
        
        // None case
        assert_eq!(parse_reserve(&None, 9), 0.0);
        
        // Invalid string
        assert_eq!(parse_reserve(&Some("invalid".to_string()), 9), 0.0);
    }

    #[test]
    fn test_compute_amm_output_basic() {
        // Balanced pool with 1000 each, no fee
        let output = compute_amm_output(100.0, 1000.0, 1000.0, 0);
        // output = 1000 * 100 / (1000 + 100) = 100000 / 1100 ≈ 90.91
        assert!((output - 90.909090909).abs() < 0.001);
    }

    #[test]
    fn test_compute_amm_output_with_fee() {
        // Balanced pool with 30 bps fee
        let output = compute_amm_output(100.0, 1000.0, 1000.0, 30);
        // effective_input = 100 * 0.997 = 99.7
        // output = 1000 * 99.7 / (1000 + 99.7) = 99700 / 1099.7 ≈ 90.66
        assert!((output - 90.663).abs() < 0.01);
    }

    #[test]
    fn test_compute_amm_output_small_trade() {
        // Very small trade relative to reserves - minimal slippage
        let output = compute_amm_output(0.1, 1000.0, 1000.0, 0);
        // output = 1000 * 0.1 / (1000 + 0.1) ≈ 0.0999
        // Almost 1:1 for tiny trades
        assert!((output - 0.0999).abs() < 0.001);
    }

    #[test]
    fn test_compute_amm_output_large_trade() {
        // Large trade causes significant slippage
        let output = compute_amm_output(500.0, 1000.0, 1000.0, 0);
        // output = 1000 * 500 / (1000 + 500) = 500000 / 1500 ≈ 333.33
        // Much less than 1:1 due to slippage
        assert!((output - 333.333).abs() < 0.01);
    }

    #[test]
    fn test_compute_amm_output_edge_cases() {
        // Zero input
        assert_eq!(compute_amm_output(0.0, 1000.0, 1000.0, 0), 0.0);
        
        // Zero reserves
        assert_eq!(compute_amm_output(100.0, 0.0, 1000.0, 0), 0.0);
        assert_eq!(compute_amm_output(100.0, 1000.0, 0.0, 0), 0.0);
        
        // Negative input
        assert_eq!(compute_amm_output(-100.0, 1000.0, 1000.0, 0), 0.0);
    }

    #[test]
    fn test_compute_hop_output_amm() {
        let output = compute_hop_output_simple(
            100.0,
            &Some("amm".to_string()),
            &Some("1000000000000".to_string()), // 1000 tokens with 9 decimals
            &Some("1000000000000".to_string()),
            Some(9),
            Some(9),
            30,
            0.997, // spot rate with fee
            &None,
            None,
            None,
        );
        // Should use AMM formula
        assert!(output > 0.0);
        assert!(output < 100.0); // Slippage reduces output
    }

    #[test]
    fn test_compute_hop_output_fallback() {
        // No reserves - should use spot rate
        let output = compute_hop_output_simple(
            100.0,
            &Some("amm".to_string()),
            &None,
            &None,
            Some(9),
            Some(9),
            30,
            0.997,
            &None,
            None,
            None,
        );
        // Should be input * spot_rate
        assert!((output - 99.7).abs() < 0.01);
    }

    #[test]
    fn test_compute_hop_output_unknown_pool() {
        // Unknown pool type - should use spot rate
        let output = compute_hop_output_simple(
            100.0,
            &Some("unknown".to_string()),
            &Some("1000000000000".to_string()),
            &Some("1000000000000".to_string()),
            Some(9),
            Some(9),
            30,
            0.997,
            &None,
            None,
            None,
        );
        assert!((output - 99.7).abs() < 0.01);
    }

    #[test]
    fn test_slippage_multiplier() {
        // Small trade - minimal slippage
        let mult_small = compute_amm_slippage_multiplier(1.0, 1000.0, 1000.0, 0);
        assert!(mult_small > 0.99); // < 1% slippage
        
        // Large trade - significant slippage
        let mult_large = compute_amm_slippage_multiplier(500.0, 1000.0, 1000.0, 0);
        assert!(mult_large < 0.7); // > 30% slippage
    }

    #[test]
    fn test_interpolate_curve_within_range() {
        let curve = SlippageCurve {
            unit: Some("source".to_string()),
            sizes: Some(vec![1.0, 3.0, 10.0, 30.0, 100.0]),
            mults: Some(vec![0.999, 0.997, 0.99, 0.97, 0.91]),
            computed_at: None,
            confidence: None,
            source: None,
        };
        // Within range - should interpolate
        let mult = interpolate_curve(&curve, 5.0);
        assert!(mult.is_some());
        let m = mult.unwrap();
        assert!(m > 0.99 && m < 0.997, "Expected interpolated value, got {}", m);
    }

    #[test]
    fn test_interpolate_curve_beyond_range_returns_none() {
        let curve = SlippageCurve {
            unit: Some("source".to_string()),
            sizes: Some(vec![1.0, 3.0, 10.0, 30.0, 100.0]),
            mults: Some(vec![0.999, 0.997, 0.99, 0.97, 0.91]),
            computed_at: None,
            confidence: None,
            source: None,
        };
        // Beyond range - should return None so reserve-based calc is used
        let mult = interpolate_curve(&curve, 200.0);
        assert!(mult.is_none(), "Expected None for input beyond curve range");
    }

    #[test]
    fn test_curve_fallthrough_to_reserves() {
        // When curve returns None (input beyond range), compute_hop_output
        // should fall through to the reserve-based AMM formula
        let curve = SlippageCurve {
            unit: Some("source".to_string()),
            sizes: Some(vec![1.0, 10.0]),
            mults: Some(vec![0.999, 0.99]),
            computed_at: None,
            confidence: None,
            source: None,
        };
        // Input of 500 is well beyond curve range (max 10)
        // With reserves of 1000/1000, AMM output for 500 ≈ 333.33
        let output = compute_hop_output(
            500.0,
            &Some("amm".to_string()),
            &Some("1000000000000".to_string()), // 1000 tokens (9 decimals)
            &Some("1000000000000".to_string()),
            Some(9),
            Some(9),
            0,
            1.0,
            true,
            &Some(curve),
            None,
            None,
        );
        // Should use AMM formula: 1000 * 500 / (1000 + 500) ≈ 333.33
        // NOT the flat-extrapolated curve which would give 500 * 1.0 * 0.99 = 495
        assert!((output - 333.333).abs() < 1.0,
            "Expected AMM-based output ~333, got {} (curve should not flat-extrapolate)", output);
    }
}
