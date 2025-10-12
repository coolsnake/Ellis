import { describe, it, expect } from 'vitest';

// Common mints
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Minimal ExecConfig for tests
const cfg = {
  mode: 'simulate',
  slippageBpsDefault: 50,
  computeUnitLimit: 1_000_000,
  computeUnitPriceMicroLamports: 1000,
  createAtasInTx: true,
  dynamicCompute: true,
} as any;

// Tests seed price store and token meta directly (no ESM export mutation or test runner mocks)

describe('resolver sizeUsd sizing', () => {

  it('uses sizeUsd to compute atoms for starting mint when size not provided', async () => {
    // Seed price store: SOL = $25, USDC = $1; and token metas
    const priceStore = await import('../server/priceStore.js');
    priceStore.setPrices({
      [SOL]: { usdc: 25, sol: 1 },
      [USDC]: { usdc: 1, sol: null },
    });
    const { executionCache } = await import('../execution/cache.js');
    executionCache.setTokenMeta(SOL, { decimals: 9, program: 'spl-token' });
    executionCache.setTokenMeta(USDC, { decimals: 6, program: 'spl-token' });

    const { resolveDirectPlan } = await import('../execution/resolver/index.js');
    const plan = await resolveDirectPlan({
      path: [SOL, USDC],
      hopPoolIds: ['p1'],
      dexes: ['raydium.amm'],
      sizeUsd: 10,
      slippageBps: 50,
    } as any, cfg);

    expect(plan.hops.length).toBe(1);
    const atoms = plan.hops[0].amountInRaw;
    // $10 at $25/SOL => 0.4 SOL => 0.4 * 1e9 = 400,000,000 lamports
    expect(typeof atoms).toBe('bigint');
    expect(Number(atoms)).toBeGreaterThan(0);
    expect(Number(atoms)).toBeGreaterThanOrEqual(399_000_000);
    expect(Number(atoms)).toBeLessThanOrEqual(401_000_000);
  });

  it('size (raw) takes precedence over sizeUsd', async () => {
    const priceStore2 = await import('../server/priceStore.js');
    priceStore2.setPrices({
      [SOL]: { usdc: 1000, sol: null },
      [USDC]: { usdc: 1, sol: null },
    });
    const { executionCache: executionCache2 } = await import('../execution/cache.js');
    executionCache2.setTokenMeta(SOL, { decimals: 9, program: 'spl-token' });
    executionCache2.setTokenMeta(USDC, { decimals: 6, program: 'spl-token' });

    const { resolveDirectPlan } = await import('../execution/resolver/index.js');
    const plan = await resolveDirectPlan({
      path: [SOL, USDC],
      hopPoolIds: ['p1'],
      dexes: ['raydium.amm'],
      size: 1_234_567_890, // raw atoms
      sizeUsd: 10,
      slippageBps: 50,
    } as any, cfg);

    expect(plan.hops.length).toBe(1);
    const atoms = plan.hops[0].amountInRaw;
    expect(typeof atoms).toBe('bigint');
    expect(atoms).toBe(1234567890n);
  });
});


