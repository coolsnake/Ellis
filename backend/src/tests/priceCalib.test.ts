import { describe, it, expect } from 'vitest';
import { calibrateMagnitude } from '../server/priceCalib.js';

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
    const getUsd = (m: string) => (m === 'A' ? 100 : 1);
    const raw = 1; // off by 100x
    const cal = calibrateMagnitude('A','B', raw, getUsd)!;
    expect(cal).toBeGreaterThan(0);
    expect(Math.abs(Math.log10(cal / 0.01))).toBeLessThan(0.05);
  });

  it('does not invert orientation (no 1/price candidate)', () => {
    const getUsd = (m: string) => (m === 'A' ? 60000 : 1);
    const raw = 1;
    const cal = calibrateMagnitude('A','B', raw, getUsd)!;
    expect(cal).toBeLessThan(1);
    expect(Math.abs(Math.log10(cal / (1/60000)))).toBeLessThan(0.1);
  });
});


