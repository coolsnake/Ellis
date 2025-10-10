import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.v1.fetch', () => {
  it('normalizes v1 shape into amm pools', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    if ((cfg as any).meteoraBalanced) {
      (cfg as any).meteoraBalanced.pageSize = 10;
      (cfg as any).meteoraBalanced.maxPages = 1;
    }
    const mod: any = await import('../pools/meteoraBalanced.js');
    const raw = await mod.fetchMeteoraBalancedV1Http(''); // empty base uses configured URL or returns []
    const norm = await mod.normalizeMeteoraBalancedHttp(raw);
    expect(norm).toHaveProperty('amm');
    expect(Array.isArray(norm.amm)).toBe(true);
  });
});


