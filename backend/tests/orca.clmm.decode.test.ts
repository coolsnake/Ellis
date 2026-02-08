import { describe, it, expect } from 'vitest';

// Orca CLMM decode sanity: B-per-1-A = (ratio^2) * 10^(decA - decB), ratio = sqrt / 2^64
describe('orca clmm sqrt decode', () => {
  it('decodes B-per-1-A from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // B per 1 A (example magnitude)
    // For Orca decode formula: target = ratio^2 * 10^(decA-decB) => ratio = sqrt(target / 10^(decA-decB))
    const ratio = Math.sqrt(target / Math.pow(10, decA - decB));
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    const decoded = (ratio2 * ratio2) * Math.pow(10, decA - decB);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


