import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: A-per-1-B = 10^(decA - decB) / (ratio^2), ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes A-per-1-B from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // A per 1 B (example magnitude)
    const ratio = Math.sqrt(Math.pow(10, decA - decB) / target);
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    const decoded = Math.pow(10, decA - decB) / (ratio2 * ratio2);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


