import { describe, it, expect } from 'vitest';
import { computeSlippageBps } from '../execution/builder/ix.js';

describe('token-2022 and price limit smoke', () => {
  it('computes slippage bps from amountIn/minOut', () => {
    const bps = computeSlippageBps(1000n, 950n);
    expect(bps).toBe(500);
  });
});


