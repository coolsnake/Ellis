use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct EdgeData {
    pub rate_effective: f64, // after fees/slippage
    #[allow(dead_code)]
    pub fee_bps: i64,
    #[allow(dead_code)]
    pub liquidity: f64, // in base units
    #[allow(dead_code)]
    pub dex: String,
    #[allow(dead_code)]
    pub pool_id: String,
    #[allow(dead_code)]
    pub liquidity_display: f64,
    #[allow(dead_code)]
    pub native_mint_a: Option<String>,
    #[allow(dead_code)]
    pub native_mint_b: Option<String>,
    #[allow(dead_code)]
    pub native_decimals_a: Option<i64>,
    #[allow(dead_code)]
    pub native_decimals_b: Option<i64>,
    #[allow(dead_code)]
    pub native_account_a: Option<String>,
    #[allow(dead_code)]
    pub native_account_b: Option<String>,
    #[allow(dead_code)]
    pub native_reserve_a_raw: Option<String>,
    #[allow(dead_code)]
    pub native_reserve_b_raw: Option<String>,
    /// Max input in source (edge input) token raw atoms; for sizing cap (no USD).
    #[allow(dead_code)]
    pub capacity_input_raw: Option<String>,
    /// Pool type: "amm", "cpmm", "clmm", or "dlmm" - used for slippage simulation
    #[allow(dead_code)]
    pub pool_kind: Option<String>,
    /// Optional USD-based slippage curve (size -> output multiplier)
    #[allow(dead_code)]
    pub slippage_curve: Option<crate::slippage::SlippageCurve>,
    #[allow(dead_code)]
    pub source_price_usd: Option<f64>,
    #[allow(dead_code)]
    pub target_price_usd: Option<f64>,
}

#[derive(Clone, Default)]
pub struct ArbGraph {
    pub g: DiGraph<String, EdgeData>,
    pub map: HashMap<String, NodeIndex>, // mint -> node (unified across DEXes)
}

impl ArbGraph {
    pub fn new() -> Self {
        Default::default()
    }

    pub fn upsert_node(&mut self, _dex: &str, mint: &str) -> NodeIndex {
        let key = mint.to_string();
        if let Some(&idx) = self.map.get(&key) {
            return idx;
        }
        // Use mint as node label; DEX is captured on edges
        let idx = self.g.add_node(mint.to_string());
        self.map.insert(key, idx);
        idx
    }

    pub fn upsert_edge(&mut self, dex: &str, mint_a: &str, mint_b: &str, data: EdgeData) {
        let a = self.upsert_node(dex, mint_a);
        let b = self.upsert_node(dex, mint_b);
        // Replace-or-dedup behavior:
        // - If pool_id is present, remove any existing edge with the same pool_id between (a,b)
        // - Otherwise, remove existing edges between (a,b) with the same DEX and empty pool_id
        let new_pool_id = data.pool_id.clone();
        let new_dex = data.dex.clone();
        let mut to_remove = Vec::new();
        // OPTIMIZATION: Use edges_connecting instead of edge_references
        // This changes complexity from O(E) to O(degree(a)), typically 100-1000x faster
        for e in self.g.edges_connecting(a, b) {
            let w = e.weight();
            if !new_pool_id.is_empty() {
                if w.pool_id == new_pool_id {
                    to_remove.push(e.id());
                }
            } else {
                if w.pool_id.is_empty() && w.dex == new_dex {
                    to_remove.push(e.id());
                }
            }
        }
        // Sort in reverse order to avoid petgraph swap-remove invalidation:
        // remove_edge uses swap-remove, moving the last edge into the removed
        // slot. Removing highest indices first keeps lower indices stable.
        to_remove.sort_by(|a, b| b.cmp(a));
        for id in to_remove {
            let _ = self.g.remove_edge(id);
        }
        self.g.add_edge(a, b, data);
    }

