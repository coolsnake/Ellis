import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: same as Orca/Uniswap V3 encoding
// Encoding: sqrt encodes sqrt(B/A) in smallest units
// Decoding: A-per-1-B = 10^(decB-decA) / (ratio^2), where ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes A-per-1-B from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // A per 1 B (example magnitude)
    // Encode: ratio = sqrt(10^(decB-decA) / target), then sqrtPriceX64 = ratio * 2^64
    const ratio = Math.sqrt(Math.pow(10, decB - decA) / target);
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    // Decode: A-per-1-B = 10^(decB-decA) / (ratio^2)
    const decoded = Math.pow(10, decB - decA) / (ratio2 * ratio2);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


