// NOTE: type coverage tightened for key SDK surfaces only; keeping any for dynamic SDK
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { createHash } from 'crypto';
import { CONFIG } from '../utils/config.js';
import { ensureWallet } from '../wallet/wallet.js';
import type { DriftStatus, SubaccountInfo, DriftMarketRef, DriftCluster } from './types.js';
import { parseAllowlistMarkets } from './marketMapping.js';
import { logger } from '../utils/logger.js';

// Lazy import SDK to keep startup fast and optional
type DriftEnv = {
  DriftClient: any;
  Wallet: any;
  User: any;
  BulkAccountLoader: any;
  getMarketsAndOraclesForSubscription?: (env: string) => any;
  getMaxNumberOfSubAccounts?: () => number | Promise<number>;
  initialize: (args: { connection: Connection; wallet: any; opts?: any }) => Promise<any>;
};

let driftEnv: DriftEnv | null = null;

async function loadSdk(): Promise<DriftEnv> {
  if (driftEnv) return driftEnv;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = await import('@drift-labs/sdk');
  driftEnv = {
    DriftClient: (sdk as any).DriftClient,
    Wallet: (sdk as any).Wallet,
    User: (sdk as any).User,
    BulkAccountLoader: (sdk as any).BulkAccountLoader,
    getMarketsAndOraclesForSubscription: (sdk as any).getMarketsAndOraclesForSubscription,
    getMaxNumberOfSubAccounts: (sdk as any).getMaxNumberOfSubAccounts,
    // Ensure options are spread at top-level per SDK constructor shape
    initialize: async ({ connection, wallet, opts }: any) => new (sdk as any).DriftClient({ connection, wallet, ...(opts || {}) })
  };
  return driftEnv;
}

export class DriftService {
  private static instance: DriftService | null = null;
  private connection: Connection | null = null;
  private walletKp: Keypair | null = null;
  private client: any | null = null;
  private cluster: DriftCluster = (CONFIG as any).drift?.cluster || 'mainnet-beta';
  private subaccountsCache: { data: SubaccountInfo[]; ts: number } | null = null;
  private loader: any | null = null;
  private lastTxAtMs: number = 0;
  private readConnection: Connection | null = null;
  private sharedSlotSubscriber: any | null = null;
  private sharedEventSubscriber: any | null = null;
  private sharedUserMap: any | null = null;
  private sharedDlobSubscriber: any | null = null;
  private sharedOrderSubscriber: any | null = null;
  private txQueueInFlight = 0;
  private txQueue: Array<() => void> = [];
  private maxTxInFlight = 2;
  private minTxGapMs = 200;
  // Warm user prefetch infra (store live SDK User or decoded UA)
  private warmUsers: Map<string, { user?: any; ua?: any; ts: number }> = new Map();
  private prefetchRunning = false;
  private prefetchTimer: any | null = null;
  private prefetchQueue: string[] = [];
  private pollLoaderWarm: any | null = null;
  // Referrer stats warm cache
  private warmRefStats: Set<string> = new Set();
  private missingRefStats: Map<string, number> = new Map();
  private refStatsTtlMs = 60_000;
  // Infra lifecycle controls
  private forceActive: boolean = false;
  private activeBots: Set<string> = new Set();
  private infraWatchdogTimer: any | null = null;
  private lastSlotTs: number = 0;
  private _slotTsHandler: any | null = null;
  private _lastResubMs: number = 0;
  private _staleCount: number = 0;
  private lastPrefetchSlot: number = 0;
  // Warmup state
  private warmupInProgress: boolean = false;
  private warmupDone: boolean = false;
  private warmupPromise: Promise<void> | null = null;
  private lastWarmupAtMs: number = 0;

  static getInstance(): DriftService {
    if (!this.instance) this.instance = new DriftService();
    return this.instance;
  }
  getReadConnection(): Connection {
    if (!this.readConnection) {
      const url: string = String(((CONFIG as any)?.readRpcUrl) || (CONFIG as any)?.rpcUrl);
      // Custom fetch to tag 429s and disable internal 429 retry loop
      const customFetch = async (info: any, init: any) => {
        const baseFetch: any = (globalThis as any).fetch || (await import('node-fetch')).default;
        const res: any = await baseFetch(info, init);
        try {
          if (res && typeof res.status === 'number' && res.status === 429) {
            let method: string | undefined;
            try { method = JSON.parse(String(init?.body || '{}'))?.method; } catch {}
            try { logger.warn('rpc.429', { method, url: String(info), cat: 'rpc' }); } catch {}
          }
        } catch {}
        return res as any;
      };
      this.readConnection = new Connection(url, { commitment: 'processed', disableRetryOnRateLimit: true, fetch: customFetch } as any);
    }
    return this.readConnection;
  }
  private getHeliusConn(): Connection {
    const primary = this.connection!;
    const read = this.getReadConnection();
    const p = String((primary as any)?._rpcEndpoint || (primary as any)?.rpcEndpoint || '');
    const r = String((read as any)?._rpcEndpoint || (read as any)?.rpcEndpoint || '');
    return /helius/i.test(p) ? primary : (/helius/i.test(r) ? read : primary);
  }
  private async toSpotNativeAmount(client: any, spotMarketIndex: number, uiAmount: number): Promise<number> {
    try {
      if (typeof client?.convertToSpotPrecision === 'function') {
        const v = await client.convertToSpotPrecision(Number(spotMarketIndex), Number(uiAmount));
        return Number(v);
      }
    } catch {}
    return Number(Math.round(Number(uiAmount) * 1_000_000));
  }

  private async toBN(n: number): Promise<any> {
    try {
      const sdk: any = await import('@drift-labs/sdk');
      const BN = (sdk as any).BN || (sdk as any).AnchorsBN || undefined;
      if (BN) return new BN(Number(n));
    } catch {}
    try {
      const mod: any = await import('bn.js');
      const BN = mod?.BN || mod?.default?.BN || mod?.default;
      if (BN) return new BN(Number(n));
    } catch {}
    return Number(n);
  }

  async getFundingRate(marketIndex: number): Promise<{ lastFundingRate: number; cumulativeFunding: number } | null> {
    await this.init();
    try {
      const PREC = 1e9; // FUNDING_RATE_PRECISION
      const mkt = this.client?.getPerpMarketAccount?.(marketIndex);
      if (!mkt) return null;
      const last = Number(mkt?.amm?.lastFundingRate?.toString?.() || 0) / PREC;
      const cum = Number(mkt?.amm?.cumulativeFundingRate?.toString?.() || 0) / PREC;
      return { lastFundingRate: last, cumulativeFunding: cum };
    } catch {
      return null;
    }
  }

  async getUnrealizedPerpPnl(marketIndex: number): Promise<number | null> {
    await this.init();
    try {
      const user: any = this.client?.user || null;
      const val = await (user?.getUnrealizedPerpPnl?.(marketIndex));
      const n = Number(val?.toString?.() || val || 0);
      return isFinite(n) ? n : 0;
    } catch {
      return null;
    }
  }

  async getUnrealizedFundingPnl(marketIndex: number): Promise<number | null> {
    await this.init();
    try {
      const user: any = this.client?.user || null;
      const val = await (user?.getUnrealizedFundingPnl?.(marketIndex));
      const n = Number(val?.toString?.() || val || 0);
      return isFinite(n) ? n : 0;
    } catch {
      return null;
    }
  }

