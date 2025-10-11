import { describe, it, expect } from 'vitest';

describe('orca.decimals.normalize', () => {
  it('forces SOL=9 and USDC=6 even if source misreports', async () => {
    const { normalizeOrcaHttp } = await import('../pools/orca.js');
    const raw = {
      whirlpools: [
        {
          address: 'poolX',
          tokenA: { mint: 'So11111111111111111111111111111111111111112', decimals: 6 },
          tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
          sqrtPriceX64: '18446744073709551616',
          liquidity: '1000',
          tickSpacing: 64,
          feeRate: 100,
        },
      ],
    } as any;
    const norm = await normalizeOrcaHttp(raw);
    expect(norm).toHaveProperty('clmm');
    expect(norm.clmm.length).toBe(1);
    const p: any = norm.clmm[0];
    // Decimals enforced
    if (p.mint_a === 'So11111111111111111111111111111111111111112') {
      expect(p.decimals_a).toBe(9);
    }
    if (p.mint_b === 'So11111111111111111111111111111111111111112') {
      expect(p.decimals_b).toBe(9);
    }
    if (p.mint_a === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
      expect(p.decimals_a).toBe(6);
    }
    if (p.mint_b === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
      expect(p.decimals_b).toBe(6);
    }
  });
});


