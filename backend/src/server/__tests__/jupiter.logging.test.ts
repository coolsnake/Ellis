// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

describe('Jupiter emits Pools Log messages when catOverride starts with pools', () => {
  it('emits pools:jup.price.fetch and pools:jup.price.ok', async () => {
    vi.resetModules();
    const emits: string[] = [];
    vi.doMock('../realtime.js', () => ({
      emit: vi.fn((event: string, payload: any) => {
        if (event === 'log' && payload?.context?.cat === 'pools') emits.push(payload.message);
      }),
    }));
    // Provide deterministic response
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any;
    const jup: any = await import('../../jupiter/jupiter.js');
    await jup.fetchPricesByMints(['So11111111111111111111111111111111111111112'], { catOverride: 'pools.refresh' });
    expect(emits.some(m => m.startsWith('pools:jup.price.fetch'))).toBe(true);
    expect(emits.some(m => m.startsWith('pools:jup.price.ok'))).toBe(true);
  });
});


