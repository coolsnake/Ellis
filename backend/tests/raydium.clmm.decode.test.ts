import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: sqrtPriceX64 encodes sqrt(B/A) in atomic units
// Encoding: sqrtPriceX64 = sqrt(B_atomic/A_atomic) * 2^64, where B_atomic/A_atomic = (B_whole/A_whole) * 10^(decA-decB)
// Decoding: A-per-1-B = 10^(decB-decA) / (ratio^2), where ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes A-per-1-B from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // A per 1 B (example magnitude, e.g., 200 SOL per 1 USDC)
    // Encode: ratio^2 = 10^(decB - decA) / target
    const scale = Math.pow(10, decB - decA);
    const ratio = Math.sqrt(scale / target);
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    // Decode: A-per-1-B = 10^(decB-decA) / (ratio^2)
    const decoded = scale / (ratio2 * ratio2);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


