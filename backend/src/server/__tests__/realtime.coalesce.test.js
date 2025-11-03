import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('realtime diff coalescing', () => {
  const OLD_ENV = { ...process.env };
  let origNodeEnv;

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
    const metricsSeq = [0, 0, 100, 200];
    let metricsIdx = 0;
    global.fetch = vi.fn(async (url) => {
      const u = String(url || '');
      if (u.endsWith('/arb/graph/update')) {
        updateCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.endsWith('/arb/graph/version')) {
        versionPeekCalls += 1;
        return { ok: true, json: async () => ({ version: 2 }) };
      }
      if (u.endsWith('/arb/graph/ack')) {
        return { ok: true, json: async () => ({ ok: true, acked: true }) };
      }
      if (u.endsWith('/metrics/json')) {
        const value = metricsSeq[Math.min(metricsIdx++, metricsSeq.length - 1)] || 0;
        return { ok: true, json: async () => ({ last_detection_ms: value }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const rt = await import('../../server/realtime.js');
    rt.setArbStreamEnabled(true);

    const p1 = rt.pushArbGraphDiff({ version: 1, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });
    const p2 = rt.pushArbGraphDiff({ version: 2, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });

    await vi.advanceTimersByTimeAsync(200);
    await rt.flushPendingFromDetector();
    await Promise.all([p1, p2]);

    expect(updateCalls).toBe(1);
    expect(versionPeekCalls).toBeGreaterThan(0);
  });
});


