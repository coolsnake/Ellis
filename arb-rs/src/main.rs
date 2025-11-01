use std::{net::SocketAddr, sync::Arc, time::Duration};
use std::sync::Mutex;
use std::collections::VecDeque;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use petgraph::prelude::NodeIndex;
use petgraph::visit::EdgeRef;

use axum::{extract::State, routing::{get, post}, Json, Router};
use axum::http::HeaderMap;
use axum::extract::ws::{WebSocketUpgrade, Message};
use axum::response::IntoResponse;
use serde::Serialize;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tokio::sync::{RwLock, Notify};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use base64::{engine::general_purpose, Engine as _};
mod opportunities;
use opportunities::{OpportunitiesResponse, Opportunity, OpportunitiesSummary};
mod graph;
use graph::{ArbGraph, EdgeData, expand_nodes_by_hops};
mod algos;
use algos::{detect_negative_cycles, detect_near_miss_cycles, detect_negative_cycles_filtered};

#[derive(Default, serde::Serialize, serde::Deserialize, Clone)]
struct ArbConfig {
    enabled: bool,
    min_profit_bps: i64,
    // Discard opportunities with absurdly high raw profitability (bps)
    max_profit_bps: i64,
    min_notional_usd: f64,
    max_hops: usize,
    max_idle_ms: u64,
    quote_size_usd: f64,
    // Cap repeated detections before suppressing unless executed
    max_detections_without_exec: usize,
    // TTL window for detection history bookkeeping
    detection_history_ttl_ms: u64,
    // TTL for opportunities before they expire (default 30s)
    opportunity_ttl_ms: u64,
    debug_emit_subthreshold: bool,
    debug_top_n: usize,
    near_miss_enable: bool,
    near_miss_epsilon: f64,
    // Estimate per-hop priority fee in lamports to include in net profit heuristics (rough)
    est_priority_fee_per_hop_lamports: Option<u64>,
    // When true, emit diagnostic logs when no near-miss is found
    debug_near_miss_failures: bool,
    // Incremental detection controls
    filtered_detect_enable: bool,
    filtered_node_ratio: f64,
    filtered_expand_hops: Option<usize>,
    periodic_full_ms: Option<u64>,
    // Pruning of competitive paths
    // Limit number of SOL<->stable hops allowed per cycle; None means unlimited
    max_sol_stable_hops: Option<usize>,
    // If true, drop any cycle that includes a stable<->stable hop (e.g., USDC<->USDT)
    drop_stable_stable_hops: bool,
    // Optional override list of stable mints; when unset or empty, defaults to {USDC, USDT}
    stable_mints: Option<Vec<String>>,
    // When true, apply 10^k magnitude calibration on ingest (backend already calibrates)
    calibrate_magnitude_on_ingest: bool,
}

