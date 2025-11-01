import { describe, it, expect } from 'vitest';

describe('orca.fees.normalize', () => {
  it('derives bps from decimal feeRate values', async () => {
    const { deriveOrcaFeeBps } = await import('../pools/orca.js');
    expect(deriveOrcaFeeBps({ feeRate: 0.003 })).toBe(30);
    expect(deriveOrcaFeeBps({ feeRate: 0.0004 })).toBe(4);
  });

  it('derives bps from percentage-style feeRate values', async () => {
    const { deriveOrcaFeeBps } = await import('../pools/orca.js');
    expect(deriveOrcaFeeBps({ feeRate: 0.04 })).toBe(4);
    expect(deriveOrcaFeeBps({ feeRate: 0.4 })).toBe(40);
  });

  it('prefers explicit bps fields when present', async () => {
    const { deriveOrcaFeeBps } = await import('../pools/orca.js');
    expect(deriveOrcaFeeBps({ fee_bps: 12, feeRate: 0.0004 })).toBe(12);
    expect(deriveOrcaFeeBps({ feeBps: '90', feeRate: 0.009 })).toBe(90);
  });

  it('integrates with normalizeOrcaHttp', async () => {
    const { normalizeOrcaHttp } = await import('../pools/orca.js');
    const raw = {
      whirlpools: [
        {
          address: 'pool-fee-1',
          tokenA: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
          tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
          sqrtPriceX64: '18446744073709551616',
          liquidity: '1000000',
          tickSpacing: 64,
          feeRate: 0.04,
        },
        {
          address: 'pool-fee-2',
          tokenA: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
          tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
          sqrtPriceX64: '18446744073709551616',
          liquidity: '1000000',
          tickSpacing: 64,
          feeRate: 0.003,
        },
      ],
    } as any;

    const norm = await normalizeOrcaHttp(raw);
    const fees = norm.clmm.reduce<Record<string, number>>((acc, pool) => {
      acc[pool.id] = pool.fee_bps;
      return acc;
    }, {});

    expect(fees['pool-fee-1']).toBe(4);
    expect(fees['pool-fee-2']).toBe(30);
  });
});


