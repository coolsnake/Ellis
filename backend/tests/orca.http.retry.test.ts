import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOrcaHttp } from '../src/server/pools/orca';

afterEach(() => {
  // @ts-expect-error
  global.fetch && (global.fetch as any).mockReset && (global.fetch as any).mockReset();
});

describe('orca.http retry behavior', () => {
  it('falls back after 429 and returns data on subsequent success', async () => {
    // First call (paged) -> 429; Second call (fallback) -> ok json with data array
    // @ts-expect-error
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => '429' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [ { address: 'pool1' } ] }) });

    const data = await fetchOrcaHttp();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    // @ts-expect-error
    expect((global.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});