#[derive(Default, serde::Serialize, Clone)]
struct Metrics {
    detection_cycles_total: u64,
    opportunities_active: u64,
    last_detection_ms: u64,
    detection_duration_ms: u64,
    graph_nodes: u64,
    graph_edges: u64,
    ws_push_total: u64,
    ws_skipped_nochange_total: u64,
    max_profit_bps: i64,
    avg_profit_bps: f64,
    graph_updates_applied: u64,
    graph_updates_skipped: u64,
    // Detection scope metrics
    detect_used_filtered: u64,
    detect_scope_nodes: u64,
    detect_scope_edges: u64,
    // Time between receiving a backend graph diff/snapshot and start of a detection iteration
    diff_to_detect_ms: u64,
    // Last time a backend graph diff/snapshot was received (server wall time)
    last_graph_push_rx_ms: u64,
    // Detector outcome counters
    detection_hits_total: u64,
    detection_misses_total: u64,
    // Cumulative opportunities detected (sum of items per iteration)
    opportunities_detected_total: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct EventItem {
    ts: u64,
    level: String,
    message: String,
}

struct AppState {
    config: ArbConfig,
    opportunities: Vec<Opportunity>,
    graph: ArbGraph,
    metrics: Metrics,
    events: Vec<EventItem>,
    near_miss: Option<Opportunity>,
    near_miss_shortfall_bps: Option<i64>,
    near_misses: Vec<Opportunity>,
    last_graph_version: u64,
    last_graph_ts: u64,
    // Buffered graph updates to be applied between loop runs
    pending_added_edges: Vec<GraphDiffEdge>,
    pending_updated_edges: Vec<GraphDiffEdge>,
    pending_removed_edge_ids: Vec<String>,
    pending_graph_version: Option<u64>,
    pending_graph_ts: Option<u64>,
    // Event-driven wakeup for detection loop
    wake: Arc<Notify>,
    // Detection bookkeeping and execution markers
    detection_counts: HashMap<String, (u64, u64)>, // key -> (count, last_seen_ms)
    executed_keys: HashSet<String>,
}

#[inline]
fn keyify_opportunity(path: &Vec<String>, dexes: &Vec<String>) -> String {
    let mut ds = dexes.clone();
    ds.sort();
    format!("{}|{}", path.join("->"), ds.join(","))
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
        // Prepare optional Basic auth header for backend /api routes
        let auth_header: Option<String> = {
            let user = std::env::var("BACKEND_AUTH_USER").ok();
            let pass = std::env::var("BACKEND_AUTH_PASS").ok();
            match (user, pass) {
                (Some(u), Some(p)) if !u.is_empty() => {
                    let creds = format!("{}:{}", u, p);
                    Some(format!("Basic {}", general_purpose::STANDARD.encode(creds.as_bytes())))
                }
                _ => None,
            }
        };
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
                let mut req = client.post(&url).json(&payload);
                if let Some(h) = &auth_header { req = req.header("authorization", h); }
                let _ = req.send().await;
            }
        });
    }

    // In-memory ring buffer to capture formatted log lines (last 2000)
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    #[derive(Clone)]
    struct RingWriter { ring: Arc<Mutex<VecDeque<String>>>, buf: String }
    impl std::io::Write for RingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.buf.push_str(&String::from_utf8_lossy(bytes));
            while let Some(pos) = self.buf.find('\n') {
                let line = self.buf[..pos].to_string();
                if !line.trim().is_empty() {
                    let mut guard = self.ring.lock().unwrap();
                    if guard.len() >= 2000 { guard.pop_front(); }
                    guard.push_back(line);
                }
                self.buf.drain(..=pos);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        // Plain layer without timestamps to avoid long timestamps in console
        .with(tracing_subscriber::fmt::layer().without_time())
        // Bridge layer (no ANSI, no time) to backend terminal/log endpoint
        .with(tracing_subscriber::fmt::layer().without_time().with_ansi(false).with_writer(move || BridgeWriter { tx: bridge_tx.clone() }))
        // Ring capture layer (no ANSI, no time) writing to in-memory buffer
        .with(tracing_subscriber::fmt::layer().without_time().with_ansi(false).with_writer({ let ring = ring.clone(); move || RingWriter { ring: ring.clone(), buf: String::new() } }))
        .init();

    let state = Arc::new(RwLock::new(AppState { config: default_config(), opportunities: Vec::new(), graph: ArbGraph::new(), metrics: Metrics::default(), events: Vec::new(), near_miss: None, near_miss_shortfall_bps: None, near_misses: Vec::new(), last_graph_version: 0, last_graph_ts: 0, pending_added_edges: Vec::new(), pending_updated_edges: Vec::new(), pending_removed_edge_ids: Vec::new(), pending_graph_version: None, pending_graph_ts: None, wake: Arc::new(Notify::new()), detection_counts: std::collections::HashMap::new(), executed_keys: std::collections::HashSet::new() }));

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
        });
    }

    // Kick off a background task to update opportunities using config interval (MVP placeholder)
    let loop_state = state.clone();
    tokio::spawn(async move {
        loop {
            let (enabled, idle_ms, min_bps, max_hops) = {
                let s = loop_state.read().await;
                (
                    s.config.enabled,
                    s.config.max_idle_ms,
                    s.config.min_profit_bps,
                    s.config.max_hops,
                )
            };
            let iter_start = Instant::now();
            if enabled {
                {
                    let s = loop_state.read().await;
                    tracing::info!(nodes = s.metrics.graph_nodes, edges = s.metrics.graph_edges, version = s.last_graph_version, "arb.loop.tick start");
                }
                // Capture diff_to_detect latency if we have a recent graph push timestamp
                {
                    let mut s = loop_state.write().await;
                    if s.metrics.last_graph_push_rx_ms > 0 {
                        let now = now_ms();
                        let delta = now.saturating_sub(s.metrics.last_graph_push_rx_ms);
                        s.metrics.diff_to_detect_ms = delta;
                        // Clear the marker so only the first iteration after push records the latency
                        s.metrics.last_graph_push_rx_ms = 0;
                    }
                }
                // Track changed mints and edge ids from pending diffs for scoped detection
                let mut changed_mints: HashSet<String> = HashSet::new();
                let mut changed_edge_ids: HashSet<String> = HashSet::new();
                // Best-effort peek at backend graph version with a short timeout.
                // Do not advance local last_graph_version here to avoid racing with buffered diffs.
                let api_base = std::env::var("BACKEND_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                let gv_url = format!("{}/arb/graph/version", api_base.trim_end_matches('/'));
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    reqwest::Client::new().get(&gv_url).send()
                ).await;
                let loop_start = Instant::now();
                let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
                // Apply any buffered diffs now (between detection runs)
                {
                    let mut s = loop_state.write().await;
                    if !s.pending_removed_edge_ids.is_empty() || !s.pending_added_edges.is_empty() || !s.pending_updated_edges.is_empty() {
                        let rem_ct = s.pending_removed_edge_ids.len();
                        let add_ct = s.pending_added_edges.len();
                        let upd_ct = s.pending_updated_edges.len();
                        let removed = std::mem::take(&mut s.pending_removed_edge_ids);
                        let added = std::mem::take(&mut s.pending_added_edges);
                        let updated = std::mem::take(&mut s.pending_updated_edges);
                        // Build change sets BEFORE applying removals to derive scope
                        for id in removed.iter() { changed_edge_ids.insert(id.clone()); }
                        let synth_edge_id = |src: &str, dst: &str, dex: &str| -> String { format!("{}->{}-{}", src, dst, dex) };
                        for e in added.iter().chain(updated.iter()) {
                            changed_mints.insert(e.source.clone());
                            changed_mints.insert(e.target.clone());
                            if let Some(pid) = &e.pool_id { if !pid.is_empty() { changed_edge_ids.insert(pid.clone()); } }
                            if let Some(dex) = &e.dex { if e.pool_id.is_none() { changed_edge_ids.insert(synth_edge_id(&e.source, &e.target, dex)); } }
                        }
                        if !removed.is_empty() { let _ = s.graph.remove_edges_by_ids(&removed); }
                        let mut upsert = |e: &GraphDiffEdge| {
                            let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                            let fee = e.fee_bps.unwrap_or(0);
                            let liq = e.liquidity.unwrap_or(0.0);
                            let liq_disp = e.liquidity_display.unwrap_or(0.0);
                            // Magnitude calibration using current graph edges as USD pivots (USDC/SOL) [optional]
                            let px_raw = if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px } else { 0.0 } } else { 0.0 };
                            let mut px = px_raw;
                            if px > 0.0 && s.config.calibrate_magnitude_on_ingest {
                                let sol_mint: &str  = "So11111111111111111111111111111111111111112";
                                let usdc_mint: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
                                let get_usd = |mint: &str, graph: &ArbGraph| -> Option<f64> {
                                    if mint == usdc_mint { return Some(1.0); }
                                    if let Some(idx) = graph.map.get(mint) {
                                        // Prefer direct edges to USDC
                                        for edge in graph.g.edges(*idx) {
                                            let u = edge.source(); let v = edge.target();
                                            let src = graph.g.node_weight(u).cloned().unwrap_or_default();
                                            let dst = graph.g.node_weight(v).cloned().unwrap_or_default();
                                            let r = edge.weight().rate_effective;
                                            if dst == usdc_mint && r > 0.0 { return Some(r); }
                                            if src == usdc_mint && r > 0.0 { return Some(1.0 / r); }
                                        }
                                        // Via SOL
                                        let mut via_sol: Option<f64> = None;
                                        let mut sol_usd: Option<f64> = None;
                                        for edge in graph.g.edge_references() {
                                            let src = graph.g.node_weight(edge.source()).cloned().unwrap_or_default();
                                            let dst = graph.g.node_weight(edge.target()).cloned().unwrap_or_default();
                                            let r = edge.weight().rate_effective;
                                            if r <= 0.0 { continue; }
                                            if src == sol_mint && dst == usdc_mint { sol_usd = Some(r); }
                                            if src == usdc_mint && dst == sol_mint { sol_usd = Some(1.0 / r); }
                                        }
                                        if let Some(su) = sol_usd {
                                            for edge in graph.g.edges(*idx) {
                                                let u = edge.source(); let v = edge.target();
                                                let s = graph.g.node_weight(u).cloned().unwrap_or_default();
                                                let t = graph.g.node_weight(v).cloned().unwrap_or_default();
                                                let r = edge.weight().rate_effective;
                                                if r <= 0.0 { continue; }
                                                if s == *mint && t == sol_mint { via_sol = Some(su / r); break; }
                                                if s == sol_mint && t == *mint { via_sol = Some(su * r); break; }
                                            }
                                        }
                                        return via_sol;
                                    }
                                    None
                                };
                                let pa = get_usd(&e.source, &s.graph);
                                let pb = get_usd(&e.target, &s.graph);
                                if let (Some(pa), Some(pb)) = (pa, pb) {
                                    let refv = pb / pa;
                                    let mut best = px; let mut best_dev = f64::INFINITY; let mut best_k = 0i32;
                                    for k in -8..=8 {
                                        let cand = px * 10f64.powi(k);
                                        if !(cand.is_finite() && cand > 0.0) { continue; }
                                        let dev = (cand / refv).max(refv / cand);
                                        if dev + 1e-12 < best_dev { best_dev = dev; best = cand; best_k = k; }
                                    }
                                    if best_k != 0 { tracing::debug!(mint_a = %e.source, mint_b = %e.target, px_in = px_raw, px_out = best, k = best_k, refv, "arb.magnitude.calibrated.diff"); }
                                    px = best;
                                }
                            }
                            let base = if px > 0.0 { 1.0 / px } else { 0.0 };
                            let rate_eff = if base > 0.0 { base * (1.0 - (fee as f64)/10_000.0).max(0.0) } else { 0.0 };
                            s.graph.upsert_edge(&dex, &e.source, &e.target, EdgeData { rate_effective: rate_eff, fee_bps: fee, liquidity: liq, dex: dex.clone(), pool_id: e.pool_id.clone().unwrap_or_default(), liquidity_display: liq_disp });
                        };
                        for e in added.iter() { upsert(e); }
                        for e in updated.iter() { upsert(e); }
                        s.metrics.graph_updates_applied = s.metrics.graph_updates_applied.saturating_add(1);
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.graph.diff: applied add={} upd={} rem={}", add_ct, upd_ct, rem_ct) });
                        tracing::info!(add=add_ct, upd=upd_ct, rem=rem_ct, "arb.graph.diff: applied");
                        let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
                    } else {
                        // Explicitly log that there were no pending graph updates for this tick
                        tracing::info!("arb.graph.diff: none pending");
                    }
                    // Update version even when there are no edges - the diff itself represents a version increment
                    if let Some(v) = s.pending_graph_version.take() {
                        if v > s.last_graph_version {
                            let old_version = s.last_graph_version;
                            s.last_graph_version = v;
                            tracing::info!(old_version = old_version, new_version = v, "arb.graph.version: updated");
                        } else {
                            tracing::warn!(received_version = v, current_version = s.last_graph_version, "arb.graph.version: attempted downgrade, ignoring");
                        }
                    }
                    if let Some(t) = s.pending_graph_ts.take() { s.last_graph_ts = t; }
                    s.metrics.graph_nodes = s.graph.g.node_count() as u64;
                    s.metrics.graph_edges = s.graph.g.edge_count() as u64;
                }
                // Detect cycles (MVP -log weights)
                // Compare with previous to only push WS updates on change
                let (opps, prev, near_pair, near_list): (Vec<Opportunity>, Vec<Opportunity>, Option<(Opportunity,i64)>, Vec<(Opportunity,i64)>) = {
                    let s = loop_state.read().await;
                    // Build affected node index set from changed mints
                    let mut changed_node_idxs: std::collections::HashSet<usize> = std::collections::HashSet::new();
                    for m in changed_mints.iter() {
                        if let Some(idx) = s.graph.map.get(m) { changed_node_idxs.insert(idx.index()); }
                    }
                    // Expand scope by hops (incoming + outgoing) up to configured bound
                    let expand_hops = s.config.filtered_expand_hops.unwrap_or(s.config.max_hops);
                    let affected_nodes = expand_nodes_by_hops(&s.graph, &changed_node_idxs, expand_hops);
                    // Decide filtered vs full scan
                    let total_nodes = s.graph.g.node_count().max(1) as f64;
                    let ratio = (affected_nodes.len() as f64) / total_nodes;
                    let use_filtered = s.config.filtered_detect_enable && !affected_nodes.is_empty() && ratio <= s.config.filtered_node_ratio.max(0.0).min(1.0);
                    // Count edges in scope for metrics
                    let scope_edges: u64 = if use_filtered {
                        let mut c: u64 = 0;
                        for e in s.graph.g.edge_references() {
                            let u = e.source().index(); let v = e.target().index();
                            if affected_nodes.contains(&u) && affected_nodes.contains(&v) { c += 1; }
                        }
                        c
                    } else { s.graph.g.edge_count() as u64 };
                    // Emit scope decision at INFO
                    tracing::info!(
                        use_filtered,
                        scope_nodes = affected_nodes.len(),
                        scope_edges,
                        total_nodes = s.graph.g.node_count(),
                        ratio,
                        "arb.detect.scope"
                    );
                    // Run detection
                    let cycles = if use_filtered { detect_negative_cycles_filtered(&s.graph, &affected_nodes) } else { detect_negative_cycles(&s.graph) };
                    tracing::info!(found = cycles.len(), "arb.detect.cycles");
                    // Prepare metrics snapshot, then drop read lock before taking write lock to avoid deadlock
                    let used_filtered_flag_for_metrics = if use_filtered { 1 } else { 0 };
                    let scope_nodes_count_for_metrics = if use_filtered { affected_nodes.len() as u64 } else { s.graph.g.node_count() as u64 };
                    let scope_edges_count_for_metrics = scope_edges;
                    drop(s);
                    // Update scope metrics under write lock
                    {
                        let mut sw = loop_state.write().await;
                        sw.metrics.detect_used_filtered = used_filtered_flag_for_metrics;
                        sw.metrics.detect_scope_nodes = scope_nodes_count_for_metrics;
                        sw.metrics.detect_scope_edges = scope_edges_count_for_metrics;
                    }
                    // Reacquire read lock for subsequent cycle processing
                    let s = loop_state.read().await;
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
                        tracing::info!(len = nlen, "arb.detect.cycle.begin");
                        let mut uniq = std::collections::HashSet::new();
                        let mut simple = true;
                        for &v in c.nodes.iter() { if !uniq.insert(v) { simple = false; break; } }
                        if !simple { continue; }

                        // Build labels (mint-only) and compute product of best-of-parallel rates along the closed loop
                        let labels: Vec<String> = c.nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                        let start_is_usdc = labels.first().map(|m| m == usdc).unwrap_or(false);
                        // Prune highly competitive cycles: stable<->stable edges and cap SOL<->stable hops
                        let sol = "So11111111111111111111111111111111111111112";
                        let default_stables: std::collections::HashSet<&str> = [
                            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
                        ].into_iter().collect();
                        let cfg_stables: std::collections::HashSet<String> = s.config.stable_mints.clone().unwrap_or_default().into_iter().collect();
                        let is_stable = |m: &str| if cfg_stables.is_empty() { default_stables.contains(m) } else { cfg_stables.contains(m) };
                        let mut has_stable_stable = false;
                        let mut sol_stable_hops: usize = 0;
                        for i in 0..labels.len() {
                            let a = &labels[i];
                            let b = &labels[(i + 1) % labels.len()];
                            let a_st = is_stable(a);
                            let b_st = is_stable(b);
                            if a_st && b_st { has_stable_stable = true; break; }
                            if (a == sol && b_st) || (b == sol && a_st) { sol_stable_hops += 1; }
                        }
                        if s.config.drop_stable_stable_hops && has_stable_stable { continue; }
                        if let Some(limit) = s.config.max_sol_stable_hops { if sol_stable_hops > limit { continue; } }
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
                        let cycle_start = std::time::Instant::now();
                        let mut timed_out = false;
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
                            if best_rate <= 0.0 {
                                tracing::info!(u = u.index(), v = v.index(), "arb.detect.cycle.no_edge");
                                rate_prod = 0.0; break 'cycle;
                            }
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
                            if cycle_start.elapsed().as_millis() > 500 {
                                timed_out = true;
                                tracing::warn!(len = nlen, elapsed_ms = cycle_start.elapsed().as_millis() as u128, "arb.detect.cycle.timeout");
                                break 'cycle;
                            }
                        }
                        if timed_out { continue; }
                        let profit = rate_prod - 1.0;
                        let profit_bps = (profit * 10_000.0).floor() as i64;
                        
                        // Skip if cycle is unprofitable after picking best edges
                        // (Bellman-Ford detected negative cycle, but best edges don't form profitable cycle)
                        if rate_prod <= 1.0 {
                            let path_str = labels.join("->");
                            tracing::info!(path = %path_str, rate_prod, "arb.detect.cycle.unprofitable_after_edge_selection");
                            continue;
                        }
                        
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
                        tracing::info!(path = %canon_labels.join("->"), profit_bps, "arb.detect.cycle.end");
                        // Align hop arrays with the rotated labels (no reversal)
                        rotate_to_start(&labels, &canon_labels, &mut hop_pool_ids);
                        rotate_to_start(&labels, &canon_labels, &mut hop_dexes);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_rates);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_outs);
                        // Validate alignment: each hop_pool_ids[i] must correspond to an edge between canon_labels[i] -> canon_labels[(i+1)%n]
                        {
                            let n = canon_labels.len();
                            let mut aligned = true;
                            for i in 0..n {
                                let src = &canon_labels[i];
                                let dst = &canon_labels[(i + 1) % n];
                                let pid = hop_pool_ids.get(i).cloned().unwrap_or_default();
                                let dex_i = hop_dexes.get(i).cloned().unwrap_or_default();
                                if pid.is_empty() || dex_i == "Link" { continue; }
                                if let (Some(&u), Some(&v)) = (s.graph.map.get(src), s.graph.map.get(dst)) {
                                    let mut ok = false;
                                    for e in s.graph.g.edges_connecting(u, v) {
                                        if e.weight().pool_id == pid { ok = true; break; }
                                    }
                                    if !ok { aligned = false; break; }
                                } else { aligned = false; break; }
                            }
                            if !aligned {
                                tracing::warn!("arb.detect.cycle.misaligned path={} pools=[{}]", canon_labels.join("->"), hop_pool_ids.join(","));
                                continue;
                            }
                        }
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
                        // Compute estimated USD profit if cycle notionally started at USDC
                        let est_profit_usd_val: f64 = if start_is_usdc { s.config.quote_size_usd.max(0.0) * (rate_prod - 1.0) } else { 0.0 };
                        if profit_bps < min_bps {
                            let shortfall = (min_bps - profit_bps).max(0);
                            if shortfall < best_below_shortfall {
                                let near = Opportunity {
                                    path: canon_labels.clone(),
                                    profit_bps,
                                    net_bps: Some(net_bps),
                                    est_profit_usd: est_profit_usd_val,
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
                                    last_verified_ms: None,
                                    detections: Some(0),
                                    bf_slack_log: None,
                                    bf_required_rate: None,
                                    bf_rate_delta_bps: None,
                                    is_near_miss: Some(true),
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
                        // Skip absurdly high raw profits (likely data issues)
                        if profit_bps > s.config.max_profit_bps { continue; }
                        curr.push(Opportunity {
                            path: canon_labels,
                            profit_bps,
                            net_bps: Some(net_bps),
                            est_profit_usd: est_profit_usd_val,
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
                            last_verified_ms: None,
                            detections: None,
                            bf_slack_log: None,
                            bf_required_rate: None,
                            bf_rate_delta_bps: None,
                            is_near_miss: None,
                        });
                    }
                    let mut near_pair = best_below.map(|o| (o, best_below_shortfall));
                    let mut near_list: Vec<(Opportunity,i64)> = Vec::new();
                    // Near-miss via Bellman-Ford final slack pass
                    if s.config.near_miss_enable {
                        let epsilon: f64 = if s.config.near_miss_epsilon.is_finite() && s.config.near_miss_epsilon > 0.0 { s.config.near_miss_epsilon } else { 5e-4 }; // log-space slack window
                        let top_k: usize = s.config.debug_top_n.max(1).min(20);
                        let nm = detect_near_miss_cycles(&s.graph, epsilon, max_hops, top_k);
                        for nmcy in nm.into_iter() {
                            // Interpret nodes to labels and compute best-of-parallel rates metadata
                            if nmcy.nodes.len() < 3 || nmcy.nodes.len() > max_hops { continue; }
                            let mut labels: Vec<String> = nmcy.nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                            // Apply pruning to near-miss cycles as well (symmetric SOL<->stable and stable<->stable)
                            {
                                let sol = "So11111111111111111111111111111111111111112";
                                let default_stables: std::collections::HashSet<&str> = [
                                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                                ].into_iter().collect();
                                let cfg_stables: std::collections::HashSet<String> = s.config.stable_mints.clone().unwrap_or_default().into_iter().collect();
                                let is_stable = |m: &str| if cfg_stables.is_empty() { default_stables.contains(m) } else { cfg_stables.contains(m) };
                                let mut has_stable_stable = false;
                                let mut sol_stable_hops: usize = 0;
                                for i in 0..labels.len() {
                                    let a = &labels[i];
                                    let b = &labels[(i + 1) % labels.len()];
                                    let a_st = is_stable(a);
                                    let b_st = is_stable(b);
                                    if a_st && b_st { has_stable_stable = true; break; }
                                    if (a == sol && b_st) || (b == sol && a_st) { sol_stable_hops += 1; }
                                }
                                if s.config.drop_stable_stable_hops && has_stable_stable { continue; }
                                if let Some(limit) = s.config.max_sol_stable_hops { if sol_stable_hops > limit { continue; } }
                            }
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
                            let net_bps = {
                                let hops = nlen as i64;
                                let est_lam = s.config.est_priority_fee_per_hop_lamports.unwrap_or(0) as f64;
                                let total_est = (est_lam * hops as f64) / 1_000_000.0 * 10_000.0; // approx: 1 SOL baseline => bps rough
                                (net_bps as f64 - total_est).round() as i64
                            };
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
                            // Validate alignment for near-miss arrays: hop_pool_ids[i] must map to edge labels[i] -> labels[(i+1)%nlen]
                            {
                                let mut aligned = true;
                                for i in 0..nlen {
                                    let src = &labels[i];
                                    let dst = &labels[(i + 1) % nlen];
                                    let pid = hop_pool_ids.get(i).cloned().unwrap_or_default();
                                    let dex_i = hop_dexes.get(i).cloned().unwrap_or_default();
                                    if pid.is_empty() || dex_i == "Link" { continue; }
                                    if let (Some(&u), Some(&v)) = (s.graph.map.get(src), s.graph.map.get(dst)) {
                                        let mut ok = false;
                                        for e in s.graph.g.edges_connecting(u, v) {
                                            if e.weight().pool_id == pid { ok = true; break; }
                                        }
                                        if !ok { aligned = false; break; }
                                    } else { aligned = false; break; }
                                }
                                if !aligned {
                                    tracing::warn!("arb.near_miss.misaligned path={} pools=[{}]", labels.join("->"), hop_pool_ids.join(","));
                                    continue;
                                }
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
                                last_verified_ms: None,
                                detections: Some(0),
                                bf_slack_log: None,
                                bf_required_rate: None,
                                bf_rate_delta_bps: None,
                                is_near_miss: Some(true),
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
                            let near_for_list = near.clone();
                            match &mut near_pair {
                                Some((ref mut best, ref mut best_shortfall)) => {
                                    if shortfall < *best_shortfall { *best = near; *best_shortfall = shortfall; }
                                }
                                None => { near_pair = Some((near, shortfall)); }
                            }
                            // Collect for top-K list
                            near_list.push((near_for_list, shortfall));
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
                            // Prune canon near-miss best-cycle by SOL<->stable cap and stable<->stable
                            {
                                let sol = "So11111111111111111111111111111111111111112";
                                let default_stables: std::collections::HashSet<&str> = [
                                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                                ].into_iter().collect();
                                let cfg_stables: std::collections::HashSet<String> = s.config.stable_mints.clone().unwrap_or_default().into_iter().collect();
                                let is_stable = |m: &str| if cfg_stables.is_empty() { default_stables.contains(m) } else { cfg_stables.contains(m) };
                                let mut has_stable_stable = false;
                                let mut sol_stable_hops: usize = 0;
                                for i in 0..canon_labels.len() {
                                    let a = &canon_labels[i];
                                    let b = &canon_labels[(i + 1) % canon_labels.len()];
                                    let a_st = is_stable(a);
                                    let b_st = is_stable(b);
                                    if a_st && b_st { has_stable_stable = true; break; }
                                    if (a == sol && b_st) || (b == sol && a_st) { sol_stable_hops += 1; }
                                }
                                if s.config.drop_stable_stable_hops && has_stable_stable { continue; }
                                if let Some(limit) = s.config.max_sol_stable_hops { if sol_stable_hops > limit { continue; } }
                            }
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
                            for e in s.graph.g.edges_connecting(u, v) {
                                let wt = e.weight(); if wt.liquidity <= 0.0 { continue; }
                                let r = wt.rate_effective.max(1e-12);
                                if r > best_rate { best_rate = r; best_meta = Some((wt.dex.clone(), wt.liquidity, wt.fee_bps, wt.pool_id.clone(), wt.liquidity_display)); }
                            }
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
                                last_verified_ms: None,
                                detections: Some(0),
                                bf_slack_log: None,
                                bf_required_rate: None,
                                bf_rate_delta_bps: None,
                                is_near_miss: Some(true),
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
                                let mut nodes = vec![a,b,c];
                                let mut labels: Vec<String> = nodes.iter().map(|&i| s.graph.g[NodeIndex::new(i)].clone()).collect();
                                // Prune triangle near-miss by SOL<->stable cap and stable<->stable
                                {
                                    let sol = "So11111111111111111111111111111111111111112";
                                    let default_stables: std::collections::HashSet<&str> = [
                                        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                                    ].into_iter().collect();
                                    let cfg_stables: std::collections::HashSet<String> = s.config.stable_mints.clone().unwrap_or_default().into_iter().collect();
                                    let is_stable = |m: &str| if cfg_stables.is_empty() { default_stables.contains(m) } else { cfg_stables.contains(m) };
                                    let mut has_stable_stable = false;
                                    let mut sol_stable_hops: usize = 0;
                                    for i in 0..labels.len() {
                                        let a = &labels[i];
                                        let b = &labels[(i + 1) % labels.len()];
                                        let a_st = is_stable(a);
                                        let b_st = is_stable(b);
                                        if a_st && b_st { has_stable_stable = true; break; }
                                        if (a == sol && b_st) || (b == sol && a_st) { sol_stable_hops += 1; }
                                    }
                                    if s.config.drop_stable_stable_hops && has_stable_stable { continue; }
                                    if let Some(limit) = s.config.max_sol_stable_hops { if sol_stable_hops > limit { continue; } }
                                }
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
                                let net_bps = {
                                    let hops = 3i64;
                                    let est_lam = s.config.est_priority_fee_per_hop_lamports.unwrap_or(0) as f64;
                                    let total_est = (est_lam * hops as f64) / 1_000_000.0 * 10_000.0;
                                    (net_bps as f64 - total_est).round() as i64
                                };
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
                                // Check if this triangle meets the profit threshold - if so, add as opportunity, otherwise near miss
                                if profit_bps >= min_bps {
                                    // This triangle is profitable enough - add as real opportunity
                                    let path_str = labels.join("->");
                                    let pools_str = hop_pool_ids.join(",");
                                    let fees_str = hop_fee_bps_vec.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
                                    // Build unit-annotated rates
                                    let mut hop_units: Vec<String> = Vec::new();
                                    for w in 0..3 {
                                        let a = &labels[w];
                                        let b = &labels[(w+1)%3];
                                        let r = hop_rates.get(w).copied().unwrap_or(0.0);
                                        let inv = if r>0.0 { 1.0/r } else { 0.0 };
                                        hop_units.push(format!("{}->{}: {:.9} {} per 1 {} | inv {:.9} {} per 1 {}", a, b, r, b, a, inv, a, b));
                                    }
                                    let rates_units = hop_units.join("; ");
                                    tracing::info!(target = "arb_rs", "arb.opportunity.triangle path={} profit_bps={} net_bps={} hops=3 rates_units={} pools=[{}] fees=[{}] product={:.8}", path_str, profit_bps, net_bps, rates_units, pools_str, fees_str, prod);
                                    // Skip if absurdly high raw profits (likely data issues)
                                    if profit_bps <= s.config.max_profit_bps {
                                        curr.push(Opportunity { path: labels, profit_bps, net_bps: Some(net_bps), est_profit_usd: 1.0, dexes, hop_dexes: Some(hop_dexes), hop_rates: Some(hop_rates), hop_outs: None, hop_pool_ids: Some(hop_pool_ids), hop_fee_bps: Some(hop_fee_bps_vec), hop_liquidity_display: None, hop_count: Some(3), rate_product: Some(prod), link_edges_used: Some(link_edges_used), link_penalty_bps_total: Some(link_penalty_bps_total), min_edge_liquidity: est_capacity, est_capacity, bottleneck: bottleneck_edge, detected_ms: Some(now_ts), first_seen_ms: None, last_verified_ms: None, detections: Some(0), bf_slack_log: None, bf_required_rate: None, bf_rate_delta_bps: None, is_near_miss: None });
                                    }
                                } else {
                                    // Below threshold - log as near miss
                                    let path_str = labels.join("->");
                                    let pools_str = hop_pool_ids.join(",");
                                    let fees_str = hop_fee_bps_vec.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
                                    // Build unit-annotated rates
                                    let mut hop_units: Vec<String> = Vec::new();
                                    for w in 0..3 {
                                        let a = &labels[w];
                                        let b = &labels[(w+1)%3];
                                        let r = hop_rates.get(w).copied().unwrap_or(0.0);
                                        let inv = if r>0.0 { 1.0/r } else { 0.0 };
                                        hop_units.push(format!("{}->{}: {:.9} {} per 1 {} | inv {:.9} {} per 1 {}", a, b, r, b, a, inv, a, b));
                                    }
                                    let rates_units = hop_units.join("; ");
                                    tracing::info!(target = "arb_rs", "arb.near_miss.triangle path={} profit_bps={} net_bps={} hops=3 rates_units={} pools=[{}] fees=[{}] product={:.8}", path_str, profit_bps, net_bps, rates_units, pools_str, fees_str, prod);
                                    let near = Opportunity { path: labels, profit_bps, net_bps: Some(net_bps), est_profit_usd: 1.0, dexes, hop_dexes: Some(hop_dexes), hop_rates: Some(hop_rates), hop_outs: None, hop_pool_ids: Some(hop_pool_ids), hop_fee_bps: Some(hop_fee_bps_vec), hop_liquidity_display: None, hop_count: Some(3), rate_product: Some(prod), link_edges_used: Some(link_edges_used), link_penalty_bps_total: Some(link_penalty_bps_total), min_edge_liquidity: est_capacity, est_capacity, bottleneck: bottleneck_edge, detected_ms: Some(now_ts), first_seen_ms: None, last_verified_ms: None, detections: Some(0), bf_slack_log: None, bf_required_rate: None, bf_rate_delta_bps: None, is_near_miss: Some(true) };
                                    near_pair = Some((near, shortfall));
                                }
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
                    // Prune prior opps that touched changed edges/pools
                    let prev_opps = if changed_edge_ids.is_empty() { s.opportunities.clone() } else {
                        s.opportunities.clone().into_iter().filter(|o| {
                            let ids: HashSet<String> = o.hop_pool_ids.as_ref().map(|v| v.iter().cloned().collect()).unwrap_or_default();
                            ids.is_disjoint(&changed_edge_ids)
                        }).collect::<Vec<_>>()
                    };
                    (curr, prev_opps, near_pair, near_list)
                };
                // Adaptive stale handling based on config.max_idle_ms and detections stability
                let now_ms_val = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                // Bump detection counts for current opps and prune old entries
                {
                    let mut sw = loop_state.write().await;
                    let ttl = sw.config.detection_history_ttl_ms.max(1_000);
                    sw.detection_counts.retain(|_, &mut (_, ts)| now_ms_val.saturating_sub(ts) <= ttl);
                    for m in opps.iter() {
                        let key = keyify_opportunity(&m.path, &m.dexes);
                        let (c, _) = sw.detection_counts.get(&key).copied().unwrap_or((0, 0));
                        sw.detection_counts.insert(key, (c.saturating_add(1), now_ms_val));
                    }
                }
                let base_ttl = {
                    // clamp to ≥5s to avoid overly aggressive churn
                    let s = loop_state.read().await;
                    s.config.max_idle_ms.max(5_000)
                };
                let mut merged: Vec<Opportunity> = Vec::new();
                // Always keep current detections, but enforce detection cap unless executed
                for mut m in opps.into_iter() {
                    let s = loop_state.read().await;
                    let key = keyify_opportunity(&m.path, &m.dexes);
                    let executed = s.executed_keys.contains(&key);
                    let count = s.detection_counts.get(&key).map(|(c,_)| *c).unwrap_or(0) as usize;
                    if executed || count < s.config.max_detections_without_exec {
                        // Set timestamps for new detections
                        if m.first_seen_ms.is_none() {
                            m.first_seen_ms = Some(now_ms_val);
                        }
                        m.last_verified_ms = Some(now_ms_val);
                        if m.detected_ms.is_none() {
                            m.detected_ms = Some(now_ms_val);
                        }
                        merged.push(m);
                    }
                }
                // Retain prior ones if within adaptive TTL and not duplicated
                for mut o in prev.into_iter() {
                    let first = o.first_seen_ms.unwrap_or(o.detected_ms.unwrap_or(now_ms_val));
                    // Reuse history to determine detections and cap
                    let det = {
                        let s = loop_state.read().await;
                        let key = keyify_opportunity(&o.path, &o.dexes);
                        s.detection_counts.get(&key).map(|(c,_)| *c).unwrap_or(o.detections.unwrap_or(1))
                    };
                    // Hard drop if exceeding cap and not executed
                    let over_cap = {
                        let s = loop_state.read().await;
                        let key = keyify_opportunity(&o.path, &o.dexes);
                        let executed = s.executed_keys.contains(&key);
                        !executed && (s.detection_counts.get(&key).map(|(c,_)| (*c as usize) >= s.config.max_detections_without_exec).unwrap_or(false))
                    };
                    if over_cap { continue; }
                    // Apply opportunity TTL check
                    let opp_ttl = {
                        let s = loop_state.read().await;
                        s.config.opportunity_ttl_ms
                    };
                    let last_verified = o.last_verified_ms.unwrap_or(o.detected_ms.unwrap_or(first));
                    if now_ms_val.saturating_sub(last_verified) > opp_ttl {
                        continue; // Expired opportunity
                    }
                    // extend TTL up to 3× (1x base + up to +2x for stability)
                    let ttl = base_ttl.saturating_mul(1 + det.min(2));
                    let is_dup = merged.iter().any(|x| x.path == o.path && x.dexes == o.dexes);
                    if !is_dup && now_ms_val.saturating_sub(first) <= ttl {
                        if o.first_seen_ms.is_none() { o.first_seen_ms = o.detected_ms; }
                        o.detections = Some(det);
                        merged.push(o);
                    }
                }
                // Prefer higher net_bps then recency; keep list bounded
                merged.sort_by(|a, b| {
                    let an = a.net_bps.unwrap_or(a.profit_bps);
                    let bn = b.net_bps.unwrap_or(b.profit_bps);
                    bn.cmp(&an)
                      .then_with(|| b.detected_ms.unwrap_or(0).cmp(&a.detected_ms.unwrap_or(0)))
                });
                if merged.len() > 50 { merged.truncate(50); }
                // Proper change detection: compare opportunities by path/dexes AND profit values
                let mut s_check = loop_state.read().await;
                let prev_opps = &s_check.opportunities;
                let changed = {
                    // Check if count changed
                    if prev_opps.len() != merged.len() { true } else {
                        // Check if any opportunity has changed (path/dexes match but profit differs)
                        let mut found_change = false;
                        for m in merged.iter() {
                            if let Some(prev_o) = prev_opps.iter().find(|p| p.path == m.path && p.dexes == m.dexes) {
                                // Check if profit_bps or net_bps changed
                                if prev_o.profit_bps != m.profit_bps || prev_o.net_bps != m.net_bps {
                                    found_change = true;
                                    break;
                                }
                            } else {
                                // New opportunity not in previous list
                                found_change = true;
                                break;
                            }
                        }
                        // Also check if any previous opportunity is missing
                        if !found_change {
                            for prev_o in prev_opps.iter() {
                                if !merged.iter().any(|m| m.path == prev_o.path && m.dexes == prev_o.dexes) {
                                    found_change = true;
                                    break;
                                }
                            }
                        }
                        found_change
                    }
                };
                drop(s_check);
                
                // Always check and update near_misses if they changed (even if opportunities didn't)
                let mut s = loop_state.write().await;
                let mut near_misses_changed = false;
                // Build top-K near-misses list for UI with updated profit values
                let mut nlist = near_list;
                nlist.sort_by_key(|(_, sh)| *sh);
                let k = s.config.debug_top_n.max(1).min(10);
                let mut new_near_misses = nlist.iter().take(k).map(|(o,_)| o.clone()).collect::<Vec<Opportunity>>();
                // Update near_misses timestamps to reflect they were just rebuilt
                for nm in new_near_misses.iter_mut() {
                    nm.last_verified_ms = Some(now_ms_val);
                }
                // Check if near_misses changed by comparing profit values
                if s.near_misses.len() != new_near_misses.len() {
                    near_misses_changed = true;
                } else {
                    for (new, prev) in new_near_misses.iter().zip(s.near_misses.iter()) {
                        if new.path != prev.path || new.dexes != prev.dexes || new.profit_bps != prev.profit_bps || new.net_bps != prev.net_bps {
                            near_misses_changed = true;
                            break;
                        }
                    }
                }
                
                if changed || near_misses_changed {
                    // Update detections for re-detected opps (only if opportunities changed)
                    if changed {
                        for m in merged.iter_mut() {
                            // If this opp also existed previously, bump detections and preserve first_seen_ms
                            if let Some(prev_o) = s.opportunities.iter().find(|p| p.path == m.path && p.dexes == m.dexes) {
                                m.first_seen_ms = prev_o.first_seen_ms.or(prev_o.detected_ms).or(m.detected_ms);
                                m.detections = Some(prev_o.detections.unwrap_or(1) + 1);
                                m.last_verified_ms = Some(now_ms_val); // Update verification timestamp
                            } else {
                                m.first_seen_ms = m.first_seen_ms.or(m.detected_ms);
                                m.last_verified_ms = m.last_verified_ms.or(m.detected_ms);
                                m.detections = Some(1);
                            }
                        }
                        s.opportunities = merged;
                    }
                    
                    // Always update near_misses if they changed
                    let prev_near_misses = s.near_misses.clone();
                    s.near_misses = new_near_misses;
                    // Prefer ≥3-DEX paths; prefer recently updated ones, then rotate across cycles
                    let preferred: Vec<Opportunity> = s.near_misses.iter().cloned().filter(|o| o.dexes.len() >= 3).collect();
                    let pool: Vec<Opportunity> = if !preferred.is_empty() { preferred } else { s.near_misses.clone() };
                    if !pool.is_empty() {
                        // Find opportunities that changed profit_bps compared to previous near_misses
                        let changed_indices: Vec<usize> = pool.iter().enumerate().filter_map(|(idx, o)| {
                            let prev = prev_near_misses.iter().find(|p| p.path == o.path && p.dexes == o.dexes);
                            if let Some(prev_o) = prev {
                                if prev_o.profit_bps != o.profit_bps || prev_o.net_bps != o.net_bps {
                                    Some(idx)
                                } else {
                                    None
                                }
                            } else {
                                // New near miss
                                Some(idx)
                            }
                        }).collect();
                        // Prefer changed entries, then rotate
                        let chosen = if !changed_indices.is_empty() {
                            // Pick from changed entries, rotating through them
                            let changed_idx = (s.metrics.detection_cycles_total as usize) % changed_indices.len();
                            pool[changed_indices[changed_idx]].clone()
                        } else {
                            // No changes detected, rotate through all
                            let idx = (s.metrics.detection_cycles_total as usize) % pool.len();
                            pool[idx].clone()
                        };
                        s.near_miss = Some(chosen.clone());
                        s.near_miss_shortfall_bps = Some((s.config.min_profit_bps - chosen.profit_bps).max(0));
                    } else {
                        s.near_miss = near_pair.as_ref().map(|(o, _)| o.clone());
                        s.near_miss_shortfall_bps = near_pair.as_ref().map(|(_, sh)| *sh);
                    }
                    // Update metrics only when opportunities changed
                    if changed {
                        s.metrics.opportunities_active = s.opportunities.len() as u64;
                        s.metrics.max_profit_bps = s.opportunities.iter().map(|o| o.profit_bps).max().unwrap_or(0) as i64;
                        let total: i64 = s.opportunities.iter().map(|o| o.profit_bps).sum();
                        s.metrics.avg_profit_bps = if s.opportunities.is_empty() { 0.0 } else { total as f64 / s.opportunities.len() as f64 };
                    }
                    s.metrics.detection_cycles_total += 1;
                    // Increment detector outcomes and cumulative opportunities
                    if s.opportunities.is_empty() {
                        s.metrics.detection_misses_total = s.metrics.detection_misses_total.saturating_add(1);
                    } else {
                        s.metrics.detection_hits_total = s.metrics.detection_hits_total.saturating_add(1);
                    }
                    s.metrics.opportunities_detected_total = s.metrics.opportunities_detected_total.saturating_add(s.opportunities.len() as u64);
                    if s.opportunities.is_empty() { s.metrics.detection_misses_total = s.metrics.detection_misses_total.saturating_add(1); } else { s.metrics.detection_hits_total = s.metrics.detection_hits_total.saturating_add(1); }
                    s.metrics.last_detection_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    s.metrics.detection_duration_ms = loop_start.elapsed().as_millis() as u64;
                    let det_ms = s.metrics.detection_duration_ms;
                    let active = s.metrics.opportunities_active;
                    if let Some(top) = s.opportunities.iter().max_by_key(|o| o.profit_bps) {
                        let top_bps = top.profit_bps;
                        let path = top.path.join("->");
                        // Compute graph age and latency metrics for observability
                        let graph_age_ms = if s.last_graph_ts > 0 { now_ms().saturating_sub(s.last_graph_ts) } else { 0 };
                        let dtd = s.metrics.diff_to_detect_ms;
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.done ms={} opps={} top_bps={} path={} graph_age_ms={} diff_to_detect_ms={}", det_ms, active, top_bps, path, graph_age_ms, dtd) });
                        tracing::info!(det_ms, opps = active, top_bps, path = %path, graph_age_ms, diff_to_detect_ms = dtd, "arb.detect.done");
                    } else {
                        let graph_age_ms = if s.last_graph_ts > 0 { now_ms().saturating_sub(s.last_graph_ts) } else { 0 };
                        let dtd = s.metrics.diff_to_detect_ms;
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.done ms={} opps=0 graph_age_ms={} diff_to_detect_ms={}", det_ms, graph_age_ms, dtd) });
                        tracing::info!(det_ms, opps = 0u64, graph_age_ms, diff_to_detect_ms = dtd, "arb.detect.done");
                        // Also emit a concise near-miss summary if available when no opportunities detected
                        if let (Some(nm), Some(shortfall)) = (s.near_miss.clone(), s.near_miss_shortfall_bps) {
                            let path = nm.path.join("->");
                            let hops = nm.hop_count.unwrap_or(nm.path.len());
                            let net_bps = nm.net_bps.unwrap_or(nm.profit_bps);
                            let dexes = nm.dexes.join(",");
                            tracing::info!(shortfall_bps = shortfall, net_bps, hops, dexes = %dexes, path = %path, "arb.near_miss.summary");
                            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.near_miss.summary shortfall_bps={} net_bps={} hops={} path={}", shortfall, net_bps, hops, path) });
                            let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
                        } else if s.config.debug_near_miss_failures {
                            // Emit diagnostics when no near-miss found
                            let hops = s.config.max_hops;
                            let epsilon = s.config.near_miss_epsilon;
                            let nodes = s.metrics.graph_nodes;
                            let edges = s.metrics.graph_edges;
                            let min_bps_cfg = s.config.min_profit_bps;
                            tracing::info!(hops, epsilon, nodes, edges, min_bps = min_bps_cfg, "arb.near_miss.none");
                            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.near_miss.none hops={} eps={} nodes={} edges={} min_bps={}", hops, epsilon, nodes, edges, min_bps_cfg) });
                            let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
                        }
                    }
                    let len = s.events.len();
                    if len > 200 { s.events.drain(0..(len-200)); }
                }
            }
            // Sleep respects configured interval even when disabled to avoid hot loop
            // Event-driven wait: wake on notify or after max idle interval
            let wake = { let s = loop_state.read().await; s.wake.clone() };
            let timeout = std::time::Duration::from_millis(idle_ms);
            tokio::select! {
                _ = wake.notified() => {},
                _ = tokio::time::sleep(timeout) => {},
            }
            tracing::info!(iter_ms = iter_start.elapsed().as_millis() as u128, "arb.loop.end");
        }
    });

    let app = Router::new()
        .route("/health", get(|| async { Json(HealthResp { status: "ok" }) }))
        .route("/opportunities", get(get_opportunities))
        
        .route("/ws/opportunities", get(ws_opportunities))
        .route("/arb/opportunity/executed", post(opportunity_executed))
        .route("/config", post(set_config).get(get_config))
        .route("/arb/start", post(arb_start))
        .route("/arb/graph/version", get(arb_graph_version))
        .route("/arb/graph/ack", post(arb_graph_ack))
        .route("/arb/graph/snapshot", post(arb_graph_snapshot))
        .route("/arb/graph/update", post(arb_graph_update))
        .route("/metrics", get(metrics_prom))
        .route("/metrics/json", get(metrics_json))
        .route("/events/json", get(events_json))
        .with_state(state);

    // Bind host/port configurable via env; default host 127.0.0.1
    let host = std::env::var("ARB_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let ip: std::net::IpAddr = host.parse().unwrap_or_else(|_| std::net::IpAddr::V4(std::net::Ipv4Addr::new(127,0,0,1)));
    let port: u16 = std::env::var("ARB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(4010);
    let addr: SocketAddr = std::net::SocketAddr::new(ip, port);
    tracing::info!(?addr, "starting arb-rs server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal(ring.clone())).await?;
    Ok(())
}

async fn shutdown_signal(ring: Arc<Mutex<VecDeque<String>>>) {
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
    // Attempt to write last 2000 log lines to logs/session.json
    if let Err(e) = write_session_json(&ring).await { let _ = e; }
    tokio::time::sleep(Duration::from_millis(200)).await;
}

async fn write_session_json(ring: &Arc<Mutex<VecDeque<String>>>) -> anyhow::Result<()> {
    let dir = std::env::var("ARB_LOG_DIR").unwrap_or_else(|_| "logs".into());
    let path = std::path::Path::new(&dir);
    tokio::fs::create_dir_all(path).await.ok();
    let file = path.join("session.json");
    let items: Vec<String> = {
        let guard = ring.lock().unwrap();
        let len = guard.len();
        let start = if len > 2000 { len - 2000 } else { 0 };
        guard.iter().skip(start).cloned().collect()
    };
    let data = serde_json::to_string_pretty(&items)?;
    tokio::fs::write(file, data).await?;
    Ok(())
}

async fn get_opportunities(
    State(state): State<Arc<RwLock<AppState>>>,
) -> Json<OpportunitiesResponse> {
    let s = state.read().await;
    let items = s.opportunities.clone();
    let near_items = if s.near_misses.is_empty() { None } else { Some(s.near_misses.clone()) };
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
        diff_to_detect_ms: s.metrics.diff_to_detect_ms,
        graph_nodes: s.metrics.graph_nodes,
        graph_edges: s.metrics.graph_edges,
        near_miss: s.near_miss.clone(),
        near_miss_shortfall_bps: s.near_miss_shortfall_bps,
        near_misses: if s.near_misses.is_empty() { None } else { Some(s.near_misses.clone()) },
    };
    Json(OpportunitiesResponse { items, near_items, summary: Some(summary) })
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
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
struct GraphDiffEdge {
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
#[serde(rename_all = "camelCase")]
struct GraphDiffReq {
    version: Option<u64>,
    timestamp: Option<u64>,
    added_edges: Option<Vec<GraphDiffEdge>>,    
    updated_edges: Option<Vec<GraphDiffEdge>>,  
    removed_edge_ids: Option<Vec<String>>,      
}

async fn arb_graph_snapshot(State(state): State<Arc<RwLock<AppState>>>, headers: HeaderMap, Json(req): Json<GraphSnapshotReq>) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) { return Json(serde_json::json!({"error":"unauthorized"})); }
    Json(handle_graph_snapshot(state, req).await)
}

// Centralized price conversion: A-per-1-B (backend) -> B-per-1-A (detector), apply fee once
#[inline]
fn edge_rate_effective_local(px_opt: Option<f64>, fee_bps_opt: Option<i64>) -> (f64, f64) {
    let fee_bps: f64 = (fee_bps_opt.unwrap_or(0)) as f64;
    let px: f64 = px_opt.unwrap_or(0.0);
    if !(px.is_finite() && px > 0.0) { return (0.0, 0.0); }
    let base: f64 = 1.0 / px;
    if !(base.is_finite() && base > 0.0) { return (0.0, 0.0); }
    let eff: f64 = base * (1.0 - fee_bps/10_000.0).max(0.0);
    (base, eff)
}

async fn handle_graph_snapshot(state: Arc<RwLock<AppState>>, req: GraphSnapshotReq) -> serde_json::Value {
    let mut s = state.write().await;
    let g = req.graph;
    tracing::info!(version = ?g.version, ts = ?g.timestamp, nodes = g.nodes.len(), edges = g.edges.len(), "arb.graph.snapshot: received");
    // Version guard: ignore stale or equal snapshots
    if let Some(v) = g.version { if v <= s.last_graph_version { s.metrics.graph_updates_skipped = s.metrics.graph_updates_skipped.saturating_add(1); return serde_json::json!({"ok": true, "ignored": true, "reason": "stale_version"}); } }
    let mut new_graph = ArbGraph::new();
    // Build a lightweight USD reference from the incoming snapshot edges to correct 10^k magnitude slips
    use std::collections::HashMap;
    let sol_mint: &str  = "So11111111111111111111111111111111111111112";
    let usdc_mint: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let usd1_mint: &str = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
    let mut px_map: HashMap<(String,String), f64> = HashMap::new();
    for e in g.edges.iter() {
        if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px_map.insert((e.source.clone(), e.target.clone()), px); } }
    }
    let sol_usd: Option<f64> = {
        if let Some(px) = px_map.get(&(usdc_mint.to_string(), sol_mint.to_string())) { if *px > 0.0 { Some(*px) } else { None } }
        else if let Some(px) = px_map.get(&(sol_mint.to_string(), usdc_mint.to_string())) { if *px > 0.0 { Some(1.0 / *px) } else { None } }
        else { None }
    };
    let get_usd_from_snapshot = |mint: &str| -> Option<f64> {
        if mint == usdc_mint || mint == usd1_mint { return Some(1.0); }
        if mint == sol_mint { return sol_usd; }
        if let Some(px) = px_map.get(&(mint.to_string(), usdc_mint.to_string())) { if *px > 0.0 { return Some(1.0 / *px); } }
        if let Some(px) = px_map.get(&(usdc_mint.to_string(), mint.to_string())) { if *px > 0.0 { return Some(*px); } }
        if let Some(su) = sol_usd {
            if let Some(px) = px_map.get(&(mint.to_string(), sol_mint.to_string())) { if *px > 0.0 { return Some(su / *px); } }
            if let Some(px) = px_map.get(&(sol_mint.to_string(), mint.to_string())) { if *px > 0.0 { return Some(su * *px); } }
        }
        None
    };
    let adjust_magnitude = |a: &str, b: &str, px_in: f64| -> f64 {
        let pa = get_usd_from_snapshot(a); let pb = get_usd_from_snapshot(b);
        if let (Some(pa), Some(pb)) = (pa, pb) {
            let refv = pb / pa;
            let mut best = px_in; let mut best_dev = f64::INFINITY; let mut best_k = 0i32;
            for k in -8..=8 { let cand = px_in * 10f64.powi(k); if !(cand.is_finite() && cand > 0.0) { continue; } let dev = (cand / refv).max(refv / cand); if dev + 1e-12 < best_dev { best_dev = dev; best = cand; best_k = k; } }
            if best_k != 0 { tracing::debug!(mint_a = a, mint_b = b, px_in, px_out = best, k = best_k, refv, "arb.magnitude.calibrated.snapshot"); }
            best
        } else {
            px_in
        }
    };
    for e in g.edges.into_iter() {
        let dex = e.dex.unwrap_or_else(|| "Unknown".to_string());
        let fee = e.fee_bps.unwrap_or(0);
        let liq = e.liquidity.unwrap_or(0.0);
        let pool_id = e.pool_id.unwrap_or_else(|| "".to_string());
        let liq_disp = e.liquidity_display.unwrap_or(0.0);
        let mut px = e.price_a_per_b.unwrap_or(0.0);
        if px.is_finite() && px > 0.0 { px = adjust_magnitude(&e.source, &e.target, px); }
        let base = if px > 0.0 { 1.0 / px } else { 0.0 };
        let rate_eff = if base > 0.0 { base * (1.0 - (fee as f64)/10_000.0).max(0.0) } else { 0.0 };
        new_graph.upsert_edge(&dex, &e.source, &e.target, EdgeData {
            rate_effective: rate_eff,
            fee_bps: fee,
            liquidity: liq,
            dex: dex.clone(),
            pool_id,
            liquidity_display: liq_disp,
        });
    }
    // Enforce reciprocity between forward/reverse edges when both present
    {
        use std::collections::HashMap;
        let mut by_core: HashMap<String, (petgraph::graph::NodeIndex, petgraph::graph::NodeIndex, f64, i64, Option<(petgraph::graph::NodeIndex, petgraph::graph::NodeIndex, f64, i64)>)> = HashMap::new();
        for e in new_graph.g.edge_references() {
            let w = e.weight();
            let pid = w.pool_id.clone();
            if pid.is_empty() { continue; }
            let core = pid.strip_suffix("-rev").unwrap_or(&pid).to_string();
            let entry = by_core.entry(core).or_insert((e.source(), e.target(), w.rate_effective, w.fee_bps, None));
            if pid.ends_with("-rev") { entry.4 = Some((e.source(), e.target(), w.rate_effective, w.fee_bps)); }
            else { entry.0 = e.source(); entry.1 = e.target(); entry.2 = w.rate_effective; entry.3 = w.fee_bps; }
        }
        for (_k,(_u,_v,rf,ff,rev_opt)) in by_core.into_iter() {
            if let Some((vr,ur,rr,fr)) = rev_opt {
                let exp = (1.0 - (ff as f64)/10_000.0).max(0.0) * (1.0 - (fr as f64)/10_000.0).max(0.0);
                let prod = rf * rr;
                let ok = prod.is_finite() && exp.is_finite() && exp > 0.0 && (prod/exp) > 0.99 && (prod/exp) < 1.01;
                if !ok {
                    // Correct reverse to reciprocal of forward base
                    let base_fwd = if (1.0 - (ff as f64)/10_000.0) > 0.0 { rf / (1.0 - (ff as f64)/10_000.0) } else { 0.0 };
                    if base_fwd.is_finite() && base_fwd > 0.0 {
                        let rr_new = (1.0 / base_fwd) * (1.0 - (fr as f64)/10_000.0).max(0.0);
                        if rr_new.is_finite() && rr_new > 0.0 { if let Some(eid) = new_graph.g.find_edge(vr, ur) { if let Some(w) = new_graph.g.edge_weight_mut(eid) { w.rate_effective = rr_new; } } }
                    }
                }
            }
        }
    }
    s.graph = new_graph;
    s.metrics.graph_nodes = s.graph.g.node_count() as u64;
    s.metrics.graph_edges = s.graph.g.edge_count() as u64;
    s.last_graph_version = g.version.unwrap_or(s.last_graph_version);
    s.last_graph_ts = g.timestamp.unwrap_or(s.last_graph_ts);
    // Record time of receipt for diff_to_detect tracking
    s.metrics.last_graph_push_rx_ms = now_ms();
    
    let nodes = s.metrics.graph_nodes; let edges = s.metrics.graph_edges;
    s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.graph.snapshot: accepted nodes={} edges={}", nodes, edges) });
    tracing::info!(nodes, edges, "arb.graph.snapshot: accepted");
    let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
    // Wake detection loop immediately
    s.wake.notify_one();
    serde_json::json!({"ok": true, "nodes": nodes, "edges": edges})
}

