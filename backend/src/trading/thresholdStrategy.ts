import { Keypair, PublicKey } from '@solana/web3.js';
import { fetchPricesByMints, executeSwap, SOL_MINT, getQuote } from '../jupiter/jupiter.js';
import { getAllPrices } from '../server/priceStore.js';
import { logger } from '../utils/logger.js';
import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';
import { resolveMint } from '../utils/tokens.js';
import { getBalances } from '../wallet/wallet.js';
import { addWalletHistory } from '../server/walletHistory.js';

export type StrategyConfig = {
  name?: string;
  token: string; // symbol or mint
  buyThreshold?: number; // deprecated
  sellThreshold?: number; // deprecated
  buyPct?: number; // e.g., 0.05 for 5% drop
  sellPct?: number; // e.g., 0.05 for 5% rise
  amount: number; // amount in token units
  inputMintUSDC?: string; // optional override mint addresses
  tokenMint?: string;
  testMode?: boolean; // if true, do not execute real swaps
  fromToken?: string; // base asset symbol/mint (e.g., USDC or SOL)
  toToken?: string; // quote asset symbol/mint (e.g., SOL or dSOL)
  active?: boolean;
  // Optional scaling in the favorable direction (pyramiding)
  // If holding long and price rises, or holding short and price drops,
  // add more to the position at thresholds of scaleStepPct beyond the entry.
  scaleAggressiveness?: number; // e.g., 0.5 means each scale adds 50% of base amount
  scaleStepPct?: number; // e.g., 0.01 for 1% steps from entry
  slippageBps?: number; // optional per-strategy slippage, defaults to 100 bps on swaps
  // Sliding anchor options
  slidingAnchor?: boolean; // enable anchor to drift toward market over time while idle
  slideRateBpsPerSec?: number; // how fast to slide (bps per second)
  slideMaxPct?: number; // cap slide from planned anchor (fraction, e.g., 0.01)
  minEdgeBps?: number; // minimum net edge (after impact+fees) to trade
};

export class ThresholdTrader {
  private isRunning = false;
  private interval?: NodeJS.Timeout;
  private lastTickAt = Date.now();
  static globalHalt = false;
  static setGlobalHalt(val: boolean) { this.globalHalt = val; }
  static realizedPnlByStrategy: Record<string, { usdc: number; sol: number }> = {};

  // Prevent duplicate executions across ticks by tracking in-flight ops per wallet+pair
  private static readonly INFLIGHT_TIMEOUT_MS = 20000; // 20s safety window
  private static inflightByWallet: Record<string, Record<string, { openLong?: number; openShort?: number; closeLong?: number; closeShort?: number; scaleLong?: number; scaleShort?: number }>> = {};
  private static isInflight(wallet: string, pairKey: string, kind: 'openLong'|'openShort'|'closeLong'|'closeShort'|'scaleLong'|'scaleShort'): boolean {
    const now = Date.now();
    const byPair = this.inflightByWallet[wallet]?.[pairKey];
    if (!byPair) return false;
    const ts = byPair[kind];
    if (!ts) return false;
    if (now - ts > this.INFLIGHT_TIMEOUT_MS) {
      // expired, clear
      delete byPair[kind];
      return false;
    }
    return true;
  }
  private static setInflight(wallet: string, pairKey: string, kind: 'openLong'|'openShort'|'closeLong'|'closeShort'|'scaleLong'|'scaleShort'): void {
    if (!this.inflightByWallet[wallet]) this.inflightByWallet[wallet] = {} as any;
    if (!this.inflightByWallet[wallet][pairKey]) this.inflightByWallet[wallet][pairKey] = {} as any;
    this.inflightByWallet[wallet][pairKey][kind] = Date.now();
  }
  private static clearInflight(wallet: string, pairKey: string, kind: 'openLong'|'openShort'|'closeLong'|'closeShort'|'scaleLong'|'scaleShort'): void {
    const byPair = this.inflightByWallet[wallet]?.[pairKey];
    if (byPair && byPair[kind]) delete byPair[kind];
  }

  constructor(private readonly walletPubkey: string, private readonly walletSignAndSend: (tx: any) => Promise<string>) {}

  async loadConfig(): Promise<StrategyConfig> {
    return readJson<StrategyConfig>(CONFIG.strategyConfigPath, {
      token: 'SOL',
      buyPct: 0.05,
      sellPct: 0.05,
      amount: 0.1,
    });
  }

