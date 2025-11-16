import type { GraphDiff, GraphSnapshot } from '../server/graph.types.js';
import type { PoolsPayload } from '../server/pools/types.js';
import type { EdgeAllow } from '../server/graph.edges.js';

export interface GraphIncrementalRequest {
  previousSnapshot: GraphSnapshot;
  previousPools: PoolsPayload;
  nextPools: PoolsPayload;
  droppedPoolIds: string[];
  edgeAllow: EdgeAllow;
  priceMap: Record<string, number>;
  decimalsMap: Record<string, number>;
  priceClampMin?: number;
  priceClampMax?: number;
  timestampMs: number;
}

export interface GraphIncrementalStats {
  addedEdges: number;
  updatedEdges: number;
  removedEdges: number;
  addedNodes: number;
  removedNodes: number;
}

export interface GraphIncrementalResult {
  changed: boolean;
  snapshot?: GraphSnapshot;
  diff?: GraphDiff;
  stats: GraphIncrementalStats;
}

export type GraphWorkerRequest = {
  kind: 'incremental';
  payload: GraphIncrementalRequest;
};

export type GraphWorkerResponse = GraphIncrementalResult;


