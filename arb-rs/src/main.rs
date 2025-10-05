use std::{net::SocketAddr, sync::Arc, time::Duration};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::collections::HashSet;
use petgraph::prelude::NodeIndex;

use axum::{extract::State, routing::{get, post}, Json, Router};
use axum::extract::Query;
use axum::extract::ws::{WebSocketUpgrade, Message};
use axum::response::IntoResponse;
use serde::Serialize;
use serde::Deserialize;
use tokio::sync::RwLock;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
mod opportunities;
use opportunities::{OpportunitiesResponse, Opportunity, OpportunitiesSummary};
mod sources;
use sources::Sources;
mod graph;
use graph::{ArbGraph, EdgeData};
mod algos;
use algos::{detect_negative_cycles, detect_near_miss_cycles};
mod pools;
use pools::{PoolCache};

#[derive(Default, serde::Serialize, serde::Deserialize, Clone)]
struct ArbConfig {
    enabled: bool,
    min_profit_bps: i64,
    min_notional_usd: f64,
    max_hops: usize,
    max_paths_per_cycle: usize,
    poll_interval_ms: u64,
    dex_allow: Vec<String>,
    priority_fee_tier: String,
    sources: SourcesCfg,
    max_slippage_bps: i64,
    execution_mode: String, // "simulate" | "execute"
    quote_size_usd: f64,
    fee_bps: i64,
    link_penalty_bps: i64,
    debug_emit_subthreshold: bool,
    debug_top_n: usize,
    near_miss_enable: bool,
    near_miss_epsilon: f64,
    // Skip adding pool edges when pool liquidity below this threshold (applies to AMM liquidity_base and CLMM liquidity)
    min_pool_liquidity: f64,
}

#[derive(Default, serde::Serialize, serde::Deserialize, Clone)]
struct SourcesCfg { jupiter: bool, raydium: bool, orca: bool }

