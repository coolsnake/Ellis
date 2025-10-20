// @ts-nocheck
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
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
const COOLDOWN_MS = 1_000;

export class DriftFillerRunner {
  private timer: any | null = null;
  private config: FillerConfig;
  private state: FillerRuntimeState;
  private abort = false;
  private inLoop: boolean = false;

  private sdk: any | null = null;
  private client: any | null = null;
  private connection: any | null = null;

  slotSubscriber: any | null = null;
  eventSubscriber: any | null = null;
  userMap: any | null = null;
  dlobSubscriber: any | null = null;

  private nodesCooldown: Map<string, number> = new Map();
  private fillsInWindow: number[] = [];

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
      loopIntervalMs: Math.max(500, Number(cfg?.intervalMs ?? 1200)),
      fillsLastMin: 0,
      marketsAllowlist: allowlist,
    };
  }

  getStatus(): FillerRuntimeState {
    const cutoff = Date.now() - 60_000;
    this.fillsInWindow = this.fillsInWindow.filter((t) => t >= cutoff);
    return { ...this.state, fillsLastMin: this.fillsInWindow.length };
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

    try { await DriftService.getInstance().init(); } catch {}
    const svc: any = DriftService.getInstance();
    this.connection = (svc as any).connection;
    this.client = (svc as any).client;
    if (!this.client || !this.connection) {
      this.state.lastError = 'CLIENT_OR_CONNECTION_UNAVAILABLE';
      logger.info('drift.filler.error client_or_connection_unavailable', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
      throw new Error('Drift client or connection unavailable');
    }

    try {
      if (Number.isFinite(this.state.subaccountId)) {
        await (svc as any).switchSubaccount?.(Number(this.state.subaccountId));
        logger.info('drift.filler.subaccount_selected', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, subaccountId: this.state.subaccountId });
      }
    } catch (e: any) {
      logger.info('drift.filler.warn subaccount_switch_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, err: String(e?.message || e) });
    }

    this.sdk = await import('@drift-labs/sdk');
    await this.initDiscovery();

    const tick = async () => {
      if (this.abort || this.inLoop) return;
      this.inLoop = true;
      try { await this.loop(); }
      finally { this.inLoop = false; }
    };
    this.timer = setInterval(() => { tick().catch(() => {}); }, this.state.loopIntervalMs);

    logger.info('drift.filler.started', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, loopMs: this.state.loopIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    this.state.running = false;
    this.abort = true;
    logger.info('drift.filler.stopped', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name });
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(400, this.state.loopIntervalMs - 300) });
    this.slotSubscriber = (infra as any).slotSubscriber;
    this.eventSubscriber = (infra as any).eventSubscriber;
    this.userMap = (infra as any).userMap;
    this.dlobSubscriber = (infra as any).dlobSubscriber;
    logger.info('drift.filler.usermap_dlob_ready', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, shared: true });
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
      const taker = await this.userMap.mustGet(takerPkStr);
      if (!taker) return false;

      const makersRaw: string[] = Array.isArray(nodeToFill?.makerNodes)
        ? nodeToFill.makerNodes.map((mn: any) => String(mn?.userAccount || '')).filter(Boolean)
        : [];
      const maxMakers = Math.max(0, Number(this.config.maxMakersPerFill ?? 2));
      const makers = makersRaw.slice(0, maxMakers);

      const makerInfos: any[] = [];
      for (const m of makers) {
        try {
          const makerUser = await this.userMap.mustGet(m);
          if (!makerUser) continue;
          const makerUa = makerUser.getUserAccount?.();
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

      const { getUserAccountPublicKey } = this.sdk;
      const takerUa = taker.getUserAccount?.();
      const takerUserPk = await getUserAccountPublicKey(this.client.program.programId, takerUa.authority, takerUa.subAccountId);
      const cuLimit = Math.max(200_000, Number(this.config.cuLimit ?? 1_000_000));
      const priority = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
        await this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, makerInfos),
        await this.client.getRevertFillIx(),
      ];

      if (this.state.dryRun) {
        logger.info('drift.filler.dry_run', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), marketIndex });
        return false;
      }

      const tx = new Transaction();
      tx.add(...ixs);
      tx.feePayer = this.client.wallet.publicKey;
      const { blockhash } = await this.connection.getLatestBlockhash({ commitment: 'confirmed' });
      tx.recentBlockhash = blockhash;
      try {
        tx.sign(this.client.wallet.payer);
        const sigTx = await DriftService.getInstance().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
        this.fillsInWindow.push(Date.now());
        logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
        return true;
      } catch (e: any) {
        logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: String(e?.message || e) });
        return false;
      }
    } catch (e: any) {
      logger.info('drift.filler.warn fill_node_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, err: String(e?.message || e) });
      return false;
    }
  }

  private async loop(): Promise<void> {
    if (this.abort) return;
    const t0 = Date.now();
    this.state.lastRunAt = t0;

    try {
      const dlob = this.dlobSubscriber?.getDLOB?.();
      if (!dlob) {
        logger.info('drift.filler.warn dlob_unavailable', { cat: FILLER_CAT, subcat: FILLER_SUBCAT });
        return;
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
        logger.info('drift.filler.loop_begin', {
          cat: FILLER_CAT,
          subcat: FILLER_SUBCAT,
          slot,
          perpsCount: Array.isArray(perps) ? perps.length : 0,
          allowlistSize: Array.isArray(this.state.marketsAllowlist) ? this.state.marketsAllowlist.length : 0,
        });
      } catch {}

      let totalPlanned = 0;
      let sent = 0;
      const sample: Array<{ m: number; taker: string; id: string; makers: number }> = [];

      for (const market of (Array.isArray(perps) ? perps : [])) {
        const mStart = Date.now();
        const idx = Number(market?.marketIndex || 0);
        if (!this.inAllowlist(idx)) continue;
        const slotBn = new BN(slot);
        const mmOraclePriceData = this.client.getMMOracleDataForPerpMarket?.(idx);
        const vAsk = calculateAskPrice(market, mmOraclePriceData, slotBn);
        const vBid = calculateBidPrice(market, mmOraclePriceData, slotBn);

        try {
          logger.info('drift.filler.market_scan', {
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

        totalPlanned += nodesToFill.length;

        try {
          logger.info('drift.filler.market_nodes', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            nodes: nodesToFill.length,
          });
        } catch {}

        for (const node of nodesToFill) {
          try {
            if (!node?.node?.order) continue;
            if (typeof node?.node?.isVammNode === 'function' && node.node.isVammNode()) {
              try {
                logger.info('drift.filler.skip_vamm_node', {
                  cat: FILLER_CAT,
                  subcat: FILLER_SUBCAT,
                  marketIndex: idx,
                  taker: String(node?.node?.userAccount || ''),
                  orderId: String(node?.node?.order?.orderId || ''),
                });
              } catch {}
              continue;
            }

            // Identify order type and trigger condition; skip trigger orders until triggered
            const o = node?.node?.order;
            let orderTypeStr: string | undefined = undefined;
            let triggerCondStr: string | undefined = undefined;
            try { orderTypeStr = o?.orderType ? String(getVariant(o.orderType)) : undefined; } catch {}
            try { triggerCondStr = o?.triggerCondition ? String(getVariant(o.triggerCondition)) : undefined; } catch {}
            if ((orderTypeStr && orderTypeStr.toLowerCase().includes('trigger')) || triggerCondStr) {
              try {
                logger.info('drift.filler.skip_trigger_order', {
                  cat: FILLER_CAT,
                  subcat: FILLER_SUBCAT,
                  marketIndex: idx,
                  taker: String(node?.node?.userAccount || ''),
                  orderId: String(node?.node?.order?.orderId || ''),
                  orderType: orderTypeStr,
                  triggerCondition: triggerCondStr,
                });
              } catch {}
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
                cuLimit: Math.max(200_000, Number(this.config.cuLimit ?? 1_000_000)),
                priority: Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0)),
                dryRun: !!this.state.dryRun,
              });
            } catch {}

            const ok = await this.tryFillNode(idx, node);
            if (ok) sent += 1;
          } catch {}
        }

        try {
          logger.info('drift.filler.market_done', {
            cat: FILLER_CAT,
            subcat: FILLER_SUBCAT,
            marketIndex: idx,
            ms: Date.now() - mStart,
          });
        } catch {}
      }

      const dur = Date.now() - t0;
      logger.info('drift.filler.loop', {
        cat: FILLER_CAT, subcat: FILLER_SUBCAT,
        ms: dur, totalNodesPlanned: totalPlanned, sent, fillsLastMin: this.getStatus().fillsLastMin, sample,
      });
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


