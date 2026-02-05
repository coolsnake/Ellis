import { hotlist } from './hotlist.js';

type IndexEntry = { ts: number };

type IndexConfig = {
  ttlMs: number;
  maxUsers: number;
  maxMarkets: number;
  maxMarketsPerUser: number;
};

export class DriftEventIndex {
  private marketToUsers: Map<number, Map<string, IndexEntry>> = new Map();
  private userToMarkets: Map<string, Map<number, IndexEntry>> = new Map();
  private marketToOrders: Map<number, Map<string, IndexEntry>> = new Map();
  private cfg: IndexConfig;
  private lastPruneAt = 0;
  private boundSubscribers: WeakSet<object> = new WeakSet();

  constructor(cfg?: Partial<IndexConfig>) {
    this.cfg = {
      ttlMs: Math.max(1000, Number(cfg?.ttlMs ?? 60_000)),
      maxUsers: Math.max(100, Number(cfg?.maxUsers ?? 50_000)),
      maxMarkets: Math.max(10, Number(cfg?.maxMarkets ?? 5_000)),
      maxMarketsPerUser: Math.max(1, Number(cfg?.maxMarketsPerUser ?? 64)),
    };
  }

  configure(next: Partial<IndexConfig>): void {
    if (next.ttlMs !== undefined) this.cfg.ttlMs = Math.max(1000, Number(next.ttlMs));
    if (next.maxUsers !== undefined) this.cfg.maxUsers = Math.max(100, Number(next.maxUsers));
    if (next.maxMarkets !== undefined) this.cfg.maxMarkets = Math.max(10, Number(next.maxMarkets));
    if (next.maxMarketsPerUser !== undefined) this.cfg.maxMarketsPerUser = Math.max(1, Number(next.maxMarketsPerUser));
  }

  updateUserMarkets(userPk: string, markets: number[], reason?: string): void {
    const key = String(userPk || '').trim();
    if (!key || !Array.isArray(markets)) return;
    const now = Date.now();
    this.pruneIfNeeded(now);
    const clipped = markets
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .slice(0, this.cfg.maxMarketsPerUser);
    if (clipped.length === 0) return;

    let mset = this.userToMarkets.get(key);
    if (!mset) {
      mset = new Map();
      this.userToMarkets.set(key, mset);
    }
    for (const idx of clipped) {
      mset.set(idx, { ts: now });
      let users = this.marketToUsers.get(idx);
      if (!users) {
        users = new Map();
        this.marketToUsers.set(idx, users);
      }
      users.set(key, { ts: now });
      try { hotlist.markMarket(idx, reason || 'index_update'); } catch {}
    }
    try { hotlist.markUser(key, reason || 'index_update'); } catch {}
  }