#[derive(Default, serde::Serialize, Clone)]
struct Metrics {
    detection_cycles_total: u64,
    opportunities_active: u64,
    last_detection_ms: u64,
    detection_duration_ms: u64,
    ingestion_duration_ms: u64,
    graph_nodes: u64,
    graph_edges: u64,
    ingestion_requests_total_jupiter: u64,
    ingestion_requests_total_raydium: u64,
    ingestion_requests_total_orca: u64,
    ingestion_errors_total_jupiter: u64,
    ingestion_errors_total_raydium: u64,
    ingestion_errors_total_orca: u64,
    ws_push_total: u64,
    ws_skipped_nochange_total: u64,
    max_profit_bps: i64,
    avg_profit_bps: f64,
    graph_updates_applied: u64,
    graph_updates_skipped: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct EventItem {
    ts: u64,
    level: String,
    message: String,
}

#[derive(Default)]
struct AppState {
    config: ArbConfig,
    opportunities: Vec<Opportunity>,
    graph: ArbGraph,
    metrics: Metrics,
    events: Vec<EventItem>,
    pool_cache: PoolCache,
    near_miss: Option<Opportunity>,
    near_miss_shortfall_bps: Option<i64>,
    force_refresh_next: bool,
    last_graph_version: u64,
    last_graph_ts: u64,
    // When true, skip local ingestion and use graph provided externally by backend
    use_backend_graph: bool,
    // Buffered graph updates to be applied between loop runs
    pending_added_edges: Vec<GraphDiffEdge>,
    pending_updated_edges: Vec<GraphDiffEdge>,
    pending_removed_edge_ids: Vec<String>,
    pending_graph_version: Option<u64>,
    pending_graph_ts: Option<u64>,
}

#[derive(Serialize)]
struct HealthResp { status: &'static str }

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Optional: prepare a bridge sender for backend logging if env is set
    #[derive(Clone)]
    struct BridgeWriter { tx: Option<tokio::sync::mpsc::Sender<String>> }
    impl std::io::Write for BridgeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if let Some(tx) = &self.tx {
                let _ = tx.try_send(String::from_utf8_lossy(buf).to_string());
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    let mut bridge_tx: Option<tokio::sync::mpsc::Sender<String>> = None;
    if let Ok(bridge_base) = std::env::var("BACKEND_LOG_BRIDGE_URL") {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(1000);
        bridge_tx = Some(tx.clone());
        let client = reqwest::Client::new();
        let url = format!("{}/terminal/log", bridge_base.trim_end_matches('/'));
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                let msg = line.trim();
                if msg.is_empty() { continue; }
                // Infer level from formatted prefix if present
                let mut level = "info";
                if msg.starts_with("[ERROR]") { level = "error"; }
                else if msg.starts_with("[WARN]") { level = "warn"; }
                else if msg.starts_with("[INFO]") { level = "info"; }
                else if msg.starts_with("[DEBUG]") { level = "debug"; }
                // Try to infer category: map known prefixes to backend categories
                let cat = if msg.contains("arb.") { Some("arb") }
                          else if msg.contains("graph:") || msg.contains("graph.") { Some("graph") }
                          else if msg.contains("pools") { Some("pools") }
                          else { None };
                let payload = if let Some(c) = cat { serde_json::json!({ "level": level, "message": msg, "cat": c }) } else { serde_json::json!({ "level": level, "message": msg }) };
                let _ = client.post(&url).json(&payload).send().await;
            }
        });
    }

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        // Plain layer without timestamps to avoid long timestamps in console
        .with(tracing_subscriber::fmt::layer().without_time())
        // Bridge layer (no ANSI, no time) to backend terminal/log endpoint
        .with(tracing_subscriber::fmt::layer().without_time().with_ansi(false).with_writer(move || BridgeWriter { tx: bridge_tx.clone() }))
        .init();

    let state = Arc::new(RwLock::new(AppState { config: default_config(), opportunities: Vec::new(), graph: ArbGraph::new(), metrics: Metrics::default(), events: Vec::new(), pool_cache: PoolCache::new(), near_miss: None, near_miss_shortfall_bps: None, force_refresh_next: false, last_graph_version: 0, last_graph_ts: 0, use_backend_graph: false, pending_added_edges: Vec::new(), pending_updated_edges: Vec::new(), pending_removed_edge_ids: Vec::new(), pending_graph_version: None, pending_graph_ts: None }));

    // Install shutdown handler to clear in-memory state
    {
        use tokio::signal;
        let state_for_shutdown = state.clone();
        tokio::spawn(async move {
            // SIGINT or SIGTERM
            let _ = signal::ctrl_c().await;
            let mut s = state_for_shutdown.write().await;
            s.graph = ArbGraph::new();
            s.opportunities.clear();
            s.near_miss = None;
            s.near_miss_shortfall_bps = None;
            s.pending_added_edges.clear();
            s.pending_updated_edges.clear();
            s.pending_removed_edge_ids.clear();
            s.pending_graph_version = None;
            s.pending_graph_ts = None;
            s.last_graph_version = 0;
            s.last_graph_ts = 0;
            s.use_backend_graph = false;
            s.force_refresh_next = true;
        });
    }

    // Kick off a background task to update opportunities using config interval (MVP placeholder)
    let loop_state = state.clone();
    tokio::spawn(async move {
        let sources = Sources::new();
        loop {
            let (enabled, interval_ms, min_bps, max_slip_bps, _fee_bps, _link_penalty_bps, _quote_size_usd, max_hops, sources_cfg, min_pool_liquidity) = {
                let s = loop_state.read().await;
                (
                    s.config.enabled,
                    s.config.poll_interval_ms,
                    s.config.min_profit_bps,
                    s.config.max_slippage_bps,
                    s.config.fee_bps,
                    s.config.link_penalty_bps,
                    s.config.quote_size_usd,
                    s.config.max_hops,
                    s.config.sources.clone(),
                    s.config.min_pool_liquidity,
                )
            };
            let iter_start = Instant::now();
            if enabled {
                tracing::info!("arb.loop.tick start");
                // Ensure we have the most recent backend graph version before detection
                let api_base = std::env::var("BACKEND_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                let gv_url = format!("{}/arb/graph/version", api_base.trim_end_matches('/'));
                let gv = match reqwest::Client::new().get(&gv_url).send().await {
                    Ok(resp) => match resp.json::<serde_json::Value>().await {
                        Ok(j) => j,
                        Err(_) => serde_json::json!({"version":0,"timestamp":0}),
                    },
                    Err(_) => serde_json::json!({"version":0,"timestamp":0}),
                };
                let incoming_ver = gv.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
                let incoming_ts = gv.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
                {
                    let mut s = loop_state.write().await;
                    if incoming_ver > s.last_graph_version {
                        s.force_refresh_next = true;
                        s.last_graph_version = incoming_ver;
                        s.last_graph_ts = incoming_ts;
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.graph.version.update v={} ts={}", incoming_ver, incoming_ts) });
                        let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
                    }
                }
                let loop_start = Instant::now();
                let ingest_start = Instant::now();
                let sol = "So11111111111111111111111111111111111111112";
                let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
                let amt_sol_small: u64 = 100_000; // 0.0001 SOL for probing
                let amt_usdc_small: u64 = 10_000; // 0.01 USDC for probing

                // If using backend-provided graph, skip local ingestion entirely
                let use_backend_graph = { loop_state.read().await.use_backend_graph };
                let (mut wl, mut pairs): (Vec<String>, Vec<(String,String,u64,u32,u32)>) = (Vec::new(), Vec::new());
                if !use_backend_graph {
                    // Pull watchlist from backend and build pair candidates (star topology to USDC)
                    let api_base = std::env::var("BACKEND_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                    wl = sources.backend_watchlist(&api_base).await.unwrap_or_else(|e| { tracing::warn!(error=?e, "arb.watchlist fetch failed; falling back to defaults"); vec![usdc.to_string(), sol.to_string()] });
                    tracing::info!(enabled, min_bps, max_slip_bps, max_hops, watchlist_len = wl.len(), "arb.loop.start");
                    for mint in wl.iter() {
                        if mint == usdc { continue; }
                        // Assume unknown decimals default {USDC:6, others:9}; future: resolve decimals via token API
                        pairs.push((mint.clone(), usdc.to_string(), amt_sol_small, 9, 6));
                        pairs.push((usdc.to_string(), mint.clone(), amt_usdc_small, 6, 9));
                    }
                    {
                        let mut s = loop_state.write().await;
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.start pairs={}", pairs.len()) });
                        let len = s.events.len();
                        if len > 200 { s.events.drain(0..(len-200)); }
                    }
                }

                // Jupiter quotes disabled for arbitrage engine
                // Raydium compute-quote is redundant when using pool edges; keep disabled by default

                // Pools snapshot (rate-limited)
                let (need_orca, need_rayd, force_now) = if use_backend_graph { (false, false, false) } else {
                    let s = loop_state.read().await;
                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    // Refresh windows aligned with backend cache TTLs: 5 minutes
                    (
                        sources_cfg.orca && (s.force_refresh_next || now.saturating_sub(s.pool_cache.last_refresh_orca_ms) > 60_000),
                        sources_cfg.raydium && (s.force_refresh_next || now.saturating_sub(s.pool_cache.last_refresh_raydium_ms) > 60_000),
                        s.force_refresh_next,
                    )
                };
                // Hint backend to refresh its normalized caches before we pull them, so Rust sees latest normalization
                // Backend route is internally debounced; ignore errors
                if need_orca || need_rayd || force_now { tracing::info!(need_orca, need_rayd, force_now, "arb.pools.refresh.hint"); let _ = sources.backend_refresh_pools(&api_base, Some("all")).await; }
                let t_orca = Instant::now();
                let orca = if use_backend_graph { Ok(serde_json::json!({ "amm": [], "clmm": [] })) } else if need_orca || { let s = loop_state.read().await; s.pool_cache.last_refresh_orca_ms == 0 } { sources.backend_orca_pools(&api_base).await } else { Ok(serde_json::json!({ "amm": [], "clmm": [] })) };
                let orca_ms = t_orca.elapsed().as_millis();
                let t_rayd = Instant::now();
                let rayd = if use_backend_graph { Ok(serde_json::json!({ "amm": [], "clmm": [] })) } else if need_rayd || { let s = loop_state.read().await; s.pool_cache.last_refresh_raydium_ms == 0 } { sources.backend_raydium_pools(&api_base).await } else { Ok(serde_json::json!({ "amm": [], "clmm": [] })) };
                let rayd_ms = t_rayd.elapsed().as_millis();
                tracing::info!(orca_ms = orca_ms as u128, rayd_ms = rayd_ms as u128, "arb.pools.fetch.done");
                let (mut orca_amm_len, mut orca_clmm_len, mut ray_amm_len, mut ray_clmm_len) = (0usize,0usize,0usize,0usize);
                if let Ok(ref j) = orca { orca_amm_len = j.get("amm").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0); orca_clmm_len = j.get("clmm").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0); }
                if let Ok(ref j) = rayd { ray_amm_len = j.get("amm").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0); ray_clmm_len = j.get("clmm").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0); }
                let orca_timed_out = matches!(&orca, Err(e) if e.to_string().contains("deadline has elapsed") || e.to_string().contains("timeout"));
                let rayd_timed_out = matches!(&rayd, Err(e) if e.to_string().contains("deadline has elapsed") || e.to_string().contains("timeout"));
                tracing::info!(
                    orca_need=?need_orca, ray_need=?need_rayd,
                    orca_amm_len, orca_clmm_len, ray_amm_len, ray_clmm_len,
                    orca_ms, rayd_ms,
                    orca_timeout=orca_timed_out, rayd_timeout=rayd_timed_out,
                    "arb.pools.snap"
                );

                // Build/update graph with effective rates unless using backend-provided graph
                {
                    let mut s = loop_state.write().await;
                    // Jupiter quotes disabled: no ingestion recorded
                    s.metrics.ingestion_requests_total_jupiter += 0;
                    if need_rayd { s.metrics.ingestion_requests_total_raydium += 1; }
                    if need_orca { s.metrics.ingestion_requests_total_orca += 1; }
                    // Jupiter quotes disabled: no errors recorded
                    if need_rayd && rayd.is_err() { s.metrics.ingestion_errors_total_raydium += 1; }
                    if need_orca && orca.is_err() { s.metrics.ingestion_errors_total_orca += 1; }
                    // Update pool cache best-effort
                    // Merge normalized payloads without discarding other DEX entries
                    if let Ok(ref j) = orca { let _ = s.pool_cache.merge_normalized_from_backend(j).await; }
                    if let Ok(ref j) = rayd { let _ = s.pool_cache.merge_normalized_from_backend(j).await; }
                    if force_now { s.force_refresh_next = false; }
                    s.metrics.ingestion_duration_ms = ingest_start.elapsed().as_millis() as u64;

                    // If backend graph mode is active, preserve the externally pushed graph
                    if use_backend_graph {
                        // Apply any buffered diffs now (between detection runs)
                        if !s.pending_removed_edge_ids.is_empty() || !s.pending_added_edges.is_empty() || !s.pending_updated_edges.is_empty() {
                            let rem_ct = s.pending_removed_edge_ids.len();
                            let add_ct = s.pending_added_edges.len();
                            let upd_ct = s.pending_updated_edges.len();
                            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
                            let added = std::mem::take(&mut s.pending_added_edges);
                            let updated = std::mem::take(&mut s.pending_updated_edges);
                            if !removed.is_empty() { let _ = s.graph.remove_edges_by_ids(&removed); }
                            let mut upsert = |e: &GraphDiffEdge| {
                                let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                                let fee = e.fee_bps.unwrap_or(0);
                                let liq = e.liquidity.unwrap_or(0.0);
                                let liq_disp = e.liquidity_display.unwrap_or(0.0);
                                // e.price_a_per_b is A per 1 B for edge source=A -> target=B; invert to get B per 1 A
                                let px = if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px } else { 0.0 } } else { 0.0 };
                                let base = if px > 0.0 { 1.0 / px } else { 0.0 };
                                let rate_eff = if base > 0.0 { base * (1.0 - (fee as f64)/10_000.0).max(0.0) } else { 0.0 };
                                s.graph.upsert_edge(&dex, &e.source, &e.target, EdgeData {
                                    rate_effective: rate_eff,
                                    fee_bps: fee,
                                    liquidity: liq,
                                    dex: dex.clone(),
                                    pool_id: e.pool_id.clone().unwrap_or_default(),
                                    liquidity_display: liq_disp,
                                });
                            };
                            for e in added.iter() { upsert(e); }
                            for e in updated.iter() { upsert(e); }
                            s.metrics.graph_updates_applied = s.metrics.graph_updates_applied.saturating_add(1);
                            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.graph.diff: applied add={} upd={} rem={}", add_ct, upd_ct, rem_ct) });
                            let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
                        }
                        if let Some(v) = s.pending_graph_version.take() { s.last_graph_version = v; }
                        if let Some(t) = s.pending_graph_ts.take() { s.last_graph_ts = t; }
                        s.metrics.graph_nodes = s.graph.g.node_count() as u64;
                        s.metrics.graph_edges = s.graph.g.edge_count() as u64;
                        // Skip local rebuild entirely
                        // Continue to detection on the preserved graph
                    } else {
                    // Rebuild graph from pool cache scoped by watchlist mints and source toggles
                    let mut wl_set: std::collections::HashSet<String> = wl.iter().cloned().collect();
                    let amm_pools = s.pool_cache.amm.clone();
                    let clmm_pools = s.pool_cache.clmm.clone();

                    // Expand watchlist by 1-hop neighbors present in current pools (to enable triangles)
                    if !wl_set.is_empty() {
                        for p in amm_pools.iter() {
                            if wl_set.contains(&p.mint_a) || wl_set.contains(&p.mint_b) {
                                wl_set.insert(p.mint_a.clone());
                                wl_set.insert(p.mint_b.clone());
                            }
                        }
                        for p in clmm_pools.iter() {
                            if wl_set.contains(&p.mint_a) || wl_set.contains(&p.mint_b) {
                                wl_set.insert(p.mint_a.clone());
                                wl_set.insert(p.mint_b.clone());
                            }
                        }
                    }

                    s.graph = ArbGraph::new();
                    // Build detection edges using ONLY pool fees (and link penalties). Global fee/slippage are applied later for net metrics.
                    let adj_detect = |rate: f64, pool_fee_bps: i64| -> f64 {
                        let pool_fee_dec = (pool_fee_bps as f64) / 10_000.0;
                        rate.max(1e-12) * (1.0 - pool_fee_dec).max(0.0)
                    };

                    // AMM pools (Raydium)
                    if sources_cfg.raydium {
                        for p in amm_pools.into_iter() {
                            if !wl_set.contains(&p.mint_a) && !wl_set.contains(&p.mint_b) { continue; }
                            if p.liquidity_base < min_pool_liquidity { continue; }
                            if p.price_a_per_b > 0.0 {
                                // Size-based slippage haircut (conservative) using liquidity_base
                                let max_slip_bps = s.config.max_slippage_bps.max(0) as f64;
                                let q_usd = s.config.quote_size_usd.max(1.0);
                                let liq = p.liquidity_base.max(1.0);
                                let hair_bps = (q_usd / liq.sqrt()).min(max_slip_bps);
                                let hair = (1.0 - hair_bps / 10_000.0).max(1e-6);
                                let rate_b_per_a = (1.0 / p.price_a_per_b).abs() * hair;
                                let rate_a_per_b = p.price_a_per_b.abs() * hair;
                                s.graph.upsert_edge(&p.dex, &p.mint_a, &p.mint_b, EdgeData { rate_effective: adj_detect(rate_b_per_a, p.fee_bps), fee_bps: p.fee_bps, liquidity: p.liquidity_base, dex: p.dex.clone(), pool_id: p.id.clone(), liquidity_display: p.liquidity_base });
                                s.graph.upsert_edge(&p.dex, &p.mint_b, &p.mint_a, EdgeData { rate_effective: adj_detect(rate_a_per_b, p.fee_bps), fee_bps: p.fee_bps, liquidity: p.liquidity_base, dex: p.dex.clone(), pool_id: p.id.clone(), liquidity_display: p.liquidity_base });
                            }
                        }
                    }

                    // CLMM pools (Orca and others); approximate mid-price from sqrt_price_x64 with decimals when available
                    if sources_cfg.orca {
                        let mut clmm_edges_added: usize = 0;
                        let mut clmm_edges_by_dex: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
                        for p in clmm_pools.into_iter() {
                            if !wl_set.contains(&p.mint_a) && !wl_set.contains(&p.mint_b) { continue; }
                            if p.liquidity < min_pool_liquidity { continue; }
                            // Prefer sqrt-derived mid-price when available; fallback to backend-provided price
                            let mut price_b_per_a: f64 = 0.0;
                            if p.sqrt_price_x64 > 0.0 {
                                // Uniswap/CLMM convention:
                                //   ratio = sqrt(price_B_per_A)
                                //   price_B_per_A = ratio^2 * 10^(decA - decB)
                                //   price_A_per_B = 1 / price_B_per_A
                                let s64 = p.sqrt_price_x64;
                                let ratio = s64 / (2f64.powi(64));
                                let dec_a = (p.decimals_a.unwrap_or(0)) as i32;
                                let dec_b = (p.decimals_b.unwrap_or(0)) as i32;
                                let price_b_per_a_unscaled = (ratio * ratio).max(1e-24);
                                price_b_per_a = if dec_a != 0 || dec_b != 0 {
                                    price_b_per_a_unscaled * 10f64.powi(dec_a - dec_b)
                                } else {
                                    price_b_per_a_unscaled
                                };
                            } else if let Some(px) = p.price_a_per_b {
                                if px > 0.0 { price_b_per_a = 1.0 / px; }
                            }
                            if price_b_per_a > 0.0 {
                                    // Size-based slippage haircut (conservative): scale by liquidity
                                    let max_slip_bps = s.config.max_slippage_bps.max(0) as f64;
                                    let q_usd = s.config.quote_size_usd.max(1.0);
                                    let liq = p.liquidity.max(1.0);
                                    let hair_bps = (q_usd / liq.sqrt()).min(max_slip_bps);
                                    let hair = (1.0 - hair_bps / 10_000.0).max(1e-6);
                                    let rate_b_per_a = price_b_per_a * hair;
                                    let rate_a_per_b = (1.0 / price_b_per_a) * hair;
                                    s.graph.upsert_edge(&p.dex, &p.mint_a, &p.mint_b, EdgeData { rate_effective: adj_detect(rate_b_per_a, p.fee_bps), fee_bps: p.fee_bps, liquidity: p.liquidity, dex: p.dex.clone(), pool_id: p.id.clone(), liquidity_display: p.liquidity });
                                    s.graph.upsert_edge(&p.dex, &p.mint_b, &p.mint_a, EdgeData { rate_effective: adj_detect(rate_a_per_b, p.fee_bps), fee_bps: p.fee_bps, liquidity: p.liquidity, dex: p.dex.clone(), pool_id: p.id.clone(), liquidity_display: p.liquidity });
                                    clmm_edges_added += 2;
                                    *clmm_edges_by_dex.entry(p.dex.clone()).or_insert(0) += 2;
                            }
                        }
                        // Simple visibility log to confirm CLMM edges added
                        tracing::debug!(target = "arb_rs", total = clmm_edges_added, by_dex = ?clmm_edges_by_dex, "graph: clmm edges added");
                    }

                    let _parse_rate = |q: &serde_json::Value, in_dec: u32, out_dec: u32| -> Option<f64> {
                        let out_raw = q.get("outAmount")?.as_str()?.parse::<u128>().ok()? as f64;
                        let in_raw = q.get("inAmount").and_then(|x| x.as_str()).and_then(|st| st.parse::<u128>().ok()).unwrap_or(0) as f64;
                        let in_raw = if in_raw == 0.0 { amt_sol_small as f64 } else { in_raw };
                        let out = out_raw / 10f64.powi(out_dec as i32);
                        let inn = in_raw / 10f64.powi(in_dec as i32);
                        if inn > 0.0 { Some(out / inn) } else { None }
                    };
                    // Jupiter edges disabled for arbitrage engine

                    // Cross-DEX link edges removed: nodes are unified by mint now
                    // Skip adding Raydium compute-quote edges; pool-derived edges already modeled
                    s.metrics.graph_nodes = s.graph.g.node_count() as u64;
                    s.metrics.graph_edges = s.graph.g.edge_count() as u64;
                    let nodes = s.metrics.graph_nodes;
                    let edges = s.metrics.graph_edges;
                    s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.ingest.done ms={} nodes={} edges={}", ingest_start.elapsed().as_millis(), nodes, edges) });
                    let len = s.events.len();
                    if len > 200 { s.events.drain(0..(len-200)); }
                    }
                }
                // Detect cycles (MVP -log weights)
                // Compare with previous to only push WS updates on change
                let (opps, prev, near_pair): (Vec<Opportunity>, Vec<Opportunity>, Option<(Opportunity,i64)>) = {
                    let s = loop_state.read().await;
                    let cycles = detect_negative_cycles(&s.graph);
                    // Deduplicate cycles and compute profit from edge rates
                    let mut seen: HashSet<String> = HashSet::new();
                    let mut curr: Vec<Opportunity> = Vec::new();
                    let mut best_below: Option<Opportunity> = None;
                    let mut best_below_shortfall: i64 = i64::MAX;
                    // Minimum liquidity threshold to consider an edge in rate selection
                    let min_edge_liq_threshold: f64 = 0.0; // filter out zero-liquidity edges
                    for c in cycles.into_iter() {
                        if c.nodes.len() < 2 { continue; }
                        // Enforce simple cycles and hop bound
                        let nlen = c.nodes.len();
                        if nlen < 3 { continue; }
                        if nlen > max_hops { continue; }
                        let mut uniq = std::collections::HashSet::new();
                        let mut simple = true;
                        for &v in c.nodes.iter() { if !uniq.insert(v) { simple = false; break; } }
                        if !simple { continue; }

                        // Build labels (mint-only) and compute product of best-of-parallel rates along the closed loop
                        let labels: Vec<String> = c.nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                        let start_is_usdc = labels.first().map(|m| m == usdc).unwrap_or(false);
                        // ensure closed by appending first at end for edge traversal
                        let mut rate_prod: f64 = 1.0;
                        let mut link_edges_used: usize = 0;
                        let mut link_penalty_bps_total: i64 = 0;
                        let mut min_edge_liquidity: f64 = f64::INFINITY;
                        let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> = None; // (uIdx,vIdx,dex,rate,liq,fee)
                        let mut dexes_set: std::collections::HashSet<String> = std::collections::HashSet::new();
                        let mut hop_dexes: Vec<String> = Vec::new();
                        let mut hop_rates: Vec<f64> = Vec::new();
                        let mut hop_pool_ids: Vec<String> = Vec::new();
                        let mut hop_fee_bps: Vec<i64> = Vec::new();
                        let mut hop_liq_disp: Vec<f64> = Vec::new();
                        let mut hop_outs: Vec<f64> = Vec::new();
                        let mut cur_out: f64 = if start_is_usdc { s.config.quote_size_usd.max(0.0) } else { 1.0 };
                        'cycle: for w in 0..c.nodes.len() {
                            let u = NodeIndex::new(c.nodes[w]);
                            let v = NodeIndex::new(c.nodes[(w+1) % c.nodes.len()]);
                            let mut best_rate: f64 = 0.0;
                            let mut best_meta: Option<(String, f64, i64, String, f64)> = None; // (dex, liq, fee, pool_id, liq_display)
                            for e in s.graph.g.edges_connecting(u, v) {
                                let wt = e.weight();
                                if wt.liquidity <= min_edge_liq_threshold { continue; }
                                let r = wt.rate_effective.max(1e-12);
                                if r > best_rate { best_rate = r; best_meta = Some((wt.dex.clone(), wt.liquidity, wt.fee_bps, wt.pool_id.clone(), wt.liquidity_display)); }
                            }
                            if best_rate <= 0.0 { rate_prod = 0.0; break 'cycle; }
                            if let Some((dex, liq, fee, pid, liqd)) = best_meta.take() {
                                if dex == "Link" { link_edges_used += 1; link_penalty_bps_total += fee; }
                                if !dex.is_empty() && dex != "Link" { dexes_set.insert(dex.clone()); }
                                min_edge_liquidity = min_edge_liquidity.min(liq);
                                let edge_rate = best_rate;
                                if bottleneck.as_ref().map(|(_,_,_,r,_,_)| edge_rate < *r).unwrap_or(true) {
                                    bottleneck = Some((u.index(), v.index(), dex.clone(), edge_rate, liq, fee));
                                }
                                hop_dexes.push(dex);
                                hop_rates.push(edge_rate);
                                hop_pool_ids.push(pid);
                                hop_fee_bps.push(fee);
                                hop_liq_disp.push(liqd);
                                // compute hop out
                                let next_out = if cur_out.is_finite() { cur_out * edge_rate } else { 0.0 };
                                hop_outs.push(next_out);
                                cur_out = next_out;
                            }
                            rate_prod *= best_rate;
                        }
                        let profit = rate_prod - 1.0;
                        let profit_bps = (profit * 10_000.0).floor() as i64;
                        // Canonicalize cycle labels by rotation only (preserve direction to keep hop arrays aligned)
                        let canon = |v: &Vec<String>| -> Vec<String> {
                            if v.is_empty() { return v.clone(); }
                            let n = v.len();
                            let mut best_key: Option<String> = None;
                            let mut best_vec: Option<Vec<String>> = None;
                            for i in 0..n {
                                let mut r = Vec::with_capacity(n);
                                for k in 0..n { r.push(v[(i+k)%n].clone()); }
                                let key = r.join("->");
                                if best_key.as_ref().map(|s| &key < s).unwrap_or(true) { best_key = Some(key); best_vec = Some(r); }
                            }
                            best_vec.unwrap()
                        };
                        // Rotate hop arrays to match canon_labels start (no reversal allowed above)
                        let rotate_to_start = |labels_orig: &Vec<String>, labels_canon: &Vec<String>, arr: &mut Vec<String>| {
                            if labels_orig.is_empty() || arr.is_empty() { return; }
                            let n = labels_orig.len();
                            if n == 0 { return; }
                            // find offset i where labels_orig[i] == labels_canon[0]
                            if let Some(i) = labels_orig.iter().position(|m| m == &labels_canon[0]) {
                                if i % n != 0 {
                                    let mut tmp = vec![String::new(); n];
                                    for k in 0..n { tmp[k] = arr[(k + i) % n].clone(); }
                                    *arr = tmp;
                                }
                            }
                        };
                        let rotate_to_start_num = |labels_orig: &Vec<String>, labels_canon: &Vec<String>, arr: &mut Vec<f64>| {
                            if labels_orig.is_empty() || arr.is_empty() { return; }
                            let n = labels_orig.len();
                            if n == 0 { return; }
                            if let Some(i) = labels_orig.iter().position(|m| m == &labels_canon[0]) {
                                if i % n != 0 {
                                    let mut tmp = vec![0.0f64; n];
                                    for k in 0..n { tmp[k] = arr[(k + i) % n]; }
                                    *arr = tmp;
                                }
                            }
                        };
                        let canon_labels = canon(&labels);
                        // Align hop arrays with the rotated labels (no reversal)
                        rotate_to_start(&labels, &canon_labels, &mut hop_pool_ids);
                        rotate_to_start(&labels, &canon_labels, &mut hop_dexes);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_rates);
                        let key = canon_labels.join("->");
                        if seen.contains(&key) { continue; }
                        seen.insert(key);
                        // DEXes derived from edges selected along the cycle
                        let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                        dexes.sort();
                        // Estimate capacity: use min edge liquidity as a rough proxy
                        let est_capacity = if min_edge_liquidity.is_finite() { Some(min_edge_liquidity.max(0.0)) } else { None };
                        let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        // Compute net_bps as profit_bps - link penalties (already included in rate, but expose explicitly)
                        let net_bps = profit_bps - link_penalty_bps_total.max(0);
                        let bottleneck_edge = bottleneck.as_ref().map(|(ui,vi,dex,rate,liq,fee)| {
                            let from = s.graph.g[NodeIndex::new(*ui)].clone();
                            let to = s.graph.g[NodeIndex::new(*vi)].clone();
                            opportunities::BottleneckEdge { from, to, dex: dex.clone(), rate: *rate, liquidity: *liq, fee_bps: *fee }
                        });
                        if profit_bps < min_bps {
                            let shortfall = (min_bps - profit_bps).max(0);
                            if shortfall < best_below_shortfall {
                                let near = Opportunity {
                                    path: canon_labels.clone(),
                                    profit_bps,
                                    net_bps: Some(net_bps),
                                    est_profit_usd: 1.0,
                                    dexes: dexes.clone(),
                                    hop_dexes: Some(hop_dexes.clone()),
                                    hop_rates: Some(hop_rates.clone()),
                                    hop_outs: None,
                                    hop_pool_ids: None,
                                    hop_fee_bps: None,
                                    hop_liquidity_display: None,
                                    hop_count: Some(nlen),
                                    rate_product: Some(rate_prod),
                                    link_edges_used: Some(link_edges_used),
                                    link_penalty_bps_total: Some(link_penalty_bps_total),
                                    min_edge_liquidity: est_capacity,
                                    est_capacity,
                                    bottleneck: bottleneck_edge.clone(),
                                    detected_ms: Some(now_ts),
                                    first_seen_ms: None,
                                    detections: Some(0),
                                    bf_slack_log: None,
                                    bf_required_rate: None,
                                    bf_rate_delta_bps: None,
                                };
                                // Only accept near-miss if at least 3 hops and min_edge_liquidity > 0
                                if nlen >= 3 && est_capacity.unwrap_or(0.0) > 0.0 {
                                    best_below = Some(near);
                                    best_below_shortfall = shortfall;
                                }
                            }
                            continue;
                        }
                        // Emit arb log for validation
                        {
                            let path_str = canon_labels.join("->");
                            let rates_str = hop_rates.iter().map(|v| format!("{:.6}", v)).collect::<Vec<_>>().join(",");
                            let outs_str = hop_outs.iter().map(|v| format!("{:.6}", v)).collect::<Vec<_>>().join(",");
                            let fees_str = hop_fee_bps.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
                            let pools_str = hop_pool_ids.join(",");
                            // Include explicit edges with closing hop for sequence validation
                            let edges_str = {
                                let mut v: Vec<String> = Vec::new();
                                let n = canon_labels.len();
                                for k in 0..n {
                                    let a = &canon_labels[k];
                                    let b = &canon_labels[(k+1)%n];
                                    let id = hop_pool_ids.get(k).cloned().unwrap_or_default();
                                    let short = |m: &String| -> String { if m.len() > 8 { format!("{}…{}", &m[..4], &m[m.len()-4..]) } else { m.clone() } };
                                    v.push(format!("{}->{}:{}", short(a), short(b), id));
                                }
                                v.join(",")
                            };
                            tracing::info!(target = "arb_rs", "arb.opportunity path={} profit_bps={} net_bps={} hops={} rates=[{}] outs=[{}] fees=[{}] pools=[{}] edges=[{}] product={:.8}", path_str, profit_bps, net_bps, nlen, rates_str, outs_str, fees_str, pools_str, edges_str, rate_prod);
                        }
                        curr.push(Opportunity {
                            path: canon_labels,
                            profit_bps,
                            net_bps: Some(net_bps),
                            est_profit_usd: 1.0,
                            dexes,
                            hop_dexes: Some(hop_dexes),
                            hop_rates: Some(hop_rates),
                            hop_outs: Some(hop_outs),
                            hop_pool_ids: Some(hop_pool_ids),
                            hop_fee_bps: Some(hop_fee_bps),
                            hop_liquidity_display: Some(hop_liq_disp),
                            hop_count: Some(nlen),
                            rate_product: Some(rate_prod),
                            link_edges_used: Some(link_edges_used),
                            link_penalty_bps_total: Some(link_penalty_bps_total),
                            min_edge_liquidity: est_capacity,
                            est_capacity,
                            bottleneck: bottleneck_edge,
                            detected_ms: Some(now_ts),
                            first_seen_ms: None,
                            detections: None,
                            bf_slack_log: None,
                            bf_required_rate: None,
                            bf_rate_delta_bps: None,
                        });
                    }
                    let mut near_pair = best_below.map(|o| (o, best_below_shortfall));
                    // Near-miss via Bellman-Ford final slack pass
                    if s.config.near_miss_enable {
                        let epsilon: f64 = if s.config.near_miss_epsilon.is_finite() && s.config.near_miss_epsilon > 0.0 { s.config.near_miss_epsilon } else { 5e-4 }; // log-space slack window
                        let top_k: usize = s.config.debug_top_n.max(1).min(20);
                        let nm = detect_near_miss_cycles(&s.graph, epsilon, max_hops, top_k);
                        for nmcy in nm.into_iter() {
                            // Interpret nodes to labels and compute best-of-parallel rates metadata
                            if nmcy.nodes.len() < 3 || nmcy.nodes.len() > max_hops { continue; }
                            let mut labels: Vec<String> = nmcy.nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                            // Rotate to preferred anchor (SOL, then USDC) for readability
                            let rotate_preferred = |mut v: Vec<String>| -> Vec<String> {
                                let prefs = [
                                    "So11111111111111111111111111111111111111112",
                                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                ];
                                for p in prefs.iter() {
                                    if let Some(pos) = v.iter().position(|x| x == p) { v.rotate_left(pos); break; }
                                }
                                v
                            };
                            labels = rotate_preferred(labels);
                            // Compute product and meta
                            let mut rate_prod: f64 = 1.0;
                            let mut link_edges_used: usize = 0;
                            let mut link_penalty_bps_total: i64 = 0;
                            let mut min_edge_liquidity: f64 = f64::INFINITY;
                            let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> = None;
                            let mut dexes_set: std::collections::HashSet<String> = std::collections::HashSet::new();
                            let nlen = nmcy.nodes.len();
                            let mut ok = true;
                            let mut hop_dexes: Vec<String> = Vec::new();
                            let mut hop_rates: Vec<f64> = Vec::new();
                            let mut hop_pool_ids: Vec<String> = Vec::new();
                            let mut hop_fee_bps: Vec<i64> = Vec::new();
                            let mut hop_liq_disp: Vec<f64> = Vec::new();
                            let mut hop_outs: Vec<f64> = Vec::new();
                            let mut cur_out: f64 = if labels.first().map(|m| m == &usdc).unwrap_or(false) { s.config.quote_size_usd.max(0.0) } else { 1.0 };
                            for w in 0..nlen {
                                let u = NodeIndex::new(nmcy.nodes[w]);
                                let v = NodeIndex::new(nmcy.nodes[(w+1)%nlen]);
                                let mut best_rate: f64 = 0.0;
                                let mut best_meta: Option<(String, f64, i64, String, f64)> = None;
                                for e in s.graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 { continue; }
                                    let r = wt.rate_effective.max(1e-12);
                                    if r > best_rate { best_rate = r; best_meta = Some((wt.dex.clone(), wt.liquidity, wt.fee_bps, wt.pool_id.clone(), wt.liquidity_display)); }
                                }
                                if best_rate <= 0.0 { ok = false; break; }
                                if let Some((dex, liq, fee, pid, liqd)) = best_meta.take() {
                                    if dex == "Link" { link_edges_used += 1; link_penalty_bps_total += fee; }
                                    if !dex.is_empty() && dex != "Link" { dexes_set.insert(dex.clone()); }
                                    min_edge_liquidity = min_edge_liquidity.min(liq);
                                    if bottleneck.as_ref().map(|(_,_,_,r,_,_)| best_rate < *r).unwrap_or(true) {
                                        bottleneck = Some((u.index(), v.index(), dex.clone(), best_rate, liq, fee));
                                    }
                                    hop_dexes.push(dex);
                                    hop_rates.push(best_rate);
                                    hop_pool_ids.push(pid);
                                    hop_fee_bps.push(fee);
                                    hop_liq_disp.push(liqd);
                                    let next_out = if cur_out.is_finite() { cur_out * best_rate } else { 0.0 };
                                    hop_outs.push(next_out);
                                    cur_out = next_out;
                                }
                                rate_prod *= best_rate;
                            }
                            if !ok { continue; }
                            let profit_bps_raw = ((rate_prod - 1.0) * 10_000.0).floor();
                            let mut profit_bps = if profit_bps_raw.is_finite() { profit_bps_raw as i64 } else { 0 };
                            if profit_bps > 1_000_000 { profit_bps = 1_000_000; }
                            if profit_bps < -1_000_000 { profit_bps = -1_000_000; }
                            if profit_bps >= min_bps { continue; } // near-miss only
                            // Build interpreted near-miss
                            let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                            dexes.sort();
                            let est_capacity = if min_edge_liquidity.is_finite() { Some(min_edge_liquidity.max(0.0)) } else { None };
                            let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                            let mut net_bps = profit_bps - link_penalty_bps_total.max(0);
                            if net_bps > 1_000_000 { net_bps = 1_000_000; }
                            if net_bps < -1_000_000 { net_bps = -1_000_000; }
                            let bottleneck_edge = bottleneck.as_ref().map(|(ui,vi,dex,rate,liq,fee)| {
                                let from = s.graph.g[NodeIndex::new(*ui)].clone();
                                let to = s.graph.g[NodeIndex::new(*vi)].clone();
                                opportunities::BottleneckEdge { from, to, dex: dex.clone(), rate: *rate, liquidity: *liq, fee_bps: *fee }
                            });
                            // Capture last rate before moving hop_rates into the struct
                            let last_rate_opt = hop_rates.last().copied();
                            // Emit arb log for near-miss (BF slack)
                            {
                                let path_str = labels.join("->");
                                let rates_str = hop_rates.iter().map(|v| format!("{:.6}", v)).collect::<Vec<_>>().join(",");
                                let outs_str = hop_outs.iter().map(|v| format!("{:.6}", v)).collect::<Vec<_>>().join(",");
                                let fees_str = hop_fee_bps.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
                                let pools_str = hop_pool_ids.join(",");
                                tracing::info!(target = "arb_rs", "arb.near_miss path={} profit_bps={} net_bps={} hops={} rates=[{}] outs=[{}] fees=[{}] pools=[{}] product={:.8} slack={:.8}", path_str, profit_bps, net_bps, nlen, rates_str, outs_str, fees_str, pools_str, rate_prod, nmcy.slack);
                            }
                            let mut near = Opportunity {
                                path: labels.clone(),
                                profit_bps,
                                net_bps: Some(net_bps),
                                est_profit_usd: 1.0,
                                dexes,
                                hop_dexes: Some(hop_dexes),
                                hop_rates: Some(hop_rates),
                                hop_outs: Some(hop_outs),
                                hop_pool_ids: Some(hop_pool_ids),
                                hop_fee_bps: Some(hop_fee_bps),
                                hop_liquidity_display: Some(hop_liq_disp),
                                hop_count: Some(nlen),
                                rate_product: Some(rate_prod),
                                link_edges_used: Some(link_edges_used),
                                link_penalty_bps_total: Some(link_penalty_bps_total),
                                min_edge_liquidity: est_capacity,
                                est_capacity,
                                bottleneck: bottleneck_edge,
                                detected_ms: Some(now_ts),
                                first_seen_ms: None,
                                detections: Some(0),
                                bf_slack_log: None,
                                bf_required_rate: None,
                                bf_rate_delta_bps: None,
                            };
                            // Attach BF slack debug for near-miss
                            near.bf_slack_log = Some(nmcy.slack);
                            // If we can estimate required closing-edge rate to hit threshold
                            let req = if rate_prod > 0.0 { (1.0 + (min_bps as f64)/10_000.0) / rate_prod } else { 0.0 };
                            near.bf_required_rate = if req.is_finite() { Some(req) } else { None };
                            if let Some(last_rate) = last_rate_opt {
                                let delta_bps = (((req.max(0.0) / last_rate.max(1e-12)) - 1.0) * 10_000.0).floor() as i64;
                                near.bf_rate_delta_bps = Some(delta_bps);
                            }
                            let shortfall = (min_bps - profit_bps).max(0);
                            match &mut near_pair {
                                Some((ref mut best, ref mut best_shortfall)) => {
                                    if shortfall < *best_shortfall { *best = near; *best_shortfall = shortfall; }
                                }
                                None => { near_pair = Some((near, shortfall)); }
                            }
                        }
                    }
                    // Fallback: if no negative cycles at all (curr empty) and no near_below, enumerate simple cycles up to max_hops and pick best product
                    if curr.is_empty() && near_pair.is_none() {
                        let ncount = s.graph.g.node_count();
                        let max_starts = ncount.min(40);
                        let mut best_prod: f64 = 0.0;
                        let mut best_nodes: Vec<usize> = Vec::new();
                        for si in 0..max_starts {
                            let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();
                            let mut stack: Vec<usize> = Vec::new();
                            visited.insert(si);
                            stack.push(si);
                            // Use manual DFS stack to avoid recursion
                            // Each frame: (current_index, next_neighbor_iter_index, current_product, prev_pool_id)
                            let mut frames: Vec<(usize, usize, f64, Option<String>)> = vec![(si, 0, 1.0, None)];
                            // Precompute adjacency as neighbor indices for performance
                            let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); ncount];
                            for ni in 0..ncount {
                                let u = NodeIndex::new(ni);
                                let mut outs: Vec<usize> = Vec::new();
                                for v in s.graph.g.neighbors_directed(u, petgraph::Direction::Outgoing) { outs.push(v.index()); }
                                neighbors[ni] = outs;
                            }
                            // Helper to get best edge (rate, pool_id) between two nodes, excluding a previous pool id if provided
                            let best_edge_between_excluding = |ui: usize, vi: usize, prev_pid: Option<&str>| -> (f64, Option<String>) {
                                let u = NodeIndex::new(ui); let v = NodeIndex::new(vi);
                                let mut best_rate = 0.0f64;
                                let mut best_pid: Option<String> = None;
                                for e in s.graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 { continue; }
                                    if let Some(pp) = prev_pid { if !pp.is_empty() && wt.pool_id == pp { continue; } }
                                    let r = wt.rate_effective.max(1e-12);
                                    if r > best_rate { best_rate = r; best_pid = Some(wt.pool_id.clone()); }
                                }
                                (best_rate, best_pid)
                            };
                            while let Some((cur, ni, prod, prev_pid)) = frames.pop() {
                                if ni >= neighbors[cur].len() { visited.remove(&cur); let _ = stack.pop(); continue; }
                                let nxt = neighbors[cur][ni];
                                // put back frame with advanced neighbor index
                                frames.push((cur, ni+1, prod, prev_pid.clone()));
                                let (rate, chosen_pid) = best_edge_between_excluding(cur, nxt, prev_pid.as_deref());
                                if rate <= 0.0 { continue; }
                                if nxt == si {
                                    // Found a cycle; require at least 3 edges (no 2-hop reverse)
                                    if stack.len() >= 3 {
                                        let cycle_prod = prod * rate;
                                        if cycle_prod > best_prod {
                                            best_prod = cycle_prod;
                                            best_nodes = stack.clone();
                                        }
                                    }
                                    continue;
                                }
                                if visited.contains(&nxt) { continue; }
                                if stack.len()+1 > max_hops { continue; }
                                visited.insert(nxt);
                                stack.push(nxt);
                                // Carry forward the chosen pool id to prevent immediate reverse via the same pool
                                frames.push((nxt, 0, prod * rate, chosen_pid));
                            }
                        }
                        if best_prod > 0.0 && !best_nodes.is_empty() {
                            // Build opportunity-like near miss from best cycle
                            let labels: Vec<String> = best_nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                            // Canonicalize
                            let canon = |v: &Vec<String>| -> Vec<String> {
                                if v.is_empty() { return v.clone(); }
                                let n = v.len();
                                let mut best = None;
                                for i in 0..n {
                                    let mut r = Vec::with_capacity(n);
                                    for k in 0..n { r.push(v[(i+k)%n].clone()); }
                                    let key = r.join("->");
                                    if best.as_ref().map(|(s,_)| &key < s).unwrap_or(true) { best = Some((key, r)); }
                                }
                                let mut vrev = v.clone(); vrev.reverse();
                                for i in 0..n {
                                    let mut r = Vec::with_capacity(n);
                                    for k in 0..n { r.push(vrev[(i+k)%n].clone()); }
                                    let key = r.join("->");
                                    if best.as_ref().map(|(s,_)| &key < s).unwrap_or(true) { best = Some((key, r)); }
                                }
                                best.unwrap().1
                            };
                            let canon_labels = canon(&labels);
                            // Dexes: recompute from edges along best_nodes
                            let mut dexes_set: std::collections::HashSet<String> = std::collections::HashSet::new();
                            // Recompute meta along canonical order
                            let mut link_edges_used: usize = 0;
                            let mut link_penalty_bps_total: i64 = 0;
                            let mut min_edge_liquidity: f64 = f64::INFINITY;
                            let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> = None;
                            let mut prod2 = 1.0f64;
                            let mut hop_dexes: Vec<String> = Vec::new();
                            let mut hop_rates: Vec<f64> = Vec::new();
                            let mut hop_pool_ids: Vec<String> = Vec::new();
                            let mut hop_fee_bps: Vec<i64> = Vec::new();
                            let mut hop_liq_disp: Vec<f64> = Vec::new();
                            let mut hop_outs: Vec<f64> = Vec::new();
                            let mut cur_out: f64 = if labels.first().map(|m| m == &usdc).unwrap_or(false) { s.config.quote_size_usd.max(0.0) } else { 1.0 };
                            for w in 0..best_nodes.len() {
                                let u = NodeIndex::new(best_nodes[w]);
                                let v = NodeIndex::new(best_nodes[(w+1)%best_nodes.len()]);
                                let mut best_rate: f64 = 0.0; let mut best_meta: Option<(String, f64, i64, String, f64)> = None;
                                for e in s.graph.g.edges_connecting(u, v) { let wt = e.weight(); if wt.liquidity <= 0.0 { continue; } let r = wt.rate_effective.max(1e-12); if r > best_rate { best_rate = r; best_meta = Some((wt.dex.clone(), wt.liquidity, wt.fee_bps, wt.pool_id.clone(), wt.liquidity_display)); } }
                                if best_rate <= 0.0 { prod2 = 0.0; break; }
                                if let Some((dex, liq, fee, pid, liqd)) = best_meta.take() { if dex == "Link" { link_edges_used += 1; link_penalty_bps_total += fee; } else { dexes_set.insert(dex.clone()); } min_edge_liquidity = min_edge_liquidity.min(liq); if bottleneck.as_ref().map(|(_,_,_,r,_,_)| best_rate < *r).unwrap_or(true) { bottleneck = Some((u.index(), v.index(), dex.clone(), best_rate, liq, fee)); } hop_dexes.push(dex); hop_rates.push(best_rate); hop_pool_ids.push(pid); hop_fee_bps.push(fee); hop_liq_disp.push(liqd); let next_out = if cur_out.is_finite() { cur_out * best_rate } else { 0.0 }; hop_outs.push(next_out); cur_out = next_out; }
                                prod2 *= best_rate;
                            }
                            let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                            dexes.sort();
                            let profit_bps = ((prod2 - 1.0) * 10_000.0).floor() as i64;
                            let net_bps = profit_bps - link_penalty_bps_total.max(0);
                            let est_capacity = if min_edge_liquidity.is_finite() { Some(min_edge_liquidity.max(0.0)) } else { None };
                            let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                            let bottleneck_edge = bottleneck.as_ref().map(|(ui,vi,dex,rate,liq,fee)| {
                                let from = s.graph.g[NodeIndex::new(*ui)].clone();
                                let to = s.graph.g[NodeIndex::new(*vi)].clone();
                                opportunities::BottleneckEdge { from, to, dex: dex.clone(), rate: *rate, liquidity: *liq, fee_bps: *fee }
                            });
                            // Only consider as near-miss if below threshold, at least 3 hops, and min liquidity > 0
                            if profit_bps < min_bps && best_nodes.len() >= 3 && est_capacity.unwrap_or(0.0) > 0.0 {
                              let near = Opportunity {
                                path: canon_labels,
                                profit_bps,
                                net_bps: Some(net_bps),
                                est_profit_usd: 1.0,
                                dexes,
                                hop_dexes: Some(hop_dexes),
                                hop_rates: Some(hop_rates),
                                hop_outs: Some(hop_outs),
                                hop_pool_ids: Some(hop_pool_ids),
                                hop_fee_bps: Some(hop_fee_bps),
                                hop_liquidity_display: Some(hop_liq_disp),
                                hop_count: Some(best_nodes.len()),
                                rate_product: Some(prod2),
                                link_edges_used: Some(link_edges_used),
                                link_penalty_bps_total: Some(link_penalty_bps_total),
                                min_edge_liquidity: est_capacity,
                                est_capacity,
                                bottleneck: bottleneck_edge,
                                detected_ms: Some(now_ts),
                                first_seen_ms: None,
                                detections: Some(0),
                                bf_slack_log: None,
                                bf_required_rate: None,
                                bf_rate_delta_bps: None,
                              };
                              let shortfall = (min_bps - profit_bps).max(0);
                              near_pair = Some((near, shortfall));
                            }
                        }
                        // Extra permissive fallback: try find any triangle cycle even if profit <= 0
                        if near_pair.is_none() {
                            let ncount = s.graph.g.node_count();
                            let best_rate_between = |ui: usize, vi: usize| -> f64 {
                                let u = NodeIndex::new(ui); let v = NodeIndex::new(vi);
                                let mut br = 0.0f64;
                                for e in s.graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 { continue; }
                                    br = br.max(wt.rate_effective.max(1e-12));
                                }
                                br
                            };
                            let mut best: Option<(usize,usize,usize,f64)> = None;
                            for a in 0..ncount { for b in 0..ncount { if b==a {continue;} for c in 0..ncount { if c==a || c==b {continue;} 
                                let r1 = best_rate_between(a,b); let r2 = best_rate_between(b,c); let r3 = best_rate_between(c,a);
                                if r1>0.0 && r2>0.0 && r3>0.0 {
                                    let prod = r1*r2*r3;
                                    if best.as_ref().map(|(_,_,_,p)| prod > *p).unwrap_or(true) { best = Some((a,b,c,prod)); }
                                }
                            }}}
                            if let Some((a,b,c,prod)) = best {
                                let nodes = vec![a,b,c];
                                let mut labels: Vec<String> = nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                                let rotate_preferred = |mut v: Vec<String>| -> Vec<String> {
                                    let prefs = [
                                        "So11111111111111111111111111111111111111112",
                                        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                    ];
                                    for p in prefs.iter() { if let Some(pos) = v.iter().position(|x| x == p) { v.rotate_left(pos); break; } }
                                    v
                                };
                                labels = rotate_preferred(labels);
                                // Build meta across the triangle
                                let mut link_edges_used: usize = 0; let mut link_penalty_bps_total: i64 = 0; let mut min_edge_liquidity: f64 = f64::INFINITY; let mut bottleneck: Option<(usize,usize,String,f64,f64,i64)> = None; let mut dexes_set: std::collections::HashSet<String> = std::collections::HashSet::new();
                                let mut hop_dexes: Vec<String> = Vec::new();
                                let mut hop_rates: Vec<f64> = Vec::new();
                                for w in 0..3 {
                                    let u = NodeIndex::new(nodes[w]); let v = NodeIndex::new(nodes[(w+1)%3]);
                                    let mut best_rate: f64 = 0.0; let mut best_meta: Option<(String,f64,i64)> = None;
                                    for e in s.graph.g.edges_connecting(u,v) { let wt = e.weight(); if wt.liquidity <= 0.0 { continue; } let r = wt.rate_effective.max(1e-12); if r>best_rate { best_rate = r; best_meta = Some((wt.dex.clone(), wt.liquidity, wt.fee_bps)); } }
                                    if let Some((dex, liq, fee)) = best_meta.take() { if dex=="Link" { link_edges_used+=1; link_penalty_bps_total+=fee; } if !dex.is_empty() && dex!="Link" { dexes_set.insert(dex.clone()); } min_edge_liquidity = min_edge_liquidity.min(liq); if bottleneck.as_ref().map(|(_,_,_,r,_,_)| best_rate<*r).unwrap_or(true) { bottleneck = Some((u.index(), v.index(), dex.clone(), best_rate, liq, fee)); } hop_dexes.push(dex); hop_rates.push(best_rate); }
                                }
                                let mut dexes: Vec<String> = dexes_set.into_iter().collect(); dexes.sort();
                                let profit_bps_raw = ((prod - 1.0) * 10_000.0).floor();
                                let mut profit_bps = if profit_bps_raw.is_finite() { profit_bps_raw as i64 } else { 0 };
                                if profit_bps > 1_000_000 { profit_bps = 1_000_000; }
                                if profit_bps < -1_000_000 { profit_bps = -1_000_000; }
                                let mut net_bps = profit_bps - link_penalty_bps_total.max(0);
                                if net_bps > 1_000_000 { net_bps = 1_000_000; }
                                if net_bps < -1_000_000 { net_bps = -1_000_000; }
                                let shortfall = (min_bps - profit_bps).max(1); // ensure >0 so UI shows
                                let est_capacity = if min_edge_liquidity.is_finite() { Some(min_edge_liquidity.max(0.0)) } else { None };
                                let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                let bottleneck_edge = bottleneck.as_ref().map(|(ui,vi,dex,rate,liq,fee)| { let from = s.graph.g[NodeIndex::new(*ui)].clone(); let to = s.graph.g[NodeIndex::new(*vi)].clone(); opportunities::BottleneckEdge { from, to, dex: dex.clone(), rate: *rate, liquidity: *liq, fee_bps: *fee } });
                                // Recompute best edges per hop to capture pool ids/fees for logging and output
                                let mut hop_pool_ids: Vec<String> = Vec::new();
                                let mut hop_fee_bps_vec: Vec<i64> = Vec::new();
                                for w in 0..3 {
                                    let u = NodeIndex::new(nodes[w]); let v = NodeIndex::new(nodes[(w+1)%3]);
                                    let mut best_rate: f64 = 0.0; let mut best_pid: Option<String> = None; let mut best_fee: i64 = 0;
                                    for e in s.graph.g.edges_connecting(u, v) { let wt = e.weight(); let r = wt.rate_effective.max(1e-12); if r > best_rate { best_rate = r; best_pid = Some(wt.pool_id.clone()); best_fee = wt.fee_bps; } }
                                    hop_pool_ids.push(best_pid.unwrap_or_default());
                                    hop_fee_bps_vec.push(best_fee);
                                }
                                // Log triangle near-miss
                                {
                                    let path_str = labels.join("->");
                                    let rates_str = hop_rates.iter().map(|v| format!("{:.6}", v)).collect::<Vec<_>>().join(",");
                                    let pools_str = hop_pool_ids.join(",");
                                    let fees_str = hop_fee_bps_vec.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
                                    tracing::info!(target = "arb_rs", "arb.near_miss.triangle path={} profit_bps={} net_bps={} hops=3 rates=[{}] pools=[{}] fees=[{}] product={:.8}", path_str, profit_bps, net_bps, rates_str, pools_str, fees_str, prod);
                                }
                                let near = Opportunity { path: labels, profit_bps, net_bps: Some(net_bps), est_profit_usd: 1.0, dexes, hop_dexes: Some(hop_dexes), hop_rates: Some(hop_rates), hop_outs: None, hop_pool_ids: Some(hop_pool_ids), hop_fee_bps: Some(hop_fee_bps_vec), hop_liquidity_display: None, hop_count: Some(3), rate_product: Some(prod), link_edges_used: Some(link_edges_used), link_penalty_bps_total: Some(link_penalty_bps_total), min_edge_liquidity: est_capacity, est_capacity, bottleneck: bottleneck_edge, detected_ms: Some(now_ts), first_seen_ms: None, detections: Some(0), bf_slack_log: None, bf_required_rate: None, bf_rate_delta_bps: None };
                                near_pair = Some((near, shortfall));
                            }
                        }
                    }
                    // Emit debug: top-N subthreshold
                    if s.config.debug_emit_subthreshold {
                        // Re-run a light pass over cycles to collect subthreshold candidates
                        let mut subs: Vec<(i64, String)> = Vec::new();
                        let dbg_cycles = detect_negative_cycles(&s.graph);
                        for c in dbg_cycles.into_iter() {
                            if c.nodes.len() < 3 || c.nodes.len() > max_hops { continue; }
                            let mut uniq = std::collections::HashSet::new();
                            let mut simple = true; for &v in c.nodes.iter() { if !uniq.insert(v) { simple = false; break; } }
                            if !simple { continue; }
                            let mut prod: f64 = 1.0;
                            let mut ok = true;
                            for w in 0..c.nodes.len() {
                                let u = NodeIndex::new(c.nodes[w]);
                                let v = NodeIndex::new(c.nodes[(w+1)%c.nodes.len()]);
                                let mut br: f64 = 0.0;
                                for e in s.graph.g.edges_connecting(u, v) { let wt = e.weight(); if wt.liquidity <= 0.0 { continue; } br = br.max(wt.rate_effective.max(1e-12)); }
                                if br <= 0.0 { ok = false; break; }
                                prod *= br;
                            }
                            if !ok { continue; }
                            let bps = ((prod - 1.0) * 10_000.0).floor() as i64;
                            if bps < min_bps {
                                let labels: Vec<String> = c.nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                                subs.push((bps, labels.join("->")));
                            }
                        }
                        subs.sort_by_key(|(bps,_)| *bps);
                        let n = s.config.debug_top_n.max(1).min(20);
                        if n > 0 {
                            // Acquire write lock separately to push events
                            let mut sw = loop_state.write().await;
                            for (i,(bps, path)) in subs.into_iter().rev().take(n).enumerate() {
                                sw.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.debug.subthreshold#{} bps={} path={}", i+1, bps, path) });
                            }
                            let len = sw.events.len(); if len > 200 { sw.events.drain(0..(len-200)); }
                        }
                    }
                    let prev_opps = s.opportunities.clone();
                    (curr, prev_opps, near_pair)
                };
                // Drop stale opps older than 10s if not re-detected
                let now_ms_val = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                let stale_threshold = 10_000u64;
                let mut merged: Vec<Opportunity> = Vec::new();
                // Keep those just detected
                merged.extend(opps.into_iter());
                // Retain prior ones if still within threshold and not duplicated
                for mut o in prev.into_iter() {
                    let ts = o.detected_ms.unwrap_or(now_ms_val);
                    let is_dup = merged.iter().any(|x| x.path == o.path && x.dexes == o.dexes);
                    if !is_dup && now_ms_val.saturating_sub(ts) <= stale_threshold {
                        // Carry over stability counters
                        if o.first_seen_ms.is_none() { o.first_seen_ms = o.detected_ms; }
                        o.detections = Some(o.detections.unwrap_or(1));
                        merged.push(o);
                    }
                }
                // Diff on paths list for change detection
                let changed = true; // simplified; merged likely differs frequently enough
                if changed {
                    let mut s = loop_state.write().await;
                    // Update detections for re-detected opps
                    for m in merged.iter_mut() {
                        // If this opp also existed previously, bump detections and preserve first_seen_ms
                        if let Some(prev_o) = s.opportunities.iter().find(|p| p.path == m.path && p.dexes == m.dexes) {
                            m.first_seen_ms = prev_o.first_seen_ms.or(prev_o.detected_ms).or(m.detected_ms);
                            m.detections = Some(prev_o.detections.unwrap_or(1) + 1);
                        } else {
                            m.first_seen_ms = m.first_seen_ms.or(m.detected_ms);
                            m.detections = Some(1);
                        }
                    }
                    s.opportunities = merged;
                    s.near_miss = near_pair.as_ref().map(|(o, _)| o.clone());
                    s.near_miss_shortfall_bps = near_pair.as_ref().map(|(_, sh)| *sh);
                    s.metrics.opportunities_active = s.opportunities.len() as u64;
                    s.metrics.max_profit_bps = s.opportunities.iter().map(|o| o.profit_bps).max().unwrap_or(0) as i64;
                    let total: i64 = s.opportunities.iter().map(|o| o.profit_bps).sum();
                    s.metrics.avg_profit_bps = if s.opportunities.is_empty() { 0.0 } else { total as f64 / s.opportunities.len() as f64 };
                    s.metrics.detection_cycles_total += 1;
                    s.metrics.last_detection_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    s.metrics.detection_duration_ms = loop_start.elapsed().as_millis() as u64;
                    let det_ms = s.metrics.detection_duration_ms;
                    let active = s.metrics.opportunities_active;
                    if let Some(top) = s.opportunities.iter().max_by_key(|o| o.profit_bps) {
                        let top_bps = top.profit_bps;
                        let path = top.path.join("->");
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.done ms={} opps={} top_bps={} path={}", det_ms, active, top_bps, path) });
                    } else {
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.done ms={} opps=0", det_ms) });
                    }
                    let len = s.events.len();
                    if len > 200 { s.events.drain(0..(len-200)); }
                }
            }
            // Sleep respects configured interval even when disabled to avoid hot loop
            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
            tracing::debug!(iter_ms = iter_start.elapsed().as_millis() as u128, "arb.loop.end");
        }
    });

    let app = Router::new()
        .route("/health", get(|| async { Json(HealthResp { status: "ok" }) }))
        .route("/opportunities", get(get_opportunities))
        .route("/pools/json", get(get_pools))
        .route("/quote", get(get_quote))
        .route("/ws/opportunities", get(ws_opportunities))
        .route("/config", post(set_config).get(get_config))
        .route("/arb/start", post(arb_start))
        .route("/arb/graph/snapshot", post(arb_graph_snapshot))
        .route("/arb/graph/update", post(arb_graph_update))
        .route("/metrics", get(metrics_prom))
        .route("/metrics/json", get(metrics_json))
        .route("/graph/trigger-refresh", post(trigger_refresh))
        .route("/events/json", get(events_json))
        .with_state(state);

    let addr: SocketAddr = (
        [127, 0, 0, 1],
        std::env::var("ARB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(4010),
    ).into();
    tracing::info!(?addr, "starting arb-rs server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("failed to install signal handler");
        sigterm.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! { _ = ctrl_c => {}, _ = terminate => {}, };
    tracing::info!("shutdown requested");
    tokio::time::sleep(Duration::from_millis(200)).await;
}

async fn get_opportunities(
    State(state): State<Arc<RwLock<AppState>>>,
) -> Json<OpportunitiesResponse> {
    let s = state.read().await;
    let items = s.opportunities.clone();
    // Build summary even if empty
    let count = items.len();
    let max_profit_bps = items.iter().map(|o| o.profit_bps).max().unwrap_or(0);
    let avg_profit_bps = if count == 0 { 0.0 } else { items.iter().map(|o| o.profit_bps as f64).sum::<f64>() / (count as f64) };
    let avg_net_bps = if count == 0 { 0.0 } else { items.iter().map(|o| o.net_bps.unwrap_or(o.profit_bps) as f64).sum::<f64>() / (count as f64) };
    let avg_hop_count = if count == 0 { 0.0 } else { items.iter().map(|o| o.hop_count.unwrap_or(o.path.len()) as f64).sum::<f64>() / (count as f64) };
    let avg_link_edges_used = if count == 0 { 0.0 } else { items.iter().map(|o| o.link_edges_used.unwrap_or(0) as f64).sum::<f64>() / (count as f64) };
    let min_edge_liquidity_vals: Vec<f64> = items.iter().map(|o| o.min_edge_liquidity.unwrap_or(0.0)).collect();
    let min_edge_liquidity_avg = if count == 0 { 0.0 } else { min_edge_liquidity_vals.iter().sum::<f64>() / (count as f64) };
    let min_edge_liquidity_min = min_edge_liquidity_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_edge_liquidity_min = if min_edge_liquidity_min.is_infinite() { 0.0 } else { min_edge_liquidity_min };
    let summary = OpportunitiesSummary {
        count,
        max_profit_bps,
        avg_profit_bps,
        avg_net_bps,
        avg_hop_count,
        avg_link_edges_used,
        min_edge_liquidity_avg,
        min_edge_liquidity_min,
        last_detection_ms: s.metrics.last_detection_ms,
        detection_duration_ms: s.metrics.detection_duration_ms,
        ingestion_duration_ms: s.metrics.ingestion_duration_ms,
        graph_nodes: s.metrics.graph_nodes,
        graph_edges: s.metrics.graph_edges,
        pools_amm: s.pool_cache.amm.len(),
        pools_clmm: s.pool_cache.clmm.len(),
        last_orca_ms: s.pool_cache.last_refresh_orca_ms,
        last_raydium_ms: s.pool_cache.last_refresh_raydium_ms,
        near_miss: s.near_miss.clone(),
        near_miss_shortfall_bps: s.near_miss_shortfall_bps,
    };
    Json(OpportunitiesResponse { items, summary: Some(summary) })
}

#[derive(Deserialize, Clone)]
struct StartReqNode { id: String }
#[derive(Deserialize, Clone)]
struct StartReqEdge {
    source: String,
    target: String,
    dex: Option<String>,
    fee_bps: Option<i64>,
    liquidity: Option<f64>,
    pool_id: Option<String>,
    liquidity_display: Option<f64>,
    price_a_per_b: Option<f64>,
}
#[derive(Deserialize, Clone)]
struct StartReqGraph { version: Option<u64>, timestamp: Option<u64>, nodes: Vec<StartReqNode>, edges: Vec<StartReqEdge> }

#[derive(Deserialize)]
struct StartReq { graph: Option<StartReqGraph>, enable: Option<bool> }

#[derive(Deserialize)]
struct GraphSnapshotReq { graph: StartReqGraph }

#[derive(Deserialize)]
struct GraphDiffNode { id: String, label: Option<String>, degree: Option<i64> }
#[derive(Deserialize)]
struct GraphDiffEdge {
    id: String,
    source: String,
    target: String,
    dex: Option<String>,
    pool_id: Option<String>,
    fee_bps: Option<i64>,
    liquidity: Option<f64>,
    liquidity_display: Option<f64>,
    price_a_per_b: Option<f64>,
}
#[derive(Deserialize)]
struct GraphDiffReq {
    version: Option<u64>,
    timestamp: Option<u64>,
    addedNodes: Option<Vec<GraphDiffNode>>,
    updatedNodes: Option<Vec<GraphDiffNode>>,
    removedNodeIds: Option<Vec<String>>,
    addedEdges: Option<Vec<GraphDiffEdge>>,
    updatedEdges: Option<Vec<GraphDiffEdge>>,
    removedEdgeIds: Option<Vec<String>>,
}

async fn arb_graph_snapshot(State(state): State<Arc<RwLock<AppState>>>, Json(req): Json<GraphSnapshotReq>) -> Json<serde_json::Value> {
    let mut s = state.write().await;
    let g = req.graph;
    tracing::info!(version = ?g.version, ts = ?g.timestamp, nodes = g.nodes.len(), edges = g.edges.len(), "arb.graph.snapshot: received");
    let mut new_graph = ArbGraph::new();
    for e in g.edges.into_iter() {
        let dex = e.dex.unwrap_or_else(|| "Unknown".to_string());
        let fee = e.fee_bps.unwrap_or(0);
        let liq = e.liquidity.unwrap_or(0.0);
        let pool_id = e.pool_id.unwrap_or_else(|| "".to_string());
        let liq_disp = e.liquidity_display.unwrap_or(0.0);
        // Backend sends price_a_per_b (A per 1 B) for edge source=A -> target=B.
        // Detector expects target-per-source (B per 1 A). Invert here.
        let px = if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px } else { 0.0 } } else { 0.0 };
        let base = if px > 0.0 { 1.0 / px } else { 0.0 };
        let rate_eff = if base > 0.0 { let f = 1.0 - (fee as f64)/10_000.0; base * if f > 0.0 { f } else { 0.0 } } else { 0.0 };
        new_graph.upsert_edge(&dex, &e.source, &e.target, EdgeData {
            rate_effective: rate_eff,
            fee_bps: fee,
            liquidity: liq,
            dex: dex.clone(),
            pool_id,
            liquidity_display: liq_disp,
        });
    }
    s.graph = new_graph;
    s.metrics.graph_nodes = s.graph.g.node_count() as u64;
    s.metrics.graph_edges = s.graph.g.edge_count() as u64;
    s.last_graph_version = g.version.unwrap_or(s.last_graph_version);
    s.last_graph_ts = g.timestamp.unwrap_or(s.last_graph_ts);
    s.use_backend_graph = true;
    s.force_refresh_next = false;
    let nodes = s.metrics.graph_nodes; let edges = s.metrics.graph_edges;
    s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.graph.snapshot: accepted nodes={} edges={}", nodes, edges) });
    let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
    Json(serde_json::json!({"ok": true, "nodes": nodes, "edges": edges}))
}

