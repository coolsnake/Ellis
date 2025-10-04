// @ts-nocheck
import { logger } from '../utils/logger.js';
import { DriftService } from './client.js';
import { DriftPriceService } from './price.js';
import { getAllowlistIndices, indexToSymbol } from './marketMapping.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { User, EventSubscriber } from '@drift-labs/sdk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';

export type LiquidatorConfig = {
  name: string;
  enabled: boolean;
  pollMs?: number;
  maxConcurrentTargets?: number;
  dryRun?: boolean;
  // Discovery
  usersAllowlist?: string[];
  userCacheMax?: number;
  riskHealthThreshold?: number; // health < threshold considered at-risk
  maxProbesPerTick?: number; // cap number of subscribe+evaluate per tick
  // Position filters
  probeMarketIndices?: Array<number>; // only evaluate users with exposure in these markets
  positionMinAbsBase?: number; // min |base| to consider active (in base units)
  positionMaxAbsBase?: number; // max |base| to consider (in base units)
  // Cooldowns
  idleCooldownMs?: number; // cooldown for users with no active positions
  outOfScopeCooldownMs?: number; // cooldown for users filtered out by market/size
  // Price triggers & markets
  usePriceTriggers?: boolean;
  priceTriggerDebounceMs?: number;
  httpPollMs?: number;
  maxUsersPerPriceTick?: number;
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
  // Discovery modes
  wsOnlyDiscovery?: boolean; // if true, disable HTTP discovery entirely
  limitedHttpDiscovery?: boolean; // if true, allow tiny HTTP discovery for initial seeding
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
  private accountLoader: any | null = null; // deprecated (no longer used)
  private marketScanInFlight: Set<number> = new Set();
  private userCache: Map<string, any> = new Map();
  private subscribedUsers: Set<string> = new Set();
  private pendingProbeQueue: string[] = [];
  private inProbeQueue: Set<string> = new Set();
  private lastMarketPagination: Map<number, number> = new Map();
  private statsTimer: any | null = null;
  private targetCooldownUntil: Map<string, number> = new Map();
  private idleUntil: Map<string, number> = new Map();
  private outOfScopeUntil: Map<string, number> = new Map();
  private eventSub: any | null = null;
  private lastDiscoveryUsedGpaV2 = false;
  private discoveryTimer: any | null = null;
  private lastDiscoverySlot: number = 0;
  private discoveredRecentUsers: Set<string> = new Set();
  private scanCursor: number = 0; // deprecated; retained for minimal impact
  private pendingProbeQueue: string[] = [];
  private inProbeQueue: Set<string> = new Set();

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
    // Initialize discovery and subscriptions (WS-only sources first)
    try { await this.initDiscovery(); this.initialized = true; } catch {}
    try { await this.initEventSubscriptions(); } catch {}
    try { await this.initDlobSources(); } catch {}
    try { await this.seedFromDlobUserMap(); } catch {}
    try { await this.seedFromDlobHttp(); } catch {}
    try { await this.initPriceTriggers(); } catch {}
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
          const exposure = this.computeExposureStats();
          logger.info('drift.liquidator.stats', {
            queued: snapshot.candidatesQueued,
            actionsLastMin: snapshot.actionsLastMin,
            errorsLastMin: snapshot.errorsLastMin,
            markets: snapshot.markets?.length || 0,
            trackedUsers: this.userCache.size,
            exposureUsers: exposure.exposureUsers,
            exposureMarkets: exposure.exposureMarkets,
            cat: 'drift'
          });
          emit('drift-liquidation', { type: 'stats', ...snapshot }).catch(() => {});
        } catch {}
      }, everyMs);
    } catch {}

    // HTTP discovery disabled (WS-only). Do not schedule any GPA/Anchor discovery timers.
    try {
      if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} }
      this.discoveryTimer = null;
      try { logger.info('drift.liquidator.discovery_http_disabled', { cat: 'drift' }); } catch {}
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
    try { this.pendingProbeQueue = []; this.inProbeQueue.clear(); } catch {}
  }

  async tick(): Promise<void> {
    try {
      if (!this.initialized) { try { await this.initDiscovery(); this.initialized = true; } catch {} }
      const candidates = await this.findUnhealthyCandidates();
      try { await this.processProbeQueue(); } catch {}
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
      // WS-only discovery: seed from DLOB/UserMap and events. Do not do HTTP discovery here.
      try { await this.seedFromDlobUserMap(); } catch {}
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
        const cfg = ((CONFIG as any)?.drift?.liquidator) || {};
        const allow: string[] = Array.isArray(this.config.usersAllowlist)
          ? (this.config.usersAllowlist as any)
          : (Array.isArray(cfg.usersAllowlist) ? cfg.usersAllowlist : []);
        if (Array.isArray(allow) && allow.length > 0) {
          const ks = allow.map((s) => String(s || '').trim()).filter(Boolean);
          if (ks.length > 0) this.userKeys = ks;
        }
      } catch {}
      // Fallback: include our own user only
      if (this.userKeys.length === 0) {
        try {
          const drift = (DriftService.getInstance() as any).client;
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
      const maxBatch = 0;
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
        const cap = 0;
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
      // Resolve markets to track: prefer explicit marketIndices; drop marketsAllowlist
      let indices: number[] = [];
      try {
        if (Array.isArray(this.config.marketIndices) && this.config.marketIndices.length > 0) {
          indices = (this.config.marketIndices as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n));
        }
      } catch {}
      try {
        // no-op: keep indices as configured or default allowlist
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
          this.enqueueProbe(userPk);
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
      let user = this.userCache.get(String(pkStr));
      if (!user) {
        let pk: any = pkStr;
        try { if (typeof pkStr === 'string') pk = new PublicKey(pkStr); } catch {}
        user = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
        this.userCache.set(String(pkStr), user);
      }
      // Ensure subscription before reads
      try {
        if (!this.subscribedUsers.has(String(pkStr)) && typeof (user as any)?.subscribe === 'function') {
          await (user as any).subscribe();
          this.subscribedUsers.add(String(pkStr));
        }
      } catch {}
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
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      // Build scan order: recent -> remaining (round-robin with persistent cursor) to avoid rescanning same heads
      const recentArr = Array.from(this.discoveredRecentUsers);
      // Rotate recent slice to avoid always scanning same heads
      if (this.recentCursor >= recentArr.length) this.recentCursor = 0;
      const prioritized: string[] = [];
      const remaining = this.userKeys.filter((k) => !this.discoveredRecentUsers.has(k));
      // Round-robin window into remaining using scanCursor
      const batchSize = Math.max(1, Math.min(200, Number(((CONFIG as any)?.drift?.liquidator?.scanBatchSize) ?? 200)));
      if (remaining.length > 0) {
        if (this.scanCursor >= remaining.length) this.scanCursor = 0;
      } else {
        this.scanCursor = 0;
      }
      const end = Math.min(this.scanCursor + batchSize, Math.max(0, remaining.length));
      const window = remaining.slice(this.scanCursor, end);
      const tail: string[] = [];
      const keys = prioritized.concat(window).concat(tail);
      // advance cursor modulo remaining length for next tick
      if (remaining.length > 0) {
        this.scanCursor = (end % remaining.length);
      } else {
        this.scanCursor = 0;
      }
      const maxConc = 2;
      const maxNewUsers = Math.max(0, Math.min(2000, Number((this.config.maxNewUsersPerTick ?? ((CONFIG as any)?.drift?.liquidator?.maxNewUsersPerTick) ?? 250))));
      let newUsersAdded = 0;
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
        if (newUsersAdded >= maxNewUsers) return null;
        let pk: any = key;
        try { if (typeof key === 'string') pk = new PublicKey(key); } catch {}
        u = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
        self.userCache.set(key, u);
        const maxSize = Math.max(50, Math.min(5000, Number((this.config.userCacheMax ?? ((CONFIG as any)?.drift?.liquidator?.userCacheMax) ?? 500))));
        if (self.userCache.size > maxSize) {
          // evict oldest (first inserted)
          const firstKey = self.userCache.keys().next().value;
          if (firstKey) {
            try { await (self.userCache.get(firstKey) as any)?.unsubscribe?.(); } catch {}
            self.userCache.delete(firstKey);
            try { self.subscribedUsers.delete(String(firstKey)); } catch {}
          }
        }
        // subscribe before returning to ensure reads are live
        try {
          if (!self.subscribedUsers.has(key) && typeof (u as any)?.subscribe === 'function') {
            // Defer subscription to probe stage; we only stage keys here
          }
        } catch {}
        newUsersAdded += 1;
        return u;
      };
      const worker = async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= keys.length) break;
          const pkStr = keys[i];
          try {
            // Don't subscribe or compute here; enqueue for probing
            this.enqueueProbe(pkStr);
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
        let sampleFailures = 0;
        // Sampling without subscription: just echo keys so we avoid extra load
        // Detailed sampleCalcs will be populated by probe logs instead
        const exposure = this.computeExposureStats();
        logger.info('drift.liquidator.scan_summary', {
          scanned: keys.length,
          candidatesFound: out.length,
          minHealth: Number.isFinite(minHealth) ? minHealth : null,
          threshold: riskThresh,
          sampledUsers: sampleKeys,
          sampleCalcs: [],
          sampleAttempts: 0,
          sampleFailures: 0,
          exposureUsers: exposure.exposureUsers,
          exposureMarkets: exposure.exposureMarkets,
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
      for (const pkStr of slice) { this.enqueueProbe(pkStr); }
      this.state.candidatesQueued = this.heap.size();
      this.maybeEmitQueue();
      try { logger.info('drift.liquidator.market_scan', { marketIndex: idx, trackedUsers: users.length, sampled: slice.length, cat: 'drift' }); } catch {}
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

  private computeExposureStats(): { exposureMarkets: number; exposureUsers: number } {
    try {
      const exposureMarkets = this.marketToUsers.size;
      const exposureUsers = this.userToMarkets.size;
      return { exposureMarkets, exposureUsers };
    } catch {
      return { exposureMarkets: 0, exposureUsers: 0 };
    }
  }

  private async seedFromDlobUserMap(): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      // Try to access DLOB/UserMap sources if exposed by SDK client
      // This avoids RPC scans by using websocket-fed order streams
      let userPks: string[] = [];
      try {
        if (typeof (drift as any)?.getUserMap === 'function') {
          const um = await (drift as any).getUserMap();
          const entries = (typeof um?.keys === 'function') ? Array.from(um.keys()) : [];
          userPks = entries.map((k: any) => String(k?.toBase58?.() || k)).filter(Boolean);
          try { logger.info('drift.liquidator.usermap_get_keys', { keys: entries.length, cat: 'drift' }); } catch {}
        } else {
          try { logger.info('drift.liquidator.usermap_get_unavailable', { cat: 'drift' }); } catch {}
        }
      } catch (e: any) {
        try { logger.warn('drift.liquidator.usermap_get_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
      }
      try {
        if (userPks.length === 0 && (drift as any)?.dlob?._userMap) {
          const um = (drift as any).dlob._userMap;
          const entries = (typeof um?.keys === 'function') ? Array.from(um.keys()) : [];
          userPks = entries.map((k: any) => String(k?.toBase58?.() || k)).filter(Boolean);
          try { logger.info('drift.liquidator.usermap_dlob_keys', { keys: entries.length, cat: 'drift' }); } catch {}
        }
      } catch (e: any) {
        try { logger.warn('drift.liquidator.usermap_dlob_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
      }
      if (Array.isArray(userPks) && userPks.length > 0) {
        const max = 1000;
        for (const pk of userPks.slice(0, max)) this.enqueueProbe(pk);
        try { logger.info('drift.liquidator.dlob_seed', { users: Math.min(userPks.length, max), cat: 'drift' }); } catch {}
      } else {
        try { logger.info('drift.liquidator.dlob_seed_skipped', { reason: 'no_keys', cat: 'drift' }); } catch {}
      }
    } catch {}
  }

  private async seedFromDlobHttp(): Promise<void> {
    try {
      // Determine markets to seed from (tracked or allowlist)
      let indices: number[] = Array.from(this.trackedMarkets);
      if (indices.length === 0) {
        try { indices = getAllowlistIndices(); } catch {}
      }
      if (indices.length === 0) indices = [0, 1, 2];
      const seen: Set<string> = new Set();
      const makers: string[] = [];
      // Lazy import helpers to avoid cycles
      const mod: any = await import('./marketdata.js');
      for (const idx of indices) {
        try {
          // Prefer topMakers (cheaper); fallback to L3 if empty
          const top = await mod.fetchDlobTopMakers(Number(idx)).catch(() => null);
          if (top && Array.isArray(top.makers) && top.makers.length > 0) {
            for (const m of top.makers) { const k = String(m.maker || ''); if (k && !seen.has(k)) { seen.add(k); makers.push(k); } }
          } else {
            const l3Keys: string[] = await mod.fetchDlobL3Makers(Number(idx)).catch(() => []);
            for (const k of l3Keys) { if (k && !seen.has(k)) { seen.add(k); makers.push(k); } }
          }
        } catch {}
      }
      if (makers.length > 0) {
        const max = Math.min(2000, makers.length);
        for (const pk of makers.slice(0, max)) this.enqueueProbe(pk);
        try { logger.info('drift.liquidator.dlob_http_seed', { users: max, markets: indices.length, cat: 'drift' }); } catch {}
      } else {
        try { logger.info('drift.liquidator.dlob_http_seed_skipped', { reason: 'no_makers', cat: 'drift' }); } catch {}
      }
    } catch (e: any) {
      try { logger.warn('drift.liquidator.dlob_http_seed_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    }
  }

  private async initDlobSources(): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      if (!drift) return;
      let sdk: any = null;
      try { sdk = await import('@drift-labs/sdk'); } catch {}
      // Initialize UserMap using SDK pattern (ws accounts + event subscriber)
      try {
        const Ctor = (sdk as any)?.UserMap || null;
        const EventSubscriberCtor = (sdk as any)?.EventSubscriber || null;
        if (Ctor && !(this as any)._dlobUserMap) {
          // Prefer SDK-style event subscriber wiring if available
          let evSub: any = this.eventSub;
          try {
            if (!evSub && EventSubscriberCtor) {
              evSub = new (EventSubscriberCtor as any)(drift.connection, drift.program);
              try { await evSub.subscribe?.(); } catch {}
            }
          } catch {}
          try {
            (this as any)._dlobUserMap = new (Ctor as any)({ connection: drift.connection, program: drift.program, eventSubscriber: evSub });
          } catch {
            try { (this as any)._dlobUserMap = new (Ctor as any)(drift.connection, drift.program); } catch {}
          }
          try {
            await ((this as any)._dlobUserMap?.subscribe?.());
            try { logger.info('drift.liquidator.usermap_subscribed', { withEventSubscriber: !!evSub, cat: 'drift' }); } catch {}
          } catch (e: any) {
            try { logger.warn('drift.liquidator.usermap_subscribe_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
          }
        }
      } catch {}
      // Initialize OrderSubscriber if constructable
      try {
        const Ctor = (sdk as any)?.OrderSubscriber || null;
        if (Ctor && !(this as any)._dlobOrderSub) {
          try { (this as any)._dlobOrderSub = new (Ctor as any)(drift.connection, drift.program); }
          catch { try { (this as any)._dlobOrderSub = new (Ctor as any)({ connection: drift.connection, program: drift.program }); } catch {} }
          try { await ((this as any)._dlobOrderSub?.subscribe?.()); } catch {}
        }
      } catch {}
      // Immediately seed from user map keys if present
      if ( (this as any)._dlobUserMap ) {
        try {
          const um = (this as any)._dlobUserMap;
          const entries = (typeof um?.keys === 'function') ? Array.from(um.keys()) : [];
          if (Array.isArray(entries) && entries.length > 0) {
            const max = Math.min(1000, entries.length);
            for (let i = 0; i < max; i += 1) {
              const k = entries[i];
              const pk = String(k?.toBase58?.() || k || '');
              if (pk) this.enqueueProbe(pk);
            }
            try { logger.info('drift.liquidator.dlob_seed', { users: Math.min(entries.length, max), cat: 'drift' }); } catch {}
          } else {
            try { logger.info('drift.liquidator.usermap_empty', { keys: 0, cat: 'drift' }); } catch {}
          }
        } catch {}
      }
      // Periodically seed from user map keys as a refresh
      if ((this as any)._dlobUserMap && !(this as any)._dlobSeedTimer) {
        (this as any)._dlobSeedTimer = (globalThis as any).setInterval(() => {
          try {
            const um = (this as any)._dlobUserMap;
            const entries = (typeof um?.keys === 'function') ? Array.from(um.keys()) : [];
            if (Array.isArray(entries)) {
              const max = Math.min(500, entries.length);
              for (let i = 0; i < max; i += 1) {
                const k = entries[i];
                const pk = String(k?.toBase58?.() || k || '');
                if (pk) this.enqueueProbe(pk);
              }
              try { logger.info('drift.liquidator.usermap_refresh', { keys: entries.length, enqueued: max, cat: 'drift' }); } catch {}
            }
          } catch {}
        }, 30000);
      }
    } catch {}
  }

  private enqueueProbe(pkStr: string): void {
    try {
      const key = String(pkStr);
      // Respect idle/out-of-scope cooldowns
      const now = Date.now();
      const idleUntil = this.idleUntil.get(key);
      if (typeof idleUntil === 'number' && now < idleUntil) return;
      const oosUntil = this.outOfScopeUntil.get(key);
      if (typeof oosUntil === 'number' && now < oosUntil) return;
      if (this.inProbeQueue.has(key)) return;
      this.pendingProbeQueue.push(key);
      this.inProbeQueue.add(key);
    } catch {}
  }

  private async processProbeQueue(): Promise<void> {
    try {
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      const drift: any = (DriftService.getInstance() as any).client;
      const cap = Math.max(1, Math.min(200, Number((this.config.maxProbesPerTick ?? ((CONFIG as any)?.drift?.liquidator?.maxProbesPerTick) ?? 40))));
      const slice = this.pendingProbeQueue.splice(0, cap);
      let probed = 0;
      let flagged = 0;
      for (const key of slice) {
        try {
          let user = this.userCache.get(key);
          if (!user) {
            let pk: any = key;
            try { if (typeof key === 'string') pk = new PublicKey(key); } catch {}
            // Use websocket subscription to avoid HTTP RPC polling that can trigger 429s
            user = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
            this.userCache.set(key, user);
          }
          // Subscribe only during probe
          try {
            if (!this.subscribedUsers.has(key) && typeof (user as any)?.subscribe === 'function') {
              await (user as any).subscribe();
              this.subscribedUsers.add(key);
            }
          } catch {}
          const exists = await (user as any).exists?.();
          if (!exists) { this.inProbeQueue.delete(key); continue; }
          // Read positions and apply filters BEFORE collateral reads to short-circuit idle/out-of-scope users
          const positions = (user as any)?.getPerpPositions?.() || [];
          let hasActive = false;
          let inScope = false;
          const allowedMarkets: Set<number> | null = Array.isArray(this.config.probeMarketIndices) && this.config.probeMarketIndices.length > 0
            ? new Set<number>((this.config.probeMarketIndices as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n)))
            : null;
          const minAbs = Number((this.config.positionMinAbsBase ?? ((CONFIG as any)?.drift?.liquidator?.positionMinAbsBase) ?? 0));
          const maxAbsCfg = this.config.positionMaxAbsBase ?? ((CONFIG as any)?.drift?.liquidator?.positionMaxAbsBase);
          const maxAbs = (maxAbsCfg === undefined || maxAbsCfg === null) ? Infinity : Number(maxAbsCfg);
          for (const p of positions) {
            try {
              const base = Math.abs(Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0));
              const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
              if (!Number.isFinite(base) || base === 0) continue;
              hasActive = true;
              const marketOk = allowedMarkets ? allowedMarkets.has(Number(m)) : true;
              const sizeOk = base >= minAbs && base <= maxAbs;
              if (marketOk && sizeOk) { inScope = true; break; }
            } catch {}
          }
          if (!hasActive) {
            const ms = Math.max(15000, Number((this.config.idleCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.idleCooldownMs) ?? 60000)));
            this.idleUntil.set(key, Date.now() + ms);
            // Unsubscribe immediately to reduce load
            try { if (this.subscribedUsers.has(key)) { await (user as any)?.unsubscribe?.(); this.subscribedUsers.delete(key); } } catch {}
            this.inProbeQueue.delete(key);
            continue;
          }
          if (!inScope) {
            const ms = Math.max(15000, Number((this.config.outOfScopeCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.outOfScopeCooldownMs) ?? 60000)));
            this.outOfScopeUntil.set(key, Date.now() + ms);
            try { if (this.subscribedUsers.has(key)) { await (user as any)?.unsubscribe?.(); this.subscribedUsers.delete(key); } } catch {}
            this.inProbeQueue.delete(key);
            continue;
          }
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          if (!isFinite(total) || !isFinite(maint)) { this.inProbeQueue.delete(key); continue; }
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          probed += 1;
          if (health < riskThresh) {
            this.addOrQueueCandidate({ userPk: key, health, updatedAt: Date.now() });
            flagged += 1;
            try { await this.refreshIndexForUser(user, key); } catch {}
          } else {
            // Not at risk: optionally unsubscribe to minimize load
            try {
              if (this.subscribedUsers.has(key) && typeof (user as any)?.unsubscribe === 'function') {
                await (user as any).unsubscribe();
                this.subscribedUsers.delete(key);
              }
            } catch {}
          }
        } catch {} finally {
          this.inProbeQueue.delete(key);
        }
      }
      try { logger.info('drift.liquidator.probe_result', { attempted: slice.length, probed, flagged, pending: this.pendingProbeQueue.length, cat: 'drift' }); } catch {}
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


