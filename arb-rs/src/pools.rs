use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct AmmPoolNormalized {
    #[allow(dead_code)] pub id: String,
    pub dex: String,
    pub mint_a: String,
    pub mint_b: String,
    #[allow(dead_code)] pub fee_bps: i64,
    pub price_a_per_b: f64, // A per 1 B
    pub liquidity_base: f64, // rough notion of depth (token A units)
    #[allow(dead_code)] pub updated_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ClmmPoolNormalized {
    #[allow(dead_code)] pub id: String,
    pub dex: String,
    pub mint_a: String,
    pub mint_b: String,
    #[allow(dead_code)] pub fee_bps: i64,
    pub sqrt_price_x64: f64,
    pub liquidity: f64,
    #[allow(dead_code)] pub tick_spacing: i64,
    #[allow(dead_code)] pub updated_ms: u64,
    // Optional enrichments from backend when available
    #[allow(dead_code)] pub price_a_per_b: Option<f64>,
    #[allow(dead_code)] pub decimals_a: Option<i64>,
    #[allow(dead_code)] pub decimals_b: Option<i64>,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub enum NormalizedPool {
    Amm(AmmPoolNormalized),
    Clmm(ClmmPoolNormalized),
}

#[derive(Default, Clone)]
pub struct PoolCache {
    pub amm: Vec<AmmPoolNormalized>,
    pub clmm: Vec<ClmmPoolNormalized>,
    pub last_refresh_orca_ms: u64,
    pub last_refresh_raydium_ms: u64,
}

impl PoolCache {
    pub fn new() -> Self { Default::default() }