async fn arb_graph_update(State(state): State<Arc<RwLock<AppState>>>, Json(req): Json<GraphDiffReq>) -> Json<serde_json::Value> {
    // Buffer the diff to apply between loop iterations to avoid contention
    let mut s = state.write().await;
    if let Some(v) = req.version { if v <= s.last_graph_version { s.metrics.graph_updates_skipped = s.metrics.graph_updates_skipped.saturating_add(1); return Json(serde_json::json!({"ok": true, "skipped": true })); } }
    if let Some(removed) = req.removedEdgeIds { let n = removed.len(); s.pending_removed_edge_ids.extend(removed); tracing::info!(removed=n, "arb.graph.diff: buffered removed edges"); }
    if let Some(added) = req.addedEdges { let n = added.len(); s.pending_added_edges.extend(added); tracing::info!(added=n, "arb.graph.diff: buffered added edges"); }
    if let Some(updated) = req.updatedEdges { let n = updated.len(); s.pending_updated_edges.extend(updated); tracing::info!(updated=n, "arb.graph.diff: buffered updated edges"); }
    if req.version.is_some() { s.pending_graph_version = req.version; }
    if req.timestamp.is_some() { s.pending_graph_ts = req.timestamp; }
    s.use_backend_graph = true;
    s.force_refresh_next = false;
    Json(serde_json::json!({"ok": true}))
}

