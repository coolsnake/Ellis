import { describe, it, expect } from 'vitest';

describe('DLOB L2 normalization', () => {
  it('scales micro-prices and passes oracle value', async () => {
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        oracle: 1_200_000_000,
        bids: [[1_000_000_000, 2]],
        asks: [[1_001_000_000, 1.5]],
      }),
    }) as any;

    try {
      const { fetchDlobL2 } = await import('../marketdata.js');
      const l2 = await fetchDlobL2(0);
      expect(l2?.oracle).toBeCloseTo(1200, 6);
      expect(l2?.bid?.[0].price).toBeCloseTo(1000, 6);
      expect(l2?.ask?.[0].price).toBeCloseTo(1001, 6);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('returns null on persistent 429', async () => {
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => '',
    }) as any;

    try {
      const { fetchDlobL2 } = await import('../marketdata.js');
      const l2 = await fetchDlobL2(0);
      expect(l2).toBeNull();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});


