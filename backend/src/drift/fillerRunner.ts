// @ts-nocheck
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { buildTipIx } from '../execution/jitoTip.js';
import { startTipFeed, getCachedTipInfo } from '../execution/jitoTipCache.js';
import { sendToBlockEngine } from '../execution/jitoClient.js';
import { getCachedBlockhash } from '../utils/blockhash.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
import { OracleUpdater } from './oracles/oracleUpdater.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';

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

const FILLER_CAT = 'drift';
const FILLER_SUBCAT = 'filler';
const COOLDOWN_MS = 100;

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
  private altRefreshTimer: any | null = null;
  private dlobUnavailableCount: number = 0;
  private wsNudgeTimer: any | null = null;
  private dlobWsFallback: any | null = null;
  private bhWarmTimer: any | null = null;
  private bhCacheStr: string | undefined = undefined;
  private bhCacheTs: number = 0;
  private beFailCount: number = 0;
  private beCoolUntilMs: number = 0;
  private lastUpdateFillerMs: number = 0;
  // Per-loop stats
  private _loopStatsTmp: any | null = null;
  private _summary: { since: number; loops: number; planned: number; sent: number; processed: number; skipped: Record<string, number>; markets: { total: number; paused: number; oracleStale: number } } | null = null;
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
    // Expose heuristic settings for UI visibility (typed as any to avoid widening FillerRuntimeState)
    return {
      ...this.state,
      fillsLastMin: this.fillsInWindow.length,
    } as any as FillerRuntimeState & {
      skipYoungOrderMs?: number;
      requireExistingMakers?: boolean;
      minMakerCountPerNode?: number;
      denyJitTakersTtlMs?: number;
      minTipFloorToAttemptLamports?: number;
    };
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
    } catch {}
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
    // Configure throttle early (reduced gaps, higher concurrency for lower latency)
    try { (svc as any).configureTxThrottle?.({ minGapMs: 30, maxInFlight: 8 }); } catch {}

    // Kick off discovery after infra warmup, then start timers
    setImmediate(async () => {
      try {
        const driftCfg: any = (CONFIG as any)?.drift || {};
        const svcGate: any = DriftService.getInstance();
        const requireWarm = driftCfg?.warmupRequireBeforeBots !== false;
        if (requireWarm) {
          const ok = await (svcGate as any).waitForWarmup?.(Number(driftCfg?.warmupTimeoutMs ?? 30000));
          try { logger.info('drift.filler.warmup_gate', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, ok }); } catch {}
        }
        const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
        await withRpcTimeout(this.initDiscovery(), 5000, 'initDiscovery');
      } catch (e: any) {
        try { logger.warn('drift.filler.discovery_degraded', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) }); } catch {}
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
          if (this._summaryTimer) { try { clearInterval(this._summaryTimer); } catch {} this._summaryTimer = null; }
          if (!this._summary) this._summary = { since: Date.now(), loops: 0, planned: 0, sent: 0, processed: 0, skipped: {}, markets: { total: 0, paused: 0, oracleStale: 0 } };
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
              });
              this._summary = { since: Date.now(), loops: 0, planned: 0, sent: 0, processed: 0, skipped: {}, markets: { total: 0, paused: 0, oracleStale: 0 } };
            } catch {}
          }, every);
        }
      } catch {}
      // Slot-driven tick once slotSubscriber is available
      try {
        const onSlot = () => { try { setImmediate(() => { tick().catch(() => {}); }); } catch { /* noop */ } };
        if (typeof (this.slotSubscriber?.onSlotChange) === 'function') {
          this.slotSubscriber.onSlotChange(onSlot, 1);
        } else {
          this.slotSubscriber?.eventEmitter?.on?.('slotUpdate', onSlot);
        }
      } catch {}
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    if (this.bhWarmTimer) { try { clearInterval(this.bhWarmTimer); } catch {} this.bhWarmTimer = null; }
    if (this.altRefreshTimer) { try { clearInterval(this.altRefreshTimer); } catch {} this.altRefreshTimer = null; }
    if (this.wsNudgeTimer) { try { clearInterval(this.wsNudgeTimer); } catch {} this.wsNudgeTimer = null; }
    this.state.running = false;
    this.abort = true;
    logger.info('drift.filler.stopped', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
    try { (DriftService.getInstance() as any).unregisterBot?.(this.botKey); } catch {}
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(100, Math.floor(this.state.loopIntervalMs / 2)), preferOrderSubscriber: true });
    this.slotSubscriber = (infra as any).slotSubscriber;
    this.eventSubscriber = (infra as any).eventSubscriber;
    this.userMap = (infra as any).userMap;
    this.dlobSubscriber = (infra as any).dlobSubscriber;
    this.orderSubscriber = (infra as any).orderSubscriber;
    logger.info('drift.filler.usermap_dlob_ready', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, shared: true });
    try {
      if (!this.oracleUpdater) {
        this.oracleUpdater = new OracleUpdater({ sdk: this.sdk, driftClient: this.client, cluster: (CONFIG as any)?.drift?.cluster || 'mainnet-beta' });
      }
    } catch {}
    // Start user prefetcher once shared infra is ready
    try { await (svc as any).startUserPrefetcher?.(this.dlobSubscriber, this.userMap); } catch {}
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
        } catch {}
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
        } catch {}
      }
    } catch {}
    // Preload ALTs for v0
    try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch { this.lookupTableAccounts = []; }
    // Periodic ALT refresh
    try {
      const every = Math.max(60_000, Number(((CONFIG as any)?.drift?.altRefreshMs) ?? 300_000));
      if (this.altRefreshTimer) { try { clearInterval(this.altRefreshTimer); } catch {} }
      this.altRefreshTimer = setInterval(async () => {
        try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch {}
      }, every);
    } catch {}
    // Blockhash warming is provided by shared utils/blockhash via DriftService
    // Sender / RPC connection warming ping
    try {
      if (this.wsNudgeTimer) { try { clearInterval(this.wsNudgeTimer); } catch {} this.wsNudgeTimer = null; }
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
            try { await fetch(endpoint.replace(/\/fast$/, '/ping'), { method: 'GET' }); } catch {}
          }
          // Warm Helius RPC via a cheap call
          try { 
            const { withRpcLimit } = await import('../utils/rpcLimiter.js');
            await withRpcLimit(() => this.connection.getBlockHeight('processed'), 1, { module: 'drift', method: 'getBlockHeight' }); 
          } catch {}
        } catch {}
      };
      doPing().catch(() => {});
      this.wsNudgeTimer = setInterval(() => { doPing().catch(() => {}); }, pingEveryMs);
    } catch {}
    // Start Jito tip feed cache (non-blocking)
    try { startTipFeed(Math.max(10_000, Number(((CONFIG as any)?.jito?.tipRefreshMs) ?? 15_000))); } catch {}
    // Prepare WS fallback (lazy start on degradation)
    try { this.dlobWsFallback = null; } catch {}
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

  private async tryFillNode(marketIndex: number, nodeToFill: any): Promise<boolean> {
    try {
      const takerPkStr = String(nodeToFill?.node?.userAccount || '');
      const { getUserAccountPublicKey } = this.sdk;
      const t0 = Date.now();
      const timings: any = { t0, hyd: 0, mk: 0, fillPri: 0, fillFb: 0, bh: 0, upd: 0, rev: 0, tip: 0, compile: 0 };
      // Bounded, non-blocking taker hydration
      const getTakerUaQuick = async (): Promise<any | null> => {
        // Warm cache first
        try {
          const warm = (DriftService.getInstance() as any).getWarmUser?.(takerPkStr);
          const ua = warm?.getUserAccount?.();
          if (ua) return ua;
        } catch {}
        // Try userMap quickly, but keep very tight bound
        try {
            const wrap = await Promise.race([
            this.userMap.mustGet(takerPkStr),
            new Promise((_, rej) => setTimeout(() => rej(new Error('UA_TIMEOUT')), 180)),
          ]).catch(() => null);
          const ua = (wrap as any)?.getUserAccount?.();
          if (ua) return ua;
        } catch {}
        return null;
      };

      const takerUa = await getTakerUaQuick();
      timings.hyd = Date.now();
      if (!takerUa) {
        try { logger.debug('drift.filler.skip_taker_hydration_timeout', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
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
              try { logger.info('drift.filler.skip_missing_referrer_stats', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
              return false;
            }
          } catch {}
        }
      } catch {}

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
        } catch {}
        return false;
      }

      // Relax precheck: rely on DLOB to surface crossable nodes; only log diagnostics
      try {
        const { getVariant } = this.sdk;
        const o = nodeToFill?.node?.order;
        const otype = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : undefined;
        const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined;
        try { logger.debug('drift.filler.precheck', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, dir, otype }); } catch {}
      } catch {}

      const makerInfos: any[] = [];
      // Makers must be warm; do not decode via RPC in the hot path
      for (const m of makers) {
        try {
          let makerUa: any = null;
          try {
            const warm = (DriftService.getInstance() as any).getWarmUser?.(m);
            makerUa = warm?.getUserAccount?.() || null;
          } catch {}
          if (!makerUa) continue;
          const makerAuth = makerUa?.authority;
          let makerStats = null;
          try {
            const { getUserStatsAccountPublicKey } = this.sdk;
            makerStats = getUserStatsAccountPublicKey(this.client.program.programId, makerAuth);
          } catch {}
          const makerNodeOrder = (nodeToFill?.makerNodes || []).find((mn: any) => String(mn?.userAccount || '') === m)?.order;
          makerInfos.push({
            maker: new PublicKey(m),
            makerUserAccount: makerUa,
            order: makerNodeOrder,
            makerStats,
          });
        } catch {}
      }
      timings.mk = Date.now();

      const takerUserPk = await getUserAccountPublicKey(this.client.program.programId, takerUa.authority, takerUa.subAccountId);
      const cuLimit = Math.max(220_000, Math.min(800_000, Number(this.config.cuLimit ?? 300_000)));
      const basePriority = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
      const suggestedMul = Number(this.client?.txSender?.getSuggestedPriorityFeeMultiplier?.() || 1.0);
      const dynFromSub = Number(this.priorityFeeSubscriber?.getCustomStrategyResult?.() || basePriority);
      const floor = Math.max(10_000, Number(((CONFIG as any)?.drift?.fillerPriorityFloorMicroLamports) ?? ((CONFIG as any)?.fees?.fillerPriorityFloorMicroLamports) ?? 15_000));
      const effectivePriority = Math.max(floor, Math.floor(Math.max(basePriority, dynFromSub * suggestedMul)));
      // Apply per-market multiplier and clamp
      const marketKey = `perp-${marketIndex}`;
      const mulCfg = Number((((CONFIG as any)?.drift?.feeMultipliers || {}) as Record<string, number>)[marketKey] ?? 1.0);
      const MAX_MICRO = 200_000;
      const priorityForSend = Math.min(MAX_MICRO, Math.max(floor, Math.floor(effectivePriority * (Number.isFinite(mulCfg) ? mulCfg : 1.0))));
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
        } catch {}
        return null;
      })() : Promise.resolve(null);
      const fillIxP = this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, makerInfos);
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
      } catch {}
      // Prefer cached blockhash; only fetch live if no cache available
      let cachedBhEarly = (() => {
        try {
          return getCachedBlockhash(200) || this.bhCacheStr;
        } catch { return this.bhCacheStr; }
      })();
      let updateFillerIx: any = null, fillIx: any, revertIx: any = null, bh: any;
      // Always await fill ix (required), but time-bound update/revert so they don't block the first send
      const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let usedNoMakersFallback = false;
      if (!cachedBhEarly) {
        try {
          const bhStr = await getFreshBlockhashOrFetch(250);
          if (bhStr) { this.bhCacheStr = bhStr; this.bhCacheTs = Date.now(); cachedBhEarly = bhStr; timings.bh = Date.now(); }
        } catch {}
      }
      if (cachedBhEarly) {
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
            try { logger.info('drift.filler.build_fallback_nomakers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') }); } catch {}
            timings.fillFb = Date.now();
          } catch (e: any) {
            try { logger.info('drift.filler.build_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) }); } catch {}
            return false;
          }
        }
        try { updateFillerIx = await withRpcTimeout(updateFillerIxP as any, updateBudgetMs, 'upd_ix'); } catch { updateFillerIx = null; }
        timings.upd = Date.now();
        try { if (updateFillerIx) { revertIx = await withRpcTimeout(revertIxP as any, 110, 'rev_ix'); } else { revertIx = null; } } catch { revertIx = null; }
        timings.rev = Date.now();
        if (updateFillerIx) { this.lastUpdateFillerMs = Date.now(); }
      } else {
        // No fresh cached blockhash; defer quickly to avoid stalling the loop
        try { logger.info('drift.filler.defer_no_cached_bh', { cat: FILLER_CAT, subcat: FILLER_SUBCAT }); } catch {}
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
            try { logger.info('drift.filler.missing_referrer_stats_proceed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
          }
        }
      } catch {}

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
            } catch {}
          }
        }
        // Do not enforce tips for Sender; Sender can be used without tipping per requirement
      } catch {}
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
      } catch {}

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
      } catch {}

      if (this.state.dryRun) {
        logger.info('drift.filler.dry_run', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), marketIndex });
        return false;
      }

      const cachedBh = (() => {
        try {
          return getCachedBlockhash(250) || this.bhCacheStr;
        } catch { return this.bhCacheStr; }
      })();
      const recentBlockhash = String(cachedBh || cachedBhEarly || (bh as any)?.blockhash);
      try { if (recentBlockhash) { this.bhCacheStr = recentBlockhash; this.bhCacheTs = Date.now(); } } catch {}
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
          try { logger.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'sender', ms: Date.now() - t0send }); } catch {}
          return sig;
        };
        const rpcSend = async () => {
          const sig = await DriftService.getInstance().sendRawTransaction(raw, opts);
          try { logger.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'rpc', ms: Date.now() - t0send }); } catch {}
          return sig;
        };
        const beSend = async () => {
          const sig = await sendToBlockEngine(base64, { beUrl: (CONFIG as any)?.jito?.blockEngineUrl, timeoutMs: (CONFIG as any)?.jito?.bundleTimeoutMs });
          this.beFailCount = 0; this.beCoolUntilMs = 0;
          try { logger.info('drift.filler.sent_via', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, path: 'jito-be', ms: Date.now() - t0send }); } catch {}
          return sig;
        };
        // Prefer Sender when enabled (it already dual-routes to validators and Jito)
        if ((CONFIG as any)?.sender?.enabled) {
          try {
            return await senderSend();
          } catch (e: any) {
            try { logger.warn('drift.filler.sender_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) }); } catch {}
            // Continue to BE/RPC fallbacks
          }
        }
        if (beEnabled && raceRpc) {
          try {
            return await Promise.any([
              beSend().catch((e) => { this.beFailCount += 1; throw e; }),
              rpcSend(),
            ]);
          } catch (e: any) {
            if (this.beFailCount >= 3) { this.beCoolUntilMs = Date.now() + 60_000; }
            try { logger.warn('drift.filler.jito_be_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) }); } catch {}
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
            try { logger.warn('drift.filler.jito_be_fail', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, err: String(e?.message || e) }); } catch {}
          }
        }
        return await rpcSend();
      };

      const dispatch = async () => {
        try {
          const vtxPrimary = toV0Tx((updateFillerIx ? ixsWithUpdate : ixsFillOnly) as any);
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
          } catch {}
          const preferJito = !!((CONFIG as any)?.jito?.enabled);
          const hadTip = !!(plannedTipLamports && plannedTipAccount);
          const sigTx = await sendV0(vtxPrimary, preferJito, hadTip);
          this.fillsInWindow.push(Date.now());
          logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
          try {
            const { trackDriftAttempt } = await import('./txTracker.js');
            const makerKeys = Array.isArray(makers) ? makers : [];
            trackDriftAttempt(this.connection as any, {
              sig: sigTx,
              action: 'fill',
              marketIndex,
              taker: takerPkStr,
              makers: makerKeys,
              orderId: String(nodeToFill?.node?.order?.orderId || ''),
              priorityFeeMicroLamports: priorityForSend,
              cuLimit,
              bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
            }).catch(() => {});
          } catch {}
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
              try { logger.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: priorityForSend, reason: 'blockhash_refresh' }); } catch {}
              const sigTx = await sendV0(vRetry);
              this.fillsInWindow.push(Date.now());
              logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                const makerKeys = Array.isArray(makers) ? makers : [];
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers: makerKeys,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: priorityForSend,
                  cuLimit,
                  bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
                }).catch(() => {});
              } catch {}
              return;
            } catch {}
          }
          if (/0x185f|RevertFill/i.test(msg)) {
            // Mark taker on cooldown; likely JIT preemption for place-and-make
            try {
              const ttl = Math.max(5000, Number(this.config.denyJitTakersTtlMs ?? 15000));
              this.jitTakerCooldown.set(takerPkStr, Date.now() + ttl);
            } catch {}
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
                try { logger.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: boosted, reason: 'revert_retry' }); } catch {}
                sigTx = await sendV0(vUpd);
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
                try { logger.info('drift.filler.try_sent', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), cuLimit, priority: boosted, reason: 'revert_retry' }); } catch {}
                sigTx = await sendV0(vFill);
              }
              this.fillsInWindow.push(Date.now());
              logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                const makerKeys = Array.isArray(makers) ? makers : [];
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers: makerKeys,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: boosted,
                  cuLimit,
                  bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
                }).catch(() => {});
              } catch {}
            } catch (e2: any) {
              logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: String(e2?.message || e2) });
              // Record failed revert attempt as well
              try {
                const { recordAttempt } = await import('./txTracker.js');
                const makerKeys = Array.isArray(makers) ? makers : [];
                recordAttempt({
                  ts: Date.now(),
                  sig: 'FAILED',
                  action: 'fill',
                  marketIndex,
                  taker: takerPkStr,
                  makers: makerKeys,
                  orderId: String(nodeToFill?.node?.order?.orderId || ''),
                  priorityFeeMicroLamports: Math.max(priorityForSend, 30_000),
                  cuLimit,
                  bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
                  success: false,
                  feeLamports: 0,
                  priorityLamports: 0,
                  lamportsPaid: 0,
                } as any);
              } catch {}
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
            const makerKeys = Array.isArray(makers) ? makers : [];
            recordAttempt({
              ts: Date.now(),
              sig: 'FAILED',
              action: 'fill',
              marketIndex,
              taker: takerPkStr,
              makers: makerKeys,
              orderId: String(nodeToFill?.node?.order?.orderId || ''),
              priorityFeeMicroLamports: priorityForSend,
              cuLimit,
              bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
              success: false,
              feeLamports: 0,
              priorityLamports: 0,
              lamportsPaid: 0,
            } as any);
          } catch {}
        }
      };

      // Fire-and-continue; do not await
      dispatch().catch(() => {});
      try { logger.debug('drift.filler.dispatched', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), blockhash: recentBlockhash }); } catch {}
      return true;
    } catch (e: any) {
      logger.info('drift.filler.warn fill_node_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, err: String(e?.message || e) });
      return false;
    }
  }

  private async loop(): Promise<void> {
    if (this.abort) return;
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
      skips: {
        vammDisallowed: 0,
        ammBelowMin: 0,
        ammNotCrossing: 0,
        triggerOrder: 0,
        cooldown: 0,
        takerHydration: 0,
        missingRefStats: 0,
        noMakers: 0,
      },
    };
    this._loopStatsTmp = loopStats;

    try {
      const dlob = this.dlobSubscriber?.getDLOB?.();
      if (!dlob) {
        logger.info('drift.filler.warn dlob_unavailable', { cat: FILLER_CAT, subcat: FILLER_SUBCAT });
        this.dlobUnavailableCount = (this.dlobUnavailableCount || 0) + 1;
        if (this.dlobUnavailableCount >= 3) {
          try { await this.initDiscovery(); } catch {}
          try {
            if (!this.wsNudgeTimer) {
              this.wsNudgeTimer = setInterval(() => {
                try {
                  if (!this.inLoop && !this.abort) setImmediate(() => { this.loop().catch(() => {}); });
                } catch {}
              }, 1000);
            }
          } catch {}
          // Start WS fallback to nudge when orderbooks update
          try {
            if (!this.dlobWsFallback) {
              const { DlobFallback } = await import('./dlobFallback.js');
              const markets = Array.isArray(await this.client.getPerpMarketAccounts?.())
                ? (await this.client.getPerpMarketAccounts?.()).map((m: any) => Number(m?.marketIndex || 0)).filter((n: any) => Number.isFinite(n))
                : [0,1,2];
              const onNudge = () => { try { if (!this.inLoop && !this.abort) setImmediate(() => { this.loop().catch(() => {}); }); } catch {} };
              this.dlobWsFallback = new DlobFallback(onNudge);
              await this.dlobWsFallback.start(markets);
            }
          } catch {}
        }
        return;
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

      const slot = this.slotSubscriber?.getSlot?.() ?? 0;
      const stateAcc = this.client.getStateAccount?.();
      const perps = await this.client.getPerpMarketAccounts?.();

      try {
        const driftCfg: any = (CONFIG as any)?.drift || {};
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
      } catch {}

      let totalPlanned = 0;
      let sent = 0;
      const sample: Array<{ m: number; taker: string; id: string; makers: number }> = [];

      for (const market of (Array.isArray(perps) ? perps : [])) {
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
            try { logger.info('drift.filler.skip_paused_market', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, status: statusStr }); } catch {}
            loopStats.marketsPaused += 1;
            continue;
          }
        } catch {}
        const mmOraclePriceData = this.client.getMMOracleDataForPerpMarket?.(idx);
        // Skip markets with stale oracle data to avoid zero-fills due to SafeMM checks
        try {
          const od = this.client.getOracleDataForPerpMarket?.(idx);
          const odSlot = Number((od as any)?.slot?.toString?.() || 0);
          const curSlot = this.slotSubscriber?.getSlot?.() ?? 0;
          const maxDelay = Math.max(0, Number(((CONFIG as any)?.drift?.maxOracleDelaySlots) ?? 40));
          if (odSlot > 0 && (curSlot - odSlot) > maxDelay) {
            try { logger.info('drift.filler.skip_oracle_stale', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, oracleDelay: (curSlot - odSlot), maxDelay }); } catch {}
            loopStats.marketsOracleStale += 1;
            continue;
          }
        } catch {}
        const vAsk = calculateAskPrice(market, mmOraclePriceData, slotBn);
        const vBid = calculateBidPrice(market, mmOraclePriceData, slotBn);

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
        } catch {}

        const nodesToFill = dlob.findNodesToFill(
          idx, vBid, vAsk, slot,
          Math.floor(Date.now() / 1000) - 60,
          MarketType.PERP, mmOraclePriceData,
          stateAcc, this.client.getPerpMarketAccount?.(idx)
        ) || [];
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

        totalPlanned += prefiltered.length;
        loopStats.nodesPlanned += prefiltered.length;

        try {
          logger.debug('drift.filler.market_nodes', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            nodes: nodesToFill.length,
          });
        } catch {}

        // Enqueue taker/maker accounts for prefetch warming
        try {
          const svc = DriftService.getInstance() as any;
          const keys: string[] = [];
          for (const n of nodesToFill) {
            const t = String(n?.node?.userAccount || ''); if (t) keys.push(t);
            const mks = Array.isArray(n?.makerNodes) ? n.makerNodes : [];
            for (const mn of mks) { const mk = String(mn?.userAccount || ''); if (mk) keys.push(mk); }
          }
          svc.enqueueUsersForPrefetch?.(keys);
        } catch {}

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
        } catch {}

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
              try { logger.debug('drift.filler.skip_young_order', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, ageMs }); } catch {}
              (loopStats.skips as any).young = ((loopStats.skips as any).young || 0) + 1;
              return false;
            }

            // Taker cooldown (recent JIT preemption)
            const takerPk = String(node?.node?.userAccount || '');
            const untilMs = this.jitTakerCooldown.get(takerPk) || 0;
            if (untilMs > nowMs) {
              try { logger.debug('drift.filler.skip_jit_taker_cooldown', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, taker: takerPk }); } catch {}
              (loopStats.skips as any).jitCooldown = ((loopStats.skips as any).jitCooldown || 0) + 1;
              return false;
            }

            // Require existing makers
            if (requireMakers) {
              const makersLen = Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0;
              if (makersLen < minMakers) {
                try { logger.debug('drift.filler.skip_no_makers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, makersLen, minMakers }); } catch {}
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
              } catch {}
            }

            return true;
          } catch { return true; }
        });

        let iter = 0;
        for (const node of filtered) {
          if ((Date.now() - t0) > LOOP_BUDGET_MS || processedNodes >= MAX_NODES_PER_LOOP) {
            budgetExceeded = true;
            try { logger.debug('drift.filler.loop_budget_exhausted', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, processedNodes, ms: Date.now() - t0 }); } catch {}
            loopStats.budget.exhausted = true;
            loopStats.budget.processedNodes = processedNodes;
            break;
          }
          iter += 1;
          if ((iter % 50) === 0) { try { await new Promise((r) => setImmediate(r)); } catch {} }
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
                } catch {}
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
                } catch {}
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
                  } catch {}
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
                    } catch {}
                    loopStats.skips.ammNotCrossing += 1;
                    continue;
                  }
                }
              }
            } catch {}

            // Identify order type; skip true trigger orders (TriggerMarket/TriggerLimit) until triggered
            const o = node?.node?.order;
            let orderTypeStr: string | undefined = undefined;
            try { orderTypeStr = o?.orderType ? String(getVariant(o.orderType)) : undefined; } catch {}
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
              } catch {}
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
              } catch {}
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
              logger.info('drift.filler.node_info', {
                cat: FILLER_CAT,
                subcat: FILLER_SUBCAT,
                marketIndex: idx,
                taker: String(node?.node?.userAccount || ''),
                orderId: String(node?.node?.order?.orderId || ''),
                makerCount: Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0,
                orderType: orderTypeStr,
                triggerCondition: triggerCondStr,
              });
            } catch {}

            try {
              logger.info('drift.filler.try_fill', {
                cat: FILLER_CAT,
                subcat: FILLER_SUBCAT,
                marketIndex: idx,
                taker: String(node?.node?.userAccount || ''),
                orderId: String(node?.node?.order?.orderId || ''),
                makerCount: Array.isArray(node?.makerNodes) ? node.makerNodes.length : 0,
                cuLimit: Math.max(220_000, Math.min(800_000, Number(this.config.cuLimit ?? 300_000))),
                priority: Math.max(10_000, Number(((CONFIG as any)?.fees?.fillerPriorityFloorMicroLamports) ?? 15_000)),
                dryRun: !!this.state.dryRun,
              });
            } catch {}

            // Count budget once node is eligible for a send attempt
            processedNodes += 1;
            loopStats.nodesProcessed += 1;
            loopStats.eligibleNodes = (loopStats.eligibleNodes || 0) + 1;

            const ok = await this.tryFillNode(idx, node);
            if (ok) { sent += 1; loopStats.nodesSent += 1; }
          } catch {}
        }

        try {
          logger.debug('drift.filler.market_done', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            ms: Date.now() - mStart,
          });
        } catch {}
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
      } catch {}
      if (totalPlanned === 0) {
        try {
          logger.info('drift.filler.loop_noop', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            slot,
            perpsCount: Array.isArray(perps) ? perps.length : 0,
          });
        } catch {}
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