async fn arb_start(State(state): State<Arc<RwLock<AppState>>>, Json(req): Json<StartReq>) -> Json<serde_json::Value> {
    // Build graph outside lock
    let prebuilt: Option<(ArbGraph, Option<u64>, Option<u64>, u64, u64)> = if let Some(g) = req.graph.clone() {
        tracing::info!(version = ?g.version, ts = ?g.timestamp, nodes = g.nodes.len(), edges = g.edges.len(), "arb.start: graph received");
        let mut new_graph = ArbGraph::new();
        for e in g.edges.into_iter() {
            let dex = e.dex.unwrap_or_else(|| "Unknown".to_string());
            let fee = e.fee_bps.unwrap_or(0);
            let liq = e.liquidity.unwrap_or(0.0);
            let pool_id = e.pool_id.unwrap_or_else(|| "".to_string());
            let liq_disp = e.liquidity_display.unwrap_or(0.0);
            // price_a_per_b is A per 1 B for edge source=A -> target=B; invert to B per 1 A
            let px = if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px } else { 0.0 } } else { 0.0 };
            let base = if px > 0.0 { 1.0 / px } else { 0.0 };
            let rate_eff = if base > 0.0 { let f = 1.0 - (fee as f64)/10_000.0; base * if f > 0.0 { f } else { 0.0 } } else { 0.0 };
            new_graph.upsert_edge(&dex, &e.source, &e.target, EdgeData { rate_effective: rate_eff, fee_bps: fee, liquidity: liq, dex: dex.clone(), pool_id, liquidity_display: liq_disp });
        }
        let nodes_cnt = new_graph.g.node_count() as u64;
        let edges_cnt = new_graph.g.edge_count() as u64;
        Some((new_graph, g.version, g.timestamp, nodes_cnt, edges_cnt))
    } else { None };

    let mut s = state.write().await;
    if let Some((new_graph, v, ts, nodes_cnt, edges_cnt)) = prebuilt {
        s.graph = new_graph;
        s.metrics.graph_nodes = nodes_cnt;
        s.metrics.graph_edges = edges_cnt;
        if let Some(vv) = v { s.last_graph_version = vv; }
        if let Some(tt) = ts { s.last_graph_ts = tt; }
        s.use_backend_graph = true;
        s.force_refresh_next = false;
        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.start: graph accepted nodes={} edges={}", nodes_cnt, edges_cnt) });
        let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
    }
    if let Some(want) = req.enable {
        if want && !s.config.enabled {
            tracing::info!("arb.start: enabling loop");
            s.config.enabled = true;
        } else if !want && s.config.enabled {
            tracing::info!("arb.stop: disabling loop");
            s.config.enabled = false;
        }
    } else {
        if !s.config.enabled { tracing::info!("arb.start: enabling loop"); }
        s.config.enabled = true;
    }
    Json(serde_json::json!({ "ok": true, "enabled": s.config.enabled, "graph_nodes": s.metrics.graph_nodes, "graph_edges": s.metrics.graph_edges }))
}

