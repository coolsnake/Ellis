import type { GraphDiff, GraphSnapshot, GraphEdge, GraphNode } from './graph.types.js';
import { CONFIG } from '../utils/config.js';

const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
const small = (x: number) => !Number.isFinite(x) || Math.abs(x) < 1e-12;

const LIQ_EPS = Math.max(1e-6, Number((CONFIG as any)?.system?.graphDiffLiqEps ?? 0.01));
const PX_EPS  = Math.max(1e-6, Number((CONFIG as any)?.system?.graphDiffPriceEps ?? 0.002));
const W_EPS   = Math.max(1e-6, Number((CONFIG as any)?.system?.graphDiffWeightEps ?? 0.01));

function nodesEqual(a: any, b: any): boolean {
  return String(a.id) === String(b.id)
    && String(a.label || '') === String(b.label || '')
    && Number(a.degree || 0) === Number(b.degree || 0);
}

function edgesEqual(a: any, b: any): boolean {
  if (String(a.id) !== String(b.id)) return false;
  if (String(a.source) !== String(b.source)) return false;
  if (String(a.target) !== String(b.target)) return false;
  if (String(a.dex || '') !== String(b.dex || '')) return false;
  if (String(a.pool_id || '') !== String(b.pool_id || '')) return false;
  const liqa = Number(a.liquidity_display ?? a.liquidity ?? 0);
  const liqb = Number(b.liquidity_display ?? b.liquidity ?? 0);
  const pxa  = Number(a.price_a_per_b ?? 0);
  const pxb  = Number(b.price_a_per_b ?? 0);
  const wa   = Number(a.weight ?? 0);
  const wb   = Number(b.weight ?? 0);
  const liqOk = (small(liqa) && small(liqb)) || pct(liqb, liqa) < LIQ_EPS;
  const pxOk  = (small(pxa)  && small(pxb))  || pct(pxb, pxa)   < PX_EPS;
  const wOk   = (small(wa)   && small(wb))   || pct(wb, wa)     < W_EPS;
  return liqOk && pxOk && wOk
    && Number(a.fee_bps ?? -1) === Number(b.fee_bps ?? -1)
    && String(a.pool_kind || '') === String(b.pool_kind || '')
    && String(a.direction || '') === String(b.direction || '');
}

export function diffSnapshots(prev: GraphSnapshot | null, next: GraphSnapshot): GraphDiff {
  const pNodes = new Map(prev?.nodes.map(n => [n.id, n]) || []);
  const pEdges = new Map(prev?.edges.map(e => [e.id, e]) || []);
  const nNodes = new Map(next.nodes.map(n => [n.id, n]));
  const nEdges = new Map(next.edges.map(e => [e.id, e]));

  const addedNodes: GraphNode[] = [];
  const updatedNodes: GraphNode[] = [];
  const removedNodeIds: string[] = [];
  for (const [id, n] of nNodes) {
    const p = pNodes.get(id);
    if (!p) addedNodes.push(n);
    else if (!nodesEqual(p, n)) updatedNodes.push(n);
  }
  for (const [id] of pNodes) if (!nNodes.has(id)) removedNodeIds.push(id);

  const addedEdges: GraphEdge[] = [];
  const updatedEdges: GraphEdge[] = [];
  const removedEdgeIds: string[] = [];
  for (const [id, e] of nEdges) {
    const p = pEdges.get(id);
    if (!p) addedEdges.push(e);
    else if (!edgesEqual(p, e)) updatedEdges.push(e);
  }
  for (const [id] of pEdges) if (!nEdges.has(id)) removedEdgeIds.push(id);

  return {
    version: next.version,
    timestamp: next.timestamp,
    addedNodes, updatedNodes, removedNodeIds,
    addedEdges, updatedEdges, removedEdgeIds,
  };
}


