import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: sqrtPriceX64 encodes sqrt(A/B) in atomic units
// Encoding: sqrtPriceX64 = sqrt(A_atomic/B_atomic) * 2^64, where A_atomic/B_atomic = (A_whole/B_whole) * 10^(decA-decB)
// Decoding: A-per-1-B = (ratio^2) * 10^(decB-decA), where ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes A-per-1-B from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // A per 1 B (example magnitude, e.g., 200 SOL per 1 USDC)
    // Encode: A_atomic/B_atomic = target * 10^(decA-decB) = 200 * 10^3 = 200000
    // sqrt = sqrt(200000) * 2^64
    const atomicPrice = target * Math.pow(10, decA - decB);
    const ratio = Math.sqrt(atomicPrice);
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    // Decode: ratio^2 = A_atomic/B_atomic
    // A_atomic/B_atomic = (A_whole * 10^decA) / (B_whole * 10^decB) = (A_whole/B_whole) * 10^(decA-decB)
    // So: A_whole/B_whole = (A_atomic/B_atomic) * 10^(decB-decA) = (ratio^2) * 10^(decB-decA)
    const decoded = (ratio2 * ratio2) * Math.pow(10, decB - decA);
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