#[derive(Serialize)]
struct PoolsResp { amm: usize, clmm: usize, last_orca_ms: u64, last_raydium_ms: u64 }

async fn get_pools(State(state): State<Arc<RwLock<AppState>>>) -> Json<PoolsResp> {
    let s = state.read().await;
    Json(PoolsResp {
        amm: s.pool_cache.amm.len(),
        clmm: s.pool_cache.clmm.len(),
        last_orca_ms: s.pool_cache.last_refresh_orca_ms,
        last_raydium_ms: s.pool_cache.last_refresh_raydium_ms,
    })
}

#[derive(serde::Deserialize)]
struct QuoteReq { input_mint: String, output_mint: String, amount: f64 }

#[derive(Serialize)]
struct QuoteResp { rate: f64, out_amount: f64 }

async fn get_quote(State(state): State<Arc<RwLock<AppState>>>, Query(q): Query<QuoteReq>) -> Json<QuoteResp> {
    let s = state.read().await;
    let fee_dec = (s.config.fee_bps as f64) / 10_000.0;
    let slip_dec = (s.config.max_slippage_bps as f64) / 10_000.0;
    let adj = |r: f64| {
        let f1 = 1.0 - fee_dec;
        let f2 = 1.0 - slip_dec;
        r.max(1e-12) * (if f1 > 0.0 { f1 } else { 0.0 }) * (if f2 > 0.0 { f2 } else { 0.0 })
    };
    // Try AMM first
    for p in s.pool_cache.amm.iter() {
        if (p.mint_a == q.input_mint && p.mint_b == q.output_mint) && p.price_a_per_b > 0.0 {
            let rate = adj(1.0 / p.price_a_per_b);
            return Json(QuoteResp { rate, out_amount: rate * q.amount });
        }
        if (p.mint_b == q.input_mint && p.mint_a == q.output_mint) && p.price_a_per_b > 0.0 {
            let rate = adj(p.price_a_per_b);
            return Json(QuoteResp { rate, out_amount: rate * q.amount });
        }
    }
    // Try CLMM approximate mid-price
    for p in s.pool_cache.clmm.iter() {
        if (p.mint_a == q.input_mint && p.mint_b == q.output_mint) && p.sqrt_price_x64 > 0.0 {
            let s64 = p.sqrt_price_x64;
            let price_b_per_a = (s64 * s64) / (2f64.powi(128));
            if price_b_per_a > 0.0 {
                let rate = adj(price_b_per_a);
                return Json(QuoteResp { rate, out_amount: rate * q.amount });
            }
        }
        if (p.mint_b == q.input_mint && p.mint_a == q.output_mint) && p.sqrt_price_x64 > 0.0 {
            let s64 = p.sqrt_price_x64;
            let price_b_per_a = (s64 * s64) / (2f64.powi(128));
            if price_b_per_a > 0.0 {
                let rate = adj(1.0 / price_b_per_a);
                return Json(QuoteResp { rate, out_amount: rate * q.amount });
            }
        }
    }
    // Fallback
    Json(QuoteResp { rate: 0.0, out_amount: 0.0 })
}

