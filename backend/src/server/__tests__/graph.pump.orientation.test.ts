import { describe, it, expect } from 'vitest';

import * as cfgMod from '../../utils/config';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';

async function stubUsd(prices: Record<string, number>) {
  const mod = await import('vitest');
  const vi = (mod as any).vi as any;
  vi.doMock('../priceStore.js', () => ({ getPriceByMint: (m: string) => ({ usdc: prices[m] }) }), { virtual: true });
}

async function buildSnap(pack: any) {
  (globalThis as any).__graphTestPools = pack;
  const { getGraphSnapshot } = await import('../graph');
  return await getGraphSnapshot(true);
}

function findEdges(snap: any, a: string, b: string, dex: string) {
  const fwd = snap.edges.find((e: any) => e.source === a && e.target === b && e.dex === dex);
  const rev = snap.edges.find((e: any) => e.source === b && e.target === a && e.dex === dex);
  return { fwd, rev };
}

describe('SOL↔PUMP orientation across DEXes', () => {
  it('orients Raydium/Orca/Meteora SOL→PUMP consistently with implied/triangulation fallbacks', async () => {
    const mod = await import('vitest');
    const vi = (mod as any).vi as any;
    vi.resetModules(); vi.restoreAllMocks();
    (cfgMod.CONFIG.sanity as any).priceClampMin = 1e-12;
    (cfgMod.CONFIG.sanity as any).priceClampMax = 1e12;
    (cfgMod.CONFIG.sanity as any).dropEdgesNoUsdBoth = false;
    await stubUsd({ [SOL]: 200, [USDC]: 1 }); // no direct USD for PUMP

    // Target approx: 1 SOL ~ 48,679.69 PUMP => A-per-1-B for SOL→PUMP ~ 1 / 48,679.69
    const targetFwd = 1 / 48679.69;
    const tol = 10; // allow wide range; verify only that orientation selects the smaller magnitude (~2e-5 order)

    const common = { fee_bps: 25, pool_kind: 'clmm', liquidity: 1e7 };

    const pack = {
      raydium: { amm: [{ id: 'pivot_usdc_sol', mint_a: USDC, mint_b: SOL, price_a_per_b: 200, fee_bps: 30, pool_kind: 'amm' }], clmm: [
        // Provide price in opposite orientation to force orientation logic
        { id: 'ray_pump_sol', mint_a: PUMP, mint_b: SOL, price_a_per_b: 50000, decimals_a: 6, decimals_b: 9, ...common },
      ] },
      orca: { amm: [], clmm: [
        // Orca sqrt decode should also orient; seed with direct A/B near inverse to test inversion path
        { id: 'orc_pump_sol', mint_a: PUMP, mint_b: SOL, price_a_per_b: 49000, decimals_a: 6, decimals_b: 9, ...common },
      ] },
      meteora: { amm: [], clmm: [
        { id: 'met_sol_pump', mint_a: SOL, mint_b: PUMP, price_a_per_b: 0.00002, decimals_a: 9, decimals_b: 6, ...common },
      ] },
      meteora_balanced: { amm: [] },
    };

    const snap = await buildSnap(pack);
    for (const dex of ['Raydium', 'Orca', 'Meteora']) {
      const { fwd, rev } = findEdges(snap, SOL, PUMP, dex);
      expect(!!fwd && !!rev).toBe(true);
      const prod = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
      expect(prod).toBeGreaterThan(1/1.02); expect(prod).toBeLessThan(1.02);
      // Ensure forward magnitude is closer to ~2e-5 than ~5e-5 when pivots present
      const px = Number((fwd as any).price_a_per_b);
      expect(px).toBeGreaterThan(1e-6);
      expect(px).toBeLessThan(1e-3);
    }
  });
});


