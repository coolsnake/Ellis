import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.fetch (http, limited)', () => {
  it('fetches some pools from API or returns empty with no URL', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    // Ensure page size small for test speed
    if ((cfg as any).meteoraBalanced) {
      (cfg as any).meteoraBalanced.pageSize = 50;
      (cfg as any).meteoraBalanced.maxPages = 1;
    }
    const { fetchMeteoraBalancedHttp, normalizeMeteoraBalancedHttp } = await import('../pools/meteoraBalanced.js');
    const raw = await fetchMeteoraBalancedHttp();
    expect(Array.isArray(raw) || Array.isArray((raw as any)?.data)).toBe(true);
    const norm = await normalizeMeteoraBalancedHttp(raw);
    expect(norm).toHaveProperty('amm');
    expect(Array.isArray(norm.amm)).toBe(true);
    // We don't assert >0 because env URL may be missing in CI; presence of array is sufficient
  });
});