async fn ws_opportunities(ws: WebSocketUpgrade, State(state): State<Arc<RwLock<AppState>>>) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut last: Option<String> = None;
        loop {
            let items = {
                let s = state.read().await;
                s.opportunities.clone()
            };
            let payload = serde_json::json!({ "items": items });
            let text = payload.to_string();
            if last.as_ref() != Some(&text) {
                if socket.send(Message::Text(text.clone())).await.is_err() { break; }
                last = Some(text);
                let mut s = state.write().await;
                s.metrics.ws_push_total += 1;
            } else {
                let mut s = state.write().await;
                s.metrics.ws_skipped_nochange_total += 1;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    })
}

#[derive(serde::Deserialize)]
struct ConfigReq {
    enabled: Option<bool>,
    min_profit_bps: Option<i64>,
    min_notional_usd: Option<f64>,
    max_hops: Option<usize>,
    max_paths_per_cycle: Option<usize>,
    poll_interval_ms: Option<u64>,
    dex_allow: Option<Vec<String>>,
    priority_fee_tier: Option<String>,
    sources: Option<SourcesCfg>,
    max_slippage_bps: Option<i64>,
    execution_mode: Option<String>,
    quote_size_usd: Option<f64>,
    fee_bps: Option<i64>,
    link_penalty_bps: Option<i64>,
    debug_emit_subthreshold: Option<bool>,
    debug_top_n: Option<usize>,
    near_miss_enable: Option<bool>,
    near_miss_epsilon: Option<f64>,
}

