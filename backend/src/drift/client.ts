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
    // For initial scaffolding, return placeholder markets and subaccounts derived from SDK when possible
    const markets: DriftMarketRef[] = (((CONFIG as any).drift?.marketsAllowlist || []) as string[]).map((s, i) => ({ marketIndex: i, symbol: s }));
    const subs = await this.getSubaccounts();
    logger.debug('drift.status', { markets: markets.length, subaccounts: subs.length, cat: 'drift' });
    return {
      cluster: this.cluster,
      programId: (CONFIG as any).drift?.programId,
      subaccounts: subs,
      markets,
    };
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
}


