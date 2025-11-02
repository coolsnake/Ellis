import { describe, it, expect } from 'vitest';
import { diffNormalizedPools } from '../pools.js';

describe('diffNormalizedPools precision comparisons', () => {
  it('detects CLMM changes when sqrt raw differs but float matches', () => {
    const baseRaw = (2n ** 64n).toString();
    const prev = {
      amm: [],
      clmm: [
        {
          id: 'pool-clmm',
          dex: 'Raydium',
          mint_a: 'A',
          mint_b: 'B',
          fee_bps: 30,
          sqrt_price_x64: Number(2n ** 64n),
          sqrt_price_x64_raw: baseRaw,
          liquidity: 100,
          liquidity_raw: '1000000',
          tick_spacing: 64,
          updated_ms: 1,
          price_a_per_b: 1.2345,
          price_a_per_b_num: '12345',
          price_a_per_b_den: '10000',
          pool_kind: 'clmm',
        },
      ],
    };
    const next = {
      amm: [],
      clmm: [
        {
          ...prev.clmm[0],
          sqrt_price_x64_raw: (BigInt(baseRaw) + 1n).toString(),
        },
      ],
    };
    const diff = diffNormalizedPools(prev as any, next as any);
    expect(diff.clmm.length).toBe(1);
  });

  it('detects AMM changes when reserves raw differ even if ratios round same', () => {
    const prev = {
      amm: [
        {
          id: 'pool-amm',
          dex: 'Raydium',
          mint_a: 'A',
          mint_b: 'B',
          fee_bps: 30,
          price_a_per_b: 1,
          liquidity_base: 100,
          updated_ms: 1,
          pool_kind: 'amm',
          reserve_a_raw: '1000000',
          reserve_b_raw: '2000000',
        },
      ],
      clmm: [],
    };
    const next = {
      amm: [
        {
          ...prev.amm[0],
          reserve_a_raw: '1000001',
        },
      ],
      clmm: [],
    };
    const diff = diffNormalizedPools(prev as any, next as any);
    expect(diff.amm.length).toBe(1);
  });
});


