import { PublicKey, ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';

export type TriggerConfig = {
  name: string;
  enabled: boolean;
  dryRun?: boolean;
  subaccountId?: number;
  intervalMs?: number; // default 800 tailored
  cuLimit?: number; // default 220_000 tailored
  priorityFeeMicroLamports?: number; // default 0 (provider strategy may boost)
  marketsAllowlist?: Array<number> | string[]; // market indices allowlist
};

type TriggerRuntimeState = {
  running: boolean;
  name: string;
  dryRun: boolean;
  subaccountId: number;
  loopIntervalMs: number;
  lastRunAt?: number;
  lastError?: string;
  triggersLastMin: number;
  marketsAllowlist?: number[];
};

const COOLDOWN_MS = 10_000; // avoid re-trigger spam per node signature
const TRIGGER_CAT = 'drift';
const TRIGGER_SUBCAT = 'trigger';

export class DriftTriggerRunner {
  private timer: any | null = null;
  private config: TriggerConfig;
  private state: TriggerRuntimeState;
  private abort = false;

  private sdk: any | null = null;
  private client: any | null = null;
  private connection: any | null = null;

  private slotSubscriber: any | null = null;
  private eventSubscriber: any | null = null;
  private userMap: any | null = null;
  private dlobSubscriber: any | null = null;

  private nodesCooldown: Map<string, number> = new Map();
  private triggersInWindow: number[] = [];

  constructor(cfg: TriggerConfig) {
    const allowlist = Array.isArray(cfg?.marketsAllowlist)
      ? (cfg!.marketsAllowlist as any[])
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n))
      : undefined;
    this.config = { ...cfg, marketsAllowlist: allowlist } as TriggerConfig;
    this.state = {
      running: false,
      name: String(cfg?.name || 'default'),
      dryRun: !!cfg?.dryRun,
      subaccountId: Number.isFinite(Number(cfg?.subaccountId)) ? Number(cfg?.subaccountId) : (0 as number),
      loopIntervalMs: Math.max(300, Number(cfg?.intervalMs ?? 800)),
      triggersLastMin: 0,
      marketsAllowlist: allowlist,
    };
  }

  getStatus(): TriggerRuntimeState {
    const cutoff = Date.now() - 60_000;
    this.triggersInWindow = this.triggersInWindow.filter((t) => t >= cutoff);
    return { ...this.state, triggersLastMin: this.triggersInWindow.length };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.abort = false;
    this.state.running = true;

    logger.info('drift.trigger.start', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, dryRun: this.state.dryRun, loopMs: this.state.loopIntervalMs, allowlist: this.state.marketsAllowlist });

    try {
      await DriftService.getInstance().init();
    } catch {}
    const svc: any = DriftService.getInstance();
    this.connection = (svc as any).connection;
    this.client = (svc as any).client;

    if (!this.client || !this.connection) {
      this.state.lastError = 'CLIENT_OR_CONNECTION_UNAVAILABLE';
      logger.info('drift.trigger.error client_or_connection_unavailable', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
      throw new Error('Drift client or connection unavailable');
    }

    try {
      if (Number.isFinite(this.state.subaccountId)) {
        await (svc as any).switchSubaccount?.(Number(this.state.subaccountId));
        logger.info('drift.trigger.subaccount_selected', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, subaccountId: this.state.subaccountId });
      }
    } catch (e: any) {
      logger.info('drift.trigger.warn subaccount_switch_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, err: String(e?.message || e) });
    }

    this.sdk = await import('@drift-labs/sdk');
    await this.initDiscovery();

    this.timer = setInterval(() => {
      this.loop().catch((e) => {
        this.state.lastError = String(e?.message || e);
      });
    }, this.state.loopIntervalMs);

    logger.info('drift.trigger.started', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, loopMs: this.state.loopIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    this.state.running = false;
    this.abort = true;
    try { this.dlobSubscriber?.unsubscribe?.(); } catch {}
    try { this.userMap?.unsubscribe?.(); } catch {}
    try { this.eventSubscriber?.unsubscribe?.(); } catch {}
    logger.info('drift.trigger.stopped', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
  }

  private async initDiscovery(): Promise<void> {
    const { SlotSubscriber, EventSubscriber, UserMap, DLOBSubscriber } = this.sdk;
    const drift = this.client;
    const driftConn = drift?.connection || this.connection;
    const program = drift?.program;

    try {
      this.slotSubscriber = new SlotSubscriber(driftConn);
      await this.slotSubscriber.subscribe();
      logger.info('drift.trigger.slot_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
    } catch (e: any) {
      logger.info('drift.trigger.warn slot_subscribe_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, err: String(e?.message || e) });
    }
    try {
      this.eventSubscriber = new EventSubscriber(driftConn, program);
      await this.eventSubscriber.subscribe();
      logger.info('drift.trigger.event_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
    } catch (e: any) {
      logger.info('drift.trigger.warn event_subscribe_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, err: String(e?.message || e) });
    }
    // UserMap: use current SDK config-object signature
    const subType = String(((CONFIG as any)?.drift?.subscriptionType || 'websocket')).toLowerCase();
    const umSubCfg: any = subType === 'polling'
      ? { type: 'polling', frequency: 1000 }
      : { type: 'websocket', resubTimeoutMs: 10000 };
    try {
      this.userMap = new UserMap({
        driftClient: drift,
        connection: driftConn,
        subscriptionConfig: umSubCfg,
        includeIdle: false,
        disableSyncOnTotalAccountsChange: false,
      });
    } catch (e1: any) {
      logger.info('drift.trigger.warn usermap_ctor_config_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, err: String(e1?.message || e1), subType });
      // Last resort: attempt minimal object
      this.userMap = new UserMap({ driftClient: drift, subscriptionConfig: { type: 'websocket' } });
    }
    await this.userMap.subscribe();
    logger.info('drift.trigger.usermap_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
    this.dlobSubscriber = new DLOBSubscriber({
      dlobSource: this.userMap,
      slotSource: this.slotSubscriber,
      updateFrequency: Math.max(200, this.state.loopIntervalMs - 250),
      driftClient: drift,
      userMapSubscriptionConfig: (() => {
        try { return drift.userAccountSubscriptionConfig || undefined; } catch { return undefined; }
      })(),
    });
    await this.dlobSubscriber.subscribe();
    logger.info('drift.trigger.dlob_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
  }

  private signatureForNode(nodeToTrigger: any): string {
    try {
      const user = String(nodeToTrigger?.node?.userAccount || '');
      const id = String(nodeToTrigger?.node?.order?.orderId || '');
      return `${user}#${id}`;
    } catch { return Math.random().toString(36).slice(-8); }
  }

  private inAllowlist(idx: number): boolean {
    const list = this.state.marketsAllowlist;
    if (!list || list.length === 0) return true;
    return list.includes(Number(idx));
  }

  private async loop(): Promise<void> {
    if (this.abort) return;
    const t0 = Date.now();
    this.state.lastRunAt = t0;

    try {
      const dlob = this.dlobSubscriber?.getDLOB?.();
      if (!dlob) return;

      const { MarketType, isVariant, getVariant, BN, getTriggerPrice, useMedianTriggerPrice } = this.sdk;

      const slot = this.slotSubscriber?.getSlot?.() ?? 0;
      const stateAcc = this.client.getStateAccount?.();

      const perp = await this.client.getPerpMarketAccounts?.();
      const spot = await this.client.getSpotMarketAccounts?.();

      const tryOneMarket = async (market: any, type: any) => {
        const idx = Number(market?.marketIndex || 0);
        if (!this.inAllowlist(idx)) return;
        const typeStr = getVariant(type);
        try {
          const oracleData = isVariant(type, 'perp')
            ? this.client.getOracleDataForPerpMarket(idx)
            : this.client.getOracleDataForSpotMarket(idx);

          const freshest = oracleData?.price as any; // BN
          const nowSec = new BN(Math.floor(Date.now() / 1000));
          let triggerPx = freshest;
          if (isVariant(type, 'perp')) {
            triggerPx = getTriggerPrice(market, freshest, nowSec, useMedianTriggerPrice(this.client.getStateAccount()));
          }

          const nodes = dlob.findNodesToTrigger(idx, slot, triggerPx, type, stateAcc);

          for (const node of nodes) {
            const sig = this.signatureForNode(node);
            const last = this.nodesCooldown.get(sig) || 0;
            if (last + COOLDOWN_MS > Date.now()) {
              continue;
            }
            this.nodesCooldown.set(sig, Date.now());
            const orderId = String(node?.node?.order?.orderId || '');
            const userPkStr = String(node?.node?.userAccount || '');

            logger.info('drift.trigger.try', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId, onChainPrice: String(oracleData?.price?.toString?.() || '') });

            let user: any = null;
            try { user = await this.userMap.mustGet(userPkStr); } catch {}
            if (!user) {
              logger.info('drift.trigger.warn user_not_found', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
              continue;
            }

            const ixs = [
              ComputeBudgetProgram.setComputeUnitLimit({ units: Number(this.config.cuLimit ?? 220_000) }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0)) }),
              await this.client.getTriggerOrderIx(new PublicKey(userPkStr), user.getUserAccount(), node.node.order),
              await this.client.getRevertFillIx(),
            ];

            if (this.state.dryRun) {
              logger.info('drift.trigger.dry_run', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, marketIndex: idx, marketType: typeStr });
              continue;
            }

            const tx = new Transaction();
            tx.add(...ixs);
            tx.feePayer = this.client.wallet.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash({ commitment: 'confirmed' });
            tx.recentBlockhash = blockhash;
            try {
              tx.sign(this.client.wallet.payer);
              const sigTx = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
              this.triggersInWindow.push(Date.now());
              logger.info('drift.trigger.ok', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, sig: sigTx, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId });
            } catch (e: any) {
              logger.info('drift.trigger.error send_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, err: String(e?.message || e) });
            }
          }
        } catch (e: any) {
          logger.info('drift.trigger.warn market_loop_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, err: String(e?.message || e) });
        }
      };

      await Promise.all([
        ...(Array.isArray(perp) ? perp.map((m: any) => tryOneMarket(m, MarketType.PERP)) : []),
        ...(Array.isArray(spot) ? spot.map((m: any) => tryOneMarket(m, MarketType.SPOT)) : []),
      ]);

      const dur = Date.now() - t0;
      logger.info('drift.trigger.loop', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, ms: dur, name: this.state.name });
    } catch (e: any) {
      this.state.lastError = String(e?.message || e);
      logger.info('drift.trigger.error loop_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, err: this.state.lastError });
    }
  }
}

export class DriftTriggerRegistry {
  private static reg = new RunnerRegistry<DriftTriggerRunner>();
  static keyOf(cfg: TriggerConfig): string {
    return cfg?.name ? `trg#${cfg.name}` : 'trg#default';
  }
  static upsert(cfg: TriggerConfig): DriftTriggerRunner {
    const key = this.keyOf(cfg);
    return this.reg.upsert(key, () => new DriftTriggerRunner(cfg));
  }
  static get(key: string): DriftTriggerRunner | undefined { return this.reg.get(key); }
  static list(): Array<{ key: string; status: TriggerRuntimeState }> { return this.reg.list(); }
  static async start(key: string): Promise<boolean> { return this.reg.start(key); }
  static stop(key: string): boolean { return this.reg.stop(key); }
  static remove(key: string): boolean { return this.reg.remove(key); }
}


