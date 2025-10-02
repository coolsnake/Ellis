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
    initialize: async ({ connection, wallet, opts }: any) => new (sdk as any).DriftClient({ connection, wallet, opts })
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

  async init(): Promise<void> {
    if (this.client) return;
    this.walletKp = await ensureWallet(CONFIG.walletPath);
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    logger.info('drift.sdk.init', { rpcUrl: CONFIG.rpcUrl, cluster: this.cluster, cat: 'drift' });
    const { initialize } = await loadSdk();
    // Minimal client; real opts can include program ID, env, etc.
    this.client = await initialize({ connection: this.connection, wallet: { publicKey: this.walletKp.publicKey } });
    logger.info('drift.sdk.ready', { pubkey: this.walletKp.publicKey?.toBase58?.(), cat: 'drift' });
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
        const name = String(a?.name || a?.symbol || '').trim() || undefined;
        return { marketIndex: idx, symbol: name };
      }).filter(m => Number.isFinite(m.marketIndex)) : [];
      // If empty, fallback to allowlist
      if (markets.length > 0) {
        return markets.sort((a, b) => a.marketIndex - b.marketIndex);
      }
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
    // Implement via SDK when wiring; OK to no-op for scaffold
    logger.info('drift.subaccount.switch', { id: _id, cat: 'drift' });
    return true;
  }

  async createSubaccount(): Promise<{ id: number } | null> {
    await this.init();
    try {
      const client: any = this.client;
      // Try add subaccount via SDK if available
      if (typeof client?.addSubAccount === 'function') {
        const res = await client.addSubAccount();
        const fallbackId = Number((CONFIG as any).drift?.defaultSubaccountId || 0);
        const id = Number((res?.subAccountId ?? res?.id) ?? fallbackId);
        logger.info('drift.subaccount.created', { id, cat: 'drift' });
        return { id };
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
      const sdk: any = await import('@drift-labs/sdk');
      const BN = (sdk as any).BN || (sdk as any).anchor?.BN || (sdk as any).web3?.BN;
      if (typeof client?.deposit === 'function' && BN) {
        // Assume USDC decimals 6 for UI amount -> native
        const native = new BN(Math.round(Number(amount) * 1_000_000));
        const res = await client.deposit(native, spotMarketIndex, subaccountId);
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
      const sdk: any = await import('@drift-labs/sdk');
      const BN = (sdk as any).BN || (sdk as any).anchor?.BN || (sdk as any).web3?.BN;
      if (typeof client?.withdraw === 'function' && BN) {
        const native = new BN(Math.round(Number(amount) * 1_000_000));
        const res = await client.withdraw(native, spotMarketIndex, subaccountId);
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
}


