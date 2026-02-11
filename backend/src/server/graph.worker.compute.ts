import {
  edgesFromPoolIncremental,
  edgeChangedSimple,
  isDexKindAllowed,
  isPoolValidForGraph,
  type EdgeBuildOptions,
} from "./graph.edges.js";
import type {
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from "./graph.types.js";
import type {
  PoolsPayload,
  AmmPool,
  ClmmPool,
  CpmmPool,
} from "./pools/types.js";
import type {
  GraphIncrementalRequest,
  GraphIncrementalResult,
} from "../workers/graphDiff.types.js";

type Pool = AmmPool | ClmmPool | CpmmPool;

const EPSILON = 1e-9;

function poolChanged(prev: Pool | undefined, next: Pool): boolean {
  if (!prev) return true;
  const poolKind = (next as any)?.pool_kind;
  const kind =
    poolKind === "clmm" ||
    poolKind === "dlmm" ||
    poolKind === "cpmm" ||
    poolKind === "amm"
      ? poolKind
      : (((next as any)?.sqrt_price_x64_raw != null ||
        typeof (next as any)?.sqrt_price_x64 === "number"
          ? "clmm"
          : "amm") as "amm" | "clmm" | "dlmm" | "cpmm");
  if (kind === "clmm" || kind === "dlmm") {
    if (
      (prev as any).sqrt_price_x64_raw &&
      (next as any).sqrt_price_x64_raw &&
      (prev as any).sqrt_price_x64_raw !== (next as any).sqrt_price_x64_raw
    )
      return true;
    if (
      (prev as any).price_a_per_b_num &&
      (prev as any).price_a_per_b_den &&
      (next as any).price_a_per_b_num &&
      (next as any).price_a_per_b_den
    ) {
      if (
        (prev as any).price_a_per_b_num !== (next as any).price_a_per_b_num ||
        (prev as any).price_a_per_b_den !== (next as any).price_a_per_b_den
      )
        return true;
    }
    if (
      (prev as any).liquidity_raw &&
      (next as any).liquidity_raw &&
      (prev as any).liquidity_raw !== (next as any).liquidity_raw
    )
      return true;
    if (
      Math.abs(
        ((prev as any).liquidity || 0) - ((next as any).liquidity || 0)
      ) > 0
    )
      return true;
    if (((prev as any).tvl_usd || 0) !== ((next as any).tvl_usd || 0))
      return true;
    if (
      Math.abs(
        ((prev as any).price_a_per_b || 0) - ((next as any).price_a_per_b || 0)
      ) > EPSILON
    )
      return true;
  } else {
    if (
      (prev as any).reserve_a_raw &&
      (prev as any).reserve_b_raw &&
      (next as any).reserve_a_raw &&
      (next as any).reserve_b_raw
    ) {
      if (
        (prev as any).reserve_a_raw !== (next as any).reserve_a_raw ||
        (prev as any).reserve_b_raw !== (next as any).reserve_b_raw
      )
        return true;
    }
    if (
      Math.abs(
        ((prev as any).price_a_per_b || 0) - ((next as any).price_a_per_b || 0)
      ) > EPSILON
    )
      return true;
    if (
      Math.abs(
        ((prev as any).liquidity_base || 0) -
          ((next as any).liquidity_base || 0)
      ) > EPSILON
    )
      return true;
    if (
      (prev as any).liquidity_base_raw &&
      (next as any).liquidity_base_raw &&
      (prev as any).liquidity_base_raw !== (next as any).liquidity_base_raw
    )
      return true;
    if (((prev as any).tvl_usd || 0) !== ((next as any).tvl_usd || 0))
      return true;
  }
  // NOTE: updated_ms fallback removed — decoders always set updated_ms = Date.now()
  // on every decode, so this caused every pool to appear "changed" even when
  // price/reserves were identical. The field-level checks above are sufficient.
  return false;
}

function buildPriceAccessor(
  priceMap: Record<string, number>
): (mint: string) => number | undefined {
  const map = new Map<string, number>();
  for (const [mint, value] of Object.entries(priceMap || {})) {
    const v = Number(value);
    if (Number.isFinite(v) && v > 0) map.set(mint, v);
  }
  return (mint: string) => map.get(String(mint)) ?? undefined;
}

export function computeIncrementalGraphUpdate(
  request: GraphIncrementalRequest
): GraphIncrementalResult {
  const {
    previousSnapshot,
    previousPools,
    nextPools,
    droppedPoolIds,
    edgeAllow,
    priceMap,
    priceClampMin,
    priceClampMax,
    timestampMs,
  } = request;

  const prevSnapshot = previousSnapshot;
  const edgesMap = new Map<string, GraphEdge>(
    prevSnapshot.edges.map((e) => [String(e.id), { ...e }])
  );
  const nodesMap = new Map<string, GraphNode>(
    prevSnapshot.nodes.map((n) => [String(n.id), { ...n }])
  );

  const prevA = new Set(
    (previousPools?.amm || []).map((p: any) => String(p?.id || ""))
  );
  const prevC = new Set(
    (previousPools?.clmm || []).map((p: any) => String(p?.id || ""))
  );
  const prevCpmm = new Set(
    (previousPools?.cpmm || []).map((p: any) => String(p?.id || ""))
  );
  const nextA = new Set(
    (nextPools?.amm || []).map((p: any) => String(p?.id || ""))
  );
  const nextC = new Set(
    (nextPools?.clmm || []).map((p: any) => String(p?.id || ""))
  );
  const nextCpmm = new Set(
    (nextPools?.cpmm || []).map((p: any) => String(p?.id || ""))
  );

  const droppedSet = new Set<string>(
    (droppedPoolIds || []).map((s) => String(s))
  );

  const removedEdgeIds: string[] = [];

  for (const id of prevA) {
    if (!nextA.has(id)) {
      if (edgesMap.delete(id)) removedEdgeIds.push(id);
    }
  }
  for (const id of prevC) {
    if (!nextC.has(id)) {
      if (edgesMap.delete(id)) removedEdgeIds.push(id);
    }
  }
  for (const id of prevCpmm) {
    if (!nextCpmm.has(id)) {
      if (edgesMap.delete(id)) removedEdgeIds.push(id);
    }
  }

  for (const pid of droppedSet) {
    if (edgesMap.delete(pid)) removedEdgeIds.push(pid);
  }

  const prevPoolsById: Map<string, Pool> = new Map(
    [
      ...(previousPools?.amm || []),
      ...(previousPools?.clmm || []),
      ...(previousPools?.cpmm || []),
    ].map((p: any) => [String(p?.id || ""), p as Pool])
  );

  const addedEdges: GraphEdge[] = [];
  const updatedEdges: GraphEdge[] = [];
  const addedNodes: GraphNode[] = [];
  const removedNodeIds: string[] = [];

  // Track edge IDs that existed in the original snapshot for accurate "added" vs "restored" distinction
  const originalEdgeIds = new Set(prevSnapshot.edges.map((e) => String(e.id)));
  const originalNodeIds = new Set(prevSnapshot.nodes.map((n) => String(n.id)));

  const getUsd = buildPriceAccessor(priceMap || {});
  const considered: Pool[] = [
    ...(nextPools?.amm || []),
    ...(nextPools?.clmm || []),
    ...(nextPools?.cpmm || []),
  ] as Pool[];
  const edgeOptions: EdgeBuildOptions = {
    priceClampMin,
    priceClampMax,
  };
  // Use defaults for incremental updates as we don't have access to CONFIG
  const validationConfig = {
    sanityEnabled: true, // Default safe
  };

  for (const pool of considered) {
    const id = String((pool as any)?.id || "");
    if (!id) continue;
    if (droppedSet.has(id)) continue;
    const prevPool = prevPoolsById.get(id);
    const changed = poolChanged(prevPool, pool);
    const dex = String((pool as any)?.dex || "");
    const kind = ((pool as any)?.pool_kind ||
      (typeof (pool as any)?.sqrt_price_x64 === "number" ? "clmm" : "amm")) as
      | "amm"
      | "clmm"
      | "dlmm"
      | "cpmm";

    if (!isDexKindAllowed(dex, kind, edgeAllow || {})) continue;

    // Protect incremental updates with same validity checks as snapshot
    if (!isPoolValidForGraph(pool, getUsd, validationConfig)) continue;

    if (!changed) continue;

    const newEdges = edgesFromPoolIncremental(pool, getUsd, edgeOptions);
    for (const edge of newEdges) {
      const current = edgesMap.get(edge.id);
      if (!current) {
        edgesMap.set(edge.id, edge);
        // Only report as "added" if it's truly new (wasn't in the original snapshot)
        // This prevents churn from showing as additions when edges are temporarily removed then re-added
        if (!originalEdgeIds.has(edge.id)) {
          addedEdges.push(edge);
        } else {
          // Edge was in original snapshot but got removed earlier in this cycle; treat as update
          updatedEdges.push(edge);
        }
      } else {
        edgesMap.set(edge.id, edge);
        if (edgeChangedSimple(current, edge) || changed) {
          updatedEdges.push(edge);
        }
      }
    }

    const mintA = String((pool as any)?.mint_a || "");
    const mintB = String((pool as any)?.mint_b || "");
    if (mintA && !nodesMap.has(mintA)) {
      const node: GraphNode = { id: mintA };
      nodesMap.set(mintA, node);
      // Only report as "added" if it's truly new (wasn't in the original snapshot)
      if (!originalNodeIds.has(mintA)) {
        addedNodes.push(node);
      }
    }
    if (mintB && !nodesMap.has(mintB)) {
      const node: GraphNode = { id: mintB };
      nodesMap.set(mintB, node);
      // Only report as "added" if it's truly new (wasn't in the original snapshot)
      if (!originalNodeIds.has(mintB)) {
        addedNodes.push(node);
      }
    }
  }

  // Capture pre-prune sets for diff tracking
  const prePruneNodeIds = new Set(nodesMap.keys());
  const prePruneEdgeIds = new Set(edgesMap.keys());

  pruneDeadEndNodes(nodesMap, edgesMap, request.pruneMinDegree ?? 2);

  // Track nodes removed by pruning
  for (const id of prePruneNodeIds) {
    if (!nodesMap.has(id)) removedNodeIds.push(id);
  }
  // Track edges removed by pruning (beyond those already tracked from pool removal)
  for (const eid of prePruneEdgeIds) {
    if (!edgesMap.has(eid) && !removedEdgeIds.includes(eid)) {
      removedEdgeIds.push(eid);
    }
  }

  const changed = Boolean(
    addedEdges.length ||
      updatedEdges.length ||
      removedEdgeIds.length ||
      addedNodes.length ||
      removedNodeIds.length
  );

  const stats = {
    addedEdges: addedEdges.length,
    updatedEdges: updatedEdges.length,
    removedEdges: removedEdgeIds.length,
    addedNodes: addedNodes.length,
    removedNodes: removedNodeIds.length,
  };

  if (!changed) {
    return { changed: false, stats };
  }

  const version = (previousSnapshot?.version || 0) + 1;
  const timestamp = timestampMs || Date.now();

  const snapshot: GraphSnapshot = {
    version,
    timestamp,
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values()),
  };

  const diff: GraphDiff = {
    version,
    timestamp,
    addedNodes,
    updatedNodes: [],
    removedNodeIds,
    addedEdges,
    updatedEdges,
    removedEdgeIds,
  };

  return {
    changed: true,
    snapshot,
    diff,
    stats,
  };
}