async fn set_config(
    State(state): State<Arc<RwLock<AppState>>>,
    Json(cfg): Json<ConfigReq>,
) -> Json<serde_json::Value> {
    let mut s = state.write().await;
    if let Some(v) = cfg.enabled { s.config.enabled = v; }
    if let Some(v) = cfg.min_profit_bps { s.config.min_profit_bps = v; }
    if let Some(v) = cfg.min_notional_usd { s.config.min_notional_usd = v; }
    if let Some(v) = cfg.max_hops { s.config.max_hops = v; }
    if let Some(v) = cfg.max_paths_per_cycle { s.config.max_paths_per_cycle = v; }
    if let Some(v) = cfg.poll_interval_ms { s.config.poll_interval_ms = v; }
    if let Some(v) = cfg.dex_allow { s.config.dex_allow = v; }
    if let Some(v) = cfg.priority_fee_tier { s.config.priority_fee_tier = v; }
    if let Some(v) = cfg.sources { s.config.sources = v; }
    if let Some(v) = cfg.max_slippage_bps { s.config.max_slippage_bps = v; }
    if let Some(v) = cfg.execution_mode { s.config.execution_mode = v; }
    if let Some(v) = cfg.quote_size_usd { s.config.quote_size_usd = v; }
    if let Some(v) = cfg.fee_bps { s.config.fee_bps = v; }
    if let Some(v) = cfg.link_penalty_bps { s.config.link_penalty_bps = v; }
    if let Some(v) = cfg.debug_emit_subthreshold { s.config.debug_emit_subthreshold = v; }
    if let Some(v) = cfg.debug_top_n { s.config.debug_top_n = v; }
    if let Some(v) = cfg.near_miss_enable { s.config.near_miss_enable = v; }
    if let Some(v) = cfg.near_miss_epsilon { s.config.near_miss_epsilon = v; }
    let _ = persist_config(&s.config).await;
    Json(serde_json::json!({"ok": true, "config": &s.config}))
}

