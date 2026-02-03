/**
 * Discovery Integration Tests
 * 
 * Tests for the full discovery pipeline including API calls.
 * Set RUN_REAL_E2E=true to run tests that make real API calls.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Skip tests if not in E2E mode
const shouldRunE2E = process.env.RUN_REAL_E2E === 'true';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock CONFIG for tests
vi.mock('../src/utils/config.js', () => ({
  CONFIG: {
    discovery: {
      enabled: false,
      intervalMs: 300000,
      jupiterApiKey: process.env.JUPITER_API_KEY || '',
      jupiterCategory: 'toptraded',
      jupiterInterval: '5m',
      jupiterLimit: 10,
      dexScreenerDelayMs: 200,
      dexScreenerBatchSize: 5,
      minLiquidityUsd: 1000,
      maxPoolsPerToken: 10,
      supportedDexIds: ['raydium', 'orca', 'meteora', 'pumpswap'],
    },
    system: {
      jupiterTopTokens: {
        apiKey: process.env.JUPITER_API_KEY || '',
        category: 'toptraded',
        interval: '5m',
        limit: 10,
        cacheTtlMs: 60000,
      },
    },
  },
}));

describe('Discovery Integration', () => {
  describe('DexScreener API', () => {
    it.skipIf(!shouldRunE2E)('should fetch pools for SOL token', async () => {
      const { fetchDexScreenerPools } = await import('../src/server/discovery/dexScreener.js');
      
      const SOL = 'So11111111111111111111111111111111111111112';
      const pools = await fetchDexScreenerPools(SOL);
      
      expect(pools).toBeDefined();
      expect(Array.isArray(pools)).toBe(true);
      expect(pools.length).toBeGreaterThan(0);
      
      // Check that pools have required fields
      const firstPool = pools[0];
      expect(firstPool.pairAddress).toBeDefined();
      expect(firstPool.dexId).toBeDefined();
      expect(firstPool.baseToken).toBeDefined();
      expect(firstPool.quoteToken).toBeDefined();
    });

    it.skipIf(!shouldRunE2E)('should fetch pools for USDC token', async () => {
      const { fetchDexScreenerPools, filterBySupportedDex } = await import('../src/server/discovery/dexScreener.js');
      
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const pools = await fetchDexScreenerPools(USDC);
      
      expect(pools).toBeDefined();
      expect(Array.isArray(pools)).toBe(true);
      
      // Filter to supported DEXes
      const supported = filterBySupportedDex(pools);
      expect(supported.length).toBeGreaterThan(0);
      
      // Check that supported pools are from expected DEXes
      for (const pool of supported) {
        expect(['raydium', 'orca', 'meteora', 'pumpswap']).toContain(pool.dexId);
      }
    });

    it.skipIf(!shouldRunE2E)('should handle rate limiting gracefully', async () => {
      const { fetchDexScreenerPoolsBatch } = await import('../src/server/discovery/dexScreener.js');
      
      // Fetch pools for multiple tokens
      const tokens = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      ];
      
      let progress: number[] = [];
      const results = await fetchDexScreenerPoolsBatch(tokens, {
        batchSize: 2,
        onProgress: (completed, total) => {
          progress.push(completed);
        },
      });
      
      expect(results.size).toBe(2);
      expect(progress.length).toBeGreaterThan(0);
    });
  });

  describe('Jupiter API', () => {
    it.skipIf(!shouldRunE2E)('should fetch top traded tokens', async () => {
      const { fetchJupiterTopTokens } = await import('../src/server/discovery/tokenDiscovery.js');
      
      const tokens = await fetchJupiterTopTokens();
      
      expect(tokens).toBeDefined();
      expect(Array.isArray(tokens)).toBe(true);
      // May return empty if API key is not set, which is expected
    });
  });

  describe('Full Discovery Cycle (Mocked)', () => {
    it('should complete a dry-run discovery cycle', async () => {
      // For unit testing, we mock the external API calls
      const { runDiscoveryCycle } = await import('../src/server/discovery/tokenDiscovery.js');
      
      // Run with dry-run to avoid actual pool integration
      const result = await runDiscoveryCycle({
        maxTokens: 0, // Skip token fetching
        dryRun: true,
      });
      
      expect(result).toBeDefined();
      expect(result.tokensChecked).toBe(0);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });
});

describe('Discovery Task Management', () => {
  it('should track running state correctly', async () => {
    const { 
      isDiscoveryRunning, 
      startDiscoveryLoop, 
      stopDiscoveryLoop,
      getDiscoveryStatus,
    } = await import('../src/server/tasks/discovery.js');
    
    // Initially not running
    expect(isDiscoveryRunning()).toBe(false);
    
    // Start the loop (with long interval to avoid actual runs)
    startDiscoveryLoop(3600_000, false);
    expect(isDiscoveryRunning()).toBe(true);
    
    // Check status
    const status = getDiscoveryStatus();
    expect(status.running).toBe(true);
    expect(status.nextRunAt).toBeDefined();
    
    // Stop the loop
    stopDiscoveryLoop();
    expect(isDiscoveryRunning()).toBe(false);
  });

  it('should prevent double-starting', async () => {
    const { 
      isDiscoveryRunning, 
      startDiscoveryLoop, 
      stopDiscoveryLoop,
    } = await import('../src/server/tasks/discovery.js');
    
    // Start once
    startDiscoveryLoop(3600_000, false);
    expect(isDiscoveryRunning()).toBe(true);
    
    // Try to start again (should be no-op, no error)
    startDiscoveryLoop(3600_000, false);
    expect(isDiscoveryRunning()).toBe(true);
    
    // Cleanup
    stopDiscoveryLoop();
  });
});
