import { describe, it, expect } from 'vitest';
import { getGraphSnapshot } from '../graph.js';
import { CONFIG } from '../../utils/config.js';

describe('graph prices orientation - Meteora and Orca are reciprocal', () => {
  it('Meteora DLMM forward/reverse product ~ 1', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL  = 'So11111111111111111111111111111111111111112';
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca:    { amm: [], clmm: [] },
      meteora: { amm: [], clmm: [{
        id: 'met-clmm-1', dex: 'Meteora', pool_kind: 'dlmm',
        mint_a: SOL, mint_b: USDC, fee_bps: 30,
        price_a_per_b: 0.0066666667,
        decimals_a: 9, decimals_b: 6,
        amount_a: 1_000_000_000, amount_b: 150_000_000,
      }]},
      saber: { amm: [], clmm: [] },
      meteora_balanced: { amm: [], clmm: [] },
    } as any;

    const cfg: any = CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;

    const snap = await getGraphSnapshot(true);
    const fwd = snap.edges.find((e: any) => e.dex === 'Meteora' && e.source === SOL && e.target === USDC);
    const rev = snap.edges.find((e: any) => e.dex === 'Meteora' && e.source === USDC && e.target === SOL);
    expect(fwd && rev).toBeTruthy();
    const prod = Number(fwd?.price_a_per_b) * Number(rev?.price_a_per_b);
    expect(prod).toBeGreaterThan(0.98);
    expect(prod).toBeLessThan(1.02);
    (globalThis as any).__graphTestPools = undefined;
  });

  it('Orca CLMM forward/reverse product ~ 1', async () => {
    const usdc = 'USDC_MINT';
    const btc  = 'BTC_MINT';
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca:    { amm: [], clmm: [{
        id: 'orca-clmm-1', dex: 'Orca', pool_kind: 'clmm',
        mint_a: usdc, mint_b: btc, fee_bps: 10,
        price_a_per_b: 120_000,
        decimals_a: 6, decimals_b: 8,
        amount_a: 10_000_000_000, amount_b: 100_000_000,
      }]},
      meteora: { amm: [], clmm: [] },
      saber: { amm: [], clmm: [] },
      meteora_balanced: { amm: [], clmm: [] },
    } as any;

    const cfg: any = CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;

    const snap = await getGraphSnapshot(true);
    const fwd = snap.edges.find((e: any) => e.dex === 'Orca' && e.source === usdc && e.target === btc);
    const rev = snap.edges.find((e: any) => e.dex === 'Orca' && e.source === btc && e.target === usdc);
    expect(fwd && rev).toBeTruthy();
    const prod = Number(fwd?.price_a_per_b) * Number(rev?.price_a_per_b);
    expect(prod).toBeGreaterThan(0.98);
    expect(prod).toBeLessThan(1.02);
    (globalThis as any).__graphTestPools = undefined;
  });
});


