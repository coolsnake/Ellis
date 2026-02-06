import { PublicKey, ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
import { hotlist } from './hotlist.js';
import { driftEventIndex } from './eventIndex.js';
import { computeTriggerPriorityFee } from './triggerUtils.js';
import { logger } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';
import { CONFIG } from '../utils/config.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { buildTipIx } from '../execution/jitoTip.js';
import { startTipFeed, getCachedTipInfo } from '../execution/jitoTipCache.js';
import { sendToBlockEngine } from '../execution/jitoClient.js';
import { hasInfra, fetchTriggerNodes, fetchUserAccounts, fetchEventIndex, waitForInfraReady } from './infraClient.js';

export type TriggerConfig = {
  name: string;
  enabled: boolean;
  dryRun?: boolean;
  subaccountId?: number;
  intervalMs?: number; // default 800 tailored
  cuLimit?: number; // default 220_000 tailored
  priorityFeeMicroLamports?: number; // default 0 (provider strategy may boost)
  marketsAllowlist?: Array<number> | string[]; // market indices allowlist
  triggerPriorityFeeMultiplier?: number; // scales dynamic priority fee (default 1.0)
};

type TriggerRuntimeState = {
  running: boolean;
  name: string;
  dryRun: boolean;
  subaccountId: number;
  loopIntervalMs: number;
  lastRunAt?: number;
  lastError?: string;
  triggersLastMin: number;
  marketsAllowlist?: number[];
};

const COOLDOWN_MS = 10_000; // avoid re-trigger spam per node signature
const TRIGGER_CAT = 'drift';
const TRIGGER_SUBCAT = 'trigger';

export class DriftTriggerRunner {
  private timer: any | null = null;
  private config: TriggerConfig;
  private state: TriggerRuntimeState;
  private abort = false;
  private inLoop: boolean = false;
  private botKey: string;

  private sdk: any | null = null;
  private client: any | null = null;
  private connection: any | null = null;

  private slotSubscriber: any | null = null;
  private eventSubscriber: any | null = null;
  private userMap: any | null = null;
  private dlobSubscriber: any | null = null;
  private priorityFeeSubscriber: any | null = null;
  private lookupTableAccounts: AddressLookupTableAccount[] | null = null;
  private useInfra: boolean = false;
  private infraUaCache: Map<string, { ua: any; ts: number }> = new Map();

  private nodesCooldown: Map<string, number> = new Map();
  private triggersInWindow: number[] = [];
  private lastPruneAtMs: number = 0;
  private marketsCacheTs: number = 0;
  private cachedPerpMarkets: any[] | null = null;
  private cachedSpotMarkets: any[] | null = null;
  private lastFullScanAt: number = 0;
  private eventIndexSweepTimer: any | null = null;
  private eventIndexBound: boolean = false;
  private summaryOnly: boolean = false;
  private _summary: { since: number; loops: number; totalNodesPlanned: number; marketsWithNodes: number; priorityMarkets: number; scanModes: { full: number; targeted: number }; users?: number; slot?: number; indexStats?: { users: number; markets: number; marketToOrders: number }; triggersLastMin?: number; lastMs?: number; lastSample?: Array<{ m: number; t: string; u: string; id: string; cond?: string; otype?: string; ordTp?: string; oracle?: string; trig?: string }> } | null = null;
  private _summaryTimer: any | null = null;

  constructor(cfg: TriggerConfig) {
    const allowlist = Array.isArray(cfg?.marketsAllowlist)
      ? (cfg!.marketsAllowlist as any[])
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n))
      : undefined;
    this.config = { ...cfg, marketsAllowlist: allowlist } as TriggerConfig;
    this.state = {
      running: false,
      name: String(cfg?.name || 'default'),
      dryRun: !!cfg?.dryRun,
      subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : (0 as number),
      loopIntervalMs: Math.max(300, Number(cfg?.intervalMs ?? 800)),
      triggersLastMin: 0,
      marketsAllowlist: allowlist,
    };
    this.botKey = `trg#${this.state.name}`;
  }

  getStatus(): TriggerRuntimeState {
    const cutoff = Date.now() - 60_000;
    this.triggersInWindow = this.triggersInWindow.filter((t) => t >= cutoff);
    return { ...this.state, triggersLastMin: this.triggersInWindow.length };
  }

  private async getUserAccountFromInfra(userPkStr: string): Promise<any | null> {
    if (!this.useInfra) return null;
    const now = Date.now();
    const cached = this.infraUaCache.get(userPkStr);
    if (cached && (now - cached.ts) < 2000) return cached.ua;
    try {
      const res = await fetchUserAccounts([userPkStr]);
      const data = res?.accounts?.[userPkStr]?.data;
      if (!data) return null;
      const { decodeUser } = await import('@drift-labs/sdk');
      const ua = decodeUser(Buffer.from(String(data), 'base64'));
      this.infraUaCache.set(userPkStr, { ua, ts: now });
      return ua;
    } catch {
      return null;
    }
  }

  private countActivePositions(ua: any): { perp: number; spot: number } {
    try {
      const isNonZero = (v: any): boolean => {
        if (v === null || v === undefined) return false;
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'string') return v !== '0';
        try { return String((v as any)?.toString?.() || '') !== '0'; } catch { return false; }
      };
      const perps = Array.isArray(ua?.perpPositions) ? ua.perpPositions : [];
      const spots = Array.isArray(ua?.spotPositions) ? ua.spotPositions : [];
      const perpCount = perps.filter((p: any) =>
        isNonZero(p?.baseAssetAmount) || isNonZero(p?.quoteAssetAmount) || Number(p?.openOrders || 0) > 0 || isNonZero(p?.lpShares)
      ).length;
      const spotCount = spots.filter((p: any) =>
        isNonZero(p?.scaledBalance) || Number(p?.openOrders || 0) > 0
      ).length;
      return { perp: perpCount, spot: spotCount };
    } catch {
      return { perp: 0, spot: 0 };
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.abort = false;
    this.state.running = true;

    logger.info('drift.trigger.start', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, dryRun: this.state.dryRun, loopMs: this.state.loopIntervalMs, allowlist: this.state.marketsAllowlist });

    try {
      const svc = DriftService.getInstance() as any;
      (svc as any).registerBot?.(this.botKey);
      await (svc as any).init?.();
    } catch (e: any) { safeLog.warn('drift.trigger.init_service', { error: String(e?.message || e), cat: 'drift' }); }
    const svc: any = DriftService.getInstance();
    this.connection = (svc as any).connection;
    this.client = (svc as any).client;

    if (!this.client || !this.connection) {
      this.state.lastError = 'CLIENT_OR_CONNECTION_UNAVAILABLE';
      logger.info('drift.trigger.error client_or_connection_unavailable', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
      throw new Error('Drift client or connection unavailable');
    }

    try {
      if (Number.isFinite(this.state.subaccountId)) {
        await (svc as any).switchSubaccount?.(Number(this.state.subaccountId));
        logger.info('drift.trigger.subaccount_selected', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, subaccountId: this.state.subaccountId });
      }
    } catch (e: any) {
      logger.info('drift.trigger.warn subaccount_switch_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, err: String(e?.message || e) });
    }

    this.sdk = await import('@drift-labs/sdk');
    this.useInfra = hasInfra();
    // Require infra warmup before proceeding if configured
    try {
      const driftCfg: any = (CONFIG as any)?.drift || {};
      const requireWarm = driftCfg?.warmupRequireBeforeBots !== false;
      if (requireWarm) {
        if (this.useInfra) {
          const ok = await waitForInfraReady(Number(driftCfg?.infraReadyTimeoutMs ?? driftCfg?.warmupTimeoutMs ?? 30000));
          safeLog.info('drift.trigger.infra_gate', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, ok });
        } else {
          const ok = await (svc as any).waitForWarmup?.(Number(driftCfg?.warmupTimeoutMs ?? 30000));
          safeLog.info('drift.trigger.warmup_gate', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, ok });
        }
      }
    } catch (e: any) { safeLog.warn('drift.trigger.warmup_gate_setup', { error: String(e?.message || e), cat: 'drift' }); }
    await this.initDiscovery();

    try {
      if ((this as any)._condStatsTimer) { try { clearInterval((this as any)._condStatsTimer); } catch { /* timer cleanup safe to swallow */ } }
      (this as any)._condStatsTimer = setInterval(() => {
        this.reportConditionalOrderStats().catch(() => {});
      }, 30000);
    } catch (e: any) { safeLog.warn('drift.trigger.cond_stats_timer_setup', { error: String(e?.message || e), cat: 'drift' }); }

    const tick = async () => {
      if (this.abort || this.inLoop) return;
      this.inLoop = true;
      try { await this.loop(); }
      finally { this.inLoop = false; }
    };
    this.timer = setInterval(() => { tick().catch(() => {}); }, this.state.loopIntervalMs);

    logger.info('drift.trigger.started', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, loopMs: this.state.loopIntervalMs });

    // Start periodic summary logger when enabled
    try {
      const driftCfg: any = (CONFIG as any)?.drift || {};
      const summaryOnly = !!driftCfg?.loopSummaryOnly;
      const every = Math.max(2000, Number(driftCfg?.loopSummaryIntervalMs ?? 10000));
      this.summaryOnly = summaryOnly;
      if (summaryOnly) {
        if (this._summaryTimer) { try { clearInterval(this._summaryTimer); } catch { /* timer cleanup safe to swallow */ } this._summaryTimer = null; }
        if (!this._summary) this._summary = { since: Date.now(), loops: 0, totalNodesPlanned: 0, marketsWithNodes: 0, priorityMarkets: 0, scanModes: { full: 0, targeted: 0 } };
        this._summaryTimer = setInterval(() => {
          try {
            const s = this._summary!;
            logger.info('drift.trigger.loop_summary_10s', {
              cat: TRIGGER_CAT,
              subcat: TRIGGER_SUBCAT,
              name: this.state.name,
              windowMs: Date.now() - s.since,
              loops: s.loops,
              users: s.users,
              slot: s.slot,
              totalNodesPlanned: s.totalNodesPlanned,
              marketsWithNodes: s.marketsWithNodes,
              scanModes: s.scanModes,
              priorityMarkets: s.priorityMarkets,
              index: s.indexStats,
              triggersLastMin: s.triggersLastMin,
              lastMs: s.lastMs,
              sample: s.lastSample,
            });
            this._summary = { since: Date.now(), loops: 0, totalNodesPlanned: 0, marketsWithNodes: 0, priorityMarkets: 0, scanModes: { full: 0, targeted: 0 } };
          } catch (e: any) { safeLog.debug('drift.trigger.loop_summary_emit', { error: String(e?.message || e), cat: 'drift' }); }
        }, every);
      }
    } catch (e: any) { safeLog.warn('drift.trigger.summary_timer_setup', { error: String(e?.message || e), cat: 'drift' }); }

    // Also drive ticks via slot updates for lower latency
    try {
      const onSlot = () => { try { setImmediate(() => { if (!this.inLoop && !this.abort) this.loop().catch(() => {}); }); } catch { /* timer cleanup safe to swallow */ } };
      if (typeof (this.slotSubscriber?.onSlotChange) === 'function') {
        this.slotSubscriber.onSlotChange(onSlot, 1);
      } else {
        this.slotSubscriber?.eventEmitter?.on?.('slotUpdate', onSlot);
      }
    } catch (e: any) { safeLog.warn('drift.trigger.slot_binding', { error: String(e?.message || e), cat: 'drift' }); }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    this.state.running = false;
    this.abort = true;
    try { if ((this as any)._condStatsTimer) { clearInterval((this as any)._condStatsTimer); (this as any)._condStatsTimer = null; } } catch { /* timer cleanup safe to swallow */ }
    try { if (this._summaryTimer) { clearInterval(this._summaryTimer); this._summaryTimer = null; } } catch { /* timer cleanup safe to swallow */ }
    this._summary = null;
    try { if (this.eventIndexSweepTimer) { clearInterval(this.eventIndexSweepTimer); this.eventIndexSweepTimer = null; } } catch { /* timer cleanup safe to swallow */ }
    logger.info('drift.trigger.stopped', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
    try { (DriftService.getInstance() as any).unregisterBot?.(this.botKey); } catch (e: any) { safeLog.debug('drift.trigger.unregister_bot', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    if (!this.useInfra) {
      const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(200, this.state.loopIntervalMs - 250), preferOrderSubscriber: true });
      this.slotSubscriber = (infra as any).slotSubscriber;
      this.eventSubscriber = (infra as any).eventSubscriber;
      this.userMap = (infra as any).userMap;
      this.dlobSubscriber = (infra as any).dlobSubscriber;
      logger.info('drift.trigger.dlob_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, shared: true });

      // Warm user prefetcher once shared infra is ready
      try { await (svc as any).startUserPrefetcher?.(this.dlobSubscriber, this.userMap); } catch (e: any) { safeLog.warn('drift.trigger.start_user_prefetcher', { error: String(e?.message || e), cat: 'drift' }); }
      try { this.setupEventIndex(); } catch (e: any) { safeLog.warn('drift.trigger.setup_event_index', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      safeLog.info('drift.trigger.infra_remote', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
    }

    // Initialize priority fee strategy
    try {
      const { PriorityFeeSubscriber } = this.sdk || {};
      if (PriorityFeeSubscriber) {
        this.priorityFeeSubscriber = new PriorityFeeSubscriber({
          connection: this.connection,
          fallbackPriorityFeeMicroLamports: Math.max(1000, Number(((CONFIG as any)?.fees?.priorityFee) || 1000)),
        });
        const { waitUntilWsReady } = await import('./wsHelper.js');
        if (this.connection) await waitUntilWsReady(this.connection, 'triggerRunner.init.priorityFee');
        
        // Import RPC limiter and debouncing
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        
        // Wrap subscribe call with debouncing and RPC tracking
        await withDebounce(
          'triggerRunner:priorityFeeSubscriber:subscribe',
          async () => {
            return await withRpcLimit(
              () => this.priorityFeeSubscriber.subscribe(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        
        try { this.priorityFeeSubscriber.updateAddresses([ this.client?.program?.programId ].filter(Boolean)); } catch (e: any) { safeLog.debug('drift.trigger.priority_fee_update_addresses', { error: String(e?.message || e), cat: 'drift' }); }
      }
    } catch (e: any) { safeLog.warn('drift.trigger.priority_fee_init', { error: String(e?.message || e), cat: 'drift' }); }

    // Preload ALTs for v0
    try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch { this.lookupTableAccounts = []; }
    // Periodic ALT refresh
    try {
      const every = Math.max(60_000, Number(((CONFIG as any)?.drift?.altRefreshMs) ?? 300_000));
      setInterval(async () => { try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch (e: any) { safeLog.debug('drift.trigger.alt_refresh', { error: String(e?.message || e), cat: 'drift' }); } }, every);
    } catch (e: any) { safeLog.warn('drift.trigger.alt_refresh_timer_setup', { error: String(e?.message || e), cat: 'drift' }); }

    // Start Jito tip feed cache (non-blocking)
    try { startTipFeed(Math.max(10_000, Number(((CONFIG as any)?.jito?.tipRefreshMs) ?? 15_000))); } catch (e: any) { safeLog.warn('drift.trigger.start_tip_feed', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private setupEventIndex(): void {
    if (this.useInfra) return;
    if (this.eventIndexBound) return;
    this.eventIndexBound = true;
    const driftCfg: any = (CONFIG as any)?.drift || {};
    try {
      driftEventIndex.configure({
        ttlMs: driftCfg?.eventIndexTtlMs,
        maxUsers: driftCfg?.eventIndexMaxUsers,
        maxMarkets: driftCfg?.eventIndexMaxMarkets,
        maxMarketsPerUser: driftCfg?.eventIndexMaxMarketsPerUser,
      });
    } catch (e: any) { safeLog.warn('drift.trigger.event_index_configure', { error: String(e?.message || e), cat: 'drift' }); }
    try { driftEventIndex.bindEventSubscriber(this.eventSubscriber); } catch (e: any) { safeLog.warn('drift.trigger.event_index_bind', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      const limit = Math.max(100, Number(driftCfg.eventIndexBootstrapUsers ?? 2000));
      driftEventIndex.bootstrapFromUserMap(this.userMap, { limit, includeOrders: true, reason: 'trigger_bootstrap' });
    } catch (e: any) { safeLog.warn('drift.trigger.event_index_bootstrap', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      const sweepMs = Math.max(10_000, Number(driftCfg.eventIndexSweepMs ?? 45_000));
      const limit = Math.max(100, Number(driftCfg.eventIndexSweepUsers ?? 1000));
      this.eventIndexSweepTimer = setInterval(() => {
        try { driftEventIndex.bootstrapFromUserMap(this.userMap, { limit, includeOrders: true, reason: 'trigger_sweep' }); } catch (e: any) { safeLog.debug('drift.trigger.event_index_sweep', { error: String(e?.message || e), cat: 'drift' }); }
      }, sweepMs);
    } catch (e: any) { safeLog.warn('drift.trigger.event_index_sweep_timer_setup', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async reportConditionalOrderStats(): Promise<void> {
    if (this.useInfra || !this.userMap) return;
    try {
      const counts = new Map<number, number>();
      let scanned = 0;
      const maxScan = 5000;
      const iter: any = (this as any).userMap?.values?.();
      if (iter && typeof iter[Symbol.iterator] === 'function') {
        for (const u of iter as Iterable<any>) {
          if (this.abort) break;
          if (scanned >= maxScan) break;
          scanned += 1;
          try {
            const ua = (u as any)?.getUserAccount?.();
            const orders: any[] = Array.isArray(ua?.orders) ? ua.orders : [];
            for (const ord of orders) {
              try {
                const ot = ord?.orderType ? (this.sdk as any).getVariant(ord.orderType) : undefined;
                const mi = Number(ord?.marketIndex ?? ord?.market_index ?? -1);
                if (typeof ot === 'string' && ot.toLowerCase().includes('trigger') && Number.isFinite(mi) && mi >= 0) {
                  counts.set(mi, 1 + (counts.get(mi) || 0));
                }
              } catch (e: any) { safeLog.debug('drift.trigger.order_type_parse', { error: String(e?.message || e), cat: 'drift' }); }
            }
          } catch (e: any) { safeLog.debug('drift.trigger.user_account_read', { error: String(e?.message || e), cat: 'drift' }); }
        }
      }
      const sample = Array.from(counts.entries()).slice(0, 10).map(([m, c]) => ({ m, c }));
      logger.info('drift.trigger.cond_orders_stats', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, scanned, markets: counts.size, sample });
    } catch (e: any) { safeLog.debug('drift.trigger.cond_order_stats', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private signatureForNode(nodeToTrigger: any): string {
    try {
      const user = String(nodeToTrigger?.node?.userAccount || '');
      const id = String(nodeToTrigger?.node?.order?.orderId || '');
      return `${user}#${id}`;
    } catch { return Math.random().toString(36).slice(-8); }
  }

  private inAllowlist(idx: number): boolean {
    const list = this.state.marketsAllowlist;
    if (!list || list.length === 0) return true;
    return list.includes(Number(idx));
  }

  private pruneMaps(): void {
    try {
      const now = Date.now();
      if ((now - this.lastPruneAtMs) < 5000) return;
      this.lastPruneAtMs = now;
      const driftCfg: any = (CONFIG as any)?.drift || {};
      const ttlMs = Math.max(1000, Number(driftCfg.nodeMapTtlMs ?? 60000));
      const maxSize = Math.max(1000, Number(driftCfg.nodeMapMax ?? 20000));
      for (const [k, ts] of this.nodesCooldown.entries()) {
        const t = Number(ts || 0);
        if (!Number.isFinite(t) || (now - t) > ttlMs) this.nodesCooldown.delete(k);
      }
      if (this.nodesCooldown.size > maxSize) {
        const entries = Array.from(this.nodesCooldown.entries()).sort((a, b) => (a[1] || 0) - (b[1] || 0));
        const overflow = this.nodesCooldown.size - maxSize;
        for (let i = 0; i < overflow; i += 1) this.nodesCooldown.delete(entries[i][0]);
      }
    } catch (e: any) { safeLog.debug('drift.trigger.prune_maps', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async getMarketLists(): Promise<{ perps: any[]; spots: any[] }> {
    const now = Date.now();
    const driftCfg: any = (CONFIG as any)?.drift || {};
    const ttlMs = Math.max(500, Number(driftCfg.marketCacheTtlMs ?? 2000));
    if (this.cachedPerpMarkets && this.cachedSpotMarkets && (now - this.marketsCacheTs) < ttlMs) {
      return { perps: this.cachedPerpMarkets, spots: this.cachedSpotMarkets };
    }
    const perps = await this.client.getPerpMarketAccounts?.();
    const spots = await this.client.getSpotMarketAccounts?.();
    this.cachedPerpMarkets = Array.isArray(perps) ? perps : [];
    this.cachedSpotMarkets = Array.isArray(spots) ? spots : [];
    this.marketsCacheTs = now;
    return { perps: this.cachedPerpMarkets, spots: this.cachedSpotMarkets };
  }

  private async loop(): Promise<void> {
    if (this.abort) return;
    this.pruneMaps();
    const t0 = Date.now();
    this.state.lastRunAt = t0;
    const driftCfg: any = (CONFIG as any)?.drift || {};
    const verboseNodeLogs = driftCfg?.verboseNodeLogs === true;
    const nodeLogSampleRate = Math.max(0, Math.min(1, Number(driftCfg?.nodeLogSampleRate ?? 0)));
    const shouldLogNode = () => verboseNodeLogs || (nodeLogSampleRate > 0 && Math.random() < nodeLogSampleRate);
    const nodeLogger = verboseNodeLogs ? logger.info : logger.debug;
    const safeNodeLogger = verboseNodeLogs ? safeLog.info : safeLog.debug;

    try {
			const dlob = this.dlobSubscriber?.getDLOB?.();
      if (!dlob && !this.useInfra) return;

      const { MarketType, isVariant, getVariant, BN, getTriggerPrice, useMedianTriggerPrice } = this.sdk;

			let slot = this.slotSubscriber?.getSlot?.() ?? 0;
			const stateAcc = this.client.getStateAccount?.();
			const { perps, spots } = await this.getMarketLists();

      let indexStats = driftEventIndex.getStats();
      let condMarkets: number[] = [];
      if (this.useInfra) {
        try {
          const remote = await fetchEventIndex(Math.max(1, Number(driftCfg?.condMarketsPerLoop ?? 50)));
          if (remote?.stats) indexStats = remote.stats;
          if (Array.isArray(remote?.condMarkets)) condMarkets = remote.condMarkets;
        } catch (e: any) { safeLog.debug('drift.trigger.fetch_event_index', { error: String(e?.message || e), cat: 'drift' }); }
      }
			const userCount = this.useInfra
        ? Number((indexStats as any)?.users ?? 0)
        : (typeof this.userMap?.size === 'function' ? Number(this.userMap.size()) : 0);
			logger.debug('drift.trigger.markets', {
				cat: TRIGGER_CAT,
				subcat: TRIGGER_SUBCAT,
				slot,
				perpCount: Array.isArray(perps) ? perps.length : 0,
				spotCount: Array.isArray(spots) ? spots.length : 0,
				allowlistSize: Array.isArray(this.state.marketsAllowlist) ? this.state.marketsAllowlist.length : 0,
				users: userCount,
			});

			// Sample a subset of users for visibility: open orders and conditional orders per market
			if (!this.useInfra && this.userMap) {
				try {
					const sampleLimit = 25;
					let sampledUsers = 0;
					let totalOpenOrders = 0;
					let totalConditionalOrders = 0;
					const condByMarket = new Map<number, number>();
					const iter: any = this.userMap?.values?.();
					if (iter && typeof iter[Symbol.iterator] === 'function') {
						for (const u of iter as Iterable<any>) {
							if (sampledUsers >= sampleLimit) break;
							try {
								const ua = u?.getUserAccount?.();
								if (!ua) { sampledUsers += 1; continue; }
								const open = Number(ua?.openOrders || 0);
								totalOpenOrders += open;
								const ordersArr: any[] = Array.isArray(ua?.orders) ? ua.orders : [];
								// Include expired/cancelled to improve visibility of presence; filter when counting conditional triggers
								for (const ord of ordersArr) {
									try {
										const ot = ord?.orderType ? getVariant(ord.orderType) : undefined;
										const isTrigger = typeof ot === 'string' && ot.toLowerCase().includes('trigger');
										if (isTrigger) {
											totalConditionalOrders += 1;
											const mi = Number(ord?.marketIndex || ord?.market_index || -1);
											if (Number.isFinite(mi) && mi >= 0) condByMarket.set(mi, 1 + (condByMarket.get(mi) || 0));
										}
									} catch (e: any) { safeLog.debug('drift.trigger.sample_order_parse', { error: String(e?.message || e), cat: 'drift' }); }
								}
								sampledUsers += 1;
							} catch { sampledUsers += 1; }
						}
					}
					const condMarketsSample = Array.from(condByMarket.entries()).slice(0, 10).map(([m, c]) => ({ m, condSample: c }));
					logger.info('drift.trigger.user_sample', {
						cat: TRIGGER_CAT,
						subcat: TRIGGER_SUBCAT,
						sampledUsers,
						totalOpenOrders,
						totalConditionalOrders,
						condMarketsSample,
					});
				} catch (e: any) { safeLog.debug('drift.trigger.user_sample_scan', { error: String(e?.message || e), cat: 'drift' }); }
			}

			let totalNodesPlanned = 0;
			let marketsWithNodes = 0;
			const nodeSamples: Array<{ m: number; t: string; u: string; id: string; cond?: string; otype?: string; ordTp?: string; oracle?: string; trig?: string }> = [];

			// Per-loop in-memory cache to avoid redundant UA reads and refreshes per user
			const uaCache = new Map<string, any>();
      const remoteNodes = this.useInfra ? new Map<string, any[]>() : null;
      let remoteSlot = slot;

			const tryOneMarket = async (market: any, type: any) => {
        const idx = Number(market?.marketIndex || 0);
        if (!this.inAllowlist(idx)) return;
        const typeStr = getVariant(type);
        try {
          let oracleData: any = null;
          let triggerPx: any = null;
          let nodes: any[] = [];
          let nodesRaw: any[] = [];
          if (this.useInfra) {
            const key = `${typeStr}:${idx}`;
            nodes = remoteNodes?.get(key) || [];
          } else {
            oracleData = isVariant(type, 'perp')
              ? this.client.getOracleDataForPerpMarket(idx)
              : this.client.getOracleDataForSpotMarket(idx);

            const freshest = oracleData?.price as any; // BN
            const nowSec = new BN(Math.floor(Date.now() / 1000));
            triggerPx = freshest;
            if (isVariant(type, 'perp')) {
              triggerPx = getTriggerPrice(market, freshest, nowSec, useMedianTriggerPrice(this.client.getStateAccount()));
            }

						// Compute both median-based and raw oracle trigger price paths to compare
						nodes = dlob.findNodesToTrigger(idx, slot, triggerPx, type, stateAcc);
						try {
							const rawTrigger = isVariant(type, 'perp') ? freshest : freshest;
							nodesRaw = dlob.findNodesToTrigger(idx, slot, rawTrigger, type, stateAcc) || [];
						} catch (e: any) { safeLog.debug('drift.trigger.raw_trigger_nodes', { error: String(e?.message || e), cat: 'drift' }); }
          }
					totalNodesPlanned += Array.isArray(nodes) ? nodes.length : 0;
					if (Array.isArray(nodes) && nodes.length > 0) marketsWithNodes += 1;

					let condAbove = 0, condBelow = 0, typeTrigMkt = 0, typeTrigLmt = 0;
					if (Array.isArray(nodes)) {
						for (const n of nodes) {
							try {
								const o = n?.node?.order;
								const cond = o?.triggerCondition ? getVariant(o.triggerCondition) : undefined;
								const ot = o?.orderType ? getVariant(o.orderType) : undefined;
								if (cond === 'above') condAbove += 1;
								else if (cond === 'below') condBelow += 1;
								if (ot === 'triggerMarket') typeTrigMkt += 1;
								else if (ot === 'triggerLimit') typeTrigLmt += 1;
							} catch (e: any) { safeLog.debug('drift.trigger.node_cond_parse', { error: String(e?.message || e), cat: 'drift' }); }
						}
					}

					logger.debug('drift.trigger.market_scan', {
						cat: TRIGGER_CAT,
						subcat: TRIGGER_SUBCAT,
						marketIndex: idx,
						marketType: typeStr,
						nodes: Array.isArray(nodes) ? nodes.length : 0,
						nodesRaw: Array.isArray(nodesRaw) ? nodesRaw.length : 0,
						triggerPrice: this.useInfra ? undefined : String((triggerPx as any)?.toString?.() || triggerPx || ''),
						oraclePrice: this.useInfra ? undefined : String(oracleData?.price?.toString?.() || ''),
						slot,
						condAbove,
						condBelow,
						typeTrigMkt,
						typeTrigLmt,
					});

          let iter = 0;
          for (const node of nodes) {
            iter += 1;
            if ((iter % 50) === 0) { try { await new Promise((r) => setImmediate(r)); } catch { /* timer cleanup safe to swallow */ } }
            const sig = this.signatureForNode(node);
            const last = this.nodesCooldown.get(sig) || 0;
            if (last + COOLDOWN_MS > Date.now()) {
							if (shouldLogNode()) {
								safeNodeLogger('drift.trigger.cooldown_skip', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, signature: sig });
							}
              continue;
            }
            this.nodesCooldown.set(sig, Date.now());
            const orderId = String(node?.node?.order?.orderId || '');
            const userPkStr = String(node?.node?.userAccount || '');
            try { if (userPkStr) driftEventIndex.updateUserMarkets(userPkStr, [idx], 'trigger_node'); } catch (e: any) { safeLog.debug('drift.trigger.update_user_markets', { error: String(e?.message || e), cat: 'drift' }); }
						if (nodeSamples.length < 5) {
							const o = node?.node?.order;
							nodeSamples.push({
								m: idx,
								t: typeStr,
								u: userPkStr,
								id: orderId,
								cond: o?.triggerCondition ? getVariant(o.triggerCondition) : undefined,
								otype: o?.orderType ? getVariant(o.orderType) : undefined,
								ordTp: String(o?.triggerPrice?.toString?.() || ''),
								oracle: String(oracleData?.price?.toString?.() || ''),
								trig: String((triggerPx as any)?.toString?.() || ''),
							});
						}

            if (shouldLogNode()) {
              safeNodeLogger('drift.trigger.try', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId, onChainPrice: String(oracleData?.price?.toString?.() || '') });
            }

            let user: any = null;
            let userAccount: any = null;
            try {
              if (this.useInfra) {
                userAccount = await this.getUserAccountFromInfra(userPkStr);
              } else {
                user = await this.userMap.mustGet(userPkStr);
                userAccount = user?.getUserAccount?.();
              }
            } catch (e: any) { safeLog.warn('drift.trigger.user_lookup', { error: String(e?.message || e), cat: 'drift' }); }
            if (!userAccount) {
              logger.info('drift.trigger.warn user_not_found', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
              continue;
            }

            // Ensure the target order still exists using the latest cached UA from subscriptions;
            // avoid per-node RPC refreshes which can trigger 429s under load.
            try {
              let ua = uaCache.get(userPkStr);
              if (!ua) { ua = userAccount; uaCache.set(userPkStr, ua); }
              const wantId = String(node.node.order?.orderId || '');
              const stillExists = Array.isArray(ua?.orders) && ua.orders.some((o: any) => String(o?.orderId || '') === wantId);
              if (!stillExists) {
                logger.info('drift.trigger.skip_missing_order', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
                continue;
              }
            } catch (e: any) { safeLog.warn('drift.trigger.order_existence_check', { error: String(e?.message || e), cat: 'drift' }); }

            // Dynamic CU limit
            let cuUnits = Math.max(100_000, Number(this.config.cuLimit ?? 220_000));
            try {
              const pos = this.useInfra ? this.countActivePositions(userAccount) : null;
              const activePositions = this.useInfra
                ? (Number(pos?.perp || 0) + Number(pos?.spot || 0))
                : (user.getActivePerpPositions().length + user.getActiveSpotPositions().length);
              const openOrders = Number(userAccount?.openOrders || 0);
              cuUnits += activePositions * 15_000;
              cuUnits += openOrders * 5_000;
            } catch (e: any) { safeLog.debug('drift.trigger.cu_limit_calc', { error: String(e?.message || e), cat: 'drift' }); }

            // Dynamic priority fee
            const suggestedMul = Number(this.client?.txSender?.getSuggestedPriorityFeeMultiplier?.() || 1.0);
            const subPriority = Number(this.priorityFeeSubscriber?.getCustomStrategyResult?.() || 0);
            const baseCfg = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
            const mul = Number(this.config.triggerPriorityFeeMultiplier ?? 1.0);
            const floor = Math.max(0, Number(driftCfg?.triggerPriorityFloorMicroLamports ?? (CONFIG as any)?.fees?.triggerPriorityFloorMicroLamports ?? 10000));
            const priority = computeTriggerPriorityFee({ baseCfg, subPriority, suggestedMul, multiplier: mul, floor });

            // Build ixs
            const buildStart = Date.now();
            let ixs: any[] = [
              ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
              await this.client.getTriggerOrderIx(new PublicKey(userPkStr), userAccount, node.node.order),
            ];

            // Tip prepend (Jito or Sender fallback)
            let plannedTipLamports: number | undefined, plannedTipAccount: string | undefined;
            try {
              if ((CONFIG as any)?.jito?.enabled) {
                const cached = getCachedTipInfo();
                const tipPk = cached?.tipAccount;
                if (tipPk && String(tipPk?.toBase58?.()) !== String(this.client.wallet.publicKey?.toBase58?.())) {
                  const priorityLamportsEst = Math.floor((priority * Math.max(220_000, cuUnits)) / 1_000_000);
                  const cfg = (CONFIG as any)?.jito || {};
                  const fixed = Number(cfg?.fixedTipLamports ?? 0);
                  const share = Number(cfg?.tipShare ?? 0.3);
                  const floor = Number(cached?.tipFloorLamports ?? 0);
                  const estShare = Math.floor((priorityLamportsEst * share) / Math.max(1 - share, 0.01));
                  const tipLamports = Math.max(1000, fixed > 0 ? fixed : (floor || estShare));
                  ixs = [buildTipIx(this.client.wallet.publicKey, tipPk, tipLamports), ...ixs];
                  plannedTipLamports = tipLamports;
                  plannedTipAccount = tipPk.toBase58();
                }
              }
              if ((CONFIG as any)?.sender?.enabled && !(plannedTipLamports && plannedTipAccount)) {
                const scfg = (CONFIG as any).sender || {};
                const accounts: string[] = Array.isArray(scfg.tipAccounts) ? scfg.tipAccounts : [];
                const chosen = accounts.length > 0 ? accounts[Math.floor(Math.random() * accounts.length)] : undefined;
                if (chosen) {
                  const tipPk2 = new PublicKey(chosen);
                  const minTip = Math.max(1000, Number(scfg.minTipLamports || 1_000_000));
                  ixs = [buildTipIx(this.client.wallet.publicKey, tipPk2, minTip), ...ixs];
                  plannedTipLamports = minTip;
                  plannedTipAccount = tipPk2.toBase58();
                }
              }
            } catch (e: any) { safeLog.warn('drift.trigger.tip_calc', { error: String(e?.message || e), cat: 'drift' }); }

            if (this.state.dryRun) {
              logger.info('drift.trigger.dry_run', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, marketIndex: idx, marketType: typeStr });
              continue;
            }
            // Blockhash from shared cache, resilient refresh with fallback across RPCs
            const { getCachedBlockhash, getFreshBlockhashOrFetch } = await import('../utils/blockhash.js');
            let bhStr = getCachedBlockhash(250);
            if (!bhStr) {
              try { bhStr = String(await getFreshBlockhashOrFetch(300) || ''); } catch (e: any) { safeLog.warn('drift.trigger.blockhash_fetch', { error: String(e?.message || e), cat: 'drift' }); }
            }
            if (!bhStr) { logger.info('drift.trigger.defer_no_cached_bh', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT }); continue; }

            // v0 compile with ALTs
            const msg = new TransactionMessage({ payerKey: this.client.wallet.publicKey, recentBlockhash: bhStr, instructions: ixs }).compileToV0Message(this.lookupTableAccounts || []);
            const vtx = new VersionedTransaction(msg);
            vtx.sign([this.client.wallet.payer]);
            const buildMs = Math.max(0, Date.now() - buildStart);

            // Sender/Jito/RPC send path
            const raw = vtx.serialize();
            const base64 = Buffer.from(raw).toString('base64');
            const rpcSend = async () => DriftService.getInstance().sendRawTransaction(raw, { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 0 });
            const beSend = async () => sendToBlockEngine(base64, { beUrl: (CONFIG as any)?.jito?.blockEngineUrl, timeoutMs: (CONFIG as any)?.jito?.bundleTimeoutMs });
            const senderSend = async () => {
              const scfg = (CONFIG as any)?.sender || {};
              let endpoint: string = String(scfg?.endpoint || 'https://sender.helius-rpc.com/fast');
              const params: string[] = [];
              if (scfg?.apiKey) params.push(`api-key=${encodeURIComponent(String(scfg.apiKey))}`);
              if (scfg?.swqosOnly) params.push('swqos_only=true');
              if (params.length > 0) endpoint += (endpoint.includes('?') ? '&' : '?') + params.join('&');
              const body = { jsonrpc: '2.0', id: String(Date.now()), method: 'sendTransaction', params: [ base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 } ] } as any;
              const res = await withRpcLimit(
                () => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
                1,
                { module: 'sender', method: 'sendTransaction' }
              );
              const json = await res.json().catch(() => ({} as any));
              if ((json as any)?.error) throw new Error(String((json as any).error?.message || 'SENDER_ERROR'));
              const sig = String((json as any)?.result || '');
              if (!sig) throw new Error('SENDER_NO_RESULT');
              return sig;
            };

            const preferSender = !!((CONFIG as any)?.sender?.enabled);
            const preferBE = !!((CONFIG as any)?.jito?.enabled) && !!(plannedTipLamports && plannedTipAccount);
            const raceRpc = !!((CONFIG as any)?.jito?.raceRpc);

            try {
              const tSend = Date.now();
              const sentAtMs = tSend;
              let sigTx: string;
              if (preferSender) {
                try { sigTx = await senderSend(); }
                catch {
                  const firstFulfilled = async <T>(arr: Array<Promise<T>>): Promise<T> => {
                    return new Promise<T>((resolve, reject) => {
                      let rejected = 0;
                      let lastErr: any;
                      const n = arr.length;
                      if (n === 0) { reject(new Error('EMPTY_PROMISE_LIST')); return; }
                      for (const p of arr) {
                        Promise.resolve(p).then(resolve, (e) => { rejected += 1; lastErr = e; if (rejected === n) reject(lastErr); });
                      }
                    });
                  };
                  sigTx = await (preferBE ? (raceRpc ? firstFulfilled([ beSend(), rpcSend() ]) : beSend()) : rpcSend());
                }
              } else if (preferBE && raceRpc) {
                const firstFulfilled = async <T>(arr: Array<Promise<T>>): Promise<T> => {
                  return new Promise<T>((resolve, reject) => {
                    let rejected = 0;
                    let lastErr: any;
                    const n = arr.length;
                    if (n === 0) { reject(new Error('EMPTY_PROMISE_LIST')); return; }
                    for (const p of arr) {
                      Promise.resolve(p).then(resolve, (e) => { rejected += 1; lastErr = e; if (rejected === n) reject(lastErr); });
                    }
                  });
                };
                sigTx = await firstFulfilled([ beSend(), rpcSend() ]);
              } else if (preferBE) {
                try { sigTx = await beSend(); } catch { sigTx = await rpcSend(); }
              } else {
                sigTx = await rpcSend();
              }
              const sendMs = Math.max(0, Date.now() - tSend);

              this.triggersInWindow.push(Date.now());
              logger.info('drift.trigger.ok', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, sig: sigTx, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId });
              try {
                hotlist.markMarket(idx, 'trigger');
                hotlist.markUser(userPkStr, 'trigger');
              } catch (e: any) { safeLog.debug('drift.trigger.hotlist_mark', { error: String(e?.message || e), cat: 'drift' }); }
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'trigger',
                  marketIndex: idx,
                  taker: userPkStr,
                  orderId,
                  priorityFeeMicroLamports: priority,
                  cuLimit: cuUnits,
                  bot: this.botKey,
                  buildMs,
                  sendMs,
                  sentAtMs,
                }).catch(() => {});
              } catch (e: any) { safeLog.debug('drift.trigger.tx_tracker', { error: String(e?.message || e), cat: 'drift' }); }
            } catch (e: any) {
              const logs = (e?.logs && Array.isArray(e.logs)) ? e.logs : undefined;
              logger.info('drift.trigger.error send_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, err: String(e?.message || e), logs });
            }
          }
        } catch (e: any) {
          logger.info('drift.trigger.warn market_loop_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, err: String(e?.message || e) });
        }
      };

      const hotMarkets = hotlist.getHotMarkets({
        limit: Math.max(1, Number(driftCfg?.hotMarketsPerLoop ?? 25)),
        consumerId: 'trigger',
      });
      if (!this.useInfra) {
        condMarkets = driftEventIndex.getMarketsWithConditionalOrders(Math.max(1, Number(driftCfg?.condMarketsPerLoop ?? 50)));
        indexStats = driftEventIndex.getStats();
      }
      const prioritySet = new Set<number>();
      for (const idx of hotMarkets) prioritySet.add(Number(idx));
      for (const idx of condMarkets) prioritySet.add(Number(idx));
      const fullScanEveryMs = Math.max(10_000, Number(driftCfg?.eventIndexFullScanMs ?? 30_000));
      const doFullScan = prioritySet.size === 0 || ((Date.now() - this.lastFullScanAt) > fullScanEveryMs);
      if (doFullScan) this.lastFullScanAt = Date.now();
      if (hotMarkets.length > 0) {
        safeLog.debug('drift.trigger.hotlist', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, count: hotMarkets.length });
      }
      if (condMarkets.length > 0) {
        safeLog.debug('drift.trigger.cond_markets', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, count: condMarkets.length });
      }
      const processed = new Set<number>();
      const perpByIndex = new Map<number, any>();
      const spotByIndex = new Map<number, any>();
      for (const m of (Array.isArray(perps) ? perps : [])) {
        perpByIndex.set(Number(m?.marketIndex || 0), m);
      }
      for (const m of (Array.isArray(spots) ? spots : [])) {
        spotByIndex.set(Number(m?.marketIndex || 0), m);
      }
      if (this.useInfra && remoteNodes) {
        try {
          const seenKeys = new Set<string>();
          const req: Array<{ marketIndex: number; marketType: string }> = [];
          const pushReq = (idx: number, typeStr: string) => {
            const key = `${typeStr}:${idx}`;
            if (seenKeys.has(key)) return;
            seenKeys.add(key);
            req.push({ marketIndex: idx, marketType: typeStr });
          };
          for (const idx of prioritySet) {
            if (!Number.isFinite(Number(idx))) continue;
            if (perpByIndex.has(Number(idx))) pushReq(Number(idx), 'perp');
            else if (spotByIndex.has(Number(idx))) pushReq(Number(idx), 'spot');
          }
          if (doFullScan) {
            for (const m of (Array.isArray(perps) ? perps : [])) pushReq(Number(m?.marketIndex || 0), 'perp');
            for (const m of (Array.isArray(spots) ? spots : [])) pushReq(Number(m?.marketIndex || 0), 'spot');
          }
          const chunkSize = 40;
          for (let i = 0; i < req.length; i += chunkSize) {
            const chunk = req.slice(i, i + chunkSize);
            const resp = await fetchTriggerNodes({ markets: chunk });
            if (typeof resp?.slot === 'number') remoteSlot = resp.slot;
            const results = Array.isArray(resp?.results) ? resp.results : [];
            for (const r of results) {
              const idx = Number(r?.marketIndex);
              const typeStr = String(r?.marketType || '').toLowerCase() === 'spot' ? 'spot' : 'perp';
              remoteNodes.set(`${typeStr}:${idx}`, Array.isArray(r?.nodes) ? r.nodes : []);
            }
          }
          if (remoteSlot > 0) slot = remoteSlot;
        } catch (e: any) { safeLog.warn('drift.trigger.remote_nodes_fetch', { error: String(e?.message || e), cat: 'drift' }); }
      }
      for (const idx of prioritySet) {
        if (!Number.isFinite(Number(idx))) continue;
        const perpM = perpByIndex.get(Number(idx));
        const spotM = spotByIndex.get(Number(idx));
        if (perpM) { await tryOneMarket(perpM, MarketType.PERP); processed.add(Number(idx)); continue; }
        if (spotM) { await tryOneMarket(spotM, MarketType.SPOT); processed.add(Number(idx)); continue; }
      }
      if (doFullScan) {
        await Promise.all([
          ...(Array.isArray(perps) ? perps.filter((m: any) => !processed.has(Number(m?.marketIndex || 0))).map((m: any) => tryOneMarket(m, MarketType.PERP)) : []),
          ...(Array.isArray(spots) ? spots.filter((m: any) => !processed.has(Number(m?.marketIndex || 0))).map((m: any) => tryOneMarket(m, MarketType.SPOT)) : []),
        ]);
      }

			const dur = Date.now() - t0;
      if (this._summary) {
        this._summary.loops += 1;
        this._summary.totalNodesPlanned += totalNodesPlanned;
        this._summary.marketsWithNodes += marketsWithNodes;
        this._summary.priorityMarkets += prioritySet.size;
        this._summary.scanModes[doFullScan ? 'full' : 'targeted'] += 1;
        this._summary.users = userCount;
        this._summary.slot = slot;
        this._summary.indexStats = indexStats;
        this._summary.triggersLastMin = this.getStatus().triggersLastMin;
        this._summary.lastMs = dur;
        if (nodeSamples.length > 0) this._summary.lastSample = nodeSamples;
      }
      if (!this.summaryOnly) {
        logger.info('drift.trigger.loop', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, ms: dur, name: this.state.name });
        logger.info('drift.trigger.loop_summary', {
          cat: TRIGGER_CAT,
          subcat: TRIGGER_SUBCAT,
          ms: dur,
          slot,
          users: userCount,
          totalNodesPlanned,
          marketsWithNodes,
          scanMode: doFullScan ? 'full' : 'targeted',
          priorityMarkets: prioritySet.size,
          index: indexStats,
          triggersLastMin: this.getStatus().triggersLastMin,
          sample: nodeSamples,
        });
      }
    } catch (e: any) {
      this.state.lastError = String(e?.message || e);
      logger.info('drift.trigger.error loop_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, err: this.state.lastError });
    }
  }
}

export class DriftTriggerRegistry {
  private static reg = new RunnerRegistry<DriftTriggerRunner>();
  static keyOf(cfg: TriggerConfig): string {
    return cfg?.name ? `trg#${cfg.name}` : 'trg#default';
  }
  static upsert(cfg: TriggerConfig): DriftTriggerRunner {
    const key = this.keyOf(cfg);
    return this.reg.upsert(key, () => new DriftTriggerRunner(cfg));
  }
  static get(key: string): DriftTriggerRunner | undefined { return this.reg.get(key); }
  static list(): Array<{ key: string; status: TriggerRuntimeState }> { return this.reg.list(); }
  static async start(key: string): Promise<boolean> { return this.reg.start(key); }
  static stop(key: string): boolean { return this.reg.stop(key); }
  static remove(key: string): boolean { return this.reg.remove(key); }
}
