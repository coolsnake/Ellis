import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.v2.normalize', () => {
  it('maps v2 shape to normalized AMM pools with tvl and fee', async () => {
    const { normalizeMeteoraBalancedHttp } = await import('../pools/meteoraBalanced.js');
    const raw = {
      status: 200,
      total: 2,
      pages: 1,
      current_page: 1,
      data: [
        {
          pool_address: 'P2',
          token_a_mint: 'A',
          token_b_mint: 'B',
          token_a_amount: 10,
          token_b_amount: 20,
          tvl: 123.45,
          base_fee: 1.0,
          dynamic_fee: 0.2,
          pool_price: 0.5,
        },
      ],
    } as any;
    const norm = await normalizeMeteoraBalancedHttp(raw);
    expect(norm).toHaveProperty('amm');
    expect(norm.amm.length).toBe(1);
    const p = norm.amm[0] as any;
    expect(p.id).toBe('P2');
    expect(p.mint_a).toBe('A');
    expect(p.mint_b).toBe('B');
    expect(p.tvl_usd).toBe(123.45);
    expect(p.fee_bps).toBe(120); // 1.0% + 0.2% => 120 bps
  });
});


