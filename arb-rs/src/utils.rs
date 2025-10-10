use std::cmp::min;

// Rotate a vector of strings so that its index 0 aligns with the first occurrence
// of labels_canon[0] in labels_orig. Rotation only; no reversal.
pub fn rotate_to_start(labels_orig: &Vec<String>, labels_canon: &Vec<String>, arr: &mut Vec<String>) {
    if labels_orig.is_empty() || arr.is_empty() || labels_canon.is_empty() { return; }
    let n = labels_orig.len();
    if n == 0 { return; }
    if let Some(i) = labels_orig.iter().position(|m| m == &labels_canon[0]) {
        if i % n != 0 {
            let mut tmp = vec![String::new(); min(n, arr.len())];
            for k in 0..tmp.len() { tmp[k] = arr[(k + i) % n].clone(); }
            // If arr is longer than labels (should not be), rotate first n elements
            if arr.len() == tmp.len() { *arr = tmp; } else {
                for k in 0..tmp.len() { arr[k] = tmp[k].clone(); }
            }
        }
    }
}

// Rotate a vector of numbers with the same scheme as rotate_to_start
pub fn rotate_to_start_num(labels_orig: &Vec<String>, labels_canon: &Vec<String>, arr: &mut Vec<f64>) {
    if labels_orig.is_empty() || arr.is_empty() || labels_canon.is_empty() { return; }
    let n = labels_orig.len();
    if n == 0 { return; }
    if let Some(i) = labels_orig.iter().position(|m| m == &labels_canon[0]) {
        if i % n != 0 {
            let mut tmp = vec![0.0f64; std::cmp::min(n, arr.len())];
            for k in 0..tmp.len() { tmp[k] = arr[(k + i) % n]; }
            if arr.len() == tmp.len() { *arr = tmp; } else {
                for k in 0..tmp.len() { arr[k] = tmp[k]; }
            }
        }
    }
}

// Compute estimated USD profit if the cycle notionally starts in USDC.
// Returns 0.0 if not starting at USDC or hop_outs is empty.
pub fn compute_est_profit_usd(start_is_usdc: bool, quote_size_usd: f64, hop_outs: &Vec<f64>) -> f64 {
    if !start_is_usdc { return 0.0; }
    if hop_outs.is_empty() { return 0.0; }
    let last = *hop_outs.last().unwrap_or(&0.0);
    last - quote_size_usd
}


