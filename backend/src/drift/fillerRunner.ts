import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { buildTipIx } from '../execution/jitoTip.js';
import { startTipFeed, getCachedTipInfo } from '../execution/jitoTipCache.js';
import { sendToBlockEngine } from '../execution/jitoClient.js';
import { getCachedBlockhash } from '../utils/blockhash.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
import { hotlist } from './hotlist.js';
import { driftEventIndex } from './eventIndex.js';
import { OracleUpdater } from './oracles/oracleUpdater.js';
import { logger } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';
import { CONFIG } from '../utils/config.js';
import { getPriceByMint } from '../server/priceStore.js';
import { hasInfra, fetchFillNodes, fetchUserAccounts, fetchEventIndex, waitForInfraReady } from './infraClient.js';

export type FillerConfig = {
  name: string;
  enabled: boolean;
  dryRun?: boolean;
  subaccountId?: number;
  intervalMs?: number; // default 1200
  cuLimit?: number; // default 1_000_000
  priorityFeeMicroLamports?: number; // default 0
  marketsAllowlist?: Array<number> | string[]; // optional allowlist
  maxMakersPerFill?: number; // default 2
  allowAmmFills?: boolean; // default true
  // Heuristics to avoid JIT place-and-make fills
  skipYoungOrderMs?: number;
  requireExistingMakers?: boolean;
  minMakerCountPerNode?: number;
  denyJitTakersTtlMs?: number;
  minTipFloorToAttemptLamports?: number;
  // Profitability / sizing gates
  minNotionalQuote?: number; // min notional in quote (e.g., USDC)
  minRemainingBase?: number; // min remaining base (native units, e.g., SOL)
  rewardShare?: number; // fraction (0..1) of taker fee attributed to filler reward
  minRewardQuote?: number; // min estimated reward in quote
  minProfitQuote?: number; // min estimated profit in quote (reward - cost)
  minRewardToCostRatio?: number; // min reward/cost ratio when cost is known
  maxCandidatesPerLoop?: number; // cap for top-N scoring
  rankBy?: 'profit' | 'reward' | 'notional';
  // Prebuild controls
  prebuildEnabled?: boolean;
  prebuildDistanceBps?: number; // widen bid/ask by this bps for near-fill prebuild
  prebuildTtlMs?: number;
  prebuildMaxCandidates?: number;
  prebuildMaxInFlight?: number;
  prebuildPerLoop?: number;
};

type FillerRuntimeState = {
  running: boolean;
  name: string;
  dryRun: boolean;
  subaccountId: number;
  loopIntervalMs: number;
  lastRunAt?: number;
  lastError?: string;
  fillsLastMin: number;
  marketsAllowlist?: number[];
};

type PreparedFill = {
  sig: string;
  marketIndex: number;
  orderId: string;
  taker: string;
  createdAt: number;
  expiresAt: number;
  takerUa: any;
  takerUserPk: PublicKey;
  makerInfos: any[];
  makerKeys: string[];
  fillIx: any;
};

const FILLER_CAT = 'drift';
const FILLER_SUBCAT = 'filler';
const COOLDOWN_MS = 100;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

export class DriftFillerRunner {
  private timer: any | null = null;
  private config: FillerConfig;
  private state: FillerRuntimeState;
  private abort = false;
  private inLoop: boolean = false;
  private botKey: string;

  private sdk: any | null = null;
  private client: any | null = null;
  private connection: any | null = null;
  private pollLoader: any | null = null;
  private blockhashSubscriber: any | null = null; // legacy; superseded by shared utils/blockhash
  private priorityFeeSubscriber: any | null = null;
  private lookupTableAccounts: AddressLookupTableAccount[] | null = null;
  private useInfra: boolean = false;
  private infraUaCache: Map<string, { ua: any; ts: number }> = new Map();

  slotSubscriber: any | null = null;
  eventSubscriber: any | null = null;
  userMap: any | null = null;
  dlobSubscriber: any | null = null;

  // Runtime maps for JIT-avoidance heuristics
  private nodeSeenAtMs: Map<string, number> = new Map();
  private jitTakerCooldown: Map<string, number> = new Map();
  orderSubscriber: any | null = null;
  private oracleUpdater: OracleUpdater | null = null;

  private nodesCooldown: Map<string, number> = new Map();
  private fillsInWindow: number[] = [];
  private skipLogCount: Map<number, { n: number; ts: number }> = new Map();
  private preparedFills: Map<string, PreparedFill> = new Map();
  private prebuildInFlight: number = 0;
  private lastLoopStats: any | null = null;
  private prebuildStats: { built: number; hit: number; miss: number; expired: number } = { built: 0, hit: 0, miss: 0, expired: 0 };
  private altRefreshTimer: any | null = null;
  private dlobUnavailableCount: number = 0;
  private wsNudgeTimer: any | null = null;
  private dlobWsFallback: any | null = null;
  private bhWarmTimer: any | null = null;
  private bhCacheStr: string | undefined = undefined;
  private bhCacheTs: number = 0;
  private lastPruneAtMs: number = 0;
  private beFailCount: number = 0;
  private beCoolUntilMs: number = 0;
  private lastUpdateFillerMs: number = 0;
  private lastFullScanAt: number = 0;
  private eventIndexSweepTimer: any | null = null;
  private eventIndexBound: boolean = false;
  // Per-loop stats
  private _loopStatsTmp: any | null = null;
  private _summary: { since: number; loops: number; planned: number; sent: number; processed: number; skipped: Record<string, number>; markets: { total: number; paused: number; oracleStale: number }; scanModes?: { full: number; targeted: number }; indexStats?: { users: number; markets: number; marketToOrders: number } } | null = null;
  private _summaryTimer: any | null = null;

