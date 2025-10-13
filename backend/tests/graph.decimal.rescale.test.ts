import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('graph decimal rescale', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rescales pool price to global decimals before orientation', async () => {
    const A = 'A_MINT';
    const B = 'B_MINT';
    // Pool reports decimals_a/b incorrectly by +2 for A and -1 for B
    const poolDecA = 11; // real 9
    const poolDecB = 5;  // real 6
    const globalDecA = 9;
    const globalDecB = 6;
    // True A_per_B is 100; pool-reported price (with wrong decs) becomes:
    // p_pool = true * 10^((poolDecA-globalDecA) - (poolDecB-globalDecB)) = 100 * 10^((11-9) - (5-6)) = 100 * 10^3 = 100000
    const p_pool = 100000;
    const pool = { id: 'pool1', dex: 'Raydium', mint_a: A, mint_b: B, fee_bps: 4, price_a_per_b: p_pool, decimals_a: poolDecA, decimals_b: poolDecB, pool_kind: 'clmm' };

    vi.doMock('../src/server/pools.ts', async () => ({
      getRaydiumPoolsNormalized: async () => ({ amm: [], clmm: [pool] }),
      getOrcaPoolsNormalized: async () => ({ amm: [], clmm: [] }),
      getMeteoraPoolsNormalized: async () => ({ amm: [], clmm: [] }),
      getMeteoraBalancedPoolsNormalized: async () => ({ amm: [], clmm: [] }),
    }));
    // Mock decimalsByMint mapping in graph via module factory
    const real = await import('../src/server/graph');
    const snap = await real.getGraphSnapshot(true);
    const e = snap.edges.find((e: any) => e.pool_id === 'pool1');
    expect(e).toBeTruthy();
    // After rescale, price should be near 100 (ignoring orientation changes)
    const px = e!.price_a_per_b as number;
    expect(px).toBeGreaterThan(50);
    expect(px).toBeLessThan(200);
  });
});


