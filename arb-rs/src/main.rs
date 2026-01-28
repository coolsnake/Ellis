use petgraph::prelude::NodeIndex;
use petgraph::visit::EdgeRef;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tokio::sync::{Notify, RwLock};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
mod opportunities;
use opportunities::{
    OpportunitiesResponse, OpportunitiesSummary, Opportunity, RejectedOpportunity,
};
mod graph;
use graph::{expand_nodes_by_hops, ArbGraph, EdgeData};
mod algos;
use algos::{detect_near_miss_cycles, detect_negative_cycles, detect_negative_cycles_filtered, detect_negative_cycles_from_anchors, detect_negative_cycles_spfa, detect_negative_cycles_spfa_filtered};
mod edge_selection;
use edge_selection::{select_best_edge_combination, compute_profit_bps, is_profitable};

const REJECTED_DEBUG_LIMIT: usize = 15;
const REJECTED_DEBUG_TTL_MS: u64 = 30_000;

#[derive(Default, serde::Serialize, serde::Deserialize, Clone)]
#[serde(default)] // Use Default for any missing fields during deserialization
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
    // Base TTL for opportunity persistence calculation (independent of loop timing)
    opportunity_base_ttl_ms: u64,
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
    // Algorithm selection: use SPFA (Shortest Path Faster Algorithm) instead of standard Bellman-Ford
    use_spfa: bool,
    // When true, run both BF and SPFA algorithms and merge results for more comprehensive detection
    run_dual_algo: bool,
    // Pruning of competitive paths
    // Limit number of SOL<->stable hops allowed per cycle; None means unlimited
    max_sol_stable_hops: Option<usize>,
    // If true, drop any cycle that includes a stable<->stable hop (e.g., USDC<->USDT)
    drop_stable_stable_hops: bool,
    // Optional override list of stable mints; when unset or empty, defaults to {USDC, USDT}
    stable_mints: Option<Vec<String>>,
    // When true, apply 10^k magnitude calibration on ingest (backend already calibrates)
    calibrate_magnitude_on_ingest: bool,
    // Start mint mode for cycle detection: "any" (default), "sol_usdc", or "anchors"
    #[serde(default = "default_start_mint_mode")]
    start_mint_mode: String,
    // List of anchor mints to use as cycle starting points (used when start_mint_mode is "anchors")
    anchor_mints: Option<Vec<String>>,
    // Maximum number of edge combinations to enumerate when selecting pools for a cycle
    // If exceeded, will use top_k_edges_per_hop to reduce combinations
    #[serde(default = "default_max_edge_combinations")]
    max_edge_combinations: usize,
    // When edge combinations exceed max_edge_combinations, keep only top-K edges per hop
    #[serde(default = "default_top_k_edges_per_hop")]
    top_k_edges_per_hop: usize,
    // WebSocket broadcast interval in milliseconds (lower = faster opportunity delivery)
    // CRITICAL: This directly impacts execution latency - lower values push opportunities faster
    #[serde(default = "default_ws_broadcast_interval_ms")]
    ws_broadcast_interval_ms: u64,
}

fn default_start_mint_mode() -> String {
    "any".to_string()
}

fn default_max_edge_combinations() -> usize {
    10_000
}

fn default_top_k_edges_per_hop() -> usize {
    5
}

