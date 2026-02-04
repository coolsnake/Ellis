import { describe, it, expect, vi } from 'vitest';
import { DriftEventIndex } from '../eventIndex.js';

describe('DriftEventIndex', () => {
  it('indexes users and evicts by TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const idx = new DriftEventIndex({ ttlMs: 1000 });
    idx.updateUserMarkets('userA', [1], 'test');
    expect(idx.getUsersForMarket(1)).toContain('userA');

    vi.advanceTimersByTime(6000);
    expect(idx.getUsersForMarket(1)).toEqual([]);
    vi.useRealTimers();
  });

  it('tracks conditional orders by market', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const idx = new DriftEventIndex({ ttlMs: 1000 });
    idx.trackConditionalOrder(2, 'u#7', 'test');
    expect(idx.getMarketsWithConditionalOrders()).toContain(2);

    vi.advanceTimersByTime(6000);
    expect(idx.getMarketsWithConditionalOrders()).toEqual([]);
    vi.useRealTimers();
  });

  it('bootstraps from user map', () => {
    const idx = new DriftEventIndex({ ttlMs: 10_000 });
    const userMap = {
      values: function* () {
        yield {
          getUserAccountPublicKey: () => ({ toBase58: () => 'user1' }),
          getPerpPositions: () => [{ marketIndex: 1, baseAssetAmount: 10 }],
          getUserAccount: () => ({
            spotPositions: [{ marketIndex: 2, scaledBalance: 5 }],
            orders: [{ marketIndex: 3, orderId: 7, orderType: { kind: 'triggerMarket' } }],
          }),
        };
      },
    };
    const res = idx.bootstrapFromUserMap(userMap, { limit: 10, includeOrders: true, reason: 'test' });
    expect(res.users).toBeGreaterThan(0);
    expect(idx.getMarketsForUser('user1')).toEqual(expect.arrayContaining([1, 2]));
    expect(idx.getMarketsWithConditionalOrders()).toContain(3);
  });
});
