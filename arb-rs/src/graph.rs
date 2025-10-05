use petgraph::graph::{DiGraph, NodeIndex};
use std::collections::HashMap;
use petgraph::visit::EdgeRef;

#[derive(Clone, Debug)]
pub struct EdgeData {
    pub rate_effective: f64, // after fees/slippage
    #[allow(dead_code)] pub fee_bps: i64,
    #[allow(dead_code)] pub liquidity: f64, // in base units
    #[allow(dead_code)] pub dex: String,
    #[allow(dead_code)] pub pool_id: String,
    #[allow(dead_code)] pub liquidity_display: f64,
}

#[derive(Default)]
pub struct ArbGraph {
    pub g: DiGraph<String, EdgeData>,
    pub map: HashMap<String, NodeIndex>, // mint -> node (unified across DEXes)
}

impl ArbGraph {
    pub fn new() -> Self { Default::default() }

    pub fn upsert_node(&mut self, _dex: &str, mint: &str) -> NodeIndex {
        let key = mint.to_string();
        if let Some(&idx) = self.map.get(&key) { return idx; }
        // Use mint as node label; DEX is captured on edges
        let idx = self.g.add_node(mint.to_string());
        self.map.insert(key, idx);
        idx
    }

    pub fn upsert_edge(&mut self, dex: &str, mint_a: &str, mint_b: &str, data: EdgeData) {
        let a = self.upsert_node(dex, mint_a);
        let b = self.upsert_node(dex, mint_b);
        // For MVP, just add parallel edges; later replace existing
        self.g.add_edge(a, b, data);
    }

    // Compute a stable edge id consistent with backend snapshot logic
    fn compute_edge_id(&self, src: NodeIndex, dst: NodeIndex, data: &EdgeData) -> String {
        let a = self.g.node_weight(src).cloned().unwrap_or_default();
        let b = self.g.node_weight(dst).cloned().unwrap_or_default();
        let dex = data.dex.clone();
        if !data.pool_id.is_empty() { return data.pool_id.clone(); }
        format!("{}->{}-{}", a, b, dex)
    }

    pub fn remove_edge_by_id(&mut self, id: &str) -> usize {
        let mut to_remove = Vec::new();
        for e in self.g.edge_references() {
            let eid = self.compute_edge_id(e.source(), e.target(), e.weight());
            if eid == id { to_remove.push(e.id()); }
        }
        let n = to_remove.len();
        for idx in to_remove { let _ = self.g.remove_edge(idx); }
        n
    }

    pub fn remove_edges_by_ids(&mut self, ids: &[String]) -> usize {
        let set: std::collections::HashSet<&String> = ids.iter().collect();
        let mut to_remove = Vec::new();
        for e in self.g.edge_references() {
            let eid = self.compute_edge_id(e.source(), e.target(), e.weight());
            if set.contains(&eid) { to_remove.push(e.id()); }
        }
        let n = to_remove.len();
        for idx in to_remove { let _ = self.g.remove_edge(idx); }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upsert_nodes_and_edges() {
        let mut g = ArbGraph::new();
        g.upsert_edge("Raydium", "SOL", "USDC", EdgeData { rate_effective: 24.5, fee_bps: 30, liquidity: 1000.0, dex: "Raydium".into() });
        g.upsert_edge("Raydium", "USDC", "SOL", EdgeData { rate_effective: 0.0408, fee_bps: 30, liquidity: 1000.0, dex: "Raydium".into() });
        assert!(g.g.node_count() >= 2);
        assert!(g.g.edge_count() >= 2);
    }
}


