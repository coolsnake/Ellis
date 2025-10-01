use petgraph::graph::{DiGraph, NodeIndex};
use std::collections::HashMap;

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


