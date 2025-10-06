import type { GraphDiff, GraphSnapshot, GraphEdge, GraphNode } from './graph.types.js';

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
    else if (JSON.stringify(p) !== JSON.stringify(n)) updatedNodes.push(n);
  }
  for (const [id] of pNodes) if (!nNodes.has(id)) removedNodeIds.push(id);

  const addedEdges: GraphEdge[] = [];
  const updatedEdges: GraphEdge[] = [];
  const removedEdgeIds: string[] = [];
  for (const [id, e] of nEdges) {
    const p = pEdges.get(id);
    if (!p) addedEdges.push(e);
    else if (JSON.stringify(p) !== JSON.stringify(e)) updatedEdges.push(e);
  }
  for (const [id] of pEdges) if (!nEdges.has(id)) removedEdgeIds.push(id);

  return {
    version: next.version,
    timestamp: next.timestamp,
    addedNodes, updatedNodes, removedNodeIds,
    addedEdges, updatedEdges, removedEdgeIds,
  };
}


