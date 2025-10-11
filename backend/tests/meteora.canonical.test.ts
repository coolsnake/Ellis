import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('meteora canonicalization - quoteHierarchy keeps stable on B', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('orients SOL/USDC to A=SOL, B=USDC and price is A per 1 B', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL  = 'So11111111111111111111111111111111111111112';
    const cfgMod: any = await import('../src/utils/config');
    cfgMod.CONFIG.system.canonicalizePairs = 'quoteHierarchy';

    const raw = {
      pairs: [
        {
          address: 'MET_TEST_CANON',
          tokenA: { mint: SOL, decimals: 9 },
          tokenB: { mint: USDC, decimals: 6 },
          current_price: 0.0002, // upstream orientation not trusted; final orientation enforced by canonicalizePairs
          bin_step: 16,
          liquidity: 10000,
          tvlUsdc: 20000,
        },
      ],
    } as any;

    const mod = await import('../src/server/pools/meteora');
    const norm = await mod.normalizeMeteoraHttp(raw);
    expect(norm.clmm.length).toBe(1);
    const p = norm.clmm[0] as any;
    expect(p.mint_a).toBe(SOL);
    expect(p.mint_b).toBe(USDC);
    expect(typeof p.price_a_per_b).toBe('number');
    expect(p.price_a_per_b).toBeGreaterThan(0);
    // With A=SOL, B=USDC: A per 1 B should be < 1
    expect(p.price_a_per_b).toBeLessThan(1);
  });
});


