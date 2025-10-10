import { describe, it, expect } from 'vitest';

describe('meteora.dlmm.normalize', () => {
  it('normalizes DLMM pairs from all_with_pagination sample', async () => {
    const { normalizeMeteoraHttp } = await import('../pools/meteora.js');
    const raw = {
      pairs: [
        {
          address: 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR',
          mint_x: 'So11111111111111111111111111111111111111112',
          mint_y: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          reserve_x_amount: 1000000000,
          reserve_y_amount: 5000000,
          bin_step: 10,
          current_price: 200.0,
        },
      ],
    } as any;
    const norm = await normalizeMeteoraHttp(raw);
    expect(norm).toHaveProperty('clmm');
    expect(Array.isArray(norm.clmm)).toBe(true);
    expect(norm.clmm.length).toBeGreaterThan(0);
    const p = norm.clmm[0];
    expect(p.mint_a).toBeDefined();
    expect(p.mint_b).toBeDefined();
  });
});