    pub async fn refresh_orca_from_http(&mut self, orca_json: &serde_json::Value) -> Result<()> {
        // Expect schema from https://api.orca.so/v2/solana/pools (mixed AMM & Whirlpool)
        let now = now_ms();
        let mut out_clmm: Vec<ClmmPoolNormalized> = Vec::new();
        let mut out_amm: Vec<AmmPoolNormalized> = Vec::new();
        fn as_f64_num(v: &serde_json::Value) -> f64 {
            if let Some(s) = v.as_str() { return s.parse::<f64>().unwrap_or(0.0); }
            if let Some(n) = v.as_f64() { return n; }
            if let Some(i) = v.as_i64() { return i as f64; }
            0.0
        }
        if let Some(arr) = orca_json.as_array() {
            for it in arr {
                let id = it.get("address").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_a = it.get("tokenA").and_then(|x| x.get("mint")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_b = it.get("tokenB").and_then(|x| x.get("mint")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fee_bps = it.get("feeRate").and_then(|x| x.as_f64()).map(|v| (v * 10_000.0) as i64).unwrap_or(it.get("fee_bps").and_then(|x| x.as_i64()).unwrap_or(0));
                if id.is_empty() || mint_a.is_empty() || mint_b.is_empty() { continue; }
                // Whirlpool path
                let tick_spacing = it.get("tickSpacing").and_then(|x| x.as_i64())
                    .or_else(|| it.get("state").and_then(|s| s.get("tickSpacing")).and_then(|x| x.as_i64()))
                    .unwrap_or(0);
                let mut sqrt_price_x64 = as_f64_num(&it.get("sqrtPrice").cloned().unwrap_or_default());
                if sqrt_price_x64 == 0.0 { sqrt_price_x64 = as_f64_num(&it.get("sqrtPriceX64").cloned().unwrap_or_default()); }
                if sqrt_price_x64 == 0.0 { sqrt_price_x64 = as_f64_num(&it.get("state").and_then(|s| s.get("sqrtPriceX64")).cloned().unwrap_or_default()); }
                let liquidity = as_f64_num(&it.get("liquidity").cloned().unwrap_or_default());
                let liq_state = as_f64_num(&it.get("state").and_then(|s| s.get("liquidity")).cloned().unwrap_or_default());
                let liquidity = if liquidity > 0.0 { liquidity } else { liq_state };
                if tick_spacing > 0 && sqrt_price_x64 > 0.0 {
                    // Best-effort decimals from HTTP payload
                    let dec_a = it.get("tokenA").and_then(|x| x.get("decimals")).and_then(|x| x.as_i64());
                    let dec_b = it.get("tokenB").and_then(|x| x.get("decimals")).and_then(|x| x.as_i64());
                    let price_http = it.get("price").and_then(|x| x.as_f64())
                        .or_else(|| it.get("price_a_per_b").and_then(|x| x.as_f64()));
                    out_clmm.push(ClmmPoolNormalized { id, dex: "Orca".into(), mint_a, mint_b, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms: now, price_a_per_b: price_http, decimals_a: dec_a, decimals_b: dec_b });
                    continue;
                }
                // AMM path (no tick spacing)
                let price = as_f64_num(&it.get("price").cloned().unwrap_or_default());
                let reserve_a = as_f64_num(&it.get("tokenAAmount").cloned().unwrap_or_default());
                let reserve_b = as_f64_num(&it.get("tokenBAmount").cloned().unwrap_or_default());
                let price_a_per_b = if price > 0.0 { price } else if reserve_b > 0.0 { reserve_a / reserve_b } else { 0.0 };
                let liquidity_base = if reserve_a > 0.0 && reserve_b > 0.0 { reserve_a.min(reserve_b) } else { 0.0 };
                if price_a_per_b > 0.0 {
                    out_amm.push(AmmPoolNormalized { id, dex: "Orca".into(), mint_a, mint_b, fee_bps, price_a_per_b, liquidity_base, updated_ms: now });
                }
            }
        }
        let updated = !out_clmm.is_empty() || !out_amm.is_empty();
        if !out_clmm.is_empty() { self.clmm = out_clmm; }
        if !out_amm.is_empty() { self.amm = out_amm; }
        if updated { self.last_refresh_orca_ms = now; }
        Ok(())
    }

    pub async fn refresh_raydium_from_http(&mut self, ray_json: &serde_json::Value) -> Result<()> {
        // Raydium pools normalized by backend bridge: { amm:[], clmm:[] }
        let now = now_ms();
        let mut out_amm: Vec<AmmPoolNormalized> = Vec::new();
        let mut out_clmm: Vec<ClmmPoolNormalized> = Vec::new();
        if let Some(arr) = ray_json.get("amm").and_then(|x| x.as_array()) {
            for it in arr {
                let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_a = it.get("mint_a").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_b = it.get("mint_b").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fee_bps = it.get("fee_bps").and_then(|x| x.as_i64()).unwrap_or(30);
                let price_a_per_b = it.get("price_a_per_b").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let liquidity_base = it.get("liquidity_base").and_then(|x| x.as_f64()).unwrap_or(0.0);
                if id.is_empty() || mint_a.is_empty() || mint_b.is_empty() || price_a_per_b <= 0.0 { continue; }
                // Prefer dex field from payload if present
                let dex = it.get("dex").and_then(|x| x.as_str()).unwrap_or("Raydium").to_string();
                out_amm.push(AmmPoolNormalized { id, dex, mint_a, mint_b, fee_bps, price_a_per_b, liquidity_base, updated_ms: now });
            }
        }
        if let Some(arr) = ray_json.get("clmm").and_then(|x| x.as_array()) {
            for it in arr {
                let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_a = it.get("mint_a").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_b = it.get("mint_b").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fee_bps = it.get("fee_bps").and_then(|x| x.as_i64()).unwrap_or(0);
                let sqrt = it.get("sqrt_price_x64").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let liq = it.get("liquidity").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let tick = it.get("tick_spacing").and_then(|x| x.as_i64()).unwrap_or(0);
                if id.is_empty() || mint_a.is_empty() || mint_b.is_empty() || sqrt <= 0.0 { continue; }
                let dex = it.get("dex").and_then(|x| x.as_str()).unwrap_or("Raydium").to_string();
                let price = it.get("price_a_per_b").and_then(|x| x.as_f64());
                let dec_a = it.get("decimals_a").and_then(|x| x.as_i64());
                let dec_b = it.get("decimals_b").and_then(|x| x.as_i64());
                out_clmm.push(ClmmPoolNormalized { id, dex, mint_a, mint_b, fee_bps, sqrt_price_x64: sqrt, liquidity: liq, tick_spacing: tick, updated_ms: now, price_a_per_b: price, decimals_a: dec_a, decimals_b: dec_b });
            }
        }
        let amm_non_empty = !out_amm.is_empty();
        let clmm_non_empty = !out_clmm.is_empty();
        if amm_non_empty { self.amm = out_amm; }
        if clmm_non_empty { self.clmm = out_clmm; }
        if amm_non_empty || clmm_non_empty { self.last_refresh_raydium_ms = now; }
        Ok(())
    }

    /// Merge normalized backend payload { amm:[], clmm:[] } into the cache without discarding other DEXes.
    /// Preserves existing entries by id and updates when incoming id matches; appends new ones.
    /// Updates last_refresh_* timestamps based on pool dex values when present.
    pub async fn merge_normalized_from_backend(&mut self, payload: &serde_json::Value) -> Result<()> {
        let now = now_ms();
        // Build id -> index maps for quick replace
        let mut amm_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (i, p) in self.amm.iter().enumerate() { amm_idx.insert(p.id.clone(), i); }
        let mut clmm_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (i, p) in self.clmm.iter().enumerate() { clmm_idx.insert(p.id.clone(), i); }

        let mut saw_orca = false;
        let mut saw_rayd = false;

        if let Some(arr) = payload.get("amm").and_then(|x| x.as_array()) {
            for it in arr {
                let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_a = it.get("mint_a").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_b = it.get("mint_b").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fee_bps = it.get("fee_bps").and_then(|x| x.as_i64()).unwrap_or(30);
                let price_a_per_b = it.get("price_a_per_b").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let liquidity_base = it.get("liquidity_base").and_then(|x| x.as_f64()).unwrap_or(0.0);
                if id.is_empty() || mint_a.is_empty() || mint_b.is_empty() || price_a_per_b <= 0.0 { continue; }
                let dex = it.get("dex").and_then(|x| x.as_str()).unwrap_or("");
                if dex.eq_ignore_ascii_case("orca") { saw_orca = true; }
                if dex.eq_ignore_ascii_case("raydium") { saw_rayd = true; }
                let rec = AmmPoolNormalized { id: id.clone(), dex: dex.to_string(), mint_a, mint_b, fee_bps, price_a_per_b, liquidity_base, updated_ms: now };
                if let Some(&idx) = amm_idx.get(&id) { self.amm[idx] = rec; } else { self.amm.push(rec); }
            }
        }
        if let Some(arr) = payload.get("clmm").and_then(|x| x.as_array()) {
            for it in arr {
                let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_a = it.get("mint_a").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let mint_b = it.get("mint_b").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fee_bps = it.get("fee_bps").and_then(|x| x.as_i64()).unwrap_or(0);
                let sqrt = it.get("sqrt_price_x64").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let liq = it.get("liquidity").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let tick = it.get("tick_spacing").and_then(|x| x.as_i64()).unwrap_or(0);
                if id.is_empty() || mint_a.is_empty() || mint_b.is_empty() || sqrt <= 0.0 { continue; }
                let dex = it.get("dex").and_then(|x| x.as_str()).unwrap_or("");
                if dex.eq_ignore_ascii_case("orca") { saw_orca = true; }
                if dex.eq_ignore_ascii_case("raydium") { saw_rayd = true; }
                let price = it.get("price_a_per_b").and_then(|x| x.as_f64());
                let dec_a = it.get("decimals_a").and_then(|x| x.as_i64());
                let dec_b = it.get("decimals_b").and_then(|x| x.as_i64());
                let rec = ClmmPoolNormalized { id: id.clone(), dex: dex.to_string(), mint_a, mint_b, fee_bps, sqrt_price_x64: sqrt, liquidity: liq, tick_spacing: tick, updated_ms: now, price_a_per_b: price, decimals_a: dec_a, decimals_b: dec_b };
                if let Some(&idx) = clmm_idx.get(&id) { self.clmm[idx] = rec; } else { self.clmm.push(rec); }
            }
        }
        if saw_orca { self.last_refresh_orca_ms = now; }
        if saw_rayd { self.last_refresh_raydium_ms = now; }
        Ok(())
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}


