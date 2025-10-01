import { describe, it, expect, vi } from 'vitest';
import { getOrcaPoolsNormalized } from '../src/server/pools';

describe('orca pools', () => {
  it('normalizes HTTP response', async () => {
    const mock = [
      {
        address: 'POOL1',
        tokenA: { mint: 'So11111111111111111111111111111111111111112' },
        tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        feeRate: 0.003,
        sqrtPrice: '79228162514264337593543950336',
        liquidity: '1000000000',
        tickSpacing: 64,
      },
    ];
    // @ts-expect-error
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mock });
    // Force http mode
    // @ts-expect-error
    process.env.ORCA_MODE = 'http';
    const res = await getOrcaPoolsNormalized();
    expect(Array.isArray(res.clmm)).toBe(true);
    expect(res.clmm.length).toBeGreaterThan(0);
    const p = res.clmm[0];
    expect(p.dex).toBe('Orca');
    expect(p.mint_a.length).toBeGreaterThan(10);
    expect(p.mint_b.length).toBeGreaterThan(10);
    expect(p.sqrt_price_x64).toBeGreaterThan(0);
  });

  it('handles HTTP failure with retries', async () => {
    const ok = [{ address: 'P2', tokenA: { mint: 'A' }, tokenB: { mint: 'B' }, feeRate: 0.003, sqrtPrice: '1', liquidity: '1', tickSpacing: 8 }];
    // @ts-expect-error
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ok });
    // @ts-expect-error
    process.env.ORCA_MODE = 'http';
    const res = await getOrcaPoolsNormalized();
    expect(Array.isArray(res.clmm)).toBe(true);
  });
});


