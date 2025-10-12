import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('graph price clamp sanity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('drops or clamps edges with extreme price_a_per_b per config', async () => {
    // Prepare a snapshot by pushing pools directly via test override
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    // Inject pools into graph builder via __graphTestPools
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca: { amm: [], clmm: [] },
      meteora: { amm: [], clmm: [{
        id: 'X', dex: 'Meteora', mint_a: SOL, mint_b: USDC, fee_bps: 30,
        price_a_per_b: 1e20, // extreme
        decimals_a: 9, decimals_b: 6, pool_kind: 'clmm'
      }] },
      meteora_balanced: { amm: [], clmm: [] }
    };
    const { getGraphSnapshot } = await import('../src/server/graph');
    const snap = await getGraphSnapshot(true);
    expect(snap.edges.length >= 0).toBe(true);
    // With clamp [1e-12, 1e9], 1e20 should be removed by clamp (edge not present) or not emitted
    const bad = snap.edges.find((e: any) => e.id?.includes('X') || (e.source===SOL && e.target===USDC && e.dex==='Meteora'));
    expect(!bad).toBe(true);
    // Cleanup
    (globalThis as any).__graphTestPools = undefined;
  });
});


