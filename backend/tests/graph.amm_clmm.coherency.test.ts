import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('graph AMM vs CLMM coherency (SOL/USDC)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps CLMM within a reasonable factor of AMM after orientation', async () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    // Minimal mock: one Raydium AMM and one Raydium CLMM for SOL/USDC
    const amm = { id: 'amm1', dex: 'Raydium', mint_a: USDC, mint_b: SOL, fee_bps: 25, price_a_per_b: 200, pool_kind: 'amm' };
    const clmm = { id: 'clmm1', dex: 'Raydium', mint_a: USDC, mint_b: SOL, fee_bps: 4, price_a_per_b: 205, pool_kind: 'clmm' };
    const pools = { raydium: { amm: [amm], clmm: [clmm] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };

    // Mock getGraphSnapshot sources
    vi.doMock('../src/server/pools.ts', async () => ({
      getRaydiumPoolsNormalized: async () => ({ amm: [amm], clmm: [clmm] }),
      getOrcaPoolsNormalized: async () => ({ amm: [], clmm: [] }),
      getMeteoraPoolsNormalized: async () => ({ amm: [], clmm: [] }),
      getMeteoraBalancedPoolsNormalized: async () => ({ amm: [], clmm: [] }),
    }));
    const mod = await import('../src/server/graph');
    const snap = await mod.getGraphSnapshot(true);
    // Extract SOL/USDC edges
    const edges = snap.edges.filter((e: any) =>
      (e.source === USDC && e.target === SOL) || (e.source === SOL && e.target === USDC)
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const ammEdge = edges.find((e: any) => e.pool_id === 'amm1');
    const clmmEdge = edges.find((e: any) => e.pool_id === 'clmm1');
    expect(ammEdge && clmmEdge).toBeTruthy();
    const ratio = (clmmEdge!.price_a_per_b as number) / (ammEdge!.price_a_per_b as number);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});


