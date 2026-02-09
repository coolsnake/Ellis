// NOTE: type coverage tightened for key SDK surfaces only; keeping any for dynamic SDK
// test
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { createHash } from 'crypto';
import { CONFIG } from '../utils/config.js';
import { ensureWallet } from '../wallet/wallet.js';
import type { DriftStatus, SubaccountInfo, DriftMarketRef, DriftCluster } from './types.js';
import { parseAllowlistMarkets, registerSdkMarkets } from './marketMapping.js';
import { logger, maskUrl } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';

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
  private activeSubaccountId: number | null = null;
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
  private eventIndexSweepTimer: any | null = null;
  private infraReady: boolean = false;
  private infraReadyAtMs: number = 0;
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
  // Cleanup tracking to prevent race conditions between shutdown and startup
  private cleanupPromise: Promise<void> | null = null;
  // Connection pool for distributing subscriptions (avoids 100-sub-per-WS limit)
  private wsPoolConns: Connection[] = [];
  private wsPoolSubCounts: number[] = [];
  private wsPoolSubMap: Map<number, { conn: Connection; realId: number }> = new Map();
  private wsPoolNextId: number = 1_000_000;
  // Mutex: serialise concurrent init() callers so only one DriftClient is ever created
  private initPromise: Promise<void> | null = null;
  // Cached total user count (Helius GPA)
  private userCountCache: { total?: number; updatedAtMs?: number; capped?: boolean; error?: string; source?: string } | null = null;
  private userCountInFlight: Promise<void> | null = null;
  private userCountTimer: any | null = null;

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
            try { method = JSON.parse(String(init?.body || '{}'))?.method; } catch (e: any) { safeLog.debug('drift.jsonParse', { error: String(e?.message || e), cat: 'drift' }); }
            safeLog.warn('rpc.429', { method, url: maskUrl(String(info)), cat: 'rpc' });
          }
        } catch (e: any) { safeLog.debug('drift.jsonParse', { error: String(e?.message || e), cat: 'drift' }); }
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
    } catch (e: any) { safeLog.warn('drift.sdk.spotPrecision', { error: String(e?.message || e), cat: 'drift' }); }
    return Number(Math.round(Number(uiAmount) * 1_000_000));
  }

  private async toBN(n: number): Promise<any> {
    try {
      const sdk: any = await import('@drift-labs/sdk');
      const BN = (sdk as any).BN || (sdk as any).AnchorsBN || undefined;
      if (BN) return new BN(Number(n));
    } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
    try {
      const mod: any = await import('bn.js');
      const BN = mod?.BN || mod?.default?.BN || mod?.default;
      if (BN) return new BN(Number(n));
    } catch (e: any) { safeLog.debug('drift.import.bnjs', { error: String(e?.message || e), cat: 'drift' }); }
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
    } catch (e: any) {
      safeLog.warn('drift.getFundingRate', { error: String(e?.message || e), cat: 'drift' });
      return null;
    }
  }

  async getUnrealizedPerpPnl(marketIndex: number): Promise<number | null> {
    await this.init();
    try {
      const user: any = (() => { try { return (this.client as any)?.user; } catch { return null; } })();
      const val = await (user?.getUnrealizedPerpPnl?.(marketIndex));
      const n = Number(val?.toString?.() || val || 0);
      return isFinite(n) ? n : 0;
    } catch (e: any) {
      safeLog.warn('drift.getUnrealizedPerpPnl', { error: String(e?.message || e), cat: 'drift' });
      return null;
    }
  }

  async getUnrealizedFundingPnl(marketIndex: number): Promise<number | null> {
    await this.init();
    try {
      const user: any = (() => { try { return (this.client as any)?.user; } catch { return null; } })();
      const val = await (user?.getUnrealizedFundingPnl?.(marketIndex));
      const n = Number(val?.toString?.() || val || 0);
      return isFinite(n) ? n : 0;
    } catch (e: any) {
      safeLog.warn('drift.getUnrealizedFundingPnl', { error: String(e?.message || e), cat: 'drift' });
      return null;
    }
  }

  async init(): Promise<void> {
    // Fast path: already initialised
    if (this.client) return;
    // Serialise concurrent callers: if another init() is in-flight, piggyback on
    // its promise instead of creating a second DriftClient (which causes 429 storms).
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    // Wait for any pending cleanup to complete before reinitializing
    // This prevents "socket was not CONNECTING or OPEN" errors from race conditions
    if (this.cleanupPromise) {
      try {
        await this.cleanupPromise.catch(() => {});
      } catch (e: any) { safeLog.debug('drift.cleanupWait', { error: String(e?.message || e), cat: 'drift' }); }
      this.cleanupPromise = null;
    }

    // Double-check after acquiring the implicit lock
    if (this.client) return;
    this.walletKp = await ensureWallet(CONFIG.walletPath);
    // Custom fetch to tag 429s and disable internal 429 retry loop
    const customFetch = async (info: any, init: any) => {
      const baseFetch: any = (globalThis as any).fetch || (await import('node-fetch')).default;
      const res: any = await baseFetch(info, init);
      try {
        if (res && typeof res.status === 'number' && res.status === 429) {
          let method: string | undefined;
          try { method = JSON.parse(String(init?.body || '{}'))?.method; } catch (e: any) { safeLog.debug('drift.jsonParse', { error: String(e?.message || e), cat: 'drift' }); }
          safeLog.warn('rpc.429', { method, url: maskUrl(String(info)), cat: 'rpc' });
        }
      } catch (e: any) { safeLog.debug('drift.jsonParse', { error: String(e?.message || e), cat: 'drift' }); }
      return res as any;
    };
    this.connection = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: customFetch } as any);
    
    // Intercept getAccountInfo to ensure all calls go through rate limiter
    // This catches SDK-internal getAccountInfo calls that bypass direct rate limiting
    const originalGetAccountInfo = this.connection.getAccountInfo.bind(this.connection);
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    this.connection.getAccountInfo = async function(...args: any[]) {
      return await withRpcLimit(
        () => originalGetAccountInfo(...args),
        1,
        { module: 'drift', method: 'getAccountInfo' }
      );
    };
    
    const t0 = Date.now();
    logger.info('drift.sdk.init', { rpcUrl: maskUrl(CONFIG.rpcUrl), cluster: this.cluster, cat: 'drift', code: 'DRIFT.SDK.INIT' });
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
      try { (this.loader as any)?.on?.('error', (e: any) => { safeLog.warn('drift.loader.error', { error: String(e?.message || e), cat: 'drift' }); }); } catch (e: any) { safeLog.debug('drift.eventListener.attach', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.warn('drift.init.bulkAccountLoader', { error: String(e?.message || e), cat: 'drift' }); this.loader = null; }
    const programIdOpt = (CONFIG as any).drift?.programId ? { programID: new PublicKey((CONFIG as any).drift.programId) } : {};
    const marketOpts = typeof getMarketsAndOraclesForSubscription === 'function' ? (getMarketsAndOraclesForSubscription as any)(this.cluster) : {};
    this.client = await initialize({ connection: this.connection, wallet, opts: { env: this.cluster, accountSubscription: subscription, ...programIdOpt, ...marketOpts } });
    
    // Protect the RPC WebSocket from being called on closed sockets
    let protectRpcWebSocket: any;
    try {
      const wsHelper = await import('./wsHelper.js');
      protectRpcWebSocket = wsHelper.protectRpcWebSocket;
      protectRpcWebSocket(this.connection, 'drift.init');
    } catch (e: any) { safeLog.debug('drift.protectRpcWebSocket', { error: String(e?.message || e), cat: 'drift' }); }

    // Distribute subscriptions across multiple WS connections to avoid 100-sub limit.
    // Monkey-patch onAccountChange / onProgramAccountChange on the connection so the
    // Drift SDK transparently uses pooled connections for subscriptions.
    if (subType === 'websocket') {
      const maxSubsPerConn = Number((CONFIG as any).system?.wsMaxSubsPerConn || 90);
      const self = this;

      const allocatePoolConn = (): { conn: Connection; idx: number } => {
        for (let i = 0; i < self.wsPoolConns.length; i++) {
          if (self.wsPoolSubCounts[i] < maxSubsPerConn) return { conn: self.wsPoolConns[i], idx: i };
        }
        // All full or none yet — create new connection
        const c = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: customFetch } as any);
        try { if (protectRpcWebSocket) protectRpcWebSocket(c, `drift.pool[${self.wsPoolConns.length}]`); } catch {}
        self.wsPoolConns.push(c);
        self.wsPoolSubCounts.push(0);
        logger.info('drift.pool.connection.created', {
          index: self.wsPoolConns.length - 1, maxSubsPerConn, cat: 'drift'
        });
        return { conn: c, idx: self.wsPoolConns.length - 1 };
      };

      // Patch onAccountChange → route to pool
      (this.connection as any).onAccountChange = function(account: any, callback: any, commitment?: any) {
        const { conn, idx } = allocatePoolConn();
        const realId = conn.onAccountChange(account, callback, commitment);
        self.wsPoolSubCounts[idx]++;
        const virtualId = self.wsPoolNextId++;
        self.wsPoolSubMap.set(virtualId, { conn, realId });
        return virtualId;
      };

      // Patch removeAccountChangeListener → route to correct pool connection
      (this.connection as any).removeAccountChangeListener = async function(id: number) {
        const entry = self.wsPoolSubMap.get(id);
        if (entry) {
          self.wsPoolSubMap.delete(id);
          return entry.conn.removeAccountChangeListener(entry.realId);
        }
      };

      // Patch onProgramAccountChange → route to pool
      (this.connection as any).onProgramAccountChange = function(programId: any, callback: any, ...rest: any[]) {
        const { conn, idx } = allocatePoolConn();
        const realId = conn.onProgramAccountChange(programId, callback, ...rest);
        self.wsPoolSubCounts[idx]++;
        const virtualId = self.wsPoolNextId++;
        self.wsPoolSubMap.set(virtualId, { conn, realId });
        return virtualId;
      };

      // Patch removeProgramAccountChangeListener → route to correct pool connection
      (this.connection as any).removeProgramAccountChangeListener = async function(id: number) {
        const entry = self.wsPoolSubMap.get(id);
        if (entry) {
          self.wsPoolSubMap.delete(id);
          return entry.conn.removeProgramAccountChangeListener(entry.realId);
        }
      };
    }

    // Use shared utility to wait for WebSocket to be ready before subscribing
    // Import once at the top for use throughout the subscribe logic
    const { waitUntilWsReady } = await import('./wsHelper.js');
    
    // Only wait for WebSocket if using websocket subscriptions
    if (subType === 'websocket') {
      try {
        await waitUntilWsReady(this.connection, 'drift.init.pre-subscribe');
        safeLog.debug('drift.ws pre-subscribe ready check passed', { cat: 'drift' });
      } catch (e: any) {
        safeLog.warn('drift.ws pre-subscribe ready check failed', { error: String(e?.message || e), cat: 'drift' });
      }
    }
    
    // Subscribe to populate internal caches for markets/users/oracles
    // Retry subscribe with backoff if WebSocket isn't ready yet
    try {
      if (typeof (this.client as any)?.subscribe === 'function') {
        const maxRetries = 3;
        const baseDelayMs = 500;
        
        // Wait for WebSocket to be ready before first subscription attempt
        // This prevents "socket was not CONNECTING or OPEN" errors during startup
        if (subType === 'websocket') {
          try { 
            await waitUntilWsReady(this.connection, 'drift.init.subscribe');
            safeLog.debug('drift.ws pre-subscribe ready check passed', { cat: 'drift' });
          } catch (e: any) {
            safeLog.warn('drift.ws pre-subscribe ready check failed', { error: String(e?.message || e), cat: 'drift' });
          }
        }
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Import RPC limiter for tracking
            const { withRpcLimit } = await import('../utils/rpcLimiter.js');
            
            // Wrap subscribe call with RPC tracking
            await withRpcLimit(
              () => (this.client as any).subscribe(),
              1,
              { module: 'drift', method: 'driftSubscribe' }
            );
            
            break;
          } catch (e: any) {
            const msg = String(e?.message || e);
            const isWsState = msg.includes('socket was not') || msg.includes('readyState');
            if (isWsState && attempt < maxRetries - 1) {
              const delay = baseDelayMs * Math.pow(1.5, attempt);
              safeLog.debug('drift.ws subscribe retry', { attempt: attempt + 1, delay, error: msg, cat: 'drift' });
              await new Promise(r => setTimeout(r, delay));
              // Wait for WebSocket again before retrying
              if (subType === 'websocket') {
                try { await waitUntilWsReady(this.connection, 'drift.init.retry'); } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
              }
              continue;
            }
            // If not a WebSocket state error or out of retries, log and rethrow
            safeLog.warn('drift.ws subscribe failed', { error: msg, attempt: attempt + 1, cat: 'drift' });
            throw e;
          }
        }
      }
    } catch (e: any) {
      // Log but don't fail initialization - the client can still work with polling or retry later
      safeLog.warn('drift.ws subscribe error (non-fatal)', { error: String(e?.message || e), cat: 'drift' });
    }
    // Force-load all state/market/oracle data from RPC immediately.
    // client.subscribe() only initiates WS subscriptions -- data arrives async.
    // client.fetchAccounts() forces the accountSubscriber to pull everything
    // (state, perp markets, spot markets, oracles) via RPC so the DriftClient
    // cache is populated before any User methods that depend on oracle prices.
    try {
      if (typeof (this.client as any)?.fetchAccounts === 'function') {
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        await withRpcLimit(
          () => (this.client as any).fetchAccounts(),
          1,
          { module: 'drift', method: 'client.fetchAccounts' }
        );
        // Verify market cache is populated -- especially spot markets which are needed
        // for liquidateBorrowForPerpPnl / liquidateSpot SDK calls (.mint.toBuffer())
        const perpAccts = (this.client as any)?.getPerpMarketAccounts?.() || [];
        const spotAccts = (this.client as any)?.getSpotMarketAccounts?.() || [];
        safeLog.info('drift.init.client_accounts_fetched', {
          perpMarkets: perpAccts.length,
          spotMarkets: spotAccts.length,
          cat: 'drift',
        });
        // If spot markets are missing, attempt to force-load them individually.
        // The DriftClient state account tells us how many exist.
        if (spotAccts.length === 0) {
          try {
            const stateAccount = (this.client as any)?.getStateAccount?.();
            const numSpot = Number(stateAccount?.numberOfSpotMarkets ?? 0);
            if (numSpot > 0) {
              safeLog.info('drift.init.force_loading_spot_markets', { expected: numSpot, cat: 'drift' });
              for (let i = 0; i < numSpot; i++) {
                try {
                  // Some SDK versions have a fetch-and-cache method per market
                  if (typeof (this.client as any)?.accountSubscriber?.fetch === 'function') {
                    await (this.client as any).accountSubscriber.fetch();
                    break; // This fetches all -- no need to loop
                  }
                } catch (e: any) { safeLog.warn('drift.accountSubscriber.fetch', { error: String(e?.message || e), cat: 'drift' }); }
              }
              // Re-check after force fetch
              const spotRetry = (this.client as any)?.getSpotMarketAccounts?.() || [];
              safeLog.info('drift.init.spot_markets_after_retry', { count: spotRetry.length, cat: 'drift' });
            }
          } catch (e: any) {
            safeLog.warn('drift.init.spot_force_load_failed', { error: String(e?.message || e), cat: 'drift' });
          }
        }
      }
    } catch (e: any) {
      safeLog.warn('drift.init.client_fetch_failed', { error: String(e?.message || e), cat: 'drift' });
    }
    // Ensure default user is initialized, registered, and set as active user.
    // Strategy:
    //   Phase A – Try the normal SDK addUser+switchActiveUser (WS-based).
    //   Phase B – If user is still null after a few WS attempts, fall back to
    //             creating the User directly with an RPC polling subscription so
    //             we load the existing on-chain account data immediately.
    //   Phase C – Once the User object exists, call user.fetchAccounts() via RPC
    //             to hydrate account data and verify oracle readiness.
    try {
      const defaultId = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
      this.activeSubaccountId = defaultId;
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      const client: any = this.client;

      // --- Phase A: Standard SDK addUser + switchActiveUser (WS-based) ---
      // Try a few times with short delays; WS subscription inside addUser may
      // need a moment before the user is stored in the internal map.
      // Note: client.user is a getter that throws if the user isn't in the map,
      // so we use hasUser() for the check.
      const wsAttempts = 3;
      const wsDelayMs = 800;
      for (let a = 0; a < wsAttempts; a++) {
        try {
          if (typeof client?.addUser === 'function') await client.addUser(defaultId);
          if (typeof client?.switchActiveUser === 'function') await client.switchActiveUser(defaultId);
          const ok = typeof client?.hasUser === 'function' ? client.hasUser(defaultId) : false;
          if (ok) break;
        } catch (e: any) { safeLog.debug('drift.init.ws_addUser', { attempt: a, error: String(e?.message || e), cat: 'drift' }); }
        if (a < wsAttempts - 1) await new Promise(r => setTimeout(r, wsDelayMs));
      }

      // --- Phase B: RPC fallback ---
      // If client.user is still null the WS-based subscribe inside addUser
      // failed to deliver account data in time.  Fix: fetch the existing
      // on-chain user account via RPC and pass it to addUser() as the third
      // argument so the SDK's User.subscribe() receives the data immediately
      // instead of waiting for WebSocket.
      //
      // SDK internals (driftClient.js):
      //   addUser(subAccountId, authority?, userAccount?)
      //     → user.subscribe(userAccount)   // uses data if provided
      //     → if (result) this.users.set(getUserMapKey(...), user)
      //   getUserMapKey(id, auth) → `${id}_${auth.toString()}`
      //   get user() → this.getUser(this.activeSubAccountId)
      let hasUser = false;
      try { hasUser = typeof client?.hasUser === 'function' ? client.hasUser(defaultId) : !!client?.user; } catch { hasUser = false; }
      if (!hasUser) {
        safeLog.info('drift.init.user_rpc_fallback', { subaccountId: defaultId, cat: 'drift' });
        try {
          // 1. Fetch the user account data directly via RPC
          const userPk = typeof client?.getUserAccountPublicKey === 'function'
            ? await client.getUserAccountPublicKey(Number(defaultId))
            : null;
          let userAccountData: any = null;
          if (userPk) {
            try {
              const accInfo = await withRpcLimit(
                () => this.connection!.getAccountInfo(userPk, 'confirmed'),
                1, { module: 'drift', method: 'user.getAccountInfo' }
              );
              if (accInfo?.data) {
                // Decode the account using the SDK's program coder
                const coder = client?.program?.coder?.accounts;
                if (coder && typeof coder.decode === 'function') {
                  userAccountData = coder.decode('User', accInfo.data);
                }
              }
            } catch (e: any) { safeLog.debug('drift.init.user_rpc_fetch', { error: String(e?.message || e), cat: 'drift' }); }
          }

          // 2. Re-call addUser with the pre-fetched account data so
          //    User.subscribe() succeeds immediately without waiting for WS
          if (typeof client?.addUser === 'function') {
            const added = await client.addUser(defaultId, undefined, userAccountData ?? undefined);
            safeLog.info('drift.init.user_rpc_addUser', { added, hasData: !!userAccountData, cat: 'drift' });
          }
          if (typeof client?.switchActiveUser === 'function') {
            await client.switchActiveUser(defaultId);
          }
          let ready = false;
          try { ready = typeof client?.hasUser === 'function' ? client.hasUser(defaultId) : !!client?.user; } catch { ready = false; }
          safeLog.info('drift.init.user_rpc_fallback_ok', { subaccountId: defaultId, userReady: ready, cat: 'drift' });
        } catch (e: any) {
          safeLog.warn('drift.init.user_rpc_fallback_failed', { error: String(e?.message || e), cat: 'drift' });
        }
      }

      // Ensure on-chain account exists (no-op if already initialized)
      if (typeof client?.initializeUserIfNotExists === 'function') {
        try { await client.initializeUserIfNotExists(defaultId); } catch (e: any) { safeLog.debug('drift.initializeUserIfNotExists', { error: String(e?.message || e), cat: 'drift' }); }
      }

      // --- Phase C: Hydrate user account data via RPC ---
      // Oracle/market data is already loaded by client.fetchAccounts() above,
      // so we mainly need the user account struct.  Use exponential backoff.
      // Note: client.user is a getter that THROWS if the user isn't in the
      // internal map, so we use hasUser() + getUser() with try-catch.
      const safeGetUser = (): any => { try { return typeof client?.getUser === 'function' ? client.getUser(defaultId) : client?.user; } catch { return null; } };
      const maxHydrationAttempts = 10;
      let userHydrated = false;
      let oraclesReady = false;
      for (let attempt = 0; attempt < maxHydrationAttempts; attempt++) {
        try {
          const user = safeGetUser();
          if (!user) {
            if (attempt < 3) {
              // Short grace period: WS subscription may still be propagating
              safeLog.debug('drift.init.hydration_waiting', { subaccountId: defaultId, attempt, cat: 'drift' });
            } else {
              safeLog.warn('drift.init.user_still_null', { subaccountId: defaultId, attempt, cat: 'drift' });
              break; // No point continuing if we can't get the User at all
            }
          }
          if (user && typeof user.fetchAccounts === 'function') {
            await withRpcLimit(() => user.fetchAccounts(), 1, { module: 'drift', method: `init.fetchAccounts.${attempt}` });
          }
          // Phase C1: verify user account is populated
          if (!userHydrated) {
            const acct = user?.getUserAccount?.();
            if (acct && acct.authority) {
              userHydrated = true;
            }
          }
          // Phase C2: verify oracle data is loaded (non-zero collateral, or empty account)
          if (userHydrated && !oraclesReady) {
            const total = Number(user?.getTotalCollateral?.('Maintenance')?.toString?.() || 0);
            if (total !== 0) {
              oraclesReady = true;
            } else {
              // Check if user actually has spot balances -- if none, 0 collateral is correct
              let hasBalance = false;
              try {
                const spots = user?.getSpotPositions?.() || [];
                for (const sp of spots) {
                  const raw = Number(sp?.scaledBalance?.toString?.() || sp?.balance || 0);
                  if (raw !== 0) { hasBalance = true; break; }
                }
              } catch (e: any) { safeLog.debug('drift.sdk.getPositions', { error: String(e?.message || e), cat: 'drift' }); }
              if (!hasBalance) {
                oraclesReady = true; // Empty account -- 0 collateral is accurate
              }
            }
          }
          if (userHydrated && oraclesReady) {
            safeLog.info('drift.init.user_hydrated', { subaccountId: defaultId, attempt, oraclesReady, cat: 'drift' });
            break;
          }
          // Log progress on later attempts
          if (attempt > 0 && attempt < maxHydrationAttempts - 1) {
            safeLog.debug('drift.init.hydration_progress', { subaccountId: defaultId, attempt, userHydrated, oraclesReady, userNull: !user, cat: 'drift' });
          }
        } catch (e: any) { safeLog.warn('drift.init.hydration_error', { attempt, error: String(e?.message || e), cat: 'drift' }); }
        // Exponential backoff: 500ms → 750ms → 1s → 1.5s → 2s (capped)
        if (attempt < maxHydrationAttempts - 1) {
          const delay = Math.min(2000, 500 * Math.pow(1.5, attempt));
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (!userHydrated || !oraclesReady) {
        safeLog.warn('drift.init.hydration_incomplete', { subaccountId: defaultId, userHydrated, oraclesReady, attempts: maxHydrationAttempts, userNull: !safeGetUser(), userReady: !!(typeof client?.hasUser === 'function' ? client.hasUser(defaultId) : false), cat: 'drift' });
      }
    } catch (e: any) {
      safeLog.warn('drift.init.user_setup_failed', { error: String(e?.message || e), cat: 'drift' });
    }
    logger.info('drift.sdk.ready', { pubkey: this.walletKp.publicKey?.toBase58?.(), ms: Date.now() - t0, cat: 'drift', code: 'DRIFT.SDK.READY' });
  }

  async getSharedInfra(opts?: { includeIdle?: boolean; updateFrequency?: number; preferOrderSubscriber?: boolean }): Promise<{ slotSubscriber: any; eventSubscriber: any; userMap: any; dlobSubscriber: any; orderSubscriber?: any }> {
    // Fast-path: if all core subscribers are already wired up and the DLOB
    // is populated, return immediately without re-entering the subscription
    // waterfall.  This prevents concurrent HTTP requests (trigger-nodes,
    // fill-nodes) from piling up inside slow subscribe/waitReady chains
    // while the infra process is still warming up or serving other requests.
    if (
      this.sharedSlotSubscriber &&
      this.sharedEventSubscriber &&
      this.sharedUserMap &&
      this.sharedDlobSubscriber &&
      (typeof this.sharedDlobSubscriber.getDLOB !== 'function' || this.sharedDlobSubscriber.getDLOB())
    ) {
      return {
        slotSubscriber: this.sharedSlotSubscriber,
        eventSubscriber: this.sharedEventSubscriber,
        userMap: this.sharedUserMap,
        dlobSubscriber: this.sharedDlobSubscriber,
        orderSubscriber: this.sharedOrderSubscriber,
      };
    }

    await this.init();
    let sdk: any = null;
    try { sdk = await import('@drift-labs/sdk'); } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
    const drift: any = this.client;
    const connection = drift?.connection || this.connection;
    const program = drift?.program;

    // Use shared WebSocket utility for ready checks
    const { waitUntilWsReady } = await import('./wsHelper.js');
    const waitReady = async () => await waitUntilWsReady(connection, 'drift.getSharedInfra');

    // Start shared blockhash cache/warmer once for all bots
    try {
      const { startSharedBlockhash } = await import('../utils/blockhash.js');
      const intervalMs = Math.max(300, Number(((CONFIG as any)?.drift?.blockhashWarmMs) ?? 400));
      // Prefer read RPC for frequent blockhash fetches to reduce contention/timeouts on primary
      startSharedBlockhash(this.getReadConnection(), { intervalMs });
    } catch (e: any) { safeLog.warn('drift.import.blockhash', { error: String(e?.message || e), cat: 'drift' }); }

    // Gentle pacing between subscription attaches to avoid startup bursts
    const spacing = Math.max(0, Number(((CONFIG as any)?.drift?.subscribeSpacingMs) ?? 100));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

    if (!this.sharedSlotSubscriber && sdk?.SlotSubscriber) {
      try {
        await waitReady();
        
        // Import RPC limiter for tracking
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        
        this.sharedSlotSubscriber = new (sdk as any).SlotSubscriber(connection);
        
        // Wrap subscribe call with RPC tracking
        await withRpcLimit(
          () => this.sharedSlotSubscriber.subscribe(),
          1,
          { module: 'drift', method: 'slotSubscribe' }
        );
        
        // Ensure slot timestamp listener is wired to the current emitter
        this.wireSlotTsListener(true);
        await sleep(spacing);
      } catch (e: any) { safeLog.warn('drift.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      // Best-effort resubscribe if previously unsubscribed
      try {
        await waitReady();
        
        // Import RPC limiter for tracking
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        
        // Wrap subscribe call with RPC tracking
        await withRpcLimit(
          () => (this.sharedSlotSubscriber as any)?.subscribe?.(),
          1,
          { module: 'drift', method: 'slotSubscribe' }
        );
        
        this.wireSlotTsListener(true);
        await sleep(spacing);
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
    }

    if (!this.sharedEventSubscriber && sdk?.EventSubscriber) {
      try {
        await waitReady();
        
        // Import RPC limiter for tracking
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        
        this.sharedEventSubscriber = new (sdk as any).EventSubscriber(connection, program);
        
        // Wrap subscribe call with RPC tracking
        await withRpcLimit(
          () => this.sharedEventSubscriber.subscribe(),
          1,
          { module: 'drift', method: 'logsSubscribe' }
        );
        
        await sleep(spacing);
      } catch (e: any) { safeLog.warn('drift.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      try { 
        await waitReady();
        
        // Import RPC limiter for tracking
        const { withRpcLimit } = await import('../utils/rpcLimiter.js');
        
        // Wrap subscribe call with RPC tracking
        await withRpcLimit(
          () => (this.sharedEventSubscriber as any)?.subscribe?.(),
          1,
          { module: 'drift', method: 'logsSubscribe' }
        );
        
        await sleep(spacing); 
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
    }

    // Wire slot timestamp listener and start watchdog for stale resubscribe
    try {
      if (this.sharedSlotSubscriber) {
        if (!this.lastSlotTs) this.lastSlotTs = Date.now();
        this.wireSlotTsListener(false);
      }
    } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }

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
              const hbTimeoutMs = Math.max(1500, Number(((CONFIG as any)?.drift?.heartbeatTimeoutMs) ?? 3000));
              const hbSlot = await withRpcTimeout(this.getReadConnection().getSlot('processed'), hbTimeoutMs, 'slot.heartbeat');
              if (Number.isFinite(Number(hbSlot))) {
                this.lastSlotTs = Date.now();
                this._staleCount = 0;
                return;
              }
            } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }

            // Escalating resubscribe: start with slot only, then event, then userMap, then DLOB
            const stage = Math.min(3, Math.max(0, this._staleCount));
            try {
              if (stage >= 0) {
                try { 
                  await waitReady(); 
                  const { withRpcLimit } = await import('../utils/rpcLimiter.js');
                  await withRpcLimit(
                    () => (this.sharedSlotSubscriber as any)?.subscribe?.(),
                    1,
                    { module: 'drift', method: 'slotSubscribe' }
                  );
                  this.wireSlotTsListener(true); 
                } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
              }
              if (stage >= 1) {
                try { 
                  await waitReady(); 
                  const { withRpcLimit } = await import('../utils/rpcLimiter.js');
                  await withRpcLimit(
                    () => (this.sharedEventSubscriber as any)?.subscribe?.(),
                    1,
                    { module: 'drift', method: 'logsSubscribe' }
                  );
                } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
              }
              if (stage >= 2) {
                try { 
                  await waitReady(); 
                  const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
                  await withDebounce(
                    'drift:userMap:subscribe',
                    async () => {
                      return await withRpcLimit(
                        () => (this.sharedUserMap as any)?.subscribe?.(),
                        1,
                        { module: 'drift', method: 'accountSubscribe' }
                      );
                    },
                    200
                  );
                } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
              }
              if (stage >= 3) {
                try {
                  const dl: any = this.sharedDlobSubscriber;
                  const has = dl && typeof dl.getDLOB === 'function' ? !!dl.getDLOB() : true;
                  if (dl && typeof dl.subscribe === 'function' && !has) { 
                    await waitReady(); 
                    const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
                    await withDebounce(
                      'drift:dlobSubscriber:subscribe',
                      async () => {
                        return await withRpcLimit(
                          () => dl.subscribe(),
                          1,
                          { module: 'drift', method: 'accountSubscribe' }
                        );
                      },
                      200
                    );
                  }
                } catch (e: any) { safeLog.warn('drift.dlobSubscriber.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
              }
            } finally {
              this._staleCount = Math.min(4, this._staleCount + 1);
            }
            safeLog.warn('drift.subs.resubscribe', { cat: 'drift', reason: 'slot_stale', stage });
          } catch (e: any) { safeLog.warn('drift.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
        }, 2500);
      }
    } catch (e: any) { safeLog.warn('drift.subscribe', { error: String(e?.message || e), cat: 'drift' }); }

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
      } catch (e: any) {
        safeLog.warn('drift.userMap.createWithConnection', { error: String(e?.message || e), cat: 'drift' });
        try {
          this.sharedUserMap = new (sdk as any).UserMap({
            driftClient: drift,
            slotSubscriber: this.sharedSlotSubscriber,
            eventSubscriber: this.sharedEventSubscriber,
            subscriptionConfig: { type: 'websocket' },
            includeIdle: !!(opts?.includeIdle),
          });
        } catch (e: any) { safeLog.warn('drift.userMap.create', { error: String(e?.message || e), cat: 'drift' }); }
      }
      try { 
        await waitReady();
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        await withDebounce(
          'drift:userMap:subscribe:initial',
          async () => {
            return await withRpcLimit(
              () => this.sharedUserMap?.subscribe?.(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        await sleep(spacing); 
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      try { 
        await waitReady();
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        await withDebounce(
          'drift:userMap:subscribe:resubscribe',
          async () => {
            return await withRpcLimit(
              () => (this.sharedUserMap as any)?.subscribe?.(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        await sleep(spacing); 
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
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
        } catch (e: any) {
          safeLog.warn('drift.orderSubscriber.create', { error: String(e?.message || e), cat: 'drift' });
          // fallback to legacy constructor (only if program is available)
          if (connection && program) {
            this.sharedOrderSubscriber = new (sdk as any).OrderSubscriber(connection, program);
          } else {
            safeLog.warn('drift.orderSubscriber.skip', { reason: program ? 'no_connection' : 'no_program', cat: 'drift' });
          }
        }
        try { 
          await waitReady();
          await this.sharedOrderSubscriber?.subscribe?.(); 
          await sleep(spacing); 
        } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      try { 
        await waitReady();
        await (this.sharedOrderSubscriber as any)?.subscribe?.(); 
        await sleep(spacing); 
      } catch (e: any) { safeLog.debug('drift.ws.waitReady', { error: String(e?.message || e), cat: 'drift' }); }
    }

    const dlobSource = (opts?.preferOrderSubscriber && this.sharedOrderSubscriber) ? this.sharedOrderSubscriber : this.sharedUserMap;
    if (!this.sharedDlobSubscriber && sdk?.DLOBSubscriber && dlobSource && this.sharedSlotSubscriber) {
      try {
        this.sharedDlobSubscriber = new (sdk as any).DLOBSubscriber({
          dlobSource,
          slotSource: this.sharedSlotSubscriber,
          updateFrequency: Math.max(200, Number(opts?.updateFrequency ?? 300)),
          driftClient: drift,
          userMapSubscriptionConfig: (() => { try { return drift.userAccountSubscriptionConfig || undefined; } catch (e: any) { safeLog.debug('drift.userAccountSubscriptionConfig', { error: String(e?.message || e), cat: 'drift' }); return undefined; } })(),
        });
        await waitReady();
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        await withDebounce(
          'drift:dlobSubscriber:subscribe:main',
          async () => {
            return await withRpcLimit(
              () => this.sharedDlobSubscriber.subscribe(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        await sleep(spacing);
      } catch (e: any) { safeLog.warn('drift.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
    } else {
      try {
        // If present but inactive, re-subscribe
        const dl: any = this.sharedDlobSubscriber;
        if (dl && typeof dl.subscribe === 'function') {
          // If getDLOB exists and returns falsy, attempt to resubscribe
          const has = typeof dl.getDLOB === 'function' ? !!dl.getDLOB() : true;
          if (!has) { 
            await waitReady();
            const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
            await withDebounce(
              'drift:dlobSubscriber:subscribe:resub',
              async () => {
                return await withRpcLimit(
                  () => dl.subscribe(),
                  1,
                  { module: 'drift', method: 'accountSubscribe' }
                );
              },
              200
            );
            await sleep(spacing); 
          }
        }
      } catch (e: any) { safeLog.warn('drift.dlobSubscriber.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
    }

    return {
      slotSubscriber: this.sharedSlotSubscriber,
      eventSubscriber: this.sharedEventSubscriber,
      userMap: this.sharedUserMap,
      dlobSubscriber: this.sharedDlobSubscriber,
      orderSubscriber: this.sharedOrderSubscriber,
    };
  }

  private async setupEventIndex(infra: { eventSubscriber?: any; userMap?: any } | null | undefined, reason: string): Promise<void> {
    try {
      const driftCfg: any = ((CONFIG as any)?.drift || {});
      const { driftEventIndex } = await import('./eventIndex.js');
      try {
        driftEventIndex.configure({
          ttlMs: driftCfg?.eventIndexTtlMs,
          maxUsers: driftCfg?.eventIndexMaxUsers,
          maxMarkets: driftCfg?.eventIndexMaxMarkets,
          maxMarketsPerUser: driftCfg?.eventIndexMaxMarketsPerUser,
        });
      } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
      try { driftEventIndex.bindEventSubscriber(infra?.eventSubscriber); } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
      try {
        const limit = Math.max(100, Number(driftCfg?.eventIndexBootstrapUsers ?? driftCfg?.eventIndexMaxUsers ?? 2000));
        driftEventIndex.bootstrapFromUserMap(infra?.userMap, { limit, includeOrders: true, reason });
      } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
      try {
        const sweepMs = Math.max(10_000, Number(driftCfg?.eventIndexSweepMs ?? 45_000));
        const limit = Math.max(100, Number(driftCfg?.eventIndexSweepUsers ?? driftCfg?.eventIndexMaxUsers ?? 1000));
        if (!this.eventIndexSweepTimer) {
          this.eventIndexSweepTimer = setInterval(() => {
            try { driftEventIndex.bootstrapFromUserMap(infra?.userMap, { limit, includeOrders: true, reason: 'infra_sweep' }); } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
          }, sweepMs);
        }
      } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.debug('drift.import.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
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
        try { await this.setupEventIndex(infra, 'infra_bootstrap'); } catch (e: any) { safeLog.debug('drift.setupEventIndex', { error: String(e?.message || e), cat: 'drift' }); }
        const prefetchEnabled = driftCfg?.prefetchEnabled !== false;
        const activeOnly = driftCfg?.prefetchActiveOnly !== false;
        if (prefetchEnabled) {
          try { await this.startUserPrefetcher(infra.dlobSubscriber, infra.userMap); } catch (e: any) { safeLog.warn('drift.startPrefetcher', { error: String(e?.message || e), cat: 'drift' }); }
        } else if (activeOnly) {
          try { await this.warmActiveUsersOnce(); } catch (e: any) { safeLog.debug('drift.warmActiveUsers', { error: String(e?.message || e), cat: 'drift' }); }
        }
        // Optional GPA bootstrap on Helius endpoints
        try {
          const heliusConn: any = this.getHeliusConn();
          const rpcEndpoint: string = String(heliusConn?._rpcEndpoint || heliusConn?.rpcEndpoint || '');
          const doGpa = !activeOnly && driftCfg?.warmupGpaBootstrap !== false && /helius/i.test(rpcEndpoint) && driftCfg?.prefetchEnabled !== false;
          if (doGpa) {
            const rawLim = driftCfg?.warmupGpaLimit ?? driftCfg?.prefetchGpaLimit ?? 1200;
            const limNum = Number(rawLim);
            const max = Math.max(100, Number.isFinite(limNum) ? limNum : 1200);
            safeLog.info('drift.warmup.gpa_start', { limit: max, cat: 'drift' });
            let decoded: Map<string, any> | null = null;
            try { decoded = await this.fetchUsersViaHeliusGpaV2(max, /*changedOnly*/ false); } catch (e: any) { safeLog.warn('drift.warmup.gpaFetch', { error: String(e?.message || e), cat: 'drift' }); decoded = null; }
            if (decoded && decoded.size > 0) {
              for (const [pk, ua] of decoded.entries()) {
                try {
                  this.evictWarmUserIfNeeded();
                  this.warmUsers.set(pk, { ua, ts: Date.now() });
                  try {
                    const ref = ua?.referrerInfo?.referrer;
                    if (ref && String(ref) !== '11111111111111111111111111111111') { await this.ensureRefStatsReady(ref); }
                  } catch (e: any) { safeLog.debug('drift.refStats', { error: String(e?.message || e), cat: 'drift' }); }
                } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
              }
              safeLog.info('drift.warmup.gpa_done', { decoded: decoded.size, cat: 'drift' });
            } else {
              // Fallback: enumerate keys (cheap) then fetch via MACI in small chunks
              try {
                const fastKeys = await this.enumerateUserPubkeysViaHeliusGpaV2(max, false);
                if (Array.isArray(fastKeys) && fastKeys.length > 0) {
                  safeLog.info('drift.warmup.enumerate_ok', { keys: fastKeys.length, cat: 'drift' });
                  const chunkSize = Math.max(10, Number(driftCfg?.prefetchChunkSize ?? 20));
                  for (let i = 0; i < Math.min(fastKeys.length, max); i += chunkSize) {
                    const slice = fastKeys.slice(i, i + chunkSize);
                    let map = new Map<string, any>();
                    try { map = await this.fetchUsersDecoded(slice); } catch (e: any) { safeLog.warn('drift.warmup.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' }); map = new Map(); }
                    for (const [pk, ua] of map.entries()) {
                      try {
                        this.evictWarmUserIfNeeded();
                        this.warmUsers.set(pk, { ua, ts: Date.now() });
                      } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
                    }
                  }
                  safeLog.info('drift.warmup.fallback_done', { warmed: this.warmUsers.size, cat: 'drift' });
                } else {
                  safeLog.info('drift.warmup.gpa_empty', { cat: 'drift' });
                }
              } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
            }
          }
        } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
        // Eagerly enumerate own subaccounts so cache is warm for bots/UI
        try { await this.getSubaccounts(); } catch (e: any) { safeLog.warn('drift.getSubaccounts', { error: String(e?.message || e), cat: 'drift' }); }
        this.warmupDone = true;
        this.lastWarmupAtMs = Date.now();
        safeLog.info('drift.warmup.ok', { ms: this.lastWarmupAtMs - t0, cat: 'drift' });
      } catch (e: any) {
        safeLog.warn('drift.warmup.failed', { err: String(e?.message || e), cat: 'drift' });
      } finally {
        this.warmupInProgress = false;
      }
    })();
    try { await this.warmupPromise; } catch (e: any) { safeLog.warn('drift.warmup', { error: String(e?.message || e), cat: 'drift' }); }
  }

  async waitForWarmup(timeoutMs?: number): Promise<boolean> {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    if (this.warmupDone) return true;
    // If warmup is disabled, consider ready
    if (driftCfg?.warmupEnabled === false) return true;
    try { await this.warmup(); } catch (e: any) { safeLog.warn('drift.warmup', { error: String(e?.message || e), cat: 'drift' }); }
    if (this.warmupDone) return true;
    const ms = Math.max(1000, Number(timeoutMs ?? driftCfg?.warmupTimeoutMs ?? 30000));
    try {
      await Promise.race([
        (async () => { while (!this.warmupDone) { await new Promise((r) => setTimeout(r, 200)); } })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('WARMUP_TIMEOUT')), ms)),
      ]);
      return true;
    } catch (e: any) {
      safeLog.debug('drift.warmup.timeout', { error: String(e?.message || e), cat: 'drift' });
      return false;
    }
  }

  // Infra manager: manual activation and bot-aware teardown
  async activate(opts?: { includeIdle?: boolean; updateFrequency?: number; preferOrderSubscriber?: boolean }): Promise<void> {
    this.forceActive = true;
    await this.warmup(opts);
    try {
      const { DriftPriceService } = await import('./price.js');
      DriftPriceService.getInstance();
    } catch (e: any) { safeLog.warn('drift.import.price', { error: String(e?.message || e), cat: 'drift' }); }
    this.infraReady = !!this.warmupDone;
    if (this.infraReady) this.infraReadyAtMs = Date.now();
    safeLog.info('drift.infra.activated', { cat: 'drift', ready: this.infraReady });
  }

  deactivate(): void {
    this.forceActive = false;
    this.infraReady = false;
    this.infraReadyAtMs = 0;
    this.maybeTeardownInfra();
    safeLog.info('drift.infra.deactivated', { cat: 'drift' });
  }

  registerBot(key: string): void {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      this.activeBots.add(k);
      safeLog.debug('drift.infra.bot_register', { key: k, total: this.activeBots.size, cat: 'drift' });
    } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
  }

  unregisterBot(key: string): void {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      this.activeBots.delete(k);
      safeLog.debug('drift.infra.bot_unregister', { key: k, total: this.activeBots.size, cat: 'drift' });
      this.maybeTeardownInfra();
    } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
  }

  getInfraStatus(): {
    active: boolean;
    forceActive: boolean;
    bots: number;
    has: { slotSubscriber: boolean; eventSubscriber: boolean; userMap: boolean; dlobSubscriber: boolean; orderSubscriber: boolean };
    lastSlotAtMs?: number;
    slotStale?: boolean;
    warmupDone?: boolean;
    warmupInProgress?: boolean;
    infraReady?: boolean;
    infraReadyAtMs?: number;
    ready?: boolean;
  } {
    const slotStaleMs = Math.max(5000, Number(((CONFIG as any)?.drift?.slotStaleMs) ?? 15000));
    const slotStale = !!(this.lastSlotTs && (Date.now() - this.lastSlotTs) > slotStaleMs);
    const has = {
      slotSubscriber: !!this.sharedSlotSubscriber,
      eventSubscriber: !!this.sharedEventSubscriber,
      userMap: !!this.sharedUserMap,
      dlobSubscriber: !!this.sharedDlobSubscriber,
      orderSubscriber: !!this.sharedOrderSubscriber,
    };
    const ready = !!(this.infraReady && !slotStale && has.slotSubscriber && has.eventSubscriber && has.userMap && has.dlobSubscriber);
    return {
      active: !!(this.sharedSlotSubscriber || this.sharedEventSubscriber || this.sharedUserMap || this.sharedDlobSubscriber || this.sharedOrderSubscriber),
      forceActive: this.forceActive,
      bots: this.activeBots.size,
      has,
      lastSlotAtMs: this.lastSlotTs || undefined,
      slotStale,
      warmupDone: this.warmupDone,
      warmupInProgress: this.warmupInProgress,
      infraReady: this.infraReady,
      infraReadyAtMs: this.infraReadyAtMs || undefined,
      ready,
    };
  }

  private getUserCountRefreshMs(): number {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    return Math.max(60_000, Number(driftCfg?.userCountRefreshMs ?? 1_800_000)); // default 30m
  }

  private getUserCountLimit(): number {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    const raw = driftCfg?.userCountGpaLimit ?? driftCfg?.prefetchGpaLimit ?? 200_000;
    const n = Number(raw);
    return Math.max(10_000, Number.isFinite(n) ? n : 200_000);
  }

  private ensureUserCountTimer(): void {
    if (this.userCountTimer) return;
    const refreshMs = this.getUserCountRefreshMs();
    this.userCountTimer = setInterval(() => {
      this.refreshUserCount('timer').catch(() => {});
    }, refreshMs);
    // Kick an initial refresh shortly after first request
    setTimeout(() => { this.refreshUserCount('initial').catch(() => {}); }, 250);
  }

  private async refreshUserCount(reason: string): Promise<void> {
    if (this.userCountInFlight) return this.userCountInFlight;
    this.userCountInFlight = (async () => {
      const prev = this.userCountCache || {};
      try {
        await this.init();
        const heliusConn: any = this.getHeliusConn();
        const endpoint: string = String(heliusConn?._rpcEndpoint || heliusConn?.rpcEndpoint || '');
        if (!/helius/i.test(endpoint)) {
          this.userCountCache = { ...prev, error: 'helius_required' };
          return;
        }
        const limit = this.getUserCountLimit();
        const keys = await this.enumerateUserPubkeysViaHeliusGpaV2(limit, false);
        const total = Array.isArray(keys) ? keys.length : 0;
        const capped = total >= limit;
        this.userCountCache = {
          total,
          capped,
          updatedAtMs: Date.now(),
          source: 'helius-gpa',
        };
        safeLog.info('drift.user_count.refresh', { total, capped, reason, cat: 'drift' });
      } catch (e: any) {
        this.userCountCache = { ...prev, error: String(e?.message || e) };
      }
    })();
    try {
      await this.userCountInFlight;
    } finally {
      this.userCountInFlight = null;
    }
  }

  async getUserCountCached(opts?: { force?: boolean; wait?: boolean }): Promise<{ total?: number; updatedAtMs?: number; capped?: boolean; error?: string; source?: string; refreshMs: number; stale: boolean; refreshing: boolean }> {
    this.ensureUserCountTimer();
    const refreshMs = this.getUserCountRefreshMs();
    const cache = this.userCountCache;
    const stale = !cache?.updatedAtMs || (Date.now() - cache.updatedAtMs) > refreshMs;
    if (opts?.force) {
      await this.refreshUserCount('force');
    } else if (stale && !this.userCountInFlight) {
      if (opts?.wait) {
        await this.refreshUserCount('stale_wait');
      } else {
        this.refreshUserCount('stale').catch(() => {});
      }
    }
    const latest = this.userCountCache || {};
    return {
      total: latest.total,
      updatedAtMs: latest.updatedAtMs,
      capped: latest.capped,
      error: latest.error,
      source: latest.source,
      refreshMs,
      stale: !latest.updatedAtMs || (Date.now() - latest.updatedAtMs) > refreshMs,
      refreshing: !!this.userCountInFlight,
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
        try { (this.sharedSlotSubscriber as any)?.eventEmitter?.off?.('slotUpdate', this._slotTsHandler); } catch (e: any) { safeLog.debug('drift.eventEmitter.off', { error: String(e?.message || e), cat: 'drift' }); }
      }
      try {
        if (typeof (this.sharedSlotSubscriber as any).onSlotChange === 'function') {
          (this.sharedSlotSubscriber as any).onSlotChange(onSlot, 1);
        } else {
          (this.sharedSlotSubscriber as any)?.eventEmitter?.on?.('slotUpdate', onSlot);
        }
      } catch (e: any) { safeLog.debug('drift.eventListener.attach', { error: String(e?.message || e), cat: 'drift' }); }
      this._slotTsHandler = onSlot;
    } catch (e: any) { safeLog.debug('drift.eventEmitter.off', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async teardownInfra(): Promise<void> {
    // Stop timers and shared blockhash warmer
    try { if (this.prefetchTimer) { clearInterval(this.prefetchTimer); this.prefetchTimer = null; } } catch (e: any) { safeLog.debug('drift.prefetch', { error: String(e?.message || e), cat: 'drift' }); }
    try { if (this.pollLoaderWarm) { try { (this.pollLoaderWarm as any)?.removeAllListeners?.(); } catch (e: any) { safeLog.debug('drift.cleanup.removeListeners', { error: String(e?.message || e), cat: 'drift' }); } this.pollLoaderWarm = null; } } catch (e: any) { safeLog.debug('drift.cleanup.removeListeners', { error: String(e?.message || e), cat: 'drift' }); }
    try { const mod = await import('../utils/blockhash.js'); (mod as any)?.stopSharedBlockhash?.(); } catch (e: any) { safeLog.warn('drift.import.blockhash', { error: String(e?.message || e), cat: 'drift' }); }
    try { if (this.eventIndexSweepTimer) { clearInterval(this.eventIndexSweepTimer); this.eventIndexSweepTimer = null; } } catch { /* timer cleanup safe to swallow */ }
    // Stop infra watchdog and detach slot listener
    try { if (this.infraWatchdogTimer) { clearInterval(this.infraWatchdogTimer); this.infraWatchdogTimer = null; } } catch { /* timer cleanup safe to swallow */ }
    try {
      if (this._slotTsHandler && (this.sharedSlotSubscriber as any)?.eventEmitter?.off) {
        (this.sharedSlotSubscriber as any).eventEmitter.off('slotUpdate', this._slotTsHandler);
      }
    } catch (e: any) { safeLog.debug('drift.eventEmitter.off', { error: String(e?.message || e), cat: 'drift' }); }
    this._slotTsHandler = null;
    this.lastSlotTs = 0;
    this._staleCount = 0;
    // Unsubscribe subscribers in safe order
    try { await (this.sharedDlobSubscriber as any)?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.dlobSubscriber.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
    try { await (this.sharedOrderSubscriber as any)?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.orderSubscriber.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
    try { await (this.sharedUserMap as any)?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.userMap.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
    try { await (this.sharedEventSubscriber as any)?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.eventSubscriber.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
    try { await (this.sharedSlotSubscriber as any)?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.slotSubscriber.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
    this.sharedDlobSubscriber = null;
    this.sharedOrderSubscriber = null;
    this.sharedUserMap = null;
    this.sharedEventSubscriber = null;
    this.sharedSlotSubscriber = null;
    this.infraReady = false;
    this.infraReadyAtMs = 0;
    this.activeSubaccountId = null;
  }

  // Public cleanup method for shutdown - ensures all subscriptions are properly torn down
  async cleanup(): Promise<void> {
    // Track cleanup with a promise so init() can wait for it to complete
    // This prevents race conditions between shutdown and startup
    this.cleanupPromise = (async () => {
      try {
        logger.info('drift.cleanup.start', { cat: 'drift' });
        
        // Unsubscribe the main client first
        try {
          if (this.client && typeof (this.client as any).unsubscribe === 'function') {
            await (this.client as any).unsubscribe().catch(() => {});
          }
        } catch (e: any) { safeLog.debug('drift.client.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
        
        // Unsubscribe all warm users
        const warmUnsubscribes: Array<Promise<any>> = [];
        for (const [pk, warm] of this.warmUsers.entries()) {
          try {
            const user = (warm as any)?.user;
            if (user && typeof user.unsubscribe === 'function') {
              warmUnsubscribes.push((user as any).unsubscribe().catch(() => {}));
            }
          } catch (e: any) { safeLog.debug('drift.user.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
        }
        if (warmUnsubscribes.length > 0) {
          try { await Promise.allSettled(warmUnsubscribes); } catch (e: any) { safeLog.debug('drift.cleanup.allSettled', { error: String(e?.message || e), cat: 'drift' }); }
        }
        this.warmUsers.clear();

        // Unsubscribe the active user if it exists
        try {
          const activeUser = (this.client as any)?.user;
          if (activeUser && typeof activeUser.unsubscribe === 'function') {
            await activeUser.unsubscribe().catch(() => {});
          }
        } catch (e: any) { safeLog.debug('drift.user.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }

        // Close all pooled subscription connections
        for (const pc of this.wsPoolConns) {
          try {
            const rpcWs: any = (pc as any)?._rpcWebSocket;
            if (rpcWs) {
              try { rpcWs._subscriptionsByAccountChangeSubscriptionId?.clear?.(); } catch {}
              try { rpcWs._subscriptionsByProgramAccountChangeSubscriptionId?.clear?.(); } catch {}
              if (rpcWs._subscriptionUpdateTimer) {
                try { clearTimeout(rpcWs._subscriptionUpdateTimer); rpcWs._subscriptionUpdateTimer = null; } catch {}
              }
              const ws = rpcWs.underlyingSocket || rpcWs._ws || rpcWs.socket || rpcWs._socket;
              if (ws && typeof ws.close === 'function') { try { ws.close(); } catch {} }
            }
          } catch {}
        }
        this.wsPoolConns = [];
        this.wsPoolSubCounts = [];
        this.wsPoolSubMap.clear();
        this.wsPoolNextId = 1_000_000;

        // Clear the primary Connection's internal subscription maps to prevent _updateSubscriptions
        // from trying to resubscribe after shutdown
        try {
          if (this.connection) {
            const rpcWs: any = (this.connection as any)?._rpcWebSocket;
            if (rpcWs) {
              // Clear subscription maps
              if (rpcWs._subscriptionsByAccountChangeSubscriptionId) {
                try { rpcWs._subscriptionsByAccountChangeSubscriptionId.clear?.(); } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
              }
              if (rpcWs._subscriptionsByProgramAccountChangeSubscriptionId) {
                try { rpcWs._subscriptionsByProgramAccountChangeSubscriptionId.clear?.(); } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
              }
              // Clear any pending timers that might trigger _updateSubscriptions
              if (rpcWs._subscriptionUpdateTimer) {
                try { clearTimeout(rpcWs._subscriptionUpdateTimer); rpcWs._subscriptionUpdateTimer = null; } catch { /* timer cleanup safe to swallow */ }
              }

              // Close the WebSocket connection to prevent lingering subscriptions
              try {
                const ws = rpcWs.underlyingSocket || rpcWs._ws || rpcWs.socket || rpcWs._socket;
                if (ws && typeof ws.close === 'function') {
                  ws.close();
                }
              } catch (e: any) { safeLog.debug('drift.ws.close', { error: String(e?.message || e), cat: 'drift' }); }
            }
          }
        } catch { /* timer cleanup safe to swallow */ }

        // Teardown infrastructure (shared subscribers, timers, etc.)
        await this.teardownInfra();
        
        // Reset client state to allow reinitialization
        this.client = null;
        this.connection = null;
        this.loader = null;
        
        logger.info('drift.cleanup.complete', { cat: 'drift' });
      } catch (e: any) {
        safeLog.warn('drift.cleanup.error', { error: String(e?.message || e), cat: 'drift' });
      }
    })();
    
    // Wait for cleanup to complete
    try {
      await this.cleanupPromise;
    } catch (e: any) { safeLog.debug('drift.cleanupWait', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private maybeTeardownInfra(): void {
    if (this.forceActive) return;
    if (this.activeBots.size > 0) return;
    // Fire-and-forget teardown
    this.teardownInfra().catch(() => {});
  }

  private getWarmUserCap(): number {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    const raw = driftCfg?.prefetchWarmUserCap ?? driftCfg?.eventIndexMaxUsers ?? 500;
    const n = Number(raw);
    return Math.max(500, Number.isFinite(n) ? n : 500);
  }

  private evictWarmUserIfNeeded(): void {
    const cap = this.getWarmUserCap();
    if (this.warmUsers.size < cap) return;
    const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldest) {
      try { (this.warmUsers.get(oldest) as any)?.user?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.user.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
      this.warmUsers.delete(oldest);
    }
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
    } catch (e: any) {
      safeLog.debug('drift.accountDiscriminator', { error: String(e?.message || e), cat: 'drift' });
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

      const { withRpcLimit, withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let delayMs = 500;
      let paginationKey: any = undefined;
      let fetched = 0;
      let page = 0;
      let coder: any = null;
      try { coder = drift?.program?.coder?.accounts || null; } catch (e: any) { safeLog.debug('drift.sdk.coder', { error: String(e?.message || e), cat: 'drift' }); }

      while (page < maxPages && fetched < totalLimit) {
        const remaining = totalLimit - fetched;
        const lmt = Math.min(pageSize, remaining);
        const params: any = { encoding: 'base64', filters, limit: lmt, commitment: 'processed' };
        if (changedOnly && this.lastPrefetchSlot > 0) { (params as any).changedSinceSlot = Number(this.lastPrefetchSlot); }
        if (paginationKey) { (params as any).paginationKey = paginationKey; }
        const body: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccountsV2', params: [programId, params] };

        const execRpc = (rpcBody: any, label: string) => withRpcLimit(
          () => withRpcTimeout(
            fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpcBody) }),
            3000,
            label
          ),
          1,
          { module: 'drift.helius', method: String(rpcBody?.method || 'getProgramAccountsV2') }
        );

        for (let attempt = 0; attempt < 4; attempt += 1) {
          const res: any = await execRpc(body, 'helius.gpa.page');
          if (res?.status === 429) {
            const retryAfter = Number(res.headers?.get?.('retry-after') || 0) * 1000;
            const jitter = 1 + (Math.random() * 0.2 - 0.1);
            const wait = Math.min(6000, Math.max(500, retryAfter || Math.round(delayMs * jitter)));
            delayMs = Math.min(6000, Math.round(delayMs * 2));
            safeLog.warn('drift.prefetch.429', { delayMs: wait, attempt: attempt + 1, page, limit: lmt, changedOnly, cat: 'drift' });
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          let json = await res.json().catch(() => ({}));
          // Helius may not support getProgramAccountsV2 on some endpoints; fallback to getProgramAccounts
          if ((json as any)?.error || (!Array.isArray(json?.result?.accounts) && !Array.isArray(json?.result))) {
            try {
              const bodyV1: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [programId, params] };
              const res2: any = await execRpc(bodyV1, 'helius.gpa.page.fallback');
              json = await res2.json().catch(() => ({}));
            } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
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
              try { ua = coder?.decode?.('User', raw); } catch (e: any) { safeLog.debug('drift.decode', { error: String(e?.message || e), cat: 'drift' }); }
              if (!ua) { try { ua = drift?.program?.account?.user?.coder?.accounts?.decode?.('User', raw); } catch (e: any) { safeLog.debug('drift.sdk.coder', { error: String(e?.message || e), cat: 'drift' }); } }
              if (ua) {
                if (!out.has(pk)) { out.set(pk, ua); fetched += 1; }
              }
            } catch (e: any) { safeLog.debug('drift.decode', { error: String(e?.message || e), cat: 'drift' }); }
          }
          paginationKey = json?.result?.paginationKey || null;
          safeLog.info('drift.prefetch.gpa_page', { page: page + 1, fetchedInPage: list?.length || 0, totalFetched: fetched, hasMore: !!paginationKey, cat: 'drift' });
          break;
        }
        if (!paginationKey) break;
        page += 1;
      }
      try { this.lastPrefetchSlot = Number(await this.getReadConnection().getSlot('processed')); } catch (e: any) { safeLog.warn('drift.rpc', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
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
      const { withRpcLimit, withRpcTimeout } = await import('../utils/rpcLimiter.js');
      let paginationKey: any = undefined;
      let fetched = 0;
      while (fetched < totalLimit) {
        const remaining = totalLimit - fetched;
        const lmt = Math.min(pageSize, remaining);
        const params: any = { encoding: 'base64', filters, dataSlice: { offset: 0, length: 0 }, limit: lmt, commitment: 'processed' };
        if (changedOnly && this.lastPrefetchSlot > 0) { (params as any).changedSinceSlot = Number(this.lastPrefetchSlot); }
        if (paginationKey) { (params as any).paginationKey = paginationKey; }
        const body: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccountsV2', params: [programId, params] };
        const res: any = await withRpcLimit(
          () => withRpcTimeout(
            fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            3000,
            'helius.gpa.keys'
          ),
          1,
          { module: 'drift.helius', method: 'getProgramAccountsV2' }
        );
        let json = await res.json().catch(() => ({}));
        // Fallback to getProgramAccounts if V2 unsupported
        if ((json as any)?.error || (!Array.isArray(json?.result?.accounts) && !Array.isArray(json?.result))) {
          try {
            const bodyV1: any = { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [programId, params] };
            const res2: any = await withRpcLimit(
              () => withRpcTimeout(
                fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyV1) }),
                3000,
                'helius.gpa.keys.fallback'
              ),
              1,
              { module: 'drift.helius', method: 'getProgramAccounts' }
            );
            json = await res2.json().catch(() => ({}));
          } catch (e: any) { safeLog.warn('drift.rpc.fetch', { error: String(e?.message || e), cat: 'drift' }); }
        }
        const accounts = json?.result?.accounts || json?.result || [];
        if (!Array.isArray(accounts) || accounts.length === 0) break;
        for (const a of accounts) {
          const pk = String(a?.pubkey || a?.account || '');
          if (pk && out.length < totalLimit) { out.push(pk); fetched += 1; }
        }
        paginationKey = json?.result?.paginationKey || null;
        safeLog.info('drift.warmup.enumerate_page', { count: accounts?.length || 0, total: out.length, hasMore: !!paginationKey, cat: 'drift' });
        if (!paginationKey) break;
      }
      try { this.lastPrefetchSlot = Number(await this.getReadConnection().getSlot('processed')); } catch (e: any) { safeLog.warn('drift.rpc', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
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
      const infos = await withRpcLimit(
        () => this.getReadConnection().getMultipleAccountsInfo(keys, 'processed'),
        weight,
        { module: 'drift', method: 'getMultipleAccountsInfo' }
      );
      const out = new Map<string, any>();
      let coder: any = null;
      try { coder = (this.client as any)?.program?.coder?.accounts || null; } catch (e: any) { safeLog.debug('drift.sdk.coder', { error: String(e?.message || e), cat: 'drift' }); }
      for (let i = 0; i < keys.length; i += 1) {
        try {
          const info = infos?.[i];
          if (!info?.data) continue;
          let ua: any = null;
          try { ua = coder?.decode?.('User', info.data); } catch (e: any) { safeLog.debug('drift.decode', { error: String(e?.message || e), cat: 'drift' }); }
          if (!ua) {
            try { ua = (this.client as any)?.program?.account?.user?.coder?.accounts?.decode?.('User', info.data); } catch (e: any) { safeLog.debug('drift.sdk.coder', { error: String(e?.message || e), cat: 'drift' }); }
          }
          if (ua) out.set(keys[i].toBase58(), ua);
        } catch (e: any) { safeLog.debug('drift.decode', { error: String(e?.message || e), cat: 'drift' }); }
      }
      return out;
    } catch (e: any) {
      safeLog.warn('drift.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' });
      return new Map<string, any>();
    }
  }
  async ensureRefStatsReady(referrerAuth: PublicKey): Promise<PublicKey | null> {
    await this.init();
    try {
      let sdk: any = null;
      try { sdk = await import('@drift-labs/sdk'); } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
      const pk: PublicKey = (sdk as any).getUserStatsAccountPublicKey(this.client.program.programId, referrerAuth);
      const key = pk.toBase58();
      if (this.warmRefStats.has(key)) return pk;
      const missAt = this.missingRefStats.get(key);
      if (missAt && Date.now() - missAt < this.refStatsTtlMs) return null;
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      const info = await withRpcLimit(
        () => this.getReadConnection().getAccountInfo(pk, 'processed'),
        1,
        { module: 'drift', method: 'getAccountInfo' }
      );
      if (info) { this.warmRefStats.add(key); return pk; }
      this.missingRefStats.set(key, Date.now());
      return null;
    } catch (e: any) { safeLog.warn('drift.ensureRefStatsReady', { error: String(e?.message || e), cat: 'drift' }); return null; }
  }
  enqueueUsersForPrefetch(pks: string[]): void {
    const driftCfg: any = ((CONFIG as any)?.drift || {});
    const activeOnly = driftCfg?.prefetchActiveOnly !== false;
    const capRaw = activeOnly ? (driftCfg?.prefetchWarmUserCap ?? driftCfg?.prefetchQueueCap) : driftCfg?.prefetchQueueCap;
    const cap = Math.max(1000, Number(capRaw ?? 5000));
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
    const activeOnly = driftCfg?.prefetchActiveOnly !== false;
    let driftEventIndex: any = null;
    if (activeOnly) {
      try { driftEventIndex = (await import('./eventIndex.js'))?.driftEventIndex; } catch (e: any) { safeLog.debug('drift.import.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
    }
    this.prefetchRunning = true;
    // Prepare polling loader for stability
    try {
      const { BulkAccountLoader } = await loadSdk();
      if (!this.pollLoaderWarm) {
        // Use a slightly slower polling frequency to reduce provider load
        this.pollLoaderWarm = new BulkAccountLoader(this.connection!, 'confirmed', 1500);
        try { (this.pollLoaderWarm as any)?.on?.('error', (e: any) => { safeLog.warn('drift.pollLoaderWarm.error', { error: String(e?.message || e), cat: 'drift' }); }); } catch (e: any) { safeLog.debug('drift.eventListener.attach', { error: String(e?.message || e), cat: 'drift' }); }
      }
    } catch (e: any) { safeLog.debug('drift.eventListener.attach', { error: String(e?.message || e), cat: 'drift' }); }

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
        } catch (e: any) { safeLog.warn('drift.sdk.getMarkets', { error: String(e?.message || e), cat: 'drift' }); }
        if (!Array.isArray(indices) || indices.length === 0) { indices = [0, 1, 2, 31, 45]; }
        for (const mi of indices) {
          try {
            const nodes = dlob.getRestingLimitOrderNodes?.(mi) || [];
            for (const n of nodes) {
              const taker = String(n?.userAccount || ''); if (taker) found.add(taker);
              const makers = Array.isArray(n?.makerNodes) ? n.makerNodes : [];
              for (const mn of makers) { const mk = String(mn?.userAccount || ''); if (mk) found.add(mk); }
            }
          } catch (e: any) { safeLog.debug('drift.dlob', { error: String(e?.message || e), cat: 'drift' }); }
        }
        const MAX_KEYS = 1000;
        this.enqueueUsersForPrefetch(Array.from(found).slice(0, MAX_KEYS));
      } catch (e: any) { safeLog.warn('drift.sdk.getMarkets', { error: String(e?.message || e), cat: 'drift' }); }
    };

    const collectFromActiveIndex = async () => {
      try {
        if (!driftEventIndex?.getActiveUsers) return;
        const capRaw = driftCfg?.prefetchWarmUserCap ?? driftCfg?.prefetchQueueCap ?? 5000;
        const maxKeys = Math.max(100, Number(capRaw));
        const keys = driftEventIndex.getActiveUsers(maxKeys) || [];
        this.enqueueUsersForPrefetch(keys);
      } catch (e: any) { safeLog.debug('drift.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
    };

    // Choose prefetch method: auto => use GPA on Helius endpoints, else MACI
    const cfgMethodRaw = String((driftCfg?.prefetchMethod || 'auto')).toLowerCase();
    const rpcEndpoint: string = String((this.connection as any)?._rpcEndpoint || (this.connection as any)?.rpcEndpoint || '');
    const autoPick = activeOnly ? 'maci' : (/helius/i.test(rpcEndpoint) ? 'gpa' : 'maci');
    let method = cfgMethodRaw === 'auto' ? autoPick : cfgMethodRaw;
    if (activeOnly && method === 'gpa') method = 'maci';
    safeLog.info('drift.prefetch.start', { method, rpc: rpcEndpoint.includes('helius') ? 'helius' : 'other', cat: 'drift' });
    const step = async () => {
      try {
        if (method === 'gpa') {
          const limit = Math.max(100, Number(driftCfg?.prefetchGpaLimit ?? 1200));
          const changedOnly = (driftCfg?.prefetchGpaChangedOnly !== false);
          const decoded = await this.fetchUsersViaHeliusGpaV2(limit, changedOnly);
          if (decoded && decoded.size > 0) {
            for (const [pk, ua] of decoded.entries()) {
              try {
                this.evictWarmUserIfNeeded();
                this.warmUsers.set(pk, { ua, ts: Date.now() });
                try {
                  const ref = ua?.referrerInfo?.referrer;
                  if (ref && String(ref) !== '11111111111111111111111111111111') {
                    await this.ensureRefStatsReady(ref);
                  }
                } catch (e: any) { safeLog.debug('drift.refStats', { error: String(e?.message || e), cat: 'drift' }); }
              } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
            }
          }
          return;
        }
        // Default MACI path
        if (activeOnly) {
          await collectFromActiveIndex();
        }
        await collectFromDlob();
        const batch = this.prefetchQueue.splice(0, batchMax);
        if (batch.length === 0) return;
        const chunkSize = chunkSizeCfg;
        for (let i = 0; i < batch.length; i += chunkSize) {
          const chunk = batch.slice(i, i + chunkSize);
          let decoded: Map<string, any> = new Map();
          try { decoded = await this.fetchUsersDecoded(chunk); } catch (e: any) { safeLog.warn('drift.prefetch.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' }); decoded = new Map(); }
          for (const pk of chunk) {
            try {
              const ua = decoded.get(pk);
              if (!ua) continue;
              this.evictWarmUserIfNeeded();
              this.warmUsers.set(pk, { ua, ts: Date.now() });
              try {
                const ref = ua?.referrerInfo?.referrer;
                if (ref && String(ref) !== '11111111111111111111111111111111') {
                  await this.ensureRefStatsReady(ref);
                }
              } catch (e: any) { safeLog.debug('drift.refStats', { error: String(e?.message || e), cat: 'drift' }); }
            } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
          }
        }
      } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
    };

    if (this.prefetchTimer) { try { clearInterval(this.prefetchTimer); } catch (e: any) { safeLog.debug('drift.prefetch', { error: String(e?.message || e), cat: 'drift' }); } }
    this.prefetchTimer = setInterval(() => { step().catch(() => {}); }, intervalMs);
    // Run an immediate step to avoid waiting for the first interval
    try { step().catch(() => {}); } catch (e: any) { safeLog.debug('drift.prefetch.step', { error: String(e?.message || e), cat: 'drift' }); }
  }

  private async warmActiveUsersOnce(): Promise<void> {
    try {
      await this.init();
      const driftCfg: any = ((CONFIG as any)?.drift || {});
      const { driftEventIndex } = await import('./eventIndex.js');
      const capRaw = driftCfg?.prefetchWarmUserCap ?? driftCfg?.eventIndexMaxUsers ?? 1000;
      const maxUsers = Math.max(100, Number(capRaw));
      const keys: string[] = driftEventIndex.getActiveUsers?.(maxUsers) || [];
      if (!Array.isArray(keys) || keys.length === 0) return;
      const chunkSize = Math.max(10, Number(driftCfg?.prefetchChunkSize ?? 20));
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        let decoded: Map<string, any> = new Map();
        try { decoded = await this.fetchUsersDecoded(chunk); } catch (e: any) { safeLog.warn('drift.warmActiveUsers.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' }); decoded = new Map(); }
        for (const pk of chunk) {
          try {
            const ua = decoded.get(pk);
            if (!ua) continue;
            this.evictWarmUserIfNeeded();
            this.warmUsers.set(pk, { ua, ts: Date.now() });
            try {
              const ref = ua?.referrerInfo?.referrer;
              if (ref && String(ref) !== '11111111111111111111111111111111') {
                await this.ensureRefStatsReady(ref);
              }
            } catch (e: any) { safeLog.debug('drift.refStats', { error: String(e?.message || e), cat: 'drift' }); }
          } catch (e: any) { safeLog.debug('drift.warmUsers', { error: String(e?.message || e), cat: 'drift' }); }
        }
      }
      safeLog.info('drift.prefetch.active_warm', { users: keys.length, cat: 'drift' });
    } catch (e: any) { safeLog.debug('drift.import.eventIndex', { error: String(e?.message || e), cat: 'drift' }); }
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
        safeLog.warn('tx.send.primary_fail', { cat: 'tx', url: maskUrl((CONFIG as any)?.rpcUrl), err: String(ePrimary?.message || ePrimary) });
        // Secondary RPC fallback (tight timeouts, best-effort)
        const secondaries: string[] = Array.isArray((CONFIG as any)?.rpcSend?.secondaryRpcUrls) ? (CONFIG as any).rpcSend.secondaryRpcUrls : [];
        let lastErr: any = ePrimary;
        for (const url of secondaries) {
          try {
            const alt = new Connection(String(url), { commitment: 'processed', disableRetryOnRateLimit: true } as any);
            const sig = await tryWithTimeout(alt, raw, Number(((CONFIG as any)?.rpcSend?.sendTimeoutMs) ?? 1200));
            safeLog.info('tx.send.fallback_ok', { cat: 'tx', url: maskUrl(url) });
            return sig;
          } catch (eAlt: any) {
            lastErr = eAlt;
            safeLog.warn('tx.send.fallback_fail', { cat: 'tx', url, err: String(eAlt?.message || eAlt) });
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
      safeLog.info('drift.tx.throttle_config', { minGapMs: this.minTxGapMs, maxInFlight: this.maxTxInFlight, cat: 'drift' });
    } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
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
        } catch (e: any) { safeLog.warn('drift.initializeUser', { error: String(e?.message || e), cat: 'drift' }); }
      }
    } catch (e: any) { safeLog.warn('drift.initializeUser', { error: String(e?.message || e), cat: 'drift' }); }
    try { if (typeof client?.addUser === 'function') { await client.addUser(Number(subaccountId)); } } catch (e: any) { safeLog.warn('drift.addUser', { error: String(e?.message || e), cat: 'drift' }); }
    try { if (typeof client?.switchActiveUser === 'function') { await client.switchActiveUser(Number(subaccountId)); } } catch (e: any) { safeLog.warn('drift.switchActiveUser', { error: String(e?.message || e), cat: 'drift' }); }
    safeLog.debug('drift.user.ready', { subaccountId, ms: Date.now() - t0, cat: 'drift' });
  }

  async getActiveSubaccountSnapshot(): Promise<SubaccountInfo | null> {
    await this.init();
    try {
      const client: any = this.client;
      let user = (() => { try { return client?.user; } catch { return null; } })();
      // If no active user, try to force-add the configured subaccount
      if (!user) {
        try {
          const subId = Number(this.activeSubaccountId ?? (CONFIG as any).drift?.defaultSubaccountId ?? 0);
          safeLog.debug('drift.snapshot.recovery', { subId, cat: 'drift' });
          if (typeof client?.addUser === 'function') await client.addUser(subId);
          if (typeof client?.switchActiveUser === 'function') await client.switchActiveUser(subId);
          this.activeSubaccountId = subId;
          user = (() => { try { return client?.user; } catch { return null; } })();
        } catch (e: any) {
          safeLog.warn('drift.snapshot.recovery_failed', { error: String(e?.message || e), cat: 'drift' });
        }
      }
      if (!user) {
        safeLog.debug('drift.snapshot.no_active_user', { activeSubaccountId: this.activeSubaccountId, cat: 'drift' });
        return null;
      }
      const acct = user?.getUserAccount?.();
      if (!acct?.authority) {
        safeLog.warn('drift.snapshot.user_not_hydrated', { activeSubaccountId: this.activeSubaccountId, cat: 'drift' });
        return null;
      }
      const id = Number((acct?.subAccountId) ?? (client?.activeUserId) ?? (CONFIG as any).drift?.defaultSubaccountId ?? 0);
      // Convert quote-precision values to UI units using SDK constants when available
      let QUOTE_PREC = 1_000_000;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        QUOTE_PREC = Number(cst?.QUOTE_PRECISION ?? 1_000_000);
      } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
      const toUi = (val: any): number => {
        try {
          return Number(val?.toString?.() || val || 0) / QUOTE_PREC;
        } catch (e: any) { safeLog.debug('drift.toUi', { error: String(e?.message || e), cat: 'drift' }); return Number(val?.toString?.() || val || 0) / QUOTE_PREC; }
      };
      const totalCollateral = toUi(user?.getTotalCollateral?.('Maintenance'));
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
      } catch (e: any) { safeLog.debug('drift.sdk.getPositions', { error: String(e?.message || e), cat: 'drift' }); }
      // If all dollar values are 0 but user has spot balances, oracles haven't loaded.
      // Return null so caller can fall through to getSubaccounts() polling path.
      if (totalCollateral === 0 && maint === 0 && free === 0 && initReq === 0) {
        let hasSpotBalance = false;
        try {
          const spots = user?.getSpotPositions?.() || [];
          for (const sp of spots) {
            const raw = Number(sp?.scaledBalance?.toString?.() || sp?.balance || 0);
            if (raw !== 0) { hasSpotBalance = true; break; }
          }
        } catch (e: any) { safeLog.debug('drift.sdk.getPositions', { error: String(e?.message || e), cat: 'drift' }); }
        if (hasSpotBalance) {
          safeLog.warn('drift.snapshot.oracle_not_loaded', { activeSubaccountId: this.activeSubaccountId, cat: 'drift' });
          return null;
        }
      }
      return { id, freeCollateral: free, totalCollateral, maintenanceRequirement: maint, initialRequirement: initReq, effectiveLeverage: lev, positions };
    } catch (e: any) {
      safeLog.warn('drift.getActiveSubaccountSnapshot', { error: String(e?.message || e), cat: 'drift' });
      return null;
    }
  }

  async getStatus(): Promise<DriftStatus> {
    await this.init();
    const markets: DriftMarketRef[] = await this.discoverMarkets();
    let subs: SubaccountInfo[] = [];
    try {
      const snap = await this.getActiveSubaccountSnapshot();
      // Only accept the snapshot if it has meaningful data (non-zero collateral);
      // otherwise fall through to getSubaccounts() which uses its own polling User
      if (snap && (snap.totalCollateral !== 0 || snap.freeCollateral !== 0 || snap.maintenanceRequirement !== 0)) {
        subs = [snap];
      }
    } catch (e: any) { safeLog.warn('drift.getSubaccounts', { error: String(e?.message || e), cat: 'drift' }); }
    if (subs.length === 0) {
      try { subs = await this.getSubaccounts(); } catch (e: any) { safeLog.warn('drift.getSubaccounts.fallback', { error: String(e?.message || e), cat: 'drift' }); subs = []; }
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
    // Helper: register discovered markets in the global mapping cache before returning
    const registerAndReturn = (markets: DriftMarketRef[]): DriftMarketRef[] => {
      try { registerSdkMarkets(markets); } catch (e: any) { safeLog.debug('drift.markets.register', { error: String(e?.message || e), cat: 'drift' }); }
      return markets;
    };
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
      } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
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
      } catch (e: any) { safeLog.warn('drift.sdk.getMarkets', { error: String(e?.message || e), cat: 'drift' }); }
      // Anchor path: client.program?.account?.perpMarket?.all?.()
      if (!accounts) {
        try {
          const maybe = await client?.program?.account?.perpMarket?.all?.();
          if (Array.isArray(maybe)) accounts = maybe.map((x: any) => x?.account || x).filter(Boolean);
        } catch (e: any) { safeLog.debug('drift.op', { error: String(e?.message || e), cat: 'drift' }); }
      }
      // Fallback: probe first 16 indices via getPerpMarketAccount
      if (!accounts) {
        const temp: any[] = [];
        for (let i = 0; i < 16; i += 1) {
          try {
            const a = await client?.getPerpMarketAccount?.(i);
            if (a) temp.push(a);
          } catch (e: any) { safeLog.warn('drift.sdk.getPerpMarket', { error: String(e?.message || e), cat: 'drift' }); }
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
        safeLog.info('drift.markets.discovery.sdk', { count: markets.length, ms: Date.now() - t0, cat: 'drift' });
        return registerAndReturn(markets.sort((a, b) => a.marketIndex - b.marketIndex));
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
          safeLog.info('drift.markets.discovery.constants', { count: out.length, ms: Date.now() - t0, cat: 'drift' });
          return registerAndReturn(out.sort((a, b) => a.marketIndex - b.marketIndex));
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
            safeLog.info('drift.markets.discovery.nameMap', { count: out2.length, ms: Date.now() - t0, cat: 'drift' });
            return registerAndReturn(out2.sort((a, b) => a.marketIndex - b.marketIndex));
          }
        }
      } catch (e: any) { safeLog.debug('drift.sdk.constants', { error: String(e?.message || e), cat: 'drift' }); }
    } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
    // Config-based fallback
    const fromCfg = this.parseAllowlistMarkets();
    safeLog.warn('drift.markets.discovery.fallback', { count: fromCfg.length, cat: 'drift' });
    return registerAndReturn(fromCfg);
  }

  async getSubaccounts(): Promise<SubaccountInfo[]> {
    // Return cached if available and not stale (TTL: 10s)
    const cacheTtlMs = 10_000;
    if (this.subaccountsCache && Array.isArray(this.subaccountsCache.data) && this.subaccountsCache.data.length > 0) {
      const age = Date.now() - (this.subaccountsCache.ts || 0);
      // Don't serve cache that's all zeros (oracle data wasn't loaded when cached)
      const hasNonZero = this.subaccountsCache.data.some(s => s.totalCollateral !== 0 || s.freeCollateral !== 0 || s.maintenanceRequirement !== 0);
      if (age < cacheTtlMs && hasNonZero) {
        return this.subaccountsCache.data;
      }
      // Cache is stale or all-zeros -- refetch
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
      } catch (e: any) { safeLog.warn('drift.getMaxSubAccounts', { error: String(e?.message || e), cat: 'drift' }); for (let i = 0; i < 8; i += 1) ids.push(i); }
      // Load quote precision for scaling UI values
      let QUOTE_PREC = 1_000_000;
      try {
        const sdk: any = await import('@drift-labs/sdk');
        const cst: any = (sdk as any).constants || (sdk as any);
        QUOTE_PREC = Number(cst?.QUOTE_PRECISION ?? 1_000_000);
      } catch (e: any) { safeLog.warn('drift.import.sdk', { error: String(e?.message || e), cat: 'drift' }); }
      const toUi = (val: any): number => Number(val?.toString?.() || val || 0) / QUOTE_PREC;

      // Step 1: Get all public keys in parallel
      const pkPromises = ids.map(async (id) => {
        try {
          const pk = await client.getUserAccountPublicKey?.(Number(id));
          return { id, pk };
        } catch (e: any) { safeLog.debug('drift.getUserAccountPublicKey', { error: String(e?.message || e), cat: 'drift' }); return { id, pk: null }; }
      });
      const pkResults = await Promise.all(pkPromises);
      const validPks = pkResults.filter((r) => r.pk !== null) as Array<{ id: number; pk: any }>;
      if (validPks.length === 0) {
        const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
        out.push({ id, freeCollateral: 0, totalCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] });
        logger.warn('drift.subaccounts.fallback', { id, reason: 'no_pks', cat: 'drift' });
        this.subaccountsCache = { data: out, ts: Date.now() };
        return this.subaccountsCache.data;
      }

      // Step 2: Batch fetch all account infos at once
      const { withRpcLimit } = await import('../utils/rpcLimiter.js');
      const pks = validPks.map((r) => r.pk);
      const infos = await withRpcLimit(
        () => this.getReadConnection().getMultipleAccountsInfo(pks, 'confirmed'),
        Math.max(1, Math.ceil(pks.length / 5)),
        { module: 'drift', method: 'getMultipleAccountsInfo' }
      );

      // Step 3: Filter to accounts that exist on-chain
      const existingAccounts: Array<{ id: number; pk: any }> = [];
      for (let i = 0; i < validPks.length; i++) {
        if (infos[i]) existingAccounts.push(validPks[i]);
      }
      if (existingAccounts.length === 0) {
        const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
        out.push({ id, freeCollateral: 0, totalCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] });
        logger.warn('drift.subaccounts.fallback', { id, reason: 'none_exist', cat: 'drift' });
        this.subaccountsCache = { data: out, ts: Date.now() };
        return this.subaccountsCache.data;
      }

      // Step 4: Create User objects and fetch data in parallel (using polling, not websocket)
      const { User, BulkAccountLoader: BAL } = await loadSdk();
      // Use shared loader if available; otherwise create an ephemeral one-shot loader
      // (this.loader is null when the DriftClient uses websocket subscriptions)
      const accountLoader = this.loader || new BAL(this.connection, 'confirmed', 0);
      const userPromises = existingAccounts.map(async ({ id, pk }) => {
        try {
          // Use polling subscription - faster than websocket, no WS wait needed
          const user = new User({
            driftClient: client,
            userAccountPublicKey: pk,
            accountSubscription: { type: 'polling', accountLoader }
          });
          try {
            if (typeof user.subscribe === 'function') {
              await withRpcLimit(
                () => user.subscribe(),
                1,
                { module: 'drift', method: 'userSubscribe' }
              );
            }
          } catch (e: any) { safeLog.warn('drift.user.subscribe', { error: String(e?.message || e), cat: 'drift' }); }
          const totalCollateral = toUi(user?.getTotalCollateral?.('Maintenance'));
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
          } catch (e: any) { safeLog.debug('drift.sdk.getPositions', { error: String(e?.message || e), cat: 'drift' }); }
          // Unsubscribe after getting data to avoid leaks
          try { await user?.unsubscribe?.(); } catch (e: any) { safeLog.debug('drift.user.unsubscribe', { error: String(e?.message || e), cat: 'drift' }); }
          return { id: Number(id), freeCollateral: free, totalCollateral, maintenanceRequirement: maint, initialRequirement: initReq, effectiveLeverage: lev, positions };
        } catch (e: any) {
          safeLog.warn('drift.subaccount.load', { error: String(e?.message || e), cat: 'drift' });
          return null;
        }
      });
      const results = await Promise.all(userPromises);
      for (const r of results) {
        if (r) out.push(r);
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
    } catch (e: any) {
      safeLog.warn('drift.getSubaccounts', { error: String(e?.message || e), cat: 'drift' });
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
      const id = Number(_id);
      if (Number.isFinite(id)) {
        if (this.activeSubaccountId === id) return true;
        if (Number.isFinite(Number(client?.activeUserId)) && Number(client.activeUserId) === id) {
          this.activeSubaccountId = id;
          return true;
        }
      }
      if (typeof client?.switchActiveUser === 'function') {
        await client.switchActiveUser(Number(_id));
        try { if (typeof client?.addUser === 'function') await client.addUser(Number(_id)); } catch (e: any) { safeLog.warn('drift.addUser', { error: String(e?.message || e), cat: 'drift' }); }
        try { if (typeof client?.initializeUserIfNotExists === 'function') await client.initializeUserIfNotExists(Number(_id)); } catch (e: any) { safeLog.warn('drift.initializeUser', { error: String(e?.message || e), cat: 'drift' }); }
        this.activeSubaccountId = Number(_id);
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
        const balLamports = await withRpcLimit(
          () => this.connection!.getBalance(this.walletKp!.publicKey, 'confirmed'),
          1,
          { module: 'drift', method: 'getBalance' }
        );
        const minLamports = 0.01 * 1_000_000_000; // ~0.01 SOL
        if (balLamports < minLamports) {
          lastReason = `INSUFFICIENT_SOL balance=${(balLamports/1_000_000_000).toFixed(6)} required>=0.01`;
          logger.error('drift.subaccount.create_failed', { error: lastReason, cat: 'drift' });
          return null;
        }
      } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
      // Discover existing subaccount ids and compute next unused id
      let maxCap = 8;
      try { const { getMaxNumberOfSubAccounts } = await loadSdk(); const m = await getMaxNumberOfSubAccounts?.(); if (Number.isFinite(Number(m))) maxCap = Math.min(Math.max(Number(m), 1), 16); } catch (e: any) { safeLog.warn('drift.sdk.getMaxSubAccounts', { error: String(e?.message || e), cat: 'drift' }); }
      const existing = new Set<number>();
      try {
        for (let cid = 0; cid < maxCap; cid += 1) {
          try {
            const pk = await client.getUserAccountPublicKey?.(Number(cid));
            if (pk) { const acc = await (await import('../utils/rpcLimiter.js')).withRpcLimit(() => this.connection!.getAccountInfo(pk, 'confirmed'), 1, { module: 'drift', method: 'getAccountInfo' }); if (acc) existing.add(Number(cid)); }
          } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
        }
      } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
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
          try { if (typeof client?.addUser === 'function') { await withBackoff(async () => client.addUser(candidate)); } } catch (e: any) { safeLog.warn('drift.addUser', { error: String(e?.message || e), cat: 'drift' }); }
          try { if (typeof client?.switchActiveUser === 'function') { await withBackoff(async () => client.switchActiveUser(candidate)); } } catch (e: any) { safeLog.warn('drift.switchActiveUser', { error: String(e?.message || e), cat: 'drift' }); }
          try { await this.ensureUserReady(candidate); } catch (e: any) { safeLog.warn('drift.ensureUserReady', { error: String(e?.message || e), cat: 'drift' }); }
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
      } catch (e: any) { safeLog.warn('drift.getMaxSubAccounts.candidates', { error: String(e?.message || e), cat: 'drift' }); for (let i = 0; i < 8; i += 1) candidateIds.push(i); }
      // Dedup and try in order; skip ids that already have a user account
      const seenIds = new Set<number>();
      const existing2 = new Set<number>();
      try {
        for (const cid of candidateIds) {
          try { const pk = await client.getUserAccountPublicKey?.(Number(cid)); if (pk) { const acc = await (await import('../utils/rpcLimiter.js')).withRpcLimit(() => this.getReadConnection().getAccountInfo(pk, 'confirmed'), 1, { module: 'drift', method: 'getAccountInfo' }); if (acc) existing2.add(Number(cid)); } } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
        }
      } catch (e: any) { safeLog.warn('drift.import.rpcLimiter', { error: String(e?.message || e), cat: 'drift' }); }
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
          try { if (typeof client?.addUser === 'function') { await withBackoff(async () => client.addUser(Number(id))); } } catch (e: any) { safeLog.warn('drift.addUser', { error: String(e?.message || e), cat: 'drift' }); }
          try { if (typeof client?.switchActiveUser === 'function') { await withBackoff(async () => client.switchActiveUser(Number(id))); } } catch (e: any) { safeLog.warn('drift.switchActiveUser', { error: String(e?.message || e), cat: 'drift' }); }
          try { await this.ensureUserReady(Number(id)); } catch (e: any) { safeLog.warn('drift.ensureUserReady', { error: String(e?.message || e), cat: 'drift' }); }
          logger.info('drift.subaccount.created', { id: Number(id), cat: 'drift' });
          this.invalidateSubaccountsCache();
          return { id: Number(id) };
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          logger.warn('drift.subaccount.create_attempt_failed', { id: Number(id), error: msg, cat: 'drift' });
          if (/exist|initialized|already/i.test(msg)) {
            // If it already exists, treat as success by switching to it
            try { await this.ensureUserReady(Number(id)); } catch (e: any) { safeLog.warn('drift.ensureUserReady', { error: String(e?.message || e), cat: 'drift' }); }
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


