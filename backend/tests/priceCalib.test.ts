import { describe, it, expect } from 'vitest';
import { calibrateMagnitude } from '../src/server/priceCalib';

describe('priceCalib.calibrateMagnitude', () => {
  it('scales magnitude by powers of ten to match USD(A)/USD(B) without inverting', () => {
    const A = 'MintA';
    const B = 'MintB';
    // USD prices: A = 2, B = 8 => reference B per 1 A = USD(A)/USD(B) = 0.25
    const getUsd = (m: string): number | undefined => (m === A ? 2 : (m === B ? 8 : undefined));
    const raw = 0.004; // off by 10^3
    const calibrated = calibrateMagnitude(A, B, raw, getUsd);
    expect(calibrated).toBeCloseTo(0.25, 1e-9 as any);
  });

  it('returns raw price when USD refs are missing', () => {
    const A = 'MintA';
    const B = 'MintB';
    const getUsd = (_m: string): number | undefined => undefined;
    const raw = 123.45;
    const calibrated = calibrateMagnitude(A, B, raw, getUsd);
    expect(calibrated).toBe(raw);
  });

  it('returns undefined for non-positive or non-finite inputs', () => {
    const getUsd = (_: string) => 1;
    expect(calibrateMagnitude('A','B', 0, getUsd)).toBeUndefined();
    expect(calibrateMagnitude('A','B', -5, getUsd)).toBeUndefined();
    expect(calibrateMagnitude('A','B', Number.NaN, getUsd)).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { calibrateMagnitude } from '../src/server/priceCalib.ts';

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
    expect(Math.abs(Math.log10(cal / 100))).toBeLessThan(0.05);
  });

  it('does not invert orientation (no 1/price candidate)', () => {
    const getUsd = (m: string) => (m === 'A' ? 60000 : 1);
    const raw = 1;
    const cal = calibrateMagnitude('A','B', raw, getUsd)!;
    expect(cal).toBeGreaterThan(1);
    // With powers-of-ten only, nearest step from 1 to 60000 is 1e5 (~1.67x off)
    expect(Math.abs(Math.log10(cal / 60000))).toBeLessThan(0.25);
  });
});


