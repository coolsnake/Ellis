import { describe, it, expect } from 'vitest';

// Raydium CLMM decode sanity: sqrtPriceX64 encodes sqrt(B/A) in atomic units
// Encoding: sqrtPriceX64 = sqrt(B_atomic/A_atomic) * 2^64, where B_atomic/A_atomic = (B_whole/A_whole) * 10^(decA-decB)
// Decoding: B-per-1-A = (ratio^2) * 10^(decA-decB), where ratio = sqrt / 2^64
describe('raydium clmm sqrt decode', () => {
  it('decodes B-per-1-A from sqrtPriceX64 and decimals', async () => {
    const decA = 9; // e.g., SOL
    const decB = 6; // e.g., USDC
    const target = 200; // B per 1 A (example magnitude, e.g., 200 USDC per 1 SOL)
    // Encode: ratio^2 = target / 10^(decA - decB)
    const scale = Math.pow(10, decA - decB);
    const ratio = Math.sqrt(target / scale);
    const sqrt = Math.floor(ratio * Math.pow(2, 64));
    const two64 = Math.pow(2, 64);
    const ratio2 = sqrt / two64;
    // Decode: B-per-1-A = (ratio^2) * 10^(decA-decB)
    const decoded = (ratio2 * ratio2) * scale;
    expect(decoded).toBeGreaterThan(0);
    expect(Math.abs(Math.log(decoded / target))).toBeLessThan(1e-6);
  });
});


