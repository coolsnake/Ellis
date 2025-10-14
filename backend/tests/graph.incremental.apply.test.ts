import { describe, it, expect } from 'vitest';

describe('graph.incremental.apply', () => {
  it('adds, updates, and removes edges via applyPoolUpdates', async () => {
    const graph: any = await import('../src/server/graph');

    // Start from clean small snapshot (no pools)
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca: { amm: [], clmm: [] },
      meteora: { amm: [], clmm: [] },
      meteora_balanced: { amm: [], clmm: [] },
    };
    const snap0 = await graph.getGraphSnapshot(true);

    // Prepare Raydium AMM delta: add pool1 A->B
    const t0 = Date.now();
    const prev = { amm: [], clmm: [] };
    const nextAdd = {
      amm: [{
        id: 'ray-amm-pool1',
        dex: 'Raydium',
        mint_a: 'TokenA',
        mint_b: 'TokenB',
        fee_bps: 30,
        price_a_per_b: 2,
        liquidity_base: 1000,
        updated_ms: t0,
        pool_kind: 'amm',
      }],
      clmm: [],
    };

    await graph.applyPoolUpdates(prev, nextAdd);
    const snap1 = await graph.getGraphSnapshot(false);
    expect(snap1.version).toBeGreaterThanOrEqual(snap0.version + 1);
    const e1 = snap1.edges.find((e: any) => e.id === 'ray-amm-pool1');
    const r1 = snap1.edges.find((e: any) => e.id === 'ray-amm-pool1-rev');
    expect(e1).toBeTruthy();
    expect(r1).toBeTruthy();
    expect(e1.source).toBe('TokenA');
    expect(e1.target).toBe('TokenB');
    expect(typeof e1.price_a_per_b).toBe('number');
    expect(e1.price_a_per_b).toBeGreaterThan(0);

    // Update price/liquidity (pool1)
    const nextUpd = {
      amm: [{
        id: 'ray-amm-pool1',
        dex: 'Raydium',
        mint_a: 'TokenA',
        mint_b: 'TokenB',
        fee_bps: 30,
        price_a_per_b: 4, // update
        liquidity_base: 2000, // update
        updated_ms: t0 + 1,
        pool_kind: 'amm',
      }],
      clmm: [],
    };
    await graph.applyPoolUpdates(nextAdd, nextUpd);
    const snap2 = await graph.getGraphSnapshot(false);
    const e2 = snap2.edges.find((e: any) => e.id === 'ray-amm-pool1');
    expect(snap2.version).toBeGreaterThanOrEqual(snap1.version + 1);
    expect(e2).toBeTruthy();
    expect(Number(e2.price_a_per_b)).toBeGreaterThan(0);
    // price should reflect update (allow calibration adjustments; assert change direction)
    expect(Number(e2.price_a_per_b)).not.toBeCloseTo(Number(e1.price_a_per_b || 0));

    // Remove pool1
    const nextRem = { amm: [], clmm: [] };
    await graph.applyPoolUpdates(nextUpd, nextRem);
    const snap3 = await graph.getGraphSnapshot(false);
    expect(snap3.version).toBeGreaterThanOrEqual(snap2.version + 1);
    const e3 = snap3.edges.find((e: any) => e.id === 'ray-amm-pool1');
    const r3 = snap3.edges.find((e: any) => e.id === 'ray-amm-pool1-rev');
    expect(e3).toBeFalsy();
    expect(r3).toBeFalsy();
    // Orphan nodes should be pruned
    const nA = snap3.nodes.find((n: any) => n.id === 'TokenA');
    const nB = snap3.nodes.find((n: any) => n.id === 'TokenB');
    expect(nA).toBeFalsy();
    expect(nB).toBeFalsy();
  });
});


