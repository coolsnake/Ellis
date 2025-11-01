import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: matches priceToSqrtPriceX64 encoding
// Encoding: sqrt = sqrt((A_per_B_whole) / 10^(decA-decB))
// Decoding: A-per-1-B = (ratio^2) × 10^(decA-decB), where ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes A-per-1-B from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // A per 1 B (example magnitude)
    // Encode: sqrt = sqrt(target / 10^(decA-decB)), then sqrtPriceX64 = sqrt * 2^64
    const ratio = Math.sqrt(target / Math.pow(10, decA - decB));
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    // Decode: A-per-1-B = (ratio^2) × 10^(decA-decB)
    const decoded = (ratio2 * ratio2) * Math.pow(10, decA - decB);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


