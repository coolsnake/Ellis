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
  private inLoop: boolean = false;

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

    try {
      if ((this as any)._condStatsTimer) { try { clearInterval((this as any)._condStatsTimer); } catch {} }
      (this as any)._condStatsTimer = setInterval(() => {
        this.reportConditionalOrderStats().catch(() => {});
      }, 30000);
    } catch {}

    const tick = async () => {
      if (this.abort || this.inLoop) return;
      this.inLoop = true;
      try { await this.loop(); }
      finally { this.inLoop = false; }
    };
    this.timer = setInterval(() => { tick().catch(() => {}); }, this.state.loopIntervalMs);

    logger.info('drift.trigger.started', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, loopMs: this.state.loopIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    this.state.running = false;
    this.abort = true;
    try { if ((this as any)._condStatsTimer) { clearInterval((this as any)._condStatsTimer); (this as any)._condStatsTimer = null; } } catch {}
    logger.info('drift.trigger.stopped', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name });
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    const infra = await (svc as any).getSharedInfra({ includeIdle: true, updateFrequency: Math.max(200, this.state.loopIntervalMs - 250), preferOrderSubscriber: true });
    this.slotSubscriber = (infra as any).slotSubscriber;
    this.eventSubscriber = (infra as any).eventSubscriber;
    this.userMap = (infra as any).userMap;
    this.dlobSubscriber = (infra as any).dlobSubscriber;
    logger.info('drift.trigger.dlob_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, shared: true });
  }

  private async reportConditionalOrderStats(): Promise<void> {
    try {
      const counts = new Map<number, number>();
      let scanned = 0;
      const maxScan = 5000;
      const iter: any = (this as any).userMap?.values?.();
      if (iter && typeof iter[Symbol.iterator] === 'function') {
        for (const u of iter as Iterable<any>) {
          if (this.abort) break;
          if (scanned >= maxScan) break;
          scanned += 1;
          try {
            const ua = (u as any)?.getUserAccount?.();
            const orders: any[] = Array.isArray(ua?.orders) ? ua.orders : [];
            for (const ord of orders) {
              try {
                const ot = ord?.orderType ? (this.sdk as any).getVariant(ord.orderType) : undefined;
                const mi = Number(ord?.marketIndex ?? ord?.market_index ?? -1);
                if (typeof ot === 'string' && ot.toLowerCase().includes('trigger') && Number.isFinite(mi) && mi >= 0) {
                  counts.set(mi, 1 + (counts.get(mi) || 0));
                }
              } catch {}
            }
          } catch {}
        }
      }
      const sample = Array.from(counts.entries()).slice(0, 10).map(([m, c]) => ({ m, c }));
      logger.info('drift.trigger.cond_orders_stats', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, scanned, markets: counts.size, sample });
    } catch {}
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

			const userCount = typeof this.userMap?.size === 'function' ? Number(this.userMap.size()) : 0;
			logger.info('drift.trigger.markets', {
				cat: TRIGGER_CAT,
				subcat: TRIGGER_SUBCAT,
				slot,
				perpCount: Array.isArray(perp) ? perp.length : 0,
				spotCount: Array.isArray(spot) ? spot.length : 0,
				allowlistSize: Array.isArray(this.state.marketsAllowlist) ? this.state.marketsAllowlist.length : 0,
				users: userCount,
			});

			// Sample a subset of users for visibility: open orders and conditional orders per market
			try {
				const sampleLimit = 25;
				let sampledUsers = 0;
				let totalOpenOrders = 0;
				let totalConditionalOrders = 0;
				const condByMarket = new Map<number, number>();
				const iter: any = this.userMap?.values?.();
				if (iter && typeof iter[Symbol.iterator] === 'function') {
					for (const u of iter as Iterable<any>) {
						if (sampledUsers >= sampleLimit) break;
						try {
							const ua = u?.getUserAccount?.();
							if (!ua) { sampledUsers += 1; continue; }
							const open = Number(ua?.openOrders || 0);
							totalOpenOrders += open;
				const ordersArr: any[] = Array.isArray(ua?.orders) ? ua.orders : [];
				// Include expired/cancelled to improve visibility of presence; filter when counting conditional triggers
							for (const ord of ordersArr) {
								try {
									const ot = ord?.orderType ? getVariant(ord.orderType) : undefined;
									const isTrigger = typeof ot === 'string' && ot.toLowerCase().includes('trigger');
									if (isTrigger) {
										totalConditionalOrders += 1;
										const mi = Number(ord?.marketIndex || ord?.market_index || -1);
										if (Number.isFinite(mi) && mi >= 0) condByMarket.set(mi, 1 + (condByMarket.get(mi) || 0));
									}
								} catch {}
							}
							sampledUsers += 1;
						} catch { sampledUsers += 1; }
					}
				}
				const condMarketsSample = Array.from(condByMarket.entries()).slice(0, 10).map(([m, c]) => ({ m, condSample: c }));
				logger.info('drift.trigger.user_sample', {
					cat: TRIGGER_CAT,
					subcat: TRIGGER_SUBCAT,
					sampledUsers,
					totalOpenOrders,
					totalConditionalOrders,
					condMarketsSample,
				});
			} catch {}

			let totalNodesPlanned = 0;
			let marketsWithNodes = 0;
			const nodeSamples: Array<{ m: number; t: string; u: string; id: string; cond?: string; otype?: string; ordTp?: string; oracle?: string; trig?: string }> = [];

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

					// Compute both median-based and raw oracle trigger price paths to compare
					const nodes = dlob.findNodesToTrigger(idx, slot, triggerPx, type, stateAcc);
					let nodesRaw = [] as any[];
					try {
						const rawTrigger = isVariant(type, 'perp') ? freshest : freshest;
						nodesRaw = dlob.findNodesToTrigger(idx, slot, rawTrigger, type, stateAcc) || [];
					} catch {}
					totalNodesPlanned += Array.isArray(nodes) ? nodes.length : 0;
					if (Array.isArray(nodes) && nodes.length > 0) marketsWithNodes += 1;

					let condAbove = 0, condBelow = 0, typeTrigMkt = 0, typeTrigLmt = 0;
					if (Array.isArray(nodes)) {
						for (const n of nodes) {
							try {
								const o = n?.node?.order;
								const cond = o?.triggerCondition ? getVariant(o.triggerCondition) : undefined;
								const ot = o?.orderType ? getVariant(o.orderType) : undefined;
								if (cond === 'above') condAbove += 1;
								else if (cond === 'below') condBelow += 1;
								if (ot === 'triggerMarket') typeTrigMkt += 1;
								else if (ot === 'triggerLimit') typeTrigLmt += 1;
							} catch {}
						}
					}

					logger.info('drift.trigger.market_scan', {
						cat: TRIGGER_CAT,
						subcat: TRIGGER_SUBCAT,
						marketIndex: idx,
						marketType: typeStr,
						nodes: Array.isArray(nodes) ? nodes.length : 0,
						nodesRaw: Array.isArray(nodesRaw) ? nodesRaw.length : 0,
						triggerPrice: String((triggerPx as any)?.toString?.() || triggerPx || ''),
						oraclePrice: String(oracleData?.price?.toString?.() || ''),
						slot,
						condAbove,
						condBelow,
						typeTrigMkt,
						typeTrigLmt,
					});

          for (const node of nodes) {
            const sig = this.signatureForNode(node);
            const last = this.nodesCooldown.get(sig) || 0;
            if (last + COOLDOWN_MS > Date.now()) {
							logger.info('drift.trigger.cooldown_skip', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, signature: sig });
              continue;
            }
            this.nodesCooldown.set(sig, Date.now());
            const orderId = String(node?.node?.order?.orderId || '');
            const userPkStr = String(node?.node?.userAccount || '');
						if (nodeSamples.length < 5) {
							const o = node?.node?.order;
							nodeSamples.push({
								m: idx,
								t: typeStr,
								u: userPkStr,
								id: orderId,
								cond: o?.triggerCondition ? getVariant(o.triggerCondition) : undefined,
								otype: o?.orderType ? getVariant(o.orderType) : undefined,
								ordTp: String(o?.triggerPrice?.toString?.() || ''),
								oracle: String(oracleData?.price?.toString?.() || ''),
								trig: String((triggerPx as any)?.toString?.() || ''),
							});
						}

            logger.info('drift.trigger.try', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId, onChainPrice: String(oracleData?.price?.toString?.() || '') });

            let user: any = null;
            try { user = await this.userMap.mustGet(userPkStr); } catch {}
            if (!user) {
              logger.info('drift.trigger.warn user_not_found', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
              continue;
            }

          // Refresh snapshot and ensure the target order still exists to avoid stale attempts
          try { await (user as any).fetchAccounts?.(); } catch {}
          try {
            const ua = user.getUserAccount?.();
            const wantId = String(node.node.order?.orderId || '');
            const stillExists = Array.isArray(ua?.orders) && ua.orders.some((o: any) => String(o?.orderId || '') === wantId);
            if (!stillExists) {
              logger.info('drift.trigger.skip_missing_order', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
              continue;
            }
          } catch {}

            const ixs = [
              ComputeBudgetProgram.setComputeUnitLimit({ units: Number(this.config.cuLimit ?? 220_000) }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0)) }),
              await this.client.getTriggerOrderIx(new PublicKey(userPkStr), user.getUserAccount(), node.node.order),
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
              const sigTx = await DriftService.getInstance().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
              this.triggersInWindow.push(Date.now());
              logger.info('drift.trigger.ok', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, sig: sigTx, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId });
            } catch (e: any) {
              const logs = (e?.logs && Array.isArray(e.logs)) ? e.logs : undefined;
              logger.info('drift.trigger.error send_failed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, err: String(e?.message || e), logs });
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
			logger.info('drift.trigger.loop_summary', {
				cat: TRIGGER_CAT,
				subcat: TRIGGER_SUBCAT,
				ms: dur,
				slot,
				users: userCount,
				totalNodesPlanned,
				marketsWithNodes,
				triggersLastMin: this.getStatus().triggersLastMin,
				sample: nodeSamples,
			});
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


