use anyhow::Result;
use std::time::Duration;
use base64::Engine as _;

pub struct Sources {
    client: reqwest::Client,
}

impl Sources {
    pub fn new() -> Self {
        // Apply a reasonable default timeout so arb loop proceeds on slow endpoints
        // Optionally attach Basic Auth for backend calls via env BACKEND_AUTH_USER/PASS
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(5));
        let user = std::env::var("BACKEND_AUTH_USER").ok();
        let pass = std::env::var("BACKEND_AUTH_PASS").ok();
        if let (Some(u), Some(p)) = (user, pass) {
            let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", u, p));
            let mut headers = reqwest::header::HeaderMap::new();
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Basic {}", token)) {
                headers.insert(reqwest::header::AUTHORIZATION, val);
                builder = builder.default_headers(headers);
            }
        }
        let client = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }

    #[allow(dead_code)]
    pub async fn jupiter_prices(&self, ids: &[&str]) -> Result<serde_json::Value> {
        if ids.is_empty() { return Ok(serde_json::json!({})); }
        let url = format!("https://lite-api.jup.ag/price/v3?ids={}", ids.join(","));
        let r = self.client.get(&url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    pub async fn jupiter_quote_base_in(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        slippage_bps: u32,
    ) -> Result<serde_json::Value> {
        let mut url = reqwest::Url::parse("https://lite-api.jup.ag/swap/v1/quote")?;
        url.query_pairs_mut()
            .append_pair("inputMint", input_mint)
            .append_pair("outputMint", output_mint)
            .append_pair("amount", &amount.to_string())
            .append_pair("slippageBps", &slippage_bps.to_string())
            .append_pair("restrictIntermediateTokens", "true");
        let r = self.client.get(url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    #[allow(dead_code)]
    pub async fn raydium_priority_fee(&self) -> Result<serde_json::Value> {
        // Using Raydium docs guidance for priority fee endpoint
        let base = "https://api-v3.raydium.io";
        let url = format!("{}/main/priority-fee", base);
        let r = self.client.get(&url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    pub async fn orca_pools(&self) -> Result<serde_json::Value> {
        let url = "https://api.orca.so/v2/solana/pools";
        let r = self.client.get(url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    pub async fn backend_orca_pools(&self, api_base: &str) -> Result<serde_json::Value> {
        let url = format!("{}/arb/pools/orca", api_base.trim_end_matches('/'));
        let r = self.client.get(&url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    #[allow(dead_code)]
    pub async fn raydium_pools(&self) -> Result<serde_json::Value> {
        // Best-effort Raydium pools list. The v3 API may expose pools under different paths.
        // Try primary, fallback to alternative paths.
        let candidates = vec![
            "https://api-v3.raydium.io/pools",
            "https://api-v3.raydium.io/main/pools",
            "https://api.raydium.io/v2/sdk/pools",
        ];
        let mut last_err: Option<anyhow::Error> = None;
        for url in candidates {
            match self.client.get(url).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        let j = resp.json().await?;
                        return Ok(j);
                    } else {
                        last_err = Some(anyhow::anyhow!("status {}", resp.status()));
                    }
                },
                Err(e) => { last_err = Some(e.into()); }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("raydium pools fetch failed")))
    }

    #[allow(dead_code)]
    pub async fn raydium_compute_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        slippage_bps: u32,
    ) -> Result<serde_json::Value> {
        let mut url = reqwest::Url::parse("https://transaction-v1.raydium.io/compute/swap-base-in")?;
        url.query_pairs_mut()
            .append_pair("inputMint", input_mint)
            .append_pair("outputMint", output_mint)
            .append_pair("amount", &amount.to_string())
            .append_pair("slippageBps", &slippage_bps.to_string());
        let r = self.client.get(url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    pub async fn backend_watchlist(&self, api_base: &str) -> Result<Vec<String>> {
        let url = format!("{}/watchlist", api_base.trim_end_matches('/'));
        let r = self.client.get(url).send().await?;
        let j = r.json::<serde_json::Value>().await?;
        let mut out = Vec::new();
        if let Some(arr) = j.get("watchlist").and_then(|x| x.as_array()) {
            for it in arr {
                if let Some(s) = it.as_str() { out.push(s.to_string()); continue; }
                if let Some(id) = it.get("id").and_then(|x| x.as_str()) { out.push(id.to_string()); }
            }
        }
        Ok(out)
    }

    pub async fn backend_raydium_pools(&self, api_base: &str) -> Result<serde_json::Value> {
        let url = format!("{}/arb/pools/raydium", api_base.trim_end_matches('/'));
        let r = self.client.get(url).send().await?;
        let j = r.json().await?;
        Ok(j)
    }

    pub async fn backend_refresh_pools(&self, api_base: &str, source: Option<&str>) -> Result<serde_json::Value> {
        let url = format!("{}/arb/pools/refresh", api_base.trim_end_matches('/'));
        let body = if let Some(s) = source { serde_json::json!({ "source": s }) } else { serde_json::json!({}) };
        let r = self.client.post(url).json(&body).send().await?;
        let j = r.json().await?;
        Ok(j)
    }
}


