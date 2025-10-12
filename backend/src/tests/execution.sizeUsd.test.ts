import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock modules that are dynamically imported by the resolver
vi.mock('../server/priceStore.js', () => {
  return {
    getPriceByMint: vi.fn(),
    setPrices: vi.fn(),
    getAllPrices: vi.fn(),
  };
});

vi.mock('../execution/resolver/tokenMeta.js', () => {
  return {
    getTokenMeta: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolver sizeUsd sizing', () => {

  it('uses sizeUsd to compute atoms for starting mint when size not provided', async () => {
    // Mock price store: SOL = $25
    const mockPriceStore = await import('../server/priceStore.js');
    (mockPriceStore as any).getPriceByMint.mockImplementation((m: string) => (
      m === SOL ? { usdc: 25, sol: 1 } : (m === USDC ? { usdc: 1, sol: null } : { usdc: null, sol: null })
    ));
    const mockTokenMeta = await import('../execution/resolver/tokenMeta.js');
    (mockTokenMeta as any).getTokenMeta.mockImplementation(async (m: string) => ({ decimals: m === SOL ? 9 : 6, program: 'spl-token' }));

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
    const mockPriceStore2 = await import('../server/priceStore.js');
    (mockPriceStore2 as any).getPriceByMint.mockImplementation((_m: string) => ({ usdc: 1000, sol: null }));
    const mockTokenMeta2 = await import('../execution/resolver/tokenMeta.js');
    (mockTokenMeta2 as any).getTokenMeta.mockImplementation(async (_m: string) => ({ decimals: 9, program: 'spl-token' }));

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