  constructor(cfg: FillerConfig) {
    const allowlist = Array.isArray(cfg?.marketsAllowlist)
      ? (cfg!.marketsAllowlist as any[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : undefined;
    this.config = { ...cfg, marketsAllowlist: allowlist } as FillerConfig;
    this.state = {
      running: false,
      name: String(cfg?.name || 'default'),
      dryRun: !!cfg?.dryRun,
      subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : (0 as number),
      loopIntervalMs: Math.max(250, Number(cfg?.intervalMs ?? 300)),
      fillsLastMin: 0,
      marketsAllowlist: allowlist,
    };
    this.botKey = `fil#${this.state.name}`;
  }

  getStatus(): FillerRuntimeState {
    const cutoff = Date.now() - 60_000;
    this.fillsInWindow = this.fillsInWindow.filter((t) => t >= cutoff);
    const cfg: any = this.config || {};
    // Expose heuristic settings for UI visibility (typed as any to avoid widening FillerRuntimeState)
    return {
      ...this.state,
      fillsLastMin: this.fillsInWindow.length,
      lastLoop: this.lastLoopStats,
      prebuildCache: this.preparedFills.size,
      prebuildStats: this.prebuildStats,
      minNotionalQuote: cfg.minNotionalQuote,
      minRemainingBase: cfg.minRemainingBase,
      rewardShare: cfg.rewardShare,
      minRewardQuote: cfg.minRewardQuote,
      minProfitQuote: cfg.minProfitQuote,
      minRewardToCostRatio: cfg.minRewardToCostRatio,
      maxCandidatesPerLoop: cfg.maxCandidatesPerLoop,
      rankBy: cfg.rankBy,
      prebuildEnabled: cfg.prebuildEnabled,
      prebuildDistanceBps: cfg.prebuildDistanceBps,
      prebuildTtlMs: cfg.prebuildTtlMs,
      prebuildMaxCandidates: cfg.prebuildMaxCandidates,
      prebuildMaxInFlight: cfg.prebuildMaxInFlight,
      prebuildPerLoop: cfg.prebuildPerLoop,
    } as any as FillerRuntimeState & {
      skipYoungOrderMs?: number;
      requireExistingMakers?: boolean;
      minMakerCountPerNode?: number;
      denyJitTakersTtlMs?: number;
      minTipFloorToAttemptLamports?: number;
    };
  }

  private async getUserAccountFromInfra(pubkey: string): Promise<any | null> {
    if (!this.useInfra) return null;
    const now = Date.now();
    const cached = this.infraUaCache.get(pubkey);
    if (cached && (now - cached.ts) < 2000) return cached.ua;
    try {
      const res = await fetchUserAccounts([pubkey]);
      const data = res?.accounts?.[pubkey]?.data;
      if (!data) return null;
      const { decodeUser } = await import('@drift-labs/sdk');
      const ua = decodeUser(Buffer.from(String(data), 'base64'));
      this.infraUaCache.set(pubkey, { ua, ts: now });
      return ua;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.abort = false;
    this.state.running = true;

    logger.info('drift.filler.start', {
      cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name,
      dryRun: this.state.dryRun, loopMs: this.state.loopIntervalMs,
      allowlist: this.state.marketsAllowlist,
    });

    try {
      const svc = DriftService.getInstance() as any;
      (svc as any).registerBot?.(this.botKey);
      await (svc as any).init?.();
    } catch (e: any) { safeLog.warn('drift.filler.service_init', { error: String(e?.message || e), cat: 'drift' }); }
    const svc: any = DriftService.getInstance();
    this.connection = (svc as any).connection;
    this.client = (svc as any).client;
    if (!this.client || !this.connection) {
      this.state.lastError = 'CLIENT_OR_CONNECTION_UNAVAILABLE';
      logger.info('drift.filler.error client_or_connection_unavailable', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
      throw new Error('Drift client or connection unavailable');
    }

    // Shared blockhash warmer is initialized via DriftService.getSharedInfra

    try {
      if (Number.isFinite(this.state.subaccountId)) {
        await (svc as any).switchSubaccount?.(Number(this.state.subaccountId));
        logger.info('drift.filler.subaccount_selected', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, subaccountId: this.state.subaccountId });
      }
    } catch (e: any) {
      logger.info('drift.filler.warn subaccount_switch_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, err: String(e?.message || e) });
    }

    this.sdk = await import('@drift-labs/sdk');
    this.useInfra = hasInfra();
    // Configure throttle early (reduced gaps, higher concurrency for lower latency)
    try { (svc as any).configureTxThrottle?.({ minGapMs: 30, maxInFlight: 8 }); } catch (e: any) { safeLog.warn('drift.filler.configure_throttle', { error: String(e?.message || e), cat: 'drift' }); }

    // Kick off discovery after infra warmup, then start timers
    setImmediate(async () => {
      try {
        const driftCfg: any = (CONFIG as any)?.drift || {};
        const svcGate: any = DriftService.getInstance();
        const requireWarm = driftCfg?.warmupRequireBeforeBots !== false;
        if (requireWarm) {
          if (this.useInfra) {
            const ok = await waitForInfraReady(Number(driftCfg?.infraReadyTimeoutMs ?? driftCfg?.warmupTimeoutMs ?? 30000));
            safeLog.info('drift.filler.infra_gate', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, ok });
          } else {
            const ok = await (svcGate as any).waitForWarmup?.(Number(driftCfg?.warmupTimeoutMs ?? 30000));
            safeLog.info('drift.filler.warmup_gate', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, ok });
          }
        }
        const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
        await withRpcTimeout(this.initDiscovery(), 5000, 'initDiscovery');
      } catch (e: any) {
        safeLog.warn('drift.filler.discovery_degraded', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) });
      }
      // Start backstop loop timer only after discovery
      const tick = async () => {
        if (this.abort || this.inLoop) return;
        this.inLoop = true;
        try { await this.loop(); }
        finally { this.inLoop = false; }
      };
      this.timer = setInterval(() => { tick().catch(() => {}); }, this.state.loopIntervalMs);
      logger.info('drift.filler.started', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, loopMs: this.state.loopIntervalMs });
      // Start periodic summary logger when enabled
      try {
        const driftCfg: any = (CONFIG as any)?.drift || {};
        const summaryOnly = !!driftCfg?.loopSummaryOnly;
        const every = Math.max(2000, Number(driftCfg?.loopSummaryIntervalMs ?? 10000));
        if (summaryOnly) {
          if (this._summaryTimer) { try { clearInterval(this._summaryTimer); } catch { /* timer cleanup safe to swallow */ } this._summaryTimer = null; }
          if (!this._summary) this._summary = { since: Date.now(), loops: 0, planned: 0, sent: 0, processed: 0, skipped: {}, markets: { total: 0, paused: 0, oracleStale: 0 }, scanModes: { full: 0, targeted: 0 } };
          this._summaryTimer = setInterval(() => {
            try {
              const s = this._summary!;
              logger.info('drift.filler.loop_summary_10s', {
                cat: FILLER_CAT,
                subcat: FILLER_SUBCAT,
                name: this.state.name,
                windowMs: Date.now() - s.since,
                loops: s.loops,
                planned: s.planned,
                processed: s.processed,
                sent: s.sent,
                skipped: s.skipped,
                markets: s.markets,
                scanModes: s.scanModes,
                index: s.indexStats,
              });
              this._summary = { since: Date.now(), loops: 0, planned: 0, sent: 0, processed: 0, skipped: {}, markets: { total: 0, paused: 0, oracleStale: 0 }, scanModes: { full: 0, targeted: 0 } };
            } catch (e: any) { safeLog.debug('drift.filler.loop_summary_emit', { error: String(e?.message || e), cat: 'drift' }); }
          }, every);
        }
      } catch (e: any) { safeLog.warn('drift.filler.summary_timer_init', { error: String(e?.message || e), cat: 'drift' }); }
      // Slot-driven tick once slotSubscriber is available
      try {
        const onSlot = () => { try { setImmediate(() => { tick().catch(() => {}); }); } catch { /* noop */ } };
        if (typeof (this.slotSubscriber?.onSlotChange) === 'function') {
          this.slotSubscriber.onSlotChange(onSlot, 1);
        } else {
          this.slotSubscriber?.eventEmitter?.on?.('slotUpdate', onSlot);
        }
      } catch (e: any) { safeLog.warn('drift.filler.slot_subscriber_init', { error: String(e?.message || e), cat: 'drift' }); }
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    if (this.bhWarmTimer) { try { clearInterval(this.bhWarmTimer); } catch { /* timer cleanup safe to swallow */ } this.bhWarmTimer = null; }
    if (this.altRefreshTimer) { try { clearInterval(this.altRefreshTimer); } catch { /* timer cleanup safe to swallow */ } this.altRefreshTimer = null; }
    if (this.wsNudgeTimer) { try { clearInterval(this.wsNudgeTimer); } catch { /* timer cleanup safe to swallow */ } this.wsNudgeTimer = null; }
    if (this.eventIndexSweepTimer) { try { clearInterval(this.eventIndexSweepTimer); } catch { /* timer cleanup safe to swallow */ } this.eventIndexSweepTimer = null; }
    this.state.running = false;
    this.abort = true;
    logger.info('drift.filler.stopped', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
    try { (DriftService.getInstance() as any).unregisterBot?.(this.botKey); } catch (e: any) { safeLog.debug('drift.filler.unregister_bot', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    if (!this.useInfra) {
      const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(100, Math.floor(this.state.loopIntervalMs / 2)), preferOrderSubscriber: true });
      this.slotSubscriber = (infra as any).slotSubscriber;
      this.eventSubscriber = (infra as any).eventSubscriber;
      this.userMap = (infra as any).userMap;
      this.dlobSubscriber = (infra as any).dlobSubscriber;
      this.orderSubscriber = (infra as any).orderSubscriber;
      logger.info('drift.filler.usermap_dlob_ready', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, shared: true });
    } else {
      safeLog.info('drift.filler.infra_remote', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
    }
    try {
      if (!this.oracleUpdater) {
        this.oracleUpdater = new OracleUpdater({ sdk: this.sdk, driftClient: this.client, cluster: (CONFIG as any)?.drift?.cluster || 'mainnet-beta' });
      }
    } catch (e: any) { safeLog.warn('drift.filler.oracle_updater_init', { error: String(e?.message || e), cat: 'drift' }); }
    // Start user prefetcher once shared infra is ready
    if (!this.useInfra) {
      try { await (svc as any).startUserPrefetcher?.(this.dlobSubscriber, this.userMap); } catch (e: any) { safeLog.warn('drift.filler.start_user_prefetcher', { error: String(e?.message || e), cat: 'drift' }); }
      try { this.setupEventIndex(); } catch (e: any) { safeLog.warn('drift.filler.setup_event_index', { error: String(e?.message || e), cat: 'drift' }); }
    }
    // Initialize blockhash subscriber and priority fee strategy
    try {
      const { BlockhashSubscriber, PriorityFeeSubscriber } = this.sdk || {};
      // Shared blockhash warmer is started from DriftService.getSharedInfra; keep SDK subscriber optional
      if (BlockhashSubscriber) {
        try {
          this.blockhashSubscriber = new BlockhashSubscriber(this.connection);
          const { waitUntilWsReady } = await import('./wsHelper.js');
          if (this.connection) await waitUntilWsReady(this.connection, 'fillerRunner.init.blockhash');
          
          // Import RPC limiter for tracking
          const { withRpcLimit } = await import('../utils/rpcLimiter.js');
          
          // Wrap subscribe call with RPC tracking
          await withRpcLimit(
            () => this.blockhashSubscriber.subscribe(),
            1,
            { module: 'drift', method: 'slotSubscribe' }
          );
        } catch (e: any) { safeLog.warn('drift.filler.blockhash_subscriber_init', { error: String(e?.message || e), cat: 'drift' }); }
      }
      if (PriorityFeeSubscriber) {
        this.priorityFeeSubscriber = new PriorityFeeSubscriber({
          connection: this.connection,
          fallbackPriorityFeeMicroLamports: Math.max(1000, Number(((CONFIG as any)?.fees?.priorityFee) || 1000)),
        });
        const { waitUntilWsReady } = await import('./wsHelper.js');
        if (this.connection) await waitUntilWsReady(this.connection, 'fillerRunner.init.priorityFee');
        
        // Import RPC limiter and debouncing
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        
        // Wrap subscribe call with debouncing and RPC tracking
        await withDebounce(
          'fillerRunner:priorityFeeSubscriber:subscribe',
          async () => {
            return await withRpcLimit(
              () => this.priorityFeeSubscriber.subscribe(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        
        try {
          this.priorityFeeSubscriber.updateAddresses([
            new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
            new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W'),
            this.client?.program?.programId,
          ].filter(Boolean));
        } catch (e: any) { safeLog.warn('drift.filler.priority_fee_addresses', { error: String(e?.message || e), cat: 'drift' }); }
      }
    } catch (e: any) { safeLog.warn('drift.filler.subscriber_init', { error: String(e?.message || e), cat: 'drift' }); }
    // Preload ALTs for v0
    try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch { this.lookupTableAccounts = []; }
    // Periodic ALT refresh
    try {
      const every = Math.max(60_000, Number(((CONFIG as any)?.drift?.altRefreshMs) ?? 300_000));
      if (this.altRefreshTimer) { try { clearInterval(this.altRefreshTimer); } catch { /* timer cleanup safe to swallow */ } }
      this.altRefreshTimer = setInterval(async () => {
        try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch (e: any) { safeLog.debug('drift.filler.alt_fetch', { error: String(e?.message || e), cat: 'drift' }); }
      }, every);
    } catch (e: any) { safeLog.warn('drift.filler.alt_refresh_timer_init', { error: String(e?.message || e), cat: 'drift' }); }
    // Blockhash warming is provided by shared utils/blockhash via DriftService
    // Sender / RPC connection warming ping
    try {
      if (this.wsNudgeTimer) { try { clearInterval(this.wsNudgeTimer); } catch { /* timer cleanup safe to swallow */ } this.wsNudgeTimer = null; }
      const pingEveryMs = Math.max(30_000, Number(((CONFIG as any)?.sender?.pingIntervalMs) ?? 60_000));
      const doPing = async () => {
        try {
          // Warm Sender endpoint
          if ((CONFIG as any)?.sender?.enabled) {
            let endpoint: string = String(((CONFIG as any)?.sender?.endpoint) || 'https://sender.helius-rpc.com/fast');
            const params: string[] = [];
            const scfg = (CONFIG as any)?.sender || {};
            if (scfg?.apiKey) params.push(`api-key=${encodeURIComponent(String(scfg.apiKey))}`);
            if (scfg?.swqosOnly) params.push('swqos_only=true');
            if (params.length > 0) endpoint += (endpoint.includes('?') ? '&' : '?') + params.join('&');
            try { await fetch(endpoint.replace(/\/fast$/, '/ping'), { method: 'GET' }); } catch (e: any) { safeLog.debug('drift.filler.sender_ping', { error: String(e?.message || e), cat: 'drift' }); }
          }
          // Warm Helius RPC via a cheap call
          try { 
            const { withRpcLimit } = await import('../utils/rpcLimiter.js');
            await withRpcLimit(() => this.connection.getBlockHeight('processed'), 1, { module: 'drift', method: 'getBlockHeight' }); 
          } catch (e: any) { safeLog.debug('drift.filler.rpc_warmup', { error: String(e?.message || e), cat: 'drift' }); }
        } catch (e: any) { safeLog.debug('drift.filler.warmup_ping', { error: String(e?.message || e), cat: 'drift' }); }
      };
      doPing().catch(() => {});
      this.wsNudgeTimer = setInterval(() => { doPing().catch(() => {}); }, pingEveryMs);
    } catch (e: any) { safeLog.warn('drift.filler.ws_nudge_timer_init', { error: String(e?.message || e), cat: 'drift' }); }
    // Start Jito tip feed cache (non-blocking)
    try { startTipFeed(Math.max(10_000, Number(((CONFIG as any)?.jito?.tipRefreshMs) ?? 15_000))); } catch (e: any) { safeLog.warn('drift.filler.tip_feed_init', { error: String(e?.message || e), cat: 'drift' }); }
    // Prepare WS fallback (lazy start on degradation)
    try { this.dlobWsFallback = null; } catch { /* assignment safe to swallow */ }
  }

  private signatureForNode(nodeToFill: any): string {
    try {
      const taker = String(nodeToFill?.node?.userAccount || '');
      const id = String(nodeToFill?.node?.order?.orderId || '');
      return `${taker}#${id}`;
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
      const pruneByTs = <T>(map: Map<string, T>, getTs: (v: T) => number) => {
        for (const [k, v] of map.entries()) {
          const ts = Number(getTs(v) || 0);
          if (!Number.isFinite(ts) || (now - ts) > ttlMs) map.delete(k);
        }
        if (map.size > maxSize) {
          const entries = Array.from(map.entries()).sort((a, b) => (getTs(a[1]) || 0) - (getTs(b[1]) || 0));
          const overflow = map.size - maxSize;
          for (let i = 0; i < overflow; i += 1) map.delete(entries[i][0]);
        }
      };
      const pruneByExpiry = (map: Map<string, number>) => {
        for (const [k, untilMs] of map.entries()) {
          const until = Number(untilMs || 0);
          if (!Number.isFinite(until) || (until + ttlMs) < now) map.delete(k);
        }
        if (map.size > maxSize) {
          const entries = Array.from(map.entries()).sort((a, b) => (a[1] || 0) - (b[1] || 0));
          const overflow = map.size - maxSize;
          for (let i = 0; i < overflow; i += 1) map.delete(entries[i][0]);
        }
      };
      pruneByTs(this.nodesCooldown as any, (v: any) => Number(v || 0));
      pruneByTs(this.nodeSeenAtMs as any, (v: any) => Number(v || 0));
      pruneByExpiry(this.jitTakerCooldown as any);
      pruneByTs(this.skipLogCount as any, (v: any) => Number(v?.ts || 0));
      // Prune prepared fills (TTL + max size)
      try {
        const ttlMs = Math.max(200, Number(this.config.prebuildTtlMs ?? 1500));
        const maxPrepared = Math.max(50, Number(this.config.prebuildMaxCandidates ?? 200));
        for (const [k, v] of this.preparedFills.entries()) {
          const exp = Number((v as any)?.expiresAt || 0);
          const age = Number((v as any)?.createdAt || 0);
          if ((exp && exp < now) || (age && (now - age) > ttlMs)) {
            this.preparedFills.delete(k);
            this.prebuildStats.expired += 1;
          }
        }
        if (this.preparedFills.size > maxPrepared) {
          const entries = Array.from(this.preparedFills.entries()).sort((a, b) => Number((a[1] as any)?.createdAt || 0) - Number((b[1] as any)?.createdAt || 0));
          const overflow = this.preparedFills.size - maxPrepared;
          for (let i = 0; i < overflow; i += 1) {
            this.preparedFills.delete(entries[i][0]);
          }
        }
      } catch (e: any) { safeLog.debug('drift.filler.prune_prepared_fills', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.debug('drift.filler.prune_maps', { error: String(e?.message || e), cat: 'drift' }); }
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
    } catch (e: any) { safeLog.warn('drift.filler.event_index_configure', { error: String(e?.message || e), cat: 'drift' }); }
    try { driftEventIndex.bindEventSubscriber(this.eventSubscriber); } catch (e: any) { safeLog.warn('drift.filler.event_index_bind', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      const limit = Math.max(100, Number(driftCfg.eventIndexBootstrapUsers ?? 2000));
      driftEventIndex.bootstrapFromUserMap(this.userMap, { limit, includeOrders: false, reason: 'filler_bootstrap' });
    } catch (e: any) { safeLog.warn('drift.filler.event_index_bootstrap', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      const sweepMs = Math.max(10_000, Number(driftCfg.eventIndexSweepMs ?? 45_000));
      const limit = Math.max(100, Number(driftCfg.eventIndexSweepUsers ?? 1000));
      this.eventIndexSweepTimer = setInterval(() => {
        try { driftEventIndex.bootstrapFromUserMap(this.userMap, { limit, includeOrders: false, reason: 'filler_sweep' }); } catch (e: any) { safeLog.debug('drift.filler.event_index_sweep', { error: String(e?.message || e), cat: 'drift' }); }
      }, sweepMs);
    } catch (e: any) { safeLog.warn('drift.filler.event_index_sweep_timer', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private getSolPriceUsd(): number | undefined {
    try {
      const sol = getPriceByMint(SOL_MINT);
      const usd = Number(sol?.usdc ?? 0);
      return Number.isFinite(usd) && usd > 0 ? usd : undefined;
    } catch { return undefined; }
  }

  private getBestBlockhash(maxAgeMs = 250, maxAgeSlots = 5): string | undefined {
    try {
      const bh = this.blockhashSubscriber?.getLatestBlockhash?.(maxAgeSlots);
      const v = String((bh as any)?.blockhash || '');
      if (v) return v;
    } catch (e: any) { safeLog.debug('drift.filler.blockhash_query', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      return getCachedBlockhash(maxAgeMs) || this.bhCacheStr;
    } catch {
      return this.bhCacheStr;
    }
  }

  private async getTakerUaQuick(takerPkStr: string): Promise<any | null> {
    if (this.useInfra) {
      return await this.getUserAccountFromInfra(takerPkStr);
    }
    // Warm cache first
    try {
      const warm = (DriftService.getInstance() as any).getWarmUser?.(takerPkStr);
      const ua = warm?.getUserAccount?.();
      if (ua) return ua;
    } catch (e: any) { safeLog.debug('drift.filler.warm_user_lookup', { error: String(e?.message || e), cat: 'drift' }); }
    // Try userMap quickly, but keep very tight bound
    try {
      const wrap = await Promise.race([
        this.userMap.mustGet(takerPkStr),
        new Promise((_, rej) => setTimeout(() => rej(new Error('UA_TIMEOUT')), 180)),
      ]).catch(() => null);
      const ua = (wrap as any)?.getUserAccount?.();
      if (ua) return ua;
    } catch (e: any) { safeLog.debug('drift.filler.usermap_lookup', { error: String(e?.message || e), cat: 'drift' }); }
    return null;
  }

  private async buildMakerInfos(makers: string[], nodeToFill: any): Promise<any[]> {
    const makerInfos: any[] = [];
    for (const m of makers) {
      try {
        let makerUa: any = null;
        if (this.useInfra) {
          makerUa = await this.getUserAccountFromInfra(m);
        } else {
          // Try warm cache first
          try {
            const warm = (DriftService.getInstance() as any).getWarmUser?.(m);
            makerUa = warm?.getUserAccount?.() || null;
          } catch (e: any) { safeLog.debug('drift.filler.warm_user_lookup', { error: String(e?.message || e), cat: 'drift' }); }
          // Fall back to userMap if not in warm cache
          if (!makerUa && this.userMap) {
            try {
              const wrap = await Promise.race([
                this.userMap.mustGet(m),
                new Promise((_, rej) => setTimeout(() => rej(new Error('MAKER_UA_TIMEOUT')), 150)),
              ]).catch(() => null);
              makerUa = (wrap as any)?.getUserAccount?.() || null;
            } catch (e: any) { safeLog.debug('drift.filler.usermap_lookup', { error: String(e?.message || e), cat: 'drift' }); }
          }
        }
        if (!makerUa) continue;
        const makerAuth = makerUa?.authority;
        let makerStats = null;
        try {
          const { getUserStatsAccountPublicKey } = this.sdk;
          makerStats = getUserStatsAccountPublicKey(this.client.program.programId, makerAuth);
        } catch (e: any) { safeLog.debug('drift.filler.maker_stats_lookup', { error: String(e?.message || e), cat: 'drift' }); }
        const makerNodeOrder = (nodeToFill?.makerNodes || []).find((mn: any) => String(mn?.userAccount || '') === m)?.order;
        makerInfos.push({
          maker: new PublicKey(m),
          makerUserAccount: makerUa,
          order: makerNodeOrder,
          makerStats,
        });
      } catch (e: any) { safeLog.warn('drift.filler.build_maker_info', { error: String(e?.message || e), cat: 'drift' }); }
    }
    return makerInfos;
  }

  private estimatePriorityForMarket(marketIndex: number): number {
    const basePriority = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
    const suggestedMul = Number(this.client?.txSender?.getSuggestedPriorityFeeMultiplier?.() || 1.0);
    const dynFromSub = Number(this.priorityFeeSubscriber?.getCustomStrategyResult?.() || basePriority);
    const floor = Math.max(10_000, Number(((CONFIG as any)?.drift?.fillerPriorityFloorMicroLamports) ?? ((CONFIG as any)?.fees?.fillerPriorityFloorMicroLamports) ?? 15_000));
    const effectivePriority = Math.max(floor, Math.floor(Math.max(basePriority, dynFromSub * suggestedMul)));
    const marketKey = `perp-${marketIndex}`;
    const mulCfg = Number((((CONFIG as any)?.drift?.feeMultipliers || {}) as Record<string, number>)[marketKey] ?? 1.0);
    const MAX_MICRO = 200_000;
    return Math.min(MAX_MICRO, Math.max(floor, Math.floor(effectivePriority * (Number.isFinite(mulCfg) ? mulCfg : 1.0))));
  }

  private estimateTipLamports(priorityForSend: number, cuLimit: number): number {
    try {
      const allowTips = !!((CONFIG as any)?.jito?.allowTips);
      if (!((CONFIG as any)?.jito?.enabled && allowTips)) return 0;
      const cached = getCachedTipInfo();
      const tipPk = cached?.tipAccount;
      if (!tipPk) return 0;
      const priorityLamportsEst = Math.floor((priorityForSend * Math.max(220_000, cuLimit)) / 1_000_000);
      const cfg = (CONFIG as any)?.jito || {};
      const fixed = Number(cfg?.fixedTipLamports ?? 0);
      const share = Number(cfg?.tipShare ?? 0.3);
      const floor = Number(cached?.tipFloorLamports ?? 0);
      const estShare = Math.floor((priorityLamportsEst * share) / Math.max(1 - share, 0.01));
      const tipLamports = Math.max(1000, fixed > 0 ? fixed : (floor || estShare));
      return tipLamports;
    } catch { return 0; }
  }

  private estimateCostLamports(priorityForSend: number, cuLimit: number): number {
    const baseFee = Math.max(0, Number((CONFIG as any)?.fees?.baseFee ?? 5000));
    const priorityLamports = Math.floor((priorityForSend * Math.max(220_000, cuLimit)) / 1_000_000);
    const tipLamports = this.estimateTipLamports(priorityForSend, cuLimit);
    return Math.max(0, baseFee + priorityLamports + tipLamports);
  }

  private estimateNodeEconomics(params: {
    marketIndex: number;
    node: any;
    vBid: any;
    vAsk: any;
  }): { notionalQuote: number; rewardQuote: number; costQuote?: number; profitQuote?: number; remainingBaseUi?: number; score: number } | null {
    try {
      const { BN, getVariant, BASE_PRECISION, PRICE_PRECISION } = this.sdk;
      const o = params.node?.node?.order;
      if (!o) return null;
      const base = o?.baseAssetAmount;
      const filled = o?.baseAssetAmountFilled || new BN(0);
      const remaining = (base && typeof base.sub === 'function') ? base.sub(filled) : null;
      if (!remaining || !Number.isFinite(Number(remaining?.toString?.() || 0))) return null;
      const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined;
      const priceBn = (o as any)?.price;
      const vAsk = params.vAsk;
      const vBid = params.vBid;
      const usePx = (priceBn && typeof priceBn.toString === 'function' && Number(priceBn.toString()) > 0)
        ? priceBn
        : (dir === 'short' ? vBid : vAsk);
      if (!usePx || !usePx.toString) return null;
      const baseNum = Number(remaining.toString());
      const priceNum = Number(usePx.toString());
      const basePrec = Number((BASE_PRECISION as any)?.toString?.() || BASE_PRECISION || 1);
      const pricePrec = Number((PRICE_PRECISION as any)?.toString?.() || PRICE_PRECISION || 1);
      const remainingBaseUi = baseNum / Math.max(1, basePrec);
      const notionalQuote = remainingBaseUi * (priceNum / Math.max(1, pricePrec));
      if (!Number.isFinite(notionalQuote) || notionalQuote <= 0) return null;
      const feeBps = Number((CONFIG as any)?.drift?.feeTakerBps ?? 5);
      const rewardShare = Math.max(0, Math.min(1, Number(this.config.rewardShare ?? 0.5)));
      const rewardQuote = notionalQuote * (feeBps / 10000) * rewardShare;
      const priorityForSend = this.estimatePriorityForMarket(params.marketIndex);
      const cuLimit = Math.max(220_000, Math.min(800_000, Number(this.config.cuLimit ?? 300_000)));
      const costLamports = this.estimateCostLamports(priorityForSend, cuLimit);
      const solUsd = this.getSolPriceUsd();
      const costQuote = solUsd ? (costLamports / LAMPORTS_PER_SOL) * solUsd : undefined;
      const profitQuote = (typeof costQuote === 'number') ? (rewardQuote - costQuote) : undefined;
      let score = rewardQuote;
      const rankBy = String(this.config.rankBy || '').toLowerCase();
      if (rankBy === 'notional') score = notionalQuote;
      else if (rankBy === 'profit' && typeof profitQuote === 'number') score = profitQuote;
      return { notionalQuote, rewardQuote, costQuote, profitQuote, remainingBaseUi, score };
    } catch {
      return null;
    }
  }

  private getPreparedFillForNode(sig: string, nodeToFill: any): PreparedFill | null {
    try {
      const cur = this.preparedFills.get(sig);
      if (!cur) {
        if (this.preparedFills.size > 0) this.prebuildStats.miss += 1;
        return null;
      }
      if (cur.expiresAt && cur.expiresAt < Date.now()) {
        this.preparedFills.delete(sig);
        this.prebuildStats.expired += 1;
        this.prebuildStats.miss += 1;
        return null;
      }
      const orderId = String(nodeToFill?.node?.order?.orderId || '');
      if (orderId && cur.orderId !== orderId) {
        this.preparedFills.delete(sig);
        this.prebuildStats.miss += 1;
        return null;
      }
      // If makers changed, discard
      if (Array.isArray(cur.makerKeys) && cur.makerKeys.length > 0 && Array.isArray(nodeToFill?.makerNodes)) {
        const nowSet = new Set(nodeToFill.makerNodes.map((mn: any) => String(mn?.userAccount || '')).filter(Boolean));
        const allPresent = cur.makerKeys.every((mk) => nowSet.has(String(mk)));
        if (!allPresent) {
          this.preparedFills.delete(sig);
          this.prebuildStats.miss += 1;
          return null;
        }
      }
      this.preparedFills.delete(sig);
      this.prebuildStats.hit += 1;
      return cur;
    } catch {
      this.prebuildStats.miss += 1;
      return null;
    }
  }

  private async prepareFill(marketIndex: number, nodeToFill: any): Promise<boolean> {
    try {
      const sig = this.signatureForNode(nodeToFill);
      if (!sig) return false;
      const existing = this.preparedFills.get(sig);
      if (existing && existing.expiresAt > Date.now()) return false;
      const ttlMs = Math.max(200, Number(this.config.prebuildTtlMs ?? 1500));
      const takerPkStr = String(nodeToFill?.node?.userAccount || '');
      const orderId = String(nodeToFill?.node?.order?.orderId || '');
      if (!takerPkStr || !orderId) return false;
      const takerUa = await this.getTakerUaQuick(takerPkStr);
      if (!takerUa) return false;
      const makersRaw: string[] = Array.isArray(nodeToFill?.makerNodes)
        ? nodeToFill.makerNodes.map((mn: any) => String(mn?.userAccount || '')).filter(Boolean)
        : [];
      const maxMakers = Math.max(0, Number(this.config.maxMakersPerFill ?? 1));
      const makers = makersRaw.slice(0, maxMakers);
      const makerKeys = makers;
      const allowAmm = this.config.allowAmmFills !== false;
      if ((!Array.isArray(nodeToFill?.makerNodes) || nodeToFill.makerNodes.length === 0) && !allowAmm) return false;
      const makerInfos = await this.buildMakerInfos(makers, nodeToFill);
      const { getUserAccountPublicKey } = this.sdk;
      const takerUserPk = await getUserAccountPublicKey(this.client.program.programId, takerUa.authority, takerUa.subAccountId);
      const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
      const fillIx = await withRpcTimeout(
        this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, makerInfos) as any,
        220,
        'fill_ix_prebuild'
      ).catch(() => null);
      if (!fillIx) return false;
      this.preparedFills.set(sig, {
        sig,
        marketIndex,
        orderId,
        taker: takerPkStr,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        takerUa,
        takerUserPk,
        makerInfos,
        makerKeys: makers,
        fillIx,
      });
      this.prebuildStats.built += 1;
      return true;
    } catch {
      return false;
    }
  }

  private async tryFillNode(marketIndex: number, nodeToFill: any): Promise<boolean> {
    try {
      const sig = this.signatureForNode(nodeToFill);
      const takerPkStr = String(nodeToFill?.node?.userAccount || '');
      try { hotlist.markUser(takerPkStr, 'filler_try'); } catch (e: any) { safeLog.debug('drift.filler.hotlist_mark_user', { error: String(e?.message || e), cat: 'drift' }); }
      const { getUserAccountPublicKey } = this.sdk;
      const t0 = Date.now();
      const timings: any = { t0, hyd: 0, mk: 0, fillPri: 0, fillFb: 0, bh: 0, upd: 0, rev: 0, tip: 0, compile: 0 };
      let buildMs: number | undefined = undefined;
      let sendMs: number | undefined = undefined;
      let sentAtMs: number | undefined = undefined;
      const usePrebuild = this.config.prebuildEnabled !== false;
      const prepared = (usePrebuild && sig) ? this.getPreparedFillForNode(sig, nodeToFill) : null;
      const takerUa = prepared?.takerUa || await this.getTakerUaQuick(takerPkStr);
      timings.hyd = Date.now();
      if (!takerUa) {
        try { if (this._loopStatsTmp?.skips) this._loopStatsTmp.skips.takerHydration = (this._loopStatsTmp.skips.takerHydration || 0) + 1; } catch (e: any) { safeLog.debug('drift.filler.stats_taker_hydration', { error: String(e?.message || e), cat: 'drift' }); }
        safeLog.debug('drift.filler.skip_taker_hydration_timeout', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex });
        return false;
      }

      // If taker has a referrer configured but referrer stats do not exist, skip (use cache-assisted check)
      try {
        const ref = (takerUa as any)?.referrerInfo?.referrer;
        if (ref) {
          try {
            const svc = DriftService.getInstance() as any;
            const ok = await (svc.ensureRefStatsReady?.(ref));
            if (!ok) {
              try { if (this._loopStatsTmp?.skips) this._loopStatsTmp.skips.missingRefStats = (this._loopStatsTmp.skips.missingRefStats || 0) + 1; } catch (e: any) { safeLog.debug('drift.filler.stats_missing_ref', { error: String(e?.message || e), cat: 'drift' }); }
              safeLog.info('drift.filler.skip_missing_referrer_stats', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex });
              return false;
            }
          } catch (e: any) { safeLog.debug('drift.filler.ensure_ref_stats', { error: String(e?.message || e), cat: 'drift' }); }
        }
      } catch (e: any) { safeLog.debug('drift.filler.referrer_check', { error: String(e?.message || e), cat: 'drift' }); }

      const makersRaw: string[] = Array.isArray(nodeToFill?.makerNodes)
        ? nodeToFill.makerNodes.map((mn: any) => String(mn?.userAccount || '')).filter(Boolean)
        : [];
      const maxMakers = Math.max(0, Number(this.config.maxMakersPerFill ?? 1));
      const makers = makersRaw.slice(0, maxMakers);

      // Require maker nodes only when AMM-only fills are disabled
      const allowAmm = this.config.allowAmmFills !== false; // default allow
      if ((!Array.isArray(nodeToFill?.makerNodes) || nodeToFill.makerNodes.length === 0) && !allowAmm) {
        try {
          logger.debug('drift.filler.skip_no_makers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
        } catch (e: any) { safeLog.debug('drift.filler.skip_no_makers.catch', { error: String(e?.message || e), cat: 'drift' }); }
        return false;
      }

      // Relax precheck: rely on DLOB to surface crossable nodes; only log diagnostics
      try {
        const { getVariant } = this.sdk;
        const o = nodeToFill?.node?.order;
        const otype = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : undefined;
        const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined;
        safeLog.debug('drift.filler.precheck', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, dir, otype });
      } catch (e: any) { safeLog.debug('drift.filler.precheck_diag', { error: String(e?.message || e), cat: 'drift' }); }

      let makerInfos: any[] = Array.isArray(prepared?.makerInfos) ? prepared!.makerInfos : [];
      if (!prepared) {
        makerInfos = await this.buildMakerInfos(makers, nodeToFill);
      }
      timings.mk = Date.now();

      const takerUserPk = prepared?.takerUserPk || await getUserAccountPublicKey(this.client.program.programId, takerUa.authority, takerUa.subAccountId);
      const cuLimit = Math.max(220_000, Math.min(800_000, Number(this.config.cuLimit ?? 300_000)));
      const priorityForSend = this.estimatePriorityForMarket(marketIndex);
      // Build all dependent instructions and (optionally) fetch blockhash in parallel to minimize delay
      const enableUpdateFiller = !!((CONFIG as any)?.drift?.enableUpdateFiller);
      const updateBudgetMs = Math.max(0, Number(((CONFIG as any)?.drift?.updateIxBudgetMs) ?? 60));
      const updateFillerIxP = enableUpdateFiller ? (async () => {
        const nowMs = Date.now();
        const cdMs = Math.max(10_000, Number(((CONFIG as any)?.drift?.updateFillerCooldownMs) ?? 30_000));
        const shouldUpdate = (nowMs - this.lastUpdateFillerMs) >= cdMs;
        if (!shouldUpdate) return null;
        try {
          const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
          if (typeof this.client.getUpdateFillerIx === 'function') {
            const ix = await withRpcTimeout(this.client.getUpdateFillerIx(), updateBudgetMs, 'upd_ix_fast');
            return ix || null;
          }
        } catch (e: any) { safeLog.warn('drift.filler.update_filler_ix', { error: String(e?.message || e), cat: 'drift' }); }
        return null;
      })() : Promise.resolve(null);
      const fillIxP = prepared?.fillIx ? null : this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, makerInfos);
      const revertIxP = this.client.getRevertFillIx();
      // Build optional oracle update instructions (Pyth Pull) if enabled
      let oracleUpdateIxs: any[] = [];
      try {
        const od = this.client.getOracleDataForPerpMarket?.(marketIndex);
        const odSlot = Number((od as any)?.slot?.toString?.() || 0);
        const curSlot = this.slotSubscriber?.getSlot?.() ?? 0;
        if (this.oracleUpdater) {
          const upd = await this.oracleUpdater.getOracleUpdateIxsForPerp({ marketIndex, currentSlot: Number(curSlot), oracleSlot: Number(odSlot) });
          if (Array.isArray(upd) && upd.length > 0) oracleUpdateIxs = upd;
        }
      } catch (e: any) { safeLog.debug('drift.filler.oracle_update_ixs', { error: String(e?.message || e), cat: 'drift' }); }
      // Prefer cached blockhash; only fetch live if no cache available
      let cachedBhEarly = this.getBestBlockhash(200, 5);
      let updateFillerIx: any = null, fillIx: any = prepared?.fillIx, revertIx: any = null, bh: any;
      // Always await fill ix (required), but time-bound update/revert so they don't block the first send
      const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let usedNoMakersFallback = false;
      if (!cachedBhEarly) {
        try {
          const { getFreshBlockhashOrFetch } = await import('../utils/blockhash.js');
          const bhStr = await getFreshBlockhashOrFetch(250);
          if (bhStr) { this.bhCacheStr = bhStr; this.bhCacheTs = Date.now(); cachedBhEarly = bhStr; timings.bh = Date.now(); }
        } catch (e: any) { safeLog.debug('drift.filler.blockhash_refresh', { error: String(e?.message || e), cat: 'drift' }); }
      }
      if (cachedBhEarly) {
        if (!fillIx) {
          try {
            fillIx = await withRpcTimeout(fillIxP as any, 220, 'fill_ix');
            timings.fillPri = Date.now();
          } catch {
            // Fallback: minimal fill without makers
            try {
              const emptyMakers: any[] = [];
              // Bound fallback as well to prevent multi-second stalls
              fillIx = await withRpcTimeout(
                this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, emptyMakers) as any,
                180,
                'fill_ix_fb'
              );
              usedNoMakersFallback = true;
              safeLog.info('drift.filler.build_fallback_nomakers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
              timings.fillFb = Date.now();
            } catch (e: any) {
              safeLog.info('drift.filler.build_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) });
              return false;
            }
          }
        }
        try { updateFillerIx = await withRpcTimeout(updateFillerIxP as any, updateBudgetMs, 'upd_ix'); } catch { updateFillerIx = null; }
        timings.upd = Date.now();
        try { if (updateFillerIx) { revertIx = await withRpcTimeout(revertIxP as any, 110, 'rev_ix'); } else { revertIx = null; } } catch { revertIx = null; }
        timings.rev = Date.now();
        if (updateFillerIx) { this.lastUpdateFillerMs = Date.now(); }
      } else {
        // No fresh cached blockhash; defer quickly to avoid stalling the loop
        safeLog.info('drift.filler.defer_no_cached_bh', { cat: FILLER_CAT, subcat: FILLER_SUBCAT });
        return false;
      }

      // If taker has a valid referrer stats account, append it as a remaining account to the fill ix (do not block if missing)
      try {
        const ref = (takerUa as any)?.referrerInfo?.referrer;
        if (ref && String(ref) !== '11111111111111111111111111111111') {
          const svc = DriftService.getInstance() as any;
          const refStatsPk = await svc.ensureRefStatsReady?.(ref);
          if (refStatsPk) {
            const exists = Array.isArray((fillIx as any)?.keys) && (fillIx as any).keys.some((k: any) => String(k?.pubkey || '') === String(refStatsPk));
            if (!exists && Array.isArray((fillIx as any)?.keys)) {
              (fillIx as any).keys.push({ pubkey: refStatsPk, isSigner: false, isWritable: true });
            }
          } else {
            safeLog.info('drift.filler.missing_referrer_stats_proceed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex });
          }
        }
      } catch (e: any) { safeLog.debug('drift.filler.ensure_ref_stats', { error: String(e?.message || e), cat: 'drift' }); }

      // Optionally append Jito tip inside the same transaction (no ALT), then add fill
      let ixsFill: any[] = [fillIx];
      let plannedTipLamports: number | undefined = undefined;
      let plannedTipAccount: string | undefined = undefined;
      try {
        const allowTips = !!((CONFIG as any)?.jito?.allowTips);
        if ((CONFIG as any)?.jito?.enabled && allowTips) {
          // Read from cache; only include tip if a valid BE tip account is known
          const cached = getCachedTipInfo();
          const tipPk = cached?.tipAccount;
          if (tipPk && String(tipPk?.toBase58?.()) !== String(this.client.wallet.publicKey?.toBase58?.())) {
            const priorityLamportsEst = Math.floor((priorityForSend * Math.max(220_000, cuLimit)) / 1_000_000);
            const cfg = (CONFIG as any)?.jito || {};
            const fixed = Number(cfg?.fixedTipLamports ?? 0);
            const share = Number(cfg?.tipShare ?? 0.3);
            const floor = Number(cached?.tipFloorLamports ?? 0);
            const estShare = Math.floor((priorityLamportsEst * share) / Math.max(1 - share, 0.01));
            const tipLamports = Math.max(1000, fixed > 0 ? fixed : (floor || estShare));
            const tipIx = buildTipIx(this.client.wallet.publicKey, tipPk, tipLamports);
            ixsFill = [tipIx, fillIx];
            plannedTipLamports = tipLamports;
            plannedTipAccount = tipPk.toBase58();
            // Optional: add 'dont-front' read-only account to the first ix
            try {
              if ((CONFIG as any)?.jito?.useDontFrontAccount && Array.isArray(ixsFill?.[0]?.keys)) {
                const acc = new PublicKey('jitodontfront111111111111111111111111111111');
                ixsFill[0].keys.push({ pubkey: acc, isSigner: false, isWritable: false });
              }
            } catch (e: any) { safeLog.debug('drift.filler.dont_front_account', { error: String(e?.message || e), cat: 'drift' }); }
          }
        }
        // Do not enforce tips for Sender; Sender can be used without tipping per requirement
      } catch (e: any) { safeLog.debug('drift.filler.tip_computation', { error: String(e?.message || e), cat: 'drift' }); }
      timings.tip = Date.now();

      const ixsFillOnly = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityForSend }),
        ...oracleUpdateIxs,
        ...ixsFill,
      ];
      const ixsWithUpdate = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityForSend }),
        ...(updateFillerIx ? [updateFillerIx] : []),
        ...oracleUpdateIxs,
        ...ixsFill,
        ...(updateFillerIx ? [revertIx] : []),
      ];
      const buildMode = updateFillerIx ? 'fill_with_update_ready' : (usedNoMakersFallback ? 'fill_minimal_nomakers' : 'fill_only_deadline');

      // Plan log for transaction build
      try {
        const bhSourcePlan = (() => { const cached = (() => { try { return getCachedBlockhash(5); } catch { return undefined; } })(); return cached ? 'cached' : (cachedBhEarly ? 'cached_early' : ((bh as any)?.blockhash ? 'fetched' : 'unknown')); })();
        const lookupCount = Array.isArray(this.lookupTableAccounts) ? this.lookupTableAccounts.length : 0;
        const priorityLamportsEst = Math.floor((priorityForSend * Math.max(220_000, cuLimit)) / 1_000_000);
        logger.info('drift.filler.tx_plan', {
          cat: FILLER_CAT,
          subcat: FILLER_SUBCAT,
          marketIndex,
          taker: takerPkStr,
          orderId: String(nodeToFill?.node?.order?.orderId || ''),
          buildMode,
          updateIx: !!updateFillerIx,
          makerInfos: Array.isArray(makerInfos) ? makerInfos.length : 0,
          allowAmm,
          cuLimit,
          priority: priorityForSend,
          priorityLamportsEst,
          bhSource: bhSourcePlan,
          lookupTables: lookupCount,
          sendPreferred: ((CONFIG as any)?.jito?.enabled ? 'jito-be' : 'rpc'),
          tipLamports: plannedTipLamports,
          tipAccount: plannedTipAccount,
        });
      } catch (e: any) { safeLog.debug('drift.filler.tx_plan.catch', { error: String(e?.message || e), cat: 'drift' }); }

      // Emit build timing breakdown before dispatch
      try {
        const total = Date.now() - t0;
        logger.info('drift.filler.build_timing', {
          cat: FILLER_CAT,
          subcat: FILLER_SUBCAT,
          marketIndex,
          taker: takerPkStr,
          orderId: String(nodeToFill?.node?.order?.orderId || ''),
          ms_total: total,
          ms_hyd: Math.max(0, timings.hyd - t0),
          ms_mk: Math.max(0, timings.mk - (timings.hyd || t0)),
          ms_fillPri: Math.max(0, timings.fillPri - (timings.mk || timings.hyd || t0)),
          ms_fillFb: Math.max(0, timings.fillFb - (timings.fillPri || timings.mk || timings.hyd || t0)),
          ms_bh: Math.max(0, timings.bh - (timings.fillFb || timings.fillPri || timings.mk || timings.hyd || t0)),
          ms_upd: Math.max(0, timings.upd - (timings.bh || timings.fillFb || timings.fillPri || timings.mk || timings.hyd || t0)),
          ms_rev: Math.max(0, timings.rev - (timings.upd || timings.bh || timings.fillFb || timings.fillPri || timings.mk || timings.hyd || t0)),
          ms_tip: Math.max(0, timings.tip - (timings.rev || timings.upd || timings.bh || timings.fillFb || timings.fillPri || timings.mk || timings.hyd || t0)),
          ms_compile: Math.max(0, timings.compile - (timings.tip || timings.rev || timings.upd || timings.bh || timings.fillFb || timings.fillPri || timings.mk || timings.hyd || t0)),
          bhSource: (() => { const cached = (() => { try { return getCachedBlockhash(5); } catch { return undefined; } })(); return cached ? 'cached' : (cachedBhEarly ? 'cached_early' : ((bh as any)?.blockhash ? 'fetched' : 'unknown')); })(),
          usedNoMakersFallback,
        });
      } catch (e: any) { safeLog.debug('drift.filler.build_timing.catch', { error: String(e?.message || e), cat: 'drift' }); }

      if (this.state.dryRun) {
        logger.info('drift.filler.dry_run', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), marketIndex });
        return false;
      }

      const cachedBh = this.getBestBlockhash(250, 5);
      const recentBlockhash = String(cachedBh || cachedBhEarly || (bh as any)?.blockhash);
      try { if (recentBlockhash) { this.bhCacheStr = recentBlockhash; this.bhCacheTs = Date.now(); } } catch (e: any) { safeLog.debug('drift.filler.blockhash_cache_update', { error: String(e?.message || e), cat: 'drift' }); }
      const toV0Tx = (instructions: any[]) => {
        const msg = new TransactionMessage({ payerKey: this.client.wallet.publicKey, recentBlockhash, instructions }).compileToV0Message(this.lookupTableAccounts || []);
        const vtx = new VersionedTransaction(msg);
        vtx.sign([this.client.wallet.payer]);
        timings.compile = Date.now();
        return vtx;
      };
      const sendV0 = async (vtx: VersionedTransaction, preferJito: boolean, hadTip: boolean): Promise<string> => {
        const raw = vtx.serialize();
        const opts: any = { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 0 };
        const t0send = Date.now();
        const now = Date.now();
        const beEnabled = !!((CONFIG as any)?.jito?.enabled) && preferJito && hadTip && now >= this.beCoolUntilMs;
        const raceRpc = !!((CONFIG as any)?.jito?.raceRpc);
        const base64 = Buffer.from(raw).toString('base64');
        const senderSend = async () => {
          const scfg = (CONFIG as any)?.sender || {};
          let endpoint: string = String(scfg?.endpoint || 'https://sender.helius-rpc.com/fast');
          const params: string[] = [];
          if (scfg?.apiKey) params.push(`api-key=${encodeURIComponent(String(scfg.apiKey))}`);
          if (scfg?.swqosOnly) params.push('swqos_only=true');
          if (params.length > 0) endpoint += (endpoint.includes('?') ? '&' : '?') + params.join('&');
          const body = {
            jsonrpc: '2.0',
            id: String(Date.now()),
            method: 'sendTransaction',
            params: [ base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 } ],
          } as any;
          const res = await withRpcLimit(
            () => fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
            1,
            { module: 'sender', method: 'sendTransaction' }
          );
          const json = await res.json().catch(() => ({} as any));
          if ((json as any)?.error) throw new Error(String((json as any).error?.message || 'SENDER_ERROR'));
          const sig = String((json as any)?.result || '');
          if (!sig) throw new Error('SENDER_NO_RESULT');
          safeLog.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'sender', ms: Date.now() - t0send });
          return sig;
        };
        const rpcSend = async () => {
          const sig = await DriftService.getInstance().sendRawTransaction(raw, opts);
          safeLog.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'rpc', ms: Date.now() - t0send });
          return sig;
        };
        const beSend = async () => {
          const sig = await sendToBlockEngine(base64, { beUrl: (CONFIG as any)?.jito?.blockEngineUrl, timeoutMs: (CONFIG as any)?.jito?.bundleTimeoutMs });
          this.beFailCount = 0; this.beCoolUntilMs = 0;
          safeLog.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'jito-be', ms: Date.now() - t0send });
          return sig;
        };
        // Prefer Sender when enabled (it already dual-routes to validators and Jito)
        if ((CONFIG as any)?.sender?.enabled) {
          try {
            return await senderSend();
          } catch (e: any) {
            safeLog.warn('drift.filler.sender_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) });
            // Continue to BE/RPC fallbacks
          }
        }
        if (beEnabled && raceRpc) {
          try {
            // @ts-expect-error -- Promise.any requires ES2021 lib
            return await Promise.any([
              beSend().catch((e: any) => { this.beFailCount += 1; throw e; }),
              rpcSend(),
            ]);
          } catch (e: any) {
            if (this.beFailCount >= 3) { this.beCoolUntilMs = Date.now() + 60_000; }
            safeLog.warn('drift.filler.jito_be_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) });
            // If race failed entirely, bubble up
            throw e;
          }
        }
        if (beEnabled) {
          try {
            return await beSend();
          } catch (e: any) {
            this.beFailCount += 1;
            if (this.beFailCount >= 3) { this.beCoolUntilMs = Date.now() + 60_000; }
            safeLog.warn('drift.filler.jito_be_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) });
          }
        }
        return await rpcSend();
      };

      const dispatch = async () => {
        try {
          const vtxPrimary = toV0Tx((updateFillerIx ? ixsWithUpdate : ixsFillOnly) as any);
          buildMs = Math.max(0, (timings.compile || Date.now()) - t0);
          try {
            const bhSource = cachedBh ? 'cached' : (cachedBhEarly ? 'cached_early' : ((bh as any)?.blockhash ? 'fetched' : 'unknown'));
            const lookupCount = Array.isArray(this.lookupTableAccounts) ? this.lookupTableAccounts.length : 0;
            logger.info('drift.filler.try_sent', {
              cat: FILLER_CAT,
              subcat: FILLER_SUBCAT,
              marketIndex,
              taker: takerPkStr,
              orderId: String(nodeToFill?.node?.order?.orderId || ''),
              cuLimit,
              priority: priorityForSend,
              buildMode,
              bhSource,
              lookups: lookupCount,
              sendPath: ((CONFIG as any)?.sender?.enabled ? 'sender-first' : (((CONFIG as any)?.jito?.enabled && plannedTipLamports && plannedTipAccount) ? 'jito-first' : 'rpc')),
              tipLamports: plannedTipLamports,
              tipAccount: plannedTipAccount,
            });
          } catch (e: any) { safeLog.debug('drift.filler.try_sent.catch', { error: String(e?.message || e), cat: 'drift' }); }
          const preferJito = !!((CONFIG as any)?.jito?.enabled);
          const hadTip = !!(plannedTipLamports && plannedTipAccount);
          const tSend = Date.now();
          sentAtMs = tSend;
          const sigTx = await sendV0(vtxPrimary, preferJito, hadTip);
          sendMs = Math.max(0, Date.now() - tSend);
          this.fillsInWindow.push(Date.now());
          logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
          try {
            const { trackDriftAttempt } = await import('./txTracker.js');
            trackDriftAttempt(this.connection as any, {
              sig: sigTx,
              action: 'fill',
              marketIndex,
              taker: takerPkStr,
              makers,
              orderId: String(nodeToFill?.node?.order?.orderId || ''),
              priorityFeeMicroLamports: priorityForSend,
              cuLimit,
              bot: this.botKey,
              buildMs,
              sendMs,
              sentAtMs,
            }).catch(() => {});
          } catch (e: any) { safeLog.debug('drift.filler.track_attempt', { error: String(e?.message || e), cat: 'drift' }); }
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          const classifySendErr = (er: any): string => {
            const m = String(er?.message || er || '').toLowerCase();
            if (m.includes('timeout')) return 'timeout';
            if (m.includes('429') || m.includes('rate')) return 'rate_limited';
            if (m.includes('blockhash') && (m.includes('expired') || m.includes('not'))) return 'blockhash';
            if (m.includes('insufficient') && m.includes('lamports')) return 'insufficient_fee';
            return 'unknown';
          };
          // If blockhash expired/not found, refresh and resend once quickly
          if (/blockhash.*(not.*found|expired)|Transaction.*expired/i.test(msg)) {
            try {
              const { getFreshBlockhashOrFetch } = await import('../utils/blockhash.js');
              const bh2Str = String(await getFreshBlockhashOrFetch(350) || '');
              const ixsRetry = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityForSend }),
                fillIx,
              ];
              const msgRetry = new TransactionMessage({ payerKey: this.client.wallet.publicKey, recentBlockhash: bh2Str, instructions: ixsRetry }).compileToV0Message(this.lookupTableAccounts || []);
              const vRetry = new VersionedTransaction(msgRetry);
              vRetry.sign([this.client.wallet.payer]);
              safeLog.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: priorityForSend, reason: 'blockhash_refresh' });
              const tSend = Date.now();
              const preferJitoRetry = !!((CONFIG as any)?.jito?.enabled);
              const hadTipRetry = !!(plannedTipLamports && plannedTipAccount);
              const sigTx = await sendV0(vRetry, preferJitoRetry, hadTipRetry);
              const retrySendMs = Math.max(0, Date.now() - tSend);
              this.fillsInWindow.push(Date.now());
              logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: priorityForSend,
                  cuLimit,
                  bot: this.botKey,
                  sendMs: retrySendMs,
                  sentAtMs: tSend,
                }).catch(() => {});
              } catch (e: any) { safeLog.debug('drift.filler.track_attempt', { error: String(e?.message || e), cat: 'drift' }); }
              return;
            } catch (e: any) { safeLog.debug('drift.filler.blockhash_refresh', { error: String(e?.message || e), cat: 'drift' }); }
          }
          if (/0x185f|RevertFill/i.test(msg)) {
            // Mark taker on cooldown; likely JIT preemption for place-and-make
            try {
              const ttl = Math.max(5000, Number(this.config.denyJitTakersTtlMs ?? 15000));
              this.jitTakerCooldown.set(takerPkStr, Date.now() + ttl);
            } catch (e: any) { safeLog.debug('drift.filler.jit_cooldown_set', { error: String(e?.message || e), cat: 'drift' }); }
            try {
              const [bh2, upd2] = await Promise.all([
                (async () => { try { const { getFreshBlockhashOrFetch } = await import('../utils/blockhash.js'); const v = await getFreshBlockhashOrFetch(300); return { blockhash: v }; } catch { return { blockhash: undefined as any }; } })(),
                (async () => {
                  try {
                    if (typeof this.client.getUpdateFillerIx === 'function') return await this.client.getUpdateFillerIx();
                    if (typeof this.client.getUpdateUserIdleIx === 'function') return await this.client.getUpdateUserIdleIx(takerUserPk, takerUa, this.client.wallet.publicKey);
                    return null;
                  } catch { return null; }
                })(),
              ]);
              const boosted = Math.max(priorityForSend, 30_000);
              const bh2Str = String((globalThis as any).__bh_shared_cached || this.blockhashSubscriber?.getLatestBlockhash?.(5)?.blockhash || (bh2 as any)?.blockhash);
              let sigTx: string;
              let retrySendMs: number | undefined = undefined;
              let retrySentAtMs: number | undefined = undefined;
              if (upd2 || updateFillerIx) {
                const ixsUpd = [
                  ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
                  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: boosted }),
                  ...(upd2 ? [upd2] : (updateFillerIx ? [updateFillerIx] : [])),
                  fillIx,
                  ...(upd2 ? [await this.client.getRevertFillIx()] : (updateFillerIx ? [revertIx] : [])),
                ];
                const msgUpd = new TransactionMessage({ payerKey: this.client.wallet.publicKey, recentBlockhash: bh2Str, instructions: ixsUpd }).compileToV0Message(this.lookupTableAccounts || []);
                const vUpd = new VersionedTransaction(msgUpd);
                vUpd.sign([this.client.wallet.payer]);
                safeLog.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: boosted, reason: 'revert_retry' });
                retrySentAtMs = Date.now();
                sigTx = await sendV0(vUpd, !!((CONFIG as any)?.jito?.enabled), !!(plannedTipLamports && plannedTipAccount));
                retrySendMs = Math.max(0, Date.now() - retrySentAtMs);
              } else {
                const msgFo = new TransactionMessage({
                  payerKey: this.client.wallet.publicKey,
                  recentBlockhash: bh2Str,
                  instructions: [
                    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: boosted }),
                    fillIx,
                  ],
                }).compileToV0Message(this.lookupTableAccounts || []);
                const vFill = new VersionedTransaction(msgFo);
                vFill.sign([this.client.wallet.payer]);
                safeLog.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: boosted, reason: 'revert_retry' });
                retrySentAtMs = Date.now();
                sigTx = await sendV0(vFill, !!((CONFIG as any)?.jito?.enabled), !!(plannedTipLamports && plannedTipAccount));
                retrySendMs = Math.max(0, Date.now() - retrySentAtMs);
              }
              this.fillsInWindow.push(Date.now());
              logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: boosted,
                  cuLimit,
                  bot: this.botKey,
                  sendMs: retrySendMs,
                  sentAtMs: retrySentAtMs,
                }).catch(() => {});
              } catch (e: any) { safeLog.debug('drift.filler.track_attempt', { error: String(e?.message || e), cat: 'drift' }); }
            } catch (e2: any) {
              logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: String(e2?.message || e2) });
              // Record failed revert attempt as well
              try {
                const { recordAttempt } = await import('./txTracker.js');
                recordAttempt({
                  ts: Date.now(),
                  sig: 'FAILED',
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: Math.max(priorityForSend, 30_000),
                  cuLimit,
                  bot: this.botKey,
                  success: false,
                  feeLamports: 0,
                  priorityLamports: 0,
                  lamportsPaid: 0,
                } as any);
              } catch (e: any) { safeLog.debug('drift.filler.record_attempt', { error: String(e?.message || e), cat: 'drift' }); }
            }
          } else {
            try {
              const bhSource = cachedBh ? 'cached' : (cachedBhEarly ? 'cached_early' : ((bh as any)?.blockhash ? 'fetched' : 'unknown'));
              logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: msg, code: classifySendErr(e), bhSource, priority: priorityForSend });
            } catch {
              logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: msg });
            }
          }
          // Record failed attempt for metrics
          try {
            const { recordAttempt } = await import('./txTracker.js');
            recordAttempt({
              ts: Date.now(),
              sig: 'FAILED',
              action: 'fill',
              marketIndex,
              taker: takerPkStr,
              makers,
              orderId: String(nodeToFill?.node?.order?.orderId || ''),
              priorityFeeMicroLamports: priorityForSend,
              cuLimit,
              bot: this.botKey,
              success: false,
              feeLamports: 0,
              priorityLamports: 0,
              lamportsPaid: 0,
            } as any);
          } catch (e: any) { safeLog.debug('drift.filler.record_attempt', { error: String(e?.message || e), cat: 'drift' }); }
        }
      };

      // Fire-and-continue; do not await
      dispatch().catch(() => {});
      safeLog.debug('drift.filler.dispatched', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), blockhash: recentBlockhash });
      return true;
    } catch (e: any) {
      logger.info('drift.filler.warn fill_node_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, err: String(e?.message || e) });
      return false;
    }
  }

  private async loop(): Promise<void> {
    if (this.abort) return;
    this.pruneMaps();
    const t0 = Date.now();
    this.state.lastRunAt = t0;

    // Loop time and work budgets to keep each tick responsive
    const LOOP_BUDGET_MS = Math.max(150, Number(((CONFIG as any)?.drift?.loopTimeBudgetMs) ?? 300));
    const MAX_NODES_PER_LOOP = Math.max(50, Number(((CONFIG as any)?.drift?.maxNodesPerLoop) ?? 200));
    let processedNodes = 0;
    let budgetExceeded = false;

    // Initialize per-loop stats snapshot
    const loopStats: any = {
      marketsTotal: 0,
      marketsPaused: 0,
      marketsOracleStale: 0,
      nodesPlanned: 0,
      nodesProcessed: 0,
      nodesSent: 0,
      makersBreakdown: { withMakers: 0, withoutMakers: 0 },
      budget: { exhausted: false, processedNodes: 0 },
      econ: { count: 0, notionalSum: 0, rewardSum: 0, costSum: 0, profitSum: 0, minNotional: Infinity, maxNotional: 0 },
      prebuild: { planned: 0, nearCandidates: 0, overflowCandidates: 0 },
      skips: {
        vammDisallowed: 0,
        ammBelowMin: 0,
        ammNotCrossing: 0,
        triggerOrder: 0,
        cooldown: 0,
        takerHydration: 0,
        missingRefStats: 0,
        noMakers: 0,
        remainingBelowMin: 0,
        notionalBelowMin: 0,
        rewardBelowMin: 0,
        profitBelowMin: 0,
        rewardCostRatio: 0,
        maxCandidates: 0,
      },
    };
    this._loopStatsTmp = loopStats;
    const driftCfg: any = (CONFIG as any)?.drift || {};
    const verboseNodeLogs = driftCfg?.verboseNodeLogs === true;
    const nodeLogSampleRate = Math.max(0, Math.min(1, Number(driftCfg?.nodeLogSampleRate ?? 0)));
    const shouldLogNode = () => verboseNodeLogs || (nodeLogSampleRate > 0 && Math.random() < nodeLogSampleRate);
    const nodeLogger = verboseNodeLogs ? logger.info : logger.debug;

    try {
      const dlob = this.dlobSubscriber?.getDLOB?.();
      if (!dlob && !this.useInfra) {
        logger.info('drift.filler.warn dlob_unavailable', { cat: FILLER_CAT, subcat: FILLER_SUBCAT });
        this.dlobUnavailableCount = (this.dlobUnavailableCount || 0) + 1;
        if (this.dlobUnavailableCount >= 3) {
          try { await this.initDiscovery(); } catch (e: any) { safeLog.warn('drift.filler.init_discovery_retry', { error: String(e?.message || e), cat: 'drift' }); }
          try {
            if (!this.wsNudgeTimer) {
              this.wsNudgeTimer = setInterval(() => {
                try {
                  if (!this.inLoop && !this.abort) setImmediate(() => { this.loop().catch(() => {}); });
                } catch (e: any) { safeLog.debug('drift.filler.loop_nudge', { error: String(e?.message || e), cat: 'drift' }); }
              }, 1000);
            }
          } catch (e: any) { safeLog.warn('drift.filler.ws_nudge_timer_init', { error: String(e?.message || e), cat: 'drift' }); }
          // Start WS fallback to nudge when orderbooks update
          try {
            if (!this.dlobWsFallback) {
              const { DlobFallback } = await import('./dlobFallback.js');
              const markets = Array.isArray(await this.client.getPerpMarketAccounts?.())
                ? (await this.client.getPerpMarketAccounts?.()).map((m: any) => Number(m?.marketIndex || 0)).filter((n: any) => Number.isFinite(n))
                : [0,1,2];
              const onNudge = () => { try { if (!this.inLoop && !this.abort) setImmediate(() => { this.loop().catch(() => {}); }); } catch (e: any) { safeLog.debug('drift.filler.loop_nudge', { error: String(e?.message || e), cat: 'drift' }); } };
              this.dlobWsFallback = new DlobFallback(onNudge);
              await this.dlobWsFallback.start(markets);
            }
          } catch (e: any) { safeLog.debug('drift.filler.dlob_fallback_start', { error: String(e?.message || e), cat: 'drift' }); }
        }
        return;
      } else if (!dlob && this.useInfra) {
        this.dlobUnavailableCount = (this.dlobUnavailableCount || 0) + 1;
      } else {
        this.dlobUnavailableCount = 0;
        // If WS fallback was running, optionally keep it or stop to reduce load
        // We keep it running as a nudge source; to stop it uncomment the following lines:
        // try { this.dlobWsFallback?.stop?.(); } catch {}
        // this.dlobWsFallback = null;
      }

      const {
        MarketType, BN,
        calculateAskPrice, calculateBidPrice,
        getVariant,
      } = this.sdk;

      let slot = this.slotSubscriber?.getSlot?.() ?? 0;
      const stateAcc = this.client.getStateAccount?.();
      const perps = await this.client.getPerpMarketAccounts?.();
      let indexStats = driftEventIndex.getStats();
      let indexMarketsRemote: number[] = [];
      if (this.useInfra) {
        try {
          const remote = await fetchEventIndex(Math.max(1, Number(driftCfg?.eventIndexMarketsPerLoop ?? 50)));
          if (remote?.stats) indexStats = remote.stats;
          if (Array.isArray(remote?.activeMarkets)) indexMarketsRemote = remote.activeMarkets;
        } catch (e: any) { safeLog.debug('drift.filler.fetch_event_index', { error: String(e?.message || e), cat: 'drift' }); }
      }

      try {
        if (!driftCfg?.loopSummaryOnly) {
          logger.info('drift.filler.loop_begin', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            slot,
            perpsCount: Array.isArray(perps) ? perps.length : 0,
            allowlistSize: Array.isArray(this.state.marketsAllowlist) ? this.state.marketsAllowlist.length : 0,
          });
        }
        if (this._summary) {
          this._summary.loops += 1;
          this._summary.markets.total += Array.isArray(perps) ? perps.length : 0;
        }
      } catch (e: any) { safeLog.debug('drift.filler.summary_update', { error: String(e?.message || e), cat: 'drift' }); }

      let totalPlanned = 0;
      let sent = 0;
      const sample: Array<{ m: number; taker: string; id: string; makers: number }> = [];

      const hotMarkets = hotlist.getHotMarkets({
        limit: Math.max(1, Number(driftCfg?.hotMarketsPerLoop ?? 25)),
        consumerId: 'filler',
      });
      const indexMarkets = this.useInfra
        ? indexMarketsRemote
        : driftEventIndex.getActiveMarkets(Math.max(1, Number(driftCfg?.eventIndexMarketsPerLoop ?? 50)));
      const prioritySet = new Set<number>();
      for (const idx of hotMarkets) prioritySet.add(Number(idx));
      for (const idx of indexMarkets) prioritySet.add(Number(idx));
      const fullScanEveryMs = Math.max(10_000, Number(driftCfg?.eventIndexFullScanMs ?? 30_000));
      const doFullScan = prioritySet.size === 0 || ((Date.now() - this.lastFullScanAt) > fullScanEveryMs);
      if (doFullScan) this.lastFullScanAt = Date.now();
      try {
        if (this._summary) {
          if (!this._summary.scanModes) this._summary.scanModes = { full: 0, targeted: 0 };
          this._summary.scanModes[doFullScan ? 'full' : 'targeted'] += 1;
          this._summary.indexStats = indexStats;
        }
      } catch (e: any) { safeLog.debug('drift.filler.scan_modes_update', { error: String(e?.message || e), cat: 'drift' }); }
      if (hotMarkets.length > 0) {
        safeLog.debug('drift.filler.hotlist', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, count: hotMarkets.length });
      }
      if (indexMarkets.length > 0) {
        safeLog.debug('drift.filler.index_markets', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, count: indexMarkets.length });
      }
      const seen = new Set<number>();
      const perpsArr = Array.isArray(perps) ? perps : [];
      const perpByIndex = new Map<number, any>();
      for (const m of perpsArr) {
        perpByIndex.set(Number(m?.marketIndex || 0), m);
      }
      const marketsOrdered: any[] = [];
      for (const idx of prioritySet) {
        const market = perpByIndex.get(Number(idx));
        if (!market) continue;
        const midx = Number(market?.marketIndex || 0);
        if (seen.has(midx)) continue;
        seen.add(midx);
        marketsOrdered.push(market);
      }
      if (doFullScan) {
        for (const market of perpsArr) {
          const idx = Number(market?.marketIndex || 0);
          if (seen.has(idx)) continue;
          marketsOrdered.push(market);
        }
      }

      const remoteByMarket = this.useInfra ? new Map<number, any>() : null;
      if (this.useInfra && remoteByMarket) {
        try {
          const marketIdxs = marketsOrdered.map((m: any) => Number(m?.marketIndex || 0)).filter((n: any) => Number.isFinite(n));
          if (marketIdxs.length > 0) {
            const resp = await fetchFillNodes({ markets: marketIdxs });
            if (typeof resp?.slot === 'number') slot = resp.slot;
            const results = Array.isArray(resp?.results) ? resp.results : [];
            const { BN } = this.sdk || {};
            const toBn = (v: any) => {
              try { return BN ? new BN(String(v)) : v; } catch { return undefined; }
            };
            for (const r of results) {
              const idx = Number(r?.marketIndex ?? -1);
              if (!Number.isFinite(idx)) continue;
              remoteByMarket.set(idx, {
                vBid: toBn(r?.vBid),
                vAsk: toBn(r?.vAsk),
                oracle: r?.oracle,
                oracleDelay: r?.oracleDelay,
                oracleStale: r?.oracleStale,
                nodes: Array.isArray(r?.nodes) ? r.nodes : [],
              });
            }
          }
        } catch (e: any) { safeLog.debug('drift.filler.fetch_fill_nodes', { error: String(e?.message || e), cat: 'drift' }); }
      }

      for (const market of marketsOrdered) {
        if (budgetExceeded) break;
        const mStart = Date.now();
        const idx = Number(market?.marketIndex || 0);
        if (!this.inAllowlist(idx)) continue;
        loopStats.marketsTotal += 1;
        const slotBn = new BN(slot);
        // Skip paused markets
        try {
          const statusStr = (() => { try { return String(getVariant((market as any)?.status)).toLowerCase(); } catch { return 'unknown'; } })();
          if (statusStr !== 'active') {
            safeLog.info('drift.filler.skip_paused_market', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, status: statusStr });
            loopStats.marketsPaused += 1;
            continue;
          }
        } catch (e: any) { safeLog.debug('drift.filler.market_status_parse', { error: String(e?.message || e), cat: 'drift' }); }
        let vAsk: any = null;
        let vBid: any = null;
        let nodesToFill: any[] = [];
        if (this.useInfra) {
          const remote = remoteByMarket?.get(idx);
          if (!remote) continue;
          if (remote.oracleStale) {
            safeLog.info('drift.filler.skip_oracle_stale', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, oracleDelay: remote.oracleDelay, maxDelay: Math.max(0, Number(((CONFIG as any)?.drift?.maxOracleDelaySlots) ?? 40)) });
            loopStats.marketsOracleStale += 1;
            continue;
          }
          vAsk = remote.vAsk;
          vBid = remote.vBid;
          nodesToFill = Array.isArray(remote.nodes) ? remote.nodes : [];
          try {
            logger.debug('drift.filler.market_scan', {
              cat: FILLER_CAT,
              subcat: FILLER_SUBCAT,
              marketIndex: idx,
              oraclePx: String(remote.oracle || ''),
              vBid: String((vBid as any)?.toString?.() || vBid || ''),
              vAsk: String((vAsk as any)?.toString?.() || vAsk || ''),
              slot,
            });
          } catch (e: any) { safeLog.debug('drift.filler.market_scan.catch', { error: String(e?.message || e), cat: 'drift' }); }
        } else {
          const mmOraclePriceData = this.client.getMMOracleDataForPerpMarket?.(idx);
          // Skip markets with stale oracle data to avoid zero-fills due to SafeMM checks
          try {
            const od = this.client.getOracleDataForPerpMarket?.(idx);
            const odSlot = Number((od as any)?.slot?.toString?.() || 0);
            const curSlot = this.slotSubscriber?.getSlot?.() ?? 0;
            const maxDelay = Math.max(0, Number(((CONFIG as any)?.drift?.maxOracleDelaySlots) ?? 40));
            if (odSlot > 0 && (curSlot - odSlot) > maxDelay) {
              safeLog.info('drift.filler.skip_oracle_stale', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, oracleDelay: (curSlot - odSlot), maxDelay });
              loopStats.marketsOracleStale += 1;
              continue;
            }
          } catch (e: any) { safeLog.debug('drift.filler.oracle_data_check', { error: String(e?.message || e), cat: 'drift' }); }
          vAsk = calculateAskPrice(market, mmOraclePriceData, slotBn);
          vBid = calculateBidPrice(market, mmOraclePriceData, slotBn);

          try {
            logger.debug('drift.filler.market_scan', {
              cat: FILLER_CAT,
              subcat: FILLER_SUBCAT,
              marketIndex: idx,
              oraclePx: String((mmOraclePriceData as any)?.price?.toString?.() || (mmOraclePriceData as any)?.price || ''),
              vBid: String((vBid as any)?.toString?.() || vBid || ''),
              vAsk: String((vAsk as any)?.toString?.() || vAsk || ''),
              slot,
            });
          } catch (e: any) { safeLog.debug('drift.filler.market_scan.catch', { error: String(e?.message || e), cat: 'drift' }); }

          nodesToFill = dlob.findNodesToFill(
            idx, vBid, vAsk, slot,
            Math.floor(Date.now() / 1000) - 60,
            MarketType.PERP, mmOraclePriceData,
            stateAcc, this.client.getPerpMarketAccount?.(idx)
          ) || [];
        }
        // Prefilter: drop trigger orders to avoid wasting budget
        const isTriggerNode = (n: any): boolean => {
          try {
            const o = n?.node?.order;
            const t = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : '';
            return t === 'triggermarket' || t === 'triggerlimit';
          } catch { return false; }
        };
        const prefiltered = nodesToFill.filter((n: any) => !isTriggerNode(n));
        const droppedTriggers = nodesToFill.length - prefiltered.length;
        if (droppedTriggers > 0) { loopStats.skips.triggerOrder += droppedTriggers; }
        if (prefiltered.length > 0) {
          try { hotlist.markMarket(idx, 'filler_nodes'); } catch (e: any) { safeLog.debug('drift.filler.hotlist_mark_market', { error: String(e?.message || e), cat: 'drift' }); }
          try { driftEventIndex.markMarket(idx, 'filler_nodes'); } catch (e: any) { safeLog.debug('drift.filler.event_index_mark_market', { error: String(e?.message || e), cat: 'drift' }); }
        }

        totalPlanned += prefiltered.length;
        loopStats.nodesPlanned += prefiltered.length;

        try {
          logger.debug('drift.filler.market_nodes', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            nodes: nodesToFill.length,
          });
        } catch (e: any) { safeLog.debug('drift.filler.market_nodes.catch', { error: String(e?.message || e), cat: 'drift' }); }

        // Enqueue taker/maker accounts for prefetch warming
        if (!this.useInfra) {
          try {
            const svc = DriftService.getInstance() as any;
            const keys: string[] = [];
            for (const n of nodesToFill) {
              const t = String(n?.node?.userAccount || ''); if (t) keys.push(t);
              const mks = Array.isArray(n?.makerNodes) ? n.makerNodes : [];
              for (const mn of mks) { const mk = String(mn?.userAccount || ''); if (mk) keys.push(mk); }
            }
            try {
              for (const k of keys) {
                if (!k) continue;
                driftEventIndex.updateUserMarkets(k, [idx], 'filler_node');
              }
            } catch (e: any) { safeLog.debug('drift.filler.event_index_update_users', { error: String(e?.message || e), cat: 'drift' }); }
            svc.enqueueUsersForPrefetch?.(keys);
          } catch (e: any) { safeLog.debug('drift.filler.event_index_update_users', { error: String(e?.message || e), cat: 'drift' }); }
        }

        // Diagnostics: maker vs non-maker nodes
        try {
          const withMakers = prefiltered.filter((n: any) => Array.isArray(n?.makerNodes) && n.makerNodes.length > 0).length;
          const withoutMakers = prefiltered.length - withMakers;
          logger.debug('drift.filler.market_nodes_breakdown', {
            cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
            nodes: prefiltered.length, withMakers, withoutMakers,
          });
          loopStats.makersBreakdown.withMakers += withMakers;
          loopStats.makersBreakdown.withoutMakers += withoutMakers;
        } catch (e: any) { safeLog.debug('drift.filler.market_nodes_breakdown.catch', { error: String(e?.message || e), cat: 'drift' }); }

        // Additional JIT-avoidance prefilters
        const requireMakers = (this.config.requireExistingMakers !== false);
        const minMakers = Math.max(0, Number(this.config.minMakerCountPerNode ?? 1));
        const skipYoungMs = Math.max(0, Number(this.config.skipYoungOrderMs ?? 0));
        const minTipFloor = Math.max(0, Number(this.config.minTipFloorToAttemptLamports ?? 0));
        const filtered = prefiltered.filter((node: any) => {
          try {
            const nowMs = Date.now();
            const sig = this.signatureForNode(node);
            if (!this.nodeSeenAtMs.has(sig)) this.nodeSeenAtMs.set(sig, nowMs);
            const firstSeen = this.nodeSeenAtMs.get(sig) || nowMs;
            const ageMs = nowMs - firstSeen;

            // Age gate
            if (skipYoungMs > 0 && ageMs < skipYoungMs) {
              safeLog.debug('drift.filler.skip_young_order', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, ageMs });
              (loopStats.skips as any).young = ((loopStats.skips as any).young || 0) + 1;
              return false;
            }

            // Taker cooldown (recent JIT preemption)
            const takerPk = String(node?.node?.userAccount || '');
            const untilMs = this.jitTakerCooldown.get(takerPk) || 0;
            if (untilMs > nowMs) {
              safeLog.debug('drift.filler.skip_jit_taker_cooldown', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, taker: takerPk });
              (loopStats.skips as any).jitCooldown = ((loopStats.skips as any).jitCooldown || 0) + 1;
              return false;
            }

            // Require existing makers
            if (requireMakers) {
              const makersLen = Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0;
              if (makersLen < minMakers) {
                safeLog.debug('drift.filler.skip_no_makers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, makersLen, minMakers });
                (loopStats.skips as any).noMakers = ((loopStats.skips as any).noMakers || 0) + 1;
                return false;
              }
            }

            // Skip when Jito tip floor is high (optional)
            if (minTipFloor > 0) {
              try {
                const { tipFloorLamports } = getCachedTipInfo();
                const floor = Number(tipFloorLamports || 0);
                if (floor >= minTipFloor) {
                  logger.debug('drift.filler.skip_tip_floor_high', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, floor, minTipFloor });
                  (loopStats.skips as any).tipFloor = ((loopStats.skips as any).tipFloor || 0) + 1;
                  return false;
                }
              } catch (e: any) { safeLog.debug('drift.filler.tip_computation', { error: String(e?.message || e), cat: 'drift' }); }
            }

            return true;
          } catch { return true; }
        });

        // Profitability and sizing gates with ranking
        const minNotionalQuote = Math.max(0, Number(this.config.minNotionalQuote ?? 0));
        const minRemainingBase = Math.max(0, Number(this.config.minRemainingBase ?? 0));
        const minRewardQuote = Math.max(0, Number(this.config.minRewardQuote ?? 0));
        const minProfitQuote = Math.max(0, Number(this.config.minProfitQuote ?? 0));
        const minRewardToCostRatio = Math.max(0, Number(this.config.minRewardToCostRatio ?? 0));
        const maxCandidatesPerLoop = Math.max(0, Number(this.config.maxCandidatesPerLoop ?? 0));
        const scored: Array<{ node: any; score: number; economics?: any }> = [];
        for (const node of filtered) {
          const econ = this.estimateNodeEconomics({ marketIndex: idx, node, vBid, vAsk });
          if (econ) {
            loopStats.econ.count += 1;
            loopStats.econ.notionalSum += Number(econ.notionalQuote || 0);
            loopStats.econ.rewardSum += Number(econ.rewardQuote || 0);
            loopStats.econ.costSum += Number(econ.costQuote || 0);
            loopStats.econ.profitSum += Number(econ.profitQuote || 0);
            loopStats.econ.minNotional = Math.min(loopStats.econ.minNotional, Number(econ.notionalQuote || Infinity));
            loopStats.econ.maxNotional = Math.max(loopStats.econ.maxNotional, Number(econ.notionalQuote || 0));
            if (minRemainingBase > 0 && typeof econ.remainingBaseUi === 'number' && econ.remainingBaseUi < minRemainingBase) {
              loopStats.skips.remainingBelowMin += 1;
              continue;
            }
            if (minNotionalQuote > 0 && econ.notionalQuote < minNotionalQuote) {
              loopStats.skips.notionalBelowMin += 1;
              continue;
            }
            if (minRewardQuote > 0 && econ.rewardQuote < minRewardQuote) {
              loopStats.skips.rewardBelowMin += 1;
              continue;
            }
            if (minProfitQuote > 0 && typeof econ.profitQuote === 'number' && econ.profitQuote < minProfitQuote) {
              loopStats.skips.profitBelowMin += 1;
              continue;
            }
            if (minRewardToCostRatio > 0 && typeof econ.costQuote === 'number' && econ.costQuote > 0) {
              const ratio = econ.rewardQuote / econ.costQuote;
              if (ratio < minRewardToCostRatio) {
                loopStats.skips.rewardCostRatio += 1;
                continue;
              }
            }
          }
          scored.push({ node, score: Number(econ?.score || 0), economics: econ });
        }
        scored.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
        let selected = scored;
        let overflow: Array<{ node: any; score: number; economics?: any }> = [];
        if (maxCandidatesPerLoop > 0 && scored.length > maxCandidatesPerLoop) {
          selected = scored.slice(0, maxCandidatesPerLoop);
          overflow = scored.slice(maxCandidatesPerLoop);
          loopStats.skips.maxCandidates += Math.max(0, overflow.length);
        }
        const nodesForAttempt = selected.map((s) => s.node);

        // Prebuild near-eligible fills and overflow candidates
        const prebuildEnabled = this.config.prebuildEnabled !== false;
        const prebuildPerLoop = Math.max(0, Number(this.config.prebuildPerLoop ?? 0));
        if (prebuildEnabled && prebuildPerLoop > 0) {
          const prebuildBps = Math.max(0, Number(this.config.prebuildDistanceBps ?? 0));
          const prebuildMaxCandidates = Math.max(0, Number(this.config.prebuildMaxCandidates ?? 0));
          const maxInFlight = Math.max(1, Number(this.config.prebuildMaxInFlight ?? 2));
          const sigSeen = new Set(nodesForAttempt.map((n: any) => this.signatureForNode(n)));
          let nearNodes: any[] = [];
          if (prebuildBps > 0) {
            try {
              const bps = Math.min(500, prebuildBps);
              const vBidNear = (vBid && typeof vBid.mul === 'function') ? vBid.mul(new BN(10000 + bps)).div(new BN(10000)) : vBid;
              const vAskNear = (vAsk && typeof vAsk.mul === 'function') ? vAsk.mul(new BN(10000 - bps)).div(new BN(10000)) : vAsk;
              const mmOracleNear = this.client.getMMOracleDataForPerpMarket?.(idx);
              nearNodes = dlob.findNodesToFill(
                idx, vBidNear, vAskNear, slot,
                Math.floor(Date.now() / 1000) - 60,
                MarketType.PERP, mmOracleNear,
                stateAcc, this.client.getPerpMarketAccount?.(idx)
              ) || [];
            } catch (e: any) { safeLog.debug('drift.filler.prebuild_near_nodes', { error: String(e?.message || e), cat: 'drift' }); }
          }
          const requireMakersPre = (this.config.requireExistingMakers !== false);
          const minMakersPre = Math.max(0, Number(this.config.minMakerCountPerNode ?? 1));
          const nearFiltered = nearNodes
            .filter((n: any) => !sigSeen.has(this.signatureForNode(n)))
            .filter((n: any) => {
              if (!requireMakersPre) return true;
              const makersLen = Array.isArray(n?.makerNodes) ? n.makerNodes.length : 0;
              return makersLen >= minMakersPre;
            });
          const overflowNodes = overflow.map((o) => o.node);
          loopStats.prebuild.nearCandidates += nearFiltered.length;
          loopStats.prebuild.overflowCandidates += overflowNodes.length;
          let candidates = [...overflowNodes, ...nearFiltered];
          if (prebuildMaxCandidates > 0 && candidates.length > prebuildMaxCandidates) {
            candidates = candidates.slice(0, prebuildMaxCandidates);
          }
          if (candidates.length > 0) {
            const toSchedule = candidates.slice(0, prebuildPerLoop);
            loopStats.prebuild.planned += toSchedule.length;
            for (const n of toSchedule) {
              if (this.prebuildInFlight >= maxInFlight) break;
              this.prebuildInFlight += 1;
              setImmediate(async () => {
                try { await this.prepareFill(idx, n); }
                finally { this.prebuildInFlight = Math.max(0, this.prebuildInFlight - 1); }
              });
            }
          }
        }

        let iter = 0;
        for (const node of nodesForAttempt) {
          if ((Date.now() - t0) > LOOP_BUDGET_MS || processedNodes >= MAX_NODES_PER_LOOP) {
            budgetExceeded = true;
            safeLog.debug('drift.filler.loop_budget_exhausted', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, processedNodes, ms: Date.now() - t0 });
            loopStats.budget.exhausted = true;
            loopStats.budget.processedNodes = processedNodes;
            break;
          }
          iter += 1;
          if ((iter % 50) === 0) { try { await new Promise((r) => setImmediate(r)); } catch { /* yield safe to swallow */ } }
          try {
            if (!node?.node?.order) continue;
            const allowAmm = this.config.allowAmmFills !== false; // default allow
            if (typeof node?.node?.isVammNode === 'function' && node.node.isVammNode()) {
              if (!allowAmm) {
                try {
                  logger.info('drift.filler.skip_vamm_node', {
                    cat: FILLER_CAT,
                    subcat: FILLER_SUBCAT,
                    marketIndex: idx,
                    taker: String(node?.node?.userAccount || ''),
                    orderId: String(node?.node?.order?.orderId || ''),
                  });
                } catch (e: any) { safeLog.debug('drift.filler.skip_vamm_node.catch', { error: String(e?.message || e), cat: 'drift' }); }
                loopStats.skips.vammDisallowed += 1;
                continue;
              } else {
                try {
                  logger.debug('drift.filler.amm_fill_candidate', {
                    cat: FILLER_CAT,
                    subcat: FILLER_SUBCAT,
                    marketIndex: idx,
                    taker: String(node?.node?.userAccount || ''),
                    orderId: String(node?.node?.order?.orderId || ''),
                  });
                } catch (e: any) { safeLog.debug('drift.filler.amm_fill_candidate.catch', { error: String(e?.message || e), cat: 'drift' }); }
                // fall through to attempt AMM fill
              }
            }

            // If we are going to try AMM (vAMM node or no makers), ensure remaining size meets AMM min and is crossing
            try {
              const usingAmm = (typeof node?.node?.isVammNode === 'function' && node.node.isVammNode()) || !(Array.isArray(node?.makerNodes) && node.makerNodes.length > 0);
              const o = node?.node?.order;
              const minSz = (market as any)?.amm?.minOrderSize; // BN
              if (usingAmm && o) {
                const { BN, getVariant } = this.sdk;
                const base = (o as any)?.baseAssetAmount;         // BN
                const filled = (o as any)?.baseAssetAmountFilled || new BN(0); // BN
                const remaining = (base && typeof base.sub === 'function') ? base.sub(filled) : null;
                if (minSz && remaining && typeof remaining.lt === 'function' && remaining.lt(minSz)) {
                  try {
                    logger.info('drift.filler.skip_below_min_order', {
                      cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                      remaining: String((remaining as any)?.toString?.() || remaining || ''),
                      minOrder: String((minSz as any)?.toString?.() || minSz || ''),
                      taker: String(node?.node?.userAccount || ''), orderId: String(o?.orderId || ''),
                    });
                  } catch (e: any) { safeLog.debug('drift.filler.skip_below_min_order.catch', { error: String(e?.message || e), cat: 'drift' }); }
                  loopStats.skips.ammBelowMin += 1;
                  continue;
                }
                // Cheap crossing check for AMM-only limit orders
                const otype = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : undefined;
                const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined; // 'long' | 'short'
                const isLimit = !!otype && otype.includes('limit');
                const priceBn = (o as any)?.price;
                if (isLimit && priceBn && typeof priceBn.lt === 'function' && typeof vAsk?.lt === 'function' && typeof vBid?.lt === 'function') {
                  const notCrossing = (dir === 'long' && priceBn.lt(vAsk)) || (dir === 'short' && priceBn.gt(vBid));
                  if (notCrossing) {
                    try {
                      logger.debug('drift.filler.skip_not_crossing_amm', {
                        cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, dir,
                        orderPrice: String(priceBn?.toString?.() || ''), vBid: String(vBid?.toString?.() || ''), vAsk: String(vAsk?.toString?.() || ''),
                        taker: String(node?.node?.userAccount || ''), orderId: String(o?.orderId || ''),
                      });
                    } catch (e: any) { safeLog.debug('drift.filler.amm_size_check', { error: String(e?.message || e), cat: 'drift' }); }
                    loopStats.skips.ammNotCrossing += 1;
                    continue;
                  }
                }
              }
            } catch (e: any) { safeLog.debug('drift.filler.order_type_parse', { error: String(e?.message || e), cat: 'drift' }); }

            // Identify order type; skip true trigger orders (TriggerMarket/TriggerLimit) until triggered
            const o = node?.node?.order;
            let orderTypeStr: string | undefined = undefined;
            try { orderTypeStr = o?.orderType ? String(getVariant(o.orderType)) : undefined; } catch (e: any) { safeLog.debug('drift.filler.order_type_parse', { error: String(e?.message || e), cat: 'drift' }); }
            let triggerCondStr: string | undefined = undefined;
            try { triggerCondStr = o?.triggerCondition ? String(getVariant(o.triggerCondition)) : undefined; } catch (e: any) { safeLog.debug('drift.filler.trigger_cond_parse', { error: String(e?.message || e), cat: 'drift' }); }
            const isTriggerType = !!orderTypeStr && ['triggermarket', 'triggerlimit'].includes(orderTypeStr.toLowerCase());
            if (isTriggerType) {
              try {
                const key = idx;
                const now = Date.now();
                const rec = this.skipLogCount.get(key) || { n: 0, ts: now };
                if (now - rec.ts > 10000) { rec.n = 0; rec.ts = now; }
                rec.n += 1;
                this.skipLogCount.set(key, rec);
                if (rec.n <= 5 || rec.n % 100 === 0) {
                  logger.debug('drift.filler.skip_trigger_order', {
                    cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                    taker: String(node?.node?.userAccount || ''),
                    orderId: String(node?.node?.order?.orderId || ''),
                    orderType: orderTypeStr,
                    countInWindow: rec.n,
                  });
                } else {
                  logger.debug('drift.filler.skip_trigger_order', {
                    cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                    orderType: orderTypeStr,
                  });
                }
              } catch (e: any) { safeLog.debug('drift.filler.skip_trigger_order.catch', { error: String(e?.message || e), cat: 'drift' }); }
              loopStats.skips.triggerOrder += 1;
              continue;
            }

            const sig = this.signatureForNode(node);
            const last = this.nodesCooldown.get(sig) || 0;
            if (last + COOLDOWN_MS > Date.now()) {
              try {
                logger.info('drift.filler.cooldown_skip', {
                  cat: FILLER_CAT,
                  subcat: FILLER_SUBCAT,
                  marketIndex: idx,
                  signature: sig,
                  orderId: String(node?.node?.order?.orderId || ''),
                });
              } catch (e: any) { safeLog.debug('drift.filler.cooldown_skip.catch', { error: String(e?.message || e), cat: 'drift' }); }
              loopStats.skips.cooldown += 1;
              continue;
            }
            this.nodesCooldown.set(sig, Date.now());

            if (sample.length < 5) {
              sample.push({
                m: idx,
                taker: String(node?.node?.userAccount || ''),
                id: String(node?.node?.order?.orderId || ''),
                makers: Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0,
              });
            }

            // Node info extra logging to aid diagnosis
            try {
              if (shouldLogNode()) {
                nodeLogger('drift.filler.node_info', {
                  cat: FILLER_CAT,
                  subcat: FILLER_SUBCAT,
                  marketIndex: idx,
                  taker: String(node?.node?.userAccount || ''),
                  orderId: String(node?.node?.order?.orderId || ''),
                  makerCount: Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0,
                  orderType: orderTypeStr,
                  triggerCondition: triggerCondStr,
                });
              }
            } catch (e: any) { safeLog.debug('drift.filler.node_info.catch', { error: String(e?.message || e), cat: 'drift' }); }

            try {
              if (shouldLogNode()) {
                nodeLogger('drift.filler.try_fill', {
                  cat: FILLER_CAT,
                  subcat: FILLER_SUBCAT,
                  marketIndex: idx,
                  taker: String(node?.node?.userAccount || ''),
                  orderId: String(node?.node?.order?.orderId || ''),
                  makerCount: Array.isArray(node?.makerNodes) ? node?.makerNodes.length : 0,
                  cuLimit: Math.max(220_000, Math.min(800_000, Number(this.config.cuLimit ?? 300_000))),
                  priority: Math.max(10_000, Number(((CONFIG as any)?.fees?.fillerPriorityFloorMicroLamports) ?? 15_000)),
                  dryRun: !!this.state.dryRun,
                });
              }
            } catch (e: any) { safeLog.debug('drift.filler.try_fill.catch', { error: String(e?.message || e), cat: 'drift' }); }

            // Count budget once node is eligible for a send attempt
            processedNodes += 1;
            loopStats.nodesProcessed += 1;
            loopStats.eligibleNodes = (loopStats.eligibleNodes || 0) + 1;

            const ok = await this.tryFillNode(idx, node);
            if (ok) { sent += 1; loopStats.nodesSent += 1; }
          } catch (e: any) { safeLog.debug('drift.filler.node_process', { error: String(e?.message || e), cat: 'drift' }); }
        }

        try {
          logger.debug('drift.filler.market_done', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            ms: Date.now() - mStart,
          });
        } catch (e: any) { safeLog.debug('drift.filler.market_done.catch', { error: String(e?.message || e), cat: 'drift' }); }
      }

      const dur = Date.now() - t0;
      try {
        const driftCfg: any = (CONFIG as any)?.drift || {};
        if (!driftCfg?.loopSummaryOnly) {
          logger.info('drift.filler.loop', {
            cat: FILLER_CAT, subcat: FILLER_SUBCAT,
            ms: dur,
            totalNodesPlanned: totalPlanned,
            sent,
            fillsLastMin: this.getStatus().fillsLastMin,
            sample,
            marketsTotal: loopStats.marketsTotal,
            marketsPaused: loopStats.marketsPaused,
            marketsOracleStale: loopStats.marketsOracleStale,
            nodesProcessed: loopStats.nodesProcessed,
            makersWith: loopStats.makersBreakdown.withMakers,
            makersWithout: loopStats.makersBreakdown.withoutMakers,
            budgetExhausted: loopStats.budget.exhausted,
            budgetProcessed: loopStats.budget.processedNodes,
            skips: loopStats.skips,
          });
        }
        if (this._summary) {
          this._summary.planned += totalPlanned;
          this._summary.processed += loopStats.nodesProcessed;
          this._summary.sent += sent;
          this._summary.markets.paused += loopStats.marketsPaused;
          this._summary.markets.oracleStale += loopStats.marketsOracleStale;
          for (const [k, v] of Object.entries(loopStats.skips || {})) {
            (this._summary.skipped as any)[k] = ((this._summary.skipped as any)[k] || 0) + Number(v || 0);
          }
        }
      } catch (e: any) { safeLog.debug('drift.filler.loop_stats.catch', { error: String(e?.message || e), cat: 'drift' }); }
      try {
        const econ = loopStats.econ || {};
        const count = Number(econ.count || 0);
        const avg = (v: any) => (count > 0 ? Number(v || 0) / count : 0);
        const econOut = {
          count,
          avgNotional: avg(econ.notionalSum),
          avgReward: avg(econ.rewardSum),
          avgCost: avg(econ.costSum),
          avgProfit: avg(econ.profitSum),
          minNotional: Number.isFinite(Number(econ.minNotional)) && Number(econ.minNotional) !== Infinity ? Number(econ.minNotional) : 0,
          maxNotional: Number(econ.maxNotional || 0),
        };
        this.lastLoopStats = {
          ts: Date.now(),
          ...loopStats,
          econ: econOut,
          prebuildCache: this.preparedFills.size,
          prebuildStats: this.prebuildStats,
        };
      } catch (e: any) { safeLog.debug('drift.filler.loop_stats_compute', { error: String(e?.message || e), cat: 'drift' }); }
      if (totalPlanned === 0) {
        try {
          logger.info('drift.filler.loop_noop', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            slot,
            perpsCount: Array.isArray(perps) ? perps.length : 0,
          });
        } catch (e: any) { safeLog.debug('drift.filler.loop_noop.catch', { error: String(e?.message || e), cat: 'drift' }); }
      }
    } catch (e: any) {
      this.state.lastError = String(e?.message || e);
      logger.info('drift.filler.error loop_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: this.state.lastError });
    }
  }
}

export class DriftFillerRegistry {
  private static reg = new RunnerRegistry<DriftFillerRunner>();
  static keyOf(cfg: FillerConfig): string { return cfg?.name ? `fil#${cfg.name}` : 'fil#default'; }
  static upsert(cfg: FillerConfig): DriftFillerRunner {
    const key = this.keyOf(cfg);
    return this.reg.upsert(key, () => new DriftFillerRunner(cfg));
  }
  static get(key: string): DriftFillerRunner | undefined { return this.reg.get(key); }
  static list(): Array<{ key: string; status: FillerRuntimeState }> { return this.reg.list(); }
  static async start(key: string): Promise<boolean> { return this.reg.start(key); }
  static stop(key: string): boolean { return this.reg.stop(key); }
  static remove(key: string): boolean { return this.reg.remove(key); }
}


