import { describe, it, expect } from 'vitest';
import { computeTriggerPriorityFee } from '../triggerUtils.js';

describe('computeTriggerPriorityFee', () => {
  it('respects floor when dynamic value is low', () => {
    const fee = computeTriggerPriorityFee({
      baseCfg: 0,
      subPriority: 100,
      suggestedMul: 2,
      multiplier: 1,
      floor: 500,
    });
    expect(fee).toBe(500);
  });

  it('uses dynamic value when above floor', () => {
    const fee = computeTriggerPriorityFee({
      baseCfg: 1000,
      subPriority: 200,
      suggestedMul: 4,
      multiplier: 1,
      floor: 500,
    });
    expect(fee).toBe(1000);
  });
});
