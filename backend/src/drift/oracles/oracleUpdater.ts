// @ts-nocheck
import { HermesClient } from '@pythnetwork/hermes-client';
import { CONFIG } from '../../utils/config.js';

type UpdatePolicy = 'stale' | 'always' | 'off';

export class OracleUpdater {
  private sdk: any;
  private driftClient: any;
  private cluster: string;
  private priceService?: HermesClient;
  private marketIndexToFeedId: Map<number, string> = new Map();
  private policy: UpdatePolicy;
  private timeoutMs: number;

  constructor(params: { sdk: any; driftClient: any; cluster: string }) {
    this.sdk = params.sdk;
    this.driftClient = params.driftClient;
    this.cluster = params.cluster || (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
    this.policy = ((CONFIG as any)?.pyth?.updatePolicy || 'off') as UpdatePolicy;
    this.timeoutMs = Math.max(200, Number(((CONFIG as any)?.pyth?.updateTimeoutMs) ?? 300));
    this.initializeClients();
    this.buildPerpFeedMap();
  }

  private initializeClients(): void {
    try {
      const hermes = (CONFIG as any)?.pyth?.hermesEndpoint;
      if (hermes) {
        this.priceService = new HermesClient(String(hermes), { timeout: this.timeoutMs });
      }
    } catch {}
  }

  private buildPerpFeedMap(): void {
    try {
      const c = (this.cluster || '').toLowerCase();
      const constants: any = this.sdk || {};
      // Prefer modern constants naming
      const main = (constants as any).MainnetPerpMarkets;
      const dev = (constants as any).DevnetPerpMarkets;
      const list: any[] = Array.isArray(main) && c.includes('mainnet') ? main : (Array.isArray(dev) ? dev : []);
      const getVariant = (constants as any).getVariant || ((x: any) => String(x));
      for (const m of list) {
        try {
          const idx = Number(m?.marketIndex ?? m?.market_index ?? m?.idx);
          if (!Number.isFinite(idx)) continue;
          const src = String(getVariant(m?.oracleSource || m?.oracle_source || '')).toLowerCase();
          const feedId: string | undefined = (m as any)?.pythFeedId || (m as any)?.pyth_feed_id;
          if (src.includes('pull') && typeof feedId === 'string' && feedId.length > 0) {
            this.marketIndexToFeedId.set(idx, feedId);
          }
        } catch {}
      }
    } catch {}
  }

  // Returns TransactionInstruction[] to prepend before a fill, or []
  async getOracleUpdateIxsForPerp(params: { marketIndex: number; currentSlot: number; oracleSlot: number | null | undefined }): Promise<any[]> {
    try {
      if (this.policy === 'off') return [];
      const feedId = this.marketIndexToFeedId.get(Number(params.marketIndex));
      if (!feedId || !this.priceService) return [];
      if (this.policy === 'stale') {
        const od = Number(params.oracleSlot ?? 0);
        const cur = Number(params.currentSlot ?? 0);
        // Only update when not already from the current slot
        if (od > 0 && cur > 0 && od >= cur) return [];
      }
      const vaas = await this.priceService.getLatestVaas([feedId]);
      if (!Array.isArray(vaas) || !vaas[0]) return [];
      const ixs = await this.driftClient.getPostPythPullOracleUpdateAtomicIxs(vaas[0], feedId);
      return Array.isArray(ixs) ? ixs : [];
    } catch {
      return [];
    }
  }
}


