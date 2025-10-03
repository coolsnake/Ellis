// @ts-nocheck
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { ensureWallet } from '../wallet/wallet.js';
import type { DriftStatus, SubaccountInfo, DriftMarketRef, DriftCluster } from './types.js';
import { logger } from '../utils/logger.js';

// Lazy import SDK to keep startup fast and optional
type DriftEnv = {
  DriftClient: any;
  initialize: (args: { connection: Connection; wallet: any; opts?: any }) => Promise<any>;
};

let driftEnv: DriftEnv | null = null;

async function loadSdk(): Promise<DriftEnv> {
  if (driftEnv) return driftEnv;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = await import('@drift-labs/sdk');
  driftEnv = {
    DriftClient: (sdk as any).DriftClient,
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

  static getInstance(): DriftService {
    if (!this.instance) this.instance = new DriftService();
    return this.instance;
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
    logger.info('drift.sdk.init', { rpcUrl: CONFIG.rpcUrl, cluster: this.cluster, cat: 'drift' });
    const { initialize } = await loadSdk();
    // Provide a signing wallet compatible with Anchor/Drift
    const wallet = {
      publicKey: this.walletKp.publicKey,
      signTransaction: async (tx: any) => { try { if (typeof tx.partialSign === 'function') tx.partialSign(this.walletKp); else tx.sign(this.walletKp); } catch {} return tx; },
      signAllTransactions: async (txs: any[]) => { try { for (const tx of txs) { if (typeof tx.partialSign === 'function') tx.partialSign(this.walletKp); else tx.sign(this.walletKp); } } catch {} return txs; }
    };
    // Provide env so SDK can derive markets/oracles automatically
    this.client = await initialize({ connection: this.connection, wallet, opts: { env: this.cluster } });
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
    logger.info('drift.sdk.ready', { pubkey: this.walletKp.publicKey?.toBase58?.(), cat: 'drift' });
  }

  private async ensureUserReady(subaccountId: number): Promise<void> {
    await this.init();
    const client: any = this.client;
    try { if (typeof client?.addUser === 'function') { await client.addUser(Number(subaccountId)); } } catch {}
    try { if (typeof client?.switchActiveUser === 'function') { await client.switchActiveUser(Number(subaccountId)); } } catch {}
    try {
      if (typeof client?.initializeUserIfNotExists === 'function') {
        await client.initializeUserIfNotExists(Number(subaccountId));
      } else if (typeof client?.initializeUser === 'function') {
        try { await client.initializeUser(Number(subaccountId)); } catch { try { await client.initializeUser(); } catch {} }
      }
    } catch {}
  }

  async getStatus(): Promise<DriftStatus> {
    await this.init();
    const markets: DriftMarketRef[] = await this.discoverMarkets();
    const subs = await this.getSubaccounts();
    logger.debug('drift.status', { markets: markets.length, subaccounts: subs.length, cat: 'drift' });
    return {
      cluster: this.cluster,
      programId: (CONFIG as any).drift?.programId,
      subaccounts: subs,
      markets,
    };
  }

  private parseAllowlistMarkets(): DriftMarketRef[] {
    try {
      const raw: string[] = (((CONFIG as any).drift?.marketsAllowlist || []) as string[]);
      const out: DriftMarketRef[] = [];
      for (const entry of raw) {
        const s = String(entry || '').trim();
        if (!s) continue;
        // Support formats: "0:SOL-PERP", "1=BTC-PERP", "2", "ETH-PERP"
        let marketIndex: number | null = null;
        let symbol: string | undefined = undefined;
        if (/^\d+\s*[:=]\s*[^:]+$/.test(s)) {
          const parts = s.split(/[:=]/);
          marketIndex = Number(parts[0].trim());
          symbol = String(parts[1]).trim();
        } else if (/^\d+$/.test(s)) {
          marketIndex = Number(s);
        } else {
          // Symbol only; keep without index
          symbol = s;
        }
        if (Number.isFinite(marketIndex as number)) out.push({ marketIndex: Number(marketIndex), symbol });
      }
      // Deduplicate by marketIndex
      const seen = new Set<number>();
      return out.filter(m => {
        if (seen.has(m.marketIndex)) return false;
        seen.add(m.marketIndex);
        return true;
      }).sort((a, b) => a.marketIndex - b.marketIndex);
    } catch {
      return [];
    }
  }

  private async discoverMarkets(): Promise<DriftMarketRef[]> {
    await this.init();
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
          if (out2.length > 0) return out2.sort((a, b) => a.marketIndex - b.marketIndex);
        }
      } catch {}
    } catch {}
    // Config-based fallback
    const fromCfg = this.parseAllowlistMarkets();
    return fromCfg;
  }

  async getSubaccounts(): Promise<SubaccountInfo[]> {
    await this.init();
    try {
      // Best-effort SDK calls (to be refined with exact SDK APIs)
      const sdk: any = await import('@drift-labs/sdk');
      const user = this.client?.user || null;
      const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
      const totalCollateral = Number(user?.getTotalCollateral?.() || 0);
      const maint = Number(user?.getMaintenanceMarginRequirement?.() || 0);
      const initReq = Number(user?.getInitialMarginRequirement?.() || 0);
      const free = Number(user?.getFreeCollateral?.() || 0);
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
      const out = [{ id, freeCollateral: free, totalCollateral, maintenanceRequirement: maint, initialRequirement: initReq, effectiveLeverage: lev, positions }];
      logger.debug('drift.subaccounts', { count: out.length, id, freeCollateral: free, effectiveLeverage: lev, cat: 'drift' });
      return out;
    } catch {
      // Fallback scaffold when SDK calls are unavailable
      const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
      const out = [{ id, freeCollateral: 0, totalCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] }];
      logger.warn('drift.subaccounts.fallback', { id, cat: 'drift' });
      return out;
    }
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
    try {
      const client: any = this.client;
      // Try add subaccount via SDK if available
      if (typeof client?.addSubAccount === 'function') {
        const res = await client.addSubAccount();
        const fallbackId = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
        const id = Number((res?.subAccountId ?? res?.id) ?? fallbackId);
        try { await this.ensureUserReady(id); } catch {}
        logger.info('drift.subaccount.created', { id, cat: 'drift' });
        return { id };
      }
      // Fallback: attempt creating at a candidate id range without relying on userStats
      if (typeof client?.initializeUserAccount === 'function') {
        const tryIds: number[] = [];
        try {
          if (typeof client?.getNextSubAccountId === 'function') {
            const next = await client.getNextSubAccountId();
            const n = Number(next);
            if (Number.isFinite(n)) tryIds.push(n);
          }
        } catch {}
        // Probe a small range as a safety net
        for (let i = 0; i < 8; i += 1) tryIds.push(i);
        // Deduplicate while preserving order
        const seen = new Set<number>();
        for (const id of tryIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          try {
            await client.initializeUserAccount(id, name || undefined);
            try { await this.ensureUserReady(id); } catch {}
            logger.info('drift.subaccount.created', { id, cat: 'drift' });
            return { id };
          } catch (e: any) {
            const msg = String(e?.message || e || '');
            // Skip if already exists; continue to next id
            if (/exist|initialized|already/i.test(msg)) continue;
            // Other errors: try next id as well
            continue;
          }
        }
      }
    } catch (e: any) {
      logger.error('drift.subaccount.create_failed', { error: String(e?.message || e), cat: 'drift' });
      return null;
    }
    // Fallback: return default id without on-chain action (scaffold)
    const id = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
    logger.warn('drift.subaccount.create_fallback', { id, cat: 'drift' });
    return { id };
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
        const toNative = typeof client?.convertToSpotPrecision === 'function'
          ? await client.convertToSpotPrecision(spotMarketIndex, Number(amount))
          : null;
        const nativeAmount = toNative ?? Number(Math.round(Number(amount) * 1_000_000));
        let ata: any = undefined;
        if (typeof client?.getAssociatedTokenAccount === 'function') {
          try { ata = await client.getAssociatedTokenAccount(spotMarketIndex); } catch {}
        }
        if (ata === undefined) {
          try {
            // Derive or create user token account when SDK helper is unavailable
            const sdk: any = await import('@drift-labs/sdk');
            const constants: any = (sdk as any).constants || (sdk as any);
            const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
            const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
            const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
            const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === Number(spotMarketIndex)) : null;
            const mintStr = String(found?.mint || found?.mintAddress || found?.address || '');
            if (mintStr) {
              const { getOrCreateTokenAccount } = await import('../wallet/wallet.js');
              const mintPk = new PublicKey(mintStr);
              const ataRes = await getOrCreateTokenAccount(mintPk, this.walletKp!.publicKey, this.walletKp!);
              ata = ataRes.address;
            } else {
              ata = this.walletKp!.publicKey;
            }
          } catch {
            ata = this.walletKp!.publicKey;
          }
        }
        // Prefer full signature (amount, spotIndex, ata, subId)
        const res = await client.deposit(nativeAmount, spotMarketIndex, ata, Number(subaccountId));
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
        const toNative = typeof client?.convertToSpotPrecision === 'function'
          ? await client.convertToSpotPrecision(spotMarketIndex, Number(amount))
          : null;
        const nativeAmount = toNative ?? Number(Math.round(Number(amount) * 1_000_000));
        let ata: any = undefined;
        if (typeof client?.getAssociatedTokenAccount === 'function') {
          try { ata = await client.getAssociatedTokenAccount(spotMarketIndex); } catch {}
        }
        if (ata === undefined) {
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const constants: any = (sdk as any).constants || (sdk as any);
            const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
            const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
            const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
            const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === Number(spotMarketIndex)) : null;
            const mintStr = String(found?.mint || found?.mintAddress || found?.address || '');
            if (mintStr) {
              const { getOrCreateTokenAccount } = await import('../wallet/wallet.js');
              const mintPk = new PublicKey(mintStr);
              const ataRes = await getOrCreateTokenAccount(mintPk, this.walletKp!.publicKey, this.walletKp!);
              ata = ataRes.address;
            } else {
              ata = this.walletKp!.publicKey;
            }
          } catch {
            ata = this.walletKp!.publicKey;
          }
        }
        const res = await client.withdraw(nativeAmount, spotMarketIndex, ata, Number(subaccountId));
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


