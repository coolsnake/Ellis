import { describe, it, expect } from 'vitest';

describe('graph stable<->stable pruning', () => {
  it('drops USDC<->USDT edges when dropStableStableEdges=true', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;
    cfg.system.dropStableStableEdges = true;
    cfg.system.stableMints = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ];
    const USDC = cfg.system.stableMints[0];
    const USDT = cfg.system.stableMints[1];
    const amm = [{
      id: 'RAY_AMM_USDC_USDT',
      dex: 'Raydium',
      mint_a: USDC,
      mint_b: USDT,
      fee_bps: 5,
      price_a_per_b: 1.0,
      liquidity_base: 1000,
      pool_kind: 'amm',
      decimals_a: 6,
      decimals_b: 6,
    }];
    // Override pools
    (globalThis as any).__graphTestPools = { raydium: { amm, clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, saber: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };
    const gmod: any = await import('../graph.js');
    const snap = await gmod.getGraphSnapshot(true);
    const ssEdges = snap.edges.filter((e: any) => (e.source === USDC && e.target === USDT) || (e.source === USDT && e.target === USDC));
    expect(ssEdges.length).toBe(0);
  });

  it('keeps USDC<->USDT edges when dropStableStableEdges=false', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;
    cfg.system.dropStableStableEdges = false;
    cfg.system.stableMints = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ];
    const USDC = cfg.system.stableMints[0];
    const USDT = cfg.system.stableMints[1];
    const amm = [{
      id: 'RAY_AMM_USDC_USDT',
      dex: 'Raydium',
      mint_a: USDC,
      mint_b: USDT,
      fee_bps: 5,
      price_a_per_b: 1.0,
      liquidity_base: 1000,
      pool_kind: 'amm',
      decimals_a: 6,
      decimals_b: 6,
    }];
    (globalThis as any).__graphTestPools = { raydium: { amm, clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, saber: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };
    const gmod: any = await import('../graph.js');
    const snap = await gmod.getGraphSnapshot(true);
    const ssEdges = snap.edges.filter((e: any) => (e.source === USDC && e.target === USDT) || (e.source === USDT && e.target === USDC));
    expect(ssEdges.length).toBeGreaterThanOrEqual(1);
  });
});


