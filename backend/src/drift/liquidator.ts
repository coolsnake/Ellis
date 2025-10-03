// @ts-nocheck
import { logger } from '../utils/logger.js';
import { DriftService } from './client.js';
import { DriftPriceService } from './price.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';

export type LiquidatorConfig = {
  name: string;
  enabled: boolean;
  pollMs?: number;
  maxConcurrentTargets?: number;
  dryRun?: boolean;
};

export type LiquidatorRuntimeState = {
  running: boolean;
  config?: LiquidatorConfig;
  candidatesQueued: number;
  actionsLastMin: number;
  errorsLastMin: number;
};

type Candidate = { userPk: string; health: number; updatedAt: number };

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
  private heap: MinHeap<Candidate> = new MinHeap<Candidate>((a, b) => a.health - b.health);
  private lastQueueEmitTs = 0;
  private trackedMarkets: Set<number> = new Set();
  private marketToUsers: Map<number, Set<string>> = new Map();
  private userToMarkets: Map<string, Set<number>> = new Map();
  private inHeap: Set<string> = new Set();
  private accountLoader: any | null = null;
  private marketScanInFlight: Set<number> = new Set();

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
    try { this.initPriceTriggers(); } catch {}
    this.timer = (globalThis as any).setInterval(() => {
      this.tick().catch((e) => logger.warn('drift.liquidator.tick_error', { error: String(e?.message || e), cat: 'drift' }));
    }, pollMs);
  }

  stop(): void {
    if (this.timer) (globalThis as any).clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    logger.info('drift.liquidator.stop', { name: this.config.name, cat: 'drift' });
  }

  async tick(): Promise<void> {
    try {
      if (!this.initialized) { try { await this.initDiscovery(); this.initialized = true; } catch {} }
      const candidates = await this.findUnhealthyCandidates();
      // Rebuild the heap from current candidates
      this.heap.clear();
      this.inHeap.clear();
      for (const c of candidates) this.heap.push({ ...c, updatedAt: Date.now() });
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
      const discoverAll = (cfg.discoverAllUsers !== false); // default true
      if (discoverAll) {
        try { list = await drift?.program?.account?.user?.all?.(); } catch {}
        if (Array.isArray(list) && list.length > 0) {
          const maxDiscover = Math.max(10, Math.min(5000, Number(cfg.maxDiscoveredUsers || 500)));
          const keys = list.map((x: any) => String(x?.publicKey?.toBase58?.() || x?.publicKey || '')).filter(Boolean);
          this.userKeys = keys.slice(0, maxDiscover);
        }
      }
      // Allow explicit allowlist override
      try {
        const allow: string[] = Array.isArray(cfg.usersAllowlist) ? cfg.usersAllowlist : [];
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

  private initPriceTriggers(): void {
    try {
      const liqCfg: any = (CONFIG as any)?.drift?.liquidator || {};
      if (liqCfg.usePriceTriggers === false) return;
      const allow: string[] = ((CONFIG as any)?.drift?.marketsAllowlist || []) as any;
      const indices: number[] = [];
      for (const entry of allow) {
        const s = String(entry || '').trim();
        if (!s) continue;
        const m = s.match(/^(\d+)/);
        if (m) indices.push(Number(m[1]));
      }
      // Default to first few common markets
      if (indices.length === 0) indices.push(0, 1, 2);
      const svc = DriftPriceService.getInstance();
      const debounceMs = Math.max(600, Math.min(1500, Number(liqCfg.priceTriggerDebounceMs || ((CONFIG as any)?.websocketIntervalMs) || 800)));
      for (const idx of indices) {
        try { svc.trackMarket(idx, Math.max(800, Number(liqCfg.httpPollMs || 1200))); } catch {}
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

  private async findUnhealthyCandidates(): Promise<Array<{ userPk: string; health: number }>> {
    const out: Array<{ userPk: string; health: number }> = [];
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const sdk: any = await import('@drift-labs/sdk');
      const { User, BulkAccountLoader } = (sdk as any);
      const conn: any = (DriftService.getInstance() as any).connection;
      if (!this.accountLoader) this.accountLoader = new BulkAccountLoader(conn, 'confirmed', 1000);
      const riskThresh = Number(((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0);
      for (const pkStr of this.userKeys) {
        try {
          const user = new User({ driftClient: drift, userAccountPublicKey: pkStr, accountSubscription: { type: 'polling', accountLoader: this.accountLoader } });
          const exists = await (user as any).exists?.();
          if (!exists) continue;
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          if (!isFinite(total) || !isFinite(maint)) continue;
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          if (health < riskThresh) out.push({ userPk: pkStr, health });
          try { await this.refreshIndexForUser(user, pkStr); } catch {}
        } catch {}
      }
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
      const sdk: any = await import('@drift-labs/sdk');
      const { User, BulkAccountLoader } = (sdk as any);
      const conn: any = (DriftService.getInstance() as any).connection;
      if (!this.accountLoader) this.accountLoader = new BulkAccountLoader(conn, 'confirmed', 1000);
      // Cap per event to avoid long stalls
      const maxUsersPerTick = Math.max(10, Math.min(100, Number(((CONFIG as any)?.drift?.liquidator?.maxUsersPerPriceTick) || 40)));
      const slice = users.slice(0, maxUsersPerTick);
      const riskThresh = Number(((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0);
      for (const pkStr of slice) {
        try {
          const user = new User({ driftClient: drift, userAccountPublicKey: pkStr, accountSubscription: { type: 'polling', accountLoader: this.accountLoader } });
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
      if (this.inFlightTargets.has(key)) return;
      if (this.inHeap.has(key)) return;
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
      // Step 1: force-cancel orders (best-effort, capped)
      try {
        const maxCancels = Math.max(5, Math.min(50, Number(((CONFIG as any)?.drift?.liquidator?.maxCancels) || 20)));
        const batch = Math.min(maxCancels, 10);
        if (typeof drift?.forceCancelOrders === 'function') {
          let remaining = maxCancels;
          while (remaining > 0) {
            try { await drift.forceCancelOrders({ userPublicKey: target.userPk, marketType: 0, limit: batch }); } catch {}
            remaining -= batch;
            if (remaining > 0) { try { await new Promise(r => setTimeout(r, 250)); } catch {} }
          }
        }
      } catch (e: any) {
        this.recordError(e);
      }
      // Step 2: attempt perp liquidation (best-effort, capped)
      try {
        if (typeof drift?.liquidatePerp === 'function') {
          const maxPerp = Math.max(1, Math.min(10, Number(((CONFIG as any)?.drift?.liquidator?.maxPerpAttempts) || 3)));
          const sizeFrac = Math.max(0.001, Math.min(0.25, Number(((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) || 0.05)));
          const markets = [0, 1, 2];
          let attempts = 0;
          for (const idx of markets) {
            if (attempts >= maxPerp) break;
            try {
              await drift.liquidatePerp(target.userPk, Number(idx), sizeFrac);
              attempts += 1;
            } catch {}
          }
        }
      } catch (e: any) {
        this.recordError(e);
      }
      // Step 3: attempt spot liquidation (best-effort, capped)
      try {
        if (typeof drift?.liquidateSpot === 'function') {
          const maxSpot = Math.max(1, Math.min(10, Number(((CONFIG as any)?.drift?.liquidator?.maxSpotAttempts) || 2)));
          const sizeFrac = Math.max(0.001, Math.min(0.25, Number(((CONFIG as any)?.drift?.liquidator?.spotSizeFraction) || 0.05)));
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
      }
      this.recordAction();
      logger.info('drift.liquidator.action_complete', { user: target.userPk, cat: 'drift' });
    } catch (e: any) {
      this.recordError(e);
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
      emit('drift-liquidation', {
        type: 'queue',
        candidatesQueued: this.state.candidatesQueued,
        top: top.map(t => ({ userPk: t.userPk, health: t.health, updatedAt: t.updatedAt })),
        markets: Array.from(this.trackedMarkets),
        exposures: exposuresCounts,
        actionsLastMin: this.state.actionsLastMin,
        errorsLastMin: this.state.errorsLastMin,
      }).catch(() => {});
    } catch {}
  }

  getQueueSnapshot(limit = 20): { candidatesQueued: number; top: Array<{ userPk: string; health: number; updatedAt: number }>; markets: number[]; exposures: Array<{ marketIndex: number; users: number }>; actionsLastMin: number; errorsLastMin: number } {
    const top: Candidate[] = [];
    const arr = this.heap.toArray();
    const cap = Math.min(arr.length, Math.max(25, Number(limit) * 8));
    const small = new MinHeap<Candidate>((a, b) => a.health - b.health);
    for (let i = 0; i < cap; i += 1) small.push(arr[i]);
    const howMany = Math.max(1, Math.min(100, Number(limit)));
    for (let i = 0; i < howMany; i += 1) { const c = small.pop(); if (!c) break; top.push(c); }
    const exposuresCounts = Array.from(this.marketToUsers.entries()).map(([m, set]) => ({ marketIndex: Number(m), users: (set?.size || 0) }));
    return {
      candidatesQueued: this.state.candidatesQueued,
      top: top.map(t => ({ userPk: t.userPk, health: t.health, updatedAt: t.updatedAt })),
      markets: Array.from(this.trackedMarkets),
      exposures: exposuresCounts,
      actionsLastMin: this.state.actionsLastMin,
      errorsLastMin: this.state.errorsLastMin,
    };
  }
}

export class DriftLiquidatorRegistry {
  private static runners: Map<string, DriftLiquidator> = new Map();

  static keyOf(cfg: LiquidatorConfig): string {
    return cfg?.name ? `liq#${cfg.name}` : 'liq#default';
  }

  static upsert(cfg: LiquidatorConfig): DriftLiquidator {
    const key = this.keyOf(cfg);
    let r = this.runners.get(key);
    if (!r) {
      r = new DriftLiquidator(cfg);
      this.runners.set(key, r);
    }
    return r;
  }

  static get(key: string): DriftLiquidator | undefined {
    return this.runners.get(key);
  }

  static list(): Array<{ key: string; status: LiquidatorRuntimeState }> {
    return Array.from(this.runners.entries()).map(([key, r]) => ({ key, status: r.getStatus() }));
  }

  static async start(key: string): Promise<boolean> {
    const r = this.runners.get(key);
    if (!r) return false;
    await r.start();
    return true;
  }

  static stop(key: string): boolean {
    const r = this.runners.get(key);
    if (!r) return false;
    r.stop();
    return true;
  }
}


