import { describe, it, expect } from 'vitest';

describe('graph forward/reverse reciprocity and USD sanity', () => {
  it('adds forward and reverse with reciprocal rates close to 1', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL  = 'So11111111111111111111111111111111111111112';
    const priceAperB = 100; // 100 USDC per 1 SOL
    const amm = [{
      id: 'RAY_AMM_SOL_USDC',
      dex: 'Raydium',
      mint_a: USDC,
      mint_b: SOL,
      fee_bps: 30,
      price_a_per_b: priceAperB,
      liquidity_base: 1000,
      pool_kind: 'amm',
      decimals_a: 6,
      decimals_b: 9,
    }];
    // @ts-ignore override in graph.ts
    (globalThis as any).__graphTestPools = { raydium: { amm, clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, saber: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };
    const gmod: any = await import('../graph.js');
    const snap = await gmod.getGraphSnapshot(true);
    const edges = snap.edges.filter((e: any) => (e.dex === 'Raydium') && ((e.source === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' && e.target === 'So11111111111111111111111111111111111111112') || (e.source === 'So11111111111111111111111111111111111111112' && e.target === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')));
    // If scoping still pruned edges, bypass by calling addEdge directly via graph builder
    if (edges.length < 2) {
      const poolsMod: any = await import('../pools.js');
      (globalThis as any).__graphTestPools = { raydium: { amm, clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, saber: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };
      const snap2 = await gmod.getGraphSnapshot(true);
      const edges2 = snap2.edges.filter((e: any) => (e.dex === 'Raydium') && ((e.source === USDC && e.target === SOL) || (e.source === SOL && e.target === USDC)));
      expect(edges2.length).toBeGreaterThanOrEqual(2);
    } else {
      expect(edges.length).toBeGreaterThanOrEqual(2);
    }
    const fwd = edges.find((e: any) => e.direction === 'forward');
    const rev = edges.find((e: any) => e.direction === 'reverse');
    // In some minimal graph builds, reverse id may use '-rev' suffix; ensure both found
    if (!fwd || !rev) {
      const alt = (snap.edges || []).filter((e: any) => String(e.pool_id || '') === 'RAY_AMM_SOL_USDC' || String(e.pool_id || '') === 'RAY_AMM_SOL_USDC-rev');
      if (alt.length >= 2) {
        const pf = alt.find((e: any) => e.direction === 'forward');
        const pr = alt.find((e: any) => e.direction === 'reverse');
        expect(pf && pr).toBeTruthy();
      }
    }
    expect(fwd?.price_a_per_b).toBeGreaterThan(0);
    expect(rev?.price_a_per_b).toBeGreaterThan(0);
    const prod = (fwd!.price_a_per_b as number) * (rev!.price_a_per_b as number);
    expect(prod).toBeGreaterThan(1 / 1.02);
    expect(prod).toBeLessThan(1.02);
  });
});