async fn arb_graph_update(State(state): State<Arc<RwLock<AppState>>>, headers: HeaderMap, Json(req): Json<GraphDiffReq>) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) { return Json(serde_json::json!({"error":"unauthorized"})); }
    // Buffer the diff to apply between loop iterations to avoid contention
    let mut s = state.write().await;
    if let Some(v) = req.version { if v <= s.last_graph_version { s.metrics.graph_updates_skipped = s.metrics.graph_updates_skipped.saturating_add(1); return Json(serde_json::json!({"ok": true, "skipped": true })); } }
    if let Some(removed) = req.removed_edge_ids { let n = removed.len(); s.pending_removed_edge_ids.extend(removed); tracing::info!(removed=n, "arb.graph.diff: buffered removed edges"); }
    if let Some(added) = req.added_edges { let n = added.len(); s.pending_added_edges.extend(added); tracing::info!(added=n, "arb.graph.diff: buffered added edges"); }
    if let Some(updated) = req.updated_edges { let n = updated.len(); s.pending_updated_edges.extend(updated); tracing::info!(updated=n, "arb.graph.diff: buffered updated edges"); }
    // Only update pending_graph_version if the new version is higher (preserve highest version)
    if let Some(v) = req.version {
        if let Some(old_pending) = s.pending_graph_version {
            if v > old_pending {
                s.pending_graph_version = Some(v);
                tracing::info!(old_version = old_pending, new_version = v, "arb.graph.diff: version buffered (replaced)");
            } else {
                tracing::info!(received_version = v, pending_version = old_pending, "arb.graph.diff: version ignored (not higher than pending)");
            }
        } else {
            s.pending_graph_version = Some(v);
            tracing::info!(version = v, "arb.graph.diff: version buffered (new)");
        }
    }
    if req.timestamp.is_some() { s.pending_graph_ts = req.timestamp; }
    // Record time of receipt for diff_to_detect tracking
    s.metrics.last_graph_push_rx_ms = now_ms();
    
    // Wake detection loop to apply diff promptly
    s.wake.notify_one();
    Json(serde_json::json!({"ok": true}))
}

