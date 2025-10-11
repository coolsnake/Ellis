// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

describe('refreshAllSources deep bootstrap gating', () => {

  it('awaits token list + universe bootstrap before pool fetchers', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../../utils/tokens.js', () => ({
      fetchAndCacheJupiterTokens: vi.fn(async () => { calls.push('tokens'); }),
    }));
    vi.doMock('../priceBootstrap.js', () => ({
      bootstrapPricesForUniverse: vi.fn(async () => { calls.push('boot.uni'); return { total: 100, priced: 50, missing: 50 }; }),
      bootstrapPricesForMints: vi.fn(async () => { calls.push('boot.mints'); return { total: 2, priced: 2, missing: 0 }; }),
    }));
    vi.doMock('../feedRegistry.js', () => ({
      enablePriceFeed: vi.fn(),
      isPriceFeedEnabled: vi.fn(() => true),
    }));
    vi.doMock('../../jupiter/rateLimiter.js', () => ({
      apiStop: vi.fn(() => { calls.push('api.stop'); }),
      apiStart: vi.fn(() => { calls.push('api.start'); }),
    }));
    // Stub pool fetchers to record call order
    vi.doMock('../pools.ts', async (orig) => {
      const real: any = await vi.importActual('../pools.ts');
      return {
        ...real,
        getRaydiumPoolsNormalized: vi.fn(async () => { calls.push('ray'); return { amm: [], clmm: [] }; }),
        getOrcaPoolsCached: vi.fn(async () => { calls.push('orc'); return { amm: [], clmm: [] }; }),
        getMeteoraPoolsCached: vi.fn(async () => { calls.push('met'); return { amm: [], clmm: [] }; }),
      };
    });
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    // Ensure ordering: api.stop -> tokens -> boot.uni -> api.start -> pool fetchers
    const sequence = calls.join('>');
    expect(sequence.includes('api.stop>tokens>boot.uni>api.start>ray')).toBe(true);
  });

  it('falls back to pool-sourced mints when universe empty', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../../utils/tokens.js', () => ({ fetchAndCacheJupiterTokens: vi.fn(async () => calls.push('tokens')) }));
    vi.doMock('../priceBootstrap.js', () => ({
      bootstrapPricesForUniverse: vi.fn(async () => ({ total: 0, priced: 0, missing: 0 })),
      bootstrapPricesForMints: vi.fn(async (mints: string[]) => { calls.push(`boot.mints:${mints.length}`); return { total: mints.length, priced: mints.length, missing: 0 }; }),
    }));
    vi.doMock('../universe.js', () => ({
      getSourceTokenSet: vi.fn(async (src: string) => new Set(src === 'raydium' ? ['A'] : ['B'])),
      getJupiterTokenSet: vi.fn(async () => new Set(['X'])),
    }));
    vi.doMock('../feedRegistry.js', () => ({ enablePriceFeed: vi.fn(), isPriceFeedEnabled: vi.fn(() => false) }));
    vi.doMock('../../jupiter/rateLimiter.js', () => ({ apiStop: vi.fn(), apiStart: vi.fn() }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(calls.some(s => s.startsWith('boot.mints:'))).toBe(true);
  });

  it('secondary pass backfills non-Jupiter mints', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../priceBootstrap.js', async (orig) => {
      const real: any = await vi.importActual('../priceBootstrap.js');
      return {
        ...real,
        bootstrapPricesForMints: vi.fn(async (mints: string[], opts?: any) => {
          if (opts?.cat === 'pools.refresh.outsideJup') calls.push(`outside:${mints.length}`);
          return { total: mints.length, priced: mints.length, missing: 0 };
        }),
        bootstrapPricesForUniverse: vi.fn(async () => ({ total: 10, priced: 10, missing: 0 })),
      };
    });
    vi.doMock('../universe.js', () => ({
      getJupiterTokenSet: vi.fn(async () => new Set(['X'])),
    }));
    vi.doMock('../pools.ts', async () => ({
      // Force mint set to include non-Jupiter mints post-fetch
      getRaydiumPoolsNormalized: vi.fn(async () => ({ amm: [{ mint_a: 'A', mint_b: 'B' }], clmm: [] })),
      getOrcaPoolsCached: vi.fn(async () => ({ amm: [], clmm: [{ mint_a: 'C', mint_b: 'D' }] })),
      getMeteoraPoolsCached: vi.fn(async () => ({ amm: [], clmm: [] })),
      getMeteoraBalancedPoolsCached: vi.fn(async () => ({ amm: [], clmm: [] })),
      refreshAllSources: (await vi.importActual('../pools.ts') as any).refreshAllSources,
    }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(calls.some(s => s.startsWith('outside:'))).toBe(true);
  });

  it('respects pausePriceFeedDuringBootstrap flag', async () => {
    vi.resetModules();
    vi.doMock('../../utils/config.js', async (orig) => {
      const real: any = await vi.importActual('../../utils/config.js');
      return { ...real, CONFIG: { ...real.CONFIG, system: { ...real.CONFIG.system, pausePriceFeedDuringBootstrap: false } } };
    });
    const feed = { enablePriceFeed: vi.fn(), isPriceFeedEnabled: vi.fn(() => true) };
    vi.doMock('../feedRegistry.js', () => feed);
    vi.doMock('../../jupiter/rateLimiter.js', () => ({ apiStop: vi.fn(), apiStart: vi.fn() }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(feed.enablePriceFeed).not.toHaveBeenCalledWith(false);
  });

  it('resumes feed only when previously enabled or watchlist non-empty', async () => {
    vi.resetModules();
    const feed = { enablePriceFeed: vi.fn(), isPriceFeedEnabled: vi.fn(() => true) };
    vi.doMock('../feedRegistry.js', () => feed);
    vi.doMock('../../utils/fs.js', () => ({ readJson: vi.fn(async () => ['X']) }));
    vi.doMock('../../jupiter/rateLimiter.js', () => ({ apiStop: vi.fn(), apiStart: vi.fn() }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(feed.enablePriceFeed).toHaveBeenCalledWith(true);
  });
});


