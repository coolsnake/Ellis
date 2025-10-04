// @ts-nocheck
import { logger } from '../utils/logger.js';
import { DriftService } from './client.js';
import { DriftPriceService } from './price.js';
import { getAllowlistIndices, indexToSymbol, symbolToIndex, parseAllowlistMarkets } from './marketMapping.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { User, BulkAccountLoader, EventSubscriber } from '@drift-labs/sdk';
import bs58 from 'bs58';
import { createHash } from 'crypto';

export type LiquidatorConfig = {
  name: string;
  enabled: boolean;
  pollMs?: number;
  maxConcurrentTargets?: number;
  dryRun?: boolean;
  // Discovery & scanning
  discoverAllUsers?: boolean;
  maxDiscoveredUsers?: number;
  usersAllowlist?: string[];
  scanConcurrency?: number;
  userCacheMax?: number;
  riskHealthThreshold?: number; // health < threshold considered at-risk
  // Price triggers & markets
  usePriceTriggers?: boolean;
  priceTriggerDebounceMs?: number;
  httpPollMs?: number;
  maxUsersPerPriceTick?: number;
  marketsAllowlist?: Array<string>; // e.g. ["0:SOL-PERP", "1:BTC-PERP"] or symbols
  marketIndices?: Array<number>; // explicit indices to track
  // Execution tuning
  maxCancels?: number;
  maxPerpAttempts?: number;
  perpSizeFraction?: number;
  maxSpotAttempts?: number;
  spotSizeFraction?: number;
  targetCooldownMs?: number;
  statsIntervalMs?: number;
  // Subscriptions
  useEventSubscriptions?: boolean;
  // Discovery scheduling & batching
  discoveryRefreshMs?: number;
  discoveryBatchSize?: number;
  scanBatchSize?: number;
  recentBatchPerTick?: number;
};

export type LiquidatorRuntimeState = {
  running: boolean;
  config?: LiquidatorConfig;
  candidatesQueued: number;
  actionsLastMin: number;
  errorsLastMin: number;
};

type Candidate = { userPk: string; health: number; updatedAt: number; distance?: number };

