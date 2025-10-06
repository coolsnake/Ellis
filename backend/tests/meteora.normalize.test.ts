import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    // @ts-expect-error
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs, meta: {} }) });
    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const norm = await getMeteoraPoolsCached(true);
    expect(norm.amm.length).toBe(0);
    expect(norm.clmm.length).toBe(1);
    const p = norm.clmm[0] as any;
    expect(p.id).toBe('DLMM_POOL_1');
    expect(p.dex).toBe('Meteora');
    expect(p.mint_a).toBe('USDC_MINT');
    expect(p.mint_b).toBe('SOL_MINT');
    expect(p.decimals_a).toBe(6);
    expect(p.decimals_b).toBe(9);
    expect(p.price_a_per_b).toBeGreaterThan(0);
    expect(p.tick_spacing).toBe(16);
    expect(p.tvl_usd).toBe(2000);
  });
});


