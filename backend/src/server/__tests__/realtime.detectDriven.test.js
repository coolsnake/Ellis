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

  it('triggers rebuild and notifies coordinator when detection completes', async () => {
    vi.doMock('../../server/graph.js', () => ({
      scheduleGraphRebuild: vi.fn(),
    }));
    const markDetectorComplete = vi.fn();
    vi.doMock('../../server/graphPushCoordinator.js', () => ({
      markDetectorComplete,
      setStreamEnabled: vi.fn(),
      getGraphPushStats: vi.fn(() => ({ count: 0, p50: null, p95: null, success: 0, failed: 0 })),
      getGraphPushStatsRaw: vi.fn(() => ({ ackMs: [], success: 0, failed: 0 })),
      submitDiff: vi.fn(),
      submitSnapshot: vi.fn(),
      hasPendingPush: vi.fn(() => true),
    }));
    const sequence = [0, 0, 1234, 1234, 2345];
    let idx = 0;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ last_detection_ms: sequence[idx++] || 0 }) }));

    const { startDetectDrivenGraphPush } = await import('../../server/realtime.js');
    const g = await import('../../server/graph.js');
    startDetectDrivenGraphPush(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(g.scheduleGraphRebuild).toHaveBeenCalled();
    expect(markDetectorComplete).toHaveBeenCalledWith(2345);
  });

  it('skips rebuild when no pending push', async () => {
    vi.doMock('../../server/graphPushCoordinator.js', () => ({
      markDetectorComplete: vi.fn(),
      setStreamEnabled: vi.fn(),
      getGraphPushStats: vi.fn(() => ({ count: 0, p50: null, p95: null, success: 0, failed: 0 })),
      getGraphPushStatsRaw: vi.fn(() => ({ ackMs: [], success: 0, failed: 0 })),
      submitDiff: vi.fn(),
      submitSnapshot: vi.fn(),
      hasPendingPush: vi.fn(() => false),
    }));

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ last_detection_ms: 5000 }) }));

    const { startDetectDrivenGraphPush } = await import('../../server/realtime.js');
    const g = await import('../../server/graph.js');
    startDetectDrivenGraphPush(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(g.scheduleGraphRebuild).not.toHaveBeenCalled();
  });
});


