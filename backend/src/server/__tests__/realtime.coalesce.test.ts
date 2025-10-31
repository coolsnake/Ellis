import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('realtime diff coalescing', () => {
  const OLD_ENV = { ...process.env } as any;
  let origNodeEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'dev'; // avoid test shortcut in processArbQueue
    process.env.ARB_DIFF_COALESCE_MS = '100';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...OLD_ENV };
    process.env.NODE_ENV = origNodeEnv;
  });

  it('merges rapid diffs into a single /arb/graph/update', async () => {
    let updateCalls = 0;
    let versionPeekCalls = 0;
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url || '');
      if (u.endsWith('/arb/graph/update')) {
        updateCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) } as any;
      }
      if (u.endsWith('/arb/graph/version')) {
        versionPeekCalls += 1;
        // Always report the target version satisfied
        return { ok: true, json: async () => ({ version: 2 }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }) as any;

    const rt = await import('../../server/realtime.js');

    const p1 = rt.pushArbGraphDiff({ version: 1, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });
    // Within coalesce window
    const p2 = rt.pushArbGraphDiff({ version: 2, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });

    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);

    expect(updateCalls).toBe(1);
    expect(versionPeekCalls).toBeGreaterThan(0);
  });
});


