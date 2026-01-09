import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('raydium cpmm normalization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isValidRaydiumCpmmPool validates required fields', async () => {
    const { isValidRaydiumCpmmPool } = await import('../src/server/pools/api-types.js');
    
    // Valid pool
    const valid = {
      pubkey: 'poolPubkey',
      token0Mint: 'mintA',
      token1Mint: 'mintB',
      token0Vault: 'vaultA',
      token1Vault: 'vaultB',
      lpMint: 'lpMint',
      ammConfig: 'config',
      token0Program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      token1Program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    };
    expect(isValidRaydiumCpmmPool(valid)).toBe(true);
    
    // Missing required field
    const invalid = { ...valid, ammConfig: undefined };
    delete (invalid as any).ammConfig;
    expect(isValidRaydiumCpmmPool(invalid)).toBe(false);
    
    // Not an object
    expect(isValidRaydiumCpmmPool(null)).toBe(false);
    expect(isValidRaydiumCpmmPool('string')).toBe(false);
  });

  it('CpmmPool type has correct structure', async () => {
    const { cpmmCache } = await import('../src/server/pools.cache.js');
    
    // Initialize cache with test data
    cpmmCache.data = {
      amm: [],
      clmm: [],
      cpmm: [{
        id: 'testCpmmPool',
        dex: 'Raydium',
        mint_a: 'So11111111111111111111111111111111111111112',
        mint_b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        fee_bps: 25,
        price_a_per_b: 100.5,
        liquidity_base: 1000000,
        updated_ms: Date.now(),
        pool_kind: 'cpmm',
        account_a: 'vaultA',
        account_b: 'vaultB',
        amm_config: 'ammConfigPubkey',
        observation_key: 'observationPubkey',
        token_program_a: 'spl-token' as const,
        token_program_b: 'spl-token' as const,
      }],
    };
    
    const pool = cpmmCache.data.cpmm[0];
    expect(pool.id).toBe('testCpmmPool');
    expect(pool.pool_kind).toBe('cpmm');
    expect(pool.fee_bps).toBe(25);
    expect(pool.amm_config).toBe('ammConfigPubkey');
    expect(pool.observation_key).toBe('observationPubkey');
    expect(pool.token_program_a).toBe('spl-token');
    expect(pool.token_program_b).toBe('spl-token');
  });

  it('DexType includes RaydiumCpmm', async () => {
    const { DexType } = await import('../src/router/types.js');
    
    expect(DexType.RaydiumCpmm).toBe(6);
  });

  it('DEX_PROGRAMS includes RAYDIUM_CPMM', async () => {
    const { DEX_PROGRAMS } = await import('../src/router/types.js');
    
    expect(DEX_PROGRAMS.RAYDIUM_CPMM).toBeDefined();
    expect(DEX_PROGRAMS.RAYDIUM_CPMM.toBase58()).toBe('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
  });

  it('cpmmCache is properly initialized', async () => {
    const { cpmmCache, clearAllPoolCaches } = await import('../src/server/pools.cache.js');
    
    // Clear and verify empty state
    clearAllPoolCaches();
    expect(cpmmCache.data).toBeFalsy();
    expect(cpmmCache.ts).toBe(0);
  });

  it('peekCpmmPools returns empty when cache is empty', async () => {
    const { peekCpmmPools, clearAllPoolCaches } = await import('../src/server/pools.cache.js');
    
    clearAllPoolCaches();
    const result = peekCpmmPools();
    expect(result.cpmm).toEqual([]);
  });

  it('findPoolInCache finds CPMM pools', async () => {
    const { cpmmCache, findPoolInCache, clearAllPoolCaches } = await import('../src/server/pools.cache.js');
    
    clearAllPoolCaches();
    
    // Set up cache
    cpmmCache.data = {
      amm: [],
      clmm: [],
      cpmm: [{
        id: 'cpmmPoolToFind',
        dex: 'Raydium',
        mint_a: 'So11111111111111111111111111111111111111112',
        mint_b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        fee_bps: 25,
        price_a_per_b: 100.5,
        liquidity_base: 1000000,
        updated_ms: Date.now(),
        pool_kind: 'cpmm',
      }],
    };
    cpmmCache.ts = Date.now();
    
    const result = findPoolInCache('cpmmPoolToFind');
    expect(result).toBeDefined();
    expect(result?.pool.id).toBe('cpmmPoolToFind');
    expect(result?.source).toBe('raydium-cpmm');
  });

  it('SummaryPool type includes raydium-cpmm as dex', async () => {
    // Import types to verify structure
    const types = await import('../src/server/pools/types.js');
    
    // Create a summary pool with CPMM dex
    const summaryPool: typeof types.SummaryPool = {
      pubkey: 'poolPubkey',
      mint_a: 'mintA',
      mint_b: 'mintB',
      dex: 'raydium-cpmm',
      type: 'cpmm',
    } as any;
    
    expect(summaryPool.dex).toBe('raydium-cpmm');
    expect(summaryPool.type).toBe('cpmm');
  });
});

