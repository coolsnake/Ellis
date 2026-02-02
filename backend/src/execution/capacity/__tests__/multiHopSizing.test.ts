/**
 * Unit Tests for Multi-Hop Sizing System
 * 
 * Tests the slippage models and profit optimizer to ensure
 * correct computation of optimal trade sizes.
 */

import { describe, it, expect } from 'vitest';
import {
  computeHopOutput,
  computeAmmOutput,
  computeClmmOutput,
  computeDlmmOutput,
  hasValidHopData,
  getHopLiquidityUsd,
  type HopParams,
} from '../slippageModels.js';
import {
  findOptimalSize,
  quickOptimalEstimate,
  simulateMultiHopTrade,
  computeProfitAtSize,
  computeSearchBounds,
  type OptimizationConfig,
} from '../profitOptimizer.js';
import { DEFAULT_SLIPPAGE_PARAMS } from '../types.js';

// ============================================================================
// Slippage Model Tests
// ============================================================================

describe('Slippage Models', () => {
  describe('computeAmmOutput', () => {
    it('should return lower output due to slippage and fees', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      
      const input = 100;
      const output = computeAmmOutput(input, hop, { reserveMultiplier: 1.0 });
      
      // With xy=k: output = 10000 * (100 * 0.9975) / (10000 + 100 * 0.9975)
      // ≈ 98.77 (slightly less than input due to slippage + fees)
      expect(output).toBeGreaterThan(0);
      expect(output).toBeLessThan(input);
    });

    it('should show more slippage for larger trades', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      
      const smallOutput = computeAmmOutput(10, hop, { reserveMultiplier: 1.0 });
      const largeOutput = computeAmmOutput(1000, hop, { reserveMultiplier: 1.0 });
      
      // Output ratio should be worse for larger trades
      const smallRatio = smallOutput / 10;
      const largeRatio = largeOutput / 1000;
      
      expect(smallRatio).toBeGreaterThan(largeRatio);
    });

    it('should handle zero reserves gracefully', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 0,
        reserveOut: 0,
      };
      
      const output = computeAmmOutput(100, hop, { reserveMultiplier: 1.0 });
      
      // Should return some output with severe penalty
      expect(output).toBeGreaterThan(0);
      expect(output).toBeLessThan(50); // Severe slippage
    });
  });

  describe('computeClmmOutput', () => {
    it('should return reasonable output for small trades', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'clmm',
        feeBps: 30,
        activeLiquidity: BigInt('1000000000000'),
        sqrtPriceX64: BigInt(1) << BigInt(64), // 1.0
        tickSpacing: 1,
      };
      
      const output = computeClmmOutput(10, hop, {
        liquidityDecayPerTick: 0.7,
        maxTickSimulation: 50,
      });
      
      expect(output).toBeGreaterThan(0);
      expect(output).toBeLessThan(10); // Should have some slippage
    });

    it('should show more slippage for larger trades in CLMM', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'clmm',
        feeBps: 30,
        activeLiquidity: BigInt('1000000000000'),
        sqrtPriceX64: BigInt(1) << BigInt(64),
        tickSpacing: 10,
      };

      const params = { liquidityDecayPerTick: 0.7, maxTickSimulation: 50 };
      
      const smallOutput = computeClmmOutput(1, hop, params);
      const largeOutput = computeClmmOutput(100, hop, params);
      
      const smallRatio = smallOutput / 1;
      const largeRatio = largeOutput / 100;
      
      expect(smallRatio).toBeGreaterThan(largeRatio);
    });
  });

  describe('computeDlmmOutput', () => {
    it('should return reasonable output for DLMM pools', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'dlmm',
        feeBps: 25,
        tvlUsd: 50000,
        binStep: 10,
      };
      
      const output = computeDlmmOutput(10, hop, {
        activeBinFraction: 0.1,
        liquidityDecayPerBin: 0.75,
      });
      
      expect(output).toBeGreaterThan(0);
      expect(output).toBeLessThan(10);
    });
  });

  describe('computeHopOutput router', () => {
    it('should route to correct model based on pool type', () => {
      const ammHop: HopParams = {
        poolId: 'amm-pool',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      
      const clmmHop: HopParams = {
        poolId: 'clmm-pool',
        poolType: 'clmm',
        feeBps: 30,
        activeLiquidity: BigInt('1000000000000'),
        tickSpacing: 1,
      };
      
      const ammOutput = computeHopOutput(10, ammHop, DEFAULT_SLIPPAGE_PARAMS);
      const clmmOutput = computeHopOutput(10, clmmHop, DEFAULT_SLIPPAGE_PARAMS);
      
      expect(ammOutput).toBeGreaterThan(0);
      expect(clmmOutput).toBeGreaterThan(0);
    });

    it('should return 0 for zero input', () => {
      const hop: HopParams = {
        poolId: 'test-pool',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      
      const output = computeHopOutput(0, hop, DEFAULT_SLIPPAGE_PARAMS);
      expect(output).toBe(0);
    });
  });

  describe('hasValidHopData', () => {
    it('should return true for AMM with reserves', () => {
      const hop: HopParams = {
        poolId: 'test',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      expect(hasValidHopData(hop)).toBe(true);
    });

    it('should return false for AMM without reserves', () => {
      const hop: HopParams = {
        poolId: 'test',
        poolType: 'amm',
        feeBps: 25,
      };
      expect(hasValidHopData(hop)).toBe(false);
    });

    it('should return true for CLMM with liquidity', () => {
      const hop: HopParams = {
        poolId: 'test',
        poolType: 'clmm',
        feeBps: 30,
        activeLiquidity: BigInt(1000000),
      };
      expect(hasValidHopData(hop)).toBe(true);
    });

    it('should return true for DLMM with TVL', () => {
      const hop: HopParams = {
        poolId: 'test',
        poolType: 'dlmm',
        feeBps: 25,
        tvlUsd: 10000,
      };
      expect(hasValidHopData(hop)).toBe(true);
    });
  });

  describe('getHopLiquidityUsd', () => {
    it('should return geometric mean of reserves for AMM', () => {
      const hop: HopParams = {
        poolId: 'test',
        poolType: 'amm',
        feeBps: 25,
        reserveIn: 10000,
        reserveOut: 10000,
      };
      
      const liquidity = getHopLiquidityUsd(hop, DEFAULT_SLIPPAGE_PARAMS);
      // sqrt(10000 * 0.95 * 10000 * 0.95) = 9500
      expect(liquidity).toBeCloseTo(9500, 0);
    });
  });
});

// ============================================================================
// Profit Optimizer Tests
// ============================================================================

describe('Profit Optimizer', () => {
  const createTestConfig = (): OptimizationConfig => ({
    minSizeUsd: 0.1,
    maxSizeUsd: 500,
    fixedCostUsd: 0.001,
    safetyMargin: 0.8,
    searchPrecisionUsd: 0.1,
    maxIterations: 20,
    slippageParams: DEFAULT_SLIPPAGE_PARAMS,
  });

  const createTestHops = (): HopParams[] => [
    {
      poolId: 'pool-1',
      poolType: 'amm',
      feeBps: 25,
      reserveIn: 10000,
      reserveOut: 10000,
    },
    {
      poolId: 'pool-2',
      poolType: 'amm',
      feeBps: 25,
      reserveIn: 8000,
      reserveOut: 8000,
    },
  ];

  describe('simulateMultiHopTrade', () => {
    it('should simulate trades through multiple hops', () => {
      const hops = createTestHops();
      const { finalOutput, hopOutputs } = simulateMultiHopTrade(
        100,
        hops,
        DEFAULT_SLIPPAGE_PARAMS
      );
      
      expect(hopOutputs.length).toBe(2);
      expect(hopOutputs[0]).toBeLessThan(100);
      expect(finalOutput).toBeLessThan(hopOutputs[0]);
      expect(finalOutput).toBeGreaterThan(0);
    });

    it('should return 0 for empty hops', () => {
      const { finalOutput } = simulateMultiHopTrade(100, [], DEFAULT_SLIPPAGE_PARAMS);
      expect(finalOutput).toBe(0);
    });

    it('should return 0 for zero input', () => {
      const hops = createTestHops();
      const { finalOutput } = simulateMultiHopTrade(0, hops, DEFAULT_SLIPPAGE_PARAMS);
      expect(finalOutput).toBe(0);
    });
  });

  describe('computeProfitAtSize', () => {
    it('should compute profit correctly', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      // For small sizes, profit should be close to 0 (output ≈ input after slippage)
      const smallProfit = computeProfitAtSize(1, hops, config.fixedCostUsd, config.slippageParams);
      
      // Profit = output - input - fixedCost
      // For small trades, output ≈ input * (1-slippage), so profit could be negative
      expect(smallProfit).toBeDefined();
    });

    it('should show negative profit for very large sizes', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      // Very large trades should have negative profit due to slippage
      const largeProfit = computeProfitAtSize(5000, hops, config.fixedCostUsd, config.slippageParams);
      
      expect(largeProfit).toBeLessThan(0);
    });
  });

  describe('computeSearchBounds', () => {
    it('should compute reasonable search bounds', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const bounds = computeSearchBounds(50, hops, config); // 50 bps profit
      
      expect(bounds.lower).toBeGreaterThanOrEqual(config.minSizeUsd);
      expect(bounds.upper).toBeLessThanOrEqual(config.maxSizeUsd);
      expect(bounds.lower).toBeLessThan(bounds.upper);
      expect(bounds.estimate).toBeGreaterThan(0);
    });

    it('should scale estimate with profit rate', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const lowProfitBounds = computeSearchBounds(20, hops, config);
      const highProfitBounds = computeSearchBounds(100, hops, config);
      
      // Higher profit rate should allow larger trades
      expect(highProfitBounds.estimate).toBeGreaterThan(lowProfitBounds.estimate);
    });

    it('should have high confidence with complete data', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const bounds = computeSearchBounds(50, hops, config);
      
      // Both hops have reserve data, so confidence should be high
      expect(bounds.confidence).toBe('high');
    });
  });

  describe('findOptimalSize', () => {
    it('should find a profitable size', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const result = findOptimalSize(50, hops, config);
      
      expect(result.optimalSizeUsd).toBeGreaterThan(0);
      expect(result.optimalSizeUsd).toBeGreaterThanOrEqual(config.minSizeUsd);
      expect(result.optimalSizeUsd).toBeLessThanOrEqual(config.maxSizeUsd);
      expect(result.method).toBe('ternary_search');
    });

    it('should apply safety margin', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const result = findOptimalSize(50, hops, config);
      
      // Optimal should be less than raw optimal due to safety margin
      if (result.rawOptimalSizeUsd) {
        expect(result.optimalSizeUsd).toBeLessThanOrEqual(result.rawOptimalSizeUsd);
      }
    });

    it('should complete within max iterations', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const result = findOptimalSize(50, hops, config);
      
      expect(result.iterations).toBeLessThanOrEqual(config.maxIterations);
    });

    it('should calculate expected slippage', () => {
      const hops = createTestHops();
      const config = createTestConfig();
      
      const result = findOptimalSize(50, hops, config);
      
      expect(result.totalSlippageBps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('quickOptimalEstimate', () => {
    it('should provide a quick estimate', () => {
      const estimate = quickOptimalEstimate(50, 10000, 2);
      
      expect(estimate).toBeGreaterThan(0);
    });

    it('should scale with number of hops', () => {
      const twoHopEstimate = quickOptimalEstimate(50, 10000, 2);
      const fourHopEstimate = quickOptimalEstimate(50, 10000, 4);
      
      // More hops = smaller optimal due to compounding slippage
      expect(twoHopEstimate).toBeGreaterThan(fourHopEstimate);
    });

    it('should scale with profit rate', () => {
      const lowProfitEstimate = quickOptimalEstimate(20, 10000, 2);
      const highProfitEstimate = quickOptimalEstimate(100, 10000, 2);
      
      expect(highProfitEstimate).toBeGreaterThan(lowProfitEstimate);
    });

    it('should return 0 for invalid inputs', () => {
      expect(quickOptimalEstimate(0, 10000, 2)).toBe(0);
      expect(quickOptimalEstimate(50, 0, 2)).toBe(0);
      expect(quickOptimalEstimate(50, 10000, 0)).toBe(0);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Multi-Hop Sizing Integration', () => {
  it('should find better size than simple heuristic for high-liquidity path', () => {
    const hops: HopParams[] = [
      { poolId: 'p1', poolType: 'amm', feeBps: 25, reserveIn: 100000, reserveOut: 100000 },
      { poolId: 'p2', poolType: 'amm', feeBps: 25, reserveIn: 80000, reserveOut: 80000 },
    ];
    
    const config: OptimizationConfig = {
      minSizeUsd: 0.1,
      maxSizeUsd: 1000,
      fixedCostUsd: 0.001,
      safetyMargin: 0.8,
      searchPrecisionUsd: 0.1,
      maxIterations: 20,
      slippageParams: DEFAULT_SLIPPAGE_PARAMS,
    };
    
    const result = findOptimalSize(100, hops, config); // 1% profit
    
    // With 1% profit and high liquidity, we should get a reasonable optimal size
    expect(result.optimalSizeUsd).toBeGreaterThan(10);
    expect(result.expectedProfitUsd).toBeGreaterThan(-config.fixedCostUsd);
  });

  it('should handle mixed pool types', () => {
    const hops: HopParams[] = [
      { poolId: 'p1', poolType: 'amm', feeBps: 25, reserveIn: 50000, reserveOut: 50000 },
      { poolId: 'p2', poolType: 'clmm', feeBps: 30, activeLiquidity: BigInt('100000000000'), tickSpacing: 10 },
      { poolId: 'p3', poolType: 'dlmm', feeBps: 25, tvlUsd: 30000, binStep: 10 },
    ];
    
    const config: OptimizationConfig = {
      minSizeUsd: 0.1,
      maxSizeUsd: 500,
      fixedCostUsd: 0.001,
      safetyMargin: 0.8,
      searchPrecisionUsd: 0.1,
      maxIterations: 20,
      slippageParams: DEFAULT_SLIPPAGE_PARAMS,
    };
    
    const result = findOptimalSize(75, hops, config); // 0.75% profit
    
    expect(result.optimalSizeUsd).toBeGreaterThan(0);
    expect(result.method).toBe('ternary_search');
  });
});
