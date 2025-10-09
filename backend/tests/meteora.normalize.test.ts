import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('meteora clmm orientation normalization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('applies stable-aware flip when USD refs missing', async () => {
    const raw = {
      pairs: [
        {
          address: 'MET_CLMM_1',
          tokenA: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 }, // SOL
          tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }, // USDC
          current_price: 0.0002, // SOL per 1 USDC (inverted for A/B expected)
          bin_step: 16,
          liquidity: 10000,
          tvlUsdc: 20000,
        },
      ],
    } as any;
    const mod = await import('../src/server/pools/meteora');
    const norm = await mod.normalizeMeteoraHttp(raw);
    const p = norm.clmm.find(p => p.id === 'MET_CLMM_1') as any;
    expect(p).toBeTruthy();
    // With quoteHierarchy default, stable (USDC) prefers B; normalized A-per-B should be USDC per 1 SOL
    expect(p.mint_b).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(p.mint_a).toBe('So11111111111111111111111111111111111111112');
    expect(typeof p.price_a_per_b).toBe('number');
  });
});

describe('meteora normalize http', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('maps DLMM fields to ClmmPool with price, decimals and TVL', async () => {
    const rawPairs = [
      {
        address: 'DLMM_POOL_1',
        tokenA: { mint: 'USDC_MINT', symbol: 'USDC', decimals: 6 },
        tokenB: { mint: 'SOL_MINT', symbol: 'SOL', decimals: 9 },
        price: 100, // A per 1 B (USDC per 1 SOL)
        tokenAAmount: '1000000000', // 1,000 USDC in base units
        tokenBAmount: '1000000000', // 1 SOL in base units
        feeRate: 0.003,
        binStep: 16,
        tvlUsdc: '2000'
      }
    ];
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs, meta: {} }) } as any);
    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const norm = await getMeteoraPoolsCached(true);
    expect(norm.amm.length).toBe(0);
    expect(norm.clmm.length).toBe(1);
    const p = norm.clmm[0] as any;
    expect(p.id).toBe('DLMM_POOL_1');
    expect(p.dex).toBe('Meteora');
    // With quoteHierarchy default, USDC should be on B side
    expect(p.mint_a).toBe('SOL_MINT');
    expect(p.mint_b).toBe('USDC_MINT');
    // After quoteHierarchy, decimals also swap sides with mints
    expect(p.decimals_a).toBe(9);
    expect(p.decimals_b).toBe(6);
    expect(p.price_a_per_b).toBeGreaterThan(0);
    expect(p.tick_spacing).toBe(16);
    expect(p.tvl_usd).toBe(2000);
  });
});

describe('meteora normalize http - active bin price precedence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses active bin derived price over current_price and reserves', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL2  = 'So11111111111111111111111111111111111111112';
    const decA = 6; // A=USDC
    const decB = 9; // B=SOL
    const binStep = 16;
    const activeId = 100;
    const f = 1 + (binStep / 10_000);
    const priceBperA = Math.pow(f, activeId) * Math.pow(10, decA - decB);
    const expectedAperB = 1 / priceBperA;

    const rawPairs = [
      {
        address: 'DLMM_POOL_X',
        tokenA: { mint: USDC, symbol: 'USDC', decimals: decA },
        tokenB: { mint: SOL2, symbol: 'SOL', decimals: decB },
        current_price: 42,
        tokenAAmount: '1000000000',
        tokenBAmount: '1000000000',
        feeRate: 0.003,
        binStep,
        activeId,
        tvlUsdc: '2000'
      }
    ];
    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs, meta: {} }) } as any);
    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const norm = await getMeteoraPoolsCached(true);
    expect(norm.clmm.length).toBeGreaterThan(0);
    const p = norm.clmm.find((x: any) => x.id === 'DLMM_POOL_X') as any;
    expect(p).toBeTruthy();
    expect(p.price_a_per_b).toBeGreaterThan(0);
    // Orientation after canonicalization: USDC should be on B; if A=SOL then expected is 1/expectedAperB
    const orientedExpected = (p.mint_a === SOL2) ? (1 / expectedAperB) : expectedAperB;
    expect(Math.abs((p.price_a_per_b as number) - orientedExpected) / orientedExpected).toBeLessThan(1e-3);
  });
});