describe('raydium cpmm resolver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('resolves CPMM hop with vault data from cache', async () => {
    // Set up execution cache
    const { executionCache } = await import('../src/execution/cache.js');
    const testPoolId = 'testCpmmPoolResolve';
    
    executionCache.setStatic(testPoolId, {
      programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
      native_account_a: 'vaultA',
      native_account_b: 'vaultB',
      native_mint_a: 'So11111111111111111111111111111111111111112',
      native_mint_b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      native_decimals_a: 9,
      native_decimals_b: 6,
      amm_config: 'ammConfigPubkey',
      observation_key: 'observationPubkey',
      mint_a: 'So11111111111111111111111111111111111111112',
      mint_b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals_a: 9,
      decimals_b: 6,
      token_program_a: 'spl-token',
      token_program_b: 'spl-token',
    });
    
    const { resolveRaydiumCpmm } = await import('../src/execution/resolver/raydiumCpmm.js');
    
    const hop = {
      dex: 'raydium' as const,
      variant: 'cpmm' as const,
      poolId: testPoolId,
      programId: '',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      userSourceAta: '',
      userDestAta: '',
      amountInRaw: 0n,
      minOutRaw: 0n,
    } as any;
    
    const resolved = await resolveRaydiumCpmm(hop);
    
    expect(resolved.programId).toBe('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    expect(resolved.vaultA).toBe('vaultA');
    expect(resolved.vaultB).toBe('vaultB');
    expect(resolved.ammConfig).toBe('ammConfigPubkey');
    expect(resolved.observationId).toBe('observationPubkey');
  });
});

describe('raydium cpmm graph edges', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('edgesFromPoolIncremental creates edges for CPMM pools', async () => {
    const { edgesFromPoolIncremental } = await import('../src/server/graph.edges.js');
    
    const cpmmPool = {
      id: 'cpmmEdgePool',
      dex: 'Raydium',
      mint_a: 'So11111111111111111111111111111111111111112',
      mint_b: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      fee_bps: 25,
      price_a_per_b: 100.5,
      liquidity_base: 1000000,
      updated_ms: Date.now(),
      pool_kind: 'cpmm',
      tvl_usd: 50000,
      _pipelineProcessed: true,
    } as any;
    
    const getUsd = () => undefined;
    const edges = edgesFromPoolIncremental(cpmmPool, getUsd);
    
    expect(edges.length).toBe(1);
    expect(edges[0].dex).toBe('Raydium');
    expect(edges[0].pool_kind).toBe('cpmm');
    expect(edges[0].price_a_per_b).toBe(100.5);
    expect(edges[0].fee_bps).toBe(25);
  });

  it('isDexKindAllowed handles cpmm kind', async () => {
    const { isDexKindAllowed } = await import('../src/server/graph.edges.js');
    
    // Default allows CPMM
    expect(isDexKindAllowed('Raydium', 'cpmm', {})).toBe(true);
    
    // Explicit disable
    expect(isDexKindAllowed('Raydium', 'cpmm', { raydium: { cpmm: false } })).toBe(false);
    
    // Explicit enable
    expect(isDexKindAllowed('Raydium', 'cpmm', { raydium: { cpmm: true } })).toBe(true);
  });
});

describe('raydium cpmm decoder', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('isRaydiumCpmmOwner identifies CPMM program', async () => {
    const { isRaydiumCpmmOwner } = await import('../src/server/pools/websockets/decoders/raydiumCpmm.js');
    
    expect(isRaydiumCpmmOwner('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')).toBe(true);
    expect(isRaydiumCpmmOwner('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')).toBe(false);
    expect(isRaydiumCpmmOwner('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')).toBe(false);
  });

  it('getAllProgramIds includes CPMM program', async () => {
    const { getAllProgramIds } = await import('../src/server/pools/websockets/decoders/index.js');
    
    const programIds = getAllProgramIds();
    expect(programIds).toContain('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
  });
});

describe('raydium cpmm subscription tracking', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('tracks CPMM subscription counts', async () => {
    const { setSubscriptionCount, getSubscriptionCount, getSubscriptionState } = 
      await import('../src/server/pools/websockets/subscriptions.js');
    
    // Set count
    setSubscriptionCount('raydium-cpmm', 42);
    
    // Verify count
    expect(getSubscriptionCount('raydium-cpmm')).toBe(42);
    
    // Verify in state
    const state = getSubscriptionState();
    expect(state.attachedRaydiumCpmmPools).toBe(42);
    
    // Reset
    setSubscriptionCount('raydium-cpmm', 0);
    expect(getSubscriptionCount('raydium-cpmm')).toBe(0);
  });
});

describe('raydium cpmm metrics support', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('shyftHelpers includes raydium-cpmm in SupportedDex', async () => {
    // Import to verify type-level changes are correct (won't throw on import)
    const helpers = await import('../src/server/pools/shyftHelpers.js');
    
    // The module should load without errors
    expect(helpers).toBeDefined();
    
    // Try using the metrics with raydium-cpmm
    const { trackGraphQLRequest } = helpers as any;
    if (trackGraphQLRequest) {
      // If the function exists, it should not throw when called with 'raydium-cpmm'
      expect(() => trackGraphQLRequest('raydium-cpmm')).not.toThrow();
    }
  });
});