class MinHeap<T> {
  private data: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}
  size(): number { return this.data.length; }
  peek(): T | undefined { return this.data[0]; }
  push(item: T): void { this.data.push(item); this.bubbleUp(this.data.length - 1); }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop() as T;
    if (this.data.length > 0) { this.data[0] = last; this.bubbleDown(0); }
    return top;
  }
  toArray(): T[] { return this.data.slice(); }
  clear(): void { this.data = []; }
  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.compare(this.data[i], this.data[p]) >= 0) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  private bubbleDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.compare(this.data[l], this.data[smallest]) < 0) smallest = l;
      if (r < n && this.compare(this.data[r], this.data[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

export class DriftLiquidator {
  private timer: any | null = null;
  private state: LiquidatorRuntimeState = { running: false, candidatesQueued: 0, actionsLastMin: 0, errorsLastMin: 0 };
  private initialized = false;
  private priceTriggerTimers: Map<number, any> = new Map();
  private actionsLog: number[] = [];
  private errorsLog: number[] = [];
  private inFlightTargets: Set<string> = new Set();
  private userKeys: string[] = [];
  private abort = false;
  private heap: MinHeap<Candidate> = new MinHeap<Candidate>((a, b) => {
    const da = (typeof a.distance === 'number') ? a.distance : Infinity;
    const db = (typeof b.distance === 'number') ? b.distance : Infinity;
    if (da !== db) return da - db;
    return a.health - b.health;
  });
  private lastQueueEmitTs = 0;
  private trackedMarkets: Set<number> = new Set();
  private marketToUsers: Map<number, Set<string>> = new Map();
  private userToMarkets: Map<string, Set<number>> = new Map();
  private inHeap: Set<string> = new Set();
  private accountLoader: any | null = null;
  private marketScanInFlight: Set<number> = new Set();
  private userCache: Map<string, any> = new Map();
  private lastMarketPagination: Map<number, number> = new Map();
  private statsTimer: any | null = null;
  private targetCooldownUntil: Map<string, number> = new Map();
  private eventSub: any | null = null;
  private lastDiscoveryUsedGpaV2 = false;
  private discoveryTimer: any | null = null;
  private lastDiscoverySlot: number = 0;
  private discoveredRecentUsers: Set<string> = new Set();
  private scanCursor: number = 0;
  private scanBatchSize: number = 2000;
  private recentCursor: number = 0;
  private recentBatchPerTick: number = 200;

  constructor(private config: LiquidatorConfig) {}

  getStatus(): LiquidatorRuntimeState {
    return { ...this.state, config: this.config };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.state.running = true;
    const pollMs = Math.max(500, Number(this.config.pollMs || 1500));
    logger.info('drift.liquidator.start', { name: this.config.name, pollMs, dryRun: !!this.config.dryRun, cat: 'drift' });
    // Ensure Drift client is initialized
    try {
      await DriftService.getInstance().init();
    } catch {}
    // Preflight: ensure wallet has some SOL for fees unless dryRun
    try {
      if (!this.config.dryRun) {
        const driftSvc: any = DriftService.getInstance();
        const conn: any = driftSvc?.connection || driftSvc?.client?.connection;
        const kp: any = driftSvc?.walletKp;
        if (conn && kp?.publicKey) {
          const bal = await conn.getBalance(kp.publicKey, (CONFIG as any)?.system?.txCommitment || 'confirmed');
          if (bal < 0.001 * 1_000_000_000) {
            logger.warn('drift.liquidator.preflight_insufficient_sol', { lamports: bal, cat: 'drift' });
            // Force dryRun to avoid tx failures
            this.config.dryRun = true;
          }
        }
      }
    } catch {}
    // Initialize discovery and price triggers once
    try { await this.initDiscovery(); this.initialized = true; } catch {}
    try { await this.initPriceTriggers(); } catch {}
    try { await this.initEventSubscriptions(); } catch {}
    this.timer = (globalThis as any).setInterval(() => {
      this.tick().catch((e) => logger.warn('drift.liquidator.tick_error', { error: String(e?.message || e), cat: 'drift' }));
    }, pollMs);
    // Periodic stats emission
    try {
      if (this.statsTimer) { try { (globalThis as any).clearInterval(this.statsTimer); } catch {} }
      const everyMs = Math.max(5000, Number(this.config.statsIntervalMs ?? ((CONFIG as any)?.drift?.liquidator?.statsIntervalMs) ?? 15000));
      this.statsTimer = (globalThis as any).setInterval(() => {
        try {
          const snapshot = this.getQueueSnapshot(20);
          logger.info('drift.liquidator.stats', {
            queued: snapshot.candidatesQueued,
            actionsLastMin: snapshot.actionsLastMin,
            errorsLastMin: snapshot.errorsLastMin,
            markets: snapshot.markets?.length || 0,
            cat: 'drift'
          });
          emit('drift-liquidation', { type: 'stats', ...snapshot }).catch(() => {});
        } catch {}
      }, everyMs);
    } catch {}

    // Periodic recent discovery (Helius getProgramAccountsV2 changedSinceSlot)
    try {
      if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} }
      const cfg: any = (CONFIG as any)?.drift?.liquidator || {};
      const discMs = Math.max(10000, Number(this.config?.discoveryRefreshMs ?? cfg.discoveryRefreshMs ?? 45000));
      this.scanBatchSize = Math.max(100, Math.min(5000, Number(this.config?.scanBatchSize ?? cfg.scanBatchSize ?? 2000)));
      this.discoveryTimer = (globalThis as any).setInterval(() => {
        this.tryRecentDiscovery().catch(() => {});
      }, discMs);
    } catch {}
  }

  stop(): void {
    if (this.timer) (globalThis as any).clearInterval(this.timer);
    this.timer = null;
    if (this.statsTimer) { try { (globalThis as any).clearInterval(this.statsTimer); } catch {} this.statsTimer = null; }
    if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} this.discoveryTimer = null; }
    // Cleanup event subscriptions
    try {
      if (this.eventSub) {
        try {
          const maybe = (this.eventSub as any).unsubscribe?.();
          if (maybe && typeof (maybe as any).then === 'function') { (maybe as Promise<any>).catch(() => {}); }
        } catch {}
        this.eventSub = null;
      }
    } catch {}
    this.state.running = false;
    logger.info('drift.liquidator.stop', { name: this.config.name, cat: 'drift' });
    // Cleanup price triggers and timers
    try {
      const svc = DriftPriceService.getInstance();
      for (const idx of Array.from(this.trackedMarkets)) {
        try {
          const t: any = this.priceTriggerTimers.get(Number(idx));
          if (t) { try { (globalThis as any).clearTimeout(t); } catch {} }
          this.priceTriggerTimers.delete(Number(idx));
        } catch {}
        try {
          const handler = (this as any)[`_onPrice_liq_${idx}`];
          if (handler) {
            try { svc.offPrice(Number(idx), handler); } catch {}
            try { svc.untrackMarket(Number(idx)); } catch {}
            try { delete (this as any)[`_onPrice_liq_${idx}`]; } catch {}
          }
        } catch {}
      }
      this.trackedMarkets.clear();
    } catch {}
    // Clear internal state to avoid leaks
    try { this.heap.clear(); } catch {}
    try { this.inHeap.clear(); } catch {}
    try { this.inFlightTargets.clear(); } catch {}
    try { this.marketScanInFlight.clear(); } catch {}
    try { this.userToMarkets.clear(); this.marketToUsers.clear(); } catch {}
  }

  async tick(): Promise<void> {
    try {
      if (!this.initialized) { try { await this.initDiscovery(); this.initialized = true; } catch {} }
      const candidates = await this.findUnhealthyCandidates();
      // Incremental updates: add candidates, avoid rebuilding entire heap
      for (const c of candidates) this.addOrQueueCandidate({ userPk: c.userPk, health: c.health, updatedAt: Date.now() } as any);
      this.state.candidatesQueued = this.heap.size();
      this.maybeEmitQueue();
      const maxConc = Math.max(1, Number(this.config.maxConcurrentTargets || 2));
      let inProgress = 0;
      while (inProgress < maxConc) {
        const c = this.heap.pop();
        if (!c) break;
        if (inProgress >= maxConc) break;
        const key = String(c.userPk);
        if (this.inFlightTargets.has(key)) continue;
        this.inFlightTargets.add(key);
        inProgress += 1;
        this.handleTarget({ userPk: c.userPk, health: c.health })
          .catch((e) => this.recordError(e))
          .finally(() => this.inFlightTargets.delete(key));
      }
    } catch (e: any) {
      logger.warn('drift.liquidator.tick_failed', { error: String(e?.message || e), cat: 'drift' });
    }
  }

  private async initDiscovery(): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      // Preferred: Anchor account scan for users
      let list: any[] | null = null;
      const cfg: any = (CONFIG as any)?.drift?.liquidator || {};
      const discoverAll = (this.config.discoverAllUsers !== undefined) ? !!this.config.discoverAllUsers : (cfg.discoverAllUsers !== false); // default true
      if (discoverAll) {
        const maxDiscover = Math.max(10, Math.min(10000, Number((this.config.maxDiscoveredUsers ?? cfg.maxDiscoveredUsers ?? 500))));
        // Try Helius getProgramAccountsV2 with pagination and anchor discriminator filter (fast & lightweight)
        let discovered: string[] | null = null;
        try {
          discovered = await this.discoverUsersViaHeliusGpaV2(maxDiscover);
          if (Array.isArray(discovered) && discovered.length > 0) {
            this.userKeys = discovered.slice(0, maxDiscover);
            this.lastDiscoveryUsedGpaV2 = true;
            try { logger.info('drift.liquidator.discovery_mode', { mode: 'helius_v2', users: this.userKeys.length, cat: 'drift' }); } catch {}
          }
        } catch {}
        // Fallback to Anchor .all() if V2 failed or no results
        if (!Array.isArray(discovered) || discovered.length === 0) {
          try { list = await drift?.program?.account?.user?.all?.(); } catch {}
          if (Array.isArray(list) && list.length > 0) {
            const keys = list.map((x: any) => String(x?.publicKey?.toBase58?.() || x?.publicKey || '')).filter(Boolean);
            this.userKeys = keys.slice(0, maxDiscover);
            this.lastDiscoveryUsedGpaV2 = false;
            try { logger.info('drift.liquidator.discovery_mode', { mode: 'anchor_all', users: this.userKeys.length, cat: 'drift' }); } catch {}
          }
        }
      }
      // Seed with active/liquidatable users via event subscriber (if present)
      try {
        const set = new Set<string>(this.userKeys);
        const maybe = (this.eventSub as any)?.eventEmitter;
        // If we have any cached user events, fold them in (best-effort)
        // Note: EventSubscriber may not expose history; this is a placeholder for future optimization hooks
        if (maybe && typeof (maybe as any).listeners === 'function') {
          // no-op: listeners are live only
        }
        this.userKeys = Array.from(set);
      } catch {}
      // Allow explicit allowlist override
      try {
        const allow: string[] = Array.isArray(this.config.usersAllowlist) ? (this.config.usersAllowlist as any) : (Array.isArray(cfg.usersAllowlist) ? cfg.usersAllowlist : []);
        if (allow.length > 0) {
          const ks = allow.map((s) => String(s || '').trim()).filter(Boolean);
          if (ks.length > 0) this.userKeys = ks;
        }
      } catch {}
      // Fallback: include our own user only
      if (this.userKeys.length === 0) {
        try {
          const pk = await drift?.getUserAccountPublicKey?.();
          if (pk) this.userKeys = [String(pk?.toBase58?.() || pk)];
        } catch {}
      }
      logger.info('drift.liquidator.discovery_ready', { users: this.userKeys.length, cat: 'drift' });
    } catch {}
  }

  private computeAnchorDiscriminatorB58(name: string): string | null {
    try {
      const label = `account:${name}`;
      const hash = createHash('sha256').update(label).digest();
      const first8 = hash.slice(0, 8);
      return bs58.encode(first8);
    } catch {
      return null;
    }
  }

  private async discoverUsersViaHeliusGpaV2(maxDiscover: number): Promise<string[]> {
    const out: string[] = [];
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const conn: any = (DriftService.getInstance() as any).connection;
      const endpoint: string = String(conn?._rpcEndpoint || conn?.rpcEndpoint || '');
      if (!endpoint || !/helius/i.test(endpoint)) return out;
      const programId: string = String(drift?.program?.programId?.toBase58?.() || drift?.program?.programId || '');
      if (!programId) return out;
      const discr = this.computeAnchorDiscriminatorB58('User');
      const filters: any[] = discr ? [{ memcmp: { offset: 0, bytes: discr } }] : [];
      let paginationKey: any = undefined;
      while (out.length < maxDiscover) {
        const body: any = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getProgramAccountsV2',
          params: [programId, { encoding: 'base64', filters, dataSlice: { offset: 0, length: 0 }, limit: Math.min(10000, Math.max(1000, maxDiscover)) }]
        };
        if (paginationKey) (body.params[1] as any).paginationKey = paginationKey;
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json();
        const accounts = json?.result?.accounts || json?.result || [];
        if (!Array.isArray(accounts) || accounts.length === 0) break;
        for (const a of accounts) {
          const pk = String(a?.pubkey || a?.account || '');
          if (pk && !out.includes(pk)) out.push(pk);
          if (out.length >= maxDiscover) break;
        }
        paginationKey = json?.result?.paginationKey || null;
        if (!paginationKey) break;
      }
    } catch {}
    return out;
  }

  private async tryRecentDiscovery(): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const conn: any = (DriftService.getInstance() as any).connection;
      const endpoint: string = String(conn?._rpcEndpoint || conn?.rpcEndpoint || '');
      if (!endpoint || !/helius/i.test(endpoint)) return;
      const programId: string = String(drift?.program?.programId?.toBase58?.() || drift?.program?.programId || '');
      if (!programId) return;
      const maxBatch = Math.max(100, Math.min(5000, Number((this.config?.discoveryBatchSize ?? ((CONFIG as any)?.drift?.liquidator?.discoveryBatchSize) ?? 2000))));
      const discr = this.computeAnchorDiscriminatorB58('User');
      const filters: any[] = discr ? [{ memcmp: { offset: 0, bytes: discr } }] : [];
      const body: any = {
        jsonrpc: '2.0', id: 1, method: 'getProgramAccountsV2',
        params: [programId, { encoding: 'base64', filters, dataSlice: { offset: 0, length: 0 }, limit: maxBatch, changedSinceSlot: Number(this.lastDiscoverySlot || 0) }]
      };
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      const accounts = json?.result?.accounts || json?.result || [];
      if (Array.isArray(accounts) && accounts.length > 0) {
        try { logger.info('drift.liquidator.discovery_recent', { fetched: accounts.length, lastSlot: this.lastDiscoverySlot, cat: 'drift' }); } catch {}
        // Further narrow recent users to those with activity in tracked markets by sampling a small subset immediately
        const sample = accounts.slice(0, Math.min(200, accounts.length));
        for (const a of sample) { const pk = String(a?.pubkey || a?.account || ''); if (pk) this.discoveredRecentUsers.add(pk); }
        // Cap recent set size
        const cap = Math.max(1000, Math.min(50000, Number((this.config?.maxDiscoveredUsers ?? ((CONFIG as any)?.drift?.liquidator?.maxDiscoveredUsers) ?? 5000))));
        if (this.discoveredRecentUsers.size > cap) {
          const trim = this.discoveredRecentUsers.size - cap;
          let i = 0;
          for (const v of Array.from(this.discoveredRecentUsers)) { this.discoveredRecentUsers.delete(v); i += 1; if (i >= trim) break; }
        }
        // Merge into userKeys (dedup)
        const set = new Set<string>(this.userKeys);
        for (const v of this.discoveredRecentUsers) set.add(v);
        this.userKeys = Array.from(set);
      }
      try { this.lastDiscoverySlot = Number(await conn.getSlot('processed')); } catch {}
    } catch {}
  }

  private async initPriceTriggers(): Promise<void> {
    try {
      const liqCfg: any = (CONFIG as any)?.drift?.liquidator || {};
      if (this.config.usePriceTriggers === false || (this.config.usePriceTriggers === undefined && liqCfg.usePriceTriggers === false)) return;
      // Resolve markets to track: prefer explicit marketIndices, then marketsAllowlist, else global allowlist
      let indices: number[] = [];
      try {
        if (Array.isArray(this.config.marketIndices) && this.config.marketIndices.length > 0) {
          indices = (this.config.marketIndices as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n));
        }
      } catch {}
      try {
        if (indices.length === 0 && Array.isArray(this.config.marketsAllowlist) && this.config.marketsAllowlist.length > 0) {
          const parsed = parseAllowlistMarkets();
          const mapFromCfg = (this.config.marketsAllowlist as any[])
            .map((s: any) => String(s || '').trim()).filter(Boolean)
            .map((s: string) => {
              if (/^\d+\s*[:=]/.test(s)) return Number(s.split(/[:=]/)[0].trim());
              if (/^\d+$/.test(s)) return Number(s.trim());
              const idx = symbolToIndex(s);
              return typeof idx === 'number' ? idx : undefined;
            })
            .filter((x: any) => Number.isFinite(x)) as number[];
          indices = mapFromCfg.length > 0 ? mapFromCfg : parsed.map((m: any) => Number(m.marketIndex));
        }
      } catch {}
      if (indices.length === 0) indices = getAllowlistIndices();
      // Default to first few common markets
      if (indices.length === 0) indices.push(0, 1, 2);
      const svc = DriftPriceService.getInstance();
      const debounceMs = Math.max(600, Math.min(5000, Number((this.config.priceTriggerDebounceMs ?? liqCfg.priceTriggerDebounceMs ?? ((CONFIG as any)?.websocketIntervalMs) ?? 800))));
      for (const idx of indices) {
        try { svc.trackMarket(idx, Math.max(800, Number((this.config.httpPollMs ?? liqCfg.httpPollMs ?? 1200)))); } catch {}
        this.trackedMarkets.add(Number(idx));
        const onPrice = () => {
          const prev: any = this.priceTriggerTimers.get(idx);
          if (prev) { try { (globalThis as any).clearTimeout(prev); } catch {} }
          const t: any = (globalThis as any).setTimeout(() => {
            this.partialUpdateForMarket(Number(idx))
              .then(() => {
                this.state.candidatesQueued = this.heap.size();
                this.drainQueue(Math.max(1, Number(this.config.maxConcurrentTargets || 2)));
              })
              .catch(() => {});
          }, debounceMs);
          this.priceTriggerTimers.set(idx, t);
        };
        (this as any)[`_onPrice_liq_${idx}`] = onPrice;
        try { svc.onPrice(idx, onPrice as any); } catch {}
      }
    } catch {}
  }

  private async initEventSubscriptions(): Promise<void> {
    try {
      if (this.config?.useEventSubscriptions === false) return;
      const drift: any = (DriftService.getInstance() as any).client;
      if (!EventSubscriber || !drift?.program || !drift?.connection) return;
      const sub = new EventSubscriber(drift.connection, drift.program);
      try {
        await sub.subscribe();
      } catch (e: any) {
        logger.warn('drift.liquidator.event_sub_error', { error: String(e?.message || e), cat: 'drift' });
        return;
      }
      this.eventSub = sub;
      // Listen for position updates and order events to prioritize scanning affected users
      const onUserEvent = async (ev: any) => {
        try {
          const userPk: string = String(ev?.user?.toBase58?.() || ev?.user || '');
          if (!userPk) return;
          await this.enqueueIfUnhealthy(userPk);
        } catch {}
      };
      try { sub.eventEmitter?.on?.('UserPositionUpdateRecord', onUserEvent); } catch {}
      try { sub.eventEmitter?.on?.('OrderRecord', onUserEvent); } catch {}
      try { sub.eventEmitter?.on?.('LiquidationRecord', onUserEvent); } catch {}
      // Basic resilience: best-effort resubscribe on emitter error/close
      const tryResub = async () => {
        try {
          await sub.unsubscribe();
        } catch {}
        try {
          await sub.subscribe();
        } catch (e: any) {
          logger.warn('drift.liquidator.event_sub_resub_failed', { error: String(e?.message || e), cat: 'drift' });
        }
      };
      try { sub.eventEmitter?.on?.('error', tryResub as any); } catch {}
      try { sub.eventEmitter?.on?.('close', tryResub as any); } catch {}
    } catch {}
  }

  private async enqueueIfUnhealthy(pkStr: string): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const conn: any = (DriftService.getInstance() as any).connection;
      if (!this.accountLoader) this.accountLoader = new BulkAccountLoader(conn, 'confirmed', 1000);
      let user = this.userCache.get(String(pkStr));
      if (!user) {
        user = new User({ driftClient: drift, userAccountPublicKey: pkStr, accountSubscription: { type: 'polling', accountLoader: this.accountLoader } });
        this.userCache.set(String(pkStr), user);
      }
      const exists = await (user as any).exists?.();
      if (!exists) return;
      const total = Number((user as any)?.getTotalCollateral?.() || 0);
      const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
      if (!isFinite(total) || !isFinite(maint)) return;
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      const health = maint > 0 ? (total - maint) / maint : Infinity;
      if (health < riskThresh) {
        this.addOrQueueCandidate({ userPk: pkStr, health, updatedAt: Date.now() } as any);
        try { await this.refreshIndexForUser(user, pkStr); } catch {}
        this.state.candidatesQueued = this.heap.size();
        this.maybeEmitQueue();
      }
    } catch {}
  }

  private async findUnhealthyCandidates(): Promise<Array<{ userPk: string; health: number }>> {
    const out: Array<{ userPk: string; health: number }> = [];
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const conn: any = (DriftService.getInstance() as any).connection;
      if (!this.accountLoader) this.accountLoader = new BulkAccountLoader(conn, 'confirmed', 1000);
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      // Build scan order: recent -> remaining (round-robin with persistent cursor) to avoid rescanning same heads
      const recentArr = Array.from(this.discoveredRecentUsers);
      // Rotate recent slice to avoid always scanning same heads
      if (this.recentCursor >= recentArr.length) this.recentCursor = 0;
      const prioritized = recentArr.slice(this.recentCursor, this.recentCursor + this.recentBatchPerTick);
      this.recentCursor = (this.recentCursor + this.recentBatchPerTick) % Math.max(1, Math.max(1, recentArr.length || 1));
      const remaining = this.userKeys.filter((k) => !this.discoveredRecentUsers.has(k));
      // Round-robin window into remaining using scanCursor
      if (this.scanCursor >= remaining.length) this.scanCursor = 0;
      const window = remaining.slice(this.scanCursor, this.scanCursor + this.scanBatchSize);
      const tail = (window.length < this.scanBatchSize) ? remaining.slice(0, Math.max(0, this.scanBatchSize - window.length)) : [];
      const keys = prioritized.concat(window).concat(tail);
      this.scanCursor = (this.scanCursor + this.scanBatchSize) % Math.max(1, remaining.length);
      const maxConc = Math.max(2, Math.min(24, Number((this.config.scanConcurrency ?? ((CONFIG as any)?.drift?.liquidator?.scanConcurrency) ?? 10))));
      let cursor = 0;
      const self = this;
      const getOrCreateUser = async (pkStr: string): Promise<any> => {
        const key = String(pkStr);
        let u = self.userCache.get(key);
        if (u) {
          // touch LRU
          self.userCache.delete(key);
          self.userCache.set(key, u);
          return u;
        }
        u = new User({ driftClient: drift, userAccountPublicKey: key, accountSubscription: { type: 'polling', accountLoader: self.accountLoader } });
        self.userCache.set(key, u);
        const maxSize = Math.max(50, Math.min(5000, Number((this.config.userCacheMax ?? ((CONFIG as any)?.drift?.liquidator?.userCacheMax) ?? 500))));
        if (self.userCache.size > maxSize) {
          // evict oldest (first inserted)
          const firstKey = self.userCache.keys().next().value;
          if (firstKey) self.userCache.delete(firstKey);
        }
        return u;
      };
      const worker = async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= keys.length) break;
          const pkStr = keys[i];
          try {
            const user = await getOrCreateUser(pkStr);
            const exists = await (user as any).exists?.();
            if (!exists) continue;
            const total = Number((user as any)?.getTotalCollateral?.() || 0);
            const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
            if (!isFinite(total) || !isFinite(maint)) continue;
            const health = maint > 0 ? (total - maint) / maint : Infinity;
            if (health < riskThresh) out.push({ userPk: pkStr, health });
            try { await self.refreshIndexForUser(user, pkStr); } catch {}
          } catch {}
        }
      };
      const runners: Promise<void>[] = [];
      for (let k = 0; k < maxConc; k += 1) runners.push(worker());
      await Promise.all(runners);
      try {
        let minHealth = Infinity;
        for (const c of out) { if (typeof c.health === 'number' && c.health < minHealth) minHealth = c.health; }
        // Build a small sample and compute relevant risk metrics
        const sampleKeys = (window.length > 0 ? window : prioritized).slice(0, Math.min(5, (window.length > 0 ? window : prioritized).length));
        const samples: Array<{ userPk: string; totalCollateral: number; maintenanceRequirement: number; freeCollateral: number; healthMaint: number | null; healthTotal: number | null }> = [];
        for (const s of sampleKeys) {
          try {
            const u = await getOrCreateUser(s);
            const total = Number((u as any)?.getTotalCollateral?.() || 0);
            const maint = Number((u as any)?.getMaintenanceMarginRequirement?.() || 0);
            const free = Number((u as any)?.getFreeCollateral?.() || 0);
            const healthMaint = maint > 0 ? (total - maint) / maint : null;
            const healthTotal = total > 0 ? (total - maint) / total : null;
            samples.push({ userPk: s, totalCollateral: total, maintenanceRequirement: maint, freeCollateral: free, healthMaint, healthTotal });
          } catch {}
        }
        logger.info('drift.liquidator.scan_summary', {
          scanned: keys.length,
          candidatesFound: out.length,
          minHealth: Number.isFinite(minHealth) ? minHealth : null,
          threshold: riskThresh,
          sampledUsers: sampleKeys,
          sampleCalcs: samples,
          cat: 'drift',
        });
      } catch {}
    } catch {}
    return out;
  }

  private async refreshIndexForUser(sdkUser: any, userPk: string): Promise<void> {
    try {
      const positions = sdkUser?.getPerpPositions?.() || [];
      const active: number[] = [];
      for (const p of positions) {
        try {
          const base = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
          const idx = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
          if (Number.isFinite(idx) && Math.abs(base) > 0) active.push(Number(idx));
        } catch {}
      }
      // If markets are specified in config, filter to those
      try {
        const conf = this.config;
        let allowed: Set<number> | null = null;
        if (Array.isArray(conf.marketIndices) && conf.marketIndices.length > 0) {
          allowed = new Set<number>((conf.marketIndices as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n)));
        } else if (Array.isArray(conf.marketsAllowlist) && conf.marketsAllowlist.length > 0) {
          const parsed = parseAllowlistMarkets();
          const map = new Map<string, number>();
          for (const m of parsed) { map.set(String(m.symbol || m.marketIndex), Number(m.marketIndex)); }
          allowed = new Set<number>((conf.marketsAllowlist as any[]).map((s: any) => {
            const str = String(s || '').trim();
            if (/^\d+\s*[:=]/.test(str)) return Number(str.split(/[:=]/)[0].trim());
            if (/^\d+$/.test(str)) return Number(str);
            const idx = symbolToIndex(str);
            return typeof idx === 'number' ? idx : NaN;
          }).filter((n) => Number.isFinite(n)) as number[]);
        }
        if (allowed) {
          for (const v of Array.from(active)) { if (!allowed.has(v)) active.splice(active.indexOf(v), 1); }
        }
      } catch {}
      const newSet = new Set<number>(active);
      const prev = this.userToMarkets.get(userPk) || new Set<number>();
      for (const m of Array.from(prev)) {
        if (!newSet.has(m)) {
          const s = this.marketToUsers.get(m);
          if (s) { s.delete(userPk); if (s.size === 0) this.marketToUsers.delete(m); }
          prev.delete(m);
        }
      }
      for (const m of Array.from(newSet)) {
        if (!prev.has(m)) {
          if (!this.marketToUsers.has(m)) this.marketToUsers.set(m, new Set());
          this.marketToUsers.get(m)!.add(userPk);
          prev.add(m);
        }
      }
      this.userToMarkets.set(userPk, prev);
    } catch {}
  }

  private async partialUpdateForMarket(marketIndex: number): Promise<void> {
    try {
      const idx = Number(marketIndex);
      if (!Number.isFinite(idx)) return;
      if (this.marketScanInFlight.has(idx)) return;
      this.marketScanInFlight.add(idx);
      const users = Array.from(this.marketToUsers.get(idx) || []);
      if (users.length === 0) { this.marketScanInFlight.delete(idx); return; }
      const drift: any = (DriftService.getInstance() as any).client;
      const conn: any = (DriftService.getInstance() as any).connection;
      if (!this.accountLoader) this.accountLoader = new BulkAccountLoader(conn, 'confirmed', 1000);
      // Cap per event to avoid long stalls
      const maxUsersPerTick = Math.max(5, Math.min(500, Number((this.config.maxUsersPerPriceTick ?? ((CONFIG as any)?.drift?.liquidator?.maxUsersPerPriceTick) ?? 40))));
      // Round-robin pagination per market
      const prevOff = this.lastMarketPagination.get(idx) || 0;
      const start = prevOff % users.length;
      const slice: string[] = [];
      for (let i = 0; i < Math.min(maxUsersPerTick, users.length); i += 1) {
        slice.push(users[(start + i) % users.length]);
      }
      this.lastMarketPagination.set(idx, (start + slice.length) % users.length);
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      for (const pkStr of slice) {
        try {
          let user = this.userCache.get(String(pkStr));
          if (!user) {
            user = new User({ driftClient: drift, userAccountPublicKey: pkStr, accountSubscription: { type: 'polling', accountLoader: this.accountLoader } });
            this.userCache.set(String(pkStr), user);
          }
          const exists = await (user as any).exists?.();
          if (!exists) continue;
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          if (!isFinite(total) || !isFinite(maint)) continue;
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          if (health < riskThresh) this.addOrQueueCandidate({ userPk: pkStr, health, updatedAt: Date.now() });
          try { await this.refreshIndexForUser(user, pkStr); } catch {}
        } catch {}
      }
      this.state.candidatesQueued = this.heap.size();
      this.maybeEmitQueue();
    } catch {
    } finally {
      try { this.marketScanInFlight.delete(Number(marketIndex)); } catch {}
    }
  }

  private addOrQueueCandidate(c: Candidate): void {
    try {
      const key = String(c.userPk);
      // Skip if target is cooling down
      const until = this.targetCooldownUntil.get(key);
      if (typeof until === 'number' && Date.now() < until) return;
      if (this.inFlightTargets.has(key)) return;
      if (this.inHeap.has(key)) return;
      // Compute distance-to-liquidation if possible (min across tracked/active markets)
      try {
        const tracked = Array.from(this.trackedMarkets);
        if (tracked.length > 0) {
          let best: number | null = null;
          for (const idx of tracked) {
            try {
              const dist = this.computeDistanceToLiquidation(key, idx);
              if (typeof dist === 'number') {
                if (best === null || dist < best) best = dist;
              }
            } catch {}
          }
          if (best !== null) (c as any).distance = best;
        }
      } catch {}
      this.heap.push(c);
      this.inHeap.add(key);
    } catch {}
  }

  private drainQueue(maxConc: number): void {
    try {
      const cap = Math.max(1, Number(maxConc || 1));
      let inProgress = 0;
      while (inProgress < cap) {
        const c = this.heap.pop();
        if (!c) break;
        const key = String(c.userPk);
        this.inHeap.delete(key);
        // Honor cooldowns
        const until = this.targetCooldownUntil.get(key);
        if (typeof until === 'number' && Date.now() < until) {
          continue;
        }
        if (this.inFlightTargets.has(key)) continue;
        this.inFlightTargets.add(key);
        inProgress += 1;
        this.handleTarget({ userPk: c.userPk, health: c.health })
          .catch((e) => this.recordError(e))
          .finally(() => this.inFlightTargets.delete(key));
      }
    } catch {}
  }

  private async handleTarget(target: { userPk: string; health: number }): Promise<void> {
    try {
      const dry = !!this.config.dryRun;
      if (dry) {
        this.recordAction();
        logger.info('drift.liquidator.dryrun_target', { user: target.userPk, health: target.health, cat: 'drift' });
        return;
      }
      const drift: any = (DriftService.getInstance() as any).client;
      const marketsForUser = Array.from(this.userToMarkets.get(String(target.userPk)) || []);
      const perpMarkets = marketsForUser.length > 0 ? marketsForUser : [0, 1, 2];
      // Step 1: force-cancel orders (best-effort, capped)
      try {
        const maxCancels = Math.max(1, Math.min(200, Number((this.config.maxCancels ?? ((CONFIG as any)?.drift?.liquidator?.maxCancels) ?? 20))));
        const batch = Math.min(maxCancels, 10);
        if (typeof drift?.forceCancelOrders === 'function') {
          let remaining = maxCancels;
          while (remaining > 0) {
            try { await drift.forceCancelOrders({ userPublicKey: target.userPk, marketType: 0, limit: batch }); } catch {}
            remaining -= batch;
            if (remaining > 0) { try { await new Promise(r => setTimeout(r, 250)); } catch {} }
          }
        } else if (typeof drift?.forceCancelOrdersForUsers === 'function') {
          try {
            await drift.forceCancelOrdersForUsers({
              users: [target.userPk],
              marketType: 0,
              maxCancels: maxCancels,
            });
          } catch {}
        }
      } catch (e: any) {
        this.recordError(e);
      }
      // Step 2: attempt perp liquidation (best-effort, capped)
      try {
        if (typeof drift?.liquidatePerp === 'function') {
          const maxPerp = Math.max(1, Math.min(50, Number((this.config.maxPerpAttempts ?? ((CONFIG as any)?.drift?.liquidator?.maxPerpAttempts) ?? 3))));
          const sizeFrac = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
          let attempts = 0;
          for (const idx of perpMarkets) {
            if (attempts >= maxPerp) break;
            try {
              await drift.liquidatePerp(target.userPk, Number(idx), sizeFrac);
              attempts += 1;
            } catch {}
          }
        } else if (typeof drift?.liquidatePerpBatch === 'function') {
          try {
            await drift.liquidatePerpBatch({
              users: [target.userPk],
              markets: perpMarkets,
              sizeFraction: Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05)))),
            });
          } catch {}
        }
      } catch (e: any) {
        this.recordError(e);
        this.applyCooldownForTarget(target.userPk);
      }
      // Step 3: attempt spot liquidation (best-effort, capped)
      try {
        if (typeof drift?.liquidateSpot === 'function') {
          const maxSpot = Math.max(1, Math.min(50, Number((this.config.maxSpotAttempts ?? ((CONFIG as any)?.drift?.liquidator?.maxSpotAttempts) ?? 2))));
          const sizeFrac = Math.max(0.001, Math.min(0.5, Number((this.config.spotSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.spotSizeFraction) ?? 0.05))));
          const spots = [0];
          let attempts = 0;
          for (const s of spots) {
            if (attempts >= maxSpot) break;
            try {
              await drift.liquidateSpot(target.userPk, Number(s), sizeFrac);
              attempts += 1;
            } catch {}
          }
        }
      } catch (e: any) {
        this.recordError(e);
        this.applyCooldownForTarget(target.userPk);
      }
      this.recordAction();
      logger.info('drift.liquidator.action_complete', { user: target.userPk, cat: 'drift' });
    } catch (e: any) {
      this.recordError(e);
      this.applyCooldownForTarget(target.userPk);
    }
  }

  private recordAction(): void {
    try {
      const now = Date.now();
      this.actionsLog.push(now);
      // Drop entries older than 60s
      while (this.actionsLog.length > 0 && (now - this.actionsLog[0]) > 60000) this.actionsLog.shift();
      this.state.actionsLastMin = this.actionsLog.length;
      try { emit('drift-liquidation', { type: 'action', actionsLastMin: this.state.actionsLastMin }); } catch {}
    } catch {}
  }

  private computeDistanceToLiquidation(userPk: string, marketIndex: number): number | null {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const sdkUser = this.userCache.get(String(userPk));
      if (!sdkUser) return null;
      // Try to get user’s position for this market
      const positions = sdkUser?.getPerpPositions?.() || [];
      const pos = positions.find((p: any) => Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index) === Number(marketIndex));
      if (!pos) return null;
      const base = Number(pos?.baseAssetAmount?.toString?.() || pos?.baseAssetAmount || 0);
      if (!isFinite(base) || Math.abs(base) === 0) return null;
      // Estimate liquidation price if available on SDK; else approximate from collateral & maintenance
      // Placeholder: derive from health proxy if SDK doesn’t expose directly
      const priceSample = DriftPriceService.getInstance().getPrice(Number(marketIndex));
      const cur = (priceSample?.mid ?? priceSample?.oracle ?? priceSample?.bid ?? priceSample?.ask);
      if (typeof cur !== 'number' || cur <= 0) return null;
      // Approximation: smaller (collateral - maint)/maint => closer to zero health; translate to price move needed
      const total = Number((sdkUser as any)?.getTotalCollateral?.() || 0);
      const maint = Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0);
      if (!isFinite(total) || !isFinite(maint) || maint <= 0) return null;
      const health = (total - maint) / maint; // 0 => liquidation threshold
      // Assume linear relation of PnL to price for small deltas: deltaPnL ≈ qty * deltaPrice
      // Solve for deltaPrice to push health to 0. This is a rough priority metric, not exact liq price.
      const qty = Math.abs(base);
      if (!qty || !isFinite(qty)) return null;
      const estDeltaPrice = Math.abs((health * maint) / qty);
      const distance = estDeltaPrice / cur; // normalized distance
      return isFinite(distance) ? Math.max(0, distance) : null;
    } catch {
      return null;
    }
  }

  private recordError(e: any): void {
    try {
      const now = Date.now();
      this.errorsLog.push(now);
      while (this.errorsLog.length > 0 && (now - this.errorsLog[0]) > 60000) this.errorsLog.shift();
      this.state.errorsLastMin = this.errorsLog.length;
      logger.warn('drift.liquidator.error', { error: String(e?.message || e), cat: 'drift' });
      try { emit('drift-liquidation', { type: 'error', error: String(e?.message || e), errorsLastMin: this.state.errorsLastMin }); } catch {}
    } catch {}
  }

  private applyCooldownForTarget(userPk: string): void {
    try {
      const baseMs = Math.max(1000, Math.min(60000, Number((this.config.targetCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.targetCooldownMs) ?? 7000))));
      const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(250, baseMs * 0.15)));
      const until = Date.now() + baseMs + jitter;
      this.targetCooldownUntil.set(String(userPk), until);
    } catch {}
  }

  private maybeEmitQueue(): void {
    try {
      const now = Date.now();
      if (now - this.lastQueueEmitTs < 1000) return;
      this.lastQueueEmitTs = now;
      const top: Candidate[] = [];
      const arr = this.heap.toArray();
      const cap = Math.min(arr.length, 200);
      // Build a small heap from a capped copy to avoid O(n) copies when large
      const small = new MinHeap<Candidate>((a, b) => a.health - b.health);
      for (let i = 0; i < cap; i += 1) small.push(arr[i]);
      for (let i = 0; i < 10; i += 1) { const c = small.pop(); if (!c) break; top.push(c); }
      const exposuresCounts = Array.from(this.marketToUsers.entries()).map(([m, set]) => ({ marketIndex: Number(m), users: (set?.size || 0) }));
      let exposuresWithSymbols: Array<{ marketIndex: number; users: number; symbol?: string }> = exposuresCounts;
      try {
        exposuresWithSymbols = exposuresCounts.map((e) => ({ ...e, symbol: indexToSymbol(Number(e.marketIndex)) }));
      } catch {}
      emit('drift-liquidation', {
        type: 'queue',
        candidatesQueued: this.state.candidatesQueued,
        top: top.map(t => ({ userPk: t.userPk, health: t.health, updatedAt: t.updatedAt })),
        markets: Array.from(this.trackedMarkets),
        exposures: exposuresWithSymbols,
        actionsLastMin: this.state.actionsLastMin,
        errorsLastMin: this.state.errorsLastMin,
      }).catch(() => {});
    } catch {}
  }

  getQueueSnapshot(limit = 20): { candidatesQueued: number; top: Array<{ userPk: string; health: number; updatedAt: number }>; markets: number[]; exposures: Array<{ marketIndex: number; users: number; symbol?: string }>; actionsLastMin: number; errorsLastMin: number } {
    const top: Candidate[] = [];
    const arr = this.heap.toArray();
    const cap = Math.min(arr.length, Math.max(25, Number(limit) * 8));
    const small = new MinHeap<Candidate>((a, b) => a.health - b.health);
    for (let i = 0; i < cap; i += 1) small.push(arr[i]);
    const howMany = Math.max(1, Math.min(100, Number(limit)));
    for (let i = 0; i < howMany; i += 1) { const c = small.pop(); if (!c) break; top.push(c); }
    const exposuresCounts = Array.from(this.marketToUsers.entries()).map(([m, set]) => ({ marketIndex: Number(m), users: (set?.size || 0) }));
    let exposuresWithSymbols: Array<{ marketIndex: number; users: number; symbol?: string }> = exposuresCounts;
    try {
      exposuresWithSymbols = exposuresCounts.map((e) => ({ ...e, symbol: indexToSymbol(Number(e.marketIndex)) }));
    } catch {}
    return {
      candidatesQueued: this.state.candidatesQueued,
      top: top.map(t => ({ userPk: t.userPk, health: t.health, updatedAt: t.updatedAt })),
      markets: Array.from(this.trackedMarkets),
      exposures: exposuresWithSymbols,
      actionsLastMin: this.state.actionsLastMin,
      errorsLastMin: this.state.errorsLastMin,
    };
  }
}

export class DriftLiquidatorRegistry {
  private static reg = new RunnerRegistry<DriftLiquidator>();

  static keyOf(cfg: LiquidatorConfig): string {
    return cfg?.name ? `liq#${cfg.name}` : 'liq#default';
  }

  static upsert(cfg: LiquidatorConfig): DriftLiquidator {
    const key = this.keyOf(cfg);
    return this.reg.upsert(key, () => new DriftLiquidator(cfg));
  }

  static get(key: string): DriftLiquidator | undefined {
    return this.reg.get(key);
  }

  static list(): Array<{ key: string; status: LiquidatorRuntimeState }> {
    return this.reg.list();
  }

  static async start(key: string): Promise<boolean> {
    return this.reg.start(key);
  }

  static stop(key: string): boolean {
    return this.reg.stop(key);
  }

  static remove(key: string): boolean {
    return this.reg.remove(key);
  }
}


