// NOTE: type coverage tightened for key SDK surfaces only; keeping any for dynamic SDK
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
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
  // Warm user prefetch infra
  private warmUsers: Map<string, { user: any; ts: number }> = new Map();
  private prefetchRunning = false;
  private prefetchTimer: any | null = null;
  private prefetchQueue: string[] = [];
  private pollLoaderWarm: any | null = null;

  static getInstance(): DriftService {
    if (!this.instance) this.instance = new DriftService();
    return this.instance;
  }
  getReadConnection(): Connection {
    if (!this.readConnection) {
      const url: string = String(((CONFIG as any)?.readRpcUrl) || (CONFIG as any)?.rpcUrl);
      // Wrap underlying fetch to honor rate limiter for high-throughput calls
      this.readConnection = new Connection(url, 'processed');
    }
    return this.readConnection;
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
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
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
    try { this.loader = subType === 'polling' ? new BulkAccountLoader(this.connection, 'confirmed', 1000) : null; } catch { this.loader = null; }
    const programIdOpt = (CONFIG as any).drift?.programId ? { programID: new PublicKey((CONFIG as any).drift.programId) } : {};
    const marketOpts = typeof getMarketsAndOraclesForSubscription === 'function' ? (getMarketsAndOraclesForSubscription as any)(this.cluster) : {};
    this.client = await initialize({ connection: this.connection, wallet, opts: { env: this.cluster, accountSubscription: subscription, ...programIdOpt, ...marketOpts } });
    // Subscribe to populate internal caches for markets/users/oracles
    try { if (typeof (this.client as any)?.subscribe === 'function') { await (this.client as any).subscribe(); } } catch {}
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

    if (!this.sharedSlotSubscriber && sdk?.SlotSubscriber) {
      try {
        this.sharedSlotSubscriber = new (sdk as any).SlotSubscriber(connection);
        await this.sharedSlotSubscriber.subscribe();
      } catch {}
    }

    if (!this.sharedEventSubscriber && sdk?.EventSubscriber) {
      try {
        this.sharedEventSubscriber = new (sdk as any).EventSubscriber(connection, program);
        await this.sharedEventSubscriber.subscribe();
      } catch {}
    }

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
      try { await this.sharedUserMap?.subscribe?.(); } catch {}
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
        try { await this.sharedOrderSubscriber?.subscribe?.(); } catch {}
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
        await this.sharedDlobSubscriber.subscribe();
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

  // Warm user cache helpers
  getWarmUser(pubkey: string): any | null {
    const w = this.warmUsers.get(pubkey);
    return w?.user || null;
  }
  enqueueUsersForPrefetch(pks: string[]): void {
    for (const pk of pks) {
      if (!pk) continue;
      if (!this.warmUsers.has(pk)) this.prefetchQueue.push(pk);
    }
  }
  async startUserPrefetcher(dlobSubscriber: any, userMap: any): Promise<void> {
    await this.init();
    if (this.prefetchRunning) return;
    this.prefetchRunning = true;
    // Prepare polling loader for stability
    try {
      const { BulkAccountLoader } = await loadSdk();
      if (!this.pollLoaderWarm) this.pollLoaderWarm = new BulkAccountLoader(this.connection!, 'confirmed', 1000);
    } catch {}

    const collectFromDlob = () => {
      try {
        const dlob = dlobSubscriber?.getDLOB?.();
        if (!dlob) return;
        const found: Set<string> = new Set();
        // Heuristic: scan a small set of common markets; adjust as needed or wire allowlist
        const indices = [0, 1, 2, 31, 45];
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
        this.enqueueUsersForPrefetch(Array.from(found));
      } catch {}
    };

    const step = async () => {
      try {
        collectFromDlob();
        const batch = this.prefetchQueue.splice(0, 200);
        const groups: string[][] = [];
        const conc = 8;
        for (let i = 0; i < batch.length; i += conc) groups.push(batch.slice(i, i + conc));
        for (const grp of groups) {
          await Promise.all(grp.map(async (pk) => {
            try {
              try { await userMap.mustGet(pk); } catch {}
              if (!this.warmUsers.has(pk)) {
                let sdk: any = null;
                try { sdk = await import('@drift-labs/sdk'); } catch {}
                const { PublicKey } = await import('@solana/web3.js');
                const u = new (sdk as any).User({
                  driftClient: this.client,
                  userAccountPublicKey: new PublicKey(pk),
                  accountSubscription: this.pollLoaderWarm ? { type: 'polling', accountLoader: this.pollLoaderWarm } : { type: 'websocket' },
                });
                try { await u.subscribe?.(); } catch {}
                // Bound LRU
                if (this.warmUsers.size >= 5000) {
                  const oldest = [...this.warmUsers.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
                  if (oldest) { try { await this.warmUsers.get(oldest)?.user?.unsubscribe?.(); } catch {} this.warmUsers.delete(oldest); }
                }
                this.warmUsers.set(pk, { user: u, ts: Date.now() });
              }
            } catch {}
          }));
        }
      } catch {}
    };

    if (this.prefetchTimer) { try { clearInterval(this.prefetchTimer); } catch {} }
    this.prefetchTimer = setInterval(() => { step().catch(() => {}); }, 400);
  }

  async sendRawTransaction(raw: Buffer | Uint8Array, opts?: any): Promise<string> {
    await this.init();
    const doSend = async (): Promise<string> => {
      const now = Date.now();
      const wait = Math.max(0, this.lastTxAtMs + this.minTxGapMs - now);
      if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
      const sig = await this.connection!.sendRawTransaction(raw as any, opts || { skipPreflight: false, preflightCommitment: 'confirmed' });
      this.lastTxAtMs = Date.now();
      return sig;
    };
    if (this.txQueueInFlight >= this.maxTxInFlight) {
      await new Promise<void>((resolve) => this.txQueue.push(resolve));
    }
    this.txQueueInFlight += 1;
    try {
      return await doSend();
    } finally {
      this.txQueueInFlight -= 1;
      const next = this.txQueue.shift();
      if (next) next();
    }
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
            try { if (typeof (user as any).subscribe === 'function') { await (user as any).subscribe(); } } catch {}
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


