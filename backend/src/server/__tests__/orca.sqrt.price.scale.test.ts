import { describe, it, expect } from 'vitest';

describe('orca.sqrt.price.scale', () => {
  it('sqrt-derived price magnitude is sane with correct decimals', async () => {
    const { normalizeOrcaHttp } = await import('../pools/orca.js');
    const raw = {
      whirlpools: [
        {
          address: 'poolY',
          tokenA: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
          tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
          // ratio = 1 => A/B = 10^(decB-decA) = 1e-3
          sqrtPriceX64: '18446744073709551616',
          liquidity: '1000',
          tickSpacing: 64,
          feeRate: 100,
        },
      ],
    } as any;
    const norm = await normalizeOrcaHttp(raw);
    expect(norm.clmm.length).toBe(1);
    const p: any = norm.clmm[0];
    expect(p.price_a_per_b).toBeGreaterThan(0);
    // Should be near 1e-3; allow a wide sanity band but ensure not extreme
    expect(p.price_a_per_b).toBeGreaterThan(1e-6);
    expect(p.price_a_per_b).toBeLessThan(1e-1);
  });
});


