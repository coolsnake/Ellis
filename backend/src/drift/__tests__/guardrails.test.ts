import { describe, it, expect } from 'vitest';
import { isOracleTwapOutlier } from '../guardrails.js';

describe('oracle/twap guardrails', () => {
  it('returns false when twap is missing', () => {
    expect(isOracleTwapOutlier(100, 0, 0.2)).toBe(false);
  });

  it('flags outlier when deviation exceeds guard', () => {
    expect(isOracleTwapOutlier(150, 100, 0.2)).toBe(true);
  });

  it('does not flag when deviation is within guard', () => {
    expect(isOracleTwapOutlier(110, 100, 0.2)).toBe(false);
  });
});
