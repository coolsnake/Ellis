import { describe, it, expect } from 'vitest';
import { calibrateMagnitude } from '../src/server/priceCalib.js';

describe('calibrateMagnitude', () => {
  it('returns undefined for non-finite or non-positive', () => {
    const getUsd = (_: string) => 1;
    expect(calibrateMagnitude('A','B', undefined, getUsd)).toBeUndefined();
    expect(calibrateMagnitude('A','B', NaN as any, getUsd)).toBeUndefined();
    expect(calibrateMagnitude('A','B', 0, getUsd)).toBeUndefined();
    expect(calibrateMagnitude('A','B', -5, getUsd)).toBeUndefined();
  });

  it('passes through when no USD refs', () => {
    const getUsd = (_: string) => undefined;
    expect(calibrateMagnitude('A','B', 123, getUsd)).toBe(123);
  });

  it('scales magnitude by powers of ten, preserves orientation', () => {
    // Suppose A=SOL at $100, B=USDC at $1.
    // A per 1 B reference is price(B)/price(A) = 1/100 = 0.01
    const getUsd = (m: string) => (m === 'A' ? 100 : 1);
    const raw = 1; // off by 100x
    const cal = calibrateMagnitude('A','B', raw, getUsd)!;
    expect(cal).toBeGreaterThan(0);
    expect(Math.abs(Math.log10(cal / 0.01))).toBeLessThan(0.05); // within ~12%
  });

  it('does not invert orientation (no 1/price candidate)', () => {
    // A=BTC $60k, B=USDC $1 -> ref A per 1 B = 1/60000 ≈ 1.6667e-5
    const getUsd = (m: string) => (m === 'A' ? 60000 : 1);
    const raw = 1; // badly scaled
    const cal = calibrateMagnitude('A','B', raw, getUsd)!;
    // Should move via powers of ten near 1.6667e-5 without using reciprocal
    expect(cal).toBeLessThan(1);
    expect(Math.abs(Math.log10(cal / (1/60000)))).toBeLessThan(0.1);
  });
});


