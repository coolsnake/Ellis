import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll import the module under test dynamically so we can stub token price/mint resolution

describe('orca normalize price math', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('derives correct B-per-A price from sqrtPriceX64 and decimals (USDC/BTC-like)', async () => {
    // Setup: token A = USDC (6), token B = BTC (8). Want B per 1 A ≈ 1 / 122,807.06
    const decA = 6;
    const decB = 8;
    const desiredBperA = 1 / 122_807.06;
    // Orca sqrt encodes sqrt(B/A) in smallest units. ratio^2 = (B/A) / 10^(decA-decB)
    const ratio2 = desiredBperA / Math.pow(10, decA - decB);
    const ratio = Math.sqrt(ratio2);
    const two64 = Math.pow(2, 64);
    const sqrt_price_x64 = Math.floor(ratio * two64);

    const raw = [
      {
        address: 'POOL1',
        type: 'whirlpool',
        tokenA: { mint: 'USDC_MINT', symbol: 'USDC', decimals: decA },
        tokenB: { mint: 'BTC_MINT', symbol: 'BTC', decimals: decB },
        sqrtPriceX64: String(sqrt_price_x64),
        // Provide incoming price to act as fallback reference
        price: desiredBperA,
        liquidity: '1000000',
        tvlUsdc: '5000000',
        tickSpacing: 64
      }
    ];
    // Mock the HTTP fetch used by the Orca HTTP fetcher
    // @ts-expect-error
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: raw, meta: {} }) });

    const { getOrcaPoolsNormalized } = await import('../src/server/pools');
    const norm = await getOrcaPoolsNormalized();
    expect(norm.clmm.length).toBe(1);
    const p = norm.clmm[0] as any;
    // Derived price should closely match desired, accounting for canonicalization orientation
    const usdc = 'USDC_MINT';
    const btc = 'BTC_MINT';
    const oriented = (p.mint_a === usdc && p.mint_b === btc)
      ? desiredBperA
      : (1 / desiredBperA);
    expect(Math.abs((p.price_a_per_b as number) - oriented) / oriented).toBeLessThan(1e-3);
    // Canonicalization: if lex mode enabled, mints should be ordered lexicographically
    const canon = (await import('../src/utils/config')).CONFIG.system.canonicalizePairs;
    if (String(canon) === 'lex') {
      const a = String(p.mint_a), b = String(p.mint_b);
      expect(a <= b).toBe(true);
    }
  });
});