    // Compute a stable edge id consistent with backend snapshot logic
    fn compute_edge_id(&self, src: NodeIndex, dst: NodeIndex, data: &EdgeData) -> String {
        let a = self.g.node_weight(src).cloned().unwrap_or_default();
        let b = self.g.node_weight(dst).cloned().unwrap_or_default();
        let dex = data.dex.clone();
        if !data.pool_id.is_empty() {
            return data.pool_id.clone();
        }
        format!("{}->{}-{}", a, b, dex)
    }

    pub fn remove_edges_by_ids(&mut self, ids: &[String]) -> usize {
        if ids.is_empty() {
            return 0;
        }
        let mut expanded: Vec<String> = Vec::with_capacity(ids.len() * 2);
        for id in ids {
            if id.is_empty() {
                continue;
            }
            expanded.push(id.clone());
            if let Some(base) = id.strip_suffix("#rev") {
                expanded.push(base.to_string());
            } else {
                expanded.push(format!("{id}#rev"));
            }
        }
        let set: std::collections::HashSet<String> = expanded.into_iter().collect();
        let mut to_remove = Vec::new();

        // OPTIMIZATION: Avoid string allocations by checking pool_id first
        for e in self.g.edge_references() {
            let w = e.weight();
            // Fast path: check pool_id directly (no allocation)
            if !w.pool_id.is_empty() {
                if set.contains(&w.pool_id) {
                    to_remove.push(e.id());
                }
            } else {
                // Slow path: compute synthetic ID only when pool_id is empty
                let eid = self.compute_edge_id(e.source(), e.target(), w);
                if set.contains(&eid) {
                    to_remove.push(e.id());
                }
            }
        }

        let n = to_remove.len();
        // Sort in reverse order to avoid petgraph swap-remove invalidation:
        // remove_edge uses swap-remove, moving the last edge into the removed
        // slot. Removing highest indices first keeps lower indices stable.
        to_remove.sort_by(|a, b| b.cmp(a));
        for idx in to_remove {
            let _ = self.g.remove_edge(idx);
        }
        n
    }
}

