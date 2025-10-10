import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.v1.normalize', () => {
  it('maps v1 array shape to normalized AMM pools', async () => {
    const { normalizeMeteoraBalancedV1 } = await import('../pools/meteoraBalanced.js');
    const raw = [
      {
        pool_address: 'POOL1',
        pool_token_mints: ['A', 'B'],
        pool_token_amounts: ['100', '200'],
        pool_token_usd_amounts: ['50', '100'],
        pool_tvl: '150',
        total_fee_pct: '0.3',
      },
    ] as any;
    const norm = await normalizeMeteoraBalancedV1(raw);
    expect(norm).toHaveProperty('amm');
    expect(Array.isArray(norm.amm)).toBe(true);
    expect(norm.amm.length).toBe(1);
    const p = norm.amm[0] as any;
    expect(p.id).toBe('POOL1');
    expect(p.mint_a).toBe('A');
    expect(p.mint_b).toBe('B');
    expect(p.tvl_usd).toBe(150);
    expect(p.fee_bps).toBe(30);
  });
});


