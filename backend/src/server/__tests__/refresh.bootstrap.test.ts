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
    // Stub low-level fetchers to avoid network and record order
    vi.doMock('../pools/raydium.js', () => ({
      fetchRaydiumPoolsRaw: vi.fn(async () => { calls.push('ray'); return { data: [] }; }),
      normalizeRaydiumPools: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    vi.doMock('../pools/orca.js', () => ({
      fetchOrcaHttp: vi.fn(async () => { calls.push('orc'); return {}; }),
      normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    vi.doMock('../pools/meteora.js', () => ({
      fetchMeteoraHttp: vi.fn(async () => { calls.push('met'); return {}; }),
      normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    // Ensure ordering: api.stop -> tokens -> boot.uni -> api.start -> pool fetchers
    const sequence = calls.join('>');
    expect(sequence.includes('api.stop>tokens>boot.uni>api.start>ray')).toBe(true);
  }, 20000);

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
    // Stub low-level fetchers to avoid network
    vi.doMock('../pools/raydium.js', () => ({ fetchRaydiumPoolsRaw: vi.fn(async () => ({ data: [] })), normalizeRaydiumPools: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/orca.js', () => ({ fetchOrcaHttp: vi.fn(async () => ({})), normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/meteora.js', () => ({ fetchMeteoraHttp: vi.fn(async () => ({})), normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(calls.some(s => s.startsWith('boot.mints:'))).toBe(true);
  }, 20000);

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
    // Stub low-level fetchers to produce desired mint sets via normalize outputs
    vi.doMock('../pools/raydium.js', () => ({
      fetchRaydiumPoolsRaw: vi.fn(async () => ({})),
      normalizeRaydiumPools: vi.fn(async () => ({ amm: [{ mint_a: 'A', mint_b: 'B' }], clmm: [] })),
    }));
    vi.doMock('../pools/orca.js', () => ({
      fetchOrcaHttp: vi.fn(async () => ({})),
      normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [{ mint_a: 'C', mint_b: 'D' }] })),
    }));
    vi.doMock('../pools/meteora.js', () => ({
      fetchMeteoraHttp: vi.fn(async () => ({})),
      normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })),
    }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(calls.some(s => s.startsWith('outside:'))).toBe(true);
  }, 20000);

  it('respects pausePriceFeedDuringBootstrap flag', async () => {
    vi.resetModules();
    vi.doMock('../../utils/config.js', async (orig) => {
      const real: any = await vi.importActual('../../utils/config.js');
      return { ...real, CONFIG: { ...real.CONFIG, system: { ...real.CONFIG.system, pausePriceFeedDuringBootstrap: false } } };
    });
    const feed = { enablePriceFeed: vi.fn(), isPriceFeedEnabled: vi.fn(() => true) };
    vi.doMock('../feedRegistry.js', () => feed);
    vi.doMock('../../jupiter/rateLimiter.js', () => ({ apiStop: vi.fn(), apiStart: vi.fn() }));
    // Stub low-level fetchers to avoid network
    vi.doMock('../pools/raydium.js', () => ({ fetchRaydiumPoolsRaw: vi.fn(async () => ({ data: [] })), normalizeRaydiumPools: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/orca.js', () => ({ fetchOrcaHttp: vi.fn(async () => ({})), normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/meteora.js', () => ({ fetchMeteoraHttp: vi.fn(async () => ({})), normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    vi.restoreAllMocks();
    expect(feed.enablePriceFeed).not.toHaveBeenCalledWith(false);
  }, 20000);

  it('resumes feed only when previously enabled or watchlist non-empty', async () => {
    vi.resetModules();
    // Spy on actual feedRegistry module so dynamic import in pools.ts hits the same instance
    const reg: any = await import('../feedRegistry.js');
    const enableSpy = vi.spyOn(reg, 'enablePriceFeed').mockImplementation(() => undefined);
    vi.spyOn(reg, 'isPriceFeedEnabled').mockReturnValue(true);
    vi.doMock('../../utils/fs.js', () => ({ readJson: vi.fn(async () => ['X']) }));
    vi.doMock('../../jupiter/rateLimiter.js', () => ({ apiStop: vi.fn(), apiStart: vi.fn() }));
    // Stub low-level fetchers to avoid network
    vi.doMock('../pools/raydium.js', () => ({ fetchRaydiumPoolsRaw: vi.fn(async () => ({ data: [] })), normalizeRaydiumPools: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/orca.js', () => ({ fetchOrcaHttp: vi.fn(async () => ({})), normalizeOrcaHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    vi.doMock('../pools/meteora.js', () => ({ fetchMeteoraHttp: vi.fn(async () => ({})), normalizeMeteoraHttp: vi.fn(async () => ({ amm: [], clmm: [] })) }));
    const mod: any = await import('../pools.js');
    await mod.refreshAllSources(true, false);
    expect(enableSpy).toHaveBeenCalledWith(true);
    vi.restoreAllMocks();
  }, 20000);
});


