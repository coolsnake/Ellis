import { describe, it, expect, vi } from 'vitest';
import { Hotlist } from '../hotlist.js';

describe('hotlist', () => {
  it('evicts entries by TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = new Hotlist({ ttlMs: 10, maxMarkets: 10, maxUsers: 10 });
    h.markMarket(1);
    expect(h.getHotMarkets({ consumerId: 't1' })).toEqual([1]);
    vi.advanceTimersByTime(11);
    expect(h.getHotMarkets({ consumerId: 't1' })).toEqual([]);
    vi.useRealTimers();
  });

  it('consumes per consumer and re-mark is visible', () => {
    const h = new Hotlist({ ttlMs: 1000, maxMarkets: 10, maxUsers: 10 });
    h.markMarket(7);
    expect(h.getHotMarkets({ consumerId: 'a' })).toEqual([7]);
    expect(h.getHotMarkets({ consumerId: 'a' })).toEqual([]);
    h.markMarket(7);
    expect(h.getHotMarkets({ consumerId: 'a' })).toEqual([7]);
  });
});
