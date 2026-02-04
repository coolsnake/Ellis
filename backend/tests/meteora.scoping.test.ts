import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMetPool(id: string, a: string, b: string, price = 1, tvl = 1000) {
  return {
    address: id,
    tokenA: { mint: a, symbol: 'A', decimals: 6 },
    tokenB: { mint: b, symbol: 'B', decimals: 6 },
    current_price: price,
    binStep: 16,
    tvlUsdc: String(tvl),
  } as any;
}

describe('meteora scoping/filtering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    // Clear any graph test pools override between tests
    // @ts-ignore
    (globalThis as any).__graphTestPools = undefined;
  });

  it('universe prefilter off keeps out-of-universe Meteora pools', async () => {
    const META_X = 'META_X';
    const META_Y = 'META_Y';
    const rawPairs = [makeMetPool('MET_POOL_1', META_X, META_Y, 1.2, 5000)];

    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs }) } as any);

    const { CONFIG } = await import('../src/utils/config');
    // Ensure prefilter disabled
    (CONFIG as any).meteora = { ...(CONFIG as any).meteora, universePrefilter: false };
    // Use watchlist universe to avoid accidentally including META_* from external maps
    (CONFIG as any).system = { ...(CONFIG as any).system, tokenUniverseMode: 'watchlist' };

    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const res = await getMeteoraPoolsCached(true);
    expect(res.clmm.length).toBe(1);
    expect(res.clmm[0]?.id).toBe('MET_POOL_1');
  });

  it('universe prefilter on filters out-of-universe Meteora pools', async () => {
    const META_X = 'META_X';
    const META_Y = 'META_Y';
    const rawPairs = [makeMetPool('MET_POOL_2', META_X, META_Y, 1.1, 4000)];

    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs }) } as any);

    const { CONFIG } = await import('../src/utils/config');
    // Enable prefilter
    (CONFIG as any).meteora = { ...(CONFIG as any).meteora, universePrefilter: true };
    // Use empty watchlist universe; anchors won't help since META_* are not anchors
    (CONFIG as any).system = { ...(CONFIG as any).system, tokenUniverseMode: 'watchlist' };

    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const res = await getMeteoraPoolsCached(true);
    expect(res.clmm.length).toBe(0);
  });

  it('graph scoping fallback preserves Meteora when scoping would drop all', async () => {
    const META_X = 'META_X';
    const META_Y = 'META_Y';

    const { CONFIG } = await import('../src/utils/config');
    // Enable graph-level scoping with restrictive universe
    (CONFIG as any).system = { ...(CONFIG as any).system, scopePools: true, scopePoolsMode: 'watchlist' };
    // Avoid dropping edges due to missing USD quotes so we can assert edges deterministically
    (CONFIG as any).sanity = { ...(CONFIG as any).sanity, dropEdgesNoUsdBoth: false };

    // Provide only Meteora pools directly to the graph (bypass caches/network)
    // @ts-ignore
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca: { amm: [], clmm: [] },
      meteora: {
        amm: [],
        clmm: [
          { id: 'MET_ONLY', dex: 'Meteora', mint_a: META_X, mint_b: META_Y, pool_kind: 'dlmm', price_a_per_b: 1.05, fee_bps: 30, liquidity: 0, tick_spacing: 16, updated_ms: Date.now() },
        ],
      },
      meteora_balanced: { amm: [], clmm: [] },
    };

    const graph = await import('../src/server/graph');
    const snap = await graph.getGraphSnapshot(true);
    const metEdges = (snap.edges || []).filter((e: any) => e.dex === 'Meteora');
    expect(metEdges.length).toBeGreaterThan(0);
  });

  it('filterPoolsByUniverse respects anchor bridging for anchored vs non-anchored pairs', async () => {
    const { filterPoolsByUniverse } = await import('../src/server/universe');
    const SOL = 'So11111111111111111111111111111111111111112';
    const NON = 'NON_ANCHOR';

    const pools = {
      amm: [],
      clmm: [
        { mint_a: SOL, mint_b: NON },
        { mint_a: NON, mint_b: NON },
      ],
    };
    const uni = new Set<string>();

    const strict = filterPoolsByUniverse(pools as any, uni, false);
    expect(strict.clmm.length).toBe(0);

    const bridged = filterPoolsByUniverse(pools as any, uni, true);
    expect(bridged.clmm.length).toBe(1);
  });

  it('token blocklist removes Meteora pools containing blocked mints', async () => {
    const META_X = 'META_X';
    const META_Y = 'META_Y';
    const rawPairs = [makeMetPool('MET_BL', META_X, META_Y, 1, 1000)];

    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rawPairs }) } as any);

    const { CONFIG } = await import('../src/utils/config');
    (CONFIG as any).system = { ...(CONFIG as any).system, tokenBlocklistMints: [META_X] };

    const { getMeteoraPoolsCached } = await import('../src/server/pools');
    const res = await getMeteoraPoolsCached(true);
    expect(res.clmm.length).toBe(0);
  });
});


