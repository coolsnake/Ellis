import { describe, it, expect } from 'vitest';
import { computeTokenUniverseFromSets, filterPoolsByUniverse } from '../universe.js';

describe('universe helpers', () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const A = 'A11111111111111111111111111111111111111111';
  const B = 'B11111111111111111111111111111111111111111';
  const C = 'C11111111111111111111111111111111111111111';

  it('computes intersection/union correctly with anchors', () => {
    const ray = new Set([A, B, SOL]);
    const orc = new Set([B, C, USDC]);
    const anchors = new Set([SOL, USDC]);
    const inter = computeTokenUniverseFromSets(ray, orc, 'intersection', anchors);
    expect(inter.has(B)).toBe(true);
    expect(inter.has(SOL)).toBe(true);
    expect(inter.has(USDC)).toBe(true);
    expect(inter.has(A)).toBe(false);
    expect(inter.has(C)).toBe(false);
    const uni = computeTokenUniverseFromSets(ray, orc, 'union', anchors);
    expect(uni.has(A) && uni.has(B) && uni.has(C)).toBe(true);
    expect(uni.has(SOL) && uni.has(USDC)).toBe(true);
  });

  it('filters pools by universe and allows anchor bridging', () => {
    const pools = {
      amm: [
        { mint_a: A, mint_b: B },
        { mint_a: A, mint_b: SOL }, // anchor bridge
        { mint_a: C, mint_b: USDC }, // anchor bridge
        { mint_a: A, mint_b: C }, // should drop
      ],
      clmm: [
        { mint_a: B, mint_b: C },
      ],
    };
    const universe = new Set([A, B]);
    const anchors = new Set([SOL, USDC]);
    const out = filterPoolsByUniverse(pools as any, universe, true, anchors);
    expect(out.amm.length).toBe(3);
    expect(out.clmm.length).toBe(0);
  });
});