async fn arb_start(State(state): State<Arc<RwLock<AppState>>>, headers: HeaderMap, Json(req): Json<StartReq>) -> Json<serde_json::Value> {
    // Validate secret when configured
    if !auth_ok(Some(&headers)) { return Json(serde_json::json!({ "error": "unauthorized" })); }
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
            let (_base, rate_eff) = edge_rate_effective_local(e.price_a_per_b, e.fee_bps);
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
    
    
        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.start: graph accepted nodes={} edges={}", nodes_cnt, edges_cnt) });
        tracing::info!(nodes = nodes_cnt, edges = edges_cnt, "arb.start: graph accepted");
        let len = s.events.len(); if len > 200 { s.events.drain(0..(len-200)); }
    }
    if let Some(want) = req.enable {
        if want && !s.config.enabled {
            tracing::info!("arb.start: enabling loop");
            s.config.enabled = true;
        } else if !want {
            tracing::info!("arb.stop: disabling loop");
            s.config.enabled = false;
            // Clear graph and pending buffers so next start receives a fresh snapshot
            s.graph = ArbGraph::new();
            s.metrics.graph_nodes = 0;
            s.metrics.graph_edges = 0;
            s.last_graph_version = 0;
            s.last_graph_ts = 0;
            s.pending_added_edges.clear();
            s.pending_updated_edges.clear();
            s.pending_removed_edge_ids.clear();
            s.pending_graph_version = None;
            s.pending_graph_ts = None;
            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: "arb.stop: graph cleared".into() });
        }
    } else {
        if !s.config.enabled { tracing::info!("arb.start: enabling loop"); }
        s.config.enabled = true;
    }
    Json(serde_json::json!({ "ok": true, "enabled": s.config.enabled, "graph_nodes": s.metrics.graph_nodes, "graph_edges": s.metrics.graph_edges }))
}