/// Expand a set of starting node indices by up to `max_hops` hops over both
/// incoming and outgoing edges. Returns the set of node indices reachable within
/// the hop budget including the starting nodes.
pub fn expand_nodes_by_hops(
    g: &ArbGraph,
    starts: &std::collections::HashSet<usize>,
    max_hops: usize,
) -> std::collections::HashSet<usize> {
    use petgraph::Direction::{Incoming, Outgoing};
    use std::collections::HashSet;
    let mut out: HashSet<usize> = starts.clone();
    if max_hops == 0 || starts.is_empty() {
        return out;
    }
    let mut frontier: HashSet<usize> = starts.clone();
    for _ in 0..max_hops {
        let mut next: HashSet<usize> = HashSet::new();
        for &u in frontier.iter() {
            let ui = NodeIndex::new(u);
            for v in g.g.neighbors_directed(ui, Outgoing) {
                if out.insert(v.index()) {
                    next.insert(v.index());
                }
            }
            for v in g.g.neighbors_directed(ui, Incoming) {
                if out.insert(v.index()) {
                    next.insert(v.index());
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_nodes_and_edges() {
        let mut g = ArbGraph::new();
        g.upsert_edge(
            "Raydium",
            "SOL",
            "USDC",
            EdgeData {
                rate_effective: 24.5,
                fee_bps: 30,
                liquidity: 1000.0,
                dex: "Raydium".into(),
                pool_id: String::new(),
                liquidity_display: 1000.0,
                native_mint_a: None,
                native_mint_b: None,
                native_decimals_a: None,
                native_decimals_b: None,
                native_account_a: None,
                native_account_b: None,
                native_reserve_a_raw: None,
                native_reserve_b_raw: None,
                pool_kind: None,
                capacity_input_raw: None,
                slippage_curve: None,
                source_price_usd: None,
                target_price_usd: None,
            },
        );
        g.upsert_edge(
            "Raydium",
            "USDC",
            "SOL",
            EdgeData {
                rate_effective: 0.0408,
                fee_bps: 30,
                liquidity: 1000.0,
                dex: "Raydium".into(),
                pool_id: String::new(),
                liquidity_display: 1000.0,
                native_mint_a: None,
                native_mint_b: None,
                native_decimals_a: None,
                native_decimals_b: None,
                native_account_a: None,
                native_account_b: None,
                native_reserve_a_raw: None,
                native_reserve_b_raw: None,
                pool_kind: None,
                capacity_input_raw: None,
                slippage_curve: None,
                source_price_usd: None,
                target_price_usd: None,
            },
        );
        assert!(g.g.node_count() >= 2);
        assert!(g.g.edge_count() >= 2);
    }

    #[test]
    fn expand_hops_reaches_expected_nodes() {
        use std::collections::HashSet;
        let mut g = ArbGraph::new();
        // Create a simple line 0->1->2->3 and also a back edge 2->0
        let dex = "D".to_string();
        let e = |rate| EdgeData {
            rate_effective: rate,
            fee_bps: 0,
            liquidity: 1.0,
            dex: dex.clone(),
            pool_id: String::new(),
            liquidity_display: 1.0,
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
            pool_kind: None,
            capacity_input_raw: None,
            slippage_curve: None,
            source_price_usd: None,
            target_price_usd: None,
        };
        g.upsert_edge(&dex, "0", "1", e(1.0));
        g.upsert_edge(&dex, "1", "2", e(1.0));
        g.upsert_edge(&dex, "2", "3", e(1.0));
        g.upsert_edge(&dex, "2", "0", e(1.0));
        // Map mints to indices
        let i0 = g.map.get("0").unwrap().index();
        let i1 = g.map.get("1").unwrap().index();
        let i2 = g.map.get("2").unwrap().index();
        let i3 = g.map.get("3").unwrap().index();
        let mut starts: HashSet<usize> = HashSet::new();
        starts.insert(i1);
        let s1 = expand_nodes_by_hops(&g, &starts, 1);
        assert!(s1.contains(&i0) && s1.contains(&i1) && s1.contains(&i2));
        assert!(!s1.contains(&i3));
        let s2 = expand_nodes_by_hops(&g, &starts, 2);
        assert!(s2.contains(&i3));
    }

    #[test]
    fn remove_edges_by_ids_handles_pool_and_synth_ids() {
        let mut g = ArbGraph::new();
        // Two parallel edges between A->B: one with pool_id, one synthesized for dex
        let dex = "R".to_string();
        let edge_pool = EdgeData {
            rate_effective: 1.0,
            fee_bps: 0,
            liquidity: 1.0,
            dex: dex.clone(),
            pool_id: "POOL123".to_string(),
            liquidity_display: 1.0,
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
            pool_kind: None,
            capacity_input_raw: None,
            slippage_curve: None,
            source_price_usd: None,
            target_price_usd: None,
        };
        let edge_synth = EdgeData {
            rate_effective: 1.0,
            fee_bps: 0,
            liquidity: 1.0,
            dex: dex.clone(),
            pool_id: String::new(),
            liquidity_display: 1.0,
            native_mint_a: None,
            native_mint_b: None,
            native_decimals_a: None,
            native_decimals_b: None,
            native_account_a: None,
            native_account_b: None,
            native_reserve_a_raw: None,
            native_reserve_b_raw: None,
            pool_kind: None,
            capacity_input_raw: None,
            slippage_curve: None,
            source_price_usd: None,
            target_price_usd: None,
        };
        g.upsert_edge(&dex, "A", "B", edge_pool);
        g.upsert_edge(&dex, "A", "B", edge_synth);
        assert_eq!(g.g.edge_count(), 2);
        // Build ids
        let a = *g.map.get("A").unwrap();
        let b = *g.map.get("B").unwrap();
        let synth_id = format!("A->B-{}", dex);
        // Remove by pool id only
        let removed1 = g.remove_edges_by_ids(&vec!["POOL123".to_string()]);
        assert_eq!(removed1, 1);
        assert_eq!(g.g.edge_count(), 1);
        // Remove remaining synthesized id
        let removed2 = g.remove_edges_by_ids(&vec![synth_id]);
        assert_eq!(removed2, 1);
        assert_eq!(g.g.edge_count(), 0);
        // Sanity to use a,b to avoid unused warnings
        let _ = (a.index(), b.index());
    }
}
