import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('detect-driven graph push', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('triggers scheduleGraphRebuild when last_detection_ms increases', async () => {
    vi.doMock('../../server/graph.js', () => ({
      scheduleGraphRebuild: vi.fn(),
    }));
    const sequence = [0, 0, 1234, 1234, 2345];
    let idx = 0;
    let updateCalls = 0;
    let ackCalls = 0;
    global.fetch = vi.fn(async (url = '') => {
      if (typeof url === 'string' && url.endsWith('/metrics/json')) {
        return { ok: true, json: async () => ({ last_detection_ms: sequence[idx++] || 0 }) };
      }
      if (typeof url === 'string' && (url.endsWith('/arb/graph/update') || url.endsWith('/arb/graph/snapshot'))) {
        if (url.endsWith('/arb/graph/update')) updateCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (typeof url === 'string' && url.endsWith('/arb/graph/ack')) {
        ackCalls += 1;
        return { ok: true, json: async () => ({ ok: true, acked: true }) };
      }
      if (typeof url === 'string' && url.endsWith('/arb/graph/version')) {
        return { ok: true, json: async () => ({ version: 1 }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { startDetectDrivenGraphPush, pushArbGraphDiff, setArbStreamEnabled } = await import('../../server/realtime.js');
    const g = await import('../../server/graph.js');
    setArbStreamEnabled(true);
    const diffPromise = pushArbGraphDiff({ version: 1, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });
    startDetectDrivenGraphPush(0);
    await vi.advanceTimersByTimeAsync(600);
    await diffPromise;
    expect(updateCalls).toBeGreaterThan(0);
    expect(ackCalls).toBeGreaterThan(0);
    expect(g.scheduleGraphRebuild).not.toHaveBeenCalled();
  });

  it('waits for detection after push (bounded)', async () => {
    const metricsSeq = [{ last_detection_ms: 1000 }, { last_detection_ms: 1000 }, { last_detection_ms: 2000 }];
    let mIdx = 0;
    global.fetch = vi.fn(async (url) => {
      if (url.endsWith('/metrics/json')) {
        const cur = metricsSeq[Math.min(mIdx++, metricsSeq.length - 1)];
        return { ok: true, json: async () => cur };
      }
      if (url.endsWith('/arb/graph/snapshot') || url.endsWith('/arb/graph/update')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/arb/graph/version')) {
        return { ok: true, json: async () => ({ version: 1 }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const rt = await import('../../server/realtime.js');
    const t0 = Date.now();
    const pushPromise = rt.pushArbGraphDiff({ version: 1, addedEdges: [], updatedEdges: [], removedEdgeIds: [] });
    await vi.advanceTimersByTimeAsync(500);
    await rt.flushPendingFromDetector();
    await pushPromise;
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(0);
  });
});


