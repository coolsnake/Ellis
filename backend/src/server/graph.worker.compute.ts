import { edgesFromPoolIncremental, edgeChangedSimple, isDexKindAllowed, isPoolValidForGraph, type EdgeBuildOptions } from './graph.edges.js';
import type { GraphDiff, GraphEdge, GraphNode, GraphSnapshot } from './graph.types.js';
import type { PoolsPayload, AmmPool, ClmmPool } from './pools/types.js';
import type { GraphIncrementalRequest, GraphIncrementalResult } from '../workers/graphDiff.types.js';

type Pool = AmmPool | ClmmPool;

const EPSILON = 1e-9;

function poolChanged(prev: Pool | undefined, next: Pool): boolean {
  if (!prev) return true;
  const kind = ((next as any)?.pool_kind || ((next as any)?.sqrt_price_x64_raw != null || typeof (next as any)?.sqrt_price_x64 === 'number') ? 'clmm' : 'amm') as 'amm' | 'clmm';
  if (kind === 'clmm') {
    if ((prev as any).sqrt_price_x64_raw && (next as any).sqrt_price_x64_raw && (prev as any).sqrt_price_x64_raw !== (next as any).sqrt_price_x64_raw) return true;
    if ((prev as any).price_a_per_b_num && (prev as any).price_a_per_b_den && (next as any).price_a_per_b_num && (next as any).price_a_per_b_den) {
      if ((prev as any).price_a_per_b_num !== (next as any).price_a_per_b_num || (prev as any).price_a_per_b_den !== (next as any).price_a_per_b_den) return true;
    }
    if ((prev as any).liquidity_raw && (next as any).liquidity_raw && (prev as any).liquidity_raw !== (next as any).liquidity_raw) return true;
    if (Math.abs(((prev as any).liquidity || 0) - ((next as any).liquidity || 0)) > 0) return true;
    if (((prev as any).tvl_usd || 0) !== ((next as any).tvl_usd || 0)) return true;
    if (Math.abs(((prev as any).price_a_per_b || 0) - ((next as any).price_a_per_b || 0)) > EPSILON) return true;
  } else {
    if ((prev as any).reserve_a_raw && (prev as any).reserve_b_raw && (next as any).reserve_a_raw && (next as any).reserve_b_raw) {
      if ((prev as any).reserve_a_raw !== (next as any).reserve_a_raw || (prev as any).reserve_b_raw !== (next as any).reserve_b_raw) return true;
    }
    if (Math.abs(((prev as any).price_a_per_b || 0) - ((next as any).price_a_per_b || 0)) > EPSILON) return true;
    if (Math.abs(((prev as any).liquidity_base || 0) - ((next as any).liquidity_base || 0)) > EPSILON) return true;
    if ((prev as any).liquidity_base_raw && (next as any).liquidity_base_raw && (prev as any).liquidity_base_raw !== (next as any).liquidity_base_raw) return true;
    if (((prev as any).tvl_usd || 0) !== ((next as any).tvl_usd || 0)) return true;
  }
  const nextMs = Number((next as any)?.updated_ms || 0);
  const prevMs = Number((prev as any)?.updated_ms || 0);
  if (nextMs > 0 && prevMs > 0 && nextMs > prevMs) return true;
  return false;
}

function buildPriceAccessor(priceMap: Record<string, number>): (mint: string) => number | undefined {
  const map = new Map<string, number>();
  for (const [mint, value] of Object.entries(priceMap || {})) {
    const v = Number(value);
    if (Number.isFinite(v) && v > 0) map.set(mint, v);
  }
  return (mint: string) => map.get(String(mint)) ?? undefined;
}

export function computeIncrementalGraphUpdate(request: GraphIncrementalRequest): GraphIncrementalResult {
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
  const edgesMap = new Map<string, GraphEdge>(prevSnapshot.edges.map((e) => [String(e.id), { ...e }]));
  const nodesMap = new Map<string, GraphNode>(prevSnapshot.nodes.map((n) => [String(n.id), { ...n }]));

  const prevA = new Set((previousPools?.amm || []).map((p: any) => String(p?.id || '')));
  const prevC = new Set((previousPools?.clmm || []).map((p: any) => String(p?.id || '')));
  const nextA = new Set((nextPools?.amm || []).map((p: any) => String(p?.id || '')));
  const nextC = new Set((nextPools?.clmm || []).map((p: any) => String(p?.id || '')));

  const droppedSet = new Set<string>((droppedPoolIds || []).map((s) => String(s)));

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

  for (const pid of droppedSet) {
    if (edgesMap.delete(pid)) removedEdgeIds.push(pid);
  }

  const prevPoolsById: Map<string, Pool> = new Map(
    [...(previousPools?.amm || []), ...(previousPools?.clmm || [])].map((p: any) => [String(p?.id || ''), p as Pool]),
  );

  const addedEdges: GraphEdge[] = [];
  const updatedEdges: GraphEdge[] = [];
  const addedNodes: GraphNode[] = [];
  const removedNodeIds: string[] = [];
  
  // Track edge IDs that existed in the original snapshot for accurate "added" vs "restored" distinction
  const originalEdgeIds = new Set(prevSnapshot.edges.map((e) => String(e.id)));
  const originalNodeIds = new Set(prevSnapshot.nodes.map((n) => String(n.id)));

  const getUsd = buildPriceAccessor(priceMap || {});
  const considered: Pool[] = [...(nextPools?.amm || []), ...(nextPools?.clmm || [])] as Pool[];
  const edgeOptions: EdgeBuildOptions = { 
    priceClampMin, 
    priceClampMax,
  };
  // Use defaults for incremental updates as we don't have access to CONFIG
  const validationConfig = {
    sanityEnabled: true // Default safe
  };

  for (const pool of considered) {
    const id = String((pool as any)?.id || '');
    if (!id) continue;
    if (droppedSet.has(id)) continue;
    const prevPool = prevPoolsById.get(id);
    const changed = poolChanged(prevPool, pool);
    const dex = String((pool as any)?.dex || '');
    const kind = ((pool as any)?.pool_kind || (typeof (pool as any)?.sqrt_price_x64 === 'number' ? 'clmm' : 'amm')) as 'amm' | 'clmm';
    
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

    const mintA = String((pool as any)?.mint_a || '');
    const mintB = String((pool as any)?.mint_b || '');
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

  const incident = new Map<string, number>();
  for (const edge of edgesMap.values()) {
    incident.set(edge.source, (incident.get(edge.source) || 0) + 1);
    incident.set(edge.target, (incident.get(edge.target) || 0) + 1);
  }
  for (const [id] of nodesMap) {
    if (!incident.has(id)) {
      nodesMap.delete(id);
      removedNodeIds.push(id);
    }
  }

  const changed = Boolean(
    addedEdges.length ||
    updatedEdges.length ||
    removedEdgeIds.length ||
    addedNodes.length ||
    removedNodeIds.length,
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


