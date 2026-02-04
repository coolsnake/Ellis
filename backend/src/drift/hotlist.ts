type HotEntry = {
  ts: number;
  count: number;
  reason?: string;
  consumedBy: Map<string, number>;
};

type HotlistOptions = {
  ttlMs: number;
  maxMarkets: number;
  maxUsers: number;
};

type ListOptions = {
  limit?: number;
  consumerId?: string;
  consume?: boolean;
};

export class Hotlist {
  private ttlMs: number;
  private maxMarkets: number;
  private maxUsers: number;
  private markets: Map<number, HotEntry> = new Map();
  private users: Map<string, HotEntry> = new Map();

  constructor(opts?: Partial<HotlistOptions>) {
    this.ttlMs = Math.max(1000, Number(opts?.ttlMs ?? 30000));
    this.maxMarkets = Math.max(10, Number(opts?.maxMarkets ?? 250));
    this.maxUsers = Math.max(50, Number(opts?.maxUsers ?? 1000));
  }

  configure(opts: Partial<HotlistOptions>): void {
    if (Number.isFinite(Number(opts?.ttlMs))) this.ttlMs = Math.max(1000, Number(opts!.ttlMs));
    if (Number.isFinite(Number(opts?.maxMarkets))) this.maxMarkets = Math.max(10, Number(opts!.maxMarkets));
    if (Number.isFinite(Number(opts?.maxUsers))) this.maxUsers = Math.max(50, Number(opts!.maxUsers));
  }

  markMarket(marketIndex: number, reason?: string): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    const now = Date.now();
    this.prune(this.markets, now);
    const prev = this.markets.get(idx);
    const entry: HotEntry = prev || { ts: now, count: 0, consumedBy: new Map() };
    entry.ts = now;
    entry.count += 1;
    if (reason) entry.reason = reason;
    this.markets.set(idx, entry);
    this.evictOldest(this.markets, this.maxMarkets);
  }

  markUser(userPk: string, reason?: string): void {
    const key = String(userPk || '').trim();
    if (!key) return;
    const now = Date.now();
    this.prune(this.users, now);
    const prev = this.users.get(key);
    const entry: HotEntry = prev || { ts: now, count: 0, consumedBy: new Map() };
    entry.ts = now;
    entry.count += 1;
    if (reason) entry.reason = reason;
    this.users.set(key, entry);
    this.evictOldest(this.users, this.maxUsers);
  }

  getHotMarkets(opts?: ListOptions): number[] {
    const now = Date.now();
    this.prune(this.markets, now);
    const limit = Math.max(1, Number(opts?.limit ?? 25));
    const consumerId = String(opts?.consumerId || '').trim() || undefined;
    const consume = opts?.consume !== false;
    const entries = Array.from(this.markets.entries())
      .sort((a, b) => b[1].ts - a[1].ts);
    const out: number[] = [];
    for (const [idx, entry] of entries) {
      if (out.length >= limit) break;
      if (consumerId) {
        const consumedAt = entry.consumedBy.get(consumerId) || 0;
        if (consumedAt >= entry.ts) continue;
      }
      out.push(idx);
      if (consumerId && consume) entry.consumedBy.set(consumerId, now);
    }
    return out;
  }

  getHotUsers(opts?: ListOptions): string[] {
    const now = Date.now();
    this.prune(this.users, now);
    const limit = Math.max(1, Number(opts?.limit ?? 50));
    const consumerId = String(opts?.consumerId || '').trim() || undefined;
    const consume = opts?.consume !== false;
    const entries = Array.from(this.users.entries())
      .sort((a, b) => b[1].ts - a[1].ts);
    const out: string[] = [];
    for (const [key, entry] of entries) {
      if (out.length >= limit) break;
      if (consumerId) {
        const consumedAt = entry.consumedBy.get(consumerId) || 0;
        if (consumedAt >= entry.ts) continue;
      }
      out.push(key);
      if (consumerId && consume) entry.consumedBy.set(consumerId, now);
    }
    return out;
  }

  private prune(map: Map<any, HotEntry>, now: number): void {
    const ttl = this.ttlMs;
    for (const [key, entry] of map.entries()) {
      if ((now - entry.ts) > ttl) {
        map.delete(key);
        continue;
      }
      for (const [consumerId, consumedAt] of entry.consumedBy.entries()) {
        if ((now - consumedAt) > ttl) entry.consumedBy.delete(consumerId);
      }
    }
  }

  private evictOldest(map: Map<any, HotEntry>, maxSize: number): void {
    if (map.size <= maxSize) return;
    const entries = Array.from(map.entries())
      .sort((a, b) => a[1].ts - b[1].ts);
    const overflow = map.size - maxSize;
    for (let i = 0; i < overflow; i += 1) {
      map.delete(entries[i][0]);
    }
  }
}

export const hotlist = new Hotlist();
