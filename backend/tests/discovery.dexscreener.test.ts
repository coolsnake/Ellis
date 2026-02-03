/**
 * DexScreener Mapping Unit Tests
 * 
 * Tests for the DexScreener to internal pool type mapping logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mapDexScreenerToInternal,
  filterBySupportedDex,
  filterByMinLiquidity,
  filterOutTracked,
  mapAndFilterPools,
  groupPoolsByDex,
  getPoolTypeName,
} from '../src/server/discovery/dexScreener.js';
import type { DexScreenerPool } from '../src/server/discovery/types.js';

// Mock logger to prevent console spam
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('DexScreener Mapping', () => {
  describe('mapDexScreenerToInternal', () => {
    // Raydium Tests
    describe('Raydium', () => {
      it('should map Raydium CLMM correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'raydium',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF',
          labels: ['CLMM'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'raydium', poolKind: 'clmm' });
      });

      it('should map Raydium CPMM correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'raydium',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '4iPcCSJ2GPywFAju8cxkfnQQzftwhXAjUc8pTBAKeCpq',
          labels: ['CPMM'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'raydium', poolKind: 'cpmm' });
      });

      it('should map Raydium AMM v4 (no label) correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'raydium',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
          baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
          quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin', symbol: 'USDC' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'raydium', poolKind: 'amm' });
      });

      it('should handle case-insensitive CLMM label', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'raydium',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'abc',
          labels: ['clmm'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'raydium', poolKind: 'clmm' });
      });
    });

    // Orca Tests
    describe('Orca', () => {
      it('should map Orca Whirlpool correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'orca',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
          labels: ['wp'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'orca', poolKind: 'clmm' });
      });

      it('should map Orca without labels as CLMM', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'orca',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'abc',
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'orca', poolKind: 'clmm' });
      });
    });

    // Meteora Tests
    describe('Meteora', () => {
      it('should map Meteora DLMM correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'meteora',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
          labels: ['DLMM'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'meteora', poolKind: 'clmm' });
      });

      it('should map Meteora DAMM v1 (DYN) correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'meteora',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '5yuefgbJJpmFNK2iiYbLSpv1aZXq7F9AUKkZKErTYCvs',
          labels: ['DYN'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'meteora_balanced', poolKind: 'amm', variant: 'v1' });
      });

      it('should map Meteora DAMM v2 (DYN2) correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'meteora',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie',
          labels: ['DYN2'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'meteora_balanced', poolKind: 'amm', variant: 'v2' });
      });

      it('should return null for unknown Meteora variant', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'meteora',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'abc',
          labels: ['UNKNOWN'],
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toBeNull();
      });
    });

    // PumpSwap Tests
    describe('PumpSwap', () => {
      it('should map PumpSwap correctly', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'pumpswap',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: '9QENPAsLYG6ysiUiJyGDAHj1RNocGAZbga28wEMYm9Nq',
          baseToken: { address: 'GuEDZL2y6rtrF2GFve2unhRUUPEpDrargKoNpJazZSQd', name: 'Test Token', symbol: 'TEST' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
        };
        expect(mapDexScreenerToInternal(pool)).toEqual({ dex: 'pumpswap', poolKind: 'amm' });
      });
    });

    // Unsupported DEX Tests
    describe('Unsupported DEXes', () => {
      it('should return null for phoenix', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'phoenix',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'abc',
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toBeNull();
      });

      it('should return null for lifinity', () => {
        const pool: DexScreenerPool = {
          chainId: 'solana',
          dexId: 'lifinity',
          url: 'https://dexscreener.com/solana/abc',
          pairAddress: 'abc',
          baseToken: { address: 'TokenA', name: 'Token A', symbol: 'TOKA' },
          quoteToken: { address: 'TokenB', name: 'Token B', symbol: 'TOKB' },
        };
        expect(mapDexScreenerToInternal(pool)).toBeNull();
      });
    });
  });

  describe('getPoolTypeName', () => {
    it('should return correct name for Raydium CLMM', () => {
      expect(getPoolTypeName({ dex: 'raydium', poolKind: 'clmm' })).toBe('Raydium CLMM');
    });

    it('should return correct name for Orca Whirlpool', () => {
      expect(getPoolTypeName({ dex: 'orca', poolKind: 'clmm' })).toBe('Orca Whirlpool');
    });

    it('should return correct name for Meteora DAMM v2', () => {
      expect(getPoolTypeName({ dex: 'meteora_balanced', poolKind: 'amm', variant: 'v2' })).toBe('Meteora DAMM v2');
    });
  });

  describe('filterBySupportedDex', () => {
    const pools: DexScreenerPool[] = [
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'A', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      { chainId: 'solana', dexId: 'phoenix', url: '', pairAddress: 'B', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      { chainId: 'solana', dexId: 'orca', url: '', pairAddress: 'C', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      { chainId: 'solana', dexId: 'lifinity', url: '', pairAddress: 'D', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
    ];

    it('should filter to only supported DEXes', () => {
      const filtered = filterBySupportedDex(pools, ['raydium', 'orca']);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(p => p.dexId)).toEqual(['raydium', 'orca']);
    });

    it('should use default supported DEXes when not specified', () => {
      const filtered = filterBySupportedDex(pools);
      expect(filtered.map(p => p.dexId)).toContain('raydium');
      expect(filtered.map(p => p.dexId)).toContain('orca');
      expect(filtered.map(p => p.dexId)).not.toContain('phoenix');
    });
  });

  describe('filterByMinLiquidity', () => {
    const pools: DexScreenerPool[] = [
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'A', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' }, liquidity: { usd: 500, base: 0, quote: 0 } },
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'B', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' }, liquidity: { usd: 5000, base: 0, quote: 0 } },
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'C', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' }, liquidity: { usd: 50, base: 0, quote: 0 } },
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'D', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } }, // No liquidity
    ];

    it('should filter by minimum liquidity', () => {
      const filtered = filterByMinLiquidity(pools, 1000);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].pairAddress).toBe('B');
    });

    it('should include pools at exactly min liquidity', () => {
      const filtered = filterByMinLiquidity(pools, 500);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(p => p.pairAddress)).toEqual(['A', 'B']);
    });
  });

  describe('filterOutTracked', () => {
    const pools: DexScreenerPool[] = [
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'PoolA', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'PoolB', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'PoolC', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
    ];

    it('should filter out already tracked pools', () => {
      const tracked = new Set(['PoolA', 'PoolC']);
      const filtered = filterOutTracked(pools, tracked);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].pairAddress).toBe('PoolB');
    });

    it('should return all pools if none are tracked', () => {
      const tracked = new Set<string>();
      const filtered = filterOutTracked(pools, tracked);
      expect(filtered).toHaveLength(3);
    });
  });

  describe('mapAndFilterPools', () => {
    it('should map and filter pools, excluding unsupported', () => {
      const pools: DexScreenerPool[] = [
        { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'A', labels: ['CLMM'], baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
        { chainId: 'solana', dexId: 'phoenix', url: '', pairAddress: 'B', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
        { chainId: 'solana', dexId: 'orca', url: '', pairAddress: 'C', labels: ['wp'], baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      ];

      const mapped = mapAndFilterPools(pools);
      expect(mapped).toHaveLength(2);
      expect(mapped[0].mapping).toEqual({ dex: 'raydium', poolKind: 'clmm' });
      expect(mapped[1].mapping).toEqual({ dex: 'orca', poolKind: 'clmm' });
    });
  });

  describe('groupPoolsByDex', () => {
    it('should group pools by DEX', () => {
      const pools = mapAndFilterPools([
        { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'A', labels: ['CLMM'], baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
        { chainId: 'solana', dexId: 'raydium', url: '', pairAddress: 'B', baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
        { chainId: 'solana', dexId: 'orca', url: '', pairAddress: 'C', labels: ['wp'], baseToken: { address: '', name: '', symbol: '' }, quoteToken: { address: '', name: '', symbol: '' } },
      ]);

      const grouped = groupPoolsByDex(pools);
      expect(grouped.get('raydium')?.length).toBe(2);
      expect(grouped.get('orca')?.length).toBe(1);
    });
  });
});
