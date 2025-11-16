import { describe, it, expect } from 'vitest';
import { computeIncrementalGraphUpdate } from '../graph.worker.compute.js';
import { edgesFromPoolIncremental } from '../graph.edges.js';
import type { GraphIncrementalRequest } from '../../workers/graphDiff.types.js';
import type { AmmPool } from '../pools/types.js';

const BASE_POOL: AmmPool = {
  id: 'pool-abc',
  dex: 'Raydium',
  mint_a: 'MintA',
  mint_b: 'MintB',
  fee_bps: 30,
  price_a_per_b: 1,
  liquidity_base: 1_000,
  liquidity_display: 1_000,
  updated_ms: 1_000,
  pool_kind: 'amm',
  decimals_a: 6,
  decimals_b: 6,
};

const PRICE_MAP = { MintA: 1, MintB: 1 };
const CLAMP_MIN = 1e-12;
const CLAMP_MAX = 1e12;

function makeSnapshot(price: number) {
  const pool = { ...BASE_POOL, price_a_per_b: price };
  const edges = edgesFromPoolIncremental(pool as any, () => 1, { priceClampMin: CLAMP_MIN, priceClampMax: CLAMP_MAX });
  return {
    version: 7,
    timestamp: 1_000,
    nodes: [{ id: 'MintA' }, { id: 'MintB' }],
    edges,
  };
}

describe('computeIncrementalGraphUpdate', () => {
  it('marks edges as updated when pool pricing changes', () => {
    const previousSnapshot = makeSnapshot(1);
    const request: GraphIncrementalRequest = {
      previousSnapshot,
      previousPools: { amm: [{ ...BASE_POOL }], clmm: [] },
      nextPools: { amm: [{ ...BASE_POOL, price_a_per_b: 1.1, updated_ms: 2_000 }], clmm: [] },
      droppedPoolIds: [],
      edgeAllow: {},
      priceMap: PRICE_MAP,
      decimalsMap: {},
      priceClampMin: CLAMP_MIN,
      priceClampMax: CLAMP_MAX,
      timestampMs: 2_000,
    };

    const result = computeIncrementalGraphUpdate(request);

    expect(result.changed).toBe(true);
    expect(result.snapshot?.version).toBe(previousSnapshot.version + 1);
    expect(result.snapshot?.edges.length).toBe(2);
    expect(result.diff?.updatedEdges.length).toBe(2);
    expect(result.stats.updatedEdges).toBe(2);
    expect(result.stats.removedEdges).toBe(0);
  });

  it('removes edges and orphan nodes when pool disappears', () => {
    const previousSnapshot = makeSnapshot(1);
    const request: GraphIncrementalRequest = {
      previousSnapshot,
      previousPools: { amm: [{ ...BASE_POOL }], clmm: [] },
      nextPools: { amm: [], clmm: [] },
      droppedPoolIds: [],
      edgeAllow: {},
      priceMap: PRICE_MAP,
      decimalsMap: {},
      priceClampMin: CLAMP_MIN,
      priceClampMax: CLAMP_MAX,
      timestampMs: 3_000,
    };

    const result = computeIncrementalGraphUpdate(request);

    expect(result.changed).toBe(true);
    expect(result.diff?.removedEdgeIds.length).toBe(2);
    expect(result.stats.removedEdges).toBe(2);
    expect(result.diff?.removedNodeIds.length).toBe(2);
    expect(result.snapshot?.edges.length).toBe(0);
    expect(result.snapshot?.nodes.length).toBe(0);
  });
});