  markMarket(marketIndex: number, reason?: string): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    try { hotlist.markMarket(idx, reason || 'event'); } catch {}
  }

  markUser(userPk: string, reason?: string): void {
    const key = String(userPk || '').trim();
    if (!key) return;
    try { hotlist.markUser(key, reason || 'event'); } catch {}
  }

  trackConditionalOrder(marketIndex: number, orderId: string, reason?: string): void {
    const idx = Number(marketIndex);
    const key = String(orderId || '').trim();
    if (!Number.isFinite(idx) || !key) return;
    this.pruneIfNeeded(Date.now());
    let orders = this.marketToOrders.get(idx);
    if (!orders) {
      orders = new Map();
      this.marketToOrders.set(idx, orders);
    }
    orders.set(key, { ts: Date.now() });
    try { hotlist.markMarket(idx, reason || 'cond_orders'); } catch {}
  }

  untrackConditionalOrder(marketIndex: number, orderId: string): void {
    const idx = Number(marketIndex);
    const key = String(orderId || '').trim();
    if (!Number.isFinite(idx) || !key) return;
    const orders = this.marketToOrders.get(idx);
    if (!orders) return;
    orders.delete(key);
    if (orders.size === 0) this.marketToOrders.delete(idx);
  }

  getMarketsWithConditionalOrders(limit = 50): number[] {
    const now = Date.now();
    this.pruneIfNeeded(now);
    const out: number[] = [];
    const entries = Array.from(this.marketToOrders.entries())
      .filter(([, v]) => v.size > 0)
      .sort((a, b) => {
        const aTs = Math.max(...Array.from(a[1].values()).map(v => v.ts));
        const bTs = Math.max(...Array.from(b[1].values()).map(v => v.ts));
        return bTs - aTs;
      });
    for (const [idx] of entries) {
      out.push(idx);
      if (out.length >= limit) break;
    }
    return out;
  }

  getUsersForMarket(marketIndex: number, limit = 200): string[] {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return [];
    const now = Date.now();
    this.pruneIfNeeded(now);
    const users = this.marketToUsers.get(idx);
    if (!users) return [];
    const out: string[] = [];
    for (const [user] of users.entries()) {
      out.push(user);
      if (out.length >= limit) break;
    }
    return out;
  }

  getMarketsForUser(userPk: string, limit = 64): number[] {
    const key = String(userPk || '').trim();
    if (!key) return [];
    const now = Date.now();
    this.pruneIfNeeded(now);
    const markets = this.userToMarkets.get(key);
    if (!markets) return [];
    const out: number[] = [];
    for (const [m] of markets.entries()) {
      out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  getActiveMarkets(limit = 50): number[] {
    const now = Date.now();
    this.pruneIfNeeded(now);
    const entries = Array.from(this.marketToUsers.entries())
      .filter(([, v]) => v.size > 0)
      .sort((a, b) => {
        const aTs = Math.max(...Array.from(a[1].values()).map(v => v.ts));
        const bTs = Math.max(...Array.from(b[1].values()).map(v => v.ts));
        return bTs - aTs;
      });
    const out: number[] = [];
    for (const [idx] of entries) {
      out.push(idx);
      if (out.length >= limit) break;
    }
    return out;
  }

  ingestMakers(marketIndex: number, makers: string[], reason?: string): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx) || !Array.isArray(makers)) return;
    for (const m of makers) {
      const key = String(m || '').trim();
      if (!key) continue;
      this.updateUserMarkets(key, [idx], reason || 'dlob_makers');
    }
  }

  bootstrapFromUserMap(userMap: any, opts?: { limit?: number; includeOrders?: boolean; reason?: string }): { users: number; markets: number; orders: number } {
    const limit = Math.max(1, Number(opts?.limit ?? 1000));
    const includeOrders = !!opts?.includeOrders;
    const reason = opts?.reason || 'bootstrap';
    let users = 0;
    let orders = 0;
    const iter: any = userMap?.values?.() ?? userMap?._map?.values?.();
    if (!iter || typeof iter[Symbol.iterator] !== 'function') return { users, markets: this.marketToUsers.size, orders };
    for (const u of iter as Iterable<any>) {
      if (users >= limit) break;
      try {
        const pk = String(
          u?.getUserAccountPublicKey?.()?.toBase58?.()
          || u?.userAccountPublicKey?.toBase58?.()
          || u?.userAccountPublicKey
          || u?.accountPublicKey?.toBase58?.()
          || u?.accountPublicKey
          || u?.userAccount?.user?.toBase58?.()
          || u?.user
          || ''
        );
        if (!pk) { users += 1; continue; }
        const markets = this.extractMarketsFromUser(u);
        if (markets.length > 0) this.updateUserMarkets(pk, markets, reason);
        if (includeOrders) {
          const ua = u?.getUserAccount?.();
          const ords: any[] = Array.isArray(ua?.orders) ? ua.orders : [];
          for (const ord of ords) {
            try {
              // Anchor enums are objects like { triggerMarket: {} } - extract key name
              const ot = ord?.orderType && typeof ord.orderType === 'object'
                ? Object.keys(ord.orderType)[0] ?? ''
                : '';
              const otStr = String(ot).toLowerCase();
              if (!otStr.includes('trigger')) continue;
              const mi = Number(ord?.marketIndex ?? ord?.market_index ?? -1);
              if (!Number.isFinite(mi) || mi < 0) continue;
              const orderId = String(ord?.orderId ?? ord?.order_id ?? '');
              if (!orderId) continue;
              this.trackConditionalOrder(mi, `${pk}#${orderId}`, reason);
              orders += 1;
            } catch {}
          }
        }
        users += 1;
      } catch {
        users += 1;
      }
    }
    return { users, markets: this.marketToUsers.size, orders };
  }

  bindEventSubscriber(sub: any): void {
    if (!sub || typeof sub !== 'object') return;
    if (this.boundSubscribers.has(sub)) return;
    this.boundSubscribers.add(sub);
    const onUserEvent = (ev: any) => {
      try {
        const userPk: string = String(ev?.user?.toBase58?.() || ev?.user || ev?.userAccount || ev?.userAccountPublicKey || '');
        const miRaw = ev?.marketIndex ?? ev?.perpMarketIndex ?? ev?.spotMarketIndex ?? ev?.market_index;
        const mi = Number(miRaw);
        if (userPk) {
          if (Number.isFinite(mi)) this.updateUserMarkets(userPk, [mi], 'ws_user_event');
          else this.markUser(userPk, 'ws_user_event');
        }
      } catch {}
    };
    const onOrder = (ev: any) => {
      try {
        const userPk: string = String(ev?.user?.toBase58?.() || ev?.user || ev?.userAccount || ev?.userAccountPublicKey || '');
        const order = ev?.order || ev?.orderRecord || ev;
        const miRaw = order?.marketIndex ?? order?.market_index ?? ev?.marketIndex ?? ev?.perpMarketIndex ?? ev?.spotMarketIndex;
        const mi = Number(miRaw);
        const orderId = String(order?.orderId ?? order?.order_id ?? '');
        // Anchor enums are objects like { triggerMarket: {} } - extract key name
        const ot = order?.orderType && typeof order.orderType === 'object'
          ? Object.keys(order.orderType)[0] ?? ''
          : '';
        const otStr = String(ot).toLowerCase();
        if (userPk && Number.isFinite(mi)) this.updateUserMarkets(userPk, [mi], 'ws_order');
        if (Number.isFinite(mi) && orderId && otStr.includes('trigger')) {
          this.trackConditionalOrder(mi, `${userPk || 'unk'}#${orderId}`, 'ws_order');
        }
      } catch {}
    };
    try { sub.eventEmitter?.on?.('UserPositionUpdateRecord', onUserEvent); } catch {}
    try { sub.eventEmitter?.on?.('OrderRecord', onOrder); } catch {}
  }

  getStats(): { users: number; markets: number; marketToOrders: number } {
    return {
      users: this.userToMarkets.size,
      markets: this.marketToUsers.size,
      marketToOrders: this.marketToOrders.size,
    };
  }

  private pruneIfNeeded(now: number): void {
    if ((now - this.lastPruneAt) < 5000) return;
    this.lastPruneAt = now;
    const ttl = this.cfg.ttlMs;
    const pruneMarket = (m: Map<any, IndexEntry>) => {
      for (const [k, v] of m.entries()) {
        if ((now - v.ts) > ttl) m.delete(k);
      }
    };
    for (const [mkt, users] of this.marketToUsers.entries()) {
      pruneMarket(users);
      if (users.size === 0) this.marketToUsers.delete(mkt);
    }
    for (const [user, markets] of this.userToMarkets.entries()) {
      pruneMarket(markets);
      if (markets.size === 0) this.userToMarkets.delete(user);
    }
    for (const [mkt, orders] of this.marketToOrders.entries()) {
      pruneMarket(orders);
      if (orders.size === 0) this.marketToOrders.delete(mkt);
    }
    // Basic size cap protection
    if (this.userToMarkets.size > this.cfg.maxUsers) {
      const entries = Array.from(this.userToMarkets.entries()).sort((a, b) => {
        const aVals = Array.from(a[1].values());
        const bVals = Array.from(b[1].values());
        const aTs = aVals.length ? Math.min(...aVals.map(v => v.ts)) : 0;
        const bTs = bVals.length ? Math.min(...bVals.map(v => v.ts)) : 0;
        return aTs - bTs;
      });
      const overflow = this.userToMarkets.size - this.cfg.maxUsers;
      for (let i = 0; i < overflow; i += 1) this.userToMarkets.delete(entries[i][0]);
    }
    if (this.marketToUsers.size > this.cfg.maxMarkets) {
      const entries = Array.from(this.marketToUsers.entries()).sort((a, b) => {
        const aVals = Array.from(a[1].values());
        const bVals = Array.from(b[1].values());
        const aTs = aVals.length ? Math.min(...aVals.map(v => v.ts)) : 0;
        const bTs = bVals.length ? Math.min(...bVals.map(v => v.ts)) : 0;
        return aTs - bTs;
      });
      const overflow = this.marketToUsers.size - this.cfg.maxMarkets;
      for (let i = 0; i < overflow; i += 1) this.marketToUsers.delete(entries[i][0]);
    }
  }

  private extractMarketsFromUser(user: any): number[] {
    const out: number[] = [];
    try {
      const positions = user?.getPerpPositions?.() || [];
      for (const p of positions) {
        try {
          const base = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
          const idx = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
          if (Number.isFinite(idx) && Math.abs(base) > 0) out.push(Number(idx));
        } catch {}
      }
    } catch {}
    try {
      const ua = user?.getUserAccount?.();
      const spot = (ua && Array.isArray(ua?.spotPositions)) ? ua.spotPositions : [];
      for (const sp of spot) {
        try {
          const raw = Number(sp?.scaledBalance?.toString?.() || sp?.scaledBalance || sp?.cumulativeDeposits || 0);
          const idx = Number(sp?.marketIndex ?? sp?.market_index ?? sp?.market?.index);
          if (Number.isFinite(idx) && Number.isFinite(raw) && raw !== 0) out.push(Number(idx));
        } catch {}
      }
    } catch {}
    return Array.from(new Set(out));
  }
}

export const driftEventIndex = new DriftEventIndex();