fn default_ws_broadcast_interval_ms() -> u64 {
    // Default 25ms for minimal latency opportunity delivery (was 1500ms)
    // Detection loop can run faster than 100ms, so we match that cadence
    // Can be overridden via ARB_WS_BROADCAST_INTERVAL_MS environment variable
    25
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
    // Double-buffer pattern metrics
    // Time between snapshot creation and detection completion (how stale are results)
    detection_staleness_ms: u64,
    // How old the detection snapshot is vs live graph (version lag)
    snapshot_version_lag: u64,
    // Timestamp when current detection snapshot was created
    snapshot_created_ms: u64,
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
    rejected_opportunities: Vec<RejectedOpportunity>,
    rejected_opportunities_updated_ms: u64,
    // Live graph - receives updates immediately from HTTP handlers
    live_graph: ArbGraph,
    live_graph_version: AtomicU64,
    // Immutable snapshot for detection - cloned from live_graph at start of each detection cycle
    detection_snapshot: Option<Arc<ArbGraph>>,
    detection_snapshot_version: AtomicU64,
    metrics: Metrics,
    events: Vec<EventItem>,
    near_miss: Option<Opportunity>,
    near_miss_shortfall_bps: Option<i64>,
    near_misses: Vec<Opportunity>,
    last_graph_version: AtomicU64, // Committed version for ACK responses
    last_graph_ts: AtomicU64,      // Committed timestamp for ACK responses
    // Buffered graph updates (legacy - will be removed when detection loop uses snapshots)
    pending_added_edges: Vec<GraphDiffEdge>,
    pending_updated_edges: Vec<GraphDiffEdge>,
    pending_removed_edge_ids: Vec<String>,
    // Version tracking for incoming updates (used for ACK coordination)
    pending_graph_version: AtomicU64, // Use u64::MAX as "None" sentinel
    pending_graph_ts: AtomicU64,      // Use u64::MAX as "None" sentinel
    // Resync tracking
    consecutive_empty_cycles: AtomicU64,
    last_resync_attempt_ms: AtomicU64,
    // Event-driven wakeup for detection loop
    wake: Arc<Notify>,
    // Notify for version changes (for ACK handlers)
    version_changed: Arc<Notify>,
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
struct HealthResp {
    status: &'static str,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Optional: prepare a bridge sender for backend logging if env is set
    #[derive(Clone)]
    struct BridgeWriter {
        tx: Option<tokio::sync::mpsc::Sender<String>>,
    }
    impl std::io::Write for BridgeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if let Some(tx) = &self.tx {
                let _ = tx.try_send(String::from_utf8_lossy(buf).to_string());
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
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
                    Some(format!(
                        "Basic {}",
                        general_purpose::STANDARD.encode(creds.as_bytes())
                    ))
                }
                _ => None,
            }
        };
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                let msg = line.trim();
                if msg.is_empty() {
                    continue;
                }
                // Infer level from formatted prefix if present
                let mut level = "info";
                if msg.starts_with("[ERROR]") {
                    level = "error";
                } else if msg.starts_with("[WARN]") {
                    level = "warn";
                } else if msg.starts_with("[INFO]") {
                    level = "info";
                } else if msg.starts_with("[DEBUG]") {
                    level = "debug";
                }
                // Try to infer category: map known prefixes to backend categories
                let cat = if msg.contains("arb.") {
                    Some("arb")
                } else if msg.contains("graph:") || msg.contains("graph.") {
                    Some("graph")
                } else if msg.contains("pools") {
                    Some("pools")
                } else {
                    None
                };
                let payload = if let Some(c) = cat {
                    serde_json::json!({ "level": level, "message": msg, "cat": c })
                } else {
                    serde_json::json!({ "level": level, "message": msg })
                };
                let mut req = client.post(&url).json(&payload);
                if let Some(h) = &auth_header {
                    req = req.header("authorization", h);
                }
                let _ = req.send().await;
            }
        });
    }

    // In-memory ring buffer to capture formatted log lines (last 2000)
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    #[derive(Clone)]
    struct RingWriter {
        ring: Arc<Mutex<VecDeque<String>>>,
        buf: String,
    }
    impl std::io::Write for RingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.buf.push_str(&String::from_utf8_lossy(bytes));
            while let Some(pos) = self.buf.find('\n') {
                let line = self.buf[..pos].to_string();
                if !line.trim().is_empty() {
                    let mut guard = self.ring.lock().unwrap();
                    if guard.len() >= 2000 {
                        guard.pop_front();
                    }
                    guard.push_back(line);
                }
                self.buf.drain(..=pos);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        // Plain layer without timestamps to avoid long timestamps in console
        .with(tracing_subscriber::fmt::layer().without_time())
        // Bridge layer (no ANSI, no time) to backend terminal/log endpoint
        .with(
            tracing_subscriber::fmt::layer()
                .without_time()
                .with_ansi(false)
                .with_writer(move || BridgeWriter {
                    tx: bridge_tx.clone(),
                }),
        )
        // Ring capture layer (no ANSI, no time) writing to in-memory buffer
        .with(
            tracing_subscriber::fmt::layer()
                .without_time()
                .with_ansi(false)
                .with_writer({
                    let ring = ring.clone();
                    move || RingWriter {
                        ring: ring.clone(),
                        buf: String::new(),
                    }
                }),
        )
        .init();

    let loaded_config = load_config();
    eprintln!("[arb-rs] Startup config: start_mint_mode={}, enabled={}", loaded_config.start_mint_mode, loaded_config.enabled);
    let state = Arc::new(RwLock::new(AppState {
        config: loaded_config,
        opportunities: Vec::new(),
        rejected_opportunities: Vec::new(),
        rejected_opportunities_updated_ms: 0,
        live_graph: ArbGraph::new(),
        live_graph_version: AtomicU64::new(0),
        detection_snapshot: None,
        detection_snapshot_version: AtomicU64::new(0),
        metrics: Metrics::default(),
        events: Vec::new(),
        near_miss: None,
        near_miss_shortfall_bps: None,
        near_misses: Vec::new(),
        last_graph_version: AtomicU64::new(0),
        last_graph_ts: AtomicU64::new(0),
        pending_added_edges: Vec::new(),
        pending_updated_edges: Vec::new(),
        pending_removed_edge_ids: Vec::new(),
        pending_graph_version: AtomicU64::new(u64::MAX),
        pending_graph_ts: AtomicU64::new(u64::MAX),
        consecutive_empty_cycles: AtomicU64::new(0),
        last_resync_attempt_ms: AtomicU64::new(0),
        wake: Arc::new(Notify::new()),
        version_changed: Arc::new(Notify::new()),
        detection_counts: std::collections::HashMap::new(),
        executed_keys: std::collections::HashSet::new(),
    }));

    // Install shutdown handler to clear in-memory state
    {
        use tokio::signal;
        let state_for_shutdown = state.clone();
        tokio::spawn(async move {
            // SIGINT or SIGTERM
            let _ = signal::ctrl_c().await;
            let mut s = state_for_shutdown.write().await;
            s.live_graph = ArbGraph::new();
            s.opportunities.clear();
            s.rejected_opportunities.clear();
            s.rejected_opportunities_updated_ms = 0;
            s.near_miss = None;
            s.near_miss_shortfall_bps = None;
            s.pending_added_edges.clear();
            s.pending_updated_edges.clear();
            s.pending_removed_edge_ids.clear();
            s.pending_graph_version.store(u64::MAX, Ordering::Release);
            s.pending_graph_ts.store(u64::MAX, Ordering::Release);
            s.last_graph_version.store(0, Ordering::Release);
            s.last_graph_ts.store(0, Ordering::Release);
        });
    }

    // Kick off a background task to update opportunities using config interval (MVP placeholder)
    let loop_state = state.clone();
    tokio::spawn(async move {
        loop {
            let iter_start = Instant::now();
            // Execute loop iteration - errors are logged but don't stop the loop
            let (enabled, _idle_ms, min_bps, max_hops) = {
                let s = loop_state.read().await;
                (
                    s.config.enabled,
                    s.config.max_idle_ms,
                    s.config.min_profit_bps,
                    s.config.max_hops,
                )
            };
            if enabled {
                let diff_apply_start = Instant::now();
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
                let mut version_to_commit: Option<u64> = None;
                let mut ts_to_commit: Option<u64> = None;
                // Best-effort peek at backend graph version with a short timeout.
                // Do not advance local last_graph_version here to avoid racing with buffered diffs.
                let api_base = std::env::var("BACKEND_API_BASE")
                    .unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                let gv_url = format!("{}/arb/graph/version", api_base.trim_end_matches('/'));
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    reqwest::Client::new().get(&gv_url).send(),
                )
                .await;
                let loop_start = Instant::now();
                let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
                // Apply any buffered diffs now (between detection runs)
                {
                    let mut version_slot: Option<u64> = None;
                    let mut ts_slot: Option<u64> = None;
                    // Extract pending data and config quickly, then drop write lock for expensive calibration
                    let (updates_data, rem_ct, add_ct, upd_ct) = {
                        let mut s = loop_state.write().await;
                        let pending_version_val = s.pending_graph_version.load(Ordering::Acquire);
                        let pending_ts_val = s.pending_graph_ts.load(Ordering::Acquire);
                        let rem_ct = s.pending_removed_edge_ids.len();
                        let add_ct = s.pending_added_edges.len();
                        let upd_ct = s.pending_updated_edges.len();
                        let has_updates = !s.pending_removed_edge_ids.is_empty()
                            || !s.pending_added_edges.is_empty()
                            || !s.pending_updated_edges.is_empty();

                        if pending_version_val != u64::MAX {
                            version_slot = Some(pending_version_val);
                            if pending_ts_val != u64::MAX {
                                ts_slot = Some(pending_ts_val);
                            }
                            tracing::info!(
                                pending_version = pending_version_val,
                                pending_timestamp = pending_ts_val,
                                has_updates,
                                "arb.graph.version: queued"
                            );
                            s.pending_graph_version.store(u64::MAX, Ordering::Release);
                            if pending_ts_val != u64::MAX {
                                s.pending_graph_ts.store(u64::MAX, Ordering::Release);
                            }
                        }

                        if has_updates {
                            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
                            let added = std::mem::take(&mut s.pending_added_edges);
                            let updated = std::mem::take(&mut s.pending_updated_edges);
                            let calibrate_enabled = s.config.calibrate_magnitude_on_ingest;
                            // Clone graph only if calibration is enabled (expensive operation)
                            let graph_snapshot = if calibrate_enabled {
                                Some(s.live_graph.clone())
                            } else {
                                None
                            };
                            // Apply removals quickly before dropping lock
                            if !removed.is_empty() {
                                let _ = s.live_graph.remove_edges_by_ids(&removed);
                            }
                            (
                                Some((removed, added, updated, calibrate_enabled, graph_snapshot)),
                                rem_ct,
                                add_ct,
                                upd_ct,
                            )
                        } else {
                            (None, 0, 0, 0)
                        }
                    };

                    // Always commit version if we captured it (even if no edge updates)
                    // This ensures ACK requests can succeed even for version-only updates
                    if version_slot.is_some() {
                        version_to_commit = version_slot;
                        ts_to_commit = ts_slot;
                    }

                    // Build change sets and do calibration outside write lock
                    if let Some((removed, added, updated, calibrate_enabled, graph_snapshot)) =
                        updates_data
                    {
                        // Build change sets BEFORE applying removals to derive scope
                        for id in removed.iter() {
                            changed_edge_ids.insert(id.clone());
                        }
                        let synth_edge_id = |src: &str, dst: &str, dex: &str| -> String {
                            format!("{}->{}-{}", src, dst, dex)
                        };
                        for e in added.iter().chain(updated.iter()) {
                            changed_mints.insert(e.source.clone());
                            changed_mints.insert(e.target.clone());
                            if let Some(pid) = &e.pool_id {
                                if !pid.is_empty() {
                                    changed_edge_ids.insert(pid.clone());
                                }
                            }
                            if let Some(dex) = &e.dex {
                                if e.pool_id.is_none() {
                                    changed_edge_ids
                                        .insert(synth_edge_id(&e.source, &e.target, dex));
                                }
                            }
                        }

                        // Do magnitude calibration outside write lock (expensive operation)
                        let mut calibrated_edges: Vec<(
                            String,
                            String,
                            String,
                            i64,
                            f64,
                            f64,
                            String,
                            f64,
                            Option<String>,
                            Option<String>,
                            Option<i64>,
                            Option<i64>,
                            Option<String>,
                            Option<String>,
                            Option<String>,
                            Option<String>,
                        )> = Vec::new();
                        let sol_mint: &str = "So11111111111111111111111111111111111111112";
                        let usdc_mint: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

                        // OPTIMIZATION: Pre-compute SOL/USDC price and cache USD lookups to avoid O(E) scans per edge
                        let mut usd_cache: std::collections::HashMap<String, f64> =
                            std::collections::HashMap::new();
                        let sol_usd_cached: Option<f64> =
                            if calibrate_enabled && graph_snapshot.is_some() {
                                let graph = graph_snapshot.as_ref().unwrap();
                                // Find SOL/USDC price once
                                let mut sol_usd: Option<f64> = None;
                                for edge in graph.g.edge_references() {
                                    let src = graph
                                        .g
                                        .node_weight(edge.source())
                                        .cloned()
                                        .unwrap_or_default();
                                    let dst = graph
                                        .g
                                        .node_weight(edge.target())
                                        .cloned()
                                        .unwrap_or_default();
                                    let r = edge.weight().rate_effective;
                                    if r <= 0.0 {
                                        continue;
                                    }
                                    if src == sol_mint && dst == usdc_mint {
                                        sol_usd = Some(r);
                                        break;
                                    }
                                    if src == usdc_mint && dst == sol_mint {
                                        sol_usd = Some(1.0 / r);
                                        break;
                                    }
                                }
                                sol_usd
                            } else {
                                None
                            };

                        for e in added.iter().chain(updated.iter()) {
                            let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                            let fee: i64 = e.fee_bps.unwrap_or(0);
                            let liq = e.liquidity.unwrap_or(0.0);
                            let liq_disp = e.liquidity_display.unwrap_or(0.0);
                            let _pool_id = e.pool_id.clone().unwrap_or_default();
                            let px_raw = if let Some(px) = e.price_a_per_b {
                                if px.is_finite() && px > 0.0 {
                                    px
                                } else {
                                    0.0
                                }
                            } else {
                                0.0
                            };
                            let mut px = px_raw;

                            if px > 0.0 && calibrate_enabled {
                                if let Some(ref graph) = graph_snapshot {
                                    // Optimized USD lookup with caching
                                    let get_usd_cached =
                                        |mint: &str,
                                         graph: &ArbGraph,
                                         cache: &mut std::collections::HashMap<String, f64>,
                                         sol_usd: Option<f64>|
                                         -> Option<f64> {
                                            if mint == usdc_mint {
                                                return Some(1.0);
                                            }
                                            if let Some(&price) = cache.get(mint) {
                                                return Some(price);
                                            }

                                            if let Some(idx) = graph.map.get(mint) {
                                                // Prefer direct edges to USDC
                                                for edge in graph.g.edges(*idx) {
                                                    let u = edge.source();
                                                    let v = edge.target();
                                                    let src = graph
                                                        .g
                                                        .node_weight(u)
                                                        .cloned()
                                                        .unwrap_or_default();
                                                    let dst = graph
                                                        .g
                                                        .node_weight(v)
                                                        .cloned()
                                                        .unwrap_or_default();
                                                    let r = edge.weight().rate_effective;
                                                    if dst == usdc_mint && r > 0.0 {
                                                        cache.insert(mint.to_string(), r);
                                                        return Some(r);
                                                    }
                                                    if src == usdc_mint && r > 0.0 {
                                                        let price = 1.0 / r;
                                                        cache.insert(mint.to_string(), price);
                                                        return Some(price);
                                                    }
                                                }
                                                // Via SOL (use cached price)
                                                if let Some(su) = sol_usd {
                                                    for edge in graph.g.edges(*idx) {
                                                        let u = edge.source();
                                                        let v = edge.target();
                                                        let s = graph
                                                            .g
                                                            .node_weight(u)
                                                            .cloned()
                                                            .unwrap_or_default();
                                                        let t = graph
                                                            .g
                                                            .node_weight(v)
                                                            .cloned()
                                                            .unwrap_or_default();
                                                        let r = edge.weight().rate_effective;
                                                        if r <= 0.0 {
                                                            continue;
                                                        }
                                                        if s == mint && t == sol_mint {
                                                            let price = su / r;
                                                            cache.insert(mint.to_string(), price);
                                                            return Some(price);
                                                        }
                                                        if s == sol_mint && t == mint {
                                                            let price = su * r;
                                                            cache.insert(mint.to_string(), price);
                                                            return Some(price);
                                                        }
                                                    }
                                                }
                                            }
                                            None
                                        };
                                    let pa = get_usd_cached(
                                        &e.source,
                                        graph,
                                        &mut usd_cache,
                                        sol_usd_cached,
                                    );
                                    let pb = get_usd_cached(
                                        &e.target,
                                        graph,
                                        &mut usd_cache,
                                        sol_usd_cached,
                                    );
                                    if let (Some(pa), Some(pb)) = (pa, pb) {
                                        let refv = pb / pa;
                                        let mut best = px;
                                        let mut best_dev = f64::INFINITY;
                                        let mut best_k = 0i32;
                                        for k in -8..=8 {
                                            let cand = px * 10f64.powi(k);
                                            if !(cand.is_finite() && cand > 0.0) {
                                                continue;
                                            }
                                            let dev = (cand / refv).max(refv / cand);
                                            if dev + 1e-12 < best_dev {
                                                best_dev = dev;
                                                best = cand;
                                                best_k = k;
                                            }
                                        }
                                        if best_k != 0 {
                                            tracing::debug!(mint_a = %e.source, mint_b = %e.target, px_in = px_raw, px_out = best, k = best_k, refv, "arb.magnitude.calibrated.diff");
                                        }
                                        px = best;
                                    }
                                }
                            }
                            let pool_id =
                                canonical_edge_id(e.pool_id.as_deref(), &e.source, &e.target, &dex);
                            calibrated_edges.push((
                                e.source.clone(),
                                e.target.clone(),
                                dex,
                                fee,
                                liq,
                                liq_disp,
                                pool_id,
                                px,
                                e.native_mint_a.clone(),
                                e.native_mint_b.clone(),
                                e.native_decimals_a,
                                e.native_decimals_b,
                                e.native_account_a.clone(),
                                e.native_account_b.clone(),
                                e.native_reserve_a_raw.clone(),
                                e.native_reserve_b_raw.clone(),
                            ));
                        }

                        // Reacquire write lock briefly to apply calibrated edges
                        {
                            let mut s = loop_state.write().await;
                            for (
                                source,
                                target,
                                dex,
                                fee,
                                liq,
                                liq_disp,
                                pool_id,
                                price,
                                native_mint_a,
                                native_mint_b,
                                native_decimals_a,
                                native_decimals_b,
                                native_account_a,
                                native_account_b,
                                native_reserve_a_raw,
                                native_reserve_b_raw,
                            ) in calibrated_edges
                            {
                                insert_bidirectional_edges(
                                    &mut s.live_graph,
                                    &dex,
                                    &source,
                                    &target,
                                    &pool_id,
                                    fee,
                                    liq,
                                    liq_disp,
                                    price,
                                    native_mint_a,
                                    native_mint_b,
                                    native_decimals_a,
                                    native_decimals_b,
                                    native_account_a,
                                    native_account_b,
                                    native_reserve_a_raw,
                                    native_reserve_b_raw,
                                );
                            }
                            s.metrics.graph_updates_applied =
                                s.metrics.graph_updates_applied.saturating_add(1);
                            s.events.push(EventItem {
                                ts: now_ms(),
                                level: "info".into(),
                                message: format!(
                                    "arb.graph.diff: applied add={} upd={} rem={}",
                                    add_ct, upd_ct, rem_ct
                                ),
                            });
                            tracing::info!(
                                add = add_ct,
                                upd = upd_ct,
                                rem = rem_ct,
                                "arb.graph.diff: applied"
                            );
                            let len = s.events.len();
                            if len > 200 {
                                s.events.drain(0..(len - 200));
                            }
                            s.metrics.graph_nodes = s.live_graph.g.node_count() as u64;
                            s.metrics.graph_edges = s.live_graph.g.edge_count() as u64;
                        }
                        // CRITICAL FIX: Commit version immediately after applying diffs,
                        // but AFTER releasing the write lock to avoid blocking.
                        // This ensures ACK requests can succeed quickly even if detection takes a long time.
                        if let Some(v_commit) = version_to_commit {
                            let s = loop_state.write().await;
                            let current_v = s.last_graph_version.load(Ordering::Acquire);
                            if v_commit > current_v {
                                tracing::info!(
                                    old_version = current_v,
                                    new_version = v_commit,
                                    "arb.graph.version: committed"
                                );
                                s.last_graph_version.store(v_commit, Ordering::Release);
                                // Notify any waiting ACK handlers immediately
                                s.version_changed.notify_waiters();
                            }
                            if let Some(ts_commit) = ts_to_commit {
                                s.last_graph_ts.store(ts_commit, Ordering::Release);
                            }
                            drop(s);
                            // Clear version_to_commit so we don't commit again after detection
                            version_to_commit = None;
                            ts_to_commit = None;
                        }
                    } else {
                        tracing::info!("arb.graph.diff: none pending");
                        // Even if no diffs, commit version if we have one (version-only updates)
                        if let Some(v_commit) = version_to_commit {
                            let s = loop_state.write().await;
                            let current_v = s.last_graph_version.load(Ordering::Acquire);
                            if v_commit > current_v {
                                tracing::info!(
                                    old_version = current_v,
                                    new_version = v_commit,
                                    "arb.graph.version: committed"
                                );
                                s.last_graph_version.store(v_commit, Ordering::Release);
                                s.version_changed.notify_waiters();
                            }
                            if let Some(ts_commit) = ts_to_commit {
                                s.last_graph_ts.store(ts_commit, Ordering::Release);
                            }
                            drop(s);
                            version_to_commit = None;
                            ts_to_commit = None;
                        }
                    }
                }
                let diff_apply_ms = diff_apply_start.elapsed().as_millis() as u128;
                
                // Create detection snapshot if live_graph has changed since last snapshot
                // This implements the double-buffer pattern: updates go to live_graph,
                // detection runs on an immutable snapshot
                //
                // IMPORTANT: We use a single write lock to atomically check AND create the snapshot.
                // This prevents a race condition where an HTTP handler could modify live_graph
                // between checking the version and creating the snapshot.
                let _detection_graph: Arc<ArbGraph> = {
                    let mut s = loop_state.write().await;
                    let live_v = s.live_graph_version.load(Ordering::Acquire);
                    let snap_v = s.detection_snapshot_version.load(Ordering::Acquire);
                    let needs_snapshot = live_v > snap_v || s.detection_snapshot.is_none();

                    if needs_snapshot {
                        // Atomically capture both graph state AND version under same lock
                        // This ensures the snapshot version matches the actual graph state
                        let snapshot = Arc::new(s.live_graph.clone());
                        s.detection_snapshot = Some(snapshot.clone());
                        s.detection_snapshot_version.store(live_v, Ordering::Release);
                        // Track when snapshot was created
                        s.metrics.snapshot_created_ms = now_ms();
                        s.metrics.snapshot_version_lag = 0; // Fresh snapshot
                        // Commit version for ACK responses
                        if let Some(v) = version_to_commit.take() {
                            s.last_graph_version.store(v, Ordering::Release);
                            s.version_changed.notify_waiters();
                        }
                        if let Some(ts) = ts_to_commit.take() {
                            s.last_graph_ts.store(ts, Ordering::Release);
                        }
                        tracing::info!(
                            live_version = live_v,
                            nodes = s.live_graph.g.node_count(),
                            edges = s.live_graph.g.edge_count(),
                            "arb.graph.snapshot: created detection snapshot"
                        );
                        snapshot
                    } else {
                        // Update version lag metric
                        s.metrics.snapshot_version_lag = live_v.saturating_sub(snap_v);
                        // Return existing snapshot (guaranteed to exist since needs_snapshot was false)
                        s.detection_snapshot.clone().expect("snapshot must exist when needs_snapshot is false")
                    }
                };
                
                let detect_start = Instant::now();
                // Detect cycles (MVP -log weights)
                // Compare with previous to only push WS updates on change
                let (opps, prev, _near_pair, _near_list, rejected_samples): (
                    Vec<Opportunity>,
                    Vec<Opportunity>,
                    Option<(Opportunity, i64)>,
                    Vec<(Opportunity, i64)>,
                    Vec<RejectedOpportunity>,
                ) = {
                    let s = loop_state.read().await;
                    // Build affected node index set from changed mints
                    let mut changed_node_idxs: std::collections::HashSet<usize> =
                        std::collections::HashSet::new();
                    for m in changed_mints.iter() {
                        if let Some(idx) = s.live_graph.map.get(m) {
                            changed_node_idxs.insert(idx.index());
                        }
                    }
                    // Expand scope by hops (incoming + outgoing) up to configured bound
                    let expand_hops = s.config.filtered_expand_hops.unwrap_or(s.config.max_hops);
                    let affected_nodes =
                        expand_nodes_by_hops(&s.live_graph, &changed_node_idxs, expand_hops);
                    // Decide filtered vs full scan
                    let total_nodes = s.live_graph.g.node_count().max(1) as f64;
                    let ratio = (affected_nodes.len() as f64) / total_nodes;
                    let use_filtered = s.config.filtered_detect_enable
                        && !affected_nodes.is_empty()
                        && ratio <= s.config.filtered_node_ratio.max(0.0).min(1.0);
                    // Count edges in scope for metrics
                    let scope_edges: u64 = if use_filtered {
                        let mut c: u64 = 0;
                        for e in s.live_graph.g.edge_references() {
                            let u = e.source().index();
                            let v = e.target().index();
                            if affected_nodes.contains(&u) && affected_nodes.contains(&v) {
                                c += 1;
                            }
                        }
                        c
                    } else {
                        s.live_graph.g.edge_count() as u64
                    };
                    // Emit scope decision at INFO
                    tracing::info!(
                        use_filtered,
                        scope_nodes = affected_nodes.len(),
                        scope_edges,
                        total_nodes = s.live_graph.g.node_count(),
                        ratio,
                        "arb.detect.scope"
                    );
                    // Run detection - log which mode is being used
                    let current_mode = s.config.start_mint_mode.as_str();
                    let cycles = match current_mode {
                        "sol_usdc" => {
                            // SOL & USDC only mode - hardcoded anchors
                            tracing::debug!(target = "arb_rs", "arb.detect.mode=sol_usdc");
                            use std::collections::HashSet;
                            let mut sol_usdc_set = HashSet::new();
                            sol_usdc_set.insert("So11111111111111111111111111111111111111112".to_string()); // SOL
                            sol_usdc_set.insert("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()); // USDC
                            detect_negative_cycles_from_anchors(&s.live_graph, &sol_usdc_set, max_hops)
                        }
                        "anchors" => {
                            // Custom anchors mode - use configured anchor_mints
                            use std::collections::HashSet;
                            let anchor_set: HashSet<String> = s.config.anchor_mints
                                .clone()
                                .unwrap_or_default()
                                .into_iter()
                                .collect();
                            if anchor_set.is_empty() {
                                // Fallback to SOL + USDC if no anchors configured
                                let mut defaults = HashSet::new();
                                defaults.insert("So11111111111111111111111111111111111111112".to_string());
                                defaults.insert("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string());
                                detect_negative_cycles_from_anchors(&s.live_graph, &defaults, max_hops)
                            } else {
                                detect_negative_cycles_from_anchors(&s.live_graph, &anchor_set, max_hops)
                            }
                        }
                        _ => {
                            // "any" mode or unknown - full graph scan (existing behavior)
                            tracing::debug!(target = "arb_rs", mode = %current_mode, "arb.detect.mode=any_or_unknown");
                            if use_filtered {
                                // Run both BF and SPFA for filtered detection if run_dual_algo is enabled
                                if s.config.run_dual_algo {
                                    let mut combined = detect_negative_cycles_spfa_filtered(&s.live_graph, &affected_nodes, max_hops);
                                    let bf_cycles = detect_negative_cycles_filtered(&s.live_graph, &affected_nodes, max_hops);
                                    // Dedupe by node sequence
                                    let existing: std::collections::HashSet<Vec<usize>> = combined.iter().map(|c| c.nodes.clone()).collect();
                                    for c in bf_cycles {
                                        if !existing.contains(&c.nodes) {
                                            combined.push(c);
                                        }
                                    }
                                    combined
                                } else if s.config.use_spfa {
                                    detect_negative_cycles_spfa_filtered(&s.live_graph, &affected_nodes, max_hops)
                                } else {
                                    detect_negative_cycles_filtered(&s.live_graph, &affected_nodes, max_hops)
                                }
                            } else {
                                // Run both BF and SPFA on full graph if run_dual_algo is enabled
                                if s.config.run_dual_algo {
                                    let mut combined = detect_negative_cycles_spfa(&s.live_graph, max_hops);
                                    let bf_cycles = detect_negative_cycles(&s.live_graph, max_hops);
                                    let existing: std::collections::HashSet<Vec<usize>> = combined.iter().map(|c| c.nodes.clone()).collect();
                                    for c in bf_cycles {
                                        if !existing.contains(&c.nodes) {
                                            combined.push(c);
                                        }
                                    }
                                    combined
                                } else if s.config.use_spfa {
                                    detect_negative_cycles_spfa(&s.live_graph, max_hops)
                                } else {
                                    detect_negative_cycles(&s.live_graph, max_hops)
                                }
                            }
                        }
                    };
                    let cycles_count = cycles.len();
                    // Prepare metrics snapshot, then drop read lock before taking write lock to avoid deadlock
                    let used_filtered_flag_for_metrics = if use_filtered { 1 } else { 0 };
                    let scope_nodes_count_for_metrics = if use_filtered {
                        affected_nodes.len() as u64
                    } else {
                        s.live_graph.g.node_count() as u64
                    };
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
                    #[allow(unused_assignments, unused_variables)]
                    let mut _best_below: Option<Opportunity> = None;
                    #[allow(unused_variables)]
                    let mut best_below_shortfall: i64 = i64::MAX;
                    // Minimum liquidity threshold to consider an edge in rate selection
                    let min_edge_liq_threshold: f64 = 0.0; // filter out zero-liquidity edges
                                                           // Track rejection reasons for detailed logging
                    let mut rejected_too_short: usize = 0;
                    let mut rejected_too_long: usize = 0;
                    let mut rejected_not_simple: usize = 0;
                    let mut rejected_stable_stable: usize = 0;
                    let mut rejected_sol_stable_limit: usize = 0;
                    let mut rejected_no_edge: usize = 0;
                    let rejected_timeout: usize = 0;
                    let mut rejected_unprofitable: usize = 0;
                    let mut rejected_misaligned: usize = 0;
                    let mut rejected_duplicate: usize = 0;
                    let mut rejected_too_low_profit: usize = 0;
                    let mut rejected_too_high_profit: usize = 0;
                    let mut rejected_samples: Vec<RejectedOpportunity> = Vec::new();
                    let mut record_rejected =
                        |reason: &'static str,
                         labels: &[String],
                         profit_bps: Option<i64>,
                         net_bps: Option<i64>,
                         dexes: Option<&[String]>,
                         hop_dexes: Option<&[String]>,
                         hop_rates: Option<&[f64]>,
                         hop_outs: Option<&[f64]>,
                         hop_pool_ids: Option<&[String]>| {
                            if rejected_samples.len() >= REJECTED_DEBUG_LIMIT {
                                return;
                            }
                            if labels.is_empty() {
                                return;
                            }
                            rejected_samples.push(RejectedOpportunity {
                                reason: reason.to_string(),
                                path: labels.to_vec(),
                                hop_count: Some(labels.len()),
                                profit_bps,
                                net_bps,
                                dexes: dexes.map(|v| v.to_vec()),
                                hop_dexes: hop_dexes.map(|v| v.to_vec()),
                                hop_rates: hop_rates.map(|v| v.to_vec()),
                                hop_outs: hop_outs.map(|v| v.to_vec()),
                                hop_pool_ids: hop_pool_ids.map(|v| v.to_vec()),
                            });
                        };
                    for c in cycles.into_iter() {
                        // Enforce simple cycles and hop bound
                        // Allow 2-node cycles (e.g., USDC -> SOL -> USDC) for cross-DEX arbitrage
                        let nlen = c.nodes.len();
                        let node_count_total = s.live_graph.g.node_count();
                        let mut labels: Vec<String> = Vec::with_capacity(nlen);
                        for &idx in c.nodes.iter() {
                            if idx < node_count_total {
                                labels.push(s.live_graph.g[NodeIndex::new(idx)].clone());
                            } else {
                                labels.push(format!("node#{}", idx));
                            }
                        }
                        if nlen < 2 {
                            record_rejected(
                                "rejected_too_short",
                                &labels,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                            );
                            rejected_too_short += 1;
                            continue;
                        }
                        if nlen > max_hops {
                            record_rejected(
                                "rejected_too_long",
                                &labels,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                            );
                            rejected_too_long += 1;
                            continue;
                        }
                        tracing::debug!(len = nlen, "arb.detect.cycle.begin");
                        let mut uniq = std::collections::HashSet::new();
                        let mut simple = true;
                        for &v in c.nodes.iter() {
                            if !uniq.insert(v) {
                                simple = false;
                                break;
                            }
                        }
                        if !simple {
                            rejected_not_simple += 1;
                            continue;
                        }

                        // Validate node indices are in bounds before processing
                        let node_count = node_count_total;
                        if c.nodes.iter().any(|&i| i >= node_count) {
                            record_rejected(
                                "rejected_too_short",
                                &labels,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                            );
                            rejected_too_short += 1;
                            continue;
                        }

                        let start_is_usdc = labels.first().map(|m| m == usdc).unwrap_or(false);
                        // Prune highly competitive cycles: stable<->stable edges and cap SOL<->stable hops
                        let sol = "So11111111111111111111111111111111111111112";
                        let default_stables: std::collections::HashSet<&str> = [
                            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
                        ]
                        .into_iter()
                        .collect();
                        let cfg_stables: std::collections::HashSet<String> = s
                            .config
                            .stable_mints
                            .clone()
                            .unwrap_or_default()
                            .into_iter()
                            .collect();
                        let is_stable = |m: &str| {
                            if cfg_stables.is_empty() {
                                default_stables.contains(m)
                            } else {
                                cfg_stables.contains(m)
                            }
                        };
                        let mut has_stable_stable = false;
                        let mut sol_stable_hops: usize = 0;
                        for i in 0..labels.len() {
                            let a = &labels[i];
                            let b = &labels[(i + 1) % labels.len()];
                            let a_st = is_stable(a);
                            let b_st = is_stable(b);
                            if a_st && b_st {
                                has_stable_stable = true;
                                break;
                            }
                            if (a == sol && b_st) || (b == sol && a_st) {
                                sol_stable_hops += 1;
                            }
                        }
                        if s.config.drop_stable_stable_hops && has_stable_stable {
                            rejected_stable_stable += 1;
                            continue;
                        }
                        if let Some(limit) = s.config.max_sol_stable_hops {
                            if sol_stable_hops > limit {
                                rejected_sol_stable_limit += 1;
                                continue;
                            }
                        }
                        // Use exhaustive edge combination selection instead of greedy per-hop selection
                        let selection = select_best_edge_combination(
                            &s.live_graph,
                            &c.nodes,
                            min_edge_liq_threshold,
                            s.config.max_edge_combinations,
                            s.config.top_k_edges_per_hop,
                        );

                        let selection = match selection {
                            Some(sel) => sel,
                            None => {
                                tracing::info!(
                                    nodes = ?c.nodes,
                                    "arb.detect.cycle.no_valid_path"
                                );
                                rejected_no_edge += 1;
                                continue;
                            }
                        };

                        // Extract results from exhaustive selection
                        let rate_prod = selection.rate_product;
                        let log_rate_prod = selection.log_rate_product;
                        let min_edge_liquidity = selection.min_liquidity;
                        
                        // Build all required vectors from selected edges
                        let mut link_edges_used: usize = 0;
                        let mut link_penalty_bps_total: i64 = 0;
                        let mut dexes_set: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        let mut hop_dexes: Vec<String> = Vec::with_capacity(nlen);
                        let mut hop_rates: Vec<f64> = Vec::with_capacity(nlen);
                        let mut hop_pool_ids: Vec<String> = Vec::with_capacity(nlen);
                        let mut hop_fee_bps: Vec<i64> = Vec::with_capacity(nlen);
                        let mut hop_liq_disp: Vec<f64> = Vec::with_capacity(nlen);
                        let mut hop_outs: Vec<f64> = Vec::with_capacity(nlen);
                        let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> = None;
                        
                        let mut cur_out: f64 = if start_is_usdc {
                            s.config.quote_size_usd.max(0.0)
                        } else {
                            1.0
                        };

                        for (w, edge) in selection.edges.iter().enumerate() {
                            let u_idx = c.nodes[w];
                            let v_idx = c.nodes[(w + 1) % c.nodes.len()];
                            
                            if edge.dex == "Link" {
                                link_edges_used += 1;
                                link_penalty_bps_total += edge.fee_bps;
                            }
                            if !edge.dex.is_empty() && edge.dex != "Link" {
                                dexes_set.insert(edge.dex.clone());
                            }
                            
                            // Track bottleneck (lowest rate edge)
                            if bottleneck
                                .as_ref()
                                .map(|(_, _, _, r, _, _)| edge.rate_effective < *r)
                                .unwrap_or(true)
                            {
                                bottleneck = Some((
                                    u_idx,
                                    v_idx,
                                    edge.dex.clone(),
                                    edge.rate_effective,
                                    edge.liquidity,
                                    edge.fee_bps,
                                ));
                            }
                            
                            hop_dexes.push(edge.dex.clone());
                            hop_rates.push(edge.rate_effective);
                            hop_pool_ids.push(edge.pool_id.clone());
                            hop_fee_bps.push(edge.fee_bps);
                            hop_liq_disp.push(edge.liquidity_display);
                            
                            // Compute hop output
                            let next_out = if cur_out.is_finite() {
                                cur_out * edge.rate_effective
                            } else {
                                0.0
                            };
                            hop_outs.push(next_out);
                            cur_out = next_out;
                        }
                        // Use precision-safe profit calculation with log_rate_prod for accuracy near breakeven
                        let profit_bps = compute_profit_bps(rate_prod, log_rate_prod);

                        // Skip if cycle is unprofitable after picking best edges
                        // (Bellman-Ford detected negative cycle, but best edges don't form profitable cycle)
                        // Use is_profitable which accounts for floating point epsilon
                        if !is_profitable(rate_prod) {
                            let path_str = labels.join("->");
                            tracing::info!(path = %path_str, rate_prod, log_rate_prod, "arb.detect.cycle.unprofitable_after_edge_selection");
                            rejected_unprofitable += 1;
                            continue;
                        }

                        // Build anchor set for canonicalization based on current mode
                        let anchor_set_for_canon: HashSet<String> = match s.config.start_mint_mode.as_str() {
                            "sol_usdc" => {
                                let mut set = HashSet::new();
                                set.insert("So11111111111111111111111111111111111111112".to_string());
                                set.insert("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string());
                                set
                            }
                            "anchors" => s.config.anchor_mints.clone().unwrap_or_default().into_iter().collect(),
                            _ => HashSet::new(), // "any" mode - no anchor preference
                        };
                        
                        // Canonicalize cycle labels - prefer starting from anchor tokens, then lexicographic order
                        let canon = |v: &Vec<String>, anchors: &HashSet<String>| -> Vec<String> {
                            if v.is_empty() {
                                return v.clone();
                            }
                            let n = v.len();
                            let mut best_key: Option<String> = None;
                            let mut best_vec: Option<Vec<String>> = None;
                            let mut best_is_anchor = false;
                            
                            for i in 0..n {
                                let mut r = Vec::with_capacity(n);
                                for k in 0..n {
                                    r.push(v[(i + k) % n].clone());
                                }
                                let starts_with_anchor = anchors.contains(&r[0]);
                                let key = r.join("->");
                                
                                // Prefer anchor starts, then lexicographic order within same anchor preference
                                let is_better = match (starts_with_anchor, best_is_anchor) {
                                    (true, false) => true,  // Anchor beats non-anchor
                                    (false, true) => false, // Non-anchor loses to anchor
                                    _ => best_key.as_ref().map(|s| &key < s).unwrap_or(true), // Same anchor status: lexicographic
                                };
                                
                                if is_better {
                                    best_key = Some(key);
                                    best_vec = Some(r);
                                    best_is_anchor = starts_with_anchor;
                                }
                            }
                            best_vec.unwrap()
                        };
                        // Rotate hop arrays to match canon_labels start (no reversal allowed above)
                        let rotate_to_start =
                            |labels_orig: &Vec<String>,
                             labels_canon: &Vec<String>,
                             arr: &mut Vec<String>| {
                                if labels_orig.is_empty() || arr.is_empty() {
                                    return;
                                }
                                let n = labels_orig.len();
                                if n == 0 {
                                    return;
                                }
                                // find offset i where labels_orig[i] == labels_canon[0]
                                if let Some(i) =
                                    labels_orig.iter().position(|m| m == &labels_canon[0])
                                {
                                    if i % n != 0 {
                                        let mut tmp = vec![String::new(); n];
                                        for k in 0..n {
                                            tmp[k] = arr[(k + i) % n].clone();
                                        }
                                        *arr = tmp;
                                    }
                                }
                            };
                        let rotate_to_start_num =
                            |labels_orig: &Vec<String>,
                             labels_canon: &Vec<String>,
                             arr: &mut Vec<f64>| {
                                if labels_orig.is_empty() || arr.is_empty() {
                                    return;
                                }
                                let n = labels_orig.len();
                                if n == 0 {
                                    return;
                                }
                                if let Some(i) =
                                    labels_orig.iter().position(|m| m == &labels_canon[0])
                                {
                                    if i % n != 0 {
                                        let mut tmp = vec![0.0f64; n];
                                        for k in 0..n {
                                            tmp[k] = arr[(k + i) % n];
                                        }
                                        *arr = tmp;
                                    }
                                }
                            };
                        let rotate_to_start_i64 =
                            |labels_orig: &Vec<String>,
                             labels_canon: &Vec<String>,
                             arr: &mut Vec<i64>| {
                                if labels_orig.is_empty() || arr.is_empty() {
                                    return;
                                }
                                let n = labels_orig.len();
                                if n == 0 {
                                    return;
                                }
                                if let Some(i) =
                                    labels_orig.iter().position(|m| m == &labels_canon[0])
                                {
                                    if i % n != 0 {
                                        let mut tmp = vec![0i64; n];
                                        for k in 0..n {
                                            tmp[k] = arr[(k + i) % n];
                                        }
                                        *arr = tmp;
                                    }
                                }
                            };
                        let canon_labels = canon(&labels, &anchor_set_for_canon);
                        tracing::debug!(path = %canon_labels.join("->"), profit_bps, "arb.detect.cycle.end");
                        // Align hop arrays with the rotated labels (no reversal)
                        rotate_to_start(&labels, &canon_labels, &mut hop_pool_ids);
                        rotate_to_start(&labels, &canon_labels, &mut hop_dexes);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_rates);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_outs);
                        rotate_to_start_i64(&labels, &canon_labels, &mut hop_fee_bps);
                        rotate_to_start_num(&labels, &canon_labels, &mut hop_liq_disp);
                        // Validate alignment: each hop_pool_ids[i] must correspond to an edge between canon_labels[i] -> canon_labels[(i+1)%n]
                        {
                            let n = canon_labels.len();
                            let mut aligned = true;
                            for i in 0..n {
                                let src = &canon_labels[i];
                                let dst = &canon_labels[(i + 1) % n];
                                let pid = hop_pool_ids.get(i).cloned().unwrap_or_default();
                                let dex_i = hop_dexes.get(i).cloned().unwrap_or_default();
                                if pid.is_empty() || dex_i == "Link" {
                                    continue;
                                }
                                if let (Some(&u), Some(&v)) =
                                    (s.live_graph.map.get(src), s.live_graph.map.get(dst))
                                {
                                    let mut ok = false;
                                    for e in s.live_graph.g.edges_connecting(u, v) {
                                        if e.weight().pool_id == pid {
                                            ok = true;
                                            break;
                                        }
                                    }
                                    if !ok {
                                        aligned = false;
                                        break;
                                    }
                                } else {
                                    aligned = false;
                                    break;
                                }
                            }
                            if !aligned {
                                tracing::warn!(
                                    "arb.detect.cycle.misaligned path={} pools=[{}]",
                                    canon_labels.join("->"),
                                    hop_pool_ids.join(",")
                                );
                                rejected_misaligned += 1;
                                continue;
                            }
                        }
                        // Include both path and pool IDs in deduplication key to distinguish cycles
                        // that use the same tokens but different pools (different opportunities)
                        let key = format!("{}|{}", canon_labels.join("->"), hop_pool_ids.join(","));
                        if seen.contains(&key) {
                            rejected_duplicate += 1;
                            continue;
                        }
                        seen.insert(key);
                        // DEXes derived from edges selected along the cycle
                        let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                        dexes.sort();
                        // Estimate capacity: use min edge liquidity as a rough proxy
                        let est_capacity = if min_edge_liquidity.is_finite() {
                            Some(min_edge_liquidity.max(0.0))
                        } else {
                            None
                        };
                        let now_ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        // Compute net_bps as profit_bps - link penalties (already included in rate, but expose explicitly)
                        let net_bps = profit_bps - link_penalty_bps_total.max(0);
                        let bottleneck_edge =
                            bottleneck
                                .as_ref()
                                .and_then(|(ui, vi, dex, rate, liq, fee)| {
                                    // Validate indices are in bounds
                                    if *ui >= node_count || *vi >= node_count {
                                        return None;
                                    }
                                    let from = s.live_graph.g[NodeIndex::new(*ui)].clone();
                                    let to = s.live_graph.g[NodeIndex::new(*vi)].clone();
                                    Some(opportunities::BottleneckEdge {
                                        from,
                                        to,
                                        dex: dex.clone(),
                                        rate: *rate,
                                        liquidity: *liq,
                                        fee_bps: *fee,
                                    })
                                });
                        // Compute estimated USD profit if cycle notionally started at USDC
                        let est_profit_usd_val: f64 = if start_is_usdc {
                            s.config.quote_size_usd.max(0.0) * (rate_prod - 1.0)
                        } else {
                            0.0
                        };
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
                                    _best_below = Some(near);
                                    best_below_shortfall = shortfall;
                                }
                            }
                            rejected_too_low_profit += 1;
                            continue;
                        }
                        // Emit arb log for validation
                        {
                            let path_str = canon_labels.join("->");
                            let rates_str = hop_rates
                                .iter()
                                .map(|v| format!("{:.6}", v))
                                .collect::<Vec<_>>()
                                .join(",");
                            let outs_str = hop_outs
                                .iter()
                                .map(|v| format!("{:.6}", v))
                                .collect::<Vec<_>>()
                                .join(",");
                            let fees_str = hop_fee_bps
                                .iter()
                                .map(|v| v.to_string())
                                .collect::<Vec<_>>()
                                .join(",");
                            let pools_str = hop_pool_ids.join(",");
                            // Include explicit edges with closing hop for sequence validation
                            let edges_str = {
                                let mut v: Vec<String> = Vec::new();
                                let n = canon_labels.len();
                                for k in 0..n {
                                    let a = &canon_labels[k];
                                    let b = &canon_labels[(k + 1) % n];
                                    let id = hop_pool_ids.get(k).cloned().unwrap_or_default();
                                    let short = |m: &String| -> String {
                                        if m.len() > 8 {
                                            format!("{}…{}", &m[..4], &m[m.len() - 4..])
                                        } else {
                                            m.clone()
                                        }
                                    };
                                    v.push(format!("{}->{}:{}", short(a), short(b), id));
                                }
                                v.join(",")
                            };
                            tracing::info!(target = "arb_rs", "arb.opportunity path={} profit_bps={} net_bps={} hops={} rates=[{}] outs=[{}] fees=[{}] pools=[{}] edges=[{}] product={:.8}", path_str, profit_bps, net_bps, nlen, rates_str, outs_str, fees_str, pools_str, edges_str, rate_prod);
                        }
                        // Skip absurdly high raw profits (likely data issues)
                        if profit_bps > s.config.max_profit_bps {
                            record_rejected(
                                "rejected_too_high_profit",
                                &canon_labels,
                                Some(profit_bps),
                                Some(net_bps),
                                Some(&dexes),
                                Some(&hop_dexes),
                                Some(&hop_rates),
                                Some(&hop_outs),
                                Some(&hop_pool_ids),
                            );
                            rejected_too_high_profit += 1;
                            continue;
                        }
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
                    // Log detailed breakdown of cycles detected vs opportunities created
                    let total_rejected = rejected_too_short
                        + rejected_too_long
                        + rejected_not_simple
                        + rejected_stable_stable
                        + rejected_sol_stable_limit
                        + rejected_no_edge
                        + rejected_timeout
                        + rejected_unprofitable
                        + rejected_misaligned
                        + rejected_duplicate
                        + rejected_too_low_profit
                        + rejected_too_high_profit;
                    tracing::info!(
                        found = cycles_count,
                        opportunities = curr.len(),
                        rejected = total_rejected,
                        rejected_too_short,
                        rejected_too_long,
                        rejected_not_simple,
                        rejected_stable_stable,
                        rejected_sol_stable_limit,
                        rejected_no_edge,
                        rejected_timeout,
                        rejected_unprofitable,
                        rejected_misaligned,
                        rejected_duplicate,
                        rejected_too_low_profit,
                        rejected_too_high_profit,
                        "arb.detect.cycles"
                    );
                    // Near-miss, triangle fallback, and subthreshold passes are disabled
                    // Only the primary detector cycles above are used
                    #[allow(unused_mut, unused_variables)]
                    let mut near_pair: Option<(Opportunity, i64)> = None;
                    #[allow(unused_mut, unused_variables)]
                    let mut near_list: Vec<(Opportunity, i64)> = Vec::new();
                    // Skip all near-miss detection (was: if s.config.near_miss_enable)
                    if false {
                        let epsilon: f64 = if s.config.near_miss_epsilon.is_finite()
                            && s.config.near_miss_epsilon > 0.0
                        {
                            s.config.near_miss_epsilon
                        } else {
                            5e-4
                        }; // log-space slack window
                        let top_k: usize = s.config.debug_top_n.max(1).min(20);
                        let nm = detect_near_miss_cycles(&s.live_graph, epsilon, max_hops, top_k);
                        for nmcy in nm.into_iter() {
                            // Interpret nodes to labels and compute best-of-parallel rates metadata
                            if nmcy.nodes.len() < 3 || nmcy.nodes.len() > max_hops {
                                continue;
                            }
                            // Validate node indices are in bounds
                            let node_count_nm = s.live_graph.g.node_count();
                            if nmcy.nodes.iter().any(|&i| i >= node_count_nm) {
                                continue;
                            }
                            let labels: Vec<String> = nmcy
                                .nodes
                                .iter()
                                .map(|&i| s.live_graph.g[NodeIndex::new(i)].clone())
                                .collect();
                            // Apply pruning to near-miss cycles as well (symmetric SOL<->stable and stable<->stable)
                            {
                                let sol = "So11111111111111111111111111111111111111112";
                                let default_stables: std::collections::HashSet<&str> = [
                                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                                ]
                                .into_iter()
                                .collect();
                                let cfg_stables: std::collections::HashSet<String> = s
                                    .config
                                    .stable_mints
                                    .clone()
                                    .unwrap_or_default()
                                    .into_iter()
                                    .collect();
                                let is_stable = |m: &str| {
                                    if cfg_stables.is_empty() {
                                        default_stables.contains(m)
                                    } else {
                                        cfg_stables.contains(m)
                                    }
                                };
                                let mut has_stable_stable = false;
                                let mut sol_stable_hops: usize = 0;
                                for i in 0..labels.len() {
                                    let a = &labels[i];
                                    let b = &labels[(i + 1) % labels.len()];
                                    let a_st = is_stable(a);
                                    let b_st = is_stable(b);
                                    if a_st && b_st {
                                        has_stable_stable = true;
                                        break;
                                    }
                                    if (a == sol && b_st) || (b == sol && a_st) {
                                        sol_stable_hops += 1;
                                    }
                                }
                                if s.config.drop_stable_stable_hops && has_stable_stable {
                                    continue;
                                }
                                if let Some(limit) = s.config.max_sol_stable_hops {
                                    if sol_stable_hops > limit {
                                        continue;
                                    }
                                }
                            }
                            // Compute product and meta using exhaustive edge selection
                            let nlen = nmcy.nodes.len();
                            
                            let selection = select_best_edge_combination(
                                &s.live_graph,
                                &nmcy.nodes,
                                0.0, // min liquidity threshold for near-miss
                                s.config.max_edge_combinations,
                                s.config.top_k_edges_per_hop,
                            );

                            let selection = match selection {
                                Some(sel) => sel,
                                None => continue,
                            };

                            let rate_prod = selection.rate_product;
                            let log_rate_prod = selection.log_rate_product;
                            let min_edge_liquidity = selection.min_liquidity;

                            let mut link_edges_used: usize = 0;
                            let mut link_penalty_bps_total: i64 = 0;
                            let mut dexes_set: std::collections::HashSet<String> =
                                std::collections::HashSet::new();
                            let mut hop_dexes: Vec<String> = Vec::with_capacity(nlen);
                            let mut hop_rates: Vec<f64> = Vec::with_capacity(nlen);
                            let mut hop_pool_ids: Vec<String> = Vec::with_capacity(nlen);
                            let mut hop_fee_bps: Vec<i64> = Vec::with_capacity(nlen);
                            let mut hop_liq_disp: Vec<f64> = Vec::with_capacity(nlen);
                            let mut hop_outs: Vec<f64> = Vec::with_capacity(nlen);
                            let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> = None;
                            
                            let mut cur_out: f64 =
                                if labels.first().map(|m| m == &usdc).unwrap_or(false) {
                                    s.config.quote_size_usd.max(0.0)
                                } else {
                                    1.0
                                };

                            for (w, edge) in selection.edges.iter().enumerate() {
                                let u_idx = nmcy.nodes[w];
                                let v_idx = nmcy.nodes[(w + 1) % nlen];
                                
                                if edge.dex == "Link" {
                                    link_edges_used += 1;
                                    link_penalty_bps_total += edge.fee_bps;
                                }
                                if !edge.dex.is_empty() && edge.dex != "Link" {
                                    dexes_set.insert(edge.dex.clone());
                                }
                                
                                if bottleneck
                                    .as_ref()
                                    .map(|(_, _, _, r, _, _)| edge.rate_effective < *r)
                                    .unwrap_or(true)
                                {
                                    bottleneck = Some((
                                        u_idx,
                                        v_idx,
                                        edge.dex.clone(),
                                        edge.rate_effective,
                                        edge.liquidity,
                                        edge.fee_bps,
                                    ));
                                }
                                
                                hop_dexes.push(edge.dex.clone());
                                hop_rates.push(edge.rate_effective);
                                hop_pool_ids.push(edge.pool_id.clone());
                                hop_fee_bps.push(edge.fee_bps);
                                hop_liq_disp.push(edge.liquidity_display);
                                
                                let next_out = if cur_out.is_finite() {
                                    cur_out * edge.rate_effective
                                } else {
                                    0.0
                                };
                                hop_outs.push(next_out);
                                cur_out = next_out;
                            }
                            // Use precision-safe profit calculation
                            let profit_bps = compute_profit_bps(rate_prod, log_rate_prod);
                            if profit_bps >= min_bps {
                                continue;
                            } // near-miss only
                              // Build interpreted near-miss
                            let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                            dexes.sort();
                            let est_capacity = if min_edge_liquidity.is_finite() {
                                Some(min_edge_liquidity.max(0.0))
                            } else {
                                None
                            };
                            let now_ts = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let mut net_bps = profit_bps - link_penalty_bps_total.max(0);
                            if net_bps > 1_000_000 {
                                net_bps = 1_000_000;
                            }
                            if net_bps < -1_000_000 {
                                net_bps = -1_000_000;
                            }
                            let net_bps = {
                                let hops = nlen as i64;
                                let est_lam =
                                    s.config.est_priority_fee_per_hop_lamports.unwrap_or(0) as f64;
                                let total_est = (est_lam * hops as f64) / 1_000_000.0 * 10_000.0; // approx: 1 SOL baseline => bps rough
                                (net_bps as f64 - total_est).round() as i64
                            };
                            let bottleneck_edge =
                                bottleneck
                                    .as_ref()
                                    .and_then(|(ui, vi, dex, rate, liq, fee)| {
                                        // Validate indices are in bounds
                                        if *ui >= node_count_nm || *vi >= node_count_nm {
                                            return None;
                                        }
                                        let from = s.live_graph.g[NodeIndex::new(*ui)].clone();
                                        let to = s.live_graph.g[NodeIndex::new(*vi)].clone();
                                        Some(opportunities::BottleneckEdge {
                                            from,
                                            to,
                                            dex: dex.clone(),
                                            rate: *rate,
                                            liquidity: *liq,
                                            fee_bps: *fee,
                                        })
                                    });
                            // Capture last rate before moving hop_rates into the struct
                            let last_rate_opt = hop_rates.last().copied();
                            // Emit arb log for near-miss (BF slack)
                            {
                                let path_str = labels.join("->");
                                let rates_str = hop_rates
                                    .iter()
                                    .map(|v| format!("{:.6}", v))
                                    .collect::<Vec<_>>()
                                    .join(",");
                                let outs_str = hop_outs
                                    .iter()
                                    .map(|v| format!("{:.6}", v))
                                    .collect::<Vec<_>>()
                                    .join(",");
                                let fees_str = hop_fee_bps
                                    .iter()
                                    .map(|v| v.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",");
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
                                    if pid.is_empty() || dex_i == "Link" {
                                        continue;
                                    }
                                    if let (Some(&u), Some(&v)) =
                                        (s.live_graph.map.get(src), s.live_graph.map.get(dst))
                                    {
                                        let mut ok = false;
                                        for e in s.live_graph.g.edges_connecting(u, v) {
                                            if e.weight().pool_id == pid {
                                                ok = true;
                                                break;
                                            }
                                        }
                                        if !ok {
                                            aligned = false;
                                            break;
                                        }
                                    } else {
                                        aligned = false;
                                        break;
                                    }
                                }
                                if !aligned {
                                    tracing::warn!(
                                        "arb.near_miss.misaligned path={} pools=[{}]",
                                        labels.join("->"),
                                        hop_pool_ids.join(",")
                                    );
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
                            let req = if rate_prod > 0.0 {
                                (1.0 + (min_bps as f64) / 10_000.0) / rate_prod
                            } else {
                                0.0
                            };
                            near.bf_required_rate = if req.is_finite() { Some(req) } else { None };
                            if let Some(last_rate) = last_rate_opt {
                                let delta_bps = (((req.max(0.0) / last_rate.max(1e-12)) - 1.0)
                                    * 10_000.0)
                                    .floor() as i64;
                                near.bf_rate_delta_bps = Some(delta_bps);
                            }
                            let shortfall = (min_bps - profit_bps).max(0);
                            let near_for_list = near.clone();
                            match &mut near_pair {
                                Some((ref mut best, ref mut best_shortfall)) => {
                                    if shortfall < *best_shortfall {
                                        *best = near;
                                        *best_shortfall = shortfall;
                                    }
                                }
                                None => {
                                    near_pair = Some((near, shortfall));
                                }
                            }
                            // Collect for top-K list
                            near_list.push((near_for_list, shortfall));
                        }
                    }
                    // Skip DFS fallback for near-miss detection (disabled)
                    if false && curr.is_empty() && near_pair.is_none() {
                        let ncount = s.live_graph.g.node_count();
                        let max_starts = ncount.min(40);
                        let mut best_prod: f64 = 0.0;
                        let mut best_nodes: Vec<usize> = Vec::new();
                        for si in 0..max_starts {
                            let mut visited: std::collections::HashSet<usize> =
                                std::collections::HashSet::new();
                            let mut stack: Vec<usize> = Vec::new();
                            visited.insert(si);
                            stack.push(si);
                            // Use manual DFS stack to avoid recursion
                            // Each frame: (current_index, next_neighbor_iter_index, current_product, prev_pool_id)
                            let mut frames: Vec<(usize, usize, f64, Option<String>)> =
                                vec![(si, 0, 1.0, None)];
                            // Precompute adjacency as neighbor indices for performance
                            let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); ncount];
                            for ni in 0..ncount {
                                let u = NodeIndex::new(ni);
                                let mut outs: Vec<usize> = Vec::new();
                                for v in s
                                    .live_graph
                                    .g
                                    .neighbors_directed(u, petgraph::Direction::Outgoing)
                                {
                                    outs.push(v.index());
                                }
                                neighbors[ni] = outs;
                            }
                            // Helper to get best edge (rate, pool_id) between two nodes, excluding a previous pool id if provided
                            let best_edge_between_excluding =
                                |ui: usize,
                                 vi: usize,
                                 prev_pid: Option<&str>|
                                 -> (f64, Option<String>) {
                                    let u = NodeIndex::new(ui);
                                    let v = NodeIndex::new(vi);
                                    let mut best_rate = 0.0f64;
                                    let mut best_pid: Option<String> = None;
                                    for e in s.live_graph.g.edges_connecting(u, v) {
                                        let wt = e.weight();
                                        if wt.liquidity <= 0.0 {
                                            continue;
                                        }
                                        if let Some(pp) = prev_pid {
                                            if !pp.is_empty() && wt.pool_id == pp {
                                                continue;
                                            }
                                        }
                                        let r = wt.rate_effective.max(1e-12);
                                        if r > best_rate {
                                            best_rate = r;
                                            best_pid = Some(wt.pool_id.clone());
                                        }
                                    }
                                    (best_rate, best_pid)
                                };
                            while let Some((cur, ni, prod, prev_pid)) = frames.pop() {
                                if ni >= neighbors[cur].len() {
                                    visited.remove(&cur);
                                    let _ = stack.pop();
                                    continue;
                                }
                                let nxt = neighbors[cur][ni];
                                // put back frame with advanced neighbor index
                                frames.push((cur, ni + 1, prod, prev_pid.clone()));
                                let (rate, chosen_pid) =
                                    best_edge_between_excluding(cur, nxt, prev_pid.as_deref());
                                if rate <= 0.0 {
                                    continue;
                                }
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
                                if visited.contains(&nxt) {
                                    continue;
                                }
                                if stack.len() + 1 > max_hops {
                                    continue;
                                }
                                visited.insert(nxt);
                                stack.push(nxt);
                                // Carry forward the chosen pool id to prevent immediate reverse via the same pool
                                frames.push((nxt, 0, prod * rate, chosen_pid));
                            }
                        }
                        if best_prod > 0.0 && !best_nodes.is_empty() {
                            // Validate node indices are in bounds
                            if best_nodes.iter().any(|&i| i >= ncount) {
                                continue;
                            }
                            // Build opportunity-like near miss from best cycle
                            let labels: Vec<String> = best_nodes
                                .iter()
                                .map(|&i| s.live_graph.g[NodeIndex::new(i)].clone())
                                .collect();
                            // Canonicalize
                            let canon = |v: &Vec<String>| -> Vec<String> {
                                if v.is_empty() {
                                    return v.clone();
                                }
                                let n = v.len();
                                let mut best = None;
                                for i in 0..n {
                                    let mut r = Vec::with_capacity(n);
                                    for k in 0..n {
                                        r.push(v[(i + k) % n].clone());
                                    }
                                    let key = r.join("->");
                                    if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                                        best = Some((key, r));
                                    }
                                }
                                let mut vrev = v.clone();
                                vrev.reverse();
                                for i in 0..n {
                                    let mut r = Vec::with_capacity(n);
                                    for k in 0..n {
                                        r.push(vrev[(i + k) % n].clone());
                                    }
                                    let key = r.join("->");
                                    if best.as_ref().map(|(s, _)| &key < s).unwrap_or(true) {
                                        best = Some((key, r));
                                    }
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
                                ]
                                .into_iter()
                                .collect();
                                let cfg_stables: std::collections::HashSet<String> = s
                                    .config
                                    .stable_mints
                                    .clone()
                                    .unwrap_or_default()
                                    .into_iter()
                                    .collect();
                                let is_stable = |m: &str| {
                                    if cfg_stables.is_empty() {
                                        default_stables.contains(m)
                                    } else {
                                        cfg_stables.contains(m)
                                    }
                                };
                                let mut has_stable_stable = false;
                                let mut sol_stable_hops: usize = 0;
                                for i in 0..canon_labels.len() {
                                    let a = &canon_labels[i];
                                    let b = &canon_labels[(i + 1) % canon_labels.len()];
                                    let a_st = is_stable(a);
                                    let b_st = is_stable(b);
                                    if a_st && b_st {
                                        has_stable_stable = true;
                                        break;
                                    }
                                    if (a == sol && b_st) || (b == sol && a_st) {
                                        sol_stable_hops += 1;
                                    }
                                }
                                if s.config.drop_stable_stable_hops && has_stable_stable {
                                    continue;
                                }
                                if let Some(limit) = s.config.max_sol_stable_hops {
                                    if sol_stable_hops > limit {
                                        continue;
                                    }
                                }
                            }
                            // Dexes: recompute from edges along best_nodes
                            let mut dexes_set: std::collections::HashSet<String> =
                                std::collections::HashSet::new();
                            // Recompute meta along canonical order
                            let mut link_edges_used: usize = 0;
                            let mut link_penalty_bps_total: i64 = 0;
                            let mut min_edge_liquidity: f64 = f64::INFINITY;
                            let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> =
                                None;
                            let mut prod2 = 1.0f64;
                            let mut hop_dexes: Vec<String> = Vec::new();
                            let mut hop_rates: Vec<f64> = Vec::new();
                            let mut hop_pool_ids: Vec<String> = Vec::new();
                            let mut hop_fee_bps: Vec<i64> = Vec::new();
                            let mut hop_liq_disp: Vec<f64> = Vec::new();
                            let mut hop_outs: Vec<f64> = Vec::new();
                            let mut cur_out: f64 =
                                if labels.first().map(|m| m == &usdc).unwrap_or(false) {
                                    s.config.quote_size_usd.max(0.0)
                                } else {
                                    1.0
                                };
                            for w in 0..best_nodes.len() {
                                let u_idx = best_nodes[w];
                                let v_idx = best_nodes[(w + 1) % best_nodes.len()];
                                // Validate indices are in bounds
                                if u_idx >= ncount || v_idx >= ncount {
                                    prod2 = 0.0;
                                    break;
                                }
                                let u = NodeIndex::new(u_idx);
                                let v = NodeIndex::new(v_idx);
                                let mut best_rate: f64 = 0.0;
                                let mut best_meta: Option<(String, f64, i64, String, f64)> = None;
                                for e in s.live_graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 {
                                        continue;
                                    }
                                    let r = wt.rate_effective.max(1e-12);
                                    if r > best_rate {
                                        best_rate = r;
                                        best_meta = Some((
                                            wt.dex.clone(),
                                            wt.liquidity,
                                            wt.fee_bps,
                                            wt.pool_id.clone(),
                                            wt.liquidity_display,
                                        ));
                                    }
                                }
                                if best_rate <= 0.0 {
                                    prod2 = 0.0;
                                    break;
                                }
                                if let Some((dex, liq, fee, pid, liqd)) = best_meta.take() {
                                    if dex == "Link" {
                                        link_edges_used += 1;
                                        link_penalty_bps_total += fee;
                                    } else {
                                        dexes_set.insert(dex.clone());
                                    }
                                    min_edge_liquidity = min_edge_liquidity.min(liq);
                                    if bottleneck
                                        .as_ref()
                                        .map(|(_, _, _, r, _, _)| best_rate < *r)
                                        .unwrap_or(true)
                                    {
                                        bottleneck = Some((
                                            u.index(),
                                            v.index(),
                                            dex.clone(),
                                            best_rate,
                                            liq,
                                            fee,
                                        ));
                                    }
                                    hop_dexes.push(dex);
                                    hop_rates.push(best_rate);
                                    hop_pool_ids.push(pid);
                                    hop_fee_bps.push(fee);
                                    hop_liq_disp.push(liqd);
                                    let next_out = if cur_out.is_finite() {
                                        cur_out * best_rate
                                    } else {
                                        0.0
                                    };
                                    hop_outs.push(next_out);
                                    cur_out = next_out;
                                }
                                prod2 *= best_rate;
                            }
                            let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                            dexes.sort();
                            // Use precision-safe profit calculation
                            let log_prod2 = prod2.max(1e-12).ln();
                            let profit_bps = compute_profit_bps(prod2, log_prod2);
                            let net_bps = profit_bps - link_penalty_bps_total.max(0);
                            let est_capacity = if min_edge_liquidity.is_finite() {
                                Some(min_edge_liquidity.max(0.0))
                            } else {
                                None
                            };
                            let now_ts = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let bottleneck_edge =
                                bottleneck
                                    .as_ref()
                                    .and_then(|(ui, vi, dex, rate, liq, fee)| {
                                        // Validate indices are in bounds
                                        if *ui >= ncount || *vi >= ncount {
                                            return None;
                                        }
                                        let from = s.live_graph.g[NodeIndex::new(*ui)].clone();
                                        let to = s.live_graph.g[NodeIndex::new(*vi)].clone();
                                        Some(opportunities::BottleneckEdge {
                                            from,
                                            to,
                                            dex: dex.clone(),
                                            rate: *rate,
                                            liquidity: *liq,
                                            fee_bps: *fee,
                                        })
                                    });
                            // Only consider as near-miss if below threshold, at least 3 hops, and min liquidity > 0
                            if profit_bps < min_bps
                                && best_nodes.len() >= 3
                                && est_capacity.unwrap_or(0.0) > 0.0
                            {
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
                        // Skip triangle fallback search (disabled)
                        if false && near_pair.is_none() {
                            let ncount = s.live_graph.g.node_count();
                            let best_rate_between = |ui: usize, vi: usize| -> f64 {
                                let u = NodeIndex::new(ui);
                                let v = NodeIndex::new(vi);
                                let mut br = 0.0f64;
                                for e in s.live_graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 {
                                        continue;
                                    }
                                    br = br.max(wt.rate_effective.max(1e-12));
                                }
                                br
                            };
                            let mut best: Option<(usize, usize, usize, f64)> = None;
                            for a in 0..ncount {
                                for b in 0..ncount {
                                    if b == a {
                                        continue;
                                    }
                                    for c in 0..ncount {
                                        if c == a || c == b {
                                            continue;
                                        }
                                        let r1 = best_rate_between(a, b);
                                        let r2 = best_rate_between(b, c);
                                        let r3 = best_rate_between(c, a);
                                        if r1 > 0.0 && r2 > 0.0 && r3 > 0.0 {
                                            let prod = r1 * r2 * r3;
                                            if best
                                                .as_ref()
                                                .map(|(_, _, _, p)| prod > *p)
                                                .unwrap_or(true)
                                            {
                                                best = Some((a, b, c, prod));
                                            }
                                        }
                                    }
                                }
                            }
                            if let Some((a, b, c, prod)) = best {
                                // Validate node indices are in bounds
                                if a >= ncount || b >= ncount || c >= ncount {
                                    continue;
                                }
                                let nodes = vec![a, b, c];
                                let labels: Vec<String> = nodes
                                    .iter()
                                    .map(|&i| s.live_graph.g[NodeIndex::new(i)].clone())
                                    .collect();
                                // Prune triangle near-miss by SOL<->stable cap and stable<->stable
                                {
                                    let sol = "So11111111111111111111111111111111111111112";
                                    let default_stables: std::collections::HashSet<&str> = [
                                        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                                    ]
                                    .into_iter()
                                    .collect();
                                    let cfg_stables: std::collections::HashSet<String> = s
                                        .config
                                        .stable_mints
                                        .clone()
                                        .unwrap_or_default()
                                        .into_iter()
                                        .collect();
                                    let is_stable = |m: &str| {
                                        if cfg_stables.is_empty() {
                                            default_stables.contains(m)
                                        } else {
                                            cfg_stables.contains(m)
                                        }
                                    };
                                    let mut has_stable_stable = false;
                                    let mut sol_stable_hops: usize = 0;
                                    for i in 0..labels.len() {
                                        let a = &labels[i];
                                        let b = &labels[(i + 1) % labels.len()];
                                        let a_st = is_stable(a);
                                        let b_st = is_stable(b);
                                        if a_st && b_st {
                                            has_stable_stable = true;
                                            break;
                                        }
                                        if (a == sol && b_st) || (b == sol && a_st) {
                                            sol_stable_hops += 1;
                                        }
                                    }
                                    if s.config.drop_stable_stable_hops && has_stable_stable {
                                        continue;
                                    }
                                    if let Some(limit) = s.config.max_sol_stable_hops {
                                        if sol_stable_hops > limit {
                                            continue;
                                        }
                                    }
                                }
                                // Build meta across the triangle
                                let mut link_edges_used: usize = 0;
                                let mut link_penalty_bps_total: i64 = 0;
                                let mut min_edge_liquidity: f64 = f64::INFINITY;
                                let mut bottleneck: Option<(usize, usize, String, f64, f64, i64)> =
                                    None;
                                let mut dexes_set: std::collections::HashSet<String> =
                                    std::collections::HashSet::new();
                                let mut hop_dexes: Vec<String> = Vec::new();
                                let mut hop_rates: Vec<f64> = Vec::new();
                                for w in 0..3 {
                                    let u = NodeIndex::new(nodes[w]);
                                    let v = NodeIndex::new(nodes[(w + 1) % 3]);
                                    let mut best_rate: f64 = 0.0;
                                    let mut best_meta: Option<(String, f64, i64)> = None;
                                    for e in s.live_graph.g.edges_connecting(u, v) {
                                        let wt = e.weight();
                                        if wt.liquidity <= 0.0 {
                                            continue;
                                        }
                                        let r = wt.rate_effective.max(1e-12);
                                        if r > best_rate {
                                            best_rate = r;
                                            best_meta =
                                                Some((wt.dex.clone(), wt.liquidity, wt.fee_bps));
                                        }
                                    }
                                    if let Some((dex, liq, fee)) = best_meta.take() {
                                        if dex == "Link" {
                                            link_edges_used += 1;
                                            link_penalty_bps_total += fee;
                                        }
                                        if !dex.is_empty() && dex != "Link" {
                                            dexes_set.insert(dex.clone());
                                        }
                                        min_edge_liquidity = min_edge_liquidity.min(liq);
                                        if bottleneck
                                            .as_ref()
                                            .map(|(_, _, _, r, _, _)| best_rate < *r)
                                            .unwrap_or(true)
                                        {
                                            bottleneck = Some((
                                                u.index(),
                                                v.index(),
                                                dex.clone(),
                                                best_rate,
                                                liq,
                                                fee,
                                            ));
                                        }
                                        hop_dexes.push(dex);
                                        hop_rates.push(best_rate);
                                    }
                                }
                                let mut dexes: Vec<String> = dexes_set.into_iter().collect();
                                dexes.sort();
                                // Use precision-safe profit calculation
                                let log_prod = prod.max(1e-12).ln();
                                let profit_bps = compute_profit_bps(prod, log_prod);
                                let mut net_bps = profit_bps - link_penalty_bps_total.max(0);
                                if net_bps > 1_000_000 {
                                    net_bps = 1_000_000;
                                }
                                if net_bps < -1_000_000 {
                                    net_bps = -1_000_000;
                                }
                                let net_bps = {
                                    let hops = 3i64;
                                    let est_lam =
                                        s.config.est_priority_fee_per_hop_lamports.unwrap_or(0)
                                            as f64;
                                    let total_est =
                                        (est_lam * hops as f64) / 1_000_000.0 * 10_000.0;
                                    (net_bps as f64 - total_est).round() as i64
                                };
                                let shortfall = (min_bps - profit_bps).max(1); // ensure >0 so UI shows
                                let est_capacity = if min_edge_liquidity.is_finite() {
                                    Some(min_edge_liquidity.max(0.0))
                                } else {
                                    None
                                };
                                let now_ts = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                                    as u64;
                                let bottleneck_edge = bottleneck.as_ref().and_then(
                                    |(ui, vi, dex, rate, liq, fee)| {
                                        // Validate indices are in bounds
                                        if *ui >= ncount || *vi >= ncount {
                                            return None;
                                        }
                                        let from = s.live_graph.g[NodeIndex::new(*ui)].clone();
                                        let to = s.live_graph.g[NodeIndex::new(*vi)].clone();
                                        Some(opportunities::BottleneckEdge {
                                            from,
                                            to,
                                            dex: dex.clone(),
                                            rate: *rate,
                                            liquidity: *liq,
                                            fee_bps: *fee,
                                        })
                                    },
                                );
                                // Recompute best edges per hop to capture pool ids/fees for logging and output
                                let mut hop_pool_ids: Vec<String> = Vec::new();
                                let mut hop_fee_bps_vec: Vec<i64> = Vec::new();
                                for w in 0..3 {
                                    let u = NodeIndex::new(nodes[w]);
                                    let v = NodeIndex::new(nodes[(w + 1) % 3]);
                                    let mut best_rate: f64 = 0.0;
                                    let mut best_pid: Option<String> = None;
                                    let mut best_fee: i64 = 0;
                                    for e in s.live_graph.g.edges_connecting(u, v) {
                                        let wt = e.weight();
                                        let r = wt.rate_effective.max(1e-12);
                                        if r > best_rate {
                                            best_rate = r;
                                            best_pid = Some(wt.pool_id.clone());
                                            best_fee = wt.fee_bps;
                                        }
                                    }
                                    hop_pool_ids.push(best_pid.unwrap_or_default());
                                    hop_fee_bps_vec.push(best_fee);
                                }
                                // Check if this triangle meets the profit threshold - if so, add as opportunity, otherwise near miss
                                if profit_bps >= min_bps {
                                    // This triangle is profitable enough - add as real opportunity
                                    let path_str = labels.join("->");
                                    let key = keyify_opportunity(&labels, &dexes);
                                    let repeat_limit_hit = if s.config.max_detections_without_exec
                                        == 0
                                    {
                                        false
                                    } else {
                                        let executed = s.executed_keys.contains(&key);
                                        let count = s
                                            .detection_counts
                                            .get(&key)
                                            .map(|(c, _)| *c as usize)
                                            .unwrap_or(0);
                                        !executed && count >= s.config.max_detections_without_exec
                                    };
                                    if repeat_limit_hit {
                                        tracing::debug!(
                                            target = "arb_rs",
                                            path = %path_str,
                                            detections = s
                                                .detection_counts
                                                .get(&key)
                                                .map(|(c, _)| *c)
                                                .unwrap_or(0),
                                            "arb.opportunity.triangle suppressed after repeat detections"
                                        );
                                        continue;
                                    }
                                    let pools_str = hop_pool_ids.join(",");
                                    let fees_str = hop_fee_bps_vec
                                        .iter()
                                        .map(|v| v.to_string())
                                        .collect::<Vec<_>>()
                                        .join(",");
                                    // Build unit-annotated rates
                                    let mut hop_units: Vec<String> = Vec::new();
                                    for w in 0..3 {
                                        let a = &labels[w];
                                        let b = &labels[(w + 1) % 3];
                                        let r = hop_rates.get(w).copied().unwrap_or(0.0);
                                        let inv = if r > 0.0 { 1.0 / r } else { 0.0 };
                                        hop_units.push(format!(
                                            "{}->{}: {:.9} {} per 1 {} | inv {:.9} {} per 1 {}",
                                            a, b, r, b, a, inv, a, b
                                        ));
                                    }
                                    let rates_units = hop_units.join("; ");
                                    tracing::info!(target = "arb_rs", "arb.opportunity.triangle path={} profit_bps={} net_bps={} hops=3 rates_units={} pools=[{}] fees=[{}] product={:.8}", path_str, profit_bps, net_bps, rates_units, pools_str, fees_str, prod);
                                    // Skip if absurdly high raw profits (likely data issues)
                                    if profit_bps <= s.config.max_profit_bps {
                                        curr.push(Opportunity {
                                            path: labels,
                                            profit_bps,
                                            net_bps: Some(net_bps),
                                            est_profit_usd: 1.0,
                                            dexes,
                                            hop_dexes: Some(hop_dexes),
                                            hop_rates: Some(hop_rates),
                                            hop_outs: None,
                                            hop_pool_ids: Some(hop_pool_ids),
                                            hop_fee_bps: Some(hop_fee_bps_vec),
                                            hop_liquidity_display: None,
                                            hop_count: Some(3),
                                            rate_product: Some(prod),
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
                                            is_near_miss: None,
                                        });
                                    }
                                } else {
                                    // Below threshold - log as near miss
                                    let path_str = labels.join("->");
                                    let pools_str = hop_pool_ids.join(",");
                                    let fees_str = hop_fee_bps_vec
                                        .iter()
                                        .map(|v| v.to_string())
                                        .collect::<Vec<_>>()
                                        .join(",");
                                    // Build unit-annotated rates
                                    let mut hop_units: Vec<String> = Vec::new();
                                    for w in 0..3 {
                                        let a = &labels[w];
                                        let b = &labels[(w + 1) % 3];
                                        let r = hop_rates.get(w).copied().unwrap_or(0.0);
                                        let inv = if r > 0.0 { 1.0 / r } else { 0.0 };
                                        hop_units.push(format!(
                                            "{}->{}: {:.9} {} per 1 {} | inv {:.9} {} per 1 {}",
                                            a, b, r, b, a, inv, a, b
                                        ));
                                    }
                                    let rates_units = hop_units.join("; ");
                                    tracing::info!(target = "arb_rs", "arb.near_miss.triangle path={} profit_bps={} net_bps={} hops=3 rates_units={} pools=[{}] fees=[{}] product={:.8}", path_str, profit_bps, net_bps, rates_units, pools_str, fees_str, prod);
                                    let near = Opportunity {
                                        path: labels,
                                        profit_bps,
                                        net_bps: Some(net_bps),
                                        est_profit_usd: 1.0,
                                        dexes,
                                        hop_dexes: Some(hop_dexes),
                                        hop_rates: Some(hop_rates),
                                        hop_outs: None,
                                        hop_pool_ids: Some(hop_pool_ids),
                                        hop_fee_bps: Some(hop_fee_bps_vec),
                                        hop_liquidity_display: None,
                                        hop_count: Some(3),
                                        rate_product: Some(prod),
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
                                    near_pair = Some((near, shortfall));
                                }
                            }
                        }
                    }
                    // Skip debug subthreshold pass (disabled)
                    if false && s.config.debug_emit_subthreshold {
                        // Re-run a light pass over cycles to collect subthreshold candidates
                        let mut subs: Vec<(i64, String)> = Vec::new();
                        let dbg_cycles = detect_negative_cycles(&s.live_graph, max_hops);
                        for c in dbg_cycles.into_iter() {
                            if c.nodes.len() < 3 || c.nodes.len() > max_hops {
                                continue;
                            }
                            let mut uniq = std::collections::HashSet::new();
                            let mut simple = true;
                            for &v in c.nodes.iter() {
                                if !uniq.insert(v) {
                                    simple = false;
                                    break;
                                }
                            }
                            if !simple {
                                continue;
                            }
                            let mut prod: f64 = 1.0;
                            // Validate node indices are in bounds
                            let node_count_dbg = s.live_graph.g.node_count();
                            if c.nodes.iter().any(|&i| i >= node_count_dbg) {
                                continue;
                            }
                            let mut ok = true;
                            for w in 0..c.nodes.len() {
                                let u = NodeIndex::new(c.nodes[w]);
                                let v = NodeIndex::new(c.nodes[(w + 1) % c.nodes.len()]);
                                let mut br: f64 = 0.0;
                                for e in s.live_graph.g.edges_connecting(u, v) {
                                    let wt = e.weight();
                                    if wt.liquidity <= 0.0 {
                                        continue;
                                    }
                                    br = br.max(wt.rate_effective.max(1e-12));
                                }
                                if br <= 0.0 {
                                    ok = false;
                                    break;
                                }
                                prod *= br;
                            }
                            if !ok {
                                continue;
                            }
                            // Use precision-safe profit calculation
                            let log_prod = prod.max(1e-12).ln();
                            let bps = compute_profit_bps(prod, log_prod);
                            if bps < min_bps {
                                let labels: Vec<String> = c
                                    .nodes
                                    .iter()
                                    .map(|&i| s.live_graph.g[NodeIndex::new(i)].clone())
                                    .collect();
                                subs.push((bps, labels.join("->")));
                            }
                        }
                        subs.sort_by_key(|(bps, _)| *bps);
                        let n = s.config.debug_top_n.max(1).min(20);
                        if n > 0 {
                            // Acquire write lock separately to push events
                            let mut sw = loop_state.write().await;
                            for (i, (bps, path)) in subs.into_iter().rev().take(n).enumerate() {
                                sw.events.push(EventItem {
                                    ts: now_ms(),
                                    level: "info".into(),
                                    message: format!(
                                        "arb.debug.subthreshold#{} bps={} path={}",
                                        i + 1,
                                        bps,
                                        path
                                    ),
                                });
                            }
                            let len = sw.events.len();
                            if len > 200 {
                                sw.events.drain(0..(len - 200));
                            }
                        }
                    }
                    // Prune prior opps that touched changed edges/pools
                    let prev_opps = if changed_edge_ids.is_empty() {
                        s.opportunities.clone()
                    } else {
                        s.opportunities
                            .clone()
                            .into_iter()
                            .filter(|o| {
                                let ids: HashSet<String> = o
                                    .hop_pool_ids
                                    .as_ref()
                                    .map(|v| v.iter().cloned().collect())
                                    .unwrap_or_default();
                                ids.is_disjoint(&changed_edge_ids)
                            })
                            .collect::<Vec<_>>()
                    };
                    (curr, prev_opps, near_pair, near_list, rejected_samples)
                };
                // Adaptive stale handling based on opportunity_base_ttl_ms and detections stability
                let now_ms_val = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                // Bump detection counts for current opps and prune old entries
                {
                    let mut sw = loop_state.write().await;
                    let ttl = sw.config.detection_history_ttl_ms.max(1_000);
                    sw.detection_counts
                        .retain(|_, &mut (_, ts)| now_ms_val.saturating_sub(ts) <= ttl);

                    // Cap detection_counts to prevent unbounded memory growth
                    // If too many entries, evict oldest ones (by timestamp)
                    const MAX_DETECTION_ENTRIES: usize = 10_000;
                    if sw.detection_counts.len() > MAX_DETECTION_ENTRIES {
                        // Collect entries sorted by timestamp (oldest first)
                        let mut entries: Vec<(String, u64)> = sw.detection_counts
                            .iter()
                            .map(|(k, (_, ts))| (k.clone(), *ts))
                            .collect();
                        entries.sort_by_key(|(_, ts)| *ts);

                        // Remove oldest entries to get back under limit
                        let to_remove = sw.detection_counts.len() - MAX_DETECTION_ENTRIES;
                        for (key, _) in entries.into_iter().take(to_remove) {
                            sw.detection_counts.remove(&key);
                        }
                        tracing::debug!(
                            removed = to_remove,
                            remaining = sw.detection_counts.len(),
                            "arb.detection_counts: evicted oldest entries"
                        );
                    }

                    for m in opps.iter() {
                        let key = keyify_opportunity(&m.path, &m.dexes);
                        let (c, _) = sw.detection_counts.get(&key).copied().unwrap_or((0, 0));
                        sw.detection_counts
                            .insert(key, (c.saturating_add(1), now_ms_val));
                    }
                }
                let base_ttl = {
                    // Use dedicated config for opportunity base TTL (independent of loop timing)
                    let s = loop_state.read().await;
                    s.config.opportunity_base_ttl_ms
                };
                let mut merged: Vec<Opportunity> = Vec::new();
                // Always keep ALL current detections for monitoring purposes
                // The executor can filter based on detection count if needed
                for mut m in opps.into_iter() {
                    let s = loop_state.read().await;
                    let key = keyify_opportunity(&m.path, &m.dexes);
                    let executed = s.executed_keys.contains(&key);
                    let count = s.detection_counts.get(&key).map(|(c, _)| *c).unwrap_or(0) as usize;
                    let max_det = s.config.max_detections_without_exec;
                    // cap_disabled = true means show all opportunities
                    let cap_disabled = max_det == 0;
                    let under_cap = count < max_det;
                    
                    // Always include opportunity for display (executor can filter)
                    // Mark as over_cap if it exceeds detection limit
                    let over_cap = !cap_disabled && !executed && !under_cap;
                    
                    // Set timestamps for new detections
                    if m.first_seen_ms.is_none() {
                        m.first_seen_ms = Some(now_ms_val);
                    }
                    m.last_verified_ms = Some(now_ms_val);
                    if m.detected_ms.is_none() {
                        m.detected_ms = Some(now_ms_val);
                    }
                    // Store detection count for monitoring
                    m.detections = Some(count as u64);
                    
                    if over_cap {
                        // Log that opportunity hit cap but still include it for monitoring
                        tracing::debug!(
                            target = "arb_rs",
                            path = m.path.join("->"),
                            count,
                            max_det,
                            "arb.opportunity: over detection cap (still displayed)"
                        );
                    }
                    
                    merged.push(m);
                }
                // Retain prior ones if within adaptive TTL and not duplicated
                for mut o in prev.into_iter() {
                    let first = o
                        .first_seen_ms
                        .unwrap_or(o.detected_ms.unwrap_or(now_ms_val));
                    // Reuse history to determine detections and cap
                    let det = {
                        let s = loop_state.read().await;
                        let key = keyify_opportunity(&o.path, &o.dexes);
                        s.detection_counts
                            .get(&key)
                            .map(|(c, _)| *c)
                            .unwrap_or(o.detections.unwrap_or(1))
                    };
                    // NOTE: We no longer drop opportunities based on detection cap
                    // All opportunities are kept for monitoring; executor can filter
                    
                    // Apply opportunity TTL check
                    // Use first_seen_ms instead of last_verified_ms so opportunities persist
                    // even when they're not detected in subsequent cycles
                    let opp_ttl = {
                        let s = loop_state.read().await;
                        s.config.opportunity_ttl_ms
                    };
                    // Keep opportunities based on when they were first seen, not last verified
                    // This allows opportunities to persist even when not re-detected
                    let first_seen = o.first_seen_ms.unwrap_or(o.detected_ms.unwrap_or(first));
                    if now_ms_val.saturating_sub(first_seen) > opp_ttl {
                        continue; // Expired opportunity
                    }
                    // extend TTL up to 3× (1x base + up to +2x for stability)
                    let ttl = base_ttl.saturating_mul(1 + det.min(2));
                    let is_dup = merged
                        .iter()
                        .any(|x| x.path == o.path && x.dexes == o.dexes);
                    if !is_dup && now_ms_val.saturating_sub(first_seen) <= ttl {
                        if o.first_seen_ms.is_none() {
                            o.first_seen_ms = o.detected_ms;
                        }
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
                if merged.len() > 50 {
                    merged.truncate(50);
                }
                // Proper change detection: compare opportunities by path/dexes AND profit values
                let s_check = loop_state.read().await;
                let prev_opps = &s_check.opportunities;
                let changed = {
                    // Check if count changed
                    if prev_opps.len() != merged.len() {
                        true
                    } else {
                        // Check if any opportunity has changed (path/dexes match but profit differs)
                        let mut found_change = false;
                        for m in merged.iter() {
                            if let Some(prev_o) = prev_opps
                                .iter()
                                .find(|p| p.path == m.path && p.dexes == m.dexes)
                            {
                                // Check if profit_bps or net_bps changed
                                if prev_o.profit_bps != m.profit_bps || prev_o.net_bps != m.net_bps
                                {
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
                                if !merged
                                    .iter()
                                    .any(|m| m.path == prev_o.path && m.dexes == prev_o.dexes)
                                {
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
                if !rejected_samples.is_empty() {
                    s.rejected_opportunities = rejected_samples;
                    s.rejected_opportunities_updated_ms = now_ms_val;
                } else {
                    let last = s.rejected_opportunities_updated_ms;
                    if last > 0 && now_ms_val.saturating_sub(last) > REJECTED_DEBUG_TTL_MS {
                        s.rejected_opportunities.clear();
                        s.rejected_opportunities_updated_ms = 0;
                    }
                }
                // Near-miss processing disabled - skip all near_misses updates
                // Clear near_misses since detection is disabled
                let near_misses_changed = !s.near_misses.is_empty();
                if near_misses_changed {
                    s.near_misses.clear();
                    s.near_miss = None;
                    s.near_miss_shortfall_bps = None;
                }

                if changed {
                    // Update detections for re-detected opps
                    for m in merged.iter_mut() {
                        // If this opp also existed previously, bump detections and preserve first_seen_ms
                        if let Some(prev_o) = s
                            .opportunities
                            .iter()
                            .find(|p| p.path == m.path && p.dexes == m.dexes)
                        {
                            m.first_seen_ms = prev_o
                                .first_seen_ms
                                .or(prev_o.detected_ms)
                                .or(m.detected_ms);
                            m.detections = Some(prev_o.detections.unwrap_or(1) + 1);
                            m.last_verified_ms = Some(now_ms_val); // Update verification timestamp
                        } else {
                            m.first_seen_ms = m.first_seen_ms.or(m.detected_ms);
                            m.last_verified_ms = m.last_verified_ms.or(m.detected_ms);
                            m.detections = Some(1);
                        }
                    }
                    s.opportunities = merged;

                    // Update metrics
                    s.metrics.opportunities_active = s.opportunities.len() as u64;
                    s.metrics.max_profit_bps = s
                        .opportunities
                        .iter()
                        .map(|o| o.profit_bps)
                        .max()
                        .unwrap_or(0) as i64;
                    let total: i64 = s.opportunities.iter().map(|o| o.profit_bps).sum();
                    s.metrics.avg_profit_bps = if s.opportunities.is_empty() {
                        0.0
                    } else {
                        total as f64 / s.opportunities.len() as f64
                    };
                    s.metrics.detection_cycles_total += 1;
                    // Increment detector outcomes and cumulative opportunities
                    if s.opportunities.is_empty() {
                        s.metrics.detection_misses_total =
                            s.metrics.detection_misses_total.saturating_add(1);
                    } else {
                        s.metrics.detection_hits_total =
                            s.metrics.detection_hits_total.saturating_add(1);
                    }
                    s.metrics.opportunities_detected_total = s
                        .metrics
                        .opportunities_detected_total
                        .saturating_add(s.opportunities.len() as u64);
                    if s.opportunities.is_empty() {
                        s.metrics.detection_misses_total =
                            s.metrics.detection_misses_total.saturating_add(1);
                    } else {
                        s.metrics.detection_hits_total =
                            s.metrics.detection_hits_total.saturating_add(1);
                    }
                    s.metrics.detection_duration_ms = loop_start.elapsed().as_millis() as u64;
                    // Calculate detection staleness (time since snapshot was created)
                    let snap_created = s.metrics.snapshot_created_ms;
                    s.metrics.detection_staleness_ms = if snap_created > 0 {
                        now_ms().saturating_sub(snap_created)
                    } else {
                        0
                    };
                    let det_ms = s.metrics.detection_duration_ms;
                    let active = s.metrics.opportunities_active;
                    if let Some(top) = s.opportunities.iter().max_by_key(|o| o.profit_bps) {
                        let top_bps = top.profit_bps;
                        let path = top.path.join("->");
                        // Compute graph age and latency metrics for observability
                        let last_ts = s.last_graph_ts.load(Ordering::Acquire);
                        let graph_age_ms = if last_ts > 0 {
                            now_ms().saturating_sub(last_ts)
                        } else {
                            0
                        };
                        let dtd = s.metrics.diff_to_detect_ms;
                        s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.detect.done ms={} opps={} top_bps={} path={} graph_age_ms={} diff_to_detect_ms={}", det_ms, active, top_bps, path, graph_age_ms, dtd) });
                        tracing::info!(det_ms, opps = active, top_bps, path = %path, graph_age_ms, diff_to_detect_ms = dtd, "arb.detect.done");
                    } else {
                        let last_ts = s.last_graph_ts.load(Ordering::Acquire);
                        let graph_age_ms = if last_ts > 0 {
                            now_ms().saturating_sub(last_ts)
                        } else {
                            0
                        };
                        let dtd = s.metrics.diff_to_detect_ms;
                        s.events.push(EventItem {
                            ts: now_ms(),
                            level: "info".into(),
                            message: format!(
                                "arb.detect.done ms={} opps=0 graph_age_ms={} diff_to_detect_ms={}",
                                det_ms, graph_age_ms, dtd
                            ),
                        });
                        tracing::info!(
                            det_ms,
                            opps = 0u64,
                            graph_age_ms,
                            diff_to_detect_ms = dtd,
                            "arb.detect.done"
                        );
                        // Also emit a concise near-miss summary if available when no opportunities detected
                        if let (Some(nm), Some(shortfall)) =
                            (s.near_miss.clone(), s.near_miss_shortfall_bps)
                        {
                            let path = nm.path.join("->");
                            let hops = nm.hop_count.unwrap_or(nm.path.len());
                            let net_bps = nm.net_bps.unwrap_or(nm.profit_bps);
                            let dexes = nm.dexes.join(",");
                            tracing::info!(shortfall_bps = shortfall, net_bps, hops, dexes = %dexes, path = %path, "arb.near_miss.summary");
                            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.near_miss.summary shortfall_bps={} net_bps={} hops={} path={}", shortfall, net_bps, hops, path) });
                            let len = s.events.len();
                            if len > 200 {
                                s.events.drain(0..(len - 200));
                            }
                        } else if s.config.debug_near_miss_failures {
                            // Emit diagnostics when no near-miss found
                            let hops = s.config.max_hops;
                            let epsilon = s.config.near_miss_epsilon;
                            let nodes = s.metrics.graph_nodes;
                            let edges = s.metrics.graph_edges;
                            let min_bps_cfg = s.config.min_profit_bps;
                            tracing::info!(
                                hops,
                                epsilon,
                                nodes,
                                edges,
                                min_bps = min_bps_cfg,
                                "arb.near_miss.none"
                            );
                            s.events.push(EventItem { ts: now_ms(), level: "info".into(), message: format!("arb.near_miss.none hops={} eps={} nodes={} edges={} min_bps={}", hops, epsilon, nodes, edges, min_bps_cfg) });
                            let len = s.events.len();
                            if len > 200 {
                                s.events.drain(0..(len - 200));
                            }
                        }
                    }
                    let len = s.events.len();
                    if len > 200 {
                        s.events.drain(0..(len - 200));
                    }
                }
                // Drop the write lock before attempting to acquire another one for version commit
                drop(s);

                // Version should already be committed before detection, but check defensively
                // This handles edge cases where version_to_commit wasn't cleared properly
                if let Some(v_commit) = version_to_commit {
                    let s = loop_state.write().await;
                    let current_v = s.last_graph_version.load(Ordering::Acquire);
                    if v_commit > current_v {
                        tracing::warn!(
                            old_version = current_v,
                            new_version = v_commit,
                            "arb.graph.version: late_commit (should have been committed earlier)"
                        );
                        s.last_graph_version.store(v_commit, Ordering::Release);
                        // Notify any waiting ACK handlers
                        s.version_changed.notify_waiters();
                    } else {
                        tracing::debug!(
                            attempt = v_commit,
                            current_version = current_v,
                            "arb.graph.version: already_current"
                        );
                    }
                    if let Some(ts_commit) = ts_to_commit {
                        s.last_graph_ts.store(ts_commit, Ordering::Release);
                    }
                    // Note: version_to_commit and ts_to_commit are not cleared here
                    // as they will be reassigned at the start of the next loop iteration
                } else {
                    // Check if there's a pending version that wasn't captured (shouldn't happen, but defensive check)
                    let pending_check = loop_state
                        .read()
                        .await
                        .pending_graph_version
                        .load(Ordering::Acquire);
                    if pending_check != u64::MAX {
                        tracing::warn!(
                            pending_version = pending_check,
                            "arb.graph.version: pending_version_not_captured"
                        );
                    }
                }

                // RESYNC LOGIC: Detect if we're falling behind and need to request a snapshot
                {
                    let s = loop_state.read().await;
                    let last_version = s.last_graph_version.load(Ordering::Acquire);
                    let pending_version = s.pending_graph_version.load(Ordering::Acquire);
                    let last_resync = s.last_resync_attempt_ms.load(Ordering::Acquire);
                    let now = now_ms();

                    // Track empty cycles using version comparison (double-buffer pattern)
                    // An empty cycle means no new updates since last snapshot
                    let live_v = s.live_graph_version.load(Ordering::Acquire);
                    let snap_v = s.detection_snapshot_version.load(Ordering::Acquire);
                    let empty_cycle = live_v == snap_v && pending_version == u64::MAX;

                    if empty_cycle {
                        let prev_empty = s.consecutive_empty_cycles.fetch_add(1, Ordering::Relaxed);
                        let empty_count = prev_empty + 1;

                        tracing::info!(consecutive_empty = empty_count, "arb.loop.empty_cycle");

                        // After 2 empty cycles, check if we're out of sync (but not more often than every 5 seconds)
                        // With 2s heartbeat + 2 cycles = ~4-5s to detect and recover from desync
                        if prev_empty >= 1 && now.saturating_sub(last_resync) > 5_000 {
                            drop(s);

                            // Query backend for current version
                            let api_base = std::env::var("BACKEND_API_BASE")
                                .unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                            let version_url =
                                format!("{}/arb/graph/version", api_base.trim_end_matches('/'));

                            if let Ok(Ok(resp)) = tokio::time::timeout(
                                std::time::Duration::from_millis(500),
                                reqwest::Client::new().get(&version_url).send(),
                            )
                            .await
                            {
                                if let Ok(json) = resp.json::<serde_json::Value>().await {
                                    if let Some(backend_version) = json["version"].as_u64() {
                                        let version_gap =
                                            backend_version.saturating_sub(last_version);

                                        tracing::info!(
                                            last_version,
                                            backend_version,
                                            gap = version_gap,
                                            "arb.resync: version check"
                                        );

                                        // If we're ANY versions behind, request resync immediately (lowered from 2)
                                        if version_gap >= 1 {
                                            tracing::warn!(
                                                last_version,
                                                backend_version,
                                                gap = version_gap,
                                                "arb.resync: detected version lag, requesting snapshot"
                                            );

                                            // Update last resync attempt time
                                            loop_state
                                                .read()
                                                .await
                                                .last_resync_attempt_ms
                                                .store(now, Ordering::Release);

                                            // Request snapshot from backend
                                            let snapshot_url = format!(
                                                "{}/arb/graph/current",
                                                api_base.trim_end_matches('/')
                                            );
                                            if let Ok(Ok(snap_resp)) = tokio::time::timeout(
                                                std::time::Duration::from_millis(5000),
                                                reqwest::Client::new().get(&snapshot_url).send(),
                                            )
                                            .await
                                            {
                                                if let Ok(snap_json) =
                                                    snap_resp.json::<GraphSnapshotReq>().await
                                                {
                                                    // Process snapshot
                                                    let result = handle_graph_snapshot(
                                                        loop_state.clone(),
                                                        snap_json,
                                                    )
                                                    .await;
                                                    tracing::info!(result = ?result, "arb.resync: snapshot applied");

                                                    // Reset empty cycle counter after successful resync
                                                    loop_state
                                                        .read()
                                                        .await
                                                        .consecutive_empty_cycles
                                                        .store(0, Ordering::Relaxed);
                                                } else {
                                                    tracing::warn!("arb.resync: failed to parse snapshot response");
                                                }
                                            } else {
                                                tracing::warn!(
                                                    "arb.resync: snapshot request timeout or error"
                                                );
                                            }
                                        } else {
                                            tracing::info!(
                                                last_version,
                                                backend_version,
                                                "arb.resync: versions in sync"
                                            );
                                        }
                                    }
                                }
                            }

                            // Reset counter after check
                            loop_state
                                .read()
                                .await
                                .consecutive_empty_cycles
                                .store(0, Ordering::Relaxed);
                        }
                    } else {
                        // Reset counter when we get updates
                        s.consecutive_empty_cycles.store(0, Ordering::Relaxed);
                    }
                }

                // Update last_detection_ms metric for monitoring only
                {
                    let mut s = loop_state.write().await;
                    s.metrics.last_detection_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                }
                let detect_ms = detect_start.elapsed().as_millis() as u128;
                let work_ms = iter_start.elapsed().as_millis() as u128;
                tracing::info!(diff_apply_ms, detect_ms, work_ms, "arb.loop.work.timing");

                // Notify backend that detection is complete - this triggers flush of pending updates
                if detector_ack_enabled() {
                    let api_base = std::env::var("BACKEND_API_BASE")
                        .unwrap_or_else(|_| "http://127.0.0.1:3001/api".into());
                    let current_version = {
                        let s = loop_state.read().await;
                        s.last_graph_version.load(Ordering::Acquire)
                    };
                    let completed_ms = work_ms as u64;
                    
                    // Fire and forget - don't block the loop on backend notification
                    let api_base_clone = api_base.clone();
                    tokio::spawn(async move {
                        if let Err(e) = notify_backend_detect_complete(&api_base_clone, current_version, completed_ms).await {
                            tracing::debug!(
                                error = %e,
                                version = current_version,
                                "arb.detect.complete: notification failed"
                            );
                        } else {
                            tracing::debug!(
                                version = current_version,
                                completed_ms,
                                "arb.detect.complete: notified backend"
                            );
                        }
                    });
                }
            }

            // Event-driven wait: wake on notify or after periodic heartbeat
            // Reduced heartbeat timeout to improve responsiveness
            let wake = {
                let s = loop_state.read().await;
                s.wake.clone()
            };
            let heartbeat_ms = 500; // 500ms heartbeat - faster response to updates
            let wait_start = Instant::now();
            let timeout = std::time::Duration::from_millis(heartbeat_ms);
            tokio::select! {
                _ = wake.notified() => {
                    tracing::info!("arb.loop.woken");
                },
                _ = tokio::time::sleep(timeout) => {
                    // Periodic wake to check for desync
                    tracing::info!("arb.loop.heartbeat");
                },
            }
            let wait_ms = wait_start.elapsed().as_millis() as u128;
            let iter_end = Instant::now();
            let total_ms = iter_end.duration_since(iter_start).as_millis() as u128;
            tracing::info!(iter_ms = total_ms, wait_ms, "arb.loop.end");
        }
    });

    let app = Router::new()
        .route(
            "/health",
            get(|| async { Json(HealthResp { status: "ok" }) }),
        )
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
    let ip: std::net::IpAddr = host
        .parse()
        .unwrap_or_else(|_| std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));
    let port: u16 = std::env::var("ARB_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4010);
    let addr: SocketAddr = std::net::SocketAddr::new(ip, port);
    tracing::info!(?addr, "starting arb-rs server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(ring.clone()))
        .await?;
    Ok(())
}

fn detector_ack_enabled() -> bool {
    static FLAG: Lazy<bool> = Lazy::new(|| {
        std::env::var("BACKEND_DETECT_ACK")
            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(true)
    });
    *FLAG
}

fn detector_ack_timeout() -> Duration {
    static TIMEOUT: Lazy<Duration> = Lazy::new(|| {
        let ms = std::env::var("BACKEND_DETECT_ACK_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.max(100).min(5_000))
            .unwrap_or(1_500);
        Duration::from_millis(ms)
    });
    *TIMEOUT
}

// Detection completion notification - triggers backend to flush pending graph updates
// This implements detect-driven push: updates accumulate during detection, then flush when ready
async fn notify_backend_detect_complete(
    api_base: &str,
    version: u64,
    completed_ms: u64,
) -> Result<(), reqwest::Error> {
    let url = format!("{}/arb/detect/complete", api_base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let timeout = detector_ack_timeout();
    
    let body = serde_json::json!({
        "graphVersion": version,
        "completedMs": completed_ms,
    });
    
    client
        .post(&url)
        .timeout(timeout)
        .json(&body)
        .send()
        .await?;
    
    Ok(())
}

async fn shutdown_signal(ring: Arc<Mutex<VecDeque<String>>>) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm =
            signal(SignalKind::terminate()).expect("failed to install signal handler");
        sigterm.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! { _ = ctrl_c => {}, _ = terminate => {}, };
    tracing::info!("shutdown requested");
    // Attempt to write last 2000 log lines to logs/session.json
    if let Err(e) = write_session_json(&ring).await {
        let _ = e;
    }
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
    let near_items = if s.near_misses.is_empty() {
        None
    } else {
        Some(s.near_misses.clone())
    };
    // Build summary even if empty
    let count = items.len();
    let max_profit_bps = items.iter().map(|o| o.profit_bps).max().unwrap_or(0);
    let avg_profit_bps = if count == 0 {
        0.0
    } else {
        items.iter().map(|o| o.profit_bps as f64).sum::<f64>() / (count as f64)
    };
    let avg_net_bps = if count == 0 {
        0.0
    } else {
        items
            .iter()
            .map(|o| o.net_bps.unwrap_or(o.profit_bps) as f64)
            .sum::<f64>()
            / (count as f64)
    };
    let avg_hop_count = if count == 0 {
        0.0
    } else {
        items
            .iter()
            .map(|o| o.hop_count.unwrap_or(o.path.len()) as f64)
            .sum::<f64>()
            / (count as f64)
    };
    let avg_link_edges_used = if count == 0 {
        0.0
    } else {
        items
            .iter()
            .map(|o| o.link_edges_used.unwrap_or(0) as f64)
            .sum::<f64>()
            / (count as f64)
    };
    let min_edge_liquidity_vals: Vec<f64> = items
        .iter()
        .map(|o| o.min_edge_liquidity.unwrap_or(0.0))
        .collect();
    let min_edge_liquidity_avg = if count == 0 {
        0.0
    } else {
        min_edge_liquidity_vals.iter().sum::<f64>() / (count as f64)
    };
    let min_edge_liquidity_min = min_edge_liquidity_vals
        .iter()
        .cloned()
        .fold(f64::INFINITY, f64::min);
    let min_edge_liquidity_min = if min_edge_liquidity_min.is_infinite() {
        0.0
    } else {
        min_edge_liquidity_min
    };
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
        near_misses: if s.near_misses.is_empty() {
            None
        } else {
            Some(s.near_misses.clone())
        },
        rejected_opportunities: if s.rejected_opportunities.is_empty() {
            None
        } else {
            Some(s.rejected_opportunities.clone())
        },
    };
    Json(OpportunitiesResponse {
        items,
        near_items,
        summary: Some(summary),
    })
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct StartReqNode {
    id: String,
}
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
    native_mint_a: Option<String>,
    native_mint_b: Option<String>,
    native_decimals_a: Option<i64>,
    native_decimals_b: Option<i64>,
    native_account_a: Option<String>,
    native_account_b: Option<String>,
    native_reserve_a_raw: Option<String>,
    native_reserve_b_raw: Option<String>,
}
#[derive(Deserialize, Clone)]
struct StartReqGraph {
    version: Option<u64>,
    timestamp: Option<u64>,
    nodes: Vec<StartReqNode>,
    edges: Vec<StartReqEdge>,
}

#[derive(Deserialize)]
struct StartReq {
    graph: Option<StartReqGraph>,
    enable: Option<bool>,
}

#[derive(Deserialize)]
struct GraphSnapshotReq {
    graph: StartReqGraph,
}

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
    native_mint_a: Option<String>,
    native_mint_b: Option<String>,
    native_decimals_a: Option<i64>,
    native_decimals_b: Option<i64>,
    native_account_a: Option<String>,
    native_account_b: Option<String>,
    native_reserve_a_raw: Option<String>,
    native_reserve_b_raw: Option<String>,
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

async fn arb_graph_snapshot(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<GraphSnapshotReq>,
) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) {
        return Json(serde_json::json!({"error":"unauthorized"}));
    }
    Json(handle_graph_snapshot(state, req).await)
}

// Centralized price conversion: apply fee to price_a_per_b.
// price_a_per_b represents "target-per-1-source" (B/A = how many B for 1 A).
// This is already the rate_effective format we need - NO inversion required.
#[inline]
fn edge_rate_effective_local(px_opt: Option<f64>, fee_bps_opt: Option<i64>) -> (f64, f64) {
    let fee_bps: f64 = (fee_bps_opt.unwrap_or(0)) as f64;
    let px: f64 = px_opt.unwrap_or(0.0);
    if !(px.is_finite() && px > 0.0) {
        return (0.0, 0.0);
    }
    // price_a_per_b is "target-per-1-source" (B/A), which is exactly what rate_effective needs.
    // For edge A->B: rate_effective = how many B you get for 1 A = price_a_per_b (no inversion)
    let base: f64 = px;
    let eff: f64 = base * (1.0 - fee_bps / 10_000.0).max(0.0);
    (base, eff)
}

fn canonical_edge_id(raw: Option<&str>, source: &str, target: &str, dex: &str) -> String {
    if let Some(pid) = raw {
        if !pid.is_empty() {
            return pid.to_string();
        }
    }
    format!("{}->{}-{}", source, target, dex)
}

fn insert_bidirectional_edges(
    graph: &mut ArbGraph,
    dex: &str,
    source: &str,
    target: &str,
    pool_id: &str,
    fee_bps: i64,
    liquidity: f64,
    liquidity_display: f64,
    price_a_per_b: f64,
    native_mint_a: Option<String>,
    native_mint_b: Option<String>,
    native_decimals_a: Option<i64>,
    native_decimals_b: Option<i64>,
    native_account_a: Option<String>,
    native_account_b: Option<String>,
    native_reserve_a_raw: Option<String>,
    native_reserve_b_raw: Option<String>,
) {
    if !(price_a_per_b.is_finite() && price_a_per_b > 0.0) {
        return;
    }
    let native_mint_a_rev = native_mint_a.clone();
    let native_mint_b_rev = native_mint_b.clone();
    let native_decimals_a_rev = native_decimals_a.clone();
    let native_decimals_b_rev = native_decimals_b.clone();
    let native_account_a_rev = native_account_a.clone();
    let native_account_b_rev = native_account_b.clone();
    let native_reserve_a_rev = native_reserve_a_raw.clone();
    let native_reserve_b_rev = native_reserve_b_raw.clone();
    let (_, rate_forward) = edge_rate_effective_local(Some(price_a_per_b), Some(fee_bps));
    graph.upsert_edge(
        dex,
        source,
        target,
        EdgeData {
            rate_effective: rate_forward,
            fee_bps,
            liquidity,
            dex: dex.to_string(),
            pool_id: pool_id.to_string(),
            liquidity_display,
            native_mint_a,
            native_mint_b,
            native_decimals_a,
            native_decimals_b,
            native_account_a,
            native_account_b,
            native_reserve_a_raw,
            native_reserve_b_raw,
        },
    );

    let px_rev = 1.0 / price_a_per_b;
    if !(px_rev.is_finite() && px_rev > 0.0) {
        return;
    }
    let (_, rate_reverse) = edge_rate_effective_local(Some(px_rev), Some(fee_bps));
    let rev_pool_id = if pool_id.is_empty() {
        format!("{target}->{source}-{dex}#rev")
    } else {
        format!("{pool_id}#rev")
    };
    graph.upsert_edge(
        dex,
        target,
        source,
        EdgeData {
            rate_effective: rate_reverse,
            fee_bps,
            liquidity,
            dex: dex.to_string(),
            pool_id: rev_pool_id,
            liquidity_display,
            native_mint_a: native_mint_a_rev,
            native_mint_b: native_mint_b_rev,
            native_decimals_a: native_decimals_a_rev,
            native_decimals_b: native_decimals_b_rev,
            native_account_a: native_account_a_rev,
            native_account_b: native_account_b_rev,
            native_reserve_a_raw: native_reserve_a_rev,
            native_reserve_b_raw: native_reserve_b_rev,
        },
    );
}

async fn handle_graph_snapshot(
    state: Arc<RwLock<AppState>>,
    req: GraphSnapshotReq,
) -> serde_json::Value {
    let mut s = state.write().await;
    let g = req.graph;
    tracing::info!(version = ?g.version, ts = ?g.timestamp, nodes = g.nodes.len(), edges = g.edges.len(), "arb.graph.snapshot: received");
    // Version guard: ignore stale or equal snapshots (atomic read - no lock needed!)
    let current_version = s.last_graph_version.load(Ordering::Acquire);
    if let Some(v) = g.version {
        if v <= current_version {
            s.metrics.graph_updates_skipped = s.metrics.graph_updates_skipped.saturating_add(1);
            return serde_json::json!({"ok": true, "ignored": true, "reason": "stale_version"});
        }
    }
    let mut new_graph = ArbGraph::new();
    // Build a lightweight USD reference from the incoming snapshot edges to correct 10^k magnitude slips
    use std::collections::HashMap;
    let sol_mint: &str = "So11111111111111111111111111111111111111112";
    let usdc_mint: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let usd1_mint: &str = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
    let mut px_map: HashMap<(String, String), f64> = HashMap::new();
    for e in g.edges.iter() {
        if let Some(px) = e.price_a_per_b {
            if px.is_finite() && px > 0.0 {
                px_map.insert((e.source.clone(), e.target.clone()), px);
            }
        }
    }
    let sol_usd: Option<f64> = {
        if let Some(px) = px_map.get(&(usdc_mint.to_string(), sol_mint.to_string())) {
            if *px > 0.0 {
                Some(*px)
            } else {
                None
            }
        } else if let Some(px) = px_map.get(&(sol_mint.to_string(), usdc_mint.to_string())) {
            if *px > 0.0 {
                Some(1.0 / *px)
            } else {
                None
            }
        } else {
            None
        }
    };
    let get_usd_from_snapshot = |mint: &str| -> Option<f64> {
        if mint == usdc_mint || mint == usd1_mint {
            return Some(1.0);
        }
        if mint == sol_mint {
            return sol_usd;
        }
        if let Some(px) = px_map.get(&(mint.to_string(), usdc_mint.to_string())) {
            if *px > 0.0 {
                return Some(1.0 / *px);
            }
        }
        if let Some(px) = px_map.get(&(usdc_mint.to_string(), mint.to_string())) {
            if *px > 0.0 {
                return Some(*px);
            }
        }
        if let Some(su) = sol_usd {
            if let Some(px) = px_map.get(&(mint.to_string(), sol_mint.to_string())) {
                if *px > 0.0 {
                    return Some(su / *px);
                }
            }
            if let Some(px) = px_map.get(&(sol_mint.to_string(), mint.to_string())) {
                if *px > 0.0 {
                    return Some(su * *px);
                }
            }
        }
        None
    };
    let adjust_magnitude = |a: &str, b: &str, px_in: f64| -> f64 {
        let pa = get_usd_from_snapshot(a);
        let pb = get_usd_from_snapshot(b);
        if let (Some(pa), Some(pb)) = (pa, pb) {
            let refv = pb / pa;
            let mut best = px_in;
            let mut best_dev = f64::INFINITY;
            let mut best_k = 0i32;
            for k in -8..=8 {
                let cand = px_in * 10f64.powi(k);
                if !(cand.is_finite() && cand > 0.0) {
                    continue;
                }
                let dev = (cand / refv).max(refv / cand);
                if dev + 1e-12 < best_dev {
                    best_dev = dev;
                    best = cand;
                    best_k = k;
                }
            }
            if best_k != 0 {
                tracing::debug!(
                    mint_a = a,
                    mint_b = b,
                    px_in,
                    px_out = best,
                    k = best_k,
                    refv,
                    "arb.magnitude.calibrated.snapshot"
                );
            }
            best
        } else {
            px_in
        }
    };
    for e in g.edges.into_iter() {
        let dex = e.dex.unwrap_or_else(|| "Unknown".to_string());
        let fee = e.fee_bps.unwrap_or(0);
        let liq = e.liquidity.unwrap_or(0.0);
        let liq_disp = e.liquidity_display.unwrap_or(0.0);
        let mut px = e.price_a_per_b.unwrap_or(0.0);
        if px.is_finite() && px > 0.0 {
            px = adjust_magnitude(&e.source, &e.target, px);
        }
        let pool_id = canonical_edge_id(e.pool_id.as_deref(), &e.source, &e.target, &dex);
        insert_bidirectional_edges(
            &mut new_graph,
            &dex,
            &e.source,
            &e.target,
            &pool_id,
            fee,
            liq,
            liq_disp,
            px,
            e.native_mint_a.clone(),
            e.native_mint_b.clone(),
            e.native_decimals_a,
            e.native_decimals_b,
            e.native_account_a.clone(),
            e.native_account_b.clone(),
            e.native_reserve_a_raw.clone(),
            e.native_reserve_b_raw.clone(),
        );
    }
    s.live_graph = new_graph;
    s.metrics.graph_nodes = s.live_graph.g.node_count() as u64;
    s.metrics.graph_edges = s.live_graph.g.edge_count() as u64;
    if let Some(v) = g.version {
        s.last_graph_version.store(v, Ordering::Release);
        s.version_changed.notify_waiters();
    }
    if let Some(ts) = g.timestamp {
        s.last_graph_ts.store(ts, Ordering::Release);
    }
    // Record time of receipt for diff_to_detect tracking
    s.metrics.last_graph_push_rx_ms = now_ms();

    let nodes = s.metrics.graph_nodes;
    let edges = s.metrics.graph_edges;
    s.events.push(EventItem {
        ts: now_ms(),
        level: "info".into(),
        message: format!(
            "arb.graph.snapshot: accepted nodes={} edges={}",
            nodes, edges
        ),
    });
    tracing::info!(nodes, edges, "arb.graph.snapshot: accepted");
    let len = s.events.len();
    if len > 200 {
        s.events.drain(0..(len - 200));
    }
    // Wake detection loop immediately
    s.wake.notify_one();
    serde_json::json!({"ok": true, "nodes": nodes, "edges": edges})
}

async fn arb_graph_update(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<GraphDiffReq>,
) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) {
        return Json(serde_json::json!({"error":"unauthorized"}));
    }
    
    // Check version atomically first (no lock needed for read!)
    if let Some(v) = req.version {
        let current_version = state
            .read()
            .await
            .last_graph_version
            .load(Ordering::Acquire);
        if v <= current_version {
            let mut s = state.write().await;
            s.metrics.graph_updates_skipped = s.metrics.graph_updates_skipped.saturating_add(1);
            tracing::warn!(
                version = v,
                current_version = current_version,
                skipped_count = s.metrics.graph_updates_skipped,
                "arb.graph.diff: skipped stale version"
            );
            return Json(serde_json::json!({"ok": true, "skipped": true }));
        }
    }
    
    let mut s = state.write().await;
    
    // Apply diffs directly to live_graph (double-buffer pattern)
    // Detection will create a snapshot at start of each cycle
    
    // Track changed mints for scoped detection (used by detection loop)
    let mut changed_mints: Vec<String> = Vec::new();
    
    // Apply removals directly to live_graph
    if let Some(removed) = req.removed_edge_ids {
        let n = removed.len();
        if n > 0 {
            let _ = s.live_graph.remove_edges_by_ids(&removed);
            tracing::info!(removed = n, "arb.graph.diff: applied removals to live_graph");
        }
        // NO buffering - we applied directly
    }
    
    // Apply additions directly to live_graph using insert_bidirectional_edges
    // to ensure proper rate inversion and bidirectional edge creation
    if let Some(added) = req.added_edges {
        let n = added.len();
        for e in added.iter() {
            let dex = e.dex.as_deref().unwrap_or("");
            let price = e.price_a_per_b.unwrap_or(0.0);
            let pool_id = e.pool_id.clone().unwrap_or_default();
            let fee_bps = e.fee_bps.unwrap_or(0);
            let liquidity = e.liquidity.unwrap_or(0.0);
            let liquidity_display = e.liquidity_display.unwrap_or(0.0);

            // Use insert_bidirectional_edges to correctly:
            // 1. Invert price to get rate_effective (1/price * (1-fee))
            // 2. Apply fees
            // 3. Create both forward and reverse edges
            insert_bidirectional_edges(
                &mut s.live_graph,
                dex,
                &e.source,
                &e.target,
                &pool_id,
                fee_bps,
                liquidity,
                liquidity_display,
                price,
                e.native_mint_a.clone(),
                e.native_mint_b.clone(),
                e.native_decimals_a,
                e.native_decimals_b,
                e.native_account_a.clone(),
                e.native_account_b.clone(),
                e.native_reserve_a_raw.clone(),
                e.native_reserve_b_raw.clone(),
            );
            changed_mints.push(e.source.clone());
            changed_mints.push(e.target.clone());
        }
        tracing::info!(added = n, "arb.graph.diff: applied additions to live_graph (bidirectional)");
    }

    // Apply updates directly to live_graph using insert_bidirectional_edges
    if let Some(updated) = req.updated_edges {
        let n = updated.len();
        for e in updated.iter() {
            let dex = e.dex.as_deref().unwrap_or("");
            let price = e.price_a_per_b.unwrap_or(0.0);
            let pool_id = e.pool_id.clone().unwrap_or_default();
            let fee_bps = e.fee_bps.unwrap_or(0);
            let liquidity = e.liquidity.unwrap_or(0.0);
            let liquidity_display = e.liquidity_display.unwrap_or(0.0);

            // Use insert_bidirectional_edges for updates as well
            insert_bidirectional_edges(
                &mut s.live_graph,
                dex,
                &e.source,
                &e.target,
                &pool_id,
                fee_bps,
                liquidity,
                liquidity_display,
                price,
                e.native_mint_a.clone(),
                e.native_mint_b.clone(),
                e.native_decimals_a,
                e.native_decimals_b,
                e.native_account_a.clone(),
                e.native_account_b.clone(),
                e.native_reserve_a_raw.clone(),
                e.native_reserve_b_raw.clone(),
            );
            changed_mints.push(e.source.clone());
            changed_mints.push(e.target.clone());
        }
        tracing::info!(updated = n, changed_mints = changed_mints.len(), "arb.graph.diff: applied updates to live_graph (bidirectional)");
    }
    
    // Increment live_graph_version
    s.live_graph_version.fetch_add(1, Ordering::Release);
    
    // IMMEDIATE VERSION COMMIT: Commit version right away since graph data is already applied.
    // This fixes desync issues where ACKs would timeout during long detection cycles because
    // pending_graph_version was only committed at the start of the next detection iteration.
    // Now that updates are applied directly to live_graph, the version should also be committed
    // immediately - matching the behavior of /arb/graph/snapshot.
    if let Some(v) = req.version {
        let current = s.last_graph_version.load(Ordering::Acquire);
        if v > current {
            s.last_graph_version.store(v, Ordering::Release);
            s.version_changed.notify_waiters();
            tracing::info!(
                old_version = current,
                new_version = v,
                "arb.graph.diff: version committed immediately"
            );
        } else {
            tracing::debug!(
                received_version = v,
                current_version = current,
                "arb.graph.diff: version skipped (not newer)"
            );
        }
    }
    if let Some(ts) = req.timestamp {
        s.last_graph_ts.store(ts, Ordering::Release);
    }
    
    // Update metrics
    s.metrics.last_graph_push_rx_ms = now_ms();
    s.metrics.graph_nodes = s.live_graph.g.node_count() as u64;
    s.metrics.graph_edges = s.live_graph.g.edge_count() as u64;
    
    let wake = s.wake.clone();
    let response = serde_json::json!({"ok": true});
    drop(s);
    wake.notify_one();
    Json(response)
}

async fn arb_start(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<StartReq>,
) -> Json<serde_json::Value> {
    // Validate secret when configured
    if !auth_ok(Some(&headers)) {
        return Json(serde_json::json!({ "error": "unauthorized" }));
    }
    // Build graph outside lock
    let prebuilt: Option<(ArbGraph, Option<u64>, Option<u64>, u64, u64)> = if let Some(g) =
        req.graph.clone()
    {
        tracing::info!(version = ?g.version, ts = ?g.timestamp, nodes = g.nodes.len(), edges = g.edges.len(), "arb.start: graph received");
        let mut new_graph = ArbGraph::new();
        for e in g.edges.into_iter() {
            let dex = e.dex.unwrap_or_else(|| "Unknown".to_string());
            let fee = e.fee_bps.unwrap_or(0);
            let liq = e.liquidity.unwrap_or(0.0);
            let liq_disp = e.liquidity_display.unwrap_or(0.0);
            let px = e.price_a_per_b.unwrap_or(0.0);
            let pool_id = canonical_edge_id(e.pool_id.as_deref(), &e.source, &e.target, &dex);
            insert_bidirectional_edges(
                &mut new_graph,
                &dex,
                &e.source,
                &e.target,
                &pool_id,
                fee,
                liq,
                liq_disp,
                px,
                e.native_mint_a.clone(),
                e.native_mint_b.clone(),
                e.native_decimals_a,
                e.native_decimals_b,
                e.native_account_a.clone(),
                e.native_account_b.clone(),
                e.native_reserve_a_raw.clone(),
                e.native_reserve_b_raw.clone(),
            );
        }
        let nodes_cnt = new_graph.g.node_count() as u64;
        let edges_cnt = new_graph.g.edge_count() as u64;
        Some((new_graph, g.version, g.timestamp, nodes_cnt, edges_cnt))
    } else {
        None
    };

    let mut s = state.write().await;
    if let Some((new_graph, v, ts, nodes_cnt, edges_cnt)) = prebuilt {
        s.live_graph = new_graph;
        s.metrics.graph_nodes = nodes_cnt;
        s.metrics.graph_edges = edges_cnt;
        if let Some(vv) = v {
            s.last_graph_version.store(vv, Ordering::Release);
            s.version_changed.notify_waiters();
        }
        if let Some(tt) = ts {
            s.last_graph_ts.store(tt, Ordering::Release);
        }

        s.events.push(EventItem {
            ts: now_ms(),
            level: "info".into(),
            message: format!(
                "arb.start: graph accepted nodes={} edges={}",
                nodes_cnt, edges_cnt
            ),
        });
        tracing::info!(
            nodes = nodes_cnt,
            edges = edges_cnt,
            "arb.start: graph accepted"
        );
        let len = s.events.len();
        if len > 200 {
            s.events.drain(0..(len - 200));
        }
    }
    if let Some(want) = req.enable {
        if want && !s.config.enabled {
            tracing::info!("arb.start: enabling loop");
            s.config.enabled = true;
        } else if !want {
            tracing::info!("arb.stop: disabling loop");
            s.config.enabled = false;
            // Clear graph and pending buffers so next start receives a fresh snapshot
            s.live_graph = ArbGraph::new();
            s.metrics.graph_nodes = 0;
            s.metrics.graph_edges = 0;
            s.last_graph_version.store(0, Ordering::Release);
            s.last_graph_ts.store(0, Ordering::Release);
            s.pending_added_edges.clear();
            s.pending_updated_edges.clear();
            s.pending_removed_edge_ids.clear();
            s.pending_graph_version.store(u64::MAX, Ordering::Release);
            s.pending_graph_ts.store(u64::MAX, Ordering::Release);
            s.events.push(EventItem {
                ts: now_ms(),
                level: "info".into(),
                message: "arb.stop: graph cleared".into(),
            });
        }
    } else {
        if !s.config.enabled {
            tracing::info!("arb.start: enabling loop");
        }
        s.config.enabled = true;
    }
    Json(
        serde_json::json!({ "ok": true, "enabled": s.config.enabled, "graph_nodes": s.metrics.graph_nodes, "graph_edges": s.metrics.graph_edges }),
    )
}

async fn ws_opportunities(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RwLock<AppState>>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |mut socket| async move {
        let mut last: Option<String> = None;
        loop {
            // Build WS payload aligned with GET /opportunities (items + near_items + summary)
            let (items, near_items, summary) = {
                let s = state.read().await;
                let items = s.opportunities.clone();
                let count = items.len();
                let max_profit_bps = items.iter().map(|o| o.profit_bps).max().unwrap_or(0);
                let avg_profit_bps = if count == 0 {
                    0.0
                } else {
                    items.iter().map(|o| o.profit_bps as f64).sum::<f64>() / (count as f64)
                };
                let avg_net_bps = if count == 0 {
                    0.0
                } else {
                    items
                        .iter()
                        .map(|o| o.net_bps.unwrap_or(o.profit_bps) as f64)
                        .sum::<f64>()
                        / (count as f64)
                };
                let avg_hop_count = if count == 0 {
                    0.0
                } else {
                    items
                        .iter()
                        .map(|o| o.hop_count.unwrap_or(o.path.len()) as f64)
                        .sum::<f64>()
                        / (count as f64)
                };
                let avg_link_edges_used = if count == 0 {
                    0.0
                } else {
                    items
                        .iter()
                        .map(|o| o.link_edges_used.unwrap_or(0) as f64)
                        .sum::<f64>()
                        / (count as f64)
                };
                let min_edge_liquidity_vals: Vec<f64> = items
                    .iter()
                    .map(|o| o.min_edge_liquidity.unwrap_or(0.0))
                    .collect();
                let min_edge_liquidity_avg = if count == 0 {
                    0.0
                } else {
                    min_edge_liquidity_vals.iter().sum::<f64>() / (count as f64)
                };
                let min_edge_liquidity_min = {
                    let m = min_edge_liquidity_vals
                        .iter()
                        .cloned()
                        .fold(f64::INFINITY, f64::min);
                    if m.is_infinite() {
                        0.0
                    } else {
                        m
                    }
                };
                let near_items = if s.near_misses.is_empty() {
                    None
                } else {
                    Some(s.near_misses.clone())
                };
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
                    near_misses: if s.near_misses.is_empty() {
                        None
                    } else {
                        Some(s.near_misses.clone())
                    },
                    rejected_opportunities: if s.rejected_opportunities.is_empty() {
                        None
                    } else {
                        Some(s.rejected_opportunities.clone())
                    },
                };
                (items, near_items, summary)
            };
            let payload =
                serde_json::json!({ "items": items, "near_items": near_items, "summary": summary });
            let text = payload.to_string();
            // Build a signature that includes profit values for change detection
            let signature = {
                let opps_sig: String = items
                    .iter()
                    .map(|o| {
                        format!(
                            "{}:{}:{}",
                            o.path.join(">"),
                            o.profit_bps,
                            o.net_bps.unwrap_or(o.profit_bps)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("|");
                let near_sig = if let Some(ref nm) = summary.near_miss {
                    format!(
                        "{}:{}:{}",
                        nm.path.join(">"),
                        nm.profit_bps,
                        nm.net_bps.unwrap_or(nm.profit_bps)
                    )
                } else {
                    String::new()
                };
                format!("{}:{}:{}", items.len(), opps_sig, near_sig)
            };
            // Compare signature instead of full JSON to detect profit value changes
            if last.as_ref() != Some(&signature) {
                if socket.send(Message::Text(text.clone())).await.is_err() {
                    break;
                }
                last = Some(signature);
                let mut s = state.write().await;
                s.metrics.ws_push_total += 1;
            } else {
                let mut s = state.write().await;
                s.metrics.ws_skipped_nochange_total += 1;
            }

            // Use tokio::select! to handle incoming messages (ping/pong) while sleeping
            // This prevents WebSocket timeouts when no data changes occur
            // PERF: Use configurable broadcast interval (default 100ms, was 1500ms)
            let broadcast_interval_ms = {
                let s = state.read().await;
                s.config.ws_broadcast_interval_ms
            };
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(broadcast_interval_ms)) => {
                    // Normal sleep expired, continue to next iteration
                }
                msg = socket.recv() => {
                    // Handle incoming messages (ping/pong frames, client messages)
                    match msg {
                        Some(Ok(Message::Close(_))) => {
                            // Client requested close
                            let _ = socket.close().await;
                            break;
                        }
                        Some(Ok(Message::Ping(data))) => {
                            // Respond to ping with pong
                            if socket.send(Message::Pong(data)).await.is_err() { break; }
                        }
                        Some(Ok(Message::Pong(_))) => {
                            // Pong received, ignore
                        }
                        Some(Ok(_)) => {
                            // Other message types, ignore
                        }
                        Some(Err(_)) => {
                            // Error receiving message, close connection
                            break;
                        }
                        None => {
                            // Connection closed
                            break;
                        }
                    }
                }
            }
        }
    })
}

#[derive(serde::Deserialize)]
struct ExecutedReq {
    path: Vec<String>,
    dexes: Option<Vec<String>>,
}

async fn opportunity_executed(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<ExecutedReq>,
) -> Json<serde_json::Value> {
    if !auth_ok(Some(&headers)) {
        return Json(serde_json::json!({"error":"unauthorized"}));
    }
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
    opportunity_base_ttl_ms: Option<u64>,
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
    use_spfa: Option<bool>,
    run_dual_algo: Option<bool>,
    max_sol_stable_hops: Option<usize>,
    drop_stable_stable_hops: Option<bool>,
    stable_mints: Option<Vec<String>>,
    calibrate_magnitude_on_ingest: Option<bool>,
    // Legacy field - kept for backward compatibility
    anchor_start_mode: Option<bool>,
    // NEW: String-based start mint mode: "any", "sol_usdc", or "anchors"
    start_mint_mode: Option<String>,
    anchor_mints: Option<Vec<String>>,
    // WebSocket broadcast interval in milliseconds (CRITICAL for execution latency)
    ws_broadcast_interval_ms: Option<u64>,
}

async fn set_config(
    State(state): State<Arc<RwLock<AppState>>>,
    Json(cfg): Json<ConfigReq>,
) -> Json<serde_json::Value> {
    let mut s = state.write().await;
    // Log receipt of config update and which keys were provided
    {
        let mut keys: Vec<&str> = Vec::new();
        if cfg.enabled.is_some() {
            keys.push("enabled");
        }
        if cfg.min_profit_bps.is_some() {
            keys.push("min_profit_bps");
        }
        if cfg.max_profit_bps.is_some() {
            keys.push("max_profit_bps");
        }
        if cfg.min_notional_usd.is_some() {
            keys.push("min_notional_usd");
        }
        if cfg.max_hops.is_some() {
            keys.push("max_hops");
        }
        if cfg.max_idle_ms.is_some() {
            keys.push("max_idle_ms");
        }
        if cfg.quote_size_usd.is_some() {
            keys.push("quote_size_usd");
        }
        if cfg.max_detections_without_exec.is_some() {
            keys.push("max_detections_without_exec");
        }
        if cfg.detection_history_ttl_ms.is_some() {
            keys.push("detection_history_ttl_ms");
        }
        if cfg.opportunity_ttl_ms.is_some() {
            keys.push("opportunity_ttl_ms");
        }
        if cfg.opportunity_base_ttl_ms.is_some() {
            keys.push("opportunity_base_ttl_ms");
        }
        if cfg.debug_emit_subthreshold.is_some() {
            keys.push("debug_emit_subthreshold");
        }
        if cfg.debug_top_n.is_some() {
            keys.push("debug_top_n");
        }
        if cfg.near_miss_enable.is_some() {
            keys.push("near_miss_enable");
        }
        if cfg.near_miss_epsilon.is_some() {
            keys.push("near_miss_epsilon");
        }
        if cfg.ws_broadcast_interval_ms.is_some() {
            keys.push("ws_broadcast_interval_ms");
        }
        let keys_str = keys.join(",");
        tracing::info!(
            target = "arb_rs",
            "arb.config.receive keys=[{}] near_miss_enable={:?} debug_top_n={:?}",
            keys_str,
            cfg.near_miss_enable,
            cfg.debug_top_n
        );
    }
    if let Some(v) = cfg.enabled {
        s.config.enabled = v;
    }
    if let Some(v) = cfg.min_profit_bps {
        s.config.min_profit_bps = v;
    }
    if let Some(v) = cfg.max_profit_bps {
        s.config.max_profit_bps = v;
    }
    if let Some(v) = cfg.min_notional_usd {
        s.config.min_notional_usd = v;
    }
    if let Some(v) = cfg.max_hops {
        // Ensure max_hops is at least 2 (minimum for a cycle)
        s.config.max_hops = v.max(2);
    }
    if let Some(v) = cfg.max_idle_ms {
        s.config.max_idle_ms = v;
    }
    if let Some(v) = cfg.quote_size_usd {
        s.config.quote_size_usd = v;
    }
    if let Some(v) = cfg.max_detections_without_exec {
        s.config.max_detections_without_exec = v;
    }
    if let Some(v) = cfg.detection_history_ttl_ms {
        s.config.detection_history_ttl_ms = v;
    }
    if let Some(v) = cfg.opportunity_ttl_ms {
        s.config.opportunity_ttl_ms = v;
    }
    if let Some(v) = cfg.opportunity_base_ttl_ms {
        s.config.opportunity_base_ttl_ms = v;
    }
    if let Some(v) = cfg.debug_emit_subthreshold {
        s.config.debug_emit_subthreshold = v;
    }
    if let Some(v) = cfg.debug_top_n {
        s.config.debug_top_n = v;
    }
    if let Some(v) = cfg.near_miss_enable {
        s.config.near_miss_enable = v;
    }
    if let Some(v) = cfg.near_miss_epsilon {
        s.config.near_miss_epsilon = v;
    }
    if let Some(v) = cfg.debug_near_miss_failures {
        s.config.debug_near_miss_failures = v;
    }
    // Extended fields
    if let Some(v) = cfg.est_priority_fee_per_hop_lamports {
        s.config.est_priority_fee_per_hop_lamports = Some(v);
    }
    if let Some(v) = cfg.filtered_detect_enable {
        s.config.filtered_detect_enable = v;
    }
    if let Some(v) = cfg.filtered_node_ratio {
        s.config.filtered_node_ratio = v;
    }
    if let Some(v) = cfg.filtered_expand_hops {
        s.config.filtered_expand_hops = Some(v);
    }
    if let Some(v) = cfg.periodic_full_ms {
        s.config.periodic_full_ms = Some(v);
    }
    if let Some(v) = cfg.use_spfa {
        s.config.use_spfa = v;
    }
    if let Some(v) = cfg.run_dual_algo {
        s.config.run_dual_algo = v;
    }
    if let Some(v) = cfg.max_sol_stable_hops {
        s.config.max_sol_stable_hops = Some(v);
    }
    if let Some(v) = cfg.drop_stable_stable_hops {
        s.config.drop_stable_stable_hops = v;
    }
    if let Some(v) = cfg.stable_mints {
        s.config.stable_mints = Some(v);
    }
    if let Some(v) = cfg.calibrate_magnitude_on_ingest {
        s.config.calibrate_magnitude_on_ingest = v;
    }
    // Handle legacy anchor_start_mode (convert to start_mint_mode)
    if let Some(v) = cfg.anchor_start_mode {
        s.config.start_mint_mode = if v { "anchors".to_string() } else { "any".to_string() };
    }
    // Prefer new start_mint_mode if provided
    if let Some(v) = cfg.start_mint_mode {
        let valid_modes = ["any", "sol_usdc", "anchors"];
        if valid_modes.contains(&v.as_str()) {
            s.config.start_mint_mode = v;
        } else {
            tracing::warn!(target = "arb_rs", "Invalid start_mint_mode: {}, using 'any'", v);
            s.config.start_mint_mode = "any".to_string();
        }
    }
    if let Some(v) = cfg.anchor_mints {
        s.config.anchor_mints = Some(v);
    }
    // WebSocket broadcast interval - CRITICAL for execution latency
    if let Some(v) = cfg.ws_broadcast_interval_ms {
        // Clamp to reasonable range: 10ms minimum (avoid CPU spin), 5000ms maximum
        let clamped = v.clamp(10, 5000);
        if clamped != v {
            tracing::warn!(target = "arb_rs", "ws_broadcast_interval_ms clamped from {} to {}", v, clamped);
        }
        s.config.ws_broadcast_interval_ms = clamped;
        tracing::info!(target = "arb_rs", ws_broadcast_interval_ms = clamped, "arb.config.ws_interval_updated");
    }
    // Optional: extend ConfigReq to accept pruning fields without breaking existing clients
    // We tolerate presence via raw JSON by re-reading from persisted file later if needed.
    let config_snapshot = s.config.clone();
    drop(s);
    if let Err(err) = persist_config(&config_snapshot).await {
        tracing::warn!(target = "arb_rs", error = ?err, "arb.config.persist_failed");
    }
    Json(serde_json::json!({"ok": true, "config": config_snapshot}))
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
        // Event-driven loop - max_idle_ms is now a fallback timeout (effectively infinite)
        max_idle_ms: std::env::var("ARB_IDLE_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3_600_000), // 1 hour default
        quote_size_usd: 100.0,
        max_detections_without_exec: std::env::var("ARB_MAX_DETECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3),
        detection_history_ttl_ms: std::env::var("ARB_DETECTION_TTL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(120_000),
        opportunity_ttl_ms: std::env::var("ARB_OPPORTUNITY_TTL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300_000), // Default 5 minutes (was 30 seconds) - opportunities persist longer
        // Base TTL for opportunity persistence - independent of loop timing
        opportunity_base_ttl_ms: std::env::var("ARB_OPPORTUNITY_BASE_TTL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5_000),
        debug_emit_subthreshold: std::env::var("ARB_DEBUG_SUBTHRESHOLD")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(false),
        debug_top_n: std::env::var("ARB_DEBUG_TOP_N")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5),
        near_miss_enable: std::env::var("ARB_NEAR_MISS_ENABLE")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(false),
        near_miss_epsilon: std::env::var("ARB_NEAR_MISS_EPS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5e-4),
        est_priority_fee_per_hop_lamports: Some(0),
        debug_near_miss_failures: std::env::var("ARB_DEBUG_NM_FAIL")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(false),
        filtered_detect_enable: std::env::var("ARB_FILTERED_DETECT_ENABLE")
            .ok()
            .map(|v| v != "false")
            .unwrap_or(false),
        filtered_node_ratio: std::env::var("ARB_FILTERED_NODE_RATIO")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1.0),
        filtered_expand_hops: std::env::var("ARB_FILTERED_EXPAND_HOPS")
            .ok()
            .and_then(|s| s.parse().ok())
            .or(None),
        periodic_full_ms: std::env::var("ARB_PERIODIC_FULL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .or(Some(1000)),
        // Algorithm selection: SPFA is generally faster on sparse graphs
        use_spfa: std::env::var("ARB_USE_SPFA")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(false),
        // Run both BF and SPFA and merge results for more comprehensive detection
        run_dual_algo: std::env::var("ARB_RUN_DUAL_ALGO")
            .ok()
            .map(|v| v != "false")
            .unwrap_or(true),
        // Pruning defaults
        // Use None to indicate unlimited (avoids JS float precision issues with usize::MAX)
        max_sol_stable_hops: std::env::var("ARB_MAX_SOL_STABLE_HOPS")
            .ok()
            .and_then(|s| s.parse().ok()),
        drop_stable_stable_hops: std::env::var("ARB_DROP_STABLE_STABLE_HOPS")
            .ok()
            .map(|v| v != "false")
            .unwrap_or(false),
        stable_mints: None,
        calibrate_magnitude_on_ingest: std::env::var("ARB_CALIBRATE_ON_INGEST")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(false),
        // Start mint mode: "any", "sol_usdc", or "anchors"
        // Also supports legacy ARB_ANCHOR_START_MODE=true -> "anchors"
        start_mint_mode: {
            let legacy = std::env::var("ARB_ANCHOR_START_MODE")
                .ok()
                .map(|v| v == "true")
                .unwrap_or(false);
            std::env::var("ARB_START_MINT_MODE")
                .ok()
                .unwrap_or_else(|| if legacy { "anchors".to_string() } else { "any".to_string() })
        },
        anchor_mints: Some(vec![
            "So11111111111111111111111111111111111111112".to_string(), // SOL
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(), // USDC
        ]),
        // Edge selection configuration
        max_edge_combinations: std::env::var("ARB_MAX_EDGE_COMBINATIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10_000),
        top_k_edges_per_hop: std::env::var("ARB_TOP_K_EDGES_PER_HOP")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5),
        // WebSocket broadcast interval - CRITICAL for execution latency
        // Default 25ms (was 1500ms) - minimal latency to match detection loop cadence
        // Configurable via ARB_WS_BROADCAST_INTERVAL_MS environment variable
        ws_broadcast_interval_ms: std::env::var("ARB_WS_BROADCAST_INTERVAL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(25), // 25ms default for minimal latency
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
            config: ArbConfig {
                max_sol_stable_hops: Some(1),
                drop_stable_stable_hops: true,
                stable_mints: None,
                ..default_config()
            },
            opportunities: Vec::new(),
            rejected_opportunities: Vec::new(),
            rejected_opportunities_updated_ms: 0,
            live_graph: ArbGraph::new(),
            live_graph_version: AtomicU64::new(0),
            detection_snapshot: None,
            detection_snapshot_version: AtomicU64::new(0),
            metrics: Metrics::default(),
            events: Vec::new(),
            near_miss: None,
            near_miss_shortfall_bps: None,
            near_misses: Vec::new(),
            last_graph_version: AtomicU64::new(0),
            last_graph_ts: AtomicU64::new(0),
            pending_added_edges: Vec::new(),
            pending_updated_edges: Vec::new(),
            pending_removed_edge_ids: Vec::new(),
            pending_graph_version: AtomicU64::new(u64::MAX),
            pending_graph_ts: AtomicU64::new(u64::MAX),
            consecutive_empty_cycles: AtomicU64::new(0),
            last_resync_attempt_ms: AtomicU64::new(0),
            wake: Arc::new(Notify::new()),
            version_changed: Arc::new(Notify::new()),
            detection_counts: HashMap::new(),
            executed_keys: HashSet::new(),
        };
        // Build three nodes and edges to form SOL->USDC->USDT->SOL (labels only)
        let sol = "So11111111111111111111111111111111111111112";
        let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        let e = |rate| EdgeData {
            rate_effective: rate,
            fee_bps: 30,
            liquidity: 1000.0,
            dex: "X".into(),
            pool_id: String::new(),
            liquidity_display: 1000.0,
        };
        s.live_graph.upsert_edge("X", sol, usdc, e(1.0));
        s.live_graph.upsert_edge("X", usdc, usdt, e(1.0));
        s.live_graph.upsert_edge("X", usdt, sol, e(1.0));
        // Build labels order
        let labels = vec![sol.to_string(), usdc.to_string(), usdt.to_string()];
        // Count sol-stable hops and detect stable-stable
        let default_stables: std::collections::HashSet<&str> = [usdc, usdt].into_iter().collect();
        let cfg_stables: std::collections::HashSet<String> = s
            .config
            .stable_mints
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let is_stable = |m: &str| {
            if cfg_stables.is_empty() {
                default_stables.contains(m)
            } else {
                cfg_stables.contains(m)
            }
        };
        let mut has_stable_stable = false;
        let mut sol_stable_hops: usize = 0;
        for i in 0..labels.len() {
            let a = &labels[i];
            let b = &labels[(i + 1) % labels.len()];
            let a_st = is_stable(a);
            let b_st = is_stable(b);
            if a_st && b_st {
                has_stable_stable = true;
                break;
            }
            if (a == sol && b_st) || (b == sol && a_st) {
                sol_stable_hops += 1;
            }
        }
        assert!(has_stable_stable);
        // Under current counting, ensure at least one SOL<->stable hop is present
        assert!(sol_stable_hops >= 1);
        // Pruning should trigger with drop_stable_stable_hops=true and max_sol_stable_hops=1
        assert!(s.config.drop_stable_stable_hops);
        assert_eq!(s.config.max_sol_stable_hops, Some(1));
    }

    fn mk_opp(
        path: &[&str],
        bps: i64,
        net: Option<i64>,
        first: u64,
        last: u64,
        det: u64,
    ) -> Opportunity {
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
            mk_opp(&["A", "B", "A"], 40, Some(35), now - 12_000, now - 2_000, 3),
            // Old and few detections -> should drop under base TTL
            mk_opp(
                &["C", "D", "C"],
                90,
                Some(80),
                now - 12_000,
                now - 11_000,
                1,
            ),
        ];
        let opps: Vec<Opportunity> = vec![];

        // Merge logic mirror
        let mut merged: Vec<Opportunity> = Vec::new();
        merged.extend(opps.into_iter());
        for mut o in prev.drain(..) {
            let first = o.first_seen_ms.unwrap_or(o.detected_ms.unwrap_or(now));
            let det = o.detections.unwrap_or(1);
            let ttl = base_ttl.saturating_mul(1 + det.min(2));
            let is_dup = merged
                .iter()
                .any(|x| x.path == o.path && x.dexes == o.dexes);
            if !is_dup && now.saturating_sub(first) <= ttl {
                if o.first_seen_ms.is_none() {
                    o.first_seen_ms = o.detected_ms;
                }
                o.detections = Some(det);
                merged.push(o);
            }
        }
        // Expect only the stable one retained
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].path, vec!["A", "B", "A"]);

        // Add a new higher net_bps item and test sorting and cap
        let mut merged2 = merged;
        merged2.push(mk_opp(
            &["E", "F", "E"],
            10,
            Some(120),
            now - 100,
            now - 50,
            1,
        ));
        merged2.sort_by(|a, b| {
            let an = a.net_bps.unwrap_or(a.profit_bps);
            let bn = b.net_bps.unwrap_or(b.profit_bps);
            bn.cmp(&an)
                .then_with(|| b.detected_ms.unwrap_or(0).cmp(&a.detected_ms.unwrap_or(0)))
        });
        assert_eq!(merged2[0].path, vec!["E", "F", "E"]);
    }

    #[test]
    fn cap_list_to_50() {
        let now = 2_000_000u64;
        let mut v: Vec<Opportunity> = Vec::new();
        for i in 0..60 {
            v.push(mk_opp(
                &["X", "Y", "X"],
                i,
                Some(i),
                now - i as u64,
                now - i as u64,
                1,
            ));
        }
        v.sort_by(|a, b| {
            let an = a.net_bps.unwrap_or(a.profit_bps);
            let bn = b.net_bps.unwrap_or(b.profit_bps);
            bn.cmp(&an)
                .then_with(|| b.detected_ms.unwrap_or(0).cmp(&a.detected_ms.unwrap_or(0)))
        });
        if v.len() > 50 {
            v.truncate(50);
        }
        assert_eq!(v.len(), 50);
        // Highest net_bps at front
        assert!(v[0].net_bps.unwrap_or(0) >= v[49].net_bps.unwrap_or(0));
    }

    #[test]
    fn detections_cap_without_execution() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let executed_keys: HashSet<String> = HashSet::new();
        let cfg = ArbConfig {
            max_detections_without_exec: 3,
            detection_history_ttl_ms: 120_000,
            ..default_config()
        };
        let opp = mk_opp(&["A", "B", "A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        let mut included = Vec::new();
        for i in 0..3u64 {
            let now = 1_000 + i * 500; // within TTL
                                       // prune
            detection_counts
                .retain(|_, &mut (_, ts)| now.saturating_sub(ts) <= cfg.detection_history_ttl_ms);
            // bump
            let (c, _) = detection_counts.get(&key).copied().unwrap_or((0, 0));
            detection_counts.insert(key.clone(), (c.saturating_add(1), now));
            // include if under cap or executed
            let executed = executed_keys.contains(&key);
            let count = detection_counts
                .get(&key)
                .map(|(c, _)| *c as usize)
                .unwrap_or(0);
            included.push(executed || count < cfg.max_detections_without_exec);
        }
        assert_eq!(included, vec![true, true, false]);
    }

    #[test]
    fn executed_override_allows_after_cap() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let mut executed_keys: HashSet<String> = HashSet::new();
        let cfg = ArbConfig {
            max_detections_without_exec: 3,
            detection_history_ttl_ms: 120_000,
            ..default_config()
        };
        let opp = mk_opp(&["A", "B", "A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        detection_counts.insert(key.clone(), (3, 10_000));
        executed_keys.insert(key.clone());
        let executed = executed_keys.contains(&key);
        let count = detection_counts
            .get(&key)
            .map(|(c, _)| *c as usize)
            .unwrap_or(0);
        assert!(executed && count >= cfg.max_detections_without_exec);
        // should be included due to executed override
        assert!(executed || count < cfg.max_detections_without_exec);
    }

    #[test]
    fn detection_history_ttl_prunes_old_counts() {
        let mut detection_counts: HashMap<String, (u64, u64)> = HashMap::new();
        let cfg = ArbConfig {
            detection_history_ttl_ms: 1000,
            ..default_config()
        };
        let opp = mk_opp(&["A", "B", "A"], 100, Some(90), 0, 0, 0);
        let key = keyify_opportunity(&opp.path, &opp.dexes);
        detection_counts.insert(key.clone(), (2, 1_000));
        // advance beyond TTL
        let now = 3_500u64;
        detection_counts
            .retain(|_, &mut (_, ts)| now.saturating_sub(ts) <= cfg.detection_history_ttl_ms);
        assert!(detection_counts.get(&key).is_none());
        // With count missing, include under cap
        let count = detection_counts
            .get(&key)
            .map(|(c, _)| *c as usize)
            .unwrap_or(0);
        assert!(count < cfg.max_detections_without_exec);
    }
}

async fn persist_config(cfg: &ArbConfig) -> anyhow::Result<()> {
    let path = std::env::var("ARB_CONFIG_PATH").unwrap_or_else(|_| "arb-config.json".into());
    let data = serde_json::to_string_pretty(cfg)?;
    tokio::fs::write(path, data).await?;
    Ok(())
}

/// Load config from persisted JSON file, falling back to defaults if not found or invalid
fn load_config() -> ArbConfig {
    let path = std::env::var("ARB_CONFIG_PATH").unwrap_or_else(|_| "arb-config.json".into());
    match std::fs::read_to_string(&path) {
        Ok(data) => {
            match serde_json::from_str::<ArbConfig>(&data) {
                Ok(cfg) => {
                    // Validate that critical fields have reasonable values
                    // If the file was from a different config system, use defaults
                    if cfg.opportunity_ttl_ms == 0 || cfg.max_idle_ms == 0 {
                        eprintln!("[arb-rs] Config file appears invalid (missing critical fields), using defaults");
                        return default_config();
                    }
                    cfg
                }
                Err(e) => {
                    eprintln!("[arb-rs] Failed to parse config file: {}, using defaults", e);
                    default_config()
                }
            }
        }
        Err(_) => default_config(),
    }
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
        s.last_graph_version.load(Ordering::Acquire),
        s.last_graph_ts.load(Ordering::Acquire)
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(serde::Serialize)]
struct EventsResponse {
    events: Vec<EventItem>,
}

async fn events_json(State(state): State<Arc<RwLock<AppState>>>) -> Json<EventsResponse> {
    let s = state.read().await;
    Json(EventsResponse {
        events: s.events.clone(),
    })
}

#[derive(serde::Serialize)]
struct GraphVersionResponse {
    version: u64,
    timestamp: u64,
}

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

async fn arb_graph_version(
    State(state): State<Arc<RwLock<AppState>>>,
) -> Json<GraphVersionResponse> {
    let s = state.read().await;
    // Return effective version (max of pending and applied) so backend cache reflects buffered versions
    // Use atomic reads - no lock contention!
    let last_version = s.last_graph_version.load(Ordering::Acquire);
    let pending_raw = s.pending_graph_version.load(Ordering::Acquire);
    let pending_version = if pending_raw == u64::MAX {
        0
    } else {
        pending_raw
    };
    let effective_version = pending_version.max(last_version);
    let timestamp = s.last_graph_ts.load(Ordering::Acquire);
    Json(GraphVersionResponse {
        version: effective_version,
        timestamp,
    })
}

async fn arb_graph_ack(
    State(state): State<Arc<RwLock<AppState>>>,
    headers: HeaderMap,
    Json(req): Json<GraphAckReq>,
) -> Json<GraphAckResponse> {
    if !auth_ok(Some(&headers)) {
        return Json(GraphAckResponse {
            ok: false,
            current_version: 0,
            current_timestamp: 0,
            acked: false,
        });
    }
    let want_version = req.version.unwrap_or(0);
    let timeout_ms = req.timeout_ms.unwrap_or(2500);
    let start = std::time::Instant::now();

    tracing::info!(want_version, timeout_ms, "arb.graph.ack: request received");

    // Wake the loop to ensure pending versions are processed quickly
    {
        let guard = state.read().await;
        guard.wake.notify_one();
    }

    // Get the version_changed notifier
    let version_notifier = {
        let guard = state.read().await;
        guard.version_changed.clone()
    };

    loop {
        let guard = state.read().await;
        let last_version = guard.last_graph_version.load(Ordering::Acquire);
        let pending_version = guard.pending_graph_version.load(Ordering::Acquire);
        let current_ts = guard.last_graph_ts.load(Ordering::Acquire);
        drop(guard);

        let elapsed = start.elapsed().as_millis() as u64;

        // Only ACK based on committed version (last_version), not pending version
        // This ensures the graph is actually updated before we acknowledge
        if want_version == 0 || last_version >= want_version {
            let acked = last_version >= want_version;
            tracing::info!(
                want_version = want_version,
                applied_version = last_version,
                pending_version = if pending_version != u64::MAX {
                    Some(pending_version)
                } else {
                    None
                },
                waited_ms = elapsed,
                acked = acked,
                "arb.graph.ack: success"
            );
            return Json(GraphAckResponse {
                ok: true,
                current_version: last_version,
                current_timestamp: current_ts,
                acked,
            });
        }

        if elapsed >= timeout_ms {
            tracing::warn!(
                want_version = want_version,
                applied_version = last_version,
                pending_version = if pending_version != u64::MAX {
                    Some(pending_version)
                } else {
                    None
                },
                elapsed_ms = elapsed,
                timeout_ms = timeout_ms,
                "arb.graph.ack: timeout"
            );
            break;
        }

        if elapsed == 0 || (elapsed > 0 && elapsed % 500 == 0) {
            tracing::debug!(
                want_version = want_version,
                applied_version = last_version,
                pending_version = if pending_version != u64::MAX {
                    Some(pending_version)
                } else {
                    None
                },
                elapsed_ms = elapsed,
                timeout_ms = timeout_ms,
                "arb.graph.ack: waiting"
            );
        }

        // Wait for version change notification or timeout
        // Use remaining timeout
        let remaining_ms = timeout_ms.saturating_sub(elapsed);
        if remaining_ms == 0 {
            break;
        }

        let timeout_duration = Duration::from_millis(remaining_ms.min(500)); // Check at most every 500ms
        let _ = tokio::time::timeout(timeout_duration, version_notifier.notified()).await;
    }

    let guard = state.read().await;
    let final_version = guard.last_graph_version.load(Ordering::Acquire);
    let final_ts = guard.last_graph_ts.load(Ordering::Acquire);
    drop(guard);
    Json(GraphAckResponse {
        ok: true,
        current_version: final_version,
        current_timestamp: final_ts,
        acked: false,
    })
}

// trigger_refresh removed with local mode deprecation

fn auth_ok(headers: Option<&HeaderMap>) -> bool {
    let expect = std::env::var("ARB_SHARED_SECRET").ok().unwrap_or_default();
    if expect.is_empty() {
        return true;
    }
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
    use axum::http::HeaderMap as AxumHeaderMap;
    use axum::http::HeaderValue;

    fn hv(s: &str) -> HeaderValue {
        HeaderValue::from_str(s).unwrap()
    }

    #[tokio::test]
    async fn diff_ordering_and_version_guards_apply_in_order() {
        std::env::set_var("ARB_SHARED_SECRET", "");
        let state = Arc::new(RwLock::new(AppState {
            config: default_config(),
            opportunities: Vec::new(),
            rejected_opportunities: Vec::new(),
            rejected_opportunities_updated_ms: 0,
            live_graph: ArbGraph::new(),
            live_graph_version: AtomicU64::new(1),
            detection_snapshot: None,
            detection_snapshot_version: AtomicU64::new(0),
            metrics: Metrics::default(),
            events: Vec::new(),
            near_miss: None,
            near_miss_shortfall_bps: None,
            near_misses: Vec::new(),
            last_graph_version: AtomicU64::new(1),
            last_graph_ts: AtomicU64::new(1),
            pending_added_edges: Vec::new(),
            pending_updated_edges: Vec::new(),
            pending_removed_edge_ids: Vec::new(),
            pending_graph_version: AtomicU64::new(u64::MAX),
            pending_graph_ts: AtomicU64::new(u64::MAX),
            consecutive_empty_cycles: AtomicU64::new(0),
            last_resync_attempt_ms: AtomicU64::new(0),
            wake: Arc::new(Notify::new()),
            version_changed: Arc::new(Notify::new()),
            detection_counts: HashMap::new(),
            executed_keys: HashSet::new(),
        }));

        // Buffer a valid diff at v=2 and a stale diff at v=1
        let mut headers = AxumHeaderMap::new();
        headers.insert("authorization", hv(""));
        let added = vec![GraphDiffEdge {
            source: "A".into(),
            target: "B".into(),
            dex: Some("D".into()),
            pool_id: None,
            fee_bps: Some(0),
            liquidity: Some(1.0),
            liquidity_display: Some(1.0),
            price_a_per_b: Some(1.0),
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
        }];
        let req_ok = GraphDiffReq {
            version: Some(2),
            timestamp: Some(2),
            added_edges: Some(added),
            updated_edges: None,
            removed_edge_ids: None,
        };
        let _ = arb_graph_update(State(state.clone()), headers.clone(), Json(req_ok)).await;
        // Stale should be skipped immediately
        let req_stale = GraphDiffReq {
            version: Some(1),
            timestamp: Some(1),
            added_edges: Some(vec![]),
            updated_edges: None,
            removed_edge_ids: None,
        };
        let resp = arb_graph_update(State(state.clone()), headers.clone(), Json(req_stale)).await;
        let j = resp.0; // Json<Value>
        assert!(
            j.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false) || j.get("ok").is_some()
        );

        // Apply buffered diffs by running the critical section from loop
        {
            let mut s = state.write().await;
            assert_eq!(s.pending_added_edges.len(), 1);
            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
            let added = std::mem::take(&mut s.pending_added_edges);
            let updated = std::mem::take(&mut s.pending_updated_edges);
            if !removed.is_empty() {
                let _ = s.live_graph.remove_edges_by_ids(&removed);
            }
            let mut upsert = |e: &GraphDiffEdge| {
                let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                let fee = e.fee_bps.unwrap_or(0);
                let liq = e.liquidity.unwrap_or(0.0);
                let liq_disp = e.liquidity_display.unwrap_or(0.0);
                let px = e.price_a_per_b.unwrap_or(0.0);
                let pool_id = canonical_edge_id(e.pool_id.as_deref(), &e.source, &e.target, &dex);
                insert_bidirectional_edges(
                    &mut s.live_graph,
                    &dex,
                    &e.source,
                    &e.target,
                    &pool_id,
                    fee,
                    liq,
                    liq_disp,
                    px,
                    e.native_mint_a.clone(),
                    e.native_mint_b.clone(),
                    e.native_decimals_a,
                    e.native_decimals_b,
                    e.native_account_a.clone(),
                    e.native_account_b.clone(),
                    e.native_reserve_a_raw.clone(),
                    e.native_reserve_b_raw.clone(),
                );
            };
            for e in added.iter() {
                upsert(e);
            }
            for e in updated.iter() {
                upsert(e);
            }
            let pending_v = s.pending_graph_version.load(Ordering::Acquire);
            if pending_v != u64::MAX {
                s.last_graph_version.store(pending_v, Ordering::Release);
                s.pending_graph_version.store(u64::MAX, Ordering::Release);
                s.version_changed.notify_waiters();
            }
            let pending_ts = s.pending_graph_ts.load(Ordering::Acquire);
            if pending_ts != u64::MAX {
                s.last_graph_ts.store(pending_ts, Ordering::Release);
                s.pending_graph_ts.store(u64::MAX, Ordering::Release);
            }
            s.metrics.graph_nodes = s.live_graph.g.node_count() as u64;
            s.metrics.graph_edges = s.live_graph.g.edge_count() as u64;
        }
        let s = state.read().await;
        assert_eq!(s.last_graph_version.load(Ordering::Acquire), 2);
        assert_eq!(s.live_graph.g.edge_count(), 1);
    }

    #[tokio::test]
    async fn snapshot_then_diffs_detect_cycle() {
        std::env::set_var("ARB_SHARED_SECRET", "");
        let state = Arc::new(RwLock::new(AppState {
            config: default_config(),
            opportunities: Vec::new(),
            rejected_opportunities: Vec::new(),
            rejected_opportunities_updated_ms: 0,
            live_graph: ArbGraph::new(),
            live_graph_version: AtomicU64::new(0),
            detection_snapshot: None,
            detection_snapshot_version: AtomicU64::new(0),
            metrics: Metrics::default(),
            events: Vec::new(),
            near_miss: None,
            near_miss_shortfall_bps: None,
            near_misses: Vec::new(),
            last_graph_version: AtomicU64::new(0),
            last_graph_ts: AtomicU64::new(0),
            pending_added_edges: Vec::new(),
            pending_updated_edges: Vec::new(),
            pending_removed_edge_ids: Vec::new(),
            pending_graph_version: AtomicU64::new(u64::MAX),
            pending_graph_ts: AtomicU64::new(u64::MAX),
            consecutive_empty_cycles: AtomicU64::new(0),
            last_resync_attempt_ms: AtomicU64::new(0),
            wake: Arc::new(Notify::new()),
            version_changed: Arc::new(Notify::new()),
            detection_counts: HashMap::new(),
            executed_keys: HashSet::new(),
        }));

        // Start with snapshot of empty graph at v=1
        let h = AxumHeaderMap::new();
        let snap = GraphSnapshotReq {
            graph: StartReqGraph {
                version: Some(1),
                timestamp: Some(1),
                edges: Vec::new(),
                nodes: Vec::new(),
            },
        };
        let _ = arb_graph_snapshot(State(state.clone()), h.clone(), Json(snap)).await;

        // Push diffs building a two-edge arbitrage A<->B: rates 2.0 and 0.6 -> product 1.2
        let add1 = GraphDiffEdge {
            source: "A".into(),
            target: "B".into(),
            dex: Some("D".into()),
            pool_id: None,
            fee_bps: Some(0),
            liquidity: Some(1.0),
            liquidity_display: Some(1.0),
            price_a_per_b: Some(0.5),
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
        }; // B per A = 2.0
        let add2 = GraphDiffEdge {
            source: "B".into(),
            target: "A".into(),
            dex: Some("D".into()),
            pool_id: None,
            fee_bps: Some(0),
            liquidity: Some(1.0),
            liquidity_display: Some(1.0),
            price_a_per_b: Some(1.6666666667),
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
        }; // A per B = 1.666.. => B per A = 0.6
        let diff = GraphDiffReq {
            version: Some(2),
            timestamp: Some(2),
            added_edges: Some(vec![add1, add2]),
            updated_edges: None,
            removed_edge_ids: None,
        };
        let _ = arb_graph_update(State(state.clone()), h.clone(), Json(diff)).await;

        // Apply diffs (simulate loop section)
        {
            let mut s = state.write().await;
            let removed = std::mem::take(&mut s.pending_removed_edge_ids);
            let added = std::mem::take(&mut s.pending_added_edges);
            let updated = std::mem::take(&mut s.pending_updated_edges);
            if !removed.is_empty() {
                let _ = s.live_graph.remove_edges_by_ids(&removed);
            }
            let mut upsert = |e: &GraphDiffEdge| {
                let dex = e.dex.clone().unwrap_or_else(|| "Unknown".to_string());
                let fee = e.fee_bps.unwrap_or(0);
                let liq = e.liquidity.unwrap_or(0.0);
                let liq_disp = e.liquidity_display.unwrap_or(0.0);
                let px = e.price_a_per_b.unwrap_or(0.0);
                let pool_id = canonical_edge_id(e.pool_id.as_deref(), &e.source, &e.target, &dex);
                insert_bidirectional_edges(
                    &mut s.live_graph,
                    &dex,
                    &e.source,
                    &e.target,
                    &pool_id,
                    fee,
                    liq,
                    liq_disp,
                    px,
                    e.native_mint_a.clone(),
                    e.native_mint_b.clone(),
                    e.native_decimals_a,
                    e.native_decimals_b,
                    e.native_account_a.clone(),
                    e.native_account_b.clone(),
                    e.native_reserve_a_raw.clone(),
                    e.native_reserve_b_raw.clone(),
                );
            };
            for e in added.iter() {
                upsert(e);
            }
            for e in updated.iter() {
                upsert(e);
            }
            let pending_v = s.pending_graph_version.load(Ordering::Acquire);
            if pending_v != u64::MAX {
                s.last_graph_version.store(pending_v, Ordering::Release);
                s.pending_graph_version.store(u64::MAX, Ordering::Release);
                s.version_changed.notify_waiters();
            }
            let pending_ts = s.pending_graph_ts.load(Ordering::Acquire);
            if pending_ts != u64::MAX {
                s.last_graph_ts.store(pending_ts, Ordering::Release);
                s.pending_graph_ts.store(u64::MAX, Ordering::Release);
            }
        }

        // Run detection and assert we find a cycle
        let s = state.read().await;
        let cycles = detect_negative_cycles(&s.live_graph, 4);
        assert!(!cycles.is_empty());
    }
}