  async init(): Promise<void> {
    if (this.client) return;
    this.walletKp = await ensureWallet(CONFIG.walletPath);
    // Custom fetch to tag 429s and disable internal 429 retry loop
    const customFetch = async (info: any, init: any) => {
      const baseFetch: any = (globalThis as any).fetch || (await import('node-fetch')).default;
      const res: any = await baseFetch(info, init);
      try {
        if (res && typeof res.status === 'number' && res.status === 429) {
          let method: string | undefined;
          try { method = JSON.parse(String(init?.body || '{}'))?.method; } catch {}
          try { logger.warn('rpc.429', { method, url: String(info), cat: 'rpc' }); } catch {}
        }
      } catch {}
      return res as any;
    };
    this.connection = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: customFetch } as any);
    
    // Intercept getAccountInfo to ensure all calls go through rate limiter
    // This catches SDK-internal getAccountInfo calls that bypass direct rate limiting
    const originalGetAccountInfo = this.connection.getAccountInfo.bind(this.connection);
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    this.connection.getAccountInfo = async function(...args: any[]) {
      return await withRpcLimit(() => originalGetAccountInfo(...args));
    };
    
    const t0 = Date.now();
    logger.info('drift.sdk.init', { rpcUrl: CONFIG.rpcUrl, cluster: this.cluster, cat: 'drift', code: 'DRIFT.SDK.INIT' });
    const { initialize, Wallet, BulkAccountLoader, getMarketsAndOraclesForSubscription } = await loadSdk();
    // Use SDK Wallet wrapper per docs
    const wallet = new Wallet(this.walletKp);
    // Choose subscription type. Default to websocket to avoid RPC batch limitations on some providers
    const subType = ((CONFIG as any).drift?.subscriptionType || 'websocket').toLowerCase();
    const subscription = subType === 'polling'
      ? { type: 'polling', accountLoader: new BulkAccountLoader(this.connection, 'confirmed', 1000) }
      : { type: 'websocket' };
    // Only prepare shared loader when polling is explicitly requested
    try {
      this.loader = subType === 'polling' ? new BulkAccountLoader(this.connection, 'confirmed', 1000) : null;
      try { (this.loader as any)?.on?.('error', (e: any) => { try { logger.warn('drift.loader.error', { error: String(e?.message || e), cat: 'drift' }); } catch {} }); } catch {}
    } catch { this.loader = null; }
    const programIdOpt = (CONFIG as any).drift?.programId ? { programID: new PublicKey((CONFIG as any).drift.programId) } : {};
    const marketOpts = typeof getMarketsAndOraclesForSubscription === 'function' ? (getMarketsAndOraclesForSubscription as any)(this.cluster) : {};
    this.client = await initialize({ connection: this.connection, wallet, opts: { env: this.cluster, accountSubscription: subscription, ...programIdOpt, ...marketOpts } });
    
    // Wait for WebSocket to be ready before subscribing to avoid "socket was not CONNECTING or OPEN" errors
    const waitUntilWsReady = async (): Promise<void> => {
      try {
        const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 5000));
        const started = Date.now();
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const getRpcWebSocketReadyState = (): number | undefined => {
          try {
            const rpcWs: any = (this.connection as any)?._rpcWebSocket;
            if (!rpcWs) return undefined;
            const sockets = [
              (rpcWs as any)?.underlyingSocket,
              (rpcWs as any)?._ws,
              (rpcWs as any)?.socket,
              (rpcWs as any)?._socket,
            ];
            for (const sock of sockets) {
              const ready = Number((sock as any)?.readyState);
              if (Number.isFinite(ready) && ready >= 0) return ready;
            }
            if ((this.connection as any)?._rpcWebSocketConnected === true) return 1;
          } catch {}
          return undefined;
        };
        for (;;) {
          const rs = getRpcWebSocketReadyState();
          // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
          if (rs === 0 || rs === 1) {
            const waited = Date.now() - started;
            if (waited > 200) {
              try { logger.debug('drift.ws waitUntilWsReady waited', { ms: waited, cat: 'drift' }); } catch {}
            }
            return;
          }
          if (Date.now() >= deadline) {
            try { logger.debug('drift.ws waitUntilWsReady timeout', { ms: Date.now() - started, cat: 'drift' }); } catch {}
            return;
          }
          if (rs === undefined || rs === 3) {
            try { await (this.connection as any)?._rpcWebSocket?.connect?.(); } catch {}
          }
          await sleep(150);
        }
      } catch {}
    };
    
    // Only wait for WebSocket if using websocket subscriptions
    if (subType === 'websocket') {
      try {
        await waitUntilWsReady();
      } catch (e: any) {
        try { logger.warn('drift.ws waitUntilWsReady error', { error: String(e?.message || e), cat: 'drift' }); } catch {}
      }
    }
    
    // Subscribe to populate internal caches for markets/users/oracles
    // Retry subscribe with backoff if WebSocket isn't ready yet
    try {
      if (typeof (this.client as any)?.subscribe === 'function') {
        const maxRetries = 3;
        const baseDelayMs = 500;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            await (this.client as any).subscribe();
            break;
          } catch (e: any) {
            const msg = String(e?.message || e);
            const isWsState = msg.includes('socket was not') || msg.includes('readyState');
            if (isWsState && attempt < maxRetries - 1) {
              const delay = baseDelayMs * Math.pow(1.5, attempt);
              try { logger.debug('drift.ws subscribe retry', { attempt: attempt + 1, delay, error: msg, cat: 'drift' }); } catch {}
              await new Promise(r => setTimeout(r, delay));
              // Wait for WebSocket again before retrying
              if (subType === 'websocket') {
                try { await waitUntilWsReady(); } catch {}
              }
              continue;
            }
            // If not a WebSocket state error or out of retries, log and rethrow
            try { logger.warn('drift.ws subscribe failed', { error: msg, attempt: attempt + 1, cat: 'drift' }); } catch {}
            throw e;
          }
        }
      }
    } catch (e: any) {
      // Log but don't fail initialization - the client can still work with polling or retry later
      try { logger.warn('drift.ws subscribe error (non-fatal)', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    }
    // Ensure default user is initialized and registered with the client
    try {
      const defaultId = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
      if (typeof (this.client as any)?.addUser === 'function') {
        await (this.client as any).addUser(defaultId);
      }
      if (typeof (this.client as any)?.initializeUserIfNotExists === 'function') {
        await (this.client as any).initializeUserIfNotExists(defaultId);
      } else if (typeof (this.client as any)?.initializeUser === 'function') {
        // Some SDKs initialize the active/default user without args
        try { await (this.client as any).initializeUser(defaultId); } catch { try { await (this.client as any).initializeUser(); } catch {} }
      }
    } catch {}
    logger.info('drift.sdk.ready', { pubkey: this.walletKp.publicKey?.toBase58?.(), ms: Date.now() - t0, cat: 'drift', code: 'DRIFT.SDK.READY' });
  }

  async getSharedInfra(opts?: { includeIdle?: boolean; updateFrequency?: number; preferOrderSubscriber?: boolean }): Promise<{ slotSubscriber: any; eventSubscriber: any; userMap: any; dlobSubscriber: any; orderSubscriber?: any }> {
    await this.init();
    let sdk: any = null;
    try { sdk = await import('@drift-labs/sdk'); } catch {}
    const drift: any = this.client;
    const connection = drift?.connection || this.connection;
    const program = drift?.program;

    // Add this helper function at the start of getSharedInfra
    const waitUntilWsReady = async (): Promise<void> => {
      try {
        const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 5000));
        const started = Date.now();
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const getRpcWebSocketReadyState = (): number | undefined => {
          try {
            const rpcWs: any = (connection as any)?._rpcWebSocket;
            if (!rpcWs) return undefined;
            const sockets = [
              (rpcWs as any)?.underlyingSocket,
              (rpcWs as any)?._ws,
              (rpcWs as any)?.socket,
              (rpcWs as any)?._socket,
            ];
            for (const sock of sockets) {
              const ready = Number((sock as any)?.readyState);
              if (Number.isFinite(ready) && ready >= 0) return ready;
            }
            if ((connection as any)?._rpcWebSocketConnected === true) return 1;
          } catch {}
          return undefined;
        };
        for (;;) {
          const rs = getRpcWebSocketReadyState();
          // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
          if (rs === 0 || rs === 1) {
            const waited = Date.now() - started;
            if (waited > 200) {
              try { logger.debug('drift.ws waitUntilWsReady waited', { ms: waited, cat: 'drift', location: 'getSharedInfra' }); } catch {}
            }
            return;
          }
          if (Date.now() >= deadline) {
            try { logger.debug('drift.ws waitUntilWsReady timeout', { ms: Date.now() - started, cat: 'drift', location: 'getSharedInfra' }); } catch {}
            return;
          }
          if (rs === undefined || rs === 3) {
            try { await (connection as any)?._rpcWebSocket?.connect?.(); } catch {}
          }
          await sleep(150);
        }
      } catch {}
    };

    // Start shared blockhash cache/warmer once for all bots
    try {
      const { startSharedBlockhash } = await import('../utils/blockhash.js');
      const intervalMs = Math.max(300, Number(((CONFIG as any)?.drift?.blockhashWarmMs) ?? 400));
      // Prefer read RPC for frequent blockhash fetches to reduce contention/timeouts on primary
      startSharedBlockhash(this.getReadConnection(), { intervalMs });
    } catch {}

    // Gentle pacing between subscription attaches to avoid startup bursts
    const spacing = Math.max(0, Number(((CONFIG as any)?.drift?.subscribeSpacingMs) ?? 100));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

    if (!this.sharedSlotSubscriber && sdk?.SlotSubscriber) {
      try {
        await waitUntilWsReady(); // ADD THIS
        this.sharedSlotSubscriber = new (sdk as any).SlotSubscriber(connection);
        await this.sharedSlotSubscriber.subscribe();
        // Ensure slot timestamp listener is wired to the current emitter
        this.wireSlotTsListener(true);
        await sleep(spacing);
      } catch {}
    } else {
      // Best-effort resubscribe if previously unsubscribed
      try {
        await waitUntilWsReady(); // ADD THIS
        await (this.sharedSlotSubscriber as any)?.subscribe?.();
        this.wireSlotTsListener(true);
        await sleep(spacing);
      } catch {}
    }

    if (!this.sharedEventSubscriber && sdk?.EventSubscriber) {
      try {
        await waitUntilWsReady(); // ADD THIS
        this.sharedEventSubscriber = new (sdk as any).EventSubscriber(connection, program);
        await this.sharedEventSubscriber.subscribe();
        await sleep(spacing);
      } catch {}
    } else {
      try { 
        await waitUntilWsReady(); // ADD THIS
        await (this.sharedEventSubscriber as any)?.subscribe?.(); 
        await sleep(spacing); 
      } catch {}
    }

    // Wire slot timestamp listener and start watchdog for stale resubscribe
    try {
      if (this.sharedSlotSubscriber) {
        if (!this.lastSlotTs) this.lastSlotTs = Date.now();
        this.wireSlotTsListener(false);
      }
    } catch {}

    try {
      const slotStaleMs = Math.max(5000, Number(((CONFIG as any)?.drift?.slotStaleMs) ?? 15000));
      const resubCooldownMs = Math.max(5000, Number(((CONFIG as any)?.drift?.resubCooldownMs) ?? 10000));
      if (!this.infraWatchdogTimer) {
        this.infraWatchdogTimer = setInterval(async () => {
          try {
            const now = Date.now();
            const stale = !this.lastSlotTs || (now - this.lastSlotTs) > slotStaleMs;
            if (!stale) { this._staleCount = 0; return; }
            const cooled = (now - this._lastResubMs) >= resubCooldownMs;
            if (!cooled) return;
            this._lastResubMs = now;

            // Heartbeat: try a quick slot fetch; if successful, mark fresh and skip resubscribe
            try {
              const { withRpcTimeout } = await import('../utils/rpcLimiter.js');
              const hbSlot = await withRpcTimeout(this.getReadConnection().getSlot('processed'), 1500, 'slot.heartbeat');
              if (Number.isFinite(Number(hbSlot))) {
                this.lastSlotTs = Date.now();
                this._staleCount = 0;
                return;
              }
            } catch {}

            // Escalating resubscribe: start with slot only, then event, then userMap, then DLOB
            const stage = Math.min(3, Math.max(0, this._staleCount));
            try {
              if (stage >= 0) {
                try { await waitUntilWsReady(); await (this.sharedSlotSubscriber as any)?.subscribe?.(); this.wireSlotTsListener(true); } catch {}
              }
              if (stage >= 1) {
                try { await waitUntilWsReady(); await (this.sharedEventSubscriber as any)?.subscribe?.(); } catch {}
              }
              if (stage >= 2) {
                try { await waitUntilWsReady(); await (this.sharedUserMap as any)?.subscribe?.(); } catch {}
              }
              if (stage >= 3) {
                try {
                  const dl: any = this.sharedDlobSubscriber;
                  const has = dl && typeof dl.getDLOB === 'function' ? !!dl.getDLOB() : true;
                  if (dl && typeof dl.subscribe === 'function' && !has) { await waitUntilWsReady(); await dl.subscribe(); }
                } catch {}
              }
            } finally {
              this._staleCount = Math.min(4, this._staleCount + 1);
            }
            try { logger.warn('drift.subs.resubscribe', { cat: 'drift', reason: 'slot_stale', stage }); } catch {}
          } catch {}
        }, 2500);
      }
    } catch {}

    if (!this.sharedUserMap && sdk?.UserMap) {
      const subType = String(((CONFIG as any)?.drift?.subscriptionType || 'websocket')).toLowerCase();
      const umSubCfg: any = subType === 'polling'
        ? { type: 'polling', frequency: 1000 }
        : { type: 'websocket', resubTimeoutMs: 10000 };
      try {
        this.sharedUserMap = new (sdk as any).UserMap({
          driftClient: drift,
          connection,
          slotSubscriber: this.sharedSlotSubscriber,
          eventSubscriber: this.sharedEventSubscriber,
          subscriptionConfig: umSubCfg,
          includeIdle: !!(opts?.includeIdle),
          disableSyncOnTotalAccountsChange: true,
        });
      } catch {
        try {
          this.sharedUserMap = new (sdk as any).UserMap({
            driftClient: drift,
            slotSubscriber: this.sharedSlotSubscriber,
            eventSubscriber: this.sharedEventSubscriber,
            subscriptionConfig: { type: 'websocket' },
            includeIdle: !!(opts?.includeIdle),
          });
        } catch {}
      }
      try { 
        await waitUntilWsReady(); // ADD THIS
        await this.sharedUserMap?.subscribe?.(); 
        await sleep(spacing); 
      } catch {}
    } else {
      try { 
        await waitUntilWsReady(); // ADD THIS
        await (this.sharedUserMap as any)?.subscribe?.(); 
        await sleep(spacing); 
      } catch {}
    }

    // Optional OrderSubscriber for improved DLOB order coverage
    if (!this.sharedOrderSubscriber && (sdk as any)?.OrderSubscriber) {
      try {
        try {
          this.sharedOrderSubscriber = new (sdk as any).OrderSubscriber({
            driftClient: drift,
            slotSubscriber: this.sharedSlotSubscriber,
            eventSubscriber: this.sharedEventSubscriber,
            resyncIntervalMs: Number(((CONFIG as any)?.drift?.orderResyncIntervalMs) ?? 15000),
          });
        } catch {
          // fallback to legacy constructor
          this.sharedOrderSubscriber = new (sdk as any).OrderSubscriber(connection, program);
        }
        try { 
          await waitUntilWsReady(); // ADD THIS
          await this.sharedOrderSubscriber?.subscribe?.(); 
          await sleep(spacing); 
        } catch {}
      } catch {}
    } else {
      try { 
        await waitUntilWsReady(); // ADD THIS
        await (this.sharedOrderSubscriber as any)?.subscribe?.(); 
        await sleep(spacing); 
      } catch {}
    }

    const dlobSource = (opts?.preferOrderSubscriber && this.sharedOrderSubscriber) ? this.sharedOrderSubscriber : this.sharedUserMap;
    if (!this.sharedDlobSubscriber && sdk?.DLOBSubscriber && dlobSource && this.sharedSlotSubscriber) {
      try {
        this.sharedDlobSubscriber = new (sdk as any).DLOBSubscriber({
          dlobSource,
          slotSource: this.sharedSlotSubscriber,
          updateFrequency: Math.max(200, Number(opts?.updateFrequency ?? 300)),
          driftClient: drift,
          userMapSubscriptionConfig: (() => { try { return drift.userAccountSubscriptionConfig || undefined; } catch { return undefined; } })(),
        });
        await waitUntilWsReady(); // ADD THIS
        await this.sharedDlobSubscriber.subscribe();
        await sleep(spacing);
      } catch {}
    } else {
      try {
        // If present but inactive, re-subscribe
        const dl: any = this.sharedDlobSubscriber;
        if (dl && typeof dl.subscribe === 'function') {
          // If getDLOB exists and returns falsy, attempt to resubscribe
          const has = typeof dl.getDLOB === 'function' ? !!dl.getDLOB() : true;
          if (!has) { 
            await waitUntilWsReady(); // ADD THIS
            await dl.subscribe(); 
            await sleep(spacing); 
          }
        }
      } catch {}
    }

    return {
      slotSubscriber: this.sharedSlotSubscriber,
      eventSubscriber: this.sharedEventSubscriber,
      userMap: this.sharedUserMap,
      dlobSubscriber: this.sharedDlobSubscriber,
      orderSubscriber: this.sharedOrderSubscriber,
    };
  }

  // One-shot warmup to prepare infra and perform optional GPA bootstrap
  async warmup(opts?: { includeIdle?: boolean; updateFrequency?: number; preferOrderSubscriber?: boolean }): Promise<void> {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    if (this.warmupDone) return;
    if (this.warmupInProgress && this.warmupPromise) { await this.warmupPromise; return; }
    this.warmupInProgress = true;
    this.warmupPromise = (async () => {
      const t0 = Date.now();
      try {
        await this.init();
        const infra = await this.getSharedInfra({ includeIdle: !!opts?.includeIdle, updateFrequency: opts?.updateFrequency, preferOrderSubscriber: (opts?.preferOrderSubscriber ?? true) });
        try { await this.startUserPrefetcher(infra.dlobSubscriber, infra.userMap); } catch {}
        // Optional GPA bootstrap on Helius endpoints
        try {
          const heliusConn: any = this.getHeliusConn();
          const rpcEndpoint: string = String(heliusConn?._rpcEndpoint || heliusConn?.rpcEndpoint || '');
          const doGpa = driftCfg?.warmupGpaBootstrap !== false && /helius/i.test(rpcEndpoint) && driftCfg?.prefetchEnabled !== false;
          if (doGpa) {
            const rawLim = driftCfg?.warmupGpaLimit ?? driftCfg?.prefetchGpaLimit ?? 1200;
            const limNum = Number(rawLim);
            const max = Math.max(100, Number.isFinite(limNum) ? limNum : 1200);
            try { logger.info('drift.warmup.gpa_start', { limit: max, cat: 'drift' }); } catch {}
            let decoded: Map<string, any> | null = null;
            try { decoded = await this.fetchUsersViaHeliusGpaV2(max, /*changedOnly*/ false); } catch { decoded = null; }
            if (decoded && decoded.size > 0) {
              for (const [pk, ua] of decoded.entries()) {
                try {
                  if (this.warmUsers.size >= 500) {
                    const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
                    if (oldest) { try { await (this.warmUsers.get(oldest) as any)?.user?.unsubscribe?.(); } catch {} this.warmUsers.delete(oldest); }
                  }
                  this.warmUsers.set(pk, { ua, ts: Date.now() });
                  try {
                    const ref = ua?.referrerInfo?.referrer;
                    if (ref && String(ref) !== '11111111111111111111111111111111') { await this.ensureRefStatsReady(ref); }
                  } catch {}
                } catch {}
              }
              try { logger.info('drift.warmup.gpa_done', { decoded: decoded.size, cat: 'drift' }); } catch {}
            } else {
              // Fallback: enumerate keys (cheap) then fetch via MACI in small chunks
              try {
                const fastKeys = await this.enumerateUserPubkeysViaHeliusGpaV2(max, false);
                if (Array.isArray(fastKeys) && fastKeys.length > 0) {
                  try { logger.info('drift.warmup.enumerate_ok', { keys: fastKeys.length, cat: 'drift' }); } catch {}
                  const chunkSize = Math.max(10, Number(driftCfg?.prefetchChunkSize ?? 20));
                  for (let i = 0; i < Math.min(fastKeys.length, max); i += chunkSize) {
                    const slice = fastKeys.slice(i, i + chunkSize);
                    let map = new Map<string, any>();
                    try { map = await this.fetchUsersDecoded(slice); } catch { map = new Map(); }
                    for (const [pk, ua] of map.entries()) {
                      try {
                        if (this.warmUsers.size >= 500) {
                          const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
                          if (oldest) { try { await (this.warmUsers.get(oldest) as any)?.user?.unsubscribe?.(); } catch {} this.warmUsers.delete(oldest); }
                        }
                        this.warmUsers.set(pk, { ua, ts: Date.now() });
                      } catch {}
                    }
                  }
                  try { logger.info('drift.warmup.fallback_done', { warmed: this.warmUsers.size, cat: 'drift' }); } catch {}
                } else {
                  try { logger.info('drift.warmup.gpa_empty', { cat: 'drift' }); } catch {}
                }
              } catch {}
            }
          }
        } catch {}
        this.warmupDone = true;
        this.lastWarmupAtMs = Date.now();
        try { logger.info('drift.warmup.ok', { ms: this.lastWarmupAtMs - t0, cat: 'drift' }); } catch {}
      } catch (e: any) {
        try { logger.warn('drift.warmup.failed', { err: String(e?.message || e), cat: 'drift' }); } catch {}
      } finally {
        this.warmupInProgress = false;
      }
    })();
    try { await this.warmupPromise; } catch {}
  }

  async waitForWarmup(timeoutMs?: number): Promise<boolean> {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    if (this.warmupDone) return true;
    // If warmup is disabled, consider ready
    if (driftCfg?.warmupEnabled === false) return true;
    try { await this.warmup(); } catch {}
    if (this.warmupDone) return true;
    const ms = Math.max(1000, Number(timeoutMs ?? driftCfg?.warmupTimeoutMs ?? 30000));
    try {
      await Promise.race([
        (async () => { while (!this.warmupDone) { await new Promise((r) => setTimeout(r, 200)); } })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('WARMUP_TIMEOUT')), ms)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // Infra manager: manual activation and bot-aware teardown
  async activate(opts?: { includeIdle?: boolean; updateFrequency?: number; preferOrderSubscriber?: boolean }): Promise<void> {
    this.forceActive = true;
    await this.warmup(opts);
    try { logger.info('drift.infra.activated', { cat: 'drift' }); } catch {}
  }

  deactivate(): void {
    this.forceActive = false;
    this.maybeTeardownInfra();
    try { logger.info('drift.infra.deactivated', { cat: 'drift' }); } catch {}
  }

  registerBot(key: string): void {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      this.activeBots.add(k);
      try { logger.debug('drift.infra.bot_register', { key: k, total: this.activeBots.size, cat: 'drift' }); } catch {}
    } catch {}
  }

  unregisterBot(key: string): void {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      this.activeBots.delete(k);
      try { logger.debug('drift.infra.bot_unregister', { key: k, total: this.activeBots.size, cat: 'drift' }); } catch {}
      this.maybeTeardownInfra();
    } catch {}
  }

  getInfraStatus(): { active: boolean; forceActive: boolean; bots: number; has: { slotSubscriber: boolean; eventSubscriber: boolean; userMap: boolean; dlobSubscriber: boolean; orderSubscriber: boolean }; lastSlotAtMs?: number; slotStale?: boolean } {
    const slotStaleMs = Math.max(5000, Number(((CONFIG as any)?.drift?.slotStaleMs) ?? 15000));
    return {
      active: !!(this.sharedSlotSubscriber || this.sharedEventSubscriber || this.sharedUserMap || this.sharedDlobSubscriber || this.sharedOrderSubscriber),
      forceActive: this.forceActive,
      bots: this.activeBots.size,
      has: {
        slotSubscriber: !!this.sharedSlotSubscriber,
        eventSubscriber: !!this.sharedEventSubscriber,
        userMap: !!this.sharedUserMap,
        dlobSubscriber: !!this.sharedDlobSubscriber,
        orderSubscriber: !!this.sharedOrderSubscriber,
      },
      lastSlotAtMs: this.lastSlotTs || undefined,
      slotStale: !!(this.lastSlotTs && (Date.now() - this.lastSlotTs) > slotStaleMs),
    };
  }

  // Re-wire slot timestamp listener to the current SlotSubscriber emitter. When force=true,
  // detach the previous handler from any existing emitter before attaching a new one.
  // Also nudges freshness immediately to avoid flapping right after resubscribe.
  private wireSlotTsListener(force?: boolean): void {
    try {
      if (!this.sharedSlotSubscriber) return;
      const onSlot = () => { this.lastSlotTs = Date.now(); };
      if (force && this._slotTsHandler) {
        try { (this.sharedSlotSubscriber as any)?.eventEmitter?.off?.('slotUpdate', this._slotTsHandler); } catch {}
      }
      try {
        if (typeof (this.sharedSlotSubscriber as any).onSlotChange === 'function') {
          (this.sharedSlotSubscriber as any).onSlotChange(onSlot, 1);
        } else {
          (this.sharedSlotSubscriber as any)?.eventEmitter?.on?.('slotUpdate', onSlot);
        }
      } catch {}
      this._slotTsHandler = onSlot;
    } catch {}
  }

  private async teardownInfra(): Promise<void> {
    // Stop timers and shared blockhash warmer
    try { if (this.prefetchTimer) { clearInterval(this.prefetchTimer); this.prefetchTimer = null; } } catch {}
    try { if (this.pollLoaderWarm) { try { (this.pollLoaderWarm as any)?.removeAllListeners?.(); } catch {} this.pollLoaderWarm = null; } } catch {}
    try { const mod = await import('../utils/blockhash.js'); (mod as any)?.stopSharedBlockhash?.(); } catch {}
    // Stop infra watchdog and detach slot listener
    try { if (this.infraWatchdogTimer) { clearInterval(this.infraWatchdogTimer); this.infraWatchdogTimer = null; } } catch {}
    try {
      if (this._slotTsHandler && (this.sharedSlotSubscriber as any)?.eventEmitter?.off) {
        (this.sharedSlotSubscriber as any).eventEmitter.off('slotUpdate', this._slotTsHandler);
      }
    } catch {}
    this._slotTsHandler = null;
    this.lastSlotTs = 0;
    this._staleCount = 0;
    // Unsubscribe subscribers in safe order
    try { await (this.sharedDlobSubscriber as any)?.unsubscribe?.(); } catch {}
    try { await (this.sharedOrderSubscriber as any)?.unsubscribe?.(); } catch {}
    try { await (this.sharedUserMap as any)?.unsubscribe?.(); } catch {}
    try { await (this.sharedEventSubscriber as any)?.unsubscribe?.(); } catch {}
    try { await (this.sharedSlotSubscriber as any)?.unsubscribe?.(); } catch {}
    this.sharedDlobSubscriber = null;
    this.sharedOrderSubscriber = null;
    this.sharedUserMap = null;
    this.sharedEventSubscriber = null;
    this.sharedSlotSubscriber = null;
  }

  // Public cleanup method for shutdown - ensures all subscriptions are properly torn down
  async cleanup(): Promise<void> {
    try {
      // Unsubscribe all warm users first
      const warmUnsubscribes: Array<Promise<any>> = [];
      for (const [pk, warm] of this.warmUsers.entries()) {
        try {
          const user = (warm as any)?.user;
          if (user && typeof user.unsubscribe === 'function') {
            warmUnsubscribes.push((user as any).unsubscribe().catch(() => {}));
          }
        } catch {}
      }
      if (warmUnsubscribes.length > 0) {
        try { await Promise.allSettled(warmUnsubscribes); } catch {}
      }
      this.warmUsers.clear();

      // Unsubscribe the active user if it exists
      try {
        const activeUser = (this.client as any)?.user;
        if (activeUser && typeof activeUser.unsubscribe === 'function') {
          await activeUser.unsubscribe().catch(() => {});
        }
      } catch {}

      // Clear the Connection's internal subscription maps to prevent _updateSubscriptions
      // from trying to resubscribe after shutdown
      try {
        if (this.connection) {
          const rpcWs: any = (this.connection as any)?._rpcWebSocket;
          if (rpcWs) {
            // Clear subscription maps
            if (rpcWs._subscriptionsByAccountChangeSubscriptionId) {
              try { rpcWs._subscriptionsByAccountChangeSubscriptionId.clear?.(); } catch {}
            }
            if (rpcWs._subscriptionsByProgramAccountChangeSubscriptionId) {
              try { rpcWs._subscriptionsByProgramAccountChangeSubscriptionId.clear?.(); } catch {}
            }
            // Clear any pending timers that might trigger _updateSubscriptions
            if (rpcWs._subscriptionUpdateTimer) {
              try { clearTimeout(rpcWs._subscriptionUpdateTimer); rpcWs._subscriptionUpdateTimer = null; } catch {}
            }
          }
        }
      } catch {}

      // Teardown infrastructure (shared subscribers, timers, etc.)
      await this.teardownInfra();
    } catch (e: any) {
      try { logger.warn('drift.cleanup.error', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    }
  }

  private maybeTeardownInfra(): void {
    if (this.forceActive) return;
    if (this.activeBots.size > 0) return;
    // Fire-and-forget teardown
    this.teardownInfra().catch(() => {});
  }

  // Warm user cache helpers
  getWarmUser(pubkey: string): any | null {
    const w = this.warmUsers.get(pubkey);
    if (!w) return null;
    if ((w as any).user) return (w as any).user;
    if ((w as any).ua) return { getUserAccount: () => (w as any).ua };
    return null;
  }
  hasWarmRefStats(pk: string | PublicKey): boolean {
    return this.warmRefStats.has(String(pk));
  }
  private base58Encode(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (!bytes || bytes.length === 0) return '';
    const digits: number[] = [0];
    for (let i = 0; i < bytes.length; i += 1) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j += 1) {
        const x = (digits[j] << 8) + carry;
        digits[j] = x % 58;
        carry = (x / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    // deal with leading zeros
    for (let k = 0; k < bytes.length && bytes[k] === 0; k += 1) digits.push(0);
    return digits.reverse().map((d) => ALPHABET[d]).join('');
  }
  private computeAnchorDiscriminatorB58(name: string): string | null {
    try {
      const label = `account:${name}`;
      const hash = createHash('sha256').update(label).digest();
      const first8 = hash.slice(0, 8);
      return this.base58Encode(first8);
    } catch {
      return null;
    }
  }
  private async fetchUsersViaHeliusGpaV2(limit: number, changedOnly = true): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    try {
      await this.init();
      const drift: any = this.client;
      const conn: any = this.getHeliusConn();
      const endpoint: string = String((conn as any)?._rpcEndpoint || (conn as any)?.rpcEndpoint || '');
      if (!/helius/i.test(endpoint)) return out;
      const programId: string = String(drift?.program?.programId?.toBase58?.() || drift?.program?.programId || '');
      if (!programId) return out;
      const discr = this.computeAnchorDiscriminatorB58('User');
      const filters: any[] = discr ? [{ memcmp: { offset: 0, bytes: discr } }] : [];
      const driftCfg: any = ((CONFIG as any)?.drift || {});
      const pageSize = Math.max(100, Math.min(10000, Number(driftCfg?.prefetchGpaPageSize ?? 2000)));
      const maxPages = Math.max(1, Number(driftCfg?.prefetchGpaMaxPages ?? 5));
      const totalLimit = Math.max(100, Math.min(100000, Number(limit || (pageSize * maxPages))));

      const { acquireRpcSlots, withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let delayMs = 500;
      let paginationKey: any = undefined;
      let fetched = 0;
      let page = 0;
      let coder: any = null;
      try { coder = drift?.program?.coder?.accounts || null; } catch {}

      while (page < maxPages && fetched < totalLimit) {
        const remaining = totalLimit - fetched;
        const lmt = Math.min(pageSize, remaining);
        const params: any = { encoding: 'base64', filters, limit: lmt, commitment: 'processed' };
        if (changedOnly && this.lastPrefetchSlot > 0) { (params as any).changedSinceSlot = Number(this.lastPrefetchSlot); }
        if (paginationKey) { (params as any).paginationKey = paginationKey; }
        const body: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccountsV2', params: [programId, params] };

        for (let attempt = 0; attempt < 4; attempt += 1) {
          await acquireRpcSlots(1);
          const res: any = await withRpcTimeout(
            fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            3000,
            'helius.gpa.page'
          );
          if (res?.status === 429) {
            const retryAfter = Number(res.headers?.get?.('retry-after') || 0) * 1000;
            const jitter = 1 + (Math.random() * 0.2 - 0.1);
            const wait = Math.min(6000, Math.max(500, retryAfter || Math.round(delayMs * jitter)));
            delayMs = Math.min(6000, Math.round(delayMs * 2));
            try { logger.warn('drift.prefetch.429', { delayMs: wait, attempt: attempt + 1, page, limit: lmt, changedOnly, cat: 'drift' }); } catch {}
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          let json = await res.json().catch(() => ({}));
          // Helius may not support getProgramAccountsV2 on some endpoints; fallback to getProgramAccounts
          if ((json as any)?.error || (!Array.isArray(json?.result?.accounts) && !Array.isArray(json?.result))) {
            try {
              const bodyV1: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [programId, params] };
              const res2: any = await withRpcTimeout(
                fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyV1) }),
                3000,
                'helius.gpa.page.fallback'
              );
              json = await res2.json().catch(() => ({}));
            } catch {}
          }
          const list = Array.isArray(json?.result?.accounts) ? json.result.accounts : (Array.isArray(json?.result) ? json.result : []);
          if (!Array.isArray(list) || list.length === 0) { page = maxPages; break; }
          for (const a of list) {
            try {
              const pk = String(a?.pubkey || a?.account || '');
              const enc = a?.account?.data;
              const b64 = Array.isArray(enc) ? enc[0] : (typeof enc === 'string' ? enc : null);
              if (!pk || !b64) continue;
              const raw = Buffer.from(b64, 'base64');
              let ua: any = null;
              try { ua = coder?.decode?.('User', raw); } catch {}
              if (!ua) { try { ua = drift?.program?.account?.user?.coder?.accounts?.decode?.('User', raw); } catch {} }
              if (ua) {
                if (!out.has(pk)) { out.set(pk, ua); fetched += 1; }
              }
            } catch {}
          }
          paginationKey = json?.result?.paginationKey || null;
          try { logger.info('drift.prefetch.gpa_page', { page: page + 1, fetchedInPage: list?.length || 0, totalFetched: fetched, hasMore: !!paginationKey, cat: 'drift' }); } catch {}
          break;
        }
        if (!paginationKey) break;
        page += 1;
      }
      try { this.lastPrefetchSlot = Number(await this.getReadConnection().getSlot('processed')); } catch {}
    } catch {}
    return out;
  }

  private async enumerateUserPubkeysViaHeliusGpaV2(limit: number, changedOnly = false): Promise<string[]> {
    const out: string[] = [];
    try {
      await this.init();
      const drift: any = this.client;
      const conn: any = this.getHeliusConn();
      const endpoint: string = String((conn as any)?._rpcEndpoint || (conn as any)?.rpcEndpoint || '');
      if (!/helius/i.test(endpoint)) return out;
      const programId: string = String(drift?.program?.programId?.toBase58?.() || drift?.program?.programId || '');
      if (!programId) return out;
      const discr = this.computeAnchorDiscriminatorB58('User');
      const filters: any[] = discr ? [{ memcmp: { offset: 0, bytes: discr } }] : [];
      const driftCfg: any = ((CONFIG as any)?.drift || {});
      const pageSize = Math.max(500, Math.min(10000, Number(driftCfg?.prefetchGpaPageSize ?? 2000)));
      const totalLimit = Math.max(100, Math.min(200000, Number(limit || pageSize)));
      const { acquireRpcSlots, withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let paginationKey: any = undefined;
      let fetched = 0;
      while (fetched < totalLimit) {
        const remaining = totalLimit - fetched;
        const lmt = Math.min(pageSize, remaining);
        const params: any = { encoding: 'base64', filters, dataSlice: { offset: 0, length: 0 }, limit: lmt, commitment: 'processed' };
        if (changedOnly && this.lastPrefetchSlot > 0) { (params as any).changedSinceSlot = Number(this.lastPrefetchSlot); }
        if (paginationKey) { (params as any).paginationKey = paginationKey; }
        const body: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccountsV2', params: [programId, params] };
        await acquireRpcSlots(1);
        const res: any = await withRpcTimeout(
          fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
          3000,
          'helius.gpa.keys'
        );
        let json = await res.json().catch(() => ({}));
        // Fallback to getProgramAccounts if V2 unsupported
        if ((json as any)?.error || (!Array.isArray(json?.result?.accounts) && !Array.isArray(json?.result))) {
          try {
            const bodyV1: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [programId, params] };
            const res2: any = await withRpcTimeout(
              fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyV1) }),
              3000,
              'helius.gpa.keys.fallback'
            );
            json = await res2.json().catch(() => ({}));
          } catch {}
        }
        const accounts = json?.result?.accounts || json?.result || [];
        if (!Array.isArray(accounts) || accounts.length === 0) break;
        for (const a of accounts) {
          const pk = String(a?.pubkey || a?.account || '');
          if (pk && out.length < totalLimit) { out.push(pk); fetched += 1; }
        }
        paginationKey = json?.result?.paginationKey || null;
        try { logger.info('drift.warmup.enumerate_page', { count: accounts?.length || 0, total: out.length, hasMore: !!paginationKey, cat: 'drift' }); } catch {}
        if (!paginationKey) break;
      }
      try { this.lastPrefetchSlot = Number(await this.getReadConnection().getSlot('processed')); } catch {}
    } catch {}
    return out;
  }
  async fetchUsersDecoded(pks: (string | PublicKey)[]): Promise<Map<string, any>> {
    await this.init();
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const keys = pks.map((k) => (typeof k === 'string' ? new PublicKey(k) : k));
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      // Gate large multi-account fetches to avoid RPC bursts; weight scales with chunk size
      const weight = Math.max(1, Math.ceil(keys.length / 5));
      const infos = await withRpcLimit(() => this.getReadConnection().getMultipleAccountsInfo(keys, 'processed'), weight);
      const out = new Map<string, any>();
      let coder: any = null;
      try { coder = (this.client as any)?.program?.coder?.accounts || null; } catch {}
      for (let i = 0; i < keys.length; i += 1) {
        try {
          const info = infos?.[i];
          if (!info?.data) continue;
          let ua: any = null;
          try { ua = coder?.decode?.('User', info.data); } catch {}
          if (!ua) {
            try { ua = (this.client as any)?.program?.account?.user?.coder?.accounts?.decode?.('User', info.data); } catch {}
          }
          if (ua) out.set(keys[i].toBase58(), ua);
        } catch {}
      }
      return out;
    } catch {
      return new Map<string, any>();
    }
  }
  async ensureRefStatsReady(referrerAuth: PublicKey): Promise<PublicKey | null> {
    await this.init();
    try {
      let sdk: any = null;
      try { sdk = await import('@drift-labs/sdk'); } catch {}
      const pk: PublicKey = (sdk as any).getUserStatsAccountPublicKey(this.client.program.programId, referrerAuth);
      const key = pk.toBase58();
      if (this.warmRefStats.has(key)) return pk;
      const missAt = this.missingRefStats.get(key);
      if (missAt && Date.now() - missAt < this.refStatsTtlMs) return null;
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      const info = await withRpcLimit(() => this.getReadConnection().getAccountInfo(pk, 'processed'));
      if (info) { this.warmRefStats.add(key); return pk; }
      this.missingRefStats.set(key, Date.now());
      return null;
    } catch { return null; }
  }
  enqueueUsersForPrefetch(pks: string[]): void {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    const cap = Math.max(1000, Number(driftCfg?.prefetchQueueCap ?? 5000));
    for (const pk of pks) {
      if (!pk) continue;
      if (this.prefetchQueue.length >= cap) break;
      if (!this.warmUsers.has(pk)) this.prefetchQueue.push(pk);
    }
  }
  async startUserPrefetcher(dlobSubscriber: any, userMap: any): Promise<void> {
    await this.init();
    if (this.prefetchRunning) return;
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    if (driftCfg?.prefetchEnabled === false) return;
    this.prefetchRunning = true;
    // Prepare polling loader for stability
    try {
      const { BulkAccountLoader } = await loadSdk();
      if (!this.pollLoaderWarm) {
        // Use a slightly slower polling frequency to reduce provider load
        this.pollLoaderWarm = new BulkAccountLoader(this.connection!, 'confirmed', 1500);
        try { (this.pollLoaderWarm as any)?.on?.('error', (e: any) => { try { logger.warn('drift.pollLoaderWarm.error', { error: String(e?.message || e), cat: 'drift' }); } catch {} }); } catch {}
      }
    } catch {}

    // Prefetch pacing config
    const intervalMs = Math.max(1500, Number(driftCfg?.prefetchIntervalMs ?? 3000));
    const batchMax = Math.max(10, Number(driftCfg?.prefetchBatchMax ?? 60));
    const chunkSizeCfg = Math.max(10, Number(driftCfg?.prefetchChunkSize ?? 20));

    const collectFromDlob = async () => {
      try {
        const dlob = dlobSubscriber?.getDLOB?.();
        if (!dlob) return;
        const found: Set<string> = new Set();
        // Build market index list dynamically from SDK
        let indices: number[] = [];
        try {
          const perps = await this.client?.getPerpMarketAccounts?.();
          if (Array.isArray(perps)) {
            indices = perps.map((m: any) => Number(m?.marketIndex ?? m?.market_index ?? m?.idx)).filter((n: any) => Number.isFinite(n));
          }
        } catch {}
        if (!Array.isArray(indices) || indices.length === 0) { indices = [0, 1, 2, 31, 45]; }
        for (const mi of indices) {
          try {
            const nodes = dlob.getRestingLimitOrderNodes?.(mi) || [];
            for (const n of nodes) {
              const taker = String(n?.userAccount || ''); if (taker) found.add(taker);
              const makers = Array.isArray(n?.makerNodes) ? n.makerNodes : [];
              for (const mn of makers) { const mk = String(mn?.userAccount || ''); if (mk) found.add(mk); }
            }
          } catch {}
        }
        const MAX_KEYS = 1000;
        this.enqueueUsersForPrefetch(Array.from(found).slice(0, MAX_KEYS));
      } catch {}
    };

    // Choose prefetch method: auto => use GPA on Helius endpoints, else MACI
    const cfgMethodRaw = String((driftCfg?.prefetchMethod || 'auto')).toLowerCase();
    const rpcEndpoint: string = String((this.connection as any)?._rpcEndpoint || (this.connection as any)?.rpcEndpoint || '');
    const autoPick = /helius/i.test(rpcEndpoint) ? 'gpa' : 'maci';
    const method = cfgMethodRaw === 'auto' ? autoPick : cfgMethodRaw;
    try { logger.info('drift.prefetch.start', { method, rpc: rpcEndpoint.includes('helius') ? 'helius' : 'other', cat: 'drift' }); } catch {}
    const step = async () => {
      try {
        if (method === 'gpa') {
          const limit = Math.max(100, Number(driftCfg?.prefetchGpaLimit ?? 1200));
          const changedOnly = (driftCfg?.prefetchGpaChangedOnly !== false);
          const decoded = await this.fetchUsersViaHeliusGpaV2(limit, changedOnly);
          if (decoded && decoded.size > 0) {
            for (const [pk, ua] of decoded.entries()) {
              try {
                if (this.warmUsers.size >= 500) {
                  const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
                  if (oldest) {
                    try { await (this.warmUsers.get(oldest) as any)?.user?.unsubscribe?.(); } catch {}
                    this.warmUsers.delete(oldest);
                  }
                }
                this.warmUsers.set(pk, { ua, ts: Date.now() });
                try {
                  const ref = ua?.referrerInfo?.referrer;
                  if (ref && String(ref) !== '11111111111111111111111111111111') {
                    await this.ensureRefStatsReady(ref);
                  }
                } catch {}
              } catch {}
            }
          }
          return;
        }
        // Default MACI path
        await collectFromDlob();
        const batch = this.prefetchQueue.splice(0, batchMax);
        if (batch.length === 0) return;
        const chunkSize = chunkSizeCfg;
        for (let i = 0; i < batch.length; i += chunkSize) {
          const chunk = batch.slice(i, i + chunkSize);
          let decoded: Map<string, any> = new Map();
          try { decoded = await this.fetchUsersDecoded(chunk); } catch { decoded = new Map(); }
          for (const pk of chunk) {
            try {
              const ua = decoded.get(pk);
              if (!ua) continue;
              if (this.warmUsers.size >= 500) {
                const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
                if (oldest) {
                  try { await (this.warmUsers.get(oldest) as any)?.user?.unsubscribe?.(); } catch {}
                  this.warmUsers.delete(oldest);
                }
              }
              this.warmUsers.set(pk, { ua, ts: Date.now() });
              try {
                const ref = ua?.referrerInfo?.referrer;
                if (ref && String(ref) !== '11111111111111111111111111111111') {
                  await this.ensureRefStatsReady(ref);
                }
              } catch {}
            } catch {}
          }
        }
      } catch {}
    };

    if (this.prefetchTimer) { try { clearInterval(this.prefetchTimer); } catch {} }
    this.prefetchTimer = setInterval(() => { step().catch(() => {}); }, intervalMs);
    // Run an immediate step to avoid waiting for the first interval
    try { step().catch(() => {}); } catch {}
  }

  async sendRawTransaction(raw: Buffer | Uint8Array, opts?: any): Promise<string> {
    await this.init();

    const tryWithTimeout = async (conn: Connection, payload: Buffer | Uint8Array, ms: number): Promise<string> => {
      const p = conn.sendRawTransaction(payload as any, opts || { skipPreflight: false, preflightCommitment: 'confirmed' });
      return await Promise.race<string>([
        p,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('SEND_TIMEOUT')), Math.max(250, ms))) as any,
      ]);
    };

    const primarySend = async (): Promise<string> => {
      const now = Date.now();
      const wait = Math.max(0, this.lastTxAtMs + this.minTxGapMs - now);
      if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
      const sig = await tryWithTimeout(this.connection!, raw, Number(((CONFIG as any)?.rpcSend?.sendTimeoutMs) ?? 1200));
      this.lastTxAtMs = Date.now();
      return sig;
    };

    // Respect in-flight queue limits for primary
    if (this.txQueueInFlight >= this.maxTxInFlight) {
      await new Promise<void>((resolve) => this.txQueue.push(resolve));
    }
    this.txQueueInFlight += 1;
    try {
      try {
        return await primarySend();
      } catch (ePrimary: any) {
        try { logger.warn('tx.send.primary_fail', { cat: 'tx', url: (CONFIG as any)?.rpcUrl, err: String(ePrimary?.message || ePrimary) }); } catch {}
        // Secondary RPC fallback (tight timeouts, best-effort)
        const secondaries: string[] = Array.isArray((CONFIG as any)?.rpcSend?.secondaryRpcUrls) ? (CONFIG as any).rpcSend.secondaryRpcUrls : [];
        let lastErr: any = ePrimary;
        for (const url of secondaries) {
          try {
            const alt = new Connection(String(url), { commitment: 'processed', disableRetryOnRateLimit: true } as any);
            const sig = await tryWithTimeout(alt, raw, Number(((CONFIG as any)?.rpcSend?.sendTimeoutMs) ?? 1200));
            try { logger.info('tx.send.fallback_ok', { cat: 'tx', url }); } catch {}
            return sig;
          } catch (eAlt: any) {
            lastErr = eAlt;
            try { logger.warn('tx.send.fallback_fail', { cat: 'tx', url, err: String(eAlt?.message || eAlt) }); } catch {}
            continue;
          }
        }
        throw lastErr;
      }
    } finally {
      this.txQueueInFlight -= 1;
      const next = this.txQueue.shift();
      if (next) next();
    }
  }

  configureTxThrottle(opts: { minGapMs?: number; maxInFlight?: number }): void {
    try {
      if (Number.isFinite(Number(opts?.minGapMs))) {
        this.minTxGapMs = Math.max(0, Number(opts!.minGapMs));
      }
      if (Number.isFinite(Number(opts?.maxInFlight))) {
        this.maxTxInFlight = Math.max(1, Number(opts!.maxInFlight));
      }
      try { logger.info('drift.tx.throttle_config', { minGapMs: this.minTxGapMs, maxInFlight: this.maxTxInFlight, cat: 'drift' }); } catch {}
    } catch {}
  }

  private async ensureUserReady(subaccountId: number): Promise<void> {
    await this.init();
    const client: any = this.client;
    const t0 = Date.now();
    try {
      const { User } = await loadSdk();
      const userPk = await client.getUserAccountPublicKey?.(Number(subaccountId));
      if (userPk) {
        try {
          const u = new User({ driftClient: client, userAccountPublicKey: userPk, accountSubscription: { type: 'websocket' } });
          const exists = await (u as any).exists?.();
          if (!exists && typeof client?.initializeUserAccount === 'function') {
            await client.initializeUserAccount(Number(subaccountId));
          }
        } catch {}
      }
    } catch {}
    try { if (typeof client?.addUser === 'function') { await client.addUser(Number(subaccountId)); } } catch {}
    try { if (typeof client?.switchActiveUser === 'function') { await client.switchActiveUser(Number(subaccountId)); } } catch {}
    try { logger.debug('drift.user.ready', { subaccountId, ms: Date.now() - t0, cat: 'drift' }); } catch {}
  }

  async getActiveSubaccountSnapshot(): Promise<SubaccountInfo | null> {
    await this.init();
    try {
      const client: any = this.client;
      const user = client?.user || null;
      if (!user) return null;
      const id = Number((client?.getUserAccount?.()?.subAccountId) ?? (client?.activeUserId) ?? (CONFIG as any).drift?.defaultSubaccountId ?? 0);
      // Convert quote-precision values to UI units using SDK constants when available
      let QUOTE_PREC = 1_000_000;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        QUOTE_PREC = Number(cst?.QUOTE_PRECISION ?? 1_000_000);
      } catch {}
      const toUi = (val: any): number => {
        try {
          // Prefer convertToNumber if available
          return Number(val?.toString?.() || val || 0) / QUOTE_PREC;
        } catch { return Number(val?.toString?.() || val || 0) / QUOTE_PREC; }
      };
      const totalCollateral = toUi(user?.getTotalCollateral?.());
      const maint = toUi(user?.getMaintenanceMarginRequirement?.());
      const initReq = toUi(user?.getInitialMarginRequirement?.());
      const free = toUi(user?.getFreeCollateral?.());
      const lev = totalCollateral > 0 ? (Number(user?.getLeverage?.() || 0)) : 0;
      const positions: Array<{ marketIndex: number; base: number; entryPrice?: number }> = [];
      try {
        const pos = user?.getPerpPositions?.() || [];
        for (const p of pos) {
          const base = Number(p?.baseAssetAmount?.toString?.() || 0);
          const idx = Number(p?.marketIndex || 0);
          positions.push({ marketIndex: idx, base, entryPrice: undefined });
        }
      } catch {}
      return { id, freeCollateral: free, totalCollateral, maintenanceRequirement: maint, initialRequirement: initReq, effectiveLeverage: lev, positions };
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<DriftStatus> {
    await this.init();
    const markets: DriftMarketRef[] = await this.discoverMarkets();
    let subs: SubaccountInfo[] = [];
    try {
      const snap = await this.getActiveSubaccountSnapshot();
      if (snap) subs = [snap];
    } catch {}
    if (subs.length === 0) {
      try { subs = await this.getSubaccounts(); } catch { subs = []; }
    }
    logger.debug('drift.status', { markets: markets.length, subaccounts: subs.length, cat: 'drift' });
    return {
      cluster: this.cluster,
      programId: (CONFIG as any).drift?.programId,
      subaccounts: subs,
      markets,
    };
  }

  private parseAllowlistMarkets(): DriftMarketRef[] { return parseAllowlistMarkets(); }

  private async discoverMarkets(): Promise<DriftMarketRef[]> {
    await this.init();
    const t0 = Date.now();
    const decodeMarketName = (raw: any): string | undefined => {
      try {
        if (!raw) return undefined;
        if (typeof raw === 'string') return raw.replace(/\0+$/g, '').trim() || undefined;
        // Handle Buffer, Uint8Array, number[]
        if (typeof Buffer !== 'undefined') {
          if (Array.isArray(raw)) {
            const s = Buffer.from(raw).toString('utf8').replace(/\0+$/g, '').trim();
            return s || undefined;
          }
          if (raw?.data && Array.isArray(raw.data)) {
            const s = Buffer.from(raw.data).toString('utf8').replace(/\0+$/g, '').trim();
            return s || undefined;
          }
          if (raw?.byteLength && typeof raw?.slice === 'function') {
            const arr = Buffer.from(Uint8Array.from(raw as Uint8Array));
            const s = arr.toString('utf8').replace(/\0+$/g, '').trim();
            return s || undefined;
          }
        }
      } catch {}
      return undefined;
    };
    // Try SDK discovery first
    try {
      const sdk: any = await import('@drift-labs/sdk');
      const client: any = this.client;
      // Preferred: client.getPerpMarketAccounts?.()
      let accounts: any[] | null = null;
      try {
        if (typeof client?.getPerpMarketAccounts === 'function') {
          accounts = await client.getPerpMarketAccounts();
        }
      } catch {}
      // Anchor path: client.program?.account?.perpMarket?.all?.()
      if (!accounts) {
        try {
          const maybe = await client?.program?.account?.perpMarket?.all?.();
          if (Array.isArray(maybe)) accounts = maybe.map((x: any) => x?.account || x).filter(Boolean);
        } catch {}
      }
      // Fallback: probe first 16 indices via getPerpMarketAccount
      if (!accounts) {
        const temp: any[] = [];
        for (let i = 0; i < 16; i += 1) {
          try {
            const a = await client?.getPerpMarketAccount?.(i);
            if (a) temp.push(a);
          } catch {}
        }
        accounts = temp;
      }
      const markets: DriftMarketRef[] = Array.isArray(accounts) ? accounts.map((a: any) => {
        const idx = Number(a?.marketIndex ?? a?.market_index ?? a?.market?.index ?? a?.idx ?? 0);
        const nameRaw = a?.name || a?.symbol || a?.marketName;
        const name = decodeMarketName(nameRaw);
        return { marketIndex: idx, symbol: name };
      }).filter(m => Number.isFinite(m.marketIndex)) : [];
      // If empty, fallback to allowlist
      if (markets.length > 0) {
        try { logger.info('drift.markets.discovery.sdk', { count: markets.length, ms: Date.now() - t0, cat: 'drift' }); } catch {}
        return markets.sort((a, b) => a.marketIndex - b.marketIndex);
      }
      // Constants-based fallback from SDK when RPC queries return empty
      try {
        const constants: any = (sdk as any).constants || (sdk as any);
        const byClusterKey = (key: string) => (constants?.PERP_MARKETS?.[key] || constants?.PerpMarkets?.[key] || constants?.perpMarkets?.[key]);
        const clusterKey1 = this.cluster; // 'mainnet-beta' | 'devnet'
        const clusterKey2 = this.cluster.replace('-', '_'); // 'mainnet_beta'
        const list = byClusterKey(clusterKey1) || byClusterKey(clusterKey2) || constants?.PERP_MARKETS || constants?.PerpMarkets || constants?.perpMarkets;
        const out: DriftMarketRef[] = [];
        if (Array.isArray(list)) {
          for (const m of list) {
            const idx = Number(m?.marketIndex ?? m?.market_index ?? m?.index ?? m?.idx);
            const name = decodeMarketName(m?.name || m?.symbol || m?.marketName) || undefined;
            if (Number.isFinite(idx)) out.push({ marketIndex: idx, symbol: name });
          }
        } else if (list && typeof list === 'object') {
          for (const k of Object.keys(list)) {
            const m = (list as any)[k];
            const idx = Number(m?.marketIndex ?? m?.market_index ?? k);
            const name = decodeMarketName(m?.name || m?.symbol || m?.marketName || k) || undefined;
            if (Number.isFinite(idx)) out.push({ marketIndex: idx, symbol: name });
          }
        }
        if (out.length > 0) {
          try { logger.info('drift.markets.discovery.constants', { count: out.length, ms: Date.now() - t0, cat: 'drift' }); } catch {}
          return out.sort((a, b) => a.marketIndex - b.marketIndex);
        }
        const nameMap = constants?.MARKET_INDEX_TO_PERP_MARKET_NAME || constants?.PERP_MARKET_INDEX_TO_MARKET_NAME || null;
        if (nameMap && typeof nameMap === 'object') {
          const out2: DriftMarketRef[] = [];
          for (const k of Object.keys(nameMap)) {
            const idx = Number(k);
            const name = decodeMarketName((nameMap as any)[k]) || undefined;
            if (Number.isFinite(idx)) out2.push({ marketIndex: idx, symbol: name });
          }
          if (out2.length > 0) {
            try { logger.info('drift.markets.discovery.nameMap', { count: out2.length, ms: Date.now() - t0, cat: 'drift' }); } catch {}
            return out2.sort((a, b) => a.marketIndex - b.marketIndex);
          }
        }
      } catch {}
    } catch {}
    // Config-based fallback
    const fromCfg = this.parseAllowlistMarkets();
    try { logger.warn('drift.markets.discovery.fallback', { count: fromCfg.length, cat: 'drift' }); } catch {}
    return fromCfg;
  }

  async getSubaccounts(): Promise<SubaccountInfo[]> {
    // Return cached if available
    if (this.subaccountsCache && Array.isArray(this.subaccountsCache.data) && this.subaccountsCache.data.length > 0) {
      return this.subaccountsCache.data;
    }
    await this.init();
    const t0 = Date.now();
    const out: SubaccountInfo[] = [];
    try {
      const client: any = this.client;
      // Enumerate possible subaccounts and include those that exist on-chain
      const ids: number[] = [];
      try {
        const { getMaxNumberOfSubAccounts } = await loadSdk();
        const max = typeof getMaxNumberOfSubAccounts === 'function' ? Number(await getMaxNumberOfSubAccounts()) : 8;
        const cap = Number.isFinite(max) && max > 0 && max < 16 ? max : 8;
        for (let i = 0; i < cap; i += 1) ids.push(i);
      } catch { for (let i = 0; i < 8; i += 1) ids.push(i); }
      // Load quote precision for scaling UI values
      let QUOTE_PREC = 1_000_000;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        QUOTE_PREC = Number(cst?.QUOTE_PRECISION ?? 1_000_000);
      } catch {}
      const toUi = (val: any): number => Number(val?.toString?.() || val || 0) / QUOTE_PREC;
      for (const id of ids) {
        try {
          const pk = await client.getUserAccountPublicKey?.(Number(id));
          if (!pk) continue;
          const info = await (await import('../utils/rpcLimiter.js')).withRpcLimit(() => this.getReadConnection().getAccountInfo(pk, 'confirmed'));
          if (!info) continue;
          // Avoid switching active user; instantiate a polling User for this subaccount
          let user: any = null;
          try {
            const { User } = await loadSdk();
            user = new User({ driftClient: client, userAccountPublicKey: pk, accountSubscription: { type: 'websocket' } });
            try { 
              if (typeof (user as any).subscribe === 'function') { 
                const { waitUntilWsReady } = await import('./wsHelper.js');
                if (this.connection) await waitUntilWsReady(this.connection, 'client.getSubaccounts');
                await (user as any).subscribe(); 
              } 
            } catch {}
          } catch {}
          const totalCollateral = toUi(user?.getTotalCollateral?.());
          const maint = toUi(user?.getMaintenanceMarginRequirement?.());
          const initReq = toUi(user?.getInitialMarginRequirement?.());
          const free = toUi(user?.getFreeCollateral?.());
          const lev = totalCollateral > 0 ? (Number(user?.getLeverage?.() || 0)) : 0;
          const positions: Array<{ marketIndex: number; base: number; entryPrice?: number }> = [];
          try {
            const pos = user?.getPerpPositions?.() || [];
            for (const p of pos) {
              const base = Number(p?.baseAssetAmount?.toString?.() || 0);
              const idx = Number(p?.marketIndex || 0);
              positions.push({ marketIndex: idx, base, entryPrice: undefined });
            }
          } catch {}
          out.push({ id: Number(id), freeCollateral: free, totalCollateral, maintenanceRequirement: maint, initialRequirement: initReq, effectiveLeverage: lev, positions });
        } catch {}
      }
      if (out.length === 0) {
        const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
        out.push({ id, freeCollateral: 0, totalCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] });
        logger.warn('drift.subaccounts.fallback', { id, cat: 'drift' });
      } else {
        logger.info('drift.subaccounts.enumerated', { count: out.length, ids: out.map(s => s.id), ms: Date.now() - t0, cat: 'drift' });
      }
      this.subaccountsCache = { data: out, ts: Date.now() };
      return this.subaccountsCache.data;
    } catch {
      const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
      return [{ id, freeCollateral: 0, totalCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] }];
    }
  }

  invalidateSubaccountsCache(): void {
    this.subaccountsCache = null;
  }

  async switchSubaccount(_id: number): Promise<boolean> {
    await this.init();
    try {
      const client: any = this.client;
      if (typeof client?.switchActiveUser === 'function') {
        await client.switchActiveUser(Number(_id));
        try { if (typeof client?.addUser === 'function') await client.addUser(Number(_id)); } catch {}
        try { if (typeof client?.initializeUserIfNotExists === 'function') await client.initializeUserIfNotExists(Number(_id)); } catch {}
        logger.info('drift.subaccount.switch_ok', { id: _id, cat: 'drift' });
        this.invalidateSubaccountsCache();
        return true;
      }
    } catch (e: any) {
      logger.error('drift.subaccount.switch_failed', { error: String(e?.message || e), id: _id, cat: 'drift' });
      return false;
    }
    logger.warn('drift.subaccount.switch_unavailable', { id: _id, cat: 'drift' });
    return true;
  }

  async createSubaccount(name?: string): Promise<{ id: number } | null> {
    await this.init();
    let lastReason: string | null = null;
    try {
      const client: any = this.client;
      // Simple retry helper for rate limits
      const { retryWithBackoff } = await import('../utils/retry.js');
      const withBackoff = async <T>(fn: () => Promise<T>): Promise<T> => retryWithBackoff(fn, { maxRetries: 5, baseMs: 500, maxMs: 8000, jitter: true });


      // Preflight: ensure wallet has SOL for fees
      try {
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        const balLamports = await withRpcLimit(() => this.connection!.getBalance(this.walletKp!.publicKey, 'confirmed'));
        const minLamports = 0.01 * 1_000_000_000; // ~0.01 SOL
        if (balLamports < minLamports) {
          lastReason = `INSUFFICIENT_SOL balance=${(balLamports/1_000_000_000).toFixed(6)} required>=0.01`;
          logger.error('drift.subaccount.create_failed', { error: lastReason, cat: 'drift' });
          return null;
        }
      } catch {}
      // Discover existing subaccount ids and compute next unused id
      let maxCap = 8;
      try { const { getMaxNumberOfSubAccounts } = await loadSdk(); const m = await getMaxNumberOfSubAccounts?.(); if (Number.isFinite(Number(m))) maxCap = Math.min(Math.max(Number(m), 1), 16); } catch {}
      const existing = new Set<number>();
      try {
        for (let cid = 0; cid < maxCap; cid += 1) {
          try {
            const pk = await client.getUserAccountPublicKey?.(Number(cid));
            if (pk) { const acc = await (await import('../utils/rpcLimiter.js')).withRpcLimit(() => this.connection!.getAccountInfo(pk, 'confirmed')); if (acc) existing.add(Number(cid)); }
          } catch {}
        }
      } catch {}
      const currentIds = Array.from(existing.values()).sort((a, b) => a - b);
      const nextId = currentIds.length > 0 ? Math.min(currentIds[currentIds.length - 1] + 1, maxCap - 1) : 0;
      if (existing.has(nextId)) {
        // find first gap
        let gap = -1;
        for (let i = 0; i < maxCap; i += 1) { if (!existing.has(i)) { gap = i; break; } }
        if (gap >= 0) {
          (this as any)._nextCandidateId = gap;
        }
      } else {
        (this as any)._nextCandidateId = nextId;
      }
      const candidate = Number((this as any)._nextCandidateId);
      if (!Number.isFinite(candidate) || candidate < 0 || candidate >= maxCap) {
        lastReason = 'NO_FREE_SLOT';
      } else {
        // Preferred: initialize specific next id, optionally with name
        try {
          if (typeof client?.initializeUserAccount === 'function') {
            await withBackoff(async () => client.initializeUserAccount(candidate, name || undefined));
          } else if (typeof client?.initializeUserIfNotExists === 'function') {
            await withBackoff(async () => client.initializeUserIfNotExists(candidate, name || undefined));
          } else if (typeof client?.initializeUser === 'function') {
            try { await withBackoff(async () => client.initializeUser(candidate, name || undefined)); }
            catch { await withBackoff(async () => client.initializeUser()); }
          } else {
            // Try addSubAccount variants (some SDK versions auto-pick next id)
            const addVariants = [client?.addSubAccount, (client as any)?.createSubAccount, (client as any)?.addSubaccount, (client as any)?.createSubaccount].filter((fn: any) => typeof fn === 'function');
            if (addVariants.length > 0) {
              const fn: any = addVariants[0];
              try { await withBackoff(async () => fn.call(client, name || undefined)); } catch (e: any) { lastReason = `ADD_VARIANT_FAILED: ${String(e?.message || e)}`; }
            } else {
              lastReason = 'INIT_METHODS_UNAVAILABLE';
            }
          }
          // After init, ensure user mapping and switch
          try { if (typeof client?.addUser === 'function') { await withBackoff(async () => client.addUser(candidate)); } } catch {}
          try { if (typeof client?.switchActiveUser === 'function') { await withBackoff(async () => client.switchActiveUser(candidate)); } } catch {}
          try { await this.ensureUserReady(candidate); } catch {}
          logger.info('drift.subaccount.created', { id: candidate, cat: 'drift' });
          this.invalidateSubaccountsCache();
          return { id: candidate };
        } catch (e: any) {
          lastReason = String(e?.message || e) || lastReason;
        }
      }
      // Fallback: attempt creating at a candidate id range without relying on userStats
      // Preferred creation path: initializeUserAccount using next id
      // Derive candidate ids without relying on internal user stats APIs
      let candidateIds: number[] = [];
      try {
        const { getMaxNumberOfSubAccounts } = await loadSdk();
        const max = typeof getMaxNumberOfSubAccounts === 'function' ? Number(await getMaxNumberOfSubAccounts()) : 8;
        const cap = Number.isFinite(max) && max > 0 && max < 16 ? max : 8;
        for (let i = 0; i < cap; i += 1) candidateIds.push(i);
      } catch { for (let i = 0; i < 8; i += 1) candidateIds.push(i); }
      // Dedup and try in order; skip ids that already have a user account
      const seenIds = new Set<number>();
      const existing2 = new Set<number>();
      try {
        for (const cid of candidateIds) {
          try { const pk = await client.getUserAccountPublicKey?.(Number(cid)); if (pk) { const acc = await (await import('../utils/rpcLimiter.js')).withRpcLimit(() => this.getReadConnection().getAccountInfo(pk, 'confirmed')); if (acc) existing2.add(Number(cid)); } } catch {}
        }
      } catch {}
      candidateIds = candidateIds.filter((x) => (Number.isFinite(x) && !seenIds.has((seenIds.add(Number(x)), Number(x))) && !existing2.has(Number(x))));
      for (const id of candidateIds) {
        try {
          if (typeof client?.initializeUserAccount === 'function') {
            await withBackoff(async () => client.initializeUserAccount(Number(id)));
          } else if (typeof client?.initializeUserIfNotExists === 'function') {
            await withBackoff(async () => client.initializeUserIfNotExists(Number(id)));
          } else if (typeof client?.initializeUser === 'function') {
            try { await withBackoff(async () => client.initializeUser(Number(id))); }
            catch { await withBackoff(async () => client.initializeUser()); }
          } else {
            lastReason = 'INIT_METHODS_UNAVAILABLE';
            break;
          }
          // After init, add/switch user for local mapping and active selection
          try { if (typeof client?.addUser === 'function') { await withBackoff(async () => client.addUser(Number(id))); } } catch {}
          try { if (typeof client?.switchActiveUser === 'function') { await withBackoff(async () => client.switchActiveUser(Number(id))); } } catch {}
          try { await this.ensureUserReady(Number(id)); } catch {}
          logger.info('drift.subaccount.created', { id: Number(id), cat: 'drift' });
          this.invalidateSubaccountsCache();
          return { id: Number(id) };
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          logger.warn('drift.subaccount.create_attempt_failed', { id: Number(id), error: msg, cat: 'drift' });
          if (/exist|initialized|already/i.test(msg)) {
            // If it already exists, treat as success by switching to it
            try { await this.ensureUserReady(Number(id)); } catch {}
            logger.info('drift.subaccount.created_existing', { id: Number(id), cat: 'drift' });
            this.invalidateSubaccountsCache();
            return { id: Number(id) };
          }
          lastReason = msg || lastReason;
          continue;
        }
      }
    } catch (e: any) {
      logger.error('drift.subaccount.create_failed', { error: String(e?.message || e), cat: 'drift' });
    }
    logger.error('drift.subaccount.create_unavailable', { reason: lastReason || 'NO_FREE_SLOT_OR_METHODS_UNAVAILABLE', cat: 'drift' });
    return null;
  }

  async depositToSubaccount(params: { subaccountId: number; amount: number; spotMarketIndex?: number }): Promise<{ ok: boolean }> {
    await this.init();
    const { subaccountId, amount } = params;
    const spotMarketIndex = Number(params.spotMarketIndex ?? 0);
    try {
      const client: any = this.client;
      if (typeof client?.deposit === 'function') {
        await this.ensureUserReady(Number(subaccountId));
        // Convert UI amount to native using SDK precision utilities
        const nativeAmount = await this.toSpotNativeAmount(client, spotMarketIndex, Number(amount));
        const { resolveAtaForSpotMarketIndex } = await import('../wallet/ata.js');
        const ata = await resolveAtaForSpotMarketIndex(client, this.walletKp!, spotMarketIndex, this.cluster);
        // Prefer full signature (amount, spotIndex, ata, subId)
        const amt = await this.toBN(nativeAmount);
        // basic per-tx spacing
        const now = Date.now();
        const minGap = 350;
        if (now - this.lastTxAtMs < minGap) await new Promise((r) => setTimeout(r, minGap - (now - this.lastTxAtMs)));
        // backoff on rate limit
        const { retryWithBackoff } = await import('../utils/retry.js');
        await retryWithBackoff(async () => {
          try {
            await client.deposit(amt, spotMarketIndex, ata, Number(subaccountId));
          } catch (e: any) {
            const msg = String(e?.message || e || '');
            if (msg.includes('rate limited') || msg.includes('-32429') || msg.includes('429')) throw e;
            throw Object.assign(e || new Error('deposit failed'), { noRetry: true });
          }
        }, { maxRetries: 5, baseMs: 300, maxMs: 5000, jitter: true });
        this.lastTxAtMs = Date.now();
        logger.info('drift.subaccount.deposit_ok', { subaccountId, amount, spotMarketIndex, cat: 'drift' });
        return { ok: true };
      }
    } catch (e: any) {
      logger.error('drift.subaccount.deposit_failed', { error: String(e?.message || e), subaccountId, amount, spotMarketIndex, cat: 'drift' });
      return { ok: false };
    }
    logger.warn('drift.subaccount.deposit_unavailable', { subaccountId, amount, spotMarketIndex, cat: 'drift' });
    return { ok: false };
  }

  async withdrawFromSubaccount(params: { subaccountId: number; amount: number; spotMarketIndex?: number }): Promise<{ ok: boolean }> {
    await this.init();
    const { subaccountId, amount } = params;
    const spotMarketIndex = Number(params.spotMarketIndex ?? 0);
    try {
      const client: any = this.client;
      if (typeof client?.withdraw === 'function') {
        await this.ensureUserReady(Number(subaccountId));
        const nativeAmount = await this.toSpotNativeAmount(client, spotMarketIndex, Number(amount));
        const { resolveAtaForSpotMarketIndex } = await import('../wallet/ata.js');
        const ata = await resolveAtaForSpotMarketIndex(client, this.walletKp!, spotMarketIndex, this.cluster);
        const amt = await this.toBN(nativeAmount);
        const now = Date.now();
        const minGap = 350;
        if (now - this.lastTxAtMs < minGap) await new Promise((r) => setTimeout(r, minGap - (now - this.lastTxAtMs)));
        const { retryWithBackoff } = await import('../utils/retry.js');
        await retryWithBackoff(async () => {
          try {
            await client.withdraw(amt, spotMarketIndex, ata, Number(subaccountId));
          } catch (e: any) {
            const msg = String(e?.message || e || '');
            if (msg.includes('rate limited') || msg.includes('-32429') || msg.includes('429')) throw e;
            throw Object.assign(e || new Error('withdraw failed'), { noRetry: true });
          }
        }, { maxRetries: 5, baseMs: 300, maxMs: 5000, jitter: true });
        this.lastTxAtMs = Date.now();
        logger.info('drift.subaccount.withdraw_ok', { subaccountId, amount, spotMarketIndex, cat: 'drift' });
        return { ok: true };
      }
    } catch (e: any) {
      logger.error('drift.subaccount.withdraw_failed', { error: String(e?.message || e), subaccountId, amount, spotMarketIndex, cat: 'drift' });
      return { ok: false };
    }
    logger.warn('drift.subaccount.withdraw_unavailable', { subaccountId, amount, spotMarketIndex, cat: 'drift' });
    return { ok: false };
  }

  async transferBetweenSubaccounts(params: { amount: number; spotMarketIndex: number; fromSubaccountId: number; toSubaccountId: number }): Promise<{ ok: boolean }> {
    await this.init();
    const { amount, spotMarketIndex, fromSubaccountId, toSubaccountId } = params;
    try {
      const client: any = this.client;
      if (typeof client?.transferDeposit === 'function') {
        await this.ensureUserReady(Number(fromSubaccountId));
        await this.ensureUserReady(Number(toSubaccountId));
        const toNative = typeof client?.convertToSpotPrecision === 'function'
          ? await client.convertToSpotPrecision(spotMarketIndex, Number(amount))
          : null;
        const nativeAmount = toNative ?? Number(Math.round(Number(amount) * 1_000_000));
        await client.transferDeposit(nativeAmount, Number(spotMarketIndex), Number(fromSubaccountId), Number(toSubaccountId));
        logger.info('drift.subaccount.transfer_ok', { amount, spotMarketIndex, fromSubaccountId, toSubaccountId, cat: 'drift' });
        this.invalidateSubaccountsCache();
        return { ok: true };
      }
    } catch (e: any) {
      logger.error('drift.subaccount.transfer_failed', { error: String(e?.message || e), amount, spotMarketIndex, fromSubaccountId, toSubaccountId, cat: 'drift' });
      return { ok: false };
    }
    logger.warn('drift.subaccount.transfer_unavailable', { amount, spotMarketIndex, fromSubaccountId, toSubaccountId, cat: 'drift' });
    return { ok: false };
  }
}


