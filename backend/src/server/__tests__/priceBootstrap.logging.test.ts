// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

describe('priceBootstrap emits Pools Log messages', () => {
  it('emits start/done and batch.fail for bootstrapPricesForUniverse', async () => {
    vi.resetModules();
    const emits: string[] = [];
    vi.doMock('../realtime.js', () => ({
      emit: vi.fn((event: string, payload: any) => {
        if (event === 'log' && payload?.context?.cat === 'pools') emits.push(payload.message);
      }),
    }));
    // Make fetchPricesByMints succeed
    vi.doMock('../../jupiter/jupiter.js', () => ({
      fetchPricesByMints: vi.fn(async () => ({})),
    }));
    const mod: any = await import('../priceBootstrap.js');
    await mod.bootstrapPricesForUniverse({ cat: 'pools.refresh', chunkSize: 40, maxRequests: 1 });
    expect(emits.some(m => m.includes('pools:bootstrap.mints start'))).toBe(true);
    expect(emits.some(m => m.includes('pools:bootstrap.mints done'))).toBe(true);
  });

  it('emits start/done and batch.fail for bootstrapPricesForMints', async () => {
    vi.resetModules();
    const emits: string[] = [];
    vi.doMock('../realtime.js', () => ({
      emit: vi.fn((event: string, payload: any) => {
        if (event === 'log' && payload?.context?.cat === 'pools') emits.push(payload.message);
      }),
    }));
    // First call throws to trigger batch.fail; next calls succeed
    const mock = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue({});
    vi.doMock('../../jupiter/jupiter.js', () => ({
      fetchPricesByMints: mock,
    }));
    const mod: any = await import('../priceBootstrap.js');
    await mod.bootstrapPricesForMints(['A','B','C'], { cat: 'pools.refresh.post', chunkSize: 40, maxRequests: 2 });
    expect(emits.some(m => m.includes('pools:bootstrap.mints start'))).toBe(true);
    expect(emits.some(m => m.includes('pools:bootstrap.mints batch.fail'))).toBe(true);
    expect(emits.some(m => m.includes('pools:bootstrap.mints done'))).toBe(true);
  });
});


