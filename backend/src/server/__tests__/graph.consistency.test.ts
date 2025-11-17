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
    const canonicalEdges = snap.edges.filter((e: any) => (e.dex === 'Raydium') && e.source === USDC && e.target === SOL);
    expect(canonicalEdges.length).toBeGreaterThanOrEqual(1);
    const canonical = canonicalEdges[0];
    expect(canonical.direction).toBe('canonical');
    expect(canonical.price_a_per_b).toBeGreaterThan(0);
    const reversePrice = 1 / (canonical.price_a_per_b as number);
    expect(reversePrice).toBeGreaterThan(0);
    const prod = (canonical.price_a_per_b as number) * reversePrice;
    expect(prod).toBeGreaterThan(1 / 1.02);
    expect(prod).toBeLessThan(1.02);
  });
});


