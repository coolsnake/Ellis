// @ts-nocheck
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
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
  allowAmmFills?: boolean; // default true
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
  private pollLoader: any | null = null;

  slotSubscriber: any | null = null;
  eventSubscriber: any | null = null;
  userMap: any | null = null;
  dlobSubscriber: any | null = null;
  orderSubscriber: any | null = null;

  private nodesCooldown: Map<string, number> = new Map();
  private fillsInWindow: number[] = [];
  private skipLogCount: Map<number, { n: number; ts: number }> = new Map();

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
    const infra = await (svc as any).getSharedInfra({ includeIdle: false, updateFrequency: Math.max(400, this.state.loopIntervalMs - 300), preferOrderSubscriber: true });
    this.slotSubscriber = (infra as any).slotSubscriber;
    this.eventSubscriber = (infra as any).eventSubscriber;
    this.userMap = (infra as any).userMap;
    this.dlobSubscriber = (infra as any).dlobSubscriber;
    this.orderSubscriber = (infra as any).orderSubscriber;
    logger.info('drift.filler.usermap_dlob_ready', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, name: this.state.name, shared: true });
    // Start user prefetcher once shared infra is ready
    try { await (svc as any).startUserPrefetcher?.(this.dlobSubscriber, this.userMap); } catch {}
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
      const { User, getUserAccountPublicKey } = this.sdk;
      // Ensure a polling loader exists for ad-hoc wrappers to avoid WS flakiness
      if (!this.pollLoader) {
        try { this.pollLoader = new (this.sdk as any).BulkAccountLoader(this.connection, 'confirmed', 1000); } catch {}
      }
      let takerWrapper: any = null;
      try {
        takerWrapper = (DriftService.getInstance() as any).getWarmUser?.(takerPkStr) || await this.userMap.mustGet(takerPkStr);
      } catch {}
      if (!takerWrapper) {
        try {
          const tmp = new User({
            driftClient: this.client,
            userAccountPublicKey: new PublicKey(takerPkStr),
            accountSubscription: this.pollLoader ? { type: 'polling', accountLoader: this.pollLoader } : { type: 'websocket' },
          });
          try { await tmp.subscribe?.(); } catch {}
          takerWrapper = tmp;
        } catch {}
      }
      // Ensure taker user account is hydrated (wrapper first)
      let takerUa = takerWrapper?.getUserAccount?.();
      if (!takerUa) {
        for (let i = 0; i < 4 && !takerUa; i += 1) {
          try { await takerWrapper?.fetchAccounts?.(); } catch {}
          try { takerUa = takerWrapper?.getUserAccount?.(); } catch {}
          if (!takerUa) { try { await new Promise((r) => setTimeout(r, 40)); } catch {} }
        }
      }
      // Additionally ensure underlying subscriber has dataAndSlot, but do not hard-fail on missing
      try {
        let ok = !!(takerWrapper as any)?.userAccountSubscriber?.dataAndSlot?.data;
        for (let i = 0; i < 3 && !ok; i += 1) {
          try { await takerWrapper?.fetchAccounts?.(); } catch {}
          ok = !!(takerWrapper as any)?.userAccountSubscriber?.dataAndSlot?.data;
          if (!ok) { try { await new Promise((r) => setTimeout(r, 40)); } catch {} }
        }
      } catch {}
      // Fallback 1: fetch raw on-chain account via Anchor coder
      if (!takerUa) {
        try { takerUa = await this.client.program.account.user.fetch(new PublicKey(takerPkStr)); } catch {}
      }
      // Fallback 2: batched decoder in DriftService (avoids wrapper entirely)
      if (!takerUa) {
        try {
          const svc = DriftService.getInstance() as any;
          const decoded = await svc.fetchUsersDecoded?.([takerPkStr]);
          takerUa = decoded?.get?.(takerPkStr) || takerUa;
        } catch {}
      }
      if (!takerUa) {
        try { logger.info('drift.filler.skip_missing_taker', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
        return false;
      }

      // If taker has a referrer configured but referrer stats do not exist, skip to avoid 6030
      try {
        const { getUserStatsAccountPublicKey } = this.sdk;
        const ref = (takerUa as any)?.referrerInfo?.referrer;
        if (ref) {
          try {
            const refStatsPk = getUserStatsAccountPublicKey(this.client.program.programId, ref);
            if (refStatsPk) {
              const info = await withRpcLimit(() => this.connection.getAccountInfo(refStatsPk, 'processed'));
              if (!info) {
                try { logger.info('drift.filler.skip_missing_referrer_stats', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
                return false;
              }
            }
          } catch {}
        }
      } catch {}

      const makersRaw: string[] = Array.isArray(nodeToFill?.makerNodes)
        ? nodeToFill.makerNodes.map((mn: any) => String(mn?.userAccount || '')).filter(Boolean)
        : [];
      const maxMakers = Math.max(0, Number(this.config.maxMakersPerFill ?? 2));
      const makers = makersRaw.slice(0, maxMakers);

      // Require maker nodes only when AMM-only fills are disabled
      const allowAmm = this.config.allowAmmFills !== false; // default allow
      if ((!Array.isArray(nodeToFill?.makerNodes) || nodeToFill.makerNodes.length === 0) && !allowAmm) {
        try {
          logger.debug('drift.filler.skip_no_makers', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
        } catch {}
        return false;
      }

      // Relax precheck: rely on DLOB to surface crossable nodes; only log diagnostics
      try {
        const { getVariant } = this.sdk;
        const o = nodeToFill?.node?.order;
        const otype = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : undefined;
        const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined;
        try { logger.debug('drift.filler.precheck', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex, dir, otype }); } catch {}
      } catch {}

      const makerInfos: any[] = [];
      // Batch-decode makers once to reduce round-trips
      let makersDecoded: Map<string, any> | null = null;
      try {
        const svc = DriftService.getInstance() as any;
        makersDecoded = await (svc.fetchUsersDecoded?.(makers) || null);
      } catch {}
      for (const m of makers) {
        try {
          let makerUa: any = null;
          let makerWrapper: any = null;
          try {
            makerWrapper = (DriftService.getInstance() as any).getWarmUser?.(m) || await this.userMap.mustGet(m);
          } catch {}
          if (!makerWrapper) {
            try {
              const tmp = new User({
                driftClient: this.client,
                userAccountPublicKey: new PublicKey(m),
                accountSubscription: this.pollLoader ? { type: 'polling', accountLoader: this.pollLoader } : { type: 'websocket' },
              });
              try { await tmp.subscribe?.(); } catch {}
              makerWrapper = tmp;
            } catch {}
          }
          // Ensure maker account is hydrated
          makerUa = makerWrapper?.getUserAccount?.();
          if (!makerUa) {
            for (let i = 0; i < 5 && !makerUa; i += 1) {
              try { await makerWrapper?.fetchAccounts?.(); } catch {}
              try { makerUa = makerWrapper?.getUserAccount?.(); } catch {}
              if (!makerUa) { try { await new Promise((r) => setTimeout(r, 40)); } catch {} }
            }
          }
          // Ensure subscriber hydration present
          try {
            let ok = !!(makerWrapper as any)?.userAccountSubscriber?.dataAndSlot?.data;
            for (let i = 0; i < 4 && !ok; i += 1) {
              try { await makerWrapper?.fetchAccounts?.(); } catch {}
              ok = !!(makerWrapper as any)?.userAccountSubscriber?.dataAndSlot?.data;
              if (!ok) { try { await new Promise((r) => setTimeout(r, 40)); } catch {} }
            }
            if (!ok && !makerUa) {
              // Keep trying via decode fallbacks below
            }
          } catch {}
          if (!makerUa) {
            try { makerUa = await this.client.program.account.user.fetch(new PublicKey(m)); } catch {}
          }
          if (!makerUa && makersDecoded) {
            try { makerUa = makersDecoded.get(m) || makerUa; } catch {}
          }
          if (!makerUa) continue;
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

      const takerUserPk = await getUserAccountPublicKey(this.client.program.programId, takerUa.authority, takerUa.subAccountId);
      const cuLimit = Math.max(200_000, Number(this.config.cuLimit ?? 1_000_000));
      const priority = Math.max(0, Number(this.config.priorityFeeMicroLamports ?? 0));
      // Build all dependent instructions and fetch blockhash in parallel to minimize delay
      const updateFillerIxP = (async () => {
        for (let i = 0; i < 3; i += 1) {
          try {
            const ix = await (this.client.getUpdateFillerIx?.() ?? this.client.getUpdateUserIdleIx?.());
            if (ix) return ix;
          } catch {}
          try { await new Promise((r) => setTimeout(r, 20)); } catch {}
        }
        return null;
      })();
      const fillIxP = this.client.getFillPerpOrderIx(takerUserPk, takerUa, nodeToFill.node.order, makerInfos);
      const revertIxP = this.client.getRevertFillIx();
      // Use retry+timeout for blockhash fetch to avoid long hangs
      const blockhashP = (async () => {
        try {
          const { withRpcRetry } = await import('../utils/rpcLimiter.js');
          return await withRpcRetry(() => this.connection.getLatestBlockhash({ commitment: 'processed' }), { timeoutMs: 2000, retries: 3, baseMs: 200, maxMs: 1200, label: 'blockhash' });
        } catch {
          return await withRpcLimit(() => this.connection.getLatestBlockhash({ commitment: 'processed' }));
        }
      })();

      let [updateFillerIx, fillIx, revertIx, bh] = await Promise.all([updateFillerIxP, fillIxP, revertIxP, blockhashP]);

      // If taker has a valid referrer stats account, append it as a remaining account to the fill ix
      try {
        const ref = (takerUa as any)?.referrerInfo?.referrer;
        if (ref && String(ref) !== '11111111111111111111111111111111') {
          const svc = DriftService.getInstance() as any;
          const refStatsPk = await svc.ensureRefStatsReady?.(ref);
          if (refStatsPk) {
            const exists = Array.isArray((fillIx as any)?.keys) && (fillIx as any).keys.some((k: any) => String(k?.pubkey || '') === String(refStatsPk));
            if (!exists && Array.isArray((fillIx as any)?.keys)) {
              (fillIx as any).keys.push({ pubkey: refStatsPk, isSigner: false, isWritable: true });
            }
          } else {
            try { logger.info('drift.filler.skip_missing_referrer_stats', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, marketIndex }); } catch {}
            return false;
          }
        }
      } catch {}

      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
        ...(updateFillerIx ? [updateFillerIx] : []),
        fillIx,
        ...(updateFillerIx ? [revertIx] : []),
      ];

      if (this.state.dryRun) {
        logger.info('drift.filler.dry_run', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), marketIndex });
        return false;
      }

      const submit = async (prio: number, updIx: any, bhObj: any): Promise<string> => {
        const toSend = new Transaction();
        toSend.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
          ...(updIx ? [updIx] : []),
          fillIx,
          ...(updIx ? [revertIx] : []),
        );
        toSend.feePayer = this.client.wallet.publicKey;
        toSend.recentBlockhash = bhObj.blockhash;
        toSend.sign(this.client.wallet.payer);
        // Wrap send with retry for transient network/RPC glitches
        try {
          const { withRpcRetry } = await import('../utils/rpcLimiter.js');
          const raw = toSend.serialize();
          return await withRpcRetry(() => DriftService.getInstance().sendRawTransaction(raw, { skipPreflight: true, preflightCommitment: 'processed' }), { timeoutMs: 4000, retries: 2, baseMs: 250, maxMs: 1200, label: 'sendTx' });
        } catch {
          return DriftService.getInstance().sendRawTransaction(toSend.serialize(), { skipPreflight: true, preflightCommitment: 'processed' });
        }
      };

      const submitFillOnly = async (prio: number, bhObj: any): Promise<string> => {
        const toSend = new Transaction();
        toSend.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
          fillIx,
        );
        toSend.feePayer = this.client.wallet.publicKey;
        toSend.recentBlockhash = bhObj.blockhash;
        toSend.sign(this.client.wallet.payer);
        try {
          const { withRpcRetry } = await import('../utils/rpcLimiter.js');
          const raw = toSend.serialize();
          return await withRpcRetry(() => DriftService.getInstance().sendRawTransaction(raw, { skipPreflight: true, preflightCommitment: 'processed' }), { timeoutMs: 4000, retries: 2, baseMs: 250, maxMs: 1200, label: 'sendTx' });
        } catch {
          return DriftService.getInstance().sendRawTransaction(toSend.serialize(), { skipPreflight: true, preflightCommitment: 'processed' });
        }
      };

      try {
        const sigTx = await submit(priority, updateFillerIx, bh);
        this.fillsInWindow.push(Date.now());
        logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
        // async track
        try {
          const { trackDriftAttempt } = await import('./txTracker.js');
          const makerKeys = Array.isArray(makers) ? makers : [];
          trackDriftAttempt(this.connection as any, {
            sig: sigTx,
            action: 'fill',
            marketIndex,
            taker: takerPkStr,
            makers: makerKeys,
            orderId: String(nodeToFill?.node?.order?.orderId || ''),
            priorityFeeMicroLamports: Number(this.config.priorityFeeMicroLamports || 0),
            cuLimit: Number(this.config.cuLimit || 0),
            bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
          }).catch(() => {});
        } catch {}
        return true;
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        if (/0x185f|RevertFill/i.test(msg)) {
          try {
            const [bh2, upd2] = await Promise.all([
              withRpcLimit(() => this.connection.getLatestBlockhash({ commitment: 'processed' })),
              (async () => { try { return await (this.client.getUpdateFillerIx?.() ?? this.client.getUpdateUserIdleIx?.()); } catch { return null; } })(),
            ]);
            const boosted = Math.max(priority, 3000);
            let sigTx: string;
            if (upd2 ?? updateFillerIx) {
              sigTx = await submit(boosted, (upd2 ?? updateFillerIx), bh2);
            } else {
              // Fallback: submit fill-only to avoid slot mismatch on revert
              sigTx = await submitFillOnly(boosted, bh2);
            }
            this.fillsInWindow.push(Date.now());
            logger.info('drift.filler.ok', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, sig: sigTx, marketIndex, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || '') });
            try {
              const { trackDriftAttempt } = await import('./txTracker.js');
              const makerKeys = Array.isArray(makers) ? makers : [];
              trackDriftAttempt(this.connection as any, {
                sig: sigTx,
                action: 'fill',
                marketIndex,
                taker: takerPkStr,
                makers: makerKeys,
                orderId: String(nodeToFill?.node?.order?.orderId || ''),
                priorityFeeMicroLamports: boosted,
                cuLimit: Number(this.config.cuLimit || 0),
                bot: (this as any)?.state?.name ? `fil#${(this as any).state.name}` : undefined,
              }).catch(() => {});
            } catch {}
            return true;
          } catch (e2: any) {
            logger.info('drift.filler.error send_failed', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, taker: takerPkStr, orderId: String(nodeToFill?.node?.order?.orderId || ''), err: String(e2?.message || e2) });
            return false;
          }
        }
        // Market paused or other error
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
        // Skip paused markets
        try {
          const statusStr = (() => { try { return String(getVariant((market as any)?.status)).toLowerCase(); } catch { return 'unknown'; } })();
          if (statusStr !== 'active') {
            try { logger.info('drift.filler.skip_paused_market', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, status: statusStr }); } catch {}
            continue;
          }
        } catch {}
        const mmOraclePriceData = this.client.getMMOracleDataForPerpMarket?.(idx);
        // Skip markets with stale oracle data to avoid zero-fills due to SafeMM checks
        try {
          const od = this.client.getOracleDataForPerpMarket?.(idx);
          const odSlot = Number((od as any)?.slot?.toString?.() || 0);
          const curSlot = this.slotSubscriber?.getSlot?.() ?? 0;
          const maxDelay = Math.max(0, Number(((CONFIG as any)?.drift?.maxOracleDelaySlots) ?? 40));
          if (odSlot > 0 && (curSlot - odSlot) > maxDelay) {
            try { logger.info('drift.filler.skip_oracle_stale', { cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, oracleDelay: (curSlot - odSlot), maxDelay }); } catch {}
            continue;
          }
        } catch {}
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

        // Enqueue taker/maker accounts for prefetch warming
        try {
          const svc = DriftService.getInstance() as any;
          const keys: string[] = [];
          for (const n of nodesToFill) {
            const t = String(n?.node?.userAccount || ''); if (t) keys.push(t);
            const mks = Array.isArray(n?.makerNodes) ? n.makerNodes : [];
            for (const mn of mks) { const mk = String(mn?.userAccount || ''); if (mk) keys.push(mk); }
          }
          svc.enqueueUsersForPrefetch?.(keys);
        } catch {}

        // Diagnostics: maker vs non-maker nodes
        try {
          const withMakers = nodesToFill.filter((n: any) => Array.isArray(n?.makerNodes) && n.makerNodes.length > 0).length;
          const withoutMakers = nodesToFill.length - withMakers;
          logger.info('drift.filler.market_nodes_breakdown', {
            cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
            nodes: nodesToFill.length, withMakers, withoutMakers,
          });
        } catch {}

        let iter = 0;
        for (const node of nodesToFill) {
          iter += 1;
          if ((iter % 50) === 0) { try { await new Promise((r) => setImmediate(r)); } catch {} }
          try {
            if (!node?.node?.order) continue;
            const allowAmm = this.config.allowAmmFills !== false; // default allow
            if (typeof node?.node?.isVammNode === 'function' && node.node.isVammNode()) {
              if (!allowAmm) {
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
              } else {
                try {
                  logger.debug('drift.filler.amm_fill_candidate', {
                    cat: FILLER_CAT,
                    subcat: FILLER_SUBCAT,
                    marketIndex: idx,
                    taker: String(node?.node?.userAccount || ''),
                    orderId: String(node?.node?.order?.orderId || ''),
                  });
                } catch {}
                // fall through to attempt AMM fill
              }
            }

            // If we are going to try AMM (vAMM node or no makers), ensure remaining size meets AMM min and is crossing
            try {
              const usingAmm = (typeof node?.node?.isVammNode === 'function' && node.node.isVammNode()) || !(Array.isArray(node?.makerNodes) && node.makerNodes.length > 0);
              const o = node?.node?.order;
              const minSz = (market as any)?.amm?.minOrderSize; // BN
              if (usingAmm && o) {
                const { BN, getVariant } = this.sdk;
                const base = (o as any)?.baseAssetAmount;         // BN
                const filled = (o as any)?.baseAssetAmountFilled || new BN(0); // BN
                const remaining = (base && typeof base.sub === 'function') ? base.sub(filled) : null;
                if (minSz && remaining && typeof remaining.lt === 'function' && remaining.lt(minSz)) {
                  try {
                    logger.info('drift.filler.skip_below_min_order', {
                      cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                      remaining: String((remaining as any)?.toString?.() || remaining || ''),
                      minOrder: String((minSz as any)?.toString?.() || minSz || ''),
                      taker: String(node?.node?.userAccount || ''), orderId: String(o?.orderId || ''),
                    });
                  } catch {}
                  continue;
                }
                // Cheap crossing check for AMM-only limit orders
                const otype = o?.orderType ? String(getVariant(o.orderType)).toLowerCase() : undefined;
                const dir = o?.direction ? String(getVariant(o.direction)).toLowerCase() : undefined; // 'long' | 'short'
                const isLimit = !!otype && otype.includes('limit');
                const priceBn = (o as any)?.price;
                if (isLimit && priceBn && typeof priceBn.lt === 'function' && typeof vAsk?.lt === 'function' && typeof vBid?.lt === 'function') {
                  const notCrossing = (dir === 'long' && priceBn.lt(vAsk)) || (dir === 'short' && priceBn.gt(vBid));
                  if (notCrossing) {
                    try {
                      logger.debug('drift.filler.skip_not_crossing_amm', {
                        cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx, dir,
                        orderPrice: String(priceBn?.toString?.() || ''), vBid: String(vBid?.toString?.() || ''), vAsk: String(vAsk?.toString?.() || ''),
                        taker: String(node?.node?.userAccount || ''), orderId: String(o?.orderId || ''),
                      });
                    } catch {}
                    continue;
                  }
                }
              }
            } catch {}

            // Identify order type; skip true trigger orders (TriggerMarket/TriggerLimit) until triggered
            const o = node?.node?.order;
            let orderTypeStr: string | undefined = undefined;
            try { orderTypeStr = o?.orderType ? String(getVariant(o.orderType)) : undefined; } catch {}
            const isTriggerType = !!orderTypeStr && ['triggermarket', 'triggerlimit'].includes(orderTypeStr.toLowerCase());
            if (isTriggerType) {
              try {
                const key = idx;
                const now = Date.now();
                const rec = this.skipLogCount.get(key) || { n: 0, ts: now };
                if (now - rec.ts > 10000) { rec.n = 0; rec.ts = now; }
                rec.n += 1;
                this.skipLogCount.set(key, rec);
                if (rec.n <= 5 || rec.n % 100 === 0) {
                  logger.info('drift.filler.skip_trigger_order', {
                    cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                    taker: String(node?.node?.userAccount || ''),
                    orderId: String(node?.node?.order?.orderId || ''),
                    orderType: orderTypeStr,
                    countInWindow: rec.n,
                  });
                } else {
                  logger.debug('drift.filler.skip_trigger_order', {
                    cat: FILLER_CAT, subcat: FILLER_SUBCAT, marketIndex: idx,
                    orderType: orderTypeStr,
                  });
                }
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


