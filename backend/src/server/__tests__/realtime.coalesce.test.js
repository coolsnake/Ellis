import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('realtime diff coalescing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('merges rapid diffs into a single /arb/graph/update', async () => {
    let updateCalls = 0;
    let versionPeekCalls = 0;
    let ackCalls = 0;
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
        ackCalls += 1;
        return { ok: true, json: async () => ({ ok: true, acked: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const rt = await import('../../server/realtime.js');
    const coord = await import('../../server/graphPushCoordinator.js');

    rt.setArbStreamEnabled(true);

    coord.submitDiff({ version: 1, timestamp: Date.now(), addedEdges: [], updatedEdges: [], removedEdgeIds: [] });
    coord.submitDiff({ version: 2, timestamp: Date.now(), addedEdges: [], updatedEdges: [], removedEdgeIds: [] });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(updateCalls).toBe(1);
    expect(versionPeekCalls).toBeGreaterThan(0);
    expect(ackCalls).toBeGreaterThan(0);
  });
});


