export type GraphNode = {
  id: string;            // mint address (base58)
  label?: string;        // symbol if known
  degree?: number;       // computed degree (optional)
};

export type GraphEdge = {
  id: string;            // `${source}-${target}-${dex}` stable
  source: string;        // mint
  target: string;        // mint
  dex: string;           // Raydium | Orca | ...
  pool_id?: string;      // underlying pool address when available
  source_account?: string; // token account/vault corresponding to source
  target_account?: string; // token account/vault corresponding to target
  fee_bps?: number;
  liquidity?: number;    // normalized liquidity signal (used for layout/weight)
  liquidity_display?: number; // display: prefer USD TVL, else raw pool liquidity
  weight?: number;       // layout weight (derived from liquidity / fee)
  price_a_per_b?: number; // A per 1 B
  tvl_usd?: number;       // approximate TVL in USD for layout/inspection
  pool_kind?: 'amm' | 'clmm'; // explicit pool kind
  direction?: 'canonical'; // edges are stored in canonical orientation only
  pool_liquidity_raw?: number; // raw pool liquidity metric when provided by the source (e.g., CLMM liquidity)
};

export type GraphSnapshot = {
  version: number;
  timestamp: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphDiff = {
  version: number;
  timestamp: number;
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodeIds: string[];
  addedEdges: GraphEdge[];
  updatedEdges: GraphEdge[];
  removedEdgeIds: string[];
};


