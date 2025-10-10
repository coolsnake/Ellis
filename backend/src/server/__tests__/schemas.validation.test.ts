import { describe, it, expect } from 'vitest';
import { ResolveDirectSchema } from '../routes/schemas.js';

describe('ResolveDirectSchema validation', () => {
  it('fails with field-specific errors when hop lengths mismatch', () => {
    const input = { path: ['A', 'B', 'C'], hopPoolIds: ['h1'], dexes: ['d1', 'd2'] };
    try {
      ResolveDirectSchema.parse(input as any);
      throw new Error('expected schema to throw');
    } catch (e: any) {
      const issues = (e?.issues || []) as Array<{ path: (string|number)[]; message: string }>;
      const hopIdsErr = issues.find((i) => String(i.path?.[0]) === 'hopPoolIds');
      const dexesErr = issues.find((i) => String(i.path?.[0]) === 'dexes');
      expect(hopIdsErr?.message || '').toContain('expected 2');
      expect(dexesErr).toBeUndefined(); // dexes length matches (2)
    }
  });

  it('parses when lengths match', () => {
    const input = { path: ['A', 'B', 'C'], hopPoolIds: ['h1', 'h2'], dexes: ['d1', 'd2'] };
    const parsed = ResolveDirectSchema.parse(input as any);
    expect(Array.isArray((parsed as any).path)).toBe(true);
  });

  it('accepts plan payload without arrays', () => {
    const input = { plan: { path: ['X', 'Y', 'Z'], hops: [{ dex: 'ray', poolId: 'p1' }, { dex: 'orc', poolId: 'p2' }] } };
    const parsed = ResolveDirectSchema.parse(input as any);
    expect((parsed as any).plan.hops.length).toBe(2);
  });
});


