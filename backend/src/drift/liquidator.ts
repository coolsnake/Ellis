// @ts-nocheck
import { logger } from '../utils/logger.js';
import { DriftService } from './client.js';
import { DriftPriceService } from './price.js';
import { fetchDlobL2 } from './marketdata.js';
import { getAllowlistIndices, indexToSymbol } from './marketMapping.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { User, EventSubscriber } from '@drift-labs/sdk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import BN from 'bn.js';

export type LiquidatorConfig = {
  name: string;
  enabled: boolean;
  pollMs?: number;
  maxConcurrentTargets?: number;
  dryRun?: boolean;
  // Account selection
  subaccountId?: number;
  // Execution gate: only attempt when healthMaint <= this (default 0)
  executeHealthThreshold?: number;
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
  // Attempt sizing caps
  maxAttemptNotional?: number; // USD cap across a target handling
};
function toPublicKey(val: any): PublicKey | null {
  try {
    if (val && typeof val === 'object' && typeof (val as any).toBase58 === 'function') return val as PublicKey;
    if (typeof val === 'string') {
      const s = val.trim();
      if (s.length > 0) {
        try { return new PublicKey(s); } catch {}
        try { const bytes = bs58.decode(s); if (bytes && bytes.length === 32) return new PublicKey(bytes); } catch {}
      }
    }
    if (val && (val as any).length === 32) {
      try { return new PublicKey(Uint8Array.from(val as any)); } catch {}
    }
  } catch {}
  return null;
}

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
  private healthyUntil: Map<string, number> = new Map();
  private eventSub: any | null = null;
  private lastDiscoveryUsedGpaV2 = false;
  private discoveryTimer: any | null = null;
  private lastDiscoverySlot: number = 0;
  private discoveredRecentUsers: Set<string> = new Set();
  private scanCursor: number = 0; // deprecated; retained for minimal impact
  private probeProcessing: boolean = false;
  private unsubscribingUsers: Set<string> = new Set();
  private liveMonitors: Map<string, any> = new Map();
  private drainRequested: boolean = false;

  private requestImmediateDrain(): void {
    try {
      if (this.drainRequested) return;
      this.drainRequested = true;
      (globalThis as any).setTimeout(() => {
        try {
          const maxConc = Math.max(1, Number(this.config.maxConcurrentTargets || 2));
          this.drainQueue(maxConc);
        } catch {} finally {
          this.drainRequested = false;
        }
      }, 0);
    } catch {}
  }
  private probeTimestamps: number[] = [];
  private currentPollMs: number = 1500;
  private atRiskUsers: Map<string, { health: number; updatedAt: number; positions?: Array<{ marketIndex: number; symbol?: string; base: number; notional?: number; liqPrice?: number; profitability?: number }>; profitability?: number; skipReason?: string; collateralUsd?: number; maintenanceUsd?: number; freeUsd?: number; exposureUsd?: number }> = new Map();
  private userLastRefresh: Map<string, number> = new Map();

  constructor(private config: LiquidatorConfig) {}

  getStatus(): LiquidatorRuntimeState {
    return { ...this.state, config: this.config };
  }

  private getProbeRps(): number {
    try { return Math.max(1, Math.min(200, Number((this.config as any).probeRps ?? ((CONFIG as any)?.drift?.liquidator?.probeRps) ?? 50))); }
    catch { return 50; }
  }

  private async acquireProbeToken(): Promise<void> {
    while (true) {
      if (this.abort) return;
      const now = Date.now();
      const cutoff = now - 1000;
      while (this.probeTimestamps.length > 0 && this.probeTimestamps[0] <= cutoff) this.probeTimestamps.shift();
      const cap = this.getProbeRps();
      if (this.probeTimestamps.length < cap) { this.probeTimestamps.push(now); return; }
      const waitMs = Math.max(5, (this.probeTimestamps[0] + 1000) - now);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.abort = false;
    this.state.running = true;
    const pollMs = Math.max(500, Number(this.config.pollMs || 1500));
    this.currentPollMs = pollMs;
    const cid = `liq-${this.config.name}-${Date.now().toString(36).slice(-5)}`;
    logger.info('drift.liquidator.start', { name: this.config.name, pollMs, dryRun: !!this.config.dryRun, cat: 'drift', code: 'DRIFT.LIQ.START', cid, span: 'start' });
    // Ensure Drift client is initialized
    try {
      await DriftService.getInstance().init();
    } catch {}
    // Ensure configured subaccount is active for liquidation actions
    try {
      const subId = Number((this.config as any)?.subaccountId ?? ((CONFIG as any)?.drift?.liquidator?.subaccountId) ?? ((CONFIG as any)?.drift?.defaultSubaccountId));
      if (Number.isFinite(subId)) {
        const svc = DriftService.getInstance();
        await svc.switchSubaccount(Number(subId));
        try { logger.info('drift.liquidator.subaccount_selected', { name: this.config.name, subaccountId: Number(subId), cat: 'drift' }); } catch {}
      }
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
    // Optional: bootstrap enumerate all Drift user accounts via Helius GPA
    try {
      const liqCfg: any = (CONFIG as any)?.drift?.liquidator || {};
      const doEnum = (this.config as any)?.enumerateAllOnStart ?? liqCfg.enumerateAllOnStart;
      if (doEnum) {
        const max = Math.max(1000, Number((this.config as any)?.enumerateMax ?? liqCfg.enumerateMax ?? 200000));
        try { logger.info('drift.liquidator.enumerate_helius_start', { max, cat: 'drift' }); } catch {}
        const list = await this.discoverUsersViaHeliusGpaV2(max);
        if (Array.isArray(list) && list.length > 0) {
          const set = new Set<string>(this.userKeys);
          const chunk = Math.max(100, Number((this.config as any)?.enumerateEnqueueChunk ?? liqCfg.enumerateEnqueueChunk ?? 1000));
          const delayMs = Math.max(0, Number((this.config as any)?.enumerateEnqueueDelayMs ?? liqCfg.enumerateEnqueueDelayMs ?? 200));
          let enqueued = 0;
          for (let i = 0; i < list.length; i += chunk) {
            const slice = list.slice(i, i + chunk);
            for (const pk of slice) { this.enqueueProbe(pk); set.add(String(pk)); }
            this.userKeys = Array.from(set);
            enqueued += slice.length;
            if (enqueued % 20000 === 0 || enqueued === list.length) {
              try { logger.info('drift.liquidator.enumerate_helius_progress', { enqueued, total: list.length, cat: 'drift' }); } catch {}
            }
            if (delayMs > 0) { try { await new Promise(r => setTimeout(r, delayMs)); } catch {} }
          }
          try { logger.info('drift.liquidator.enumerate_helius_complete', { total: list.length, cat: 'drift' }); } catch {}
        } else {
          try { logger.info('drift.liquidator.enumerate_helius_empty', { cat: 'drift' }); } catch {}
        }
      }
    } catch (e: any) {
      try { logger.warn('drift.liquidator.enumerate_helius_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    }
    try { await this.initPriceTriggers(); } catch {}
    const guardedTick = async () => {
      if (this.abort || (this as any)._inTick) return;
      (this as any)._inTick = true;
      try { await this.tick(); }
      catch (e: any) { logger.warn('drift.liquidator.tick_error', { error: String(e?.message || e), cat: 'drift', code: 'DRIFT.LIQ.TICK_ERROR' }); }
      finally { (this as any)._inTick = false; }
    };
    this.timer = (globalThis as any).setInterval(() => { guardedTick().catch(() => {}); }, pollMs);
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

    // Discovery scheduling based on flags
    try {
      const liqCfg: any = (CONFIG as any)?.drift?.liquidator || {};
      const wsOnly = (this.config.wsOnlyDiscovery === true) || (this.config.wsOnlyDiscovery === undefined && liqCfg.wsOnlyDiscovery === true);
      const limitedHttp = (this.config.limitedHttpDiscovery === true) || (this.config.limitedHttpDiscovery === undefined && liqCfg.limitedHttpDiscovery === true);
      if (wsOnly) {
        if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} }
        this.discoveryTimer = null;
        try { logger.info('drift.liquidator.discovery_http_disabled', { cat: 'drift' }); } catch {}
      } else if (limitedHttp) {
        const every = Math.max(15000, Number((this.config as any).discoveryIntervalMs ?? liqCfg.discoveryIntervalMs ?? 30000));
        if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} }
        this.discoveryTimer = (globalThis as any).setInterval(() => {
          this.tryRecentDiscovery().catch(() => {});
        }, every);
        try { logger.info('drift.liquidator.discovery_http_limited', { intervalMs: every, cat: 'drift' }); } catch {}
      }
    } catch {}
  }

  stop(): void {
    this.abort = true;
    if (this.timer) (globalThis as any).clearInterval(this.timer);
    this.timer = null;
    if (this.statsTimer) { try { (globalThis as any).clearInterval(this.statsTimer); } catch {} this.statsTimer = null; }
    if (this.discoveryTimer) { try { (globalThis as any).clearInterval(this.discoveryTimer); } catch {} this.discoveryTimer = null; }
    // Do not unsubscribe shared event subscriber owned by DriftService
    try { this.eventSub = null; } catch {}
    // Cleanup DLOB helpers and periodic seed timer
    try {
      const seed = (this as any)._dlobSeedTimer;
      if (seed) { try { (globalThis as any).clearInterval(seed); } catch {} }
      try { delete (this as any)._dlobSeedTimer; } catch {}
    } catch {}
    try {
      const um = (this as any)._dlobUserMap;
      if (um && typeof um.unsubscribe === 'function') {
        try {
          const race = Promise.race([
            Promise.resolve().then(() => um.unsubscribe?.()).catch(() => {}),
            new Promise<void>((resolve) => { try { (globalThis as any).setTimeout(resolve, 2000); } catch { resolve(); } }),
          ]);
          (race as any)?.catch?.(() => {});
        } catch {}
      }
      try { delete (this as any)._dlobUserMap; } catch {}
    } catch {}
    try {
      const os = (this as any)._dlobOrderSub;
      if (os && typeof os.unsubscribe === 'function') {
        try {
          const race2 = Promise.race([
            Promise.resolve().then(() => os.unsubscribe?.()).catch(() => {}),
            new Promise<void>((resolve) => { try { (globalThis as any).setTimeout(resolve, 2000); } catch { resolve(); } }),
          ]);
          (race2 as any)?.catch?.(() => {});
        } catch {}
      }
      try { delete (this as any)._dlobOrderSub; } catch {}
    } catch {}
    this.state.running = false;
    logger.info('drift.liquidator.stop', { name: this.config.name, cat: 'drift', code: 'DRIFT.LIQ.STOP', span: 'end' });
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
    // Unsubscribe all User websocket subscriptions (skip when WS not ready)
    try {
      const drift: any = (DriftService.getInstance() as any).client;
      const ws: any = drift?.connection?._rpcWebSocket?._ws;
      const rs: number = Number(ws?.readyState);
      const canRpc = (rs === 0 || rs === 1);
      for (const key of Array.from(this.subscribedUsers)) {
        try {
          if (!canRpc) continue;
          const u = this.userCache.get(String(key));
          const p = (async () => { try { await (u as any)?.unsubscribe?.(); } catch {} })();
          (p as any)?.catch?.(() => {});
        } catch {}
      }
      this.subscribedUsers.clear();
    } catch {}
    // Clear internal state to avoid leaks
    try { this.heap.clear(); } catch {}
    try { this.inHeap.clear(); } catch {}
    try { this.inFlightTargets.clear(); } catch {}
    try { this.marketScanInFlight.clear(); } catch {}
    try { this.userToMarkets.clear(); this.marketToUsers.clear(); } catch {}
    try { this.pendingProbeQueue = []; this.inProbeQueue.clear(); } catch {}
    try { this.userCache.clear(); } catch {}
    this.initialized = false;
  }

  async tick(): Promise<void> {
    try {
      if (!this.initialized) { try { await this.initDiscovery(); this.initialized = true; } catch {} }
      const candidates = await this.findUnhealthyCandidates();
      try { await this.processProbeQueue(); } catch {}
      // Opportunistically refresh a small set of stale at-risk users to keep UI metrics fresh
      try {
        const now = Date.now();
        let refreshed = 0;
        for (const [key, v] of Array.from(this.atRiskUsers.entries())) {
          if (refreshed >= 25) break;
          if (!v || typeof v.updatedAt !== 'number') continue;
          if ((now - v.updatedAt) > Math.max(5000, Number(((this.config as any)?.refreshAccountsMs ?? ((CONFIG as any)?.drift?.liquidator?.refreshAccountsMs) ?? 15000)))) {
            this.enqueueProbe(String(key));
            refreshed += 1;
          }
        }
      } catch {}
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
      const driftSvc = DriftService.getInstance();
      const drift: any = (driftSvc as any).client;
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
      // Resolve markets to track: prefer explicit probeMarketIndices, then trackedMarketIndices, then marketIndices
      let indices: number[] = [];
      try {
        const a = (this.config as any)?.probeMarketIndices;
        if (Array.isArray(a) && a.length > 0) {
          indices = (a as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n));
        }
      } catch {}
      try {
        if (indices.length === 0) {
          const b = (this.config as any)?.trackedMarketIndices;
          if (Array.isArray(b) && b.length > 0) indices = (b as any[]).map((n: any) => Number(n)).filter((n) => Number.isFinite(n));
        }
      } catch {}
      try {
        if (indices.length === 0 && Array.isArray(this.config.marketIndices) && this.config.marketIndices.length > 0) {
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
        try { logger.info('drift.liquidator.track_market_add', { marketIndex: Number(idx), tracked: this.trackedMarkets.size, cat: 'drift' }); } catch {}
        const onPrice = () => {
          // One-shot throttle: if a timer exists, let it run; else schedule
          if (this.priceTriggerTimers.has(idx)) return;
          const t: any = (globalThis as any).setTimeout(() => {
            try {
              this.partialUpdateForMarket(Number(idx))
                .then(() => {
                  this.state.candidatesQueued = this.heap.size();
                  this.drainQueue(Math.max(1, Number(this.config.maxConcurrentTargets || 2)));
                })
                .catch(() => {});
            } finally {
              try { this.priceTriggerTimers.delete(idx); } catch {}
            }
          }, debounceMs);
          this.priceTriggerTimers.set(idx, t);
        };
        (this as any)[`_onPrice_liq_${idx}`] = onPrice;
        try { svc.onPrice(idx, onPrice as any); } catch {}
      }
    } catch {}
  }

  private ensurePriceTriggerForMarket(marketIndex: number): void {
    try {
      const liqCfg: any = (CONFIG as any)?.drift?.liquidator || {};
      if (this.config.usePriceTriggers === false || (this.config.usePriceTriggers === undefined && liqCfg.usePriceTriggers === false)) return;
      const idx = Number(marketIndex);
      if (!Number.isFinite(idx)) return;
      // If already registered, ensure tracking and return
      const existingHandler = (this as any)[`_onPrice_liq_${idx}`];
      if (existingHandler) {
        try {
          const svc = DriftPriceService.getInstance();
          const pollMs = Math.max(800, Number((this.config.httpPollMs ?? liqCfg.httpPollMs ?? 1200)));
          svc.trackMarket(idx, pollMs);
        } catch {}
        this.trackedMarkets.add(idx);
        return;
      }
      const svc = DriftPriceService.getInstance();
      const pollMs = Math.max(800, Number((this.config.httpPollMs ?? liqCfg.httpPollMs ?? 1200)));
      try { svc.trackMarket(idx, pollMs); } catch {}
      const debounceMs = Math.max(600, Math.min(5000, Number((this.config.priceTriggerDebounceMs ?? liqCfg.priceTriggerDebounceMs ?? ((CONFIG as any)?.websocketIntervalMs) ?? 800))));
      const onPrice = () => {
        if (this.priceTriggerTimers.has(idx)) return;
        const t: any = (globalThis as any).setTimeout(() => {
          try {
            this.partialUpdateForMarket(Number(idx))
              .then(() => {
                this.state.candidatesQueued = this.heap.size();
                this.drainQueue(Math.max(1, Number(this.config.maxConcurrentTargets || 2)));
              })
              .catch(() => {});
          } finally {
            try { this.priceTriggerTimers.delete(idx); } catch {}
          }
        }, debounceMs);
        this.priceTriggerTimers.set(idx, t);
      };
      (this as any)[`_onPrice_liq_${idx}`] = onPrice;
      try { svc.onPrice(idx, onPrice as any); } catch {}
      this.trackedMarkets.add(idx);
    } catch {}
  }

  private async initEventSubscriptions(): Promise<void> {
    try {
      if (this.config?.useEventSubscriptions === false) return;
      const infra = await DriftService.getInstance().getSharedInfra({ includeIdle: true });
      const sub = (infra as any).eventSubscriber;
      if (!sub) return;
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
      const recoveryBuf = Number(((this.config as any).recoveryBuffer ?? ((CONFIG as any)?.drift?.liquidator?.recoveryBuffer) ?? 0.05));
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
        logger.debug('drift.liquidator.scan_summary', {
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
      // Allowed markets gate: only index markets we target (probeMarketIndices > trackedMarketIndices > marketIndices > allowlist)
      let allowed: Set<number> | null = null;
      try {
        const pref = (this.config as any)?.probeMarketIndices;
        const tracked = (this.config as any)?.trackedMarketIndices;
        if (Array.isArray(pref) && pref.length > 0) allowed = new Set<number>((pref as any[]).map((n: any) => Number(n)).filter(Number.isFinite));
        else if (Array.isArray(tracked) && tracked.length > 0) allowed = new Set<number>((tracked as any[]).map((n: any) => Number(n)).filter(Number.isFinite));
        else if (Array.isArray(this.config.marketIndices) && this.config.marketIndices.length > 0) allowed = new Set<number>((this.config.marketIndices as any[]).map((n: any) => Number(n)).filter(Number.isFinite));
        else allowed = new Set<number>(getAllowlistIndices());
      } catch {}
      for (const p of positions) {
        try {
          const base = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
          const idx = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
          if (Number.isFinite(idx) && Math.abs(base) > 0 && (!allowed || allowed.has(Number(idx)))) active.push(Number(idx));
        } catch {}
      }
      // Optionally include spot exposure (non-zero deposits or borrows) so users are indexed for price-trigger scans
      try {
        const cfgAny: any = (CONFIG as any)?.drift?.liquidator || {};
        const includeSpot = ((this.config as any)?.indexSpotExposure !== undefined) ? !!(this.config as any).indexSpotExposure : !!cfgAny.indexSpotExposure;
        if (includeSpot) {
          const ua = (sdkUser as any)?.getUserAccount?.();
          const spot = (ua && Array.isArray((ua as any).spotPositions)) ? (ua as any).spotPositions : [];
          for (const sp of spot) {
            try {
              const raw = Number(sp?.scaledBalance?.toString?.() || sp?.scaledBalance || sp?.cumulativeDeposits || 0);
              const idx = Number(sp?.marketIndex ?? sp?.market_index ?? sp?.market?.index);
              if (Number.isFinite(idx) && Number.isFinite(raw) && raw !== 0 && (!allowed || allowed.has(Number(idx)))) active.push(Number(idx));
            } catch {}
          }
        }
      } catch {}
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
      // Dynamically ensure price triggers for newly active markets
      try {
        for (const m of Array.from(prev)) {
          try { this.ensurePriceTriggerForMarket(Number(m)); } catch {}
        }
      } catch {}
    } catch {}
  }

  private async partialUpdateForMarket(marketIndex: number): Promise<void> {
    try {
      const idx = Number(marketIndex);
      if (!Number.isFinite(idx)) return;
      if (this.marketScanInFlight.has(idx)) return;
      this.marketScanInFlight.add(idx);
      // Ensure price tracking is active for this market
      try {
        const svc = DriftPriceService.getInstance();
        const pollMs = Math.max(800, Number((this.config.httpPollMs ?? ((CONFIG as any)?.drift?.liquidator?.httpPollMs ?? 1200))));
        svc.trackMarket(idx, pollMs);
      } catch {}
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

      // Always include currently at-risk users for this market on every price tick
      try {
        if (this.atRiskUsers.size > 0) {
          const setExisting = new Set<string>(slice.map((s) => String(s)));
          for (const u of users) {
            if (this.atRiskUsers.has(String(u)) && !setExisting.has(String(u))) {
              slice.push(String(u));
              setExisting.add(String(u));
            }
          }
        }
      } catch {}

      // Recompute health/exposure/profitability for slice using WS-cached user state and current prices
      let recomputed = 0;
      for (const key of slice) {
        try {
          let user = this.userCache.get(String(key));
          if (!user) {
            // Instantiate and subscribe on-demand (WS only)
            let pk: any = key;
            try { if (typeof key === 'string') pk = new PublicKey(key); } catch {}
            user = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
            this.userCache.set(String(key), user);
            try { await (user as any)?.subscribe?.(); this.subscribedUsers.add(String(key)); } catch {}
          }
          // Occasional truth refresh
          try {
            const last = this.userLastRefresh.get(String(key)) || 0;
            if ((Date.now() - last) > Math.max(10000, Number((this.config as any)?.refreshAccountsMs ?? ((CONFIG as any)?.drift?.liquidator?.refreshAccountsMs) ?? 20000))) {
              try { await (user as any)?.fetchAccounts?.(); } catch {}
              this.userLastRefresh.set(String(key), Date.now());
            }
          } catch {}

          // Collateral/maintenance (quote precision)
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          // Quote precision to UI
          let QUOTE_PREC = 1_000_000;
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const cst: any = (sdk as any).constants || (sdk as any);
            if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION);
          } catch {}
          const totalUi = total / QUOTE_PREC;
          const maintUi = maint / QUOTE_PREC;
          let freeUi = 0;
          try { freeUi = Number((user as any)?.getFreeCollateral?.()?.toString?.() || (user as any)?.getFreeCollateral?.() || 0) / QUOTE_PREC; } catch {}

          // Positions and pricing
          let BASE_PREC = 1_000_000_000;
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const cst: any = (sdk as any).constants || (sdk as any);
            if (Number.isFinite(Number(cst?.BASE_PRECISION))) BASE_PREC = Number(cst.BASE_PRECISION);
          } catch {}
          let positions = (user as any)?.getPerpPositions?.() || [];
          try { if (!Array.isArray(positions) || positions.length === 0) { const raw = (user as any)?.getUserAccount?.()?.perpPositions; if (Array.isArray(raw)) positions = raw; } } catch {}
          const posSummary: Array<{ marketIndex: number; symbol?: string; base: number; notional?: number; liqPrice?: number; profitability?: number }> = [];
          for (const p of positions) {
            try {
              const raw = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
              const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
              if (!Number.isFinite(m) || raw === 0) continue;
              // Prefer market-specific base precision when available
              let basePrecForMarket = BASE_PREC;
              try {
                const acct = await (DriftService.getInstance() as any)?.client?.getPerpMarketAccount?.(Number(m));
                const maybe = Number(acct?.amm?.basePrecision ?? acct?.basePrecision);
                if (Number.isFinite(maybe) && maybe > 0) basePrecForMarket = maybe;
              } catch {}
              const baseUi = raw / basePrecForMarket;
              const symbol = (indexToSymbol(Number(m)) || '').split('-')[0] || undefined;
              // Price sample for this market
              try {
                const svc = DriftPriceService.getInstance();
                const pollMs = Math.max(800, Number((this.config.httpPollMs ?? ((CONFIG as any)?.drift?.liquidator?.httpPollMs ?? 1200))));
                // Ensure we are tracking price for any market we observe in positions
                try { svc.trackMarket(Number(m), pollMs); } catch {}
              } catch {}
              const priceSample = DriftPriceService.getInstance().getPrice(Number(m));
              let cur = (priceSample?.mid ?? priceSample?.oracle ?? priceSample?.bid ?? priceSample?.ask);
              if (!(typeof cur === 'number' && isFinite(cur))) {
                try {
                  const l2 = await fetchDlobL2(Number(m));
                  if (l2) {
                    const mid = (typeof l2.bid?.[0]?.price === 'number' && typeof l2.ask?.[0]?.price === 'number')
                      ? (l2.bid[0].price + l2.ask[0].price) / 2
                      : undefined;
                    cur = (typeof mid === 'number') ? mid : (typeof l2.oracle === 'number' ? l2.oracle : cur);
                  }
                } catch {}
              }
              let notional: number | undefined = undefined;
              let liqPrice: number | undefined = undefined;
              let profitability: number | undefined = undefined;
              if (typeof cur === 'number' && isFinite(cur)) {
                notional = Math.abs(baseUi) * cur;
                const dist = this.computeDistanceToLiquidation(String(key), Number(m));
                if (typeof dist === 'number' && isFinite(dist)) {
                  const sgn = Math.sign(baseUi) || 1;
                  liqPrice = cur * (1 - sgn * dist);
                }
                const feeCfg: any = (CONFIG as any)?.drift?.liquidator?.feeAssumptions || {};
                const liqFeeRate = Math.max(0, Number(feeCfg.liqFeeRate ?? 0.01));
                const takerFeeRate = Math.max(0, Number(feeCfg.takerFeeRate ?? 0.0004));
                const slippageBp = Math.max(0, Number(feeCfg.slippageBp ?? 30));
                const oracleHaircutBp = Math.max(0, Number(feeCfg.oracleHaircutBp ?? 10));
                const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
                const slippageRate = slippageBp / 10_000;
                const oracleHaircutRate = oracleHaircutBp / 10_000;
                const attemptNotional = (notional || 0) * sizeFraction;
                const bonus = attemptNotional * liqFeeRate;
                const expectedFees = attemptNotional * (takerFeeRate + slippageRate + oracleHaircutRate);
                profitability = attemptNotional > 0 ? (bonus - expectedFees) / attemptNotional : undefined;
              }
              posSummary.push({ marketIndex: m, symbol, base: baseUi, notional, liqPrice, profitability });
            } catch {}
          }
          const exposureUsd = posSummary.reduce((s, p) => s + (typeof p.notional === 'number' ? Math.abs(p.notional) : 0), 0);
          // Gate reason precompute
          const minProfitability = Math.max(Number((this.config as any)?.minProfitability ?? ((CONFIG as any)?.drift?.liquidator?.minProfitability) ?? -Infinity), -Infinity);
          const minNotional = Math.max(0, Number((this.config as any)?.minNotional ?? ((CONFIG as any)?.drift?.liquidator?.minNotional) ?? 0));
          const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
          let userProfit: number | undefined = undefined;
          for (const ps of posSummary) {
            if (typeof ps.profitability === 'number') userProfit = (typeof userProfit === 'number') ? Math.min(userProfit, ps.profitability) : ps.profitability;
          }
          let skipReason: string | undefined = undefined;
          const anyLargeEnough = posSummary.some((ps) => typeof ps.notional === 'number' && (ps.notional as number) * sizeFraction >= minNotional);
          if (!anyLargeEnough) skipReason = 'SIZE_TOO_SMALL';
          if (skipReason === undefined && Number.isFinite(minProfitability) && typeof userProfit === 'number' && userProfit < minProfitability) skipReason = 'UNPROFITABLE';
          if (skipReason === undefined && total <= 0) skipReason = 'NO_COLLATERAL';

          // Update at-risk entry
          const summary = {
            health,
            updatedAt: Date.now(),
            positions: posSummary,
            profitability: userProfit,
            skipReason,
            collateralUsd: totalUi,
            maintenanceUsd: maintUi,
            freeUsd: freeUi,
            exposureUsd,
          } as any;
          this.atRiskUsers.set(String(key), summary);
          try { const { emitUserSummary } = await import('../server/realtime.js'); emitUserSummary({ userPk: String(key), ...summary }); } catch {}
          this.startLiveMonitor(String(key));
          // If still at-risk, queue candidate and drain immediately
          if (health < riskThresh) { this.addOrQueueCandidate({ userPk: String(key), health, updatedAt: Date.now() }); this.requestImmediateDrain(); }
          recomputed += 1;
        } catch {}
      }
      this.state.candidatesQueued = this.heap.size();
      this.maybeEmitQueue();
      try { logger.info('drift.liquidator.market_recompute', { marketIndex: idx, trackedUsers: users.length, recomputed, cat: 'drift' }); } catch {}
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
      this.requestImmediateDrain();
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
      // Received a test/queue attempt request
      try { logger.info('drift.liquidator.attempt_received', { user: target.userPk, health: target.health, name: this.config?.name, cat: 'drift' }); } catch {}
      const dry = !!this.config.dryRun;
      if (dry) {
        this.recordAction();
        logger.info('drift.liquidator.dryrun_target', { user: target.userPk, health: target.health, cat: 'drift' });
        return;
      }
      // Defer profitability/size gates until after we log a full snapshot below
      // Best-effort: ensure configured subaccount is active before taking actions
      try {
        const subId = Number((this.config as any)?.subaccountId ?? ((CONFIG as any)?.drift?.liquidator?.subaccountId) ?? ((CONFIG as any)?.drift?.defaultSubaccountId));
        if (Number.isFinite(subId)) {
          await (DriftService.getInstance() as any).switchSubaccount(Number(subId));
          try { logger.info('drift.liquidator.ensure_subaccount', { user: target.userPk, subaccountId: Number(subId), cat: 'drift' }); } catch {}
        }
      } catch {}
      const drift: any = (DriftService.getInstance() as any).client;
      // Parse user public key for SDK calls in this attempt scope
      let userPublicKey: PublicKey | null = toPublicKey(target.userPk);
      if (!userPublicKey) {
        try { logger.warn('drift.liquidator.skip_target', { user: target.userPk, reason: 'INVALID_PUBKEY', cat: 'drift' }); } catch {}
        return;
      }
      try { logger.debug('drift.liquidator.pubkey_ok', { user: target.userPk, pubkey: (userPublicKey as any)?.toBase58?.() || null, cat: 'drift' }); } catch {}
      // Precheck: compute current user health and skip if above execution gate
      try {
        const execGate = Number((this.config.executeHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.executeHealthThreshold) ?? 0));
        let healthNow: number | null = null;
        let user = this.userCache.get(String(target.userPk));
        if (!user) {
          let pk: any = target.userPk;
          try { pk = new PublicKey(String(target.userPk)); } catch {}
          user = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
          this.userCache.set(String(target.userPk), user);
          try { await (user as any)?.subscribe?.(); this.subscribedUsers.add(String(target.userPk)); } catch {}
        }
        try { await (user as any)?.fetchAccounts?.(); } catch {}
        try {
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          if (isFinite(total) && isFinite(maint) && maint > 0) healthNow = (total - maint) / maint;
        } catch {}
        if (typeof healthNow === 'number' && isFinite(healthNow) && healthNow > execGate) {
          try { logger.info('drift.liquidator.skip_target', { user: target.userPk, reason: 'HEALTHY_EXEC_GATE', healthNow, execGate, cat: 'drift' }); } catch {}
          return;
        }
        // Passed execution gate; mark formal start with the latest health
        try { logger.info('drift.liquidator.attempt_start', { user: target.userPk, health: healthNow, execGate, name: this.config?.name, cat: 'drift' }); } catch {}
      } catch {}
      // Compute remaining notional cap (USD) if configured
      let remainingNotional = Infinity;
      try {
        const assume: any = (CONFIG as any)?.drift?.liquidator || {};
        const maxAttemptNotional = (this.config as any)?.maxAttemptNotional ?? assume.maxAttemptNotional;
        if (Number.isFinite(Number(maxAttemptNotional)) && Number(maxAttemptNotional) > 0) {
          remainingNotional = Number(maxAttemptNotional);
        }
        try { logger.info('drift.liquidator.cap_state', { user: target.userPk, maxAttemptNotional: Number.isFinite(remainingNotional) && remainingNotional !== Infinity ? remainingNotional : null, cat: 'drift' }); } catch {}
      } catch {}
      // Build notional/base lookups by market for this user (perp positions only)
      const userSummary = this.atRiskUsers.get(String(target.userPk));
      const posNotionalByMarket: Map<number, number> = new Map();
      const posBaseRawByMarket: Map<number, number> = new Map();
      try {
        for (const ps of (userSummary?.positions || [])) {
          const idx = Number(ps?.marketIndex);
          const n = Math.abs(Number(ps?.notional || 0));
          if (Number.isFinite(idx) && Number.isFinite(n) && n > 0) posNotionalByMarket.set(idx, n);
        }
      } catch {}
      // Build snapshot of raw information for logging and decisioning
      try {
        let sdkUser = this.userCache.get(String(target.userPk));
        if (!sdkUser) {
          let pk: any = target.userPk;
          try { pk = new PublicKey(String(target.userPk)); } catch {}
          sdkUser = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
          this.userCache.set(String(target.userPk), sdkUser);
          try { await (sdkUser as any)?.subscribe?.(); this.subscribedUsers.add(String(target.userPk)); } catch {}
        }
        try { await (sdkUser as any)?.fetchAccounts?.(); } catch {}
        // Early bankruptcy handling: skip normal liquidation and optionally resolve
        try {
          const bankrupt = await this.isUserBankrupt(sdkUser);
          if (bankrupt) {
            try { logger.info('drift.liquidator.skip_target', { user: target.userPk, reason: 'BANKRUPT', cat: 'drift' }); } catch {}
            try {
              const resolvePerp = (DriftService.getInstance() as any)?.client?.resolvePerpBankruptcy;
              if (typeof resolvePerp === 'function') {
                let BASE_PREC = 1_000_000_000;
                try { const sdk: any = await import('@drift-labs/sdk'); const cst: any = (sdk as any).constants || (sdk as any); if (Number.isFinite(Number(cst?.BASE_PRECISION))) BASE_PREC = Number(cst.BASE_PRECISION); } catch {}
                const positions = (sdkUser as any)?.getPerpPositions?.() || [];
                for (const p of (positions || [])) {
                  try {
                    const rawBase = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
                    const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
                    if (!Number.isFinite(m) || rawBase === 0) continue;
                    await resolvePerp(userPublicKey, m);
                    try { logger.info('drift.liquidator.bankruptcy_perp_resolve_ok', { user: target.userPk, marketIndex: m, cat: 'drift' }); } catch {}
                  } catch (e: any) {
                    try { logger.warn('drift.liquidator.bankruptcy_perp_resolve_failed', { user: target.userPk, error: String(e?.message || e), cat: 'drift' }); } catch {}
                  }
                }
              }
            } catch {}
            this.recordAction();
            return;
          }
        } catch {}
        // Collateral values (native + UI)
        let QUOTE_PREC = 1_000_000;
        try { const sdk: any = await import('@drift-labs/sdk'); const cst: any = (sdk as any).constants || (sdk as any); if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION); } catch {}
        const total = Number((sdkUser as any)?.getTotalCollateral?.() || 0);
        const maint = Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0);
        const free = Number((sdkUser as any)?.getFreeCollateral?.()?.toString?.() || (sdkUser as any)?.getFreeCollateral?.() || 0);
        const totalUi = total / QUOTE_PREC;
        const maintUi = maint / QUOTE_PREC;
        const freeUi = free / QUOTE_PREC;
        // Positions summary with pricing (mid/oracle fallback via DLOB)
        let BASE_PREC = 1_000_000_000;
        try { const sdk: any = await import('@drift-labs/sdk'); const cst: any = (sdk as any).constants || (sdk as any); if (Number.isFinite(Number(cst?.BASE_PRECISION))) BASE_PREC = Number(cst.BASE_PRECISION); } catch {}
        let positions = (sdkUser as any)?.getPerpPositions?.() || [];
        try { if (!Array.isArray(positions) || positions.length === 0) { const raw = (sdkUser as any)?.getUserAccount?.()?.perpPositions; if (Array.isArray(raw)) positions = raw; } } catch {}
        const posSummary: Array<{ marketIndex: number; symbol?: string; base: number; price?: number; notional?: number; liqPrice?: number; profitability?: number } & { baseRaw?: number }> = [];
        for (const p of (positions || [])) {
          try {
            const rawBase = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
            const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
            if (!Number.isFinite(m) || rawBase === 0) continue;
            let basePrecForMarket = BASE_PREC;
            try {
              const acc = await (DriftService.getInstance() as any)?.client?.getPerpMarketAccount?.(Number(m));
              const maybe = Number(acc?.amm?.basePrecision ?? acc?.basePrecision);
              if (Number.isFinite(maybe) && maybe > 0) basePrecForMarket = maybe;
            } catch {}
            const baseUi = rawBase / basePrecForMarket;
            const symbol = (indexToSymbol(Number(m)) || '').split('-')[0] || undefined;
            let priceSample = DriftPriceService.getInstance().getPrice(Number(m));
            let cur = (priceSample?.mid ?? priceSample?.oracle ?? priceSample?.bid ?? priceSample?.ask);
            if (!(typeof cur === 'number' && isFinite(cur))) {
              try { const l2 = await fetchDlobL2(Number(m)); if (l2) { const mid = (typeof l2.bid?.[0]?.price === 'number' && typeof l2.ask?.[0]?.price === 'number') ? (l2.bid[0].price + l2.ask[0].price) / 2 : undefined; cur = (typeof mid === 'number') ? mid : (typeof l2.oracle === 'number' ? l2.oracle : cur); } } catch {}
            }
            let notional: number | undefined = undefined;
            let liqPrice: number | undefined = undefined;
            let profitability: number | undefined = undefined;
            if (typeof cur === 'number' && isFinite(cur)) {
              notional = Math.abs(baseUi) * cur;
              const dist = this.computeDistanceToLiquidation(String(target.userPk), Number(m));
              if (typeof dist === 'number' && isFinite(dist)) {
                const sgn = Math.sign(baseUi) || 1;
                liqPrice = cur * (1 - sgn * dist);
              }
              const feeCfg: any = (CONFIG as any)?.drift?.liquidator?.feeAssumptions || {};
              const liqFeeRate = Math.max(0, Number(feeCfg.liqFeeRate ?? 0.01));
              const takerFeeRate = Math.max(0, Number(feeCfg.takerFeeRate ?? 0.0004));
              const slippageBp = Math.max(0, Number(feeCfg.slippageBp ?? 30));
              const oracleHaircutBp = Math.max(0, Number(feeCfg.oracleHaircutBp ?? 10));
              const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
              const slippageRate = slippageBp / 10_000;
              const oracleHaircutRate = oracleHaircutBp / 10_000;
              const attemptNotional = (notional || 0) * sizeFraction;
              const bonus = attemptNotional * liqFeeRate;
              const expectedFees = attemptNotional * (takerFeeRate + slippageRate + oracleHaircutRate);
              profitability = attemptNotional > 0 ? (bonus - expectedFees) / attemptNotional : undefined;
            }
            posSummary.push({ marketIndex: m, symbol, base: baseUi, baseRaw: rawBase, price: typeof cur === 'number' ? cur : undefined, notional, liqPrice, profitability });
            try { posBaseRawByMarket.set(Number(m), Math.abs(Number(rawBase))); } catch {}
          } catch {}
        }
        // Recompute notional by market from fresh posSummary to avoid stale cache
        try {
          posNotionalByMarket.clear();
          for (const ps of posSummary) {
            const idx = Number(ps?.marketIndex);
            const n = Math.abs(Number(ps?.notional || 0));
            if (Number.isFinite(idx) && Number.isFinite(n) && n > 0) posNotionalByMarket.set(idx, n);
          }
        } catch {}
        const exposureUsd = posSummary.reduce((s, p) => s + (typeof p.notional === 'number' ? Math.abs(p.notional) : 0), 0);
        // Spot collateral snapshot (amounts + UI conversion)
        let spotCollateral: Array<{ marketIndex: number; symbol?: string; amountUi: number; amountRaw: number; mint?: string }> = [];
        try {
          const spots = (sdkUser as any)?.getSpotPositions?.() || [];
          for (const sp of (spots || [])) {
            try {
              const idx = Number(sp?.marketIndex ?? sp?.market_index ?? sp?.market?.index);
              if (!Number.isFinite(idx)) continue;
              const mktAcc = await (DriftService.getInstance() as any)?.client?.getSpotMarketAccount?.(idx);
              const decimals = Number(mktAcc?.decimals ?? 6);
              const mint = String(mktAcc?.mint ?? '');
              const amountRaw = Number(sp?.scaledBalance?.toString?.() || sp?.balance || sp?.depositBalance || sp?.borrowBalance || 0);
              const amountUi = amountRaw / Math.pow(10, decimals);
              const symbol = (mktAcc?.name || mktAcc?.symbol || '')?.toString?.()?.replace?.(/\0+$/g, '') || undefined;
              spotCollateral.push({ marketIndex: idx, symbol, amountUi, amountRaw, mint });
            } catch {}
          }
        } catch {}
        let userProfit: number | undefined = undefined;
        for (const ps of posSummary) { if (typeof ps.profitability === 'number') userProfit = (typeof userProfit === 'number') ? Math.min(userProfit, ps.profitability) : ps.profitability; }
        const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
        const execGate = Number((this.config.executeHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.executeHealthThreshold) ?? 0));
        const healthNow = (isFinite(total) && isFinite(maint) && maint > 0) ? (total - maint) / maint : null;
        const cfgAssume: any = (CONFIG as any)?.drift?.liquidator || {};
        const cfgLog = {
          subaccountId: (this.config as any)?.subaccountId ?? ((CONFIG as any)?.drift?.liquidator?.subaccountId) ?? ((CONFIG as any)?.drift?.defaultSubaccountId),
          maxAttemptNotional: (this.config as any)?.maxAttemptNotional ?? cfgAssume.maxAttemptNotional,
          perpSizeFraction: this.config.perpSizeFraction ?? cfgAssume.perpSizeFraction,
          spotSizeFraction: this.config.spotSizeFraction ?? cfgAssume.spotSizeFraction,
          maxPerpAttempts: this.config.maxPerpAttempts ?? cfgAssume.maxPerpAttempts,
          maxSpotAttempts: this.config.maxSpotAttempts ?? cfgAssume.maxSpotAttempts,
          maxCancels: this.config.maxCancels ?? cfgAssume.maxCancels,
        };
        logger.info('drift.liquidator.target_snapshot', {
          user: target.userPk,
          healthNow, thresholds: { risk: riskThresh, execute: execGate },
          collateral: { total: total, maintenance: maint, free: free, totalUi, maintUi, freeUi },
          exposureUsd,
          positions: posSummary,
          spotCollateral,
          config: cfgLog,
          cat: 'drift'
        } as any);
        // Profitability/size gate after logging snapshot
        try {
          const minProfitability = (this.config as any)?.minProfitability ?? cfgAssume.minProfitability;
          const minNotional = (this.config as any)?.minNotional ?? cfgAssume.minNotional;
          const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? cfgAssume.perpSizeFraction ?? 0.05))));
          let maxAttemptNotionalLocal = 0;
          try { for (const ps of posSummary) { if (typeof ps.notional === 'number') maxAttemptNotionalLocal = Math.max(maxAttemptNotionalLocal, ps.notional * sizeFraction); } } catch {}
          if (minNotional !== undefined && Number.isFinite(Number(minNotional)) && maxAttemptNotionalLocal < Number(minNotional)) {
            logger.info('drift.liquidator.decision', { user: target.userPk, proceed: false, reason: 'SIZE_TOO_SMALL', gate: { minNotional, attemptNotional: maxAttemptNotionalLocal }, cat: 'drift' } as any);
            return;
          }
          if (minProfitability !== undefined && typeof userProfit === 'number' && userProfit < Number(minProfitability)) {
            logger.info('drift.liquidator.decision', { user: target.userPk, proceed: false, reason: 'UNPROFITABLE', gate: { minProfitability, profitability: userProfit }, cat: 'drift' } as any);
            return;
          }
          logger.info('drift.liquidator.decision', { user: target.userPk, proceed: true, reason: 'OK', gate: { minNotional, minProfitability, attemptNotional: maxAttemptNotionalLocal, profitability: userProfit }, cat: 'drift' } as any);
        } catch {}
      } catch {}
      const marketsForUser = Array.from(this.userToMarkets.get(String(target.userPk)) || []);
      const perpMarkets = marketsForUser.length > 0 ? marketsForUser : [0, 1, 2];
      // Step 1: force-cancel orders (best-effort, capped)
      try {
        const maxCancels = Math.max(1, Math.min(200, Number((this.config.maxCancels ?? ((CONFIG as any)?.drift?.liquidator?.maxCancels) ?? 20))));
        const batch = Math.min(maxCancels, 10);
        try { logger.info('drift.liquidator.force_cancel_begin', { user: target.userPk, maxCancels, batch, cat: 'drift' }); } catch {}
        let batches = 0;
        let errors = 0;
        if (typeof drift?.forceCancelOrdersForUsers === 'function' && userPublicKey) {
          try {
            await drift.forceCancelOrdersForUsers({ users: [userPublicKey], marketType: 0, maxCancels });
            batches += 1;
            try { logger.info('drift.liquidator.force_cancel_batch_ok', { user: target.userPk, batchSize: maxCancels, batches, cat: 'drift' }); } catch {}
          } catch (e: any) {
            errors += 1;
            try { logger.warn('drift.liquidator.force_cancel_batch_failed', { user: target.userPk, error: String(e?.message || e), cat: 'drift' }); } catch {}
          }
        } else if (typeof drift?.forceCancelOrders === 'function' && userPublicKey) {
          try {
            let remaining = maxCancels;
            while (remaining > 0) {
              try {
                await drift.forceCancelOrders({ userPublicKey: userPublicKey, marketType: 0, limit: batch });
                batches += 1;
                try { logger.info('drift.liquidator.force_cancel_batch_ok', { user: target.userPk, batchSize: batch, batches, cat: 'drift' }); } catch {}
              } catch (e: any) {
                errors += 1;
                try { logger.warn('drift.liquidator.force_cancel_batch_failed', { user: target.userPk, error: String(e?.message || e), cat: 'drift' }); } catch {}
              }
              remaining -= batch;
              if (remaining > 0) { try { await new Promise(r => setTimeout(r, 250)); } catch {} }
            }
          } catch {}
        } else {
          try { logger.info('drift.liquidator.force_cancel_unavailable', { user: target.userPk, cat: 'drift' }); } catch {}
        }
        try { logger.info('drift.liquidator.force_cancel_summary', { user: target.userPk, requested: maxCancels, batches, errors, cat: 'drift' }); } catch {}
        try { logger.info('drift.liquidator.force_cancel_end', { user: target.userPk, cat: 'drift' }); } catch {}
      } catch (e: any) {
        this.recordError(e);
      }
      // Step 2: attempt perp liquidation (best-effort, capped and obeying maxAttemptNotional when set)
      try {
        const maxPerp = Math.max(1, Math.min(50, Number((this.config.maxPerpAttempts ?? ((CONFIG as any)?.drift?.liquidator?.maxPerpAttempts) ?? 3))));
        const baseSizeFrac = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
        // Prefer SDK BN; fallback to Anchor BN, then bn.js and polyfill toBuffer when missing
        let BN: any = null;
        try { const sdk: any = await import('@drift-labs/sdk'); BN = (sdk as any)?.BN || (sdk as any)?.AnchorsBN || null; } catch {}
        if (!BN) { try { const anchor: any = await import('@coral-xyz/anchor'); BN = (anchor as any)?.BN || (anchor as any)?.default?.BN || null; } catch {} }
        if (!BN) {
          try {
            const mod: any = await import('bn.js');
            BN = (mod as any)?.BN || (mod as any)?.default?.BN || (mod as any)?.default || null;
            try {
              if (BN && !BN.prototype.toBuffer && typeof BN.prototype.toArrayLike === 'function') {
                BN.prototype.toBuffer = function toBuffer(this: any, endian?: any, length?: any) {
                  const buf = Buffer.from(this.toArrayLike(Buffer, endian || 'be', length));
                  return buf;
                };
              }
            } catch {}
          } catch {}
        }
        let anySuccess = false;
        if (typeof drift?.liquidatePerp === 'function' && userPublicKey) {
          let attempts = 0;
          for (const idx of perpMarkets) {
            if (attempts >= maxPerp) break;
            const mkt = Number(idx);
            const posN = Number(posNotionalByMarket.get(mkt) || 0);
            const baseRawAbs = Number(posBaseRawByMarket.get(mkt) || 0);
            if (!Number.isFinite(posN) || posN <= 0) continue;
            // Cap fraction to respect remainingNotional when set
            let sizeFrac = baseSizeFrac;
            if (Number.isFinite(remainingNotional) && remainingNotional !== Infinity) {
              const allowed = remainingNotional / posN;
              sizeFrac = Math.min(baseSizeFrac, Math.max(0, allowed));
            }
            try { logger.info('drift.liquidator.perp_attempt', { user: target.userPk, marketIndex: mkt, posNotional: posN, baseSizeFrac, sizeFrac, remainingNotional: Number.isFinite(remainingNotional) && remainingNotional !== Infinity ? remainingNotional : null, cat: 'drift' }); } catch {}
            if (sizeFrac <= 0) break;
            const t0 = Date.now();
            try {
              const attemptBaseRaw = Math.max(1, Math.floor(baseRawAbs * sizeFrac));
              let res: any = null;
              try {
                // Prefer fractional size if supported by SDK
                res = await drift.liquidatePerp(userPublicKey, mkt, sizeFrac);
              } catch (e: any) {
                if (BN) {
                  // Fallback to BN amount if fractional signature is not supported
                  const amt = new BN(Number(attemptBaseRaw));
                  res = await drift.liquidatePerp(userPublicKey, mkt, amt);
                } else {
                  throw e;
                }
              }
              const sig = typeof res === 'string' ? res : (res?.txSig || res?.signature || null);
              attempts += 1;
              const consumedUsd = posN * sizeFrac;
              if (Number.isFinite(remainingNotional) && remainingNotional !== Infinity) {
                remainingNotional = Math.max(0, remainingNotional - consumedUsd);
              }
              try {
                logger.info('drift.liquidator.perp_ok', { user: target.userPk, marketIndex: mkt, sizeFraction: sizeFrac, consumedUsd, remainingNotional: (Number.isFinite(remainingNotional) && remainingNotional !== Infinity) ? remainingNotional : null, sig, ms: Date.now() - t0, cat: 'drift' });
              } catch {}
              anySuccess = true;
              if (Number.isFinite(remainingNotional) && remainingNotional !== Infinity && remainingNotional <= 0) break;
            } catch (e: any) {
              try {
                logger.warn('drift.liquidator.perp_failed', { user: target.userPk, marketIndex: mkt, sizeFraction: sizeFrac, error: String(e?.message || e), cat: 'drift' });
              } catch {}
            }
          }
        } else if (typeof drift?.liquidatePerpBatch === 'function' && userPublicKey) {
          try {
            // If we only have batch available, compute a conservative global fraction to obey the cap
            let sizeFraction = baseSizeFrac;
            if (Number.isFinite(remainingNotional) && remainingNotional !== Infinity) {
              const sumN = perpMarkets.reduce((s: number, idx: number) => s + (Number(posNotionalByMarket.get(Number(idx)) || 0)), 0);
              if (sumN > 0) sizeFraction = Math.min(baseSizeFrac, Math.max(0, remainingNotional / sumN));
              try { logger.info('drift.liquidator.perp_batch_attempt', { user: target.userPk, markets: perpMarkets, sumNotional: sumN, sizeFraction, remainingNotional, cat: 'drift' }); } catch {}
            }
            const t0 = Date.now();
            if (sizeFraction > 0) {
              try {
                const res = await drift.liquidatePerpBatch({ users: [userPublicKey], markets: perpMarkets, sizeFraction });
                const sig = typeof res === 'string' ? res : (res?.txSig || res?.signature || null);
                try { logger.info('drift.liquidator.perp_batch_ok', { user: target.userPk, markets: perpMarkets, sizeFraction, sig, ms: Date.now() - t0, cat: 'drift' }); } catch {}
                anySuccess = true;
              } catch (e: any) {
                try { logger.warn('drift.liquidator.perp_batch_failed', { user: target.userPk, markets: perpMarkets, sizeFraction, error: String(e?.message || e), cat: 'drift' }); } catch {}
              }
            }
          } catch {}
        } else {
          try { logger.info('drift.liquidator.perp_unavailable', { user: target.userPk, cat: 'drift' }); } catch {}
        }
      } catch (e: any) {
        this.recordError(e);
        this.applyCooldownForTarget(target.userPk);
      }
      // Step 3: attempt spot liquidation (best-effort, capped)
      try {
        if (Number.isFinite(remainingNotional) && remainingNotional !== Infinity && remainingNotional <= 0) {
          // Cap fully consumed; skip spot
          try { logger.info('drift.liquidator.spot_skip_cap', { user: target.userPk, cat: 'drift' }); } catch {}
        } else {
        if (typeof drift?.liquidateSpot === 'function' && userPublicKey && (drift?.liquidateSpot?.length || 0) >= 4) {
          const maxSpot = Math.max(1, Math.min(50, Number((this.config.maxSpotAttempts ?? ((CONFIG as any)?.drift?.liquidator?.maxSpotAttempts) ?? 2))));
          const sizeFrac = Math.max(0.001, Math.min(0.5, Number((this.config.spotSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.spotSizeFraction) ?? 0.05))));
          const spots = [0];
          let attempts = 0;
          for (const s of spots) {
            if (attempts >= maxSpot) break;
              try { logger.info('drift.liquidator.spot_attempt', { user: target.userPk, spotMarketIndex: Number(s), sizeFraction: sizeFrac, cat: 'drift' }); } catch {}
            const t0 = Date.now();
            try {
                // Without liability/asset mapping, skip spot liquidation unless API supports simple signature. Guarded above by arity.
                // Implementations typically require (user, assetMarketIndex, liabilityMarketIndex, maxAmountBN)
                // For now, treat as unavailable in most SDKs.
                throw new Error('SPOT_API_UNSUPPORTED');
                const sig = typeof res === 'string' ? res : (res?.txSig || res?.signature || null);
                attempts += 1;
                try { logger.info('drift.liquidator.spot_ok', { user: target.userPk, spotMarketIndex: Number(s), sizeFraction: sizeFrac, sig, ms: Date.now() - t0, cat: 'drift' }); } catch {}
                anySuccess = true;
            } catch (e: any) {
              try { logger.warn('drift.liquidator.spot_failed', { user: target.userPk, spotMarketIndex: Number(s), sizeFraction: sizeFrac, error: String(e?.message || e), cat: 'drift' }); } catch {}
            }
          }
        } else {
          try { logger.info('drift.liquidator.spot_unavailable', { user: target.userPk, cat: 'drift' }); } catch {}
        }
        }
      } catch (e: any) {
        this.recordError(e);
        this.applyCooldownForTarget(target.userPk);
      }
      // Final attempt summary: before/after health and reduced USD by market
      try {
        let beforeHealth: number | null = null;
        let afterHealth: number | null = null;
        try {
          let sdkUser = this.userCache.get(String(target.userPk));
          if (!sdkUser) {
            let pk: any = target.userPk;
            try { pk = new PublicKey(String(target.userPk)); } catch {}
            sdkUser = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
            this.userCache.set(String(target.userPk), sdkUser);
            try { await (sdkUser as any)?.subscribe?.(); this.subscribedUsers.add(String(target.userPk)); } catch {}
          }
          try {
            const total = Number((sdkUser as any)?.getTotalCollateral?.() || 0);
            const maint = Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0);
            beforeHealth = (isFinite(total) && isFinite(maint) && maint > 0) ? (total - maint) / maint : null;
          } catch {}
          try { await (sdkUser as any)?.fetchAccounts?.(); } catch {}
          try {
            const total2 = Number((sdkUser as any)?.getTotalCollateral?.() || 0);
            const maint2 = Number((sdkUser as any)?.getMaintenanceMarginRequirement?.() || 0);
            afterHealth = (isFinite(total2) && isFinite(maint2) && maint2 > 0) ? (total2 - maint2) / maint2 : null;
          } catch {}
          const posAfter = (sdkUser as any)?.getPerpPositions?.() || [];
          let BASE_PREC = 1_000_000_000;
          try { const sdk: any = await import('@drift-labs/sdk'); const cst: any = (sdk as any).constants || (sdk as any); if (Number.isFinite(Number(cst?.BASE_PRECISION))) BASE_PREC = Number(cst.BASE_PRECISION); } catch {}
          const notionalAfter: Map<number, number> = new Map();
          for (const p of posAfter) {
            try {
              const rawBase = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
              const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
              if (!Number.isFinite(m) || rawBase === 0) continue;
              const baseUi = rawBase / BASE_PREC;
              let priceSample = DriftPriceService.getInstance().getPrice(Number(m));
              const cur = (priceSample?.mid ?? priceSample?.oracle ?? priceSample?.bid ?? priceSample?.ask);
              if (typeof cur === 'number' && isFinite(cur)) notionalAfter.set(m, Math.abs(baseUi) * cur);
            } catch {}
          }
          const deltas: Array<{ marketIndex: number; reducedUsd: number }> = [];
          if (anySuccess && notionalAfter.size > 0) {
            for (const [m, beforeN] of Array.from(posNotionalByMarket.entries())) {
              const afterN = Number(notionalAfter.get(m) ?? beforeN);
              if (Number.isFinite(beforeN) && Number.isFinite(afterN)) {
                const reduced = Math.max(0, beforeN - afterN);
                if (reduced > 0) deltas.push({ marketIndex: Number(m), reducedUsd: reduced });
              }
            }
          }
          try {
            logger.info('drift.liquidator.attempt_result', {
              user: target.userPk,
              beforeHealth,
              afterHealth,
              healthDelta: (typeof beforeHealth === 'number' && typeof afterHealth === 'number') ? (afterHealth - beforeHealth) : null,
              reducedUsdByMarket: deltas,
              remainingNotional: (Number.isFinite(remainingNotional) && remainingNotional !== Infinity) ? remainingNotional : null,
              cat: 'drift'
            });
          } catch {}
        } catch {}
      } catch {}
      this.recordAction();
      logger.info('drift.liquidator.action_complete', { user: target.userPk, cat: 'drift' });
    } catch (e: any) {
      this.recordError(e);
      this.applyCooldownForTarget(target.userPk);
    } finally {
      try { logger.info('drift.liquidator.attempt_end', { user: target.userPk, name: this.config?.name, cat: 'drift' }); } catch {}
    }
  }

  async testTarget(userPk: string): Promise<{ ok: boolean }> {
    try {
      try { logger.info('drift.liquidator.test_request', { user: String(userPk), name: this.config?.name, cat: 'drift' }); } catch {}
      await this.handleTarget({ userPk: String(userPk), health: 0 });
      try { this.maybeEmitQueue(); } catch {}
      try { logger.info('drift.liquidator.test_complete', { user: String(userPk), name: this.config?.name, cat: 'drift' }); } catch {}
      return { ok: true };
    } catch (e: any) {
      try { logger.error('drift.liquidator.test_failed', { user: String(userPk), error: String(e?.message || e), cat: 'drift' }); } catch {}
      return { ok: false };
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
      // Try to get user's position for this market
      const positions = sdkUser?.getPerpPositions?.() || [];
      const pos = positions.find((p: any) => Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index) === Number(marketIndex));
      if (!pos) return null;
      const base = Number(pos?.baseAssetAmount?.toString?.() || pos?.baseAssetAmount || 0);
      if (!isFinite(base) || Math.abs(base) === 0) return null;
      // Estimate liquidation price if available on SDK; else approximate from collateral & maintenance
      // Placeholder: derive from health proxy if SDK doesn't expose directly
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

  private async isUserBankrupt(sdkUser: any): Promise<boolean> {
    try {
      let QUOTE_PREC = 1_000_000;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION);
      } catch {}
      const toNum = (v: any): number => Number(v?.toString?.() || v || 0);
      const assets = toNum((sdkUser as any)?.getAssetsValue?.()) / QUOTE_PREC;
      const liabilities = toNum((sdkUser as any)?.getLiabilitiesValue?.()) / QUOTE_PREC;
      const free = toNum((sdkUser as any)?.getFreeCollateral?.()) / QUOTE_PREC;
      if (!isFinite(assets) || !isFinite(liabilities)) return false;
      return (liabilities >= assets) && (free <= 0);
    } catch {
      return false;
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
      const snapshot = this.getQueueSnapshot(20);
      emit('drift-liquidation', { type: 'queue', ...snapshot }).catch(() => {});
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
        // Enqueue for probing and merge into discovery keys for scan scheduling
        const set = new Set<string>(this.userKeys);
        for (const pk of userPks.slice(0, max)) { this.enqueueProbe(pk); set.add(String(pk)); }
        this.userKeys = Array.from(set);
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
        const set = new Set<string>(this.userKeys);
        for (const pk of makers.slice(0, max)) { this.enqueueProbe(pk); set.add(String(pk)); }
        this.userKeys = Array.from(set);
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
      const healthyUntil = this.healthyUntil.get(key);
      if (typeof healthyUntil === 'number' && now < healthyUntil) return;
      if (this.inProbeQueue.has(key)) return;
      this.pendingProbeQueue.push(key);
      this.inProbeQueue.add(key);
    } catch {}
  }

  private async processProbeQueue(): Promise<void> {
    if (this.probeProcessing) return;
    if (this.abort) return;
    this.probeProcessing = true;
    try {
      const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
      const drift: any = (DriftService.getInstance() as any).client;
      const capCfg = Math.max(1, Math.min(200, Number((this.config.maxProbesPerTick ?? ((CONFIG as any)?.drift?.liquidator?.maxProbesPerTick) ?? 40))));
      const perTickCap = Math.max(1, Math.floor(this.getProbeRps() * Math.max(200, Number(this.currentPollMs || 1000)) / 1000));
      const cap = Math.min(capCfg, perTickCap);
      const slice = this.pendingProbeQueue.splice(0, cap);
      let probed = 0;
      let flagged = 0;
      for (const key of slice) {
        if (this.abort) break;
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
          // Rate-limit the HTTP RPC call
          await this.acquireProbeToken();
          const exists = await (user as any).exists?.();
          if (!exists) { this.inProbeQueue.delete(key); continue; }
          // Ensure fresh accounts snapshot after subscribe (WS may take a moment to push first state)
          try { if (typeof (user as any)?.fetchAccounts === 'function') { await (user as any).fetchAccounts(); } } catch {}
          // Compute health early; if already under threshold, flag immediately
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          if (!isFinite(total) || !isFinite(maint)) { this.inProbeQueue.delete(key); continue; }
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          // Positions for scoping and indexing
          let positions = (user as any)?.getPerpPositions?.() || [];
          try { if (!Array.isArray(positions) || positions.length === 0) { const raw = (user as any)?.getUserAccount?.()?.perpPositions; if (Array.isArray(raw)) positions = raw; } } catch {}
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
            try { await this.safeUnsubscribeUser(key, user); } catch {}
            this.inProbeQueue.delete(key);
            continue;
          }
          if (!inScope) {
            const ms = Math.max(15000, Number((this.config.outOfScopeCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.outOfScopeCooldownMs) ?? 60000)));
            this.outOfScopeUntil.set(key, Date.now() + ms);
            try { await this.safeUnsubscribeUser(key, user); } catch {}
            this.atRiskUsers.delete(key);
            this.inProbeQueue.delete(key);
            continue;
          }
          // Index in-scope users for price-triggered scans
          try { await this.refreshIndexForUser(user, key); } catch {}
          // Build lightweight positions summary for UI
          // Compute quote precision and UI-scaled collateral metrics
          let QUOTE_PREC = 1_000_000;
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const cst: any = (sdk as any).constants || (sdk as any);
            if (Number.isFinite(Number(cst?.QUOTE_PRECISION))) QUOTE_PREC = Number(cst.QUOTE_PRECISION);
          } catch {}
          const totalUi = Number(total) / QUOTE_PREC;
          const maintUi = Number(maint) / QUOTE_PREC;
          let freeUi = 0;
          try { freeUi = Number((user as any)?.getFreeCollateral?.()?.toString?.() || (user as any)?.getFreeCollateral?.() || 0) / QUOTE_PREC; } catch {}
          let posSummary: Array<{ marketIndex: number; symbol?: string; base: number; notional?: number; liqPrice?: number; profitability?: number }> = [];
          try {
            let BASE_PREC = 1_000_000_000; // default BASE_PRECISION
            try {
              const sdk: any = await import('@drift-labs/sdk');
              const cst: any = (sdk as any).constants || (sdk as any);
              const maybe = Number(cst?.BASE_PRECISION || cst?.BASE_PRECISION_EXP || cst?.BASE_PRECISION_EXPONENT);
              // Prefer BASE_PRECISION; some SDKs expose exponent or alt names; fall back to 1e9
              if (Number.isFinite(Number(cst?.BASE_PRECISION))) BASE_PREC = Number(cst.BASE_PRECISION);
            } catch {}
            for (const p of positions) {
              try {
                const raw = Number(p?.baseAssetAmount?.toString?.() || p?.baseAssetAmount || 0);
                const m = Number(p?.marketIndex ?? p?.market_index ?? p?.market?.index);
                if (Number.isFinite(m) && raw !== 0) {
                  const baseUi = raw / BASE_PREC;
                  let notional: number | undefined = undefined;
                  let liqPrice: number | undefined = undefined;
                  let profitability: number | undefined = undefined;
                  let symbol: string | undefined = undefined;
                  try {
                    symbol = (indexToSymbol(Number(m)) || '').split('-')[0] || undefined;
                    // Ensure price tracking and attempt immediate price sampling
                    try {
                      const svc = DriftPriceService.getInstance();
                      const pollMs = Math.max(800, Number((this.config.httpPollMs ?? ((CONFIG as any)?.drift?.liquidator?.httpPollMs ?? 1200))));
                      svc.trackMarket(Number(m), pollMs);
                    } catch {}
                    const priceSample = DriftPriceService.getInstance().getPrice(Number(m));
                    let cur = (priceSample?.mid ?? priceSample?.oracle ?? priceSample?.bid ?? priceSample?.ask);
                    if (!(typeof cur === 'number' && isFinite(cur))) {
                      try {
                        const l2 = await fetchDlobL2(Number(m));
                        if (l2) {
                          const mid = (typeof l2.bid?.[0]?.price === 'number' && typeof l2.ask?.[0]?.price === 'number')
                            ? (l2.bid[0].price + l2.ask[0].price) / 2
                            : undefined;
                          cur = (typeof mid === 'number') ? mid : (typeof l2.oracle === 'number' ? l2.oracle : cur);
                        }
                      } catch {}
                    }
                    if (typeof cur === 'number' && isFinite(cur)) {
                      notional = Math.abs(baseUi) * cur;
                      const dist = this.computeDistanceToLiquidation(String(key), Number(m));
                      if (typeof dist === 'number' && isFinite(dist)) {
                        const sgn = Math.sign(baseUi) || 1;
                        liqPrice = cur * (1 - sgn * dist);
                      }
                      // Profitability heuristic
                      const feeCfg: any = (CONFIG as any)?.drift?.liquidator?.feeAssumptions || {};
                      const liqFeeRate = Math.max(0, Number(feeCfg.liqFeeRate ?? 0.01));
                      const takerFeeRate = Math.max(0, Number(feeCfg.takerFeeRate ?? 0.0004));
                      const slippageBp = Math.max(0, Number(feeCfg.slippageBp ?? 30));
                      const oracleHaircutBp = Math.max(0, Number(feeCfg.oracleHaircutBp ?? 10));
                      const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
                      const slippageRate = slippageBp / 10_000;
                      const oracleHaircutRate = oracleHaircutBp / 10_000;
                      const attemptNotional = (notional || 0) * sizeFraction;
                      const bonus = attemptNotional * liqFeeRate;
                      const expectedFees = attemptNotional * (takerFeeRate + slippageRate + oracleHaircutRate);
                      profitability = attemptNotional > 0 ? (bonus - expectedFees) / attemptNotional : undefined;
                    }
                  } catch {}
                  posSummary.push({ marketIndex: m, symbol, base: baseUi, notional, liqPrice, profitability });
                }
              } catch {}
            }
          } catch {}
          probed += 1;
          if (health < riskThresh) {
            // Aggregate a user-level profitability (min across positions)
            let userProfit: number | undefined = undefined;
            try {
              for (const ps of posSummary) {
                if (typeof ps.profitability === 'number') {
                  userProfit = (typeof userProfit === 'number') ? Math.min(userProfit, ps.profitability) : ps.profitability;
                }
              }
            } catch {}
            const exposureUsd = posSummary.reduce((s, p) => s + (typeof p.notional === 'number' ? Math.abs(p.notional) : 0), 0);
            const cfgAssume: any = (CONFIG as any)?.drift?.liquidator?.feeAssumptions || {};
            const minProfitability = Math.max(Number((this.config as any)?.minProfitability ?? ((CONFIG as any)?.drift?.liquidator?.minProfitability) ?? -Infinity), -Infinity);
            const minNotional = Math.max(0, Number((this.config as any)?.minNotional ?? ((CONFIG as any)?.drift?.liquidator?.minNotional) ?? 0));
            const sizeFraction = Math.max(0.001, Math.min(0.5, Number((this.config.perpSizeFraction ?? ((CONFIG as any)?.drift?.liquidator?.perpSizeFraction) ?? 0.05))));
            let skipReason: string | undefined = undefined;
            try {
              // If all positions too small for an attempt, mark size
              const anyLargeEnough = posSummary.some((ps) => typeof ps.notional === 'number' && (ps.notional as number) * sizeFraction >= minNotional);
              if (!anyLargeEnough) skipReason = 'SIZE_TOO_SMALL';
              // Check profitability gate if configured
              if (skipReason === undefined && Number.isFinite(minProfitability) && typeof userProfit === 'number' && userProfit < minProfitability) skipReason = 'UNPROFITABLE';
              // If total collateral <= 0, likely bad debt
              if (skipReason === undefined && total <= 0) skipReason = 'NO_COLLATERAL';
            } catch {}
          this.atRiskUsers.set(key, {
              health,
              updatedAt: Date.now(),
              positions: posSummary,
              profitability: userProfit,
              skipReason,
              collateralUsd: totalUi,
              maintenanceUsd: maintUi,
              freeUsd: freeUi,
              exposureUsd,
            } as any);
          this.startLiveMonitor(key);
            this.addOrQueueCandidate({ userPk: key, health, updatedAt: Date.now() });
            flagged += 1;
          } else {
            // Not at risk: optionally unsubscribe to minimize load
            if (health >= (riskThresh + recoveryBuf)) {
              this.atRiskUsers.delete(key);
              this.stopLiveMonitor(key);
            }
            // Apply healthy cooldown to avoid immediate re-probing
            try {
              const ms = Math.max(8000, Number(((this.config as any)?.healthyCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.healthyCooldownMs) ?? 15000)));
              this.healthyUntil.set(key, Date.now() + ms);
            } catch {}
            try { await this.safeUnsubscribeUser(key, user); } catch {}
          }
        } catch {} finally {
          this.inProbeQueue.delete(key);
        }
      }
      try { logger.debug('drift.liquidator.probe_result', { attempted: slice.length, probed, flagged, pending: this.pendingProbeQueue.length, rps: this.getProbeRps(), cat: 'drift' }); } catch {}
    } catch {} finally {
      this.probeProcessing = false;
    }
  }

  private startLiveMonitor(userPk: string): void {
    try {
      const key = String(userPk);
      if (this.liveMonitors.has(key)) return;
      const intervalMs = Math.max(3000, Number(((this.config as any)?.liveMonitorIntervalMs ?? ((CONFIG as any)?.drift?.liquidator?.refreshAccountsMs) ?? 12000)));
      const t: any = (globalThis as any).setInterval(async () => {
        try {
          const drift: any = (DriftService.getInstance() as any).client;
          let user = this.userCache.get(key);
          if (!user) {
            let pk: any = key; try { pk = new PublicKey(key); } catch {}
            user = new User({ driftClient: drift, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
            this.userCache.set(key, user);
            try { await (user as any)?.subscribe?.(); this.subscribedUsers.add(key); } catch {}
          }
          try { await (user as any)?.fetchAccounts?.(); } catch {}
          const total = Number((user as any)?.getTotalCollateral?.() || 0);
          const maint = Number((user as any)?.getMaintenanceMarginRequirement?.() || 0);
          const riskThresh = Number((this.config.riskHealthThreshold ?? ((CONFIG as any)?.drift?.liquidator?.riskHealthThreshold) ?? 0));
          const health = maint > 0 ? (total - maint) / maint : Infinity;
          if (!(health < riskThresh)) { this.stopLiveMonitor(key); this.healthyUntil.set(key, Date.now() + Math.max(8000, Number(((this.config as any)?.healthyCooldownMs ?? ((CONFIG as any)?.drift?.liquidator?.healthyCooldownMs) ?? 15000)))); return; }
          this.addOrQueueCandidate({ userPk: key, health, updatedAt: Date.now() } as any);
          this.requestImmediateDrain();
        } catch {}
      }, intervalMs);
      this.liveMonitors.set(key, t);
    } catch {}
  }

  private stopLiveMonitor(userPk: string): void {
    try {
      const key = String(userPk);
      const t = this.liveMonitors.get(key);
      if (t) { try { (globalThis as any).clearInterval(t); } catch {} }
      this.liveMonitors.delete(key);
    } catch {}
  }

  private async safeUnsubscribeUser(key: string, user: any, timeoutMs: number = 2000): Promise<void> {
    try {
      if (!this.subscribedUsers.has(key) || this.unsubscribingUsers.has(key)) return;
      this.unsubscribingUsers.add(key);
      const doUnsub = (async () => { try { await user?.unsubscribe?.(); } catch {} })();
      await Promise.race([
        doUnsub,
        new Promise<void>((resolve) => { try { (globalThis as any).setTimeout(resolve, Math.max(250, Number(timeoutMs))); } catch { resolve(); } }),
      ]);
    } finally {
      try { this.subscribedUsers.delete(key); } catch {}
      try { this.unsubscribingUsers.delete(key); } catch {}
    }
  }

  getQueueSnapshot(limit = 20): { candidatesQueued: number; top: Array<{ userPk: string; health: number; updatedAt: number }>; markets: number[]; exposures: Array<{ marketIndex: number; users: number; symbol?: string }>; actionsLastMin: number; errorsLastMin: number; users: Array<{ userPk: string; health: number; updatedAt: number; positions?: Array<{ marketIndex: number; symbol?: string; base: number; notional?: number; liqPrice?: number; profitability?: number }>; profitability?: number; skipReason?: string; collateralUsd?: number; maintenanceUsd?: number; freeUsd?: number; exposureUsd?: number }> } {
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
    const usersArr = Array.from(this.atRiskUsers.entries()).map(([k, v]) => ({
      userPk: k,
      health: v.health,
      updatedAt: v.updatedAt,
      positions: v.positions,
      profitability: (v as any).profitability,
      skipReason: (v as any).skipReason,
      collateralUsd: (v as any).collateralUsd,
      maintenanceUsd: (v as any).maintenanceUsd,
      freeUsd: (v as any).freeUsd,
      exposureUsd: (v as any).exposureUsd,
    }));
    usersArr.sort((a, b) => a.health - b.health);
    const usersLimit = Math.max(1, Math.min(500, Number(((CONFIG as any)?.drift?.liquidator?.usersListLimit) ?? 200)));
    return {
      candidatesQueued: this.state.candidatesQueued,
      top: top.map(t => ({ userPk: t.userPk, health: t.health, updatedAt: t.updatedAt })),
      markets: Array.from(this.trackedMarkets),
      exposures: exposuresWithSymbols,
      actionsLastMin: this.state.actionsLastMin,
      errorsLastMin: this.state.errorsLastMin,
      users: usersArr.slice(0, usersLimit),
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