/**
 * Iteratively prune dead-end nodes (degree < minDegree) and their incident edges.
 * Cascading: removing a node may reduce its neighbor's degree, triggering further pruning.
 * Modifies both maps in place. O(V+E) via adjacency index.
 */
export function pruneDeadEndNodes(
  nodesMap: Map<string, GraphNode>,
  edgesMap: Map<string, GraphEdge>,
  minDegree: number
): { prunedNodes: number; prunedEdges: number } {
  if (minDegree < 1) return { prunedNodes: 0, prunedEdges: 0 };

  // Build degree and adjacency index
  const degree = new Map<string, number>();
  const adj = new Map<string, Set<string>>();

  for (const [eid, e] of edgesMap) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
    let srcSet = adj.get(e.source);
    if (!srcSet) {
      srcSet = new Set();
      adj.set(e.source, srcSet);
    }
    srcSet.add(eid);
    let tgtSet = adj.get(e.target);
    if (!tgtSet) {
      tgtSet = new Set();
      adj.set(e.target, tgtSet);
    }
    tgtSet.add(eid);
  }

  // Seed worklist with all nodes below minDegree
  const queue: string[] = [];
  for (const nodeId of nodesMap.keys()) {
    if ((degree.get(nodeId) || 0) < minDegree) {
      queue.push(nodeId);
    }
  }

  let prunedNodes = 0;
  let prunedEdges = 0;

  while (queue.length > 0) {
    const nodeId = queue.pop()!;
    if (!nodesMap.has(nodeId)) continue;
    if ((degree.get(nodeId) || 0) >= minDegree) continue;

    nodesMap.delete(nodeId);
    prunedNodes++;

    const incidentEdges = adj.get(nodeId);
    if (incidentEdges) {
      for (const eid of incidentEdges) {
        const edge = edgesMap.get(eid);
        if (!edge) continue;

        edgesMap.delete(eid);
        prunedEdges++;

        const neighbor = edge.source === nodeId ? edge.target : edge.source;
        const newDeg = (degree.get(neighbor) || 1) - 1;
        degree.set(neighbor, newDeg);
        adj.get(neighbor)?.delete(eid);
        if (newDeg > 0 && newDeg < minDegree) {
          queue.push(neighbor);
        }
      }
      adj.delete(nodeId);
    }
    degree.delete(nodeId);
  }

  return { prunedNodes, prunedEdges };
}
