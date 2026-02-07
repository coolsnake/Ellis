use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Opportunity {
    pub path: Vec<String>,
    pub profit_bps: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_bps: Option<i64>,
    pub est_profit_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sizeUsd")]
    pub size_usd: Option<f64>,
    /// Optimal trade size in human (display) source token units, e.g. 111.51 SOL
    #[serde(skip_serializing_if = "Option::is_none", rename = "sizeTokens")]
    pub size_tokens: Option<f64>,
    /// Optimal trade size in start token raw (atomic) units; use for execution (no USD).
    #[serde(skip_serializing_if = "Option::is_none", rename = "sizeTokensRaw")]
    pub size_tokens_raw: Option<String>,
    /// Decimals for the start token (for proper conversion)
    #[serde(skip_serializing_if = "Option::is_none", rename = "startDecimals")]
    pub start_decimals: Option<i64>,
    pub dexes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_dexes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_rates: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_outs: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_pool_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_fee_bps: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_liquidity_display: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_product: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_edges_used: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_penalty_bps_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_edge_liquidity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub est_capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottleneck: Option<BottleneckEdge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detections: Option<u64>,
    // Optional debug for near-miss
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bf_slack_log: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bf_required_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bf_rate_delta_bps: Option<i64>,
    // Marker to distinguish simulated candidates
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_near_miss: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BottleneckEdge {
    pub from: String,
    pub to: String,
    pub dex: String,
    pub rate: f64,
    pub liquidity: f64,
    pub fee_bps: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpportunitiesResponse {
    pub items: Vec<Opportunity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_items: Option<Vec<Opportunity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<OpportunitiesSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpportunitiesSummary {
    pub count: usize,
    pub max_profit_bps: i64,
    pub avg_profit_bps: f64,
    pub avg_net_bps: f64,
    pub avg_hop_count: f64,
    pub avg_link_edges_used: f64,
    pub min_edge_liquidity_avg: f64,
    pub min_edge_liquidity_min: f64,
    pub last_detection_ms: u64,
    pub detection_duration_ms: u64,
    pub diff_to_detect_ms: u64,
    pub graph_nodes: u64,
    pub graph_edges: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_miss: Option<Opportunity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_miss_shortfall_bps: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_misses: Option<Vec<Opportunity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected_opportunities: Option<Vec<RejectedOpportunity>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RejectedOpportunity {
    pub reason: String,
    pub path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profit_bps: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_bps: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dexes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_dexes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_rates: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_outs: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_pool_ids: Option<Vec<String>>,
}