async fn get_config(State(state): State<Arc<RwLock<AppState>>>) -> Json<ArbConfig> {
    let s = state.read().await;
    Json(s.config.clone())
}

fn default_config() -> ArbConfig {
    ArbConfig {
        enabled: false,
        min_profit_bps: 30,
        min_notional_usd: 50.0,
        max_hops: 3,
        max_paths_per_cycle: 10,
        poll_interval_ms: 2000,
        dex_allow: vec!["Raydium".into(), "Orca".into()],
        priority_fee_tier: "h".into(),
        sources: SourcesCfg { jupiter: false, raydium: true, orca: true },
        max_slippage_bps: 100,
        execution_mode: "simulate".into(),
        quote_size_usd: 50.0,
        fee_bps: 30,
        link_penalty_bps: 2,
        debug_emit_subthreshold: false,
        debug_top_n: 5,
        near_miss_enable: true,
        near_miss_epsilon: 5e-4,
        min_pool_liquidity: 0.0,
    }
}

async fn persist_config(cfg: &ArbConfig) -> anyhow::Result<()> {
    let path = std::env::var("ARB_CONFIG_PATH").unwrap_or_else(|_| "arb-config.json".into());
    let data = serde_json::to_string_pretty(cfg)?;
    tokio::fs::write(path, data).await?;
    Ok(())
}

async fn metrics_json(State(state): State<Arc<RwLock<AppState>>>) -> Json<Metrics> {
    let s = state.read().await;
    Json(s.metrics.clone())
}

async fn metrics_prom(State(state): State<Arc<RwLock<AppState>>>) -> String {
    let m = { state.read().await.metrics.clone() };
    format!(
        concat!(
            "arb_detection_cycles_total {}\n",
            "arb_opportunities_active {}\n",
            "arb_last_detection_ms {}\n",
            "arb_detection_duration_ms {}\n",
            "arb_ingestion_duration_ms {}\n",
            "arb_graph_nodes {}\n",
            "arb_graph_edges {}\n",
            "arb_ingestion_requests_total{{source=\"jupiter\"}} {}\n",
            "arb_ingestion_requests_total{{source=\"raydium\"}} {}\n",
            "arb_ingestion_requests_total{{source=\"orca\"}} {}\n",
            "arb_ingestion_errors_total{{source=\"jupiter\"}} {}\n",
            "arb_ingestion_errors_total{{source=\"raydium\"}} {}\n",
            "arb_ingestion_errors_total{{source=\"orca\"}} {}\n",
            "arb_ws_push_total {}\n",
            "arb_ws_skipped_nochange_total {}\n",
            "arb_max_profit_bps {}\n",
            "arb_avg_profit_bps {}\n"
        ),
        m.detection_cycles_total,
        m.opportunities_active,
        m.last_detection_ms,
        m.detection_duration_ms,
        m.ingestion_duration_ms,
        m.graph_nodes,
        m.graph_edges,
        m.ingestion_requests_total_jupiter,
        m.ingestion_requests_total_raydium,
        m.ingestion_requests_total_orca,
        m.ingestion_errors_total_jupiter,
        m.ingestion_errors_total_raydium,
        m.ingestion_errors_total_orca,
        m.ws_push_total,
        m.ws_skipped_nochange_total,
        m.max_profit_bps,
        m.avg_profit_bps
    )
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(serde::Serialize)]
struct EventsResponse { events: Vec<EventItem> }

async fn events_json(State(state): State<Arc<RwLock<AppState>>>) -> Json<EventsResponse> {
    let s = state.read().await;
    Json(EventsResponse { events: s.events.clone() })
}

#[derive(serde::Deserialize)]
struct TriggerReq { reason: Option<String> }

async fn trigger_refresh(State(state): State<Arc<RwLock<AppState>>>, Json(_req): Json<TriggerReq>) -> Json<serde_json::Value> {
    {
        let mut s = state.write().await;
        s.force_refresh_next = true;
        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: "graph.trigger_refresh".into() });
        let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
    }
    Json(serde_json::json!({"ok": true}))
}


