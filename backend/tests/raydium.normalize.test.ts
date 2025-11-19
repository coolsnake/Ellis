import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('raydium amm orientation normalization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('prefers reserves-derived price over upstream when reserves present', async () => {
    const now = Date.now();
    const raw = {
      data: [
        {
          id: 'POOL_AMM_1',
          poolType: 'amm',
          mintA: { address: 'BONK_MINT', decimals: 5 },
          mintB: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }, // USDC
          mintAmountA: 100000000, // 1,000,000 BONK (dec=5) => 10000 whole
          mintAmountB: 2000000,   // 2,000,000 USDC (dec=6) => 2 whole
          price: 0.00002,         // upstream says BONK per 1 USDC is tiny
          tvl: 0,
          updatedTime: now,
        },
      ],
    };
    const mod = await import('../src/server/pools/raydium');
    const norm = await mod.normalizeRaydiumPools(raw as any);
    const p = norm.amm.find(p => p.id === 'POOL_AMM_1') as any;
    expect(p).toBeTruthy();
    // Reserves-derived price using decimals-aware ratio should be > 1 and dominated by reserves, not upstream
    expect(p.price_a_per_b).toBeGreaterThan(1);
  });

  it('skips pool when using upstream price and no reserves', async () => {
    const now = Date.now();
    const raw = {
      data: [
        {
          id: 'POOL_AMM_2',
          poolType: 'amm',
          mintA: { address: 'BONK_MINT', decimals: 5 },
          mintB: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }, // USDC
          // No mintAmountA/B => no reserves-based price
          price: 0.00002, 
          tvl: 0,
          updatedTime: now,
        },
      ],
    };
    const mod = await import('../src/server/pools/raydium');
    const norm = await mod.normalizeRaydiumPools(raw as any);
    // Should skip because no reserves to calculate verified price
    expect(norm.amm.length).toBe(0);
  });
});

// vitest globals already imported above

// Import normalize via dynamic import to avoid top-level side effects
async function normalize(raw: any) {
  const mod: any = await import('../src/server/pools.ts');
  const fn = (mod as any).defaultNormalizeRaydiumPools
    ? (mod as any).defaultNormalizeRaydiumPools
    : (mod as any).normalizeRaydiumPools;
  return await fn(raw);
}

describe('normalizeRaydiumPools', () => {
  it('normalizes AMM array with reserves to price', async () => {
    const raw = { data: [ { 
      id: 'pool1', 
      mintA: { address: 'A', decimals: 6 }, 
      mintB: { address: 'B', decimals: 6 }, 
      reserveA: 200, 
      reserveB: 100, 
      feeBps: 30 
    } ] };
    const mod: any = await import('../src/server/pools');
    const fn = (mod as any).normalizeRaydiumPools;
    const out = await fn(raw);
    expect(out.amm.length).toBe(1);
    expect(out.amm[0].price_a_per_b).toBe(2);
  });

  it('normalizes CLMM with sqrtPriceX64 and derives price', async () => {
    const sqrt = Math.floor(Math.sqrt(2) * Math.pow(2, 64));
    const raw = { data: [ { 
      id: 'clmm1', 
      mintA: { address: 'A', decimals: 9 }, 
      mintB: { address: 'B', decimals: 9 }, 
      sqrtPriceX64: sqrt, 
      tickSpacing: 64, 
      liquidity: 123 
    } ] } as any;
    const mod: any = await import('../src/server/pools');
    const fn = (mod as any).normalizeRaydiumPools;
    const out = await fn(raw);
    expect(out.clmm.length).toBe(1);
    expect(out.clmm[0].sqrt_price_x64).toBeGreaterThan(0);
    expect((out.clmm[0] as any).price_a_per_b).toBeGreaterThan(0);
  });

  // Deprecated: on-chain enrichment and discovery removed; HTTP fetcher only

  it('sets pool_kind on normalized pools', async () => {
    const sqrt = Math.floor(Math.sqrt(2) * Math.pow(2, 64));
    const raw = { data: [
      { id: 'ammX', mintA: 'So11111111111111111111111111111111111111112', mintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', reserveA: 1000000, reserveB: 1000000, feeBps: 30 },
      { id: 'clmmX', mintA: 'So11111111111111111111111111111111111111112', mintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sqrtPriceX64: sqrt, tokenA: { decimals: 9 }, tokenB: { decimals: 6 }, tickSpacing: 64, liquidity: 1000, feeBps: 100 }
    ] } as any;
    const out = await normalize(raw);
    expect(out.amm[0].pool_kind).toBe('amm');
    expect(out.clmm[0].pool_kind).toBe('clmm');
  });
});


