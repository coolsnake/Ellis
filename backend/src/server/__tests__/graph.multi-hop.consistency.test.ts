import { describe, it, expect } from 'vitest';

// Multi-hop consistency across mixed DEX/pool types
// Construct a 3-cycle USDC -> SOL -> BTC -> USDC such that the product of forward edge prices equals ~1
// Forward edge price semantics: price_a_per_b is A per 1 B for edge source=A -> target=B

describe('graph multi-hop pricing consistency across mixed DEXes', () => {
  it('USDC->SOL->BTC->USDC cycle product ~ 1 and pair reciprocals hold', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    // Disable scoping/filters to ensure edges are built from the provided fake pools
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.minPoolsPerPair = 1;

    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL  = 'So11111111111111111111111111111111111111112';
    const BTC  = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

    // Choose consistent prices:
    // p(USDC/SOL) = 100 USDC per 1 SOL  [Raydium AMM]
    // p(SOL/BTC) = 20000 SOL per 1 BTC  [Orca CLMM]
    // p(BTC/USDC) = 1 / (100 * 20000) = 5e-7 BTC per 1 USDC  [Meteora CLMM]
    const pUSDCperSOL = 100;
    const pSOLperBTC = 20000;
    const pBTCperUSDC = 1 / (pUSDCperSOL * pSOLperBTC);

    const rayAmm = [{
      id: 'RAY_AMM_USDC_SOL', dex: 'Raydium', pool_kind: 'amm',
      mint_a: USDC, mint_b: SOL,
      fee_bps: 25,
      price_a_per_b: pUSDCperSOL,
      liquidity_base: 1_000_000,
      decimals_a: 6,
      decimals_b: 9,
    }];
    const orcClmm = [{
      id: 'ORC_CLMM_SOL_BTC', dex: 'Orca', pool_kind: 'clmm',
      mint_a: SOL, mint_b: BTC,
      fee_bps: 30,
      price_a_per_b: pSOLperBTC,
      sqrt_price_x64: 0,
      liquidity: 1_000_000,
      tick_spacing: 64,
      decimals_a: 9,
      decimals_b: 8,
    }];
    const metClmm = [{
      id: 'MET_CLMM_BTC_USDC', dex: 'Meteora', pool_kind: 'dlmm',
      mint_a: BTC, mint_b: USDC,
      fee_bps: 10,
      price_a_per_b: pBTCperUSDC,
      sqrt_price_x64: 0,
      liquidity: 500_000,
      tick_spacing: 16,
      decimals_a: 8,
      decimals_b: 6,
    }];

    // @ts-ignore override graph build inputs
    (globalThis as any).__graphTestPools = {
      raydium: { amm: rayAmm, clmm: [] },
      orca: { amm: [], clmm: orcClmm },
      meteora: { amm: [], clmm: metClmm },
      saber: { amm: [], clmm: [] },
      meteora_balanced: { amm: [], clmm: [] },
    };

    const gmod: any = await import('../graph.js');
    const snap = await gmod.getGraphSnapshot(true);

    // Find forward edges
    const eUSDC_SOL = (snap.edges || []).find((e: any) => e.dex === 'Raydium' && e.source === USDC && e.target === SOL);
    const eSOL_BTC = (snap.edges || []).find((e: any) => e.dex === 'Orca' && e.source === SOL && e.target === BTC);
    const eBTC_USDC = (snap.edges || []).find((e: any) => e.dex === 'Meteora' && e.source === BTC && e.target === USDC);
    expect(eUSDC_SOL && eSOL_BTC && eBTC_USDC).toBeTruthy();

    // Verify pairwise reciprocals exist
    const eSOL_USDC = (snap.edges || []).find((e: any) => e.dex === 'Raydium' && e.source === SOL && e.target === USDC);
    const eBTC_SOL = (snap.edges || []).find((e: any) => e.dex === 'Orca' && e.source === BTC && e.target === SOL);
    const eUSDC_BTC = (snap.edges || []).find((e: any) => e.dex === 'Meteora' && e.source === USDC && e.target === BTC);
    expect(eSOL_USDC && eBTC_SOL && eUSDC_BTC).toBeTruthy();

    const prod = Number(eUSDC_SOL!.price_a_per_b) * Number(eSOL_BTC!.price_a_per_b) * Number(eBTC_USDC!.price_a_per_b);
    expect(prod).toBeGreaterThan(0.98);
    expect(prod).toBeLessThan(1.02);
  });
});