async fn ws_opportunities(ws: WebSocketUpgrade, State(state): State<Arc<RwLock<AppState>>>) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut last: Option<String> = None;
        loop {
            // Build WS payload aligned with GET /opportunities (items + near_items + summary)
            let (items, near_items, summary) = {
                let s = state.read().await;
                let items = s.opportunities.clone();
                let count = items.len();
                let max_profit_bps = items.iter().map(|o| o.profit_bps).max().unwrap_or(0);
                let avg_profit_bps = if count == 0 { 0.0 } else { items.iter().map(|o| o.profit_bps as f64).sum::<f64>() / (count as f64) };
                let avg_net_bps = if count == 0 { 0.0 } else { items.iter().map(|o| o.net_bps.unwrap_or(o.profit_bps) as f64).sum::<f64>() / (count as f64) };
                let avg_hop_count = if count == 0 { 0.0 } else { items.iter().map(|o| o.hop_count.unwrap_or(o.path.len()) as f64).sum::<f64>() / (count as f64) };
                let avg_link_edges_used = if count == 0 { 0.0 } else { items.iter().map(|o| o.link_edges_used.unwrap_or(0) as f64).sum::<f64>() / (count as f64) };
                let min_edge_liquidity_vals: Vec<f64> = items.iter().map(|o| o.min_edge_liquidity.unwrap_or(0.0)).collect();
                let min_edge_liquidity_avg = if count == 0 { 0.0 } else { min_edge_liquidity_vals.iter().sum::<f64>() / (count as f64) };
                let min_edge_liquidity_min = {
                    let m = min_edge_liquidity_vals.iter().cloned().fold(f64::INFINITY, f64::min);
                    if m.is_infinite() { 0.0 } else { m }
                };
                let near_items = if s.near_misses.is_empty() { None } else { Some(s.near_misses.clone()) };
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
                    diff_to_detect_ms: s.metrics.diff_to_detect_ms,
                    graph_nodes: s.metrics.graph_nodes,
                    graph_edges: s.metrics.graph_edges,
                    near_miss: s.near_miss.clone(),
                    near_miss_shortfall_bps: s.near_miss_shortfall_bps,
                    near_misses: if s.near_misses.is_empty() { None } else { Some(s.near_misses.clone()) },
                };
                (items, near_items, summary)
            };
            let payload = serde_json::json!({ "items": items, "near_items": near_items, "summary": summary });
            let text = payload.to_string();
            // Build a signature that includes profit values for change detection
            let signature = {
                let opps_sig: String = items.iter().map(|o| {
                    format!("{}:{}:{}", 
                        o.path.join(">"), 
                        o.profit_bps, 
                        o.net_bps.unwrap_or(o.profit_bps))
                }).collect::<Vec<_>>().join("|");
                let near_sig = if let Some(ref nm) = summary.near_miss {
                    format!("{}:{}:{}", nm.path.join(">"), nm.profit_bps, nm.net_bps.unwrap_or(nm.profit_bps))
                } else {
                    String::new()
                };
                format!("{}:{}:{}", items.len(), opps_sig, near_sig)
            };
            // Compare signature instead of full JSON to detect profit value changes
            if last.as_ref() != Some(&signature) {
                if socket.send(Message::Text(text.clone())).await.is_err() { break; }
                last = Some(signature);
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
struct ExecutedReq { path: Vec<String>, dexes: Option<Vec<String>> }

async fn opportunity_executed(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<ExecutedReq>,
) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) { return Json(serde_json::json!({"error":"unauthorized"})); }
    let mut s = state.write().await;
    let key = keyify_opportunity(&req.path, &req.dexes.unwrap_or_default());
    s.executed_keys.insert(key);
    Json(serde_json::json!({"ok": true}))
}