  async tick(): Promise<void> {
    const cfg = await this.loadConfig();
    if (cfg.active === false) {
      emit('activity', { strategy: cfg.name || 'default', status: 'idle', trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      return;
    }
    const fromSym = (cfg.fromToken || 'USDC');
    const toSym = (cfg.toToken || cfg.token || 'SOL');
    const fromInfo = await resolveMint(fromSym);
    const toInfo = await resolveMint(toSym);
    const prices = getAllPrices();
    let fromUsd: number | null = prices[fromInfo.mint]?.usdc ?? null;
    let toUsd: number | null = prices[toInfo.mint]?.usdc ?? null;
    let solUsd: number | null = prices[SOL_MINT]?.usdc ?? null;
    if (!fromUsd || !toUsd || !solUsd) {
      try {
        const fresh = await fetchPricesByMints([fromInfo.mint, toInfo.mint, SOL_MINT]);
        fromUsd = fromUsd ?? (fresh[fromInfo.mint]?.usdc ?? null);
        toUsd = toUsd ?? (fresh[toInfo.mint]?.usdc ?? null);
        solUsd = solUsd ?? (fresh[SOL_MINT]?.usdc ?? null);
      } catch (e: any) {
        logger.warn('fetchPrices fallback failed', { error: String(e?.message || e) });
      }
    }
    const pairPrice = (fromUsd && toUsd) ? (toUsd / fromUsd) : null; // toToken per fromToken (e.g., SOL per USDC)
    if (!pairPrice) {
      logger.warn('Pair price not available', { from: fromSym, to: toSym });
      return;
    }

    const now = Date.now();
    const deltaMs = now - this.lastTickAt;
    this.lastTickAt = now;
    logger.debug?.('tick', { pair: `${fromSym}/${toSym}`, price: pairPrice, dtMs: deltaMs });
    const instanceKey = `${this.walletPubkey}:${cfg.name || 'default'}`;
    const state = ThresholdTrader.stateFor[instanceKey] || { anchor: pairPrice, holding: null as null | 'long' | 'short' };
    ThresholdTrader.stateFor[instanceKey] = state;
    if (!state.anchor) state.anchor = pairPrice;

    const buyPct = cfg.buyPct ?? (cfg.buyThreshold && pairPrice ? Math.max(0, (cfg.buyThreshold - pairPrice) / pairPrice) : 0.05);
    const sellPct = cfg.sellPct ?? (cfg.sellThreshold && pairPrice ? Math.max(0, (pairPrice - cfg.sellThreshold) / pairPrice) : 0.05);
    // LST NAV anchor (EMA fallback)
    let navPair: number | null = null;
    if ((cfg as any).lst) {
      if ((cfg as any).navSource === 'protocol') {
        navPair = pairPrice; // TODO: replace with protocol NAV
      } else {
        const alpha = 0.2;
        const prev = (state as any).emaNav || pairPrice;
        navPair = prev * (1 - alpha) + (pairPrice || prev) * alpha;
        (state as any).emaNav = navPair;
      }
    }
    let dropFromAnchor = (state.anchor - pairPrice) / state.anchor;
    let riseFromAnchor = (pairPrice - state.anchor) / state.anchor;

    // Plan anchor/triggers should be fixed while idle and fixed at entry while holding
    let plannedAnchor = state.holding ? state.anchor : ((state as any).plannedAnchor ?? ((cfg as any).anchorPairAtSetup ?? (navPair || pairPrice)));
    if (!state.holding && (state as any).plannedAnchor === undefined) {
      (state as any).plannedAnchor = plannedAnchor;
    }
    // Sliding anchor toward current while idle to keep opportunities reachable
    if (!state.holding && (cfg as any).slidingAnchor) {
      const rateBpsPerSec = Number((cfg as any).slideRateBpsPerSec ?? 0);
      const maxPct = Number((cfg as any).slideMaxPct ?? 0);
      if (rateBpsPerSec > 0 && typeof pairPrice === 'number' && typeof plannedAnchor === 'number') {
        const dtSec = Math.max(0, Math.min(5, Math.floor(deltaMs / 1000))); // bound to 5s per tick
        const fracPerSec = rateBpsPerSec / 10000;
        const alpha = Math.min(0.5, dtSec * fracPerSec);
        const raw = plannedAnchor + (pairPrice - plannedAnchor) * alpha;
        if (maxPct > 0) {
          const maxMove = (state as any).plannedAnchor !== undefined ? Math.abs(((state as any).plannedAnchor - plannedAnchor) * maxPct) : Infinity;
          const clamped = Math.abs(raw - plannedAnchor) > maxMove ? (plannedAnchor + Math.sign(raw - plannedAnchor) * maxMove) : raw;
          plannedAnchor = clamped;
        } else {
          plannedAnchor = raw;
        }
        (state as any).plannedAnchor = plannedAnchor;
      }
    }
    const buyTrigger = plannedAnchor * (1 - buyPct);
    const sellTrigger = plannedAnchor * (1 + sellPct);
    // Fee/slippage/hysteresis and premium for LST
    const feeBps = Number((cfg as any).feeBps ?? 0);
    const xSlip = Number((cfg as any).extraSlippageBps ?? 0);
    const hysteresis = Number((cfg as any).hysteresisBps ?? 0);
    const edgeDec = (feeBps + xSlip + hysteresis) / 10000;
    const premium = (navPair && pairPrice) ? (pairPrice / navPair - 1) : null;
    // Note: detailed phase emission moved below after signal variables are initialized

    // Decision snapshot: only emit when near a trigger to keep noise low
    const needBuyBps = Math.max(0, Math.round((buyPct - ((plannedAnchor - pairPrice) / plannedAnchor)) * 10000));
    const needSellBps = Math.max(0, Math.round((sellPct - ((pairPrice - plannedAnchor) / plannedAnchor)) * 10000));
    if (!state.holding) {
      const nearThreshold = (needBuyBps > 0 && needBuyBps <= 25) || (needSellBps > 0 && needSellBps <= 25);
      if (nearThreshold) {
        logger.debug?.('pretrade:near-trigger', { pair: `${fromSym}/${toSym}`, anchor: plannedAnchor, buyTrigger, sellTrigger, current: pairPrice, needBuyBps, needSellBps, premium, edge: edgeDec });
        emit('log', { level: 'info', message: `pretrade: near-trigger ${fromSym}/${toSym} current=${pairPrice.toFixed(6)} buy=${buyTrigger.toFixed(6)}(+${needBuyBps}bps) sell=${sellTrigger.toFixed(6)}(+${needSellBps}bps)`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
      }
    }

    // Resolve trading pair
    const baseSymbol = fromSym.toUpperCase();
    const quoteSymbol = toSym.toUpperCase();
    const inputBaseMint = fromInfo.mint;
    const outputQuoteMint = toInfo.mint;
    const pairKey = `${inputBaseMint}->${outputQuoteMint}`;

    if (ThresholdTrader.globalHalt) {
      // Halted: only emit waiting snapshot, no signals or executions
      emit('activity', { strategy: cfg.name || 'default', status: 'idle', pair: `${fromSym}/${toSym}`, anchor: state.anchor, buyTrigger: state.anchor * (1 - buyPct), sellTrigger: state.anchor * (1 + sellPct), trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      return;
    }

    // Market enter if requested (one-shot)
    let forceLongOpen = false;
    let forceShortOpen = false;
    if (!state.holding && (cfg as any).marketEnter === 'long') { forceLongOpen = true; (cfg as any).marketEnter = null; }
    if (!state.holding && (cfg as any).marketEnter === 'short') { forceShortOpen = true; (cfg as any).marketEnter = null; }

    const dropFromPlanned = (plannedAnchor - pairPrice) / plannedAnchor;
    const riseFromPlanned = (pairPrice - plannedAnchor) / plannedAnchor;
    const cdMs = Number((cfg as any).cooldownMs ?? 0);
    const sinceLast = now - Number((state as any).lastActionAt || 0);
    const allowByCooldown = cdMs ? (sinceLast >= cdMs) : true;
    const maxPos = Number((cfg as any).maxOpenPositions ?? Infinity);
    const currentOpen = (ThresholdTrader.positionsFor[instanceKey] || []).length;
    const canOpenMore = currentOpen < maxPos;
    const lstLongCond = (cfg as any).lst && premium !== null ? (premium <= -(Number(cfg.buyPct ?? 0) + edgeDec)) : false;
    const lstShortCond = (cfg as any).lst && premium !== null ? (premium >= (Number(cfg.sellPct ?? 0) + edgeDec)) : false;
    // Restrict strategy direction if specified (or inferred from name)
    const dir = (cfg as any).direction as ('long'|'short'|'both'|undefined);
    const nameLower = (cfg.name || '').toLowerCase();
    const inferred: 'long'|'short'|'both' = dir ?? (nameLower.includes('long') ? 'long' : (nameLower.includes('short') ? 'short' : 'both'));
    const allowLong = inferred === 'long' || inferred === 'both';
    const allowShort = inferred === 'short' || inferred === 'both';

    // Emit detailed phase after all pre-signal vars are available
    {
      const holding = state.holding;
      let phaseLabel: string = 'Idle';
      let nextAction: 'open-long' | 'open-short' | 'close-long' | 'close-short' | 'wait' = 'wait';
      if (!holding) {
        const needBuy = dropFromPlanned >= (buyPct + edgeDec);
        const needSell = riseFromPlanned >= (sellPct + edgeDec);
        if (allowLong && (needBuy || forceLongOpen || lstLongCond)) { phaseLabel = 'Waiting to Open/Buy'; nextAction = 'open-long'; }
        else if (allowShort && (needSell || forceShortOpen || lstShortCond)) { phaseLabel = 'Waiting to Open/Sell'; nextAction = 'open-short'; }
        else { phaseLabel = 'Waiting/Idle'; nextAction = 'wait'; }
      } else if (holding === 'long') {
        if (riseFromAnchor >= sellPct) { phaseLabel = 'Holding to Close/Sell'; nextAction = 'close-long'; }
        else { phaseLabel = 'Holding Long'; nextAction = 'wait'; }
      } else if (holding === 'short') {
        if (dropFromAnchor >= buyPct) { phaseLabel = 'Holding to Close/Buy'; nextAction = 'close-short'; }
        else { phaseLabel = 'Holding Short'; nextAction = 'wait'; }
      }
      emit('activity', {
        strategy: cfg.name || 'default',
        status: 'waiting',
        pair: `${fromSym}/${toSym}`,
        anchor: plannedAnchor,
        buyTrigger,
        sellTrigger,
        current: pairPrice,
        currentPairPrice: pairPrice,
        nav: navPair ?? undefined,
        premium: premium ?? undefined,
        edge: edgeDec || undefined,
        phaseLabel,
        nextAction,
        holding: holding || null,
        pnlUSDC: ThresholdTrader.realizedPnlByStrategy[cfg.name || 'default']?.usdc || 0,
        pnlSOL: ThresholdTrader.realizedPnlByStrategy[cfg.name || 'default']?.sol || 0,
        trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50)
      });
    }

    if (!state.holding && allowByCooldown && canOpenMore && allowLong && (forceLongOpen || lstLongCond || (!((cfg as any).lst) && dropFromPlanned >= (buyPct + edgeDec)))) {
      if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'openLong')) {
        logger.info('Skip duplicate open-long (in-flight)', { pair: `${fromSym}/${toSym}` });
        return;
      }
      // Buy: BASE -> QUOTE
      const stratName = cfg.name || 'default';
      logger.debug?.(`strategy:${stratName} Buy signal`, { pair: `${fromSym}/${toSym}`, entryPrice: pairPrice, buyTrigger, amountFrom: cfg.amount });
      emit('log', { level: 'info', message: `strategy:${stratName} Buy signal ${fromSym}/${toSym} entry=${pairPrice} trigger=${buyTrigger} amount=${cfg.amount}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'strategy' } });
      emit('log', { level: 'info', message: `pretrade:open-long checks ${fromSym}/${toSym} cooldown=${allowByCooldown} canOpen=${canOpenMore} needBuyBps=${needBuyBps}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
      try { (await import('../utils/tradeSummary.js')).logIntent({ ts: new Date().toISOString(), strategy: stratName, intent: 'open-long', pair: `${fromSym}/${toSym}`, anchor: plannedAnchor, trigger: buyTrigger, amountFrom: cfg.amount }); } catch {}
      emit('activity', { strategy: cfg.name || 'default', status: 'buying', pair: `${fromSym}/${toSym}`, trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      const inputMint = inputBaseMint; // base
      const outputMint = outputQuoteMint; // quote
      let openQuoteAmount: number | undefined = undefined;
      if (cfg.testMode) {
        logger.info('Test mode: skipping buy execution', { inputMint, outputMint, amount: cfg.amount });
      } else {
        try {
          ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'openLong');
          
          // Check if we should retry a previous balance check failure
          const shouldRetry = ThresholdTrader.shouldRetryBalanceCheck(cfg.name || 'default', 'openLong');
          if (shouldRetry) {
            logger.info('Retrying buy execution after previous balance check failure', { strategy: cfg.name });
            emit('log', { level: 'info', message: `terminal: retrying buy execution after balance check failure`, timestamp: new Date().toLocaleTimeString() });
          }
          
          // Inventory check: need base balance >= amount
          const bal = await getBalances(new PublicKey(this.walletPubkey));
          const haveBase = (fromSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[fromInfo.mint] || 0);
          const haveSol = Number(bal.sol || 0);
          const minSolForFees = Number((globalThis as any).process?.env?.MIN_SOL_FOR_FEES || 0.02);
          emit('log', { level: 'info', message: `pretrade:balances base=${haveBase} ${fromSym} sol=${haveSol}`, timestamp: new Date().toLocaleTimeString() });
          if (haveBase < cfg.amount) {
            logger.warn('Insufficient base balance for buy', { token: fromSym, need: cfg.amount, have: haveBase });
            emit('log', { level: 'warn', message: `terminal: buy skipped - insufficient ${fromSym} balance (need ${cfg.amount}, have ${haveBase})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.recordBalanceCheckFailure(cfg.name || 'default', 'openLong');
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
            return;
          }
          
          // Clear any previous balance check failure since we have sufficient balance
          ThresholdTrader.clearBalanceCheckFailure(cfg.name || 'default', 'openLong');
          if (fromSym.toUpperCase() === 'SOL') {
            if (haveBase - cfg.amount < minSolForFees) {
              logger.warn('Insufficient SOL left over for fees after buy', { haveBase, amount: cfg.amount, minSolForFees });
              emit('log', { level: 'warn', message: `terminal: buy skipped - need ~${minSolForFees} SOL left over for fees`, timestamp: new Date().toLocaleTimeString() });
              ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
              return;
            }
          } else if (haveSol < minSolForFees) {
            logger.warn('Insufficient SOL for fees', { haveSol, minSolForFees });
            emit('log', { level: 'warn', message: `terminal: buy skipped - insufficient SOL for fees (~${minSolForFees})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
            return;
          }
          // Enforce maxPositionSize for open
          const maxSize = Number((cfg as any).maxPositionSize ?? Infinity);
          if (cfg.amount > maxSize) {
            logger.warn('Open skipped: exceeds maxPositionSize', { amount: cfg.amount, maxSize });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
            return;
          }
          const amountInSmallest = Math.round(cfg.amount * 10 ** fromInfo.decimals);
          // Pre-quote to capture expected toAmount and realized entry ratio
          let toAmount = 0;
          let realizedEntryPair = pairPrice;
          let routeLen: number | undefined;
          try {
          const q: any = await getQuote({ inputMint, outputMint, amount: amountInSmallest, slippageBps: (cfg as any).slippageBps ?? 100 }, false, 'strategy');
            const outRaw = Number(q?.outAmount || 0);
            const outDec = Number(q?.routePlan?.[q?.routePlan?.length - 1]?.swapInfo?.outDecimals ?? toInfo.decimals ?? 6);
            toAmount = outRaw / Math.pow(10, outDec);
            routeLen = Array.isArray(q?.routePlan) ? q.routePlan.length : undefined;
            if (toAmount > 0) realizedEntryPair = toAmount / cfg.amount;
            emit('log', { level: 'info', message: `pretrade:quote open-long out=${toAmount} rate=${realizedEntryPair} routes=${routeLen ?? 0}`, timestamp: new Date().toLocaleTimeString() });
            openQuoteAmount = toAmount;
            try { (await import('../utils/tradeSummary.js')).logQuote({ ts: new Date().toISOString(), strategy: stratName, side: 'long', pair: `${fromSym}/${toSym}`, amountIn: cfg.amount, amountOut: toAmount, rate: realizedEntryPair, routes: routeLen, priceImpactBps: (typeof (q?.priceImpactPct) === 'number') ? Math.round(q.priceImpactPct * 10000) : undefined }); } catch {}
            // Evaluate quote vs threshold including edge
            try {
              const achievedDrop = (plannedAnchor && realizedEntryPair) ? ((plannedAnchor - realizedEntryPair) / plannedAnchor) : null;
              const needDrop = (buyPct + edgeDec);
              if (typeof achievedDrop === 'number') {
                const status = achievedDrop >= needDrop ? 'in-range' : 'not-in-range';
                const bpsAchieved = Math.round(achievedDrop * 10000);
                const bpsNeed = Math.round(needDrop * 10000);
                emit('log', { level: achievedDrop >= needDrop ? 'info' : 'warn', message: `pretrade:quote-check ${status} long dropBps=${bpsAchieved} needBps=${bpsNeed}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
              }
            } catch {}
            // Net-of-cost minimum edge gate
            try {
              const impactBps = (typeof (q?.priceImpactPct) === 'number') ? Math.round(q.priceImpactPct * 10000) : 0;
              const totalBps = impactBps + feeBps + xSlip;
              const minEdge = Number((cfg as any).minEdgeBps || 0);
              if (minEdge > 0 && totalBps >= minEdge) {
                emit('log', { level: 'warn', message: `pretrade:edge-block long impact+fees=${totalBps}bps >= minEdge=${minEdge}bps`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
                ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
                return;
              }
            } catch {}
          } catch (e: any) {
            logger.warn('pretrade:quote open-long failed', { error: String(e?.message || e) });
          }
        const swapResultOpenLong = await executeSwap(
            { 
              inputMint, 
              outputMint, 
              amount: amountInSmallest, 
              userPublicKey: this.walletPubkey, 
              slippageBps: (cfg as any).slippageBps ?? 100,
              prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
              maxAccounts: CONFIG.fees.jupiterMaxAccounts,
              dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
              asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
            },
            this.walletSignAndSend,
            false, // priority
            toInfo.decimals, // output decimals for received amount
            'strategy'
          );
          
        const sigOpenLong = swapResultOpenLong.signature;
        logger.info('Buy executed', { sig: sigOpenLong });
        emit('log', { level: 'info', message: `trade:filled open-long sig=${sigOpenLong} rate=${realizedEntryPair}`, timestamp: new Date().toLocaleTimeString() });
        emit('log', { level: 'info', message: `terminal: buy filled ${fromSym}->${toSym} amount=${cfg.amount} sig=${sigOpenLong}`, timestamp: new Date().toLocaleTimeString() });
          addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: fromSym, fromAmount: cfg.amount, toToken: toSym, toAmount });
          try { (await import('../utils/tradeSummary.js')).logTrade({ ts: new Date().toISOString(), strategy: stratName, event: 'open-long', pair: `${fromSym}/${toSym}`, base: cfg.amount, quote: toAmount, rate: realizedEntryPair, sig: sigOpenLong }); } catch {}
          // Set anchor to realized entry
          state.anchor = realizedEntryPair;
        } catch (e: any) {
          logger.error('Buy failed', { error: String(e?.message || e) });
          ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'buy-error', token: `${fromSym}->${toSym}`, amount: cfg.amount, price: pairPrice });
          emit('log', { level: 'error', message: `terminal: buy failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString() });
          ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
          return;
        }
      }
      state.holding = 'long';
      delete (state as any).plannedAnchor;
      // reset scaling level for new long
      (state as any).longScaleLevel = 0;
      ThresholdTrader.openPosition(instanceKey, {
        mint: outputMint,
        symbol: toSym,
        side: 'long',
        entry: state.anchor,
        target: pairPrice * (1 + sellPct),
        amountFrom: cfg.amount,
        // capture precise quantities for better PnL
        quoteAmount: openQuoteAmount,
        baseReceivedAtOpen: cfg.amount,
        meta: { baseUsdAtOpen: fromUsd || undefined, quoteUsdAtOpen: toUsd || undefined },
        fromSymbol: fromSym,
        toSymbol: toSym,
        strategy: cfg.name || 'default',
        openedAtMs: Date.now(),
      });
      ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'open-long', token: `${fromSym}->${toSym}`, amount: cfg.amount, price: pairPrice });
      ThresholdTrader.emitAllPositions();
      (state as any).lastActionAt = now;
      ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openLong');
    } else if (!state.holding && allowByCooldown && canOpenMore && allowShort && (forceShortOpen || lstShortCond || (!((cfg as any).lst) && riseFromPlanned >= (sellPct + edgeDec)))) {
      if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'openShort')) {
        logger.info('Skip duplicate open-short (in-flight)', { pair: `${fromSym}/${toSym}` });
        return;
      }
      // Sell: QUOTE -> BASE
      const stratName2 = cfg.name || 'default';
      logger.debug?.(`strategy:${stratName2} Sell signal`, { pair: `${fromSym}/${toSym}`, entryPrice: pairPrice, sellTrigger, amountFrom: cfg.amount });
      emit('log', { level: 'info', message: `strategy:${stratName2} Sell signal ${fromSym}/${toSym} entry=${pairPrice} trigger=${sellTrigger} amount=${cfg.amount}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'strategy' } });
      emit('log', { level: 'info', message: `pretrade:open-short checks ${fromSym}/${toSym} cooldown=${allowByCooldown} canOpen=${canOpenMore} needSellBps=${needSellBps}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
      try { (await import('../utils/tradeSummary.js')).logIntent({ ts: new Date().toISOString(), strategy: stratName2, intent: 'open-short', pair: `${fromSym}/${toSym}`, anchor: plannedAnchor, trigger: sellTrigger, amountFrom: cfg.amount }); } catch {}
      emit('activity', { strategy: cfg.name || 'default', status: 'selling', pair: `${fromSym}/${toSym}`, trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      const inputMint = inputBaseMint;
      const outputMint = outputQuoteMint;
      if (cfg.testMode) {
        logger.info('Test mode: skipping sell execution', { inputMint, outputMint, amount: cfg.amount });
      } else {
        try {
          ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'openShort');
          
          // Check if we should retry a previous balance check failure
          const shouldRetry = ThresholdTrader.shouldRetryBalanceCheck(cfg.name || 'default', 'openShort');
          if (shouldRetry) {
            logger.info('Retrying sell execution after previous balance check failure', { strategy: cfg.name });
            emit('log', { level: 'info', message: `terminal: retrying sell execution after balance check failure`, timestamp: new Date().toLocaleTimeString() });
          }
          
          // Sell fromToken amount into toToken
          const quoteAmount = cfg.amount;
          const bal = await getBalances(new PublicKey(this.walletPubkey));
          const haveQuote = (fromSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[fromInfo.mint] || 0);
          const haveSol = Number(bal.sol || 0);
          const minSolForFees = Number((globalThis as any).process?.env?.MIN_SOL_FOR_FEES || 0.02);
          emit('log', { level: 'info', message: `pretrade:balances quote=${haveQuote} ${toSym} sol=${haveSol}`, timestamp: new Date().toLocaleTimeString() });
          if (haveQuote < quoteAmount) {
            logger.warn('Insufficient quote balance for sell', { token: toSym, need: quoteAmount, have: haveQuote });
            emit('log', { level: 'warn', message: `terminal: sell skipped - insufficient ${toSym} balance (need ${quoteAmount}, have ${haveQuote})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.recordBalanceCheckFailure(cfg.name || 'default', 'openShort');
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
            return;
          }
          
          // Clear any previous balance check failure since we have sufficient balance
          ThresholdTrader.clearBalanceCheckFailure(cfg.name || 'default', 'openShort');
          if (haveSol < minSolForFees) {
            logger.warn('Insufficient SOL for fees', { haveSol, minSolForFees });
            emit('log', { level: 'warn', message: `terminal: sell skipped - insufficient SOL for fees (~${minSolForFees})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
            return;
          }
          // Enforce maxPositionSize for open (base-equivalent = cfg.amount)
          const maxSize = Number((cfg as any).maxPositionSize ?? Infinity);
          if (cfg.amount > maxSize) {
            logger.warn('Open skipped: exceeds maxPositionSize', { amount: cfg.amount, maxSize });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
            return;
          }
          const amountInSmallest = Math.round(quoteAmount * 10 ** fromInfo.decimals);
          // Pre-quote to capture expected base out and realized entry ratio
          let baseOut = 0;
          let realizedEntryPairShort = pairPrice;
          let routeLen2: number | undefined;
          try {
          const q: any = await getQuote({ inputMint, outputMint, amount: amountInSmallest, slippageBps: (cfg as any).slippageBps ?? 100 }, false, 'strategy');
            const outRaw = Number(q?.outAmount || 0);
            const outDec = Number(q?.routePlan?.[q?.routePlan?.length - 1]?.swapInfo?.outDecimals ?? toInfo.decimals ?? 6);
            baseOut = outRaw / Math.pow(10, outDec);
            routeLen2 = Array.isArray(q?.routePlan) ? q.routePlan.length : undefined;
            if (baseOut > 0) realizedEntryPairShort = baseOut / quoteAmount;
            emit('log', { level: 'info', message: `pretrade:quote open-short out=${baseOut} rate=${realizedEntryPairShort} routes=${routeLen2 ?? 0}` , timestamp: new Date().toLocaleTimeString()});
            try { (await import('../utils/tradeSummary.js')).logQuote({ ts: new Date().toISOString(), strategy: stratName2, side: 'short', pair: `${fromSym}/${toSym}`, amountIn: quoteAmount, amountOut: baseOut, rate: realizedEntryPairShort, routes: routeLen2, priceImpactBps: (typeof (q?.priceImpactPct) === 'number') ? Math.round(q.priceImpactPct * 10000) : undefined }); } catch {}
            // Evaluate quote vs threshold including edge
            try {
              const realizedForCompare = realizedEntryPairShort ? (1 / realizedEntryPairShort) : null;
              const achievedRise = (plannedAnchor && realizedForCompare) ? ((realizedForCompare - plannedAnchor) / plannedAnchor) : null;
              const needRise = (sellPct + edgeDec);
              if (typeof achievedRise === 'number') {
                const status = achievedRise >= needRise ? 'in-range' : 'not-in-range';
                const bpsAchieved = Math.round(achievedRise * 10000);
                const bpsNeed = Math.round(needRise * 10000);
                emit('log', { level: achievedRise >= needRise ? 'info' : 'warn', message: `pretrade:quote-check ${status} short riseBps=${bpsAchieved} needBps=${bpsNeed}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
              }
            } catch {}
            // Net-of-cost minimum edge gate
            try {
              const impactBps = (typeof (q?.priceImpactPct) === 'number') ? Math.round(q.priceImpactPct * 10000) : 0;
              const totalBps = impactBps + feeBps + xSlip;
              const minEdge = Number((cfg as any).minEdgeBps || 0);
              if (minEdge > 0 && totalBps >= minEdge) {
                emit('log', { level: 'warn', message: `pretrade:edge-block short impact+fees=${totalBps}bps >= minEdge=${minEdge}bps`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
                ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
                return;
              }
            } catch {}
          } catch (e: any) {
            logger.warn('pretrade:quote open-short failed', { error: String(e?.message || e) });
          }
        const swapResultOpenShort = await executeSwap(
            { 
              inputMint, 
              outputMint, 
              amount: amountInSmallest, 
              userPublicKey: this.walletPubkey, 
              slippageBps: (cfg as any).slippageBps ?? 100,
              prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
              maxAccounts: CONFIG.fees.jupiterMaxAccounts,
              dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
              asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
            },
            this.walletSignAndSend,
            false, // priority
            fromInfo.decimals, // output decimals for received amount
            'strategy'
          );
          
        const sigOpenShort = swapResultOpenShort.signature;
        logger.info('Sell executed', { sig: sigOpenShort });
        emit('log', { level: 'info', message: `trade:filled open-short sig=${sigOpenShort} rate=${realizedEntryPairShort}`, timestamp: new Date().toLocaleTimeString() });
        emit('log', { level: 'info', message: `terminal: sell filled ${fromSym}->${toSym} amount=${quoteAmount.toFixed(6)} sig=${sigOpenShort}`, timestamp: new Date().toLocaleTimeString() });
          addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: fromSym, fromAmount: quoteAmount, toToken: toSym, toAmount: baseOut });
          try { (await import('../utils/tradeSummary.js')).logTrade({ ts: new Date().toISOString(), strategy: stratName2, event: 'open-short', pair: `${fromSym}/${toSym}`, base: quoteAmount, quote: baseOut, rate: realizedEntryPairShort, sig: sigOpenShort }); } catch {}
          state.anchor = realizedEntryPairShort;
        } catch (e: any) {
          logger.error('Sell failed', { error: String(e?.message || e) });
          ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'sell-error', token: `${toSym}->${fromSym}`, amount: cfg.amount, price: pairPrice });
          emit('log', { level: 'error', message: `terminal: sell failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString() });
          ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
          return;
        }
      }
      state.holding = 'short';
      delete (state as any).plannedAnchor;
      // reset scaling level for new short
      (state as any).shortScaleLevel = 0;
      ThresholdTrader.openPosition(instanceKey, {
        mint: inputMint,
        symbol: fromSym,
        side: 'short',
        entry: state.anchor,
        target: pairPrice * (1 - buyPct),
        amountFrom: cfg.amount,
        // capture quantities for better PnL
        quoteAmountSold: cfg.amount, // amount of fromToken (e.g., SOL) sold
        baseReceivedAtOpen: 0, // will be reflected in wallet history; UI PnL uses USD deltas
        meta: { baseUsdAtOpen: fromUsd || undefined, quoteUsdAtOpen: toUsd || undefined },
        fromSymbol: fromSym,
        toSymbol: toSym,
        strategy: cfg.name || 'default',
        openedAtMs: Date.now(),
      });
      ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'open-short', token: `${toSym}->${fromSym}`, amount: cfg.amount, price: pairPrice });
      ThresholdTrader.emitAllPositions();
      (state as any).lastActionAt = now;
      ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'openShort');
    }

    // Scale-in logic when already holding a position (pyramiding winners)
    if (state.holding === 'long') {
      const aggr = Number(cfg.scaleAggressiveness ?? 0);
      const step = Number(cfg.scaleStepPct ?? 0);
      const entry = ThresholdTrader.lastEntryPair[instanceKey]?.long;
      if (aggr > 0 && step > 0 && typeof entry === 'number' && pairPrice > entry) {
        const riseFromEntry = (pairPrice - entry) / entry;
        const levelNow = Math.floor(riseFromEntry / step);
        const prevLevel = Number((state as any).longScaleLevel || 0);
        if (levelNow > prevLevel) {
          if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'scaleLong')) {
            return;
          }
          try {
            ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'scaleLong');
            // buy additional quote using base; amount in base units
            const addAmountBase = cfg.amount * aggr;
            const bal = await getBalances(new PublicKey(this.walletPubkey));
            const haveBase = (fromSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[fromInfo.mint] || 0);
            if (haveBase < addAmountBase) {
              logger.warn('Insufficient base balance for scale-long', { token: fromSym, need: addAmountBase, have: haveBase });
              ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleLong');
              return;
            }
            const amountInSmallest = Math.round(addAmountBase * 10 ** fromInfo.decimals);
            const swapResult = await executeSwap(
              { 
                inputMint: inputBaseMint, 
                outputMint: outputQuoteMint, 
                amount: amountInSmallest, 
                userPublicKey: this.walletPubkey, 
                slippageBps: (cfg as any).slippageBps ?? 100,
                prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
                maxAccounts: CONFIG.fees.jupiterMaxAccounts,
                dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
                asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
              },
              this.walletSignAndSend,
              false, // priority
              toInfo.decimals // output decimals for received amount
            );
            const sig = swapResult.signature;
            (state as any).longScaleLevel = prevLevel + 1;
            ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'scale-long', token: `${fromSym}->${toSym}`, amount: addAmountBase, price: pairPrice });
            addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: fromSym, fromAmount: addAmountBase, toToken: toSym });
            emit('log', { level: 'info', message: `Scaled long by ${addAmountBase} ${fromSym} @ ${pairPrice}`, timestamp: new Date().toLocaleTimeString() });
            // Update position size for this strategy/side
            const list = ThresholdTrader.positionsFor[instanceKey] || [];
            for (const p of list) {
              if (p.side === 'long' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym) {
                p.amountFrom = Number(p.amountFrom || 0) + addAmountBase;
                // update quote amount and weighted-average entry using current pairPrice as fill rate proxy
                const prevBase = Number(p.amountFrom || 0) - addAmountBase;
                if (prevBase > 0 && typeof p.entry === 'number') {
                  const newEntry = ((prevBase * p.entry) + (addAmountBase * pairPrice)) / (prevBase + addAmountBase);
                  p.entry = newEntry;
                  if (!ThresholdTrader.lastEntryPair[instanceKey]) ThresholdTrader.lastEntryPair[instanceKey] = {};
                  ThresholdTrader.lastEntryPair[instanceKey].long = newEntry;
                }
                (p as any).quoteAmount = Number((p as any).quoteAmount || 0) + (addAmountBase * pairPrice);
              }
            }
            ThresholdTrader.emitAllPositions();
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleLong');
            return; // execute at most one scale per tick
          } catch (e: any) {
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleLong');
            logger.error('Scale long failed', { error: String(e?.message || e) });
            emit('log', { level: 'error', message: `terminal: scale long failed ${String(e?.message || e)}` , timestamp: new Date().toLocaleTimeString()});
          }
        }
      }
    }

    if (state.holding === 'short') {
      const aggr = Number(cfg.scaleAggressiveness ?? 0);
      const step = Number(cfg.scaleStepPct ?? 0);
      const entry = ThresholdTrader.lastEntryPair[instanceKey]?.short;
      if (aggr > 0 && step > 0 && typeof entry === 'number' && pairPrice < entry) {
        const dropFromEntry = (entry - pairPrice) / entry;
        const levelNow = Math.floor(dropFromEntry / step);
        const prevLevel = Number((state as any).shortScaleLevel || 0);
        if (levelNow > prevLevel) {
          if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'scaleShort')) {
            return;
          }
          try {
            ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'scaleShort');
            // sell additional quote into base; quote required to raise base by amount is base / price
            const addAmountQuote = (cfg.amount * aggr) / pairPrice;
            const bal = await getBalances(new PublicKey(this.walletPubkey));
            const haveQuote = (toSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[toInfo.mint] || 0);
            if (haveQuote < addAmountQuote) {
              logger.warn('Insufficient quote balance for scale-short', { token: toSym, need: addAmountQuote, have: haveQuote });
              ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleShort');
              return;
            }
            const amountInSmallest = Math.round(addAmountQuote * 10 ** toInfo.decimals);
            const swapResult = await executeSwap(
              { 
                inputMint: outputQuoteMint, 
                outputMint: inputBaseMint, 
                amount: amountInSmallest, 
                userPublicKey: this.walletPubkey, 
                slippageBps: (cfg as any).slippageBps ?? 100,
                prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
                maxAccounts: CONFIG.fees.jupiterMaxAccounts,
                dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
                asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
              },
              this.walletSignAndSend,
              false, // priority
              fromInfo.decimals // output decimals for received amount
            );
            const sig = swapResult.signature;
            (state as any).shortScaleLevel = prevLevel + 1;
            ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'scale-short', token: `${toSym}->${fromSym}`, amount: addAmountQuote, price: pairPrice });
            addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: toSym, fromAmount: addAmountQuote, toToken: fromSym, toAmount: (typeof toUsd === 'number' && typeof fromUsd === 'number') ? (addAmountQuote * (toUsd / fromUsd)) : undefined });
            emit('log', { level: 'info', message: `Scaled short by ${addAmountQuote} ${toSym} @ ${pairPrice}`, timestamp: new Date().toLocaleTimeString() });
            // Update position size (base-equivalent) for short
            const addBaseEquiv = cfg.amount * aggr;
            const list = ThresholdTrader.positionsFor[instanceKey] || [];
            for (const p of list) {
              if (p.side === 'short' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym) {
                p.amountFrom = Number(p.amountFrom || 0) + addBaseEquiv;
                // update weighted-average entry with current pairPrice proxy
                const prevBase = Number(p.amountFrom || 0) - addBaseEquiv;
                if (prevBase > 0 && typeof p.entry === 'number') {
                  const newEntry = ((prevBase * p.entry) + (addBaseEquiv * pairPrice)) / (prevBase + addBaseEquiv);
                  p.entry = newEntry;
                  if (!ThresholdTrader.lastEntryPair[instanceKey]) ThresholdTrader.lastEntryPair[instanceKey] = {};
                  ThresholdTrader.lastEntryPair[instanceKey].short = newEntry;
                }
                (p as any).quoteAmountSold = Number((p as any).quoteAmountSold || 0) + addAmountQuote;
              }
            }
            ThresholdTrader.emitAllPositions();
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleShort');
            return; // at most one scale per tick
          } catch (e: any) {
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'scaleShort');
            logger.error('Scale short failed', { error: String(e?.message || e) });
            emit('log', { level: 'error', message: `terminal: scale short failed ${String(e?.message || e)}` , timestamp: new Date().toLocaleTimeString()});
          }
        }
      }
    }

    if (state.holding === 'long' && riseFromAnchor >= sellPct) {
      const inputMint = outputQuoteMint;
      const outputMint = inputBaseMint;
      if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'closeLong')) {
        logger.info('Skip duplicate close-long (in-flight)', { pair: `${fromSym}/${toSym}` });
        return;
      }
      emit('log', { level: 'info', message: `pretrade:close-long ${fromSym}/${toSym} at current=${pairPrice} target>=${sellTrigger}`, timestamp: new Date().toLocaleTimeString() });
      if (cfg.testMode) {
        logger.info('Test mode: closing long', { inputMint, outputMint, amount: cfg.amount });
      } else {
        try {
          ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'closeLong');
          // Closing long sells QUOTE -> BASE; restrict to this strategy's share
          const bal = await getBalances(new PublicKey(this.walletPubkey));
          const haveQuote = (toSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[toInfo.mint] || 0);
          const haveSol = Number(bal.sol || 0);
          const minSolForFees = Number((globalThis as any).process?.env?.MIN_SOL_FOR_FEES || 0.02);
          emit('log', { level: 'info', message: `pretrade:balances (close-long) quote=${haveQuote} ${toSym} sol=${haveSol}`, timestamp: new Date().toLocaleTimeString() });
          if (haveQuote <= 0) {
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeLong');
            return;
          }
          if (haveSol < minSolForFees) {
            logger.warn('Insufficient SOL for fees (close long)', { haveSol, minSolForFees });
            emit('log', { level: 'warn', message: `terminal: close long skipped - insufficient SOL for fees (~${minSolForFees})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeLong');
            return;
          }
          const posList = ThresholdTrader.positionsFor[instanceKey] || [];
          const pos = posList.find(p => p.side === 'long' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym);
          const entryLong = ThresholdTrader.lastEntryPair[instanceKey]?.long || (pos?.entry as number | undefined) || state.anchor || pairPrice;
          const desiredQuote = Math.max(0, Number((pos as any)?.quoteAmount ?? ((Number(pos?.amountFrom || 0)) * entryLong)));
          const quoteToSell = Math.min(haveQuote, desiredQuote);
          const amountInSmallest = Math.round(quoteToSell * 10 ** toInfo.decimals);
        const swapResultCloseLong = await executeSwap(
            { 
              inputMint, 
              outputMint, 
              amount: amountInSmallest, 
              userPublicKey: this.walletPubkey, 
              slippageBps: (cfg as any).slippageBps ?? 100,
              prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
              maxAccounts: CONFIG.fees.jupiterMaxAccounts,
              dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
              asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
            },
            this.walletSignAndSend,
            false, // priority
            fromInfo.decimals, // output decimals for received amount
            'strategy'
          );
          
        const sigCloseLong = swapResultCloseLong.signature;
        logger.info('Closed long (partial/total)', { sig: sigCloseLong });
        emit('log', { level: 'info', message: `trade:filled close-long sig=${sigCloseLong}` , timestamp: new Date().toLocaleTimeString()});
        emit('log', { level: 'info', message: `terminal: close long filled ${toSym}->${fromSym} amount=${quoteToSell}`, timestamp: new Date().toLocaleTimeString() });
          addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: toSym, fromAmount: quoteToSell, toToken: fromSym, toAmount: (typeof toUsd === 'number' && typeof fromUsd === 'number') ? (quoteToSell * (toUsd / fromUsd)) : undefined });
          try {
            const estBaseRecovered = (ThresholdTrader.lastEntryPair[instanceKey]?.long || entryLong) > 0 ? (quoteToSell / (ThresholdTrader.lastEntryPair[instanceKey]?.long || entryLong)) : undefined;
            (await import('../utils/tradeSummary.js')).logTrade({ ts: new Date().toISOString(), strategy: cfg.name || 'default', event: 'close-long', pair: `${fromSym}/${toSym}`, quoteSold: quoteToSell, estBaseRecovered, sig: sigCloseLong });
          } catch {}
          // Update position for partial close
          if (pos) {
            const remainingQuote = Math.max(0, desiredQuote - quoteToSell);
            (pos as any).quoteAmount = remainingQuote;
            if (entryLong > 0) {
              const baseRecovered = quoteToSell / entryLong;
              pos.amountFrom = Math.max(0, Number(pos.amountFrom || 0) - baseRecovered);
            }
          }
        } catch (e: any) {
          logger.error('Close long failed', { error: String(e?.message || e) });
          ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'close-long-error', token: `${toSym}->${fromSym}`, amount: cfg.amount, price: pairPrice });
          emit('log', { level: 'error', message: `terminal: close long failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString() });
          ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeLong');
          return;
        }
      }
      // Determine if fully closed (no remaining quote or base exposure)
      const posAfter = (ThresholdTrader.positionsFor[instanceKey] || []).find(p => p.side === 'long' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym);
      const remainingQuoteAmt = Number((posAfter as any)?.quoteAmount || 0);
      const remainingBaseAmt = Number(posAfter?.amountFrom || 0);
      const fullyClosed = (!posAfter) || (remainingQuoteAmt <= 1e-9) || (remainingBaseAmt <= 1e-9);
      if (fullyClosed) {
        state.holding = null;
        state.anchor = pairPrice;
        if (!(cfg as any).fixedAnchor) {
          (state as any).plannedAnchor = pairPrice;
        }
        // realized PnL (long) and trade summary
        if (fromUsd && typeof solUsd === 'number') {
          const entry = ThresholdTrader.lastEntryPair[instanceKey]?.long;
          const realizedBase = Number((posAfter?.amountFrom ? 0 : ((ThresholdTrader.positionsFor[instanceKey] || []).find(p => p.side === 'long' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym)?.amountFrom || cfg.amount || 0)) || 0);
          const pnlUsdc = typeof entry === 'number' ? ((pairPrice - entry) * realizedBase * fromUsd) : 0;
          ThresholdTrader.addPnl(cfg.name || 'default', pnlUsdc, pnlUsdc / solUsd);
          try { await (await import('../utils/tradeSummary')).writeTradeSummary({
            time: new Date().toISOString(),
            strategy: cfg.name || 'default',
            side: 'long',
            pair: `${fromSym}/${toSym}`,
            entryPair: entry,
            exitPair: pairPrice,
            baseAmount: realizedBase,
            pnlUSDC: pnlUsdc,
          }); } catch {}
        }
        ThresholdTrader.closePosition(instanceKey, 'long');
        ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'close-long', token: `${toSym}->${fromSym}`, amount: cfg.amount, price: pairPrice });
      } else {
        // Keep holding; emit positions to reflect partial close
        emit('activity', { strategy: cfg.name || 'default', status: 'holding', pair: `${fromSym}/${toSym}`, trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      }
      ThresholdTrader.emitAllPositions();
      ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeLong');
    } else if (state.holding === 'short' && dropFromAnchor >= buyPct) {
      // Close SHORT: spend toToken (e.g., USDC) to buy back fromToken (e.g., SOL)
      const inputMint = outputQuoteMint;  // USDC
      const outputMint = inputBaseMint;   // SOL
      if (ThresholdTrader.isInflight(this.walletPubkey, pairKey, 'closeShort')) {
        logger.info('Skip duplicate close-short (in-flight)', { pair: `${fromSym}/${toSym}` });
        return;
      }
      emit('log', { level: 'info', message: `pretrade:close-short ${fromSym}/${toSym} at current=${pairPrice} target<=${buyTrigger}`, timestamp: new Date().toLocaleTimeString() });
      if (cfg.testMode) {
        logger.info('Test mode: closing short', { inputMint, outputMint, amount: cfg.amount });
      } else {
        try {
          ThresholdTrader.setInflight(this.walletPubkey, pairKey, 'closeShort');
          // Closing short: buy back SOL using USDC; restrict to this strategy's share
          const bal = await getBalances(new PublicKey(this.walletPubkey));
          const haveBase = (toSym.toUpperCase() === 'SOL') ? (bal.sol || 0) : (bal.tokens[toInfo.mint] || 0);
          const haveSol = Number(bal.sol || 0);
          const minSolForFees = Number((globalThis as any).process?.env?.MIN_SOL_FOR_FEES || 0.02);
          emit('log', { level: 'info', message: `pretrade:balances (close-short) base=${haveBase} ${toSym} sol=${haveSol}`, timestamp: new Date().toLocaleTimeString() });
          if (toSym.toUpperCase() !== 'SOL' && haveSol < minSolForFees) {
            logger.warn('Insufficient SOL for fees (close short)', { haveSol, minSolForFees });
            emit('log', { level: 'warn', message: `terminal: close short skipped - insufficient SOL for fees (~${minSolForFees})`, timestamp: new Date().toLocaleTimeString() });
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeShort');
            return;
          }
          const posList2 = ThresholdTrader.positionsFor[instanceKey] || [];
          const pos2 = posList2.find(p => p.side === 'short' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym);
          const desiredQuoteToBuy = Math.max(0, Number((pos2 as any)?.quoteAmountSold ?? ((Number(pos2?.amountFrom || 0)) / Math.max(1e-12, (ThresholdTrader.lastEntryPair[instanceKey]?.short || state.anchor || pairPrice)))));
          const baseRequiredNow = desiredQuoteToBuy * pairPrice; // USDC required
          const baseCapacity = toSym.toUpperCase() === 'SOL' ? Math.max(0, haveBase - minSolForFees) : haveBase;
          const baseToSpend = Math.min(baseCapacity, baseRequiredNow);
          if (baseToSpend <= 0) {
            ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeShort');
            return;
          }
          const amountInSmallest = Math.round(baseToSpend * 10 ** toInfo.decimals);
        const swapResultCloseShort = await executeSwap(
            { 
              inputMint, 
              outputMint, 
              amount: amountInSmallest, 
              userPublicKey: this.walletPubkey, 
              slippageBps: (cfg as any).slippageBps ?? 100,
              prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
              maxAccounts: CONFIG.fees.jupiterMaxAccounts,
              dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
              asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
            },
            this.walletSignAndSend,
            false, // priority
            toInfo.decimals, // output decimals for received amount
            'strategy'
          );
          
        const sigCloseShort = swapResultCloseShort.signature;
        logger.info('Closed short (partial/total)', { sig: sigCloseShort });
        emit('log', { level: 'info', message: `trade:filled close-short sig=${sigCloseShort}` , timestamp: new Date().toLocaleTimeString()});
        emit('log', { level: 'info', message: `terminal: close short filled ${toSym}->${fromSym} amount=${baseToSpend}` , timestamp: new Date().toLocaleTimeString()});
          addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: toSym, fromAmount: baseToSpend, toToken: fromSym, toAmount: (baseToSpend / Math.max(1e-12, pairPrice)) });
          try {
            const estSolBought = baseToSpend / Math.max(1e-12, pairPrice);
            (await import('../utils/tradeSummary.js')).logTrade({ ts: new Date().toISOString(), strategy: cfg.name || 'default', event: 'close-short', pair: `${fromSym}/${toSym}`, usdcSpent: baseToSpend, estQuoteBought: estSolBought, sig: sigCloseShort });
          } catch {}
          // Update position for partial close
          if (pos2) {
            const quoteBought = baseToSpend / Math.max(1e-12, pairPrice);
            (pos2 as any).quoteAmountSold = Math.max(0, Number((pos2 as any).quoteAmountSold || desiredQuoteToBuy) - quoteBought);
            // amountFrom is SOL base-equivalent; reduce by SOL bought back
            pos2.amountFrom = Math.max(0, Number(pos2.amountFrom || 0) - quoteBought);
          }
        } catch (e: any) {
          logger.error('Close short failed', { error: String(e?.message || e) });
          ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'close-short-error', token: `${fromSym}->${toSym}`, amount: cfg.amount, price: pairPrice });
          emit('log', { level: 'error', message: `terminal: close short failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString() });
          ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeShort');
          return;
        }
      }
      // Determine if fully closed
      const posAfter2 = (ThresholdTrader.positionsFor[instanceKey] || []).find(p => p.side === 'short' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym);
      const remainingQuoteSold = Number((posAfter2 as any)?.quoteAmountSold || 0);
      const remainingBase2 = Number(posAfter2?.amountFrom || 0);
      const fullyClosed2 = (!posAfter2) || (remainingQuoteSold <= 1e-9) || (remainingBase2 <= 1e-9);
      if (fullyClosed2) {
        state.holding = null;
        state.anchor = pairPrice;
        if (!(cfg as any).fixedAnchor) {
          (state as any).plannedAnchor = pairPrice;
        }
        // realized PnL (short) and trade summary
        if (fromUsd && typeof solUsd === 'number') {
          const entry = ThresholdTrader.lastEntryPair[instanceKey]?.short;
          const realizedBase = Number((posAfter2?.amountFrom ? 0 : ((ThresholdTrader.positionsFor[instanceKey] || []).find(p => p.side === 'short' && (p.fromSymbol || fromSym) === fromSym && (p.toSymbol || toSym) === toSym)?.amountFrom || cfg.amount || 0)) || 0);
          const pnlUsdc = typeof entry === 'number' ? ((entry - pairPrice) * realizedBase * fromUsd) : 0;
          ThresholdTrader.addPnl(cfg.name || 'default', pnlUsdc, pnlUsdc / solUsd);
          try { await (await import('../utils/tradeSummary')).writeTradeSummary({
            time: new Date().toISOString(),
            strategy: cfg.name || 'default',
            side: 'short',
            pair: `${fromSym}/${toSym}`,
            entryPair: entry,
            exitPair: pairPrice,
            baseAmount: realizedBase,
            pnlUSDC: pnlUsdc,
          }); } catch {}
        }
        ThresholdTrader.closePosition(instanceKey, 'short');
        ThresholdTrader.addActivity(cfg.name || 'default', { time: new Date().toISOString(), action: 'close-short', token: `${fromSym}->${toSym}`, amount: cfg.amount, price: pairPrice });
      } else {
        emit('activity', { strategy: cfg.name || 'default', status: 'holding', pair: `${fromSym}/${toSym}`, trades: (ThresholdTrader.activityLogByStrategy[cfg.name || 'default'] || []).slice(-50) });
      }
      ThresholdTrader.emitAllPositions();
      ThresholdTrader.clearInflight(this.walletPubkey, pairKey, 'closeShort');
    }
  }

  static stateFor: Record<string, { anchor: number; holding: null | 'long' | 'short' }> = {};
  static positionsFor: Record<string, Array<{ mint: string; symbol?: string; side: 'long' | 'short'; entry: number; target: number; amountFrom?: number; quoteHeld?: number; fromSymbol?: string; toSymbol?: string; strategy?: string; openedAtMs?: number; meta?: { baseUsdAtOpen?: number; quoteUsdAtOpen?: number }; quoteAmount?: number; baseReceivedAtOpen?: number; quoteAmountSold?: number }>> = {};
  static activityLogByStrategy: Record<string, Array<{ time: string; action: string; token: string; amount: number; price: number }>> = {};
  private static lastEntryPair: Record<string, { long?: number; short?: number }> = {};
  private static balanceCheckFailures: Record<string, { lastCheck: number; retryCount: number; action: string }> = {};

  static openPosition(key: string, p: { mint: string; symbol?: string; side: 'long' | 'short'; entry: number; target: number; amountFrom?: number; fromSymbol?: string; toSymbol?: string; strategy?: string; openedAtMs?: number; meta?: { baseUsdAtOpen?: number; quoteUsdAtOpen?: number }; quoteAmount?: number; baseReceivedAtOpen?: number; quoteAmountSold?: number }) {
    if (!this.positionsFor[key]) this.positionsFor[key] = [];
    const withTime = { ...p, openedAtMs: p.openedAtMs ?? Date.now() };
    this.positionsFor[key].push(withTime);
    if (!this.lastEntryPair[key]) this.lastEntryPair[key] = {};
    if (p.side === 'long') this.lastEntryPair[key].long = withTime.entry;
    if (p.side === 'short') this.lastEntryPair[key].short = withTime.entry;
  }

  static closePosition(key: string, side: 'long' | 'short') {
    if (!this.positionsFor[key]) return;
    this.positionsFor[key] = this.positionsFor[key].filter((p) => p.side !== side);
  }

  static addActivity(strategyName: string, item: { time: string; action: string; token: string; amount: number; price: number }) {
    const name = strategyName || 'default';
    if (!this.activityLogByStrategy[name]) this.activityLogByStrategy[name] = [];
    this.activityLogByStrategy[name].push(item);
    if (this.activityLogByStrategy[name].length > 200) this.activityLogByStrategy[name].shift();
    const trades = this.activityLogByStrategy[name].slice(-50);
    emit('activity', { strategy: name, status: 'active', trades });
  }

  private static shouldRetryBalanceCheck(strategyName: string, action: string): boolean {
    const key = `${strategyName}:${action}`;
    const failure = this.balanceCheckFailures[key];
    if (!failure) return false;
    
    const now = Date.now();
    const timeSinceLastCheck = now - failure.lastCheck;
    const retryInterval = Math.min(30000, 5000 * Math.pow(2, failure.retryCount)); // Exponential backoff, max 30s
    
    return timeSinceLastCheck >= retryInterval && failure.retryCount < 5; // Max 5 retries
  }

  private static recordBalanceCheckFailure(strategyName: string, action: string): void {
    const key = `${strategyName}:${action}`;
    const now = Date.now();
    if (this.balanceCheckFailures[key]) {
      this.balanceCheckFailures[key].retryCount++;
      this.balanceCheckFailures[key].lastCheck = now;
    } else {
      this.balanceCheckFailures[key] = { lastCheck: now, retryCount: 1, action };
    }
  }

  private static clearBalanceCheckFailure(strategyName: string, action: string): void {
    const key = `${strategyName}:${action}`;
    delete this.balanceCheckFailures[key];
  }

  static addPnl(strategyName: string, usdc: number, sol: number) {
    if (!this.realizedPnlByStrategy[strategyName]) this.realizedPnlByStrategy[strategyName] = { usdc: 0, sol: 0 };
    this.realizedPnlByStrategy[strategyName].usdc += usdc;
    this.realizedPnlByStrategy[strategyName].sol += sol;
  }

  static emitAllPositions(): void {
    const all: any[] = [];
    for (const key of Object.keys(this.positionsFor || {})) {
      const arr = this.positionsFor[key] || [];
      for (const p of arr) all.push(p);
    }
    emit('positions', all);
  }

  start(pollMs = Math.max(500, (CONFIG as any).websocketIntervalMs || 1000)): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.interval = setInterval(() => {
      this.tick().catch((e) => logger.error('tick error', { error: String(e) }));
    }, pollMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.isRunning = false;
  }
}


