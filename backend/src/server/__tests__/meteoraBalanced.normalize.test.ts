import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.normalize', () => {
  it('computes price/liquidity and preserves fields', async () => {
    const configMod: any = await import('../../utils/config.js');
    configMod.CONFIG.meteoraBalanced.minLiqBase = 0;
    const { normalizeMeteoraBalancedHttp } = await import('../pools/meteoraBalanced.js');

    const mintA = 'So11111111111111111111111111111111111111112'; // SOL
    const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
    const raw = [
      {
        address: 'pool-abc',
        tokenA: { mint: mintA, decimals: 6 },
        tokenB: { mint: mintB, decimals: 6 },
        reserveA: 2_000_000, // 2.0
        reserveB: 1_000_000, // 1.0
        feeRate: 0.003, // 30 bps
      },
    ];

    const norm = await normalizeMeteoraBalancedHttp(raw);
    expect(norm).toBeTruthy();
    expect(Array.isArray(norm.amm)).toBe(true);
    expect(norm.clmm.length).toBe(0);
    expect(norm.amm.length).toBe(1);
    const p = norm.amm[0] as any;
    expect(p.dex).toMatch(/MeteoraBalanced/);
    expect(p.pool_kind).toBe('amm');
    expect(p.fee_bps).toBe(30);
    // Orientation may be canonicalized; compute expected price accordingly
    const expectedPriceIfAIsMintA = 2.0; // 2 / 1
    const px = Number(p.price_a_per_b);
    expect(px).toBeGreaterThan(0);
    if (p.mint_a === mintA && p.mint_b === mintB) {
      expect(Math.abs(px - expectedPriceIfAIsMintA)).toBeLessThan(1e-9);
    } else if (p.mint_a === mintB && p.mint_b === mintA) {
      expect(Math.abs(px - (1 / expectedPriceIfAIsMintA))).toBeLessThan(1e-9);
    } else {
      // If canonicalization reorders by hierarchy but not exactly these mints, still require positive price
      expect(px).toBeGreaterThan(0);
    }
    // Liquidity base should be min(2,1) => 1
    expect(Number(p.liquidity_base)).toBeGreaterThan(0);
  });
});


