// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

describe('Pools Log emits during refreshAllSources bootstrap sequence', () => {
  it('emits pools:bootstrap tokens/universe/api logs on refresh', async () => {
    vi.resetModules();

    // Capture Pools panel emits
    const emits: Array<{ level: string; message: string }> = [];
    vi.doMock('../realtime.js', () => ({
      emit: vi.fn((event: string, payload: any) => {
        if (event === 'log' && payload?.context?.cat === 'pools') emits.push({ level: payload.level, message: payload.message });
      }),
    }));

    // Ensure watchlist non-empty so feed.resume emits
    vi.doMock('../../utils/fs.js', () => ({ readJson: vi.fn(async () => ['X']) }));

    // Avoid network: stub low-level fetchers return empty
    vi.doMock('../pools/raydium.js', () => ({
      fetchRaydiumPoolsRaw: vi.fn(async () => ({ data: [] })),
      normalizeRaydiumPools: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    vi.doMock('../pools/orca.js', () => ({
      fetchOrcaHttp: vi.fn(async () => ({})),
      normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    vi.doMock('../pools/meteora.js', () => ({
      fetchMeteoraHttp: vi.fn(async () => ({})),
      normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));

    // Make bootstrap quick and deterministic
    vi.doMock('./priceBootstrap.js', () => ({
      bootstrapPricesForUniverse: vi.fn(async () => ({ total: 10, priced: 10, missing: 0 })),
      bootstrapPricesForMints: vi.fn(async (m: string[]) => ({ total: m.length, priced: m.length, missing: 0 })),
    }));

    const pools: any = await import('../pools.js');
    await pools.refreshAllSources(true, false);

    const messages = emits.map(e => e.message);
    expect(messages.some(m => m.startsWith('pools:bootstrap api.pause'))).toBe(true);
    expect(messages.some(m => m.startsWith('pools:bootstrap tokens.start'))).toBe(true);
    expect(messages.some(m => m.startsWith('pools:bootstrap tokens.ok'))).toBe(true);
    expect(messages.some(m => m.startsWith('pools:bootstrap universe.start'))).toBe(true);
    expect(messages.some(m => m.startsWith('pools:bootstrap universe.done'))).toBe(true);
    expect(messages.some(m => m.startsWith('pools:bootstrap api.resume'))).toBe(true);
    // feed.resume after all
    expect(messages.some(m => m.startsWith('pools:bootstrap feed.resume'))).toBe(true);
  }, 20000);
});


