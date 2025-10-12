import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('raydium amm orientation (no stable flip)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps upstream A-per-B when B is stable and upstream<1 (no flip)', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL = 'So11111111111111111111111111111111111111112';
    const raw = {
      data: [
        {
          id: 'R_amm_1',
          type: 'amm',
          mintA: { address: SOL, decimals: 9 },
          mintB: { address: USDC, decimals: 6 },
          price: 0.005, // A-per-1-B: SOL per 1 USDC; <1
          reserveA: 100,
          reserveB: 20_000,
          feeRate: 0.00025
        }
      ]
    } as any;
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => raw });
    const { getRaydiumPoolsNormalized } = await import('../src/server/pools');
    const norm = await getRaydiumPoolsNormalized();
    expect(norm.amm.length).toBe(1);
    const p = norm.amm[0] as any;
    // No stable-aware flip occurs inside Raydium normalizer now. Canonicalization may reorder mints, but price stays consistent with orientation A-per-B
    const oriented = (p.mint_a === SOL && p.mint_b === USDC) ? 0.005 : (1 / 0.005);
    expect(Math.abs((p.price_a_per_b as number) - oriented) / oriented).toBeLessThan(1e-9);
  });
});


