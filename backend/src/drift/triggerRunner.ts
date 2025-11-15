import { PublicKey, ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';
import { DriftService } from './client.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { buildTipIx } from '../execution/jitoTip.js';
import { startTipFeed, getCachedTipInfo } from '../execution/jitoTipCache.js';
import { sendToBlockEngine } from '../execution/jitoClient.js';

export type TriggerConfig = {
  name: string;
  enabled: boolean;
  dryRun?: boolean;
  subaccountId?: number;
  intervalMs?: number; // default 800 tailored
  cuLimit?: number; // default 220_000 tailored
  priorityFeeMicroLamports?: number; // default 0 (provider strategy may boost)
  marketsAllowlist?: Array<number> | string[]; // market indices allowlist
  triggerPriorityFeeMultiplier?: number; // scales dynamic priority fee (default 1.0)
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
  private botKey: string;

  private sdk: any | null = null;
  private client: any | null = null;
  private connection: any | null = null;

  private slotSubscriber: any | null = null;
  private eventSubscriber: any | null = null;
  private userMap: any | null = null;
  private dlobSubscriber: any | null = null;
  private priorityFeeSubscriber: any | null = null;
  private lookupTableAccounts: AddressLookupTableAccount[] | null = null;

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
    this.botKey = `trg#${this.state.name}`;
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
      const svc = DriftService.getInstance() as any;
      (svc as any).registerBot?.(this.botKey);
      await (svc as any).init?.();
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
    // Require infra warmup before proceeding if configured
    try {
      const driftCfg: any = (CONFIG as any)?.drift || {};
      const requireWarm = driftCfg?.warmupRequireBeforeBots !== false;
      if (requireWarm) {
        const ok = await (svc as any).waitForWarmup?.(Number(driftCfg?.warmupTimeoutMs ?? 30000));
        try { logger.info('drift.trigger.warmup_gate', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, ok }); } catch {}
      }
    } catch {}
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

    // Also drive ticks via slot updates for lower latency
    try {
      const onSlot = () => { try { setImmediate(() => { if (!this.inLoop && !this.abort) this.loop().catch(() => {}); }); } catch {} };
      if (typeof (this.slotSubscriber?.onSlotChange) === 'function') {
        this.slotSubscriber.onSlotChange(onSlot, 1);
      } else {
        this.slotSubscriber?.eventEmitter?.on?.('slotUpdate', onSlot);
      }
    } catch {}
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
    try { (DriftService.getInstance() as any).unregisterBot?.(this.botKey); } catch {}
  }

  private async initDiscovery(): Promise<void> {
    const svc = DriftService.getInstance();
    const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(200, this.state.loopIntervalMs - 250), preferOrderSubscriber: true });
    this.slotSubscriber = (infra as any).slotSubscriber;
    this.eventSubscriber = (infra as any).eventSubscriber;
    this.userMap = (infra as any).userMap;
    this.dlobSubscriber = (infra as any).dlobSubscriber;
    logger.info('drift.trigger.dlob_subscribed', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, name: this.state.name, shared: true });

    // Warm user prefetcher once shared infra is ready
    try { await (svc as any).startUserPrefetcher?.(this.dlobSubscriber, this.userMap); } catch {}

    // Initialize priority fee strategy
    try {
      const { PriorityFeeSubscriber } = this.sdk || {};
      if (PriorityFeeSubscriber) {
        this.priorityFeeSubscriber = new PriorityFeeSubscriber({
          connection: this.connection,
          fallbackPriorityFeeMicroLamports: Math.max(1000, Number(((CONFIG as any)?.fees?.priorityFee) || 1000)),
        });
        const { waitUntilWsReady } = await import('./wsHelper.js');
        if (this.connection) await waitUntilWsReady(this.connection, 'triggerRunner.init.priorityFee');
        
        // Import RPC limiter and debouncing
        const { withRpcLimit, withDebounce } = await import('../utils/rpcLimiter.js');
        
        // Wrap subscribe call with debouncing and RPC tracking
        await withDebounce(
          'triggerRunner:priorityFeeSubscriber:subscribe',
          async () => {
            return await withRpcLimit(
              () => this.priorityFeeSubscriber.subscribe(),
              1,
              { module: 'drift', method: 'accountSubscribe' }
            );
          },
          200
        );
        
        try { this.priorityFeeSubscriber.updateAddresses([ this.client?.program?.programId ].filter(Boolean)); } catch {}
      }
    } catch {}

    // Preload ALTs for v0
    try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch { this.lookupTableAccounts = []; }
    // Periodic ALT refresh
    try {
      const every = Math.max(60_000, Number(((CONFIG as any)?.drift?.altRefreshMs) ?? 300_000));
      setInterval(async () => { try { this.lookupTableAccounts = await (this.client?.fetchAllLookupTableAccounts?.()); } catch {} }, every);
    } catch {}

    // Start Jito tip feed cache (non-blocking)
    try { startTipFeed(Math.max(10_000, Number(((CONFIG as any)?.jito?.tipRefreshMs) ?? 15_000))); } catch {}
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
			logger.debug('drift.trigger.markets', {
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

			// Per-loop in-memory cache to avoid redundant UA reads and refreshes per user
			const uaCache = new Map<string, any>();

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

					logger.debug('drift.trigger.market_scan', {
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

          let iter = 0;
          for (const node of nodes) {
            iter += 1;
            if ((iter % 50) === 0) { try { await new Promise((r) => setImmediate(r)); } catch {} }
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

            // Ensure the target order still exists using the latest cached UA from subscriptions;
            // avoid per-node RPC refreshes which can trigger 429s under load.
            try {
              let ua = uaCache.get(userPkStr);
              if (!ua) { ua = user.getUserAccount?.(); uaCache.set(userPkStr, ua); }
              const wantId = String(node.node.order?.orderId || '');
              const stillExists = Array.isArray(ua?.orders) && ua.orders.some((o: any) => String(o?.orderId || '') === wantId);
              if (!stillExists) {
                logger.info('drift.trigger.skip_missing_order', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId });
                continue;
              }
            } catch {}

            // Dynamic CU limit
            let cuUnits = Math.max(100_000, Number(this.config.cuLimit ?? 220_000));
            try {
              const activePositions = user.getActivePerpPositions().length + user.getActiveSpotPositions().length;
              const openOrders = user.getUserAccount().openOrders;
              cuUnits += activePositions * 15_000;
              cuUnits += openOrders * 5_000;
            } catch {}

            // Dynamic priority fee
            const suggestedMul = Number(this.client?.txSender?.getSuggestedPriorityFeeMultiplier?.() || 1.0);
            const subPriority = Number(this.priorityFeeSubscriber?.getCustomStrategyResult?.() || 0);
            const baseCfg = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
            const mul = Number(this.config.triggerPriorityFeeMultiplier ?? 1.0);
            const priority = Math.floor(Math.max(baseCfg, subPriority * suggestedMul) * mul);

            // Build ixs
            let ixs: any[] = [
              ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
              await this.client.getTriggerOrderIx(new PublicKey(userPkStr), user.getUserAccount(), node.node.order),
            ];

            // Tip prepend (Jito or Sender fallback)
            let plannedTipLamports: number | undefined, plannedTipAccount: string | undefined;
            try {
              if ((CONFIG as any)?.jito?.enabled) {
                const cached = getCachedTipInfo();
                const tipPk = cached?.tipAccount;
                if (tipPk && String(tipPk?.toBase58?.()) !== String(this.client.wallet.publicKey?.toBase58?.())) {
                  const priorityLamportsEst = Math.floor((priority * Math.max(220_000, cuUnits)) / 1_000_000);
                  const cfg = (CONFIG as any)?.jito || {};
                  const fixed = Number(cfg?.fixedTipLamports ?? 0);
                  const share = Number(cfg?.tipShare ?? 0.3);
                  const floor = Number(cached?.tipFloorLamports ?? 0);
                  const estShare = Math.floor((priorityLamportsEst * share) / Math.max(1 - share, 0.01));
                  const tipLamports = Math.max(1000, fixed > 0 ? fixed : (floor || estShare));
                  ixs = [buildTipIx(this.client.wallet.publicKey, tipPk, tipLamports), ...ixs];
                  plannedTipLamports = tipLamports;
                  plannedTipAccount = tipPk.toBase58();
                }
              }
              if ((CONFIG as any)?.sender?.enabled && !(plannedTipLamports && plannedTipAccount)) {
                const scfg = (CONFIG as any).sender || {};
                const accounts: string[] = Array.isArray(scfg.tipAccounts) ? scfg.tipAccounts : [];
                const chosen = accounts.length > 0 ? accounts[Math.floor(Math.random() * accounts.length)] : undefined;
                if (chosen) {
                  const tipPk2 = new PublicKey(chosen);
                  const minTip = Math.max(1000, Number(scfg.minTipLamports || 1_000_000));
                  ixs = [buildTipIx(this.client.wallet.publicKey, tipPk2, minTip), ...ixs];
                  plannedTipLamports = minTip;
                  plannedTipAccount = tipPk2.toBase58();
                }
              }
            } catch {}

            if (this.state.dryRun) {
              logger.info('drift.trigger.dry_run', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, user: userPkStr, orderId, marketIndex: idx, marketType: typeStr });
              continue;
            }
            // Blockhash from shared cache, resilient refresh with fallback across RPCs
            const { getCachedBlockhash, getFreshBlockhashOrFetch } = await import('../utils/blockhash.js');
            let bhStr = getCachedBlockhash(250);
            if (!bhStr) {
              try { bhStr = String(await getFreshBlockhashOrFetch(300) || ''); } catch {}
            }
            if (!bhStr) { logger.info('drift.trigger.defer_no_cached_bh', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT }); continue; }

            // v0 compile with ALTs
            const msg = new TransactionMessage({ payerKey: this.client.wallet.publicKey, recentBlockhash: bhStr, instructions: ixs }).compileToV0Message(this.lookupTableAccounts || []);
            const vtx = new VersionedTransaction(msg);
            vtx.sign([this.client.wallet.payer]);

            // Sender/Jito/RPC send path
            const raw = vtx.serialize();
            const base64 = Buffer.from(raw).toString('base64');
            const rpcSend = async () => DriftService.getInstance().sendRawTransaction(raw, { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 0 });
            const beSend = async () => sendToBlockEngine(base64, { beUrl: (CONFIG as any)?.jito?.blockEngineUrl, timeoutMs: (CONFIG as any)?.jito?.bundleTimeoutMs });
            const senderSend = async () => {
              const scfg = (CONFIG as any)?.sender || {};
              let endpoint: string = String(scfg?.endpoint || 'https://sender.helius-rpc.com/fast');
              const params: string[] = [];
              if (scfg?.apiKey) params.push(`api-key=${encodeURIComponent(String(scfg.apiKey))}`);
              if (scfg?.swqosOnly) params.push('swqos_only=true');
              if (params.length > 0) endpoint += (endpoint.includes('?') ? '&' : '?') + params.join('&');
              const body = { jsonrpc: '2.0', id: String(Date.now()), method: 'sendTransaction', params: [ base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 } ] } as any;
              const res = await withRpcLimit(
                () => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
                1,
                { module: 'sender', method: 'sendTransaction' }
              );
              const json = await res.json().catch(() => ({} as any));
              if ((json as any)?.error) throw new Error(String((json as any).error?.message || 'SENDER_ERROR'));
              const sig = String((json as any)?.result || '');
              if (!sig) throw new Error('SENDER_NO_RESULT');
              return sig;
            };

            const preferSender = !!((CONFIG as any)?.sender?.enabled);
            const preferBE = !!((CONFIG as any)?.jito?.enabled) && !!(plannedTipLamports && plannedTipAccount);
            const raceRpc = !!((CONFIG as any)?.jito?.raceRpc);

            try {
              let sigTx: string;
              if (preferSender) {
                try { sigTx = await senderSend(); }
                catch {
                  const firstFulfilled = async <T>(arr: Array<Promise<T>>): Promise<T> => {
                    return new Promise<T>((resolve, reject) => {
                      let rejected = 0;
                      let lastErr: any;
                      const n = arr.length;
                      if (n === 0) { reject(new Error('EMPTY_PROMISE_LIST')); return; }
                      for (const p of arr) {
                        Promise.resolve(p).then(resolve, (e) => { rejected += 1; lastErr = e; if (rejected === n) reject(lastErr); });
                      }
                    });
                  };
                  sigTx = await (preferBE ? (raceRpc ? firstFulfilled([ beSend(), rpcSend() ]) : beSend()) : rpcSend());
                }
              } else if (preferBE && raceRpc) {
                const firstFulfilled = async <T>(arr: Array<Promise<T>>): Promise<T> => {
                  return new Promise<T>((resolve, reject) => {
                    let rejected = 0;
                    let lastErr: any;
                    const n = arr.length;
                    if (n === 0) { reject(new Error('EMPTY_PROMISE_LIST')); return; }
                    for (const p of arr) {
                      Promise.resolve(p).then(resolve, (e) => { rejected += 1; lastErr = e; if (rejected === n) reject(lastErr); });
                    }
                  });
                };
                sigTx = await firstFulfilled([ beSend(), rpcSend() ]);
              } else if (preferBE) {
                try { sigTx = await beSend(); } catch { sigTx = await rpcSend(); }
              } else {
                sigTx = await rpcSend();
              }

              this.triggersInWindow.push(Date.now());
              logger.info('drift.trigger.ok', { cat: TRIGGER_CAT, subcat: TRIGGER_SUBCAT, sig: sigTx, marketType: typeStr, marketIndex: idx, user: userPkStr, orderId });
              try {
                const { trackDriftAttempt } = await import('./txTracker.js');
                trackDriftAttempt(this.connection as any, {
                  sig: sigTx,
                  action: 'trigger',
                  marketIndex: idx,
                  taker: userPkStr,
                  orderId,
                  priorityFeeMicroLamports: priority,
                  cuLimit: cuUnits,
                  bot: (this as any)?.state?.name ? `trg#${(this as any).state.name}` : undefined,
                }).catch(() => {});
              } catch {}
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