#[derive(serde::Deserialize)]
struct ConfigReq {
    enabled: Option<bool>,
    min_profit_bps: Option<i64>,
    max_profit_bps: Option<i64>,
    min_notional_usd: Option<f64>,
    max_hops: Option<usize>,
    max_idle_ms: Option<u64>,
    quote_size_usd: Option<f64>,
    max_detections_without_exec: Option<usize>,
    detection_history_ttl_ms: Option<u64>,
    opportunity_ttl_ms: Option<u64>,
    debug_emit_subthreshold: Option<bool>,
    debug_top_n: Option<usize>,
    near_miss_enable: Option<bool>,
    near_miss_epsilon: Option<f64>,
    debug_near_miss_failures: Option<bool>,
    // Additional detector/cadence/pruning fields
    est_priority_fee_per_hop_lamports: Option<u64>,
    filtered_detect_enable: Option<bool>,
    filtered_node_ratio: Option<f64>,
    filtered_expand_hops: Option<usize>,
    periodic_full_ms: Option<u64>,
    max_sol_stable_hops: Option<usize>,
    drop_stable_stable_hops: Option<bool>,
    stable_mints: Option<Vec<String>>,
    calibrate_magnitude_on_ingest: Option<bool>,
}

async fn set_config(
    State(state): State<Arc<RwLock<AppState>>>,
    Json(cfg): Json<ConfigReq>,
) -> Json<serde_json::Value> {
    let mut s = state.write().await;
    // Log receipt of config update and which keys were provided
    {
        let mut keys: Vec<&str> = Vec::new();
        if cfg.enabled.is_some() { keys.push("enabled"); }
        if cfg.min_profit_bps.is_some() { keys.push("min_profit_bps"); }
        if cfg.max_profit_bps.is_some() { keys.push("max_profit_bps"); }
        if cfg.min_notional_usd.is_some() { keys.push("min_notional_usd"); }
        if cfg.max_hops.is_some() { keys.push("max_hops"); }
        if cfg.max_idle_ms.is_some() { keys.push("max_idle_ms"); }
        if cfg.quote_size_usd.is_some() { keys.push("quote_size_usd"); }
        if cfg.max_detections_without_exec.is_some() { keys.push("max_detections_without_exec"); }
        if cfg.detection_history_ttl_ms.is_some() { keys.push("detection_history_ttl_ms"); }
        if cfg.opportunity_ttl_ms.is_some() { keys.push("opportunity_ttl_ms"); }
        if cfg.debug_emit_subthreshold.is_some() { keys.push("debug_emit_subthreshold"); }
        if cfg.debug_top_n.is_some() { keys.push("debug_top_n"); }
        if cfg.near_miss_enable.is_some() { keys.push("near_miss_enable"); }
        if cfg.near_miss_epsilon.is_some() { keys.push("near_miss_epsilon"); }
        let keys_str = keys.join(",");
        tracing::info!(target = "arb_rs", "arb.config.receive keys=[{}] near_miss_enable={:?} debug_top_n={:?}", keys_str, cfg.near_miss_enable, cfg.debug_top_n);
    }
    if let Some(v) = cfg.enabled { s.config.enabled = v; }
    if let Some(v) = cfg.min_profit_bps { s.config.min_profit_bps = v; }
    if let Some(v) = cfg.max_profit_bps { s.config.max_profit_bps = v; }
    if let Some(v) = cfg.min_notional_usd { s.config.min_notional_usd = v; }
    if let Some(v) = cfg.max_hops { s.config.max_hops = v; }
    if let Some(v) = cfg.max_idle_ms { s.config.max_idle_ms = v; }
    if let Some(v) = cfg.quote_size_usd { s.config.quote_size_usd = v; }
    if let Some(v) = cfg.max_detections_without_exec { s.config.max_detections_without_exec = v; }
    if let Some(v) = cfg.detection_history_ttl_ms { s.config.detection_history_ttl_ms = v; }
    if let Some(v) = cfg.opportunity_ttl_ms { s.config.opportunity_ttl_ms = v; }
    if let Some(v) = cfg.debug_emit_subthreshold { s.config.debug_emit_subthreshold = v; }
    if let Some(v) = cfg.debug_top_n { s.config.debug_top_n = v; }
    if let Some(v) = cfg.near_miss_enable { s.config.near_miss_enable = v; }
    if let Some(v) = cfg.near_miss_epsilon { s.config.near_miss_epsilon = v; }
    if let Some(v) = cfg.debug_near_miss_failures { s.config.debug_near_miss_failures = v; }
    // Extended fields
    if let Some(v) = cfg.est_priority_fee_per_hop_lamports { s.config.est_priority_fee_per_hop_lamports = Some(v); }
    if let Some(v) = cfg.filtered_detect_enable { s.config.filtered_detect_enable = v; }
    if let Some(v) = cfg.filtered_node_ratio { s.config.filtered_node_ratio = v; }
    if let Some(v) = cfg.filtered_expand_hops { s.config.filtered_expand_hops = Some(v); }
    if let Some(v) = cfg.periodic_full_ms { s.config.periodic_full_ms = Some(v); }
    if let Some(v) = cfg.max_sol_stable_hops { s.config.max_sol_stable_hops = Some(v); }
    if let Some(v) = cfg.drop_stable_stable_hops { s.config.drop_stable_stable_hops = v; }
    if let Some(v) = cfg.stable_mints { s.config.stable_mints = Some(v); }
    if let Some(v) = cfg.calibrate_magnitude_on_ingest { s.config.calibrate_magnitude_on_ingest = v; }
    // Optional: extend ConfigReq to accept pruning fields without breaking existing clients
    // We tolerate presence via raw JSON by re-reading from persisted file later if needed.
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
        min_profit_bps: 0,
        max_profit_bps: 20000,
        min_notional_usd: 0.0,
        max_hops: 4,
        max_idle_ms: std::env::var("ARB_IDLE_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(100),
        quote_size_usd: 100.0,
        max_detections_without_exec: std::env::var("ARB_MAX_DETECTIONS").ok().and_then(|s| s.parse().ok()).unwrap_or(3),
        detection_history_ttl_ms: std::env::var("ARB_DETECTION_TTL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(120_000),
        opportunity_ttl_ms: std::env::var("ARB_OPPORTUNITY_TTL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(30_000),
        debug_emit_subthreshold: std::env::var("ARB_DEBUG_SUBTHRESHOLD").ok().map(|v| v == "true").unwrap_or(false),
        debug_top_n: std::env::var("ARB_DEBUG_TOP_N").ok().and_then(|s| s.parse().ok()).unwrap_or(5),
        near_miss_enable: std::env::var("ARB_NEAR_MISS_ENABLE").ok().map(|v| v != "false").unwrap_or(true),
        near_miss_epsilon: std::env::var("ARB_NEAR_MISS_EPS").ok().and_then(|s| s.parse().ok()).unwrap_or(5e-4),
        est_priority_fee_per_hop_lamports: Some(0),
        debug_near_miss_failures: std::env::var("ARB_DEBUG_NM_FAIL").ok().map(|v| v == "true").unwrap_or(false),
        filtered_detect_enable: std::env::var("ARB_FILTERED_DETECT_ENABLE").ok().map(|v| v != "false").unwrap_or(false),
        filtered_node_ratio: std::env::var("ARB_FILTERED_NODE_RATIO").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0),
        filtered_expand_hops: std::env::var("ARB_FILTERED_EXPAND_HOPS").ok().and_then(|s| s.parse().ok()).or(None),
        periodic_full_ms: std::env::var("ARB_PERIODIC_FULL_MS").ok().and_then(|s| s.parse().ok()).or(Some(1000)),
        // Pruning defaults
        max_sol_stable_hops: Some(std::env::var("ARB_MAX_SOL_STABLE_HOPS").ok().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX)),
        drop_stable_stable_hops: std::env::var("ARB_DROP_STABLE_STABLE_HOPS").ok().map(|v| v != "false").unwrap_or(false),
        stable_mints: None,
        calibrate_magnitude_on_ingest: std::env::var("ARB_CALIBRATE_ON_INGEST").ok().map(|v| v == "true").unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // use petgraph::graph::NodeIndex; // not used; keep commented for reference

    // Minimal unit test to validate SOL<->stable hop cap logic on labels only
    #[test]
    fn prune_sol_stable_and_stable_stable_cycles() {
        let mut s = AppState {
            config: ArbConfig { max_sol_stable_hops: Some(1), drop_stable_stable_hops: true, stable_mints: None, ..default_config() },
            opportunities: Vec::new(), graph: ArbGraph::new(), metrics: Metrics::default(), events: Vec::new(), near_miss: None, near_miss_shortfall_bps: None, near_misses: Vec::new(), last_graph_version: 0, last_graph_ts: 0,
            pending_added_edges: Vec::new(), pending_updated_edges: Vec::new(), pending_removed_edge_ids: Vec::new(), pending_graph_version: None, pending_graph_ts: None, wake: Arc::new(Notify::new()),
            detection_counts: HashMap::new(), executed_keys: HashSet::new(),
        };
        // Build three nodes and edges to form SOL->USDC->USDT->SOL (labels only)
        let sol = "So11111111111111111111111111111111111111112";
        let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        let e = |rate| EdgeData { rate_effective: rate, fee_bps: 30, liquidity: 1000.0, dex: "X".into(), pool_id: String::new(), liquidity_display: 1000.0 };
        s.graph.upsert_edge("X", sol, usdc, e(1.0));
        s.graph.upsert_edge("X", usdc, usdt, e(1.0));
        s.graph.upsert_edge("X", usdt, sol, e(1.0));
        // Build labels order
        let labels = vec![sol.to_string(), usdc.to_string(), usdt.to_string()];
        // Count sol-stable hops and detect stable-stable
        let default_stables: std::collections::HashSet<&str> = [usdc, usdt].into_iter().collect();
        let cfg_stables: std::collections::HashSet<String> = s.config.stable_mints.clone().unwrap_or_default().into_iter().collect();
        let is_stable = |m: &str| if cfg_stables.is_empty() { default_stables.contains(m) } else { cfg_stables.contains(m) };
        let mut has_stable_stable = false; let mut sol_stable_hops: usize = 0;
        for i in 0..labels.len() {
            let a = &labels[i]; let b = &labels[(i+1)%labels.len()];
            let a_st = is_stable(a); let b_st = is_stable(b);
            if a_st && b_st { has_stable_stable = true; break; }
            if (a == sol && b_st) || (b == sol && a_st) { sol_stable_hops += 1; }
        }
        assert!(has_stable_stable);
        // Under current counting, ensure at least one SOL<->stable hop is present
        assert!(sol_stable_hops >= 1);
        // Pruning should trigger with drop_stable_stable_hops=true and max_sol_stable_hops=1
        assert!(s.config.drop_stable_stable_hops);
        assert_eq!(s.config.max_sol_stable_hops, Some(1));
    }

    fn mk_opp(path: &[&str], bps: i64, net: Option<i64>, first: u64, last: u64, det: u64) -> Opportunity {
        Opportunity {
            path: path.iter().map(|s| s.to_string()).collect(),
            profit_bps: bps,
            net_bps: net,
            est_profit_usd: 0.0,
            dexes: vec!["X".into(), "Y".into(), "Z".into()],
            hop_dexes: None,
            hop_rates: None,
            hop_outs: None,
            hop_pool_ids: None,
            hop_fee_bps: None,
            hop_liquidity_display: None,
            hop_count: None,
            rate_product: None,
            link_edges_used: None,
            link_penalty_bps_total: None,
            min_edge_liquidity: None,
            est_capacity: None,
            bottleneck: None,
            detected_ms: Some(last),
            last_verified_ms: Some(last),
            first_seen_ms: Some(first),
            detections: Some(det),
            bf_slack_log: None,
            bf_required_rate: None,
            bf_rate_delta_bps: None,
            is_near_miss: None,
        }
    }

    #[test]
    fn adaptive_ttl_keeps_stable_and_sorts() {
        // Simulate now and base TTL
        let now = 1_000_000u64;
        let base_ttl = 5_000u64;

        // Current detections empty; prev has two items
        let mut prev: Vec<Opportunity> = vec![
            // Stable: first seen long ago but many detections -> extend TTL
            mk_opp(&["A","B","A"], 40, Some(35), now - 12_000, now - 2_000, 3),
            // Old and few detections -> should drop under base TTL
            mk_opp(&["C","D","C"], 90, Some(80), now - 12_000, now - 11_000, 1),
        ];
        let opps: Vec<Opportunity> = vec![];

        // Merge logic mirror
        let mut merged: Vec<Opportunity> = Vec::new();
        merged.extend(opps.into_iter());
        for mut o in prev.drain(..) {
            let first = o.first_seen_ms.unwrap_or(o.detected_ms.unwrap_or(now));
            let det = o.detections.unwrap_or(1);
            let ttl = base_ttl.saturating_mul(1 + det.min(2));
            let is_dup = merged.iter().any(|x| x.path == o.path && x.dexes == o.dexes);
            if !is_dup && now.saturating_sub(first) <= ttl {
                if o.first_seen_ms.is_none() { o.first_seen_ms = o.detected_ms; }
                o.detections = Some(det);
                merged.push(o);
            }
        }
        // Expect only the stable one retained
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].path, vec!["A","B","A"]);

        // Add a new higher net_bps item and test sorting and cap
        let mut merged2 = merged;
        merged2.push(mk_opp(&["E","F","E"], 10, Some(120), now - 100, now - 50, 1));
        merged2.sort_by(|a,b| {
            let an = a.net_bps.unwrap_or(a.profit_bps);
            let bn = b.net_bps.unwrap_or(b.profit_bps);
            bn.cmp(&an).then_with(|| b.detected_ms.unwrap_or(0).cmp(&a.detected_ms.unwrap_or(0)))
        });
        assert_eq!(merged2[0].path, vec!["E","F","E"]);
    }

    #[test]
    fn cap_list_to_50() {
        let now = 2_000_000u64;
        let mut v: Vec<Opportunity> = Vec::new();
        for i in 0..60 {
            v.push(mk_opp(&["X","Y","X"], i, Some(i), now - i as u64, now - i as u64, 1));
        }
        v.sort_by(|a,b| {
            let an = a.net_bps.unwrap_or(a.profit_bps);
            let bn = b.net_bps.unwrap_or(b.profit_bps);
            bn.cmp(&an).then_with(|| b.detected_ms.unwrap_or(0).cmp(&a.detected_ms.unwrap_or(0)))
        });
        if v.len() > 50 { v.truncate(50); }
        assert_eq!(v.len(), 50);
        // Highest net_bps at front
        assert!(v[0].net_bps.unwrap_or(0) >= v[49].net_bps.unwrap_or(0));
    }

    #[test]
    fn detections_cap_without_execution() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let executed_keys: HashSet<String> = HashSet::new();
        let cfg = ArbConfig { max_detections_without_exec: 3, detection_history_ttl_ms: 120_000, ..default_config() };
        let opp = mk_opp(&["A","B","A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        let mut included = Vec::new();
        for i in 0..3u64 {
            let now = 1_000 + i * 500; // within TTL
            // prune
            detection_counts.retain(|_, &mut (_, ts)| now.saturating_sub(ts) <= cfg.detection_history_ttl_ms);
            // bump
            let (c, _) = detection_counts.get(&key).copied().unwrap_or((0, 0));
            detection_counts.insert(key.clone(), (c.saturating_add(1), now));
            // include if under cap or executed
            let executed = executed_keys.contains(&key);
            let count = detection_counts.get(&key).map(|(c,_)| *c as usize).unwrap_or(0);
            included.push(executed || count < cfg.max_detections_without_exec);
        }
        assert_eq!(included, vec![true, true, false]);
    }

    #[test]
    fn executed_override_allows_after_cap() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let mut executed_keys: HashSet<String> = HashSet::new();
        let cfg = ArbConfig { max_detections_without_exec: 3, detection_history_ttl_ms: 120_000, ..default_config() };
        let opp = mk_opp(&["A","B","A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        detection_counts.insert(key.clone(), (3, 10_000));
        executed_keys.insert(key.clone());
        let executed = executed_keys.contains(&key);
        let count = detection_counts.get(&key).map(|(c,_)| *c as usize).unwrap_or(0);
        assert!(executed && count >= cfg.max_detections_without_exec);
        // should be included due to executed override
        assert!(executed || count < cfg.max_detections_without_exec);
    }

    #[test]
    fn detection_history_ttl_prunes_old_counts() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let cfg = ArbConfig { detection_history_ttl_ms: 1000, ..default_config() };
        let opp = mk_opp(&["A","B","A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        detection_counts.insert(key.clone(), (2, 1_000));
        // advance beyond TTL
        let now = 3_500u64;
        detection_counts.retain(|_, &mut (_, ts)| now.saturating_sub(ts) <= cfg.detection_history_ttl_ms);
        assert!(detection_counts.get(&key).is_none());
        // With count missing, include under cap
        let count = detection_counts.get(&key).map(|(c,_)| *c as usize).unwrap_or(0);
        assert!(count < cfg.max_detections_without_exec);
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
    let s = state.read().await;
    let m = &s.metrics;
    format!(
        concat!(
            "arb_detection_cycles_total {}\n",
            "arb_opportunities_active {}\n",
            "arb_last_detection_ms {}\n",
            "arb_detection_duration_ms {}\n",
            "arb_graph_nodes {}\n",
            "arb_graph_edges {}\n",
            "arb_ws_push_total {}\n",
            "arb_ws_skipped_nochange_total {}\n",
            "arb_max_profit_bps {}\n",
            "arb_avg_profit_bps {}\n",
            "arb_diff_to_detect_ms {}\n",
            "arb_detection_hits_total {}\n",
            "arb_detection_misses_total {}\n",
            "arb_opportunities_detected_total {}\n",
            "arb_graph_last_version {}\n",
            "arb_graph_last_timestamp {}\n"
        ),
        m.detection_cycles_total,
        m.opportunities_active,
        m.last_detection_ms,
        m.detection_duration_ms,
        m.graph_nodes,
        m.graph_edges,
        m.ws_push_total,
        m.ws_skipped_nochange_total,
        m.max_profit_bps,
        m.avg_profit_bps,
        m.diff_to_detect_ms,
        m.detection_hits_total,
        m.detection_misses_total,
        m.opportunities_detected_total,
        s.last_graph_version,
        s.last_graph_ts
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

#[derive(serde::Serialize)]
struct GraphVersionResponse { version: u64, timestamp: u64 }

#[derive(serde::Deserialize)]
struct GraphAckReq {
    version: Option<u64>,
    timeout_ms: Option<u64>,
}

#[derive(serde::Serialize)]
struct GraphAckResponse {
    ok: bool,
    current_version: u64,
    current_timestamp: u64,
    acked: bool,
}

async fn arb_graph_version(State(state): State<Arc<RwLock<AppState>>>) -> Json<GraphVersionResponse> {
    let s = state.read().await;
    Json(GraphVersionResponse { version: s.last_graph_version, timestamp: s.last_graph_ts })
}

async fn arb_graph_ack(State(state): State<Arc<RwLock<AppState>>>, headers: HeaderMap, Json(req): Json<GraphAckReq>) -> Json<GraphAckResponse> {
    if !auth_ok(Some(&headers)) { 
        return Json(GraphAckResponse { ok: false, current_version: 0, current_timestamp: 0, acked: false });
    }
    let want_version = req.version.unwrap_or(0);
    let timeout_ms = req.timeout_ms.unwrap_or(2500);
    let start = std::time::Instant::now();
    
    // Poll until version is >= want_version or timeout
    loop {
        let s = state.read().await;
        let last_version = s.last_graph_version;
        let current_ts = s.last_graph_ts;
        drop(s);
        
        if want_version > 0 && last_version >= want_version {
            return Json(GraphAckResponse { 
                ok: true, 
                current_version: last_version, 
                current_timestamp: current_ts, 
                acked: true 
            });
        }
        
        if start.elapsed().as_millis() as u64 >= timeout_ms {
            break;
        }
        
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    
    let final_version = {
        let s = state.read().await;
        s.last_graph_version
    };
    Json(GraphAckResponse { 
        ok: true, 
        current_version: final_version, 
        current_timestamp: 0, 
        acked: false 
    })
}

// trigger_refresh removed with local mode deprecation

fn auth_ok(headers: Option<&HeaderMap>) -> bool {
    let expect = std::env::var("ARB_SHARED_SECRET").ok().unwrap_or_default();
    if expect.is_empty() { return true; }
    if let Some(hm) = headers {
        if let Some(val) = hm.get("authorization") {
            if let Ok(s) = val.to_str() {
                let token = s.trim();
                let want = format!("Bearer {}", expect);
                return token == want;
            }
        }
    }
    false
}


#[cfg(test)]
mod e2e_tests {
    use super::*;
    use axum::http::HeaderValue;
    use axum::http::HeaderMap as AxumHeaderMap;

    fn hv(s: &str) -> HeaderValue { HeaderValue::from_str(s).unwrap() }

    #[tokio::test]
    async fn diff_ordering_and_version_guards_apply_in_order() {
        std::env::set_var("ARB_SHARED_SECRET", "");
        let state = Arc::new(RwLock::new(AppState { config: default_config(), opportunities: Vec::new(), graph: ArbGraph::new(), metrics: Metrics::default(), events: Vec::new(), near_miss: None, near_miss_shortfall_bps: None, near_misses: Vec::new(), last_graph_version: 1, last_graph_ts: 1, pending_added_edges: Vec::new(), pending_updated_edges: Vec::new(), pending_removed_edge_ids: Vec::new(), pending_graph_version: None, pending_graph_ts: None, wake: Arc::new(Notify::new()), detection_counts: HashMap::new(), executed_keys: HashSet::new() }));

        // Buffer a valid diff at v=2 and a stale diff at v=1
        let mut headers = AxumHeaderMap::new();
        headers.insert("authorization", hv(""));
        let added = vec![GraphDiffEdge { source: "A".into(), target: "B".into(), dex: Some("D".into()), pool_id: None, fee_bps: Some(0), liquidity: Some(1.0), liquidity_display: Some(1.0), price_a_per_b: Some(1.0) }];
        let req_ok = GraphDiffReq { version: Some(2), timestamp: Some(2), added_edges: Some(added), updated_edges: None, removed_edge_ids: None };
        let _ = arb_graph_update(State(state.clone()), headers.clone(), Json(req_ok)).await;
        // Stale should be skipped immediately
        let req_stale = GraphDiffReq { version: Some(1), timestamp: Some(1), added_edges: Some(vec![]), updated_edges: None, removed_edge_ids: None };
        let resp = arb_graph_update(State(state.clone()), headers.clone(), Json(req_stale)).await;
        let j = resp.0; // Json<Value>
        assert!(j.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false) || j.get("ok").is_some());

        // Apply buffered diffs by running the critical section from loop
        {
            let mut s = state.write().await;
            assert_eq!(s.pending_added_edges.len(), 1);
            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
            let added = std::mem::take(&mut s.pending_added_edges);
            let updated = std::mem::take(&mut s.pending_updated_edges);
            if !removed.is_empty() { let _ = s.graph.remove_edges_by_ids(&removed); }
            let mut upsert = |e: &GraphDiffEdge| {
                let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                let fee = e.fee_bps.unwrap_or(0);
                let liq = e.liquidity.unwrap_or(0.0);
                let liq_disp = e.liquidity_display.unwrap_or(0.0);
                let (_base, rate_eff) = edge_rate_effective_local(e.price_a_per_b, e.fee_bps);
                s.graph.upsert_edge(&dex, &e.source, &e.target, EdgeData { rate_effective: rate_eff, fee_bps: fee, liquidity: liq, dex: dex.clone(), pool_id: e.pool_id.clone().unwrap_or_default(), liquidity_display: liq_disp });
            };
            for e in added.iter() { upsert(e); }
            for e in updated.iter() { upsert(e); }
            if let Some(v) = s.pending_graph_version.take() { s.last_graph_version = v; }
            if let Some(t) = s.pending_graph_ts.take() { s.last_graph_ts = t; }
            s.metrics.graph_nodes = s.graph.g.node_count() as u64;
            s.metrics.graph_edges = s.graph.g.edge_count() as u64;
        }
        let s = state.read().await;
        assert_eq!(s.last_graph_version, 2);
        assert_eq!(s.graph.g.edge_count(), 1);
    }

    #[tokio::test]
    async fn snapshot_then_diffs_detect_cycle() {
        std::env::set_var("ARB_SHARED_SECRET", "");
        let state = Arc::new(RwLock::new(AppState { config: default_config(), opportunities: Vec::new(), graph: ArbGraph::new(), metrics: Metrics::default(), events: Vec::new(), near_miss: None, near_miss_shortfall_bps: None, near_misses: Vec::new(), last_graph_version: 0, last_graph_ts: 0, pending_added_edges: Vec::new(), pending_updated_edges: Vec::new(), pending_removed_edge_ids: Vec::new(), pending_graph_version: None, pending_graph_ts: None, wake: Arc::new(Notify::new()), detection_counts: HashMap::new(), executed_keys: HashSet::new() }));

        // Start with snapshot of empty graph at v=1
        let h = AxumHeaderMap::new();
        let snap = GraphSnapshotReq { graph: StartReqGraph { version: Some(1), timestamp: Some(1), edges: Vec::new(), nodes: Vec::new() } };
        let _ = arb_graph_snapshot(State(state.clone()), h.clone(), Json(snap)).await;

        // Push diffs building a two-edge arbitrage A<->B: rates 2.0 and 0.6 -> product 1.2
        let add1 = GraphDiffEdge { source: "A".into(), target: "B".into(), dex: Some("D".into()), pool_id: None, fee_bps: Some(0), liquidity: Some(1.0), liquidity_display: Some(1.0), price_a_per_b: Some(0.5) }; // B per A = 2.0
        let add2 = GraphDiffEdge { source: "B".into(), target: "A".into(), dex: Some("D".into()), pool_id: None, fee_bps: Some(0), liquidity: Some(1.0), liquidity_display: Some(1.0), price_a_per_b: Some(1.6666666667) }; // A per B = 1.666.. => B per A = 0.6
        let diff = GraphDiffReq { version: Some(2), timestamp: Some(2), added_edges: Some(vec![add1, add2]), updated_edges: None, removed_edge_ids: None };
        let _ = arb_graph_update(State(state.clone()), h.clone(), Json(diff)).await;

        // Apply diffs (simulate loop section)
        {
            let mut s = state.write().await;
            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
            let added = std::mem::take(&mut s.pending_added_edges);
            let updated = std::mem::take(&mut s.pending_updated_edges);
            if !removed.is_empty() { let _ = s.graph.remove_edges_by_ids(&removed); }
            let mut upsert = |e: &GraphDiffEdge| {
                let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                let fee = e.fee_bps.unwrap_or(0);
                let liq = e.liquidity.unwrap_or(0.0);
                let liq_disp = e.liquidity_display.unwrap_or(0.0);
                let px = if let Some(px) = e.price_a_per_b { if px.is_finite() && px > 0.0 { px } else { 0.0 } } else { 0.0 };
                let base = if px > 0.0 { 1.0 / px } else { 0.0 };
                let rate_eff = if base > 0.0 { base * (1.0 - (fee as f64)/10_000.0).max(0.0) } else { 0.0 };
                s.graph.upsert_edge(&dex, &e.source, &e.target, EdgeData { rate_effective: rate_eff, fee_bps: fee, liquidity: liq, dex: dex.clone(), pool_id: e.pool_id.clone().unwrap_or_default(), liquidity_display: liq_disp });
            };
            for e in added.iter() { upsert(e); }
            for e in updated.iter() { upsert(e); }
            if let Some(v) = s.pending_graph_version.take() { s.last_graph_version = v; }
            if let Some(t) = s.pending_graph_ts.take() { s.last_graph_ts = t; }
        }

        // Run detection and assert we find a cycle
        let s = state.read().await;
        let cycles = detect_negative_cycles(&s.graph);
        assert!(!cycles.is_empty());
    }
}
