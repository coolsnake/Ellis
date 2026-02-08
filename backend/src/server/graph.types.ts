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
  native_mint_a?: string;
  native_mint_b?: string;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_account_a?: string;
  native_account_b?: string;
  native_reserve_a_raw?: string;
  native_reserve_b_raw?: string;
  fee_bps?: number;
  source_price_usd?: number; // USD price for source mint (if known)
  target_price_usd?: number; // USD price for target mint (if known)
  liquidity?: number;    // normalized liquidity signal (used for layout/weight)
  liquidity_display?: number; // display: prefer USD TVL, else raw pool liquidity
  weight?: number;       // layout weight (derived from liquidity / fee)
  price_a_per_b?: number; // B per 1 A (how many B for 1 A)
  tvl_usd?: number;       // approximate TVL in USD for layout/inspection
  pool_kind?: 'amm' | 'clmm' | 'dlmm' | 'cpmm'; // explicit pool kind
  direction?: 'canonical'; // edges are stored in canonical orientation only
  pool_liquidity_raw?: number; // raw pool liquidity metric when provided by the source (e.g., CLMM liquidity)
  /** Max reasonable input in source (edge input) token raw atoms; used for sizing/cap in arb-rs (no USD). */
  capacity_input_raw?: string;
  was_swapped?: boolean; // Track if pool was swapped during canonicalization
  slippage_curve?: {
    unit: 'usd' | 'source';
    sizes: number[];   // size points (USD or source token units)
    mults: number[];   // output multipliers (dimensionless; source-unit uses spot_rate * mult)
    computed_at: number;
    confidence?: 'low' | 'medium' | 'high';
    source?: string;
  };
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


