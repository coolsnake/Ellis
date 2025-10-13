import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('CLMM decimals/orientation consistency', () => {
  const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
  const SOL = 'So11111111111111111111111111111111111111112';

  let savedOverride: any;

  beforeAll(async () => {
    const priceStore = await import('../src/server/priceStore.js');
    // Seed SOL and USDC USD refs; USD1 left unanchored
    priceStore.setPrices({
      [SOL]: { usdc: 25, sol: 1 },
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { usdc: 1, sol: 1/25 },
    });
    savedOverride = (globalThis as any).__graphTestPools;
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [{
        id: 'ray-clmm', dex: 'Raydium', mint_a: USD1, mint_b: SOL, fee_bps: 25,
        sqrt_price_x64: Math.pow(2, 64) / Math.sqrt(480), decimals_a: 6, decimals_b: 9,
        liquidity: 1, pool_kind: 'clmm', updated_ms: Date.now(), price_a_per_b: undefined,
      }]},
      orca: { amm: [], clmm: [{
        id: 'orc-clmm', dex: 'Orca', mint_a: USD1, mint_b: SOL, fee_bps: 25,
        sqrt_price_x64: Math.pow(2, 64) / Math.sqrt(480), decimals_a: 6, decimals_b: 9,
        liquidity: 1, pool_kind: 'clmm', updated_ms: Date.now(), price_a_per_b: undefined,
      }]},
      meteora: { amm: [], clmm: [{
        id: 'met-clmm', dex: 'Meteora', mint_a: USD1, mint_b: SOL, fee_bps: 300,
        tick_spacing: 1, decimals_a: 6, decimals_b: 9, liquidity: 1, pool_kind: 'clmm',
        updated_ms: Date.now(), price_a_per_b: 480,
      }]},
      meteora_balanced: { amm: [], clmm: [] },
    };
  });

  afterAll(() => {
    (globalThis as any).__graphTestPools = savedOverride;
  });

  it('aligns across DEXes and maintains strict reciprocity', async () => {
    const graphMod: any = await import('../src/server/graph.js');
    const snap = await graphMod.getGraphSnapshot(true);
    const rel = (e: any) => (
      (e.source === USD1 && e.target === SOL) ||
      (e.source === SOL && e.target === USD1)
    );
    const edges = snap.edges.filter(rel);
    const byDex: Record<string, any[]> = {};
    for (const e of edges) { (byDex[e.dex] ||= []).push(e); }
    for (const dex of ['Raydium', 'Orca', 'Meteora']) {
      const list = byDex[dex] || [];
      expect(list.length).toBeGreaterThanOrEqual(2);
      const fwd = list.find((e) => e.source === USD1 && e.target === SOL);
      const rev = list.find((e) => e.source === SOL && e.target === USD1);
      expect(fwd?.price_a_per_b).toBeGreaterThan(0);
      expect(rev?.price_a_per_b).toBeGreaterThan(0);
      const prod = (fwd!.price_a_per_b as number) * (rev!.price_a_per_b as number);
      expect(prod).toBeGreaterThan(1/1.02);
      expect(prod).toBeLessThan(1.02);
    }
  });
});


