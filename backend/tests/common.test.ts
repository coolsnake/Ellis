import { describe, it, expect } from 'vitest';
import { toFeeBpsSafe, canonicalizePairs, validateHttpUrl } from '../src/server/pools/common';

describe('pools.common helpers', () => {
  it('toFeeBpsSafe converts fractions to bps and preserves bps numbers', () => {
    expect(toFeeBpsSafe(0.003)).toBe(30);
    expect(toFeeBpsSafe(0.0035)).toBe(35);
    expect(toFeeBpsSafe(30)).toBe(30);
    expect(toFeeBpsSafe(undefined, 25)).toBe(25);
  });

  it('canonicalizePairs lex order swaps A/B and inverts price once', () => {
    const pools = [{ mint_a: 'Zzz', mint_b: 'Aaa', price_a_per_b: 2 }];
    const canon = canonicalizePairs(pools);
    expect(canon).toHaveLength(1);
    expect(canon[0].mint_a < canon[0].mint_b).toBe(true);
    // After swap, price should be inverted
    expect(canon[0].price_a_per_b).toBeCloseTo(0.5, 1e-9 as any);
  });

  it('validateHttpUrl allows http/https and rejects private/internal hosts', () => {
    expect(validateHttpUrl('https://api.example.com/x')).toBe('https://api.example.com/x');
    expect(validateHttpUrl('http://127.0.0.1/x')).toBeNull();
    expect(validateHttpUrl('http://172.16.0.10/x')).toBeNull();
    expect(validateHttpUrl('ftp://example.com/x')).toBeNull();
    expect(validateHttpUrl('https://raydium.io')).toBe('https://raydium.io/');
  });
});


