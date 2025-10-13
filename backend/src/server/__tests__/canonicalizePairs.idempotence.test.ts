import { describe, it, expect } from 'vitest';
import { canonicalizePairs } from '../pools/common';

describe('canonicalizePairs idempotence', () => {
  it('inverts once and is idempotent', () => {
    const p = { mint_a: 'B', mint_b: 'A', price_a_per_b: 0.1, amount_a: 1, amount_b: 10 } as any;
    const once = canonicalizePairs([p])[0] as any;
    const twice = canonicalizePairs([once])[0] as any;
    expect(twice.mint_a).toBe(once.mint_a);
    expect(twice.mint_b).toBe(once.mint_b);
    expect(Math.abs(once.price_a_per_b - twice.price_a_per_b)).toBeLessThan(1e-12);
  });
});


