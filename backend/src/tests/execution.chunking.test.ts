import { describe, it, expect } from 'vitest';
import { chunkRouteAsync } from '../execution/builder/tx.js';

describe('chunking async', () => {
  it('splits per approx size', async () => {
    const plan: any = { hops: [
      { dex: 'raydium', variant: 'amm' },
      { dex: 'raydium', variant: 'clmm' },
      { dex: 'meteora', variant: 'dlmm' },
    ] };
    const { txs, totalIxs } = await chunkRouteAsync(plan, [], undefined, 350);
    expect(Array.isArray(txs)).toBe(true);
    expect(totalIxs).toBeGreaterThan(0);
  });
});


