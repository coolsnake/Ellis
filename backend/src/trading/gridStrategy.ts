import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { fetchPricesByMints, executeSwap, SOL_MINT, getQuote } from '../jupiter/jupiter.js';
import { getAllPrices } from '../server/priceStore.js';
import { logger } from '../utils/logger.js';
import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { emit } from '../server/realtime.js';
import { resolveMint } from '../utils/tokens.js';
import { getBalances } from '../wallet/wallet.js';
import { addWalletHistory } from '../server/walletHistory.js';
import { writeTradeSummary } from '../utils/tradeSummary.js';

export type GridLevel = {
  id: string;
  price: number;
  side: 'buy' | 'sell';
  amount: number; // For buy: amount of fromToken to spend; For sell: amount of toToken to sell
  filled: boolean;
  filledAt?: number;
  filledPrice?: number;
  filledAmount?: number; // Actual amount that was filled
  actualReceivedAmount?: number; // For buy levels: actual toToken received; For sell levels: actual fromToken received
  transactionSignature?: string;
  pnl?: number;
  pairedLevelId?: string; // Links sell levels to their corresponding buy levels
};

export type GridPosition = {
  id: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice?: number;
  entryUsdPerTo?: number; // $ per toToken at entry (executed)
  exitUsdPerTo?: number; // $ per toToken at exit (executed)
  amount: number;
  filledAmount: number;
  pnl: number;
  openedAt: number;
  closedAt?: number;
  transactionSignature?: string;
  exitTransactionSignature?: string;
  status: 'pending' | 'filled' | 'closed' | 'failed';
  strategyName?: string;
  pairedPositionId?: string;
  intention?: string; // e.g., "buyID5 - Sell@xxx price"
  timeSinceOpen?: number; // milliseconds since opened
  // Stable pairing fields
  levelId?: string;
  pairedLevelId?: string;
  // Planned exit metadata for accurate UI rendering
  plannedExitSide?: 'buy' | 'sell';
  plannedExitLevelId?: string;
  plannedExitPrice?: number;
  plannedExitQtyIn?: number;
  plannedExitQtyOutEst?: number;
  plannedExitUsdPerTo?: number; // $ per toToken for planned exit at time of planning
};

export type GridStrategyConfig = {
  name?: string;
  fromToken?: string; // base asset symbol/mint (e.g., USDC or SOL)
  toToken?: string; // quote asset symbol/mint (e.g., SOL or dSOL)
  active?: boolean;
  testMode?: boolean;
  // Control flags
  onlyClose?: boolean; // if true, do not open new BUYs; allow only SELLs of existing inventory
  
  // Grid-specific parameters
  gridType: 'arithmetic' | 'geometric' | 'fibonacci';
  gridSpacing: number; // percentage or fixed amount
  gridLevels: number; // number of levels above and below center
  centerPrice?: number; // if not set, uses current market price
  totalAmount: number; // total amount to be distributed across grid
  levelAmount: number; // amount per grid level
  
  // Bias controls
  bias?: 'neutral' | 'long' | 'short';
  biasStrength?: number; // 0..1
  
  // Initial range settings
  initialBuyRange?: number; // percentage below center for initial buy levels
  initialSellRange?: number; // percentage above center for initial sell levels
  
  // Risk management
  maxPositions?: number;
  stopLoss?: number; // percentage below center price
  takeProfit?: number; // percentage above center price
  rebalanceThreshold?: number; // rebalance when price moves this % from center
  
  // Advanced features
  adaptiveSpacing?: boolean; // adjust spacing based on volatility
  volatilityPeriod?: number; // period for volatility calculation (in ticks)
  minLevelSpacing?: number; // minimum spacing between levels
  maxLevelSpacing?: number; // maximum spacing between levels
  
  // Sliding center price
  slidingCenter?: boolean; // enable sliding center price
  slideRate?: number; // rate of slide per second (in basis points)
  slideMaxDistance?: number; // maximum distance to slide from original center (in percentage)
  
  // Common trading parameters
  slippageBps?: number;
  cooldownMs?: number;
  feeBps?: number;
  extraSlippageBps?: number;
  minEdgeBps?: number;
};

export class GridTrader {
  private isRunning = false;
  private isTicking = false;
  private interval?: NodeJS.Timeout;
  private lastTickAt = Date.now();
  static globalHalt = false;
  static setGlobalHalt(val: boolean) { this.globalHalt = val; }
  static realizedPnlByInstance: Record<string, Record<string, number>> = {};
  
  // Grid state management
  private static gridLevels: Record<string, GridLevel[]> = {};
  private static gridPositions: Record<string, GridPosition[]> = {};
  private static tradeHistory: Record<string, GridPosition[]> = {}; // Persistent trade history
  private static gridState: Record<string, {
    centerPrice: number;
    originalCenterPrice: number; // Store original center price for sliding calculations
    lastRebalance: number;
    volatility: number;
    totalFilled: number;
    totalPnl: number;
    lastSlideUpdate: number; // Track last slide update time
    completedCycles: number; // Track completed buy/sell cycles
    totalTrades: number; // Track total number of trades executed
    atasEnsured?: boolean; // ensure ATAs precreated only once per instance
    configSignature: string;
    fromToken: string;
    toToken: string;
    strategyName: string;
  }> = {};
  
  // In-flight operation tracking
  private static readonly INFLIGHT_TIMEOUT_MS = 20000;
  private static inflightByInstance: Record<string, Record<string, { 
    gridBuy?: number; 
    gridSell?: number; 
    rebalance?: number;
  }>> = {};
  
  // Priority execution queue for grid levels
  private static priorityExecutionQueue: Array<{
    instanceKey: string;
    levelId: string;
    priority: number; // Higher number = higher priority
    timestamp: number;
  }> = [];
  
  private static isInflight(instanceKey: string, pairKey: string, kind: 'gridBuy'|'gridSell'|'rebalance'): boolean {
    const now = Date.now();
    const byPair = this.inflightByInstance[instanceKey]?.[pairKey];
    if (!byPair) return false;
    const ts = byPair[kind];
    if (!ts) return false;
    if (now - ts > this.INFLIGHT_TIMEOUT_MS) {
      delete byPair[kind];
      return false;
    }
    return true;
  }
  
  private static setInflight(instanceKey: string, pairKey: string, kind: 'gridBuy'|'gridSell'|'rebalance'): void {
    if (!this.inflightByInstance[instanceKey]) this.inflightByInstance[instanceKey] = {} as any;
    if (!this.inflightByInstance[instanceKey][pairKey]) this.inflightByInstance[instanceKey][pairKey] = {} as any;
    this.inflightByInstance[instanceKey][pairKey][kind] = Date.now();
  }
  
  private static clearInflight(instanceKey: string, pairKey: string, kind: 'gridBuy'|'gridSell'|'rebalance'): void {
    const byPair = this.inflightByInstance[instanceKey]?.[pairKey];
    if (byPair && byPair[kind]) delete byPair[kind];
  }

  private async validateTransactionSuccess(signature: string): Promise<boolean> {
    try {
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const commitment: any = (CONFIG as any).system?.txCommitment || 'confirmed';
      const transaction = await connection.getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: 0
      });
      
      if (!transaction) {
        logger.warn('Transaction not found', { signature });
        return false;
      }
      
      if (transaction.meta?.err) {
        logger.error('Transaction failed with error', { 
          signature, 
          error: transaction.meta.err 
        });
        return false;
      }
      
      logger.debug('Transaction validated successfully', { signature, commitment });
      return true;
    } catch (error) {
      logger.error('Failed to validate transaction', { 
        signature, 
        error: String(error) 
      });
      return false;
    }
  }

  constructor(private readonly walletPubkey: string, private readonly walletSignAndSend: (tx: any) => Promise<string>) {}

  async loadConfig(): Promise<GridStrategyConfig> {
    return readJson<GridStrategyConfig>(CONFIG.strategyConfigPath, {
      fromToken: 'USDC',
      toToken: 'SOL',
      gridType: 'arithmetic',
      gridSpacing: 0.01, // 1%
      gridLevels: 5,
      totalAmount: 1.0,
      levelAmount: 0.1,
      active: false,
    });
  }

  async tick(): Promise<void> {
    if (this.isTicking) {
      logger.debug('Grid tick skipped - previous tick still running', { wallet: this.walletPubkey });
      return;
    }
    this.isTicking = true;
    try {
      const cfg = await this.loadConfig();
      const instanceKey = `${this.walletPubkey}:${cfg.name || 'grid-default'}`;
      if (cfg.active === false) {
        emit('activity', { 
          strategy: cfg.name || 'grid-default', 
          status: 'idle', 
          trades: (GridTrader.activityLogByInstance[instanceKey] || []).slice(-50) 
        });
        return;
      }

      const fromSym = cfg.fromToken || 'USDC';
      const toSym = cfg.toToken || 'SOL';
      const fromInfo = await resolveMint(fromSym);
      const toInfo = await resolveMint(toSym);
      
      logger.info(`Grid strategy tick`, {
        strategy: cfg.name,
        fromToken: fromSym,
        toToken: toSym,
        fromMint: fromInfo.mint,
        toMint: toInfo.mint,
        fromDecimals: fromInfo.decimals,
        toDecimals: toInfo.decimals,
        config: {
          fromToken: cfg.fromToken,
          toToken: cfg.toToken,
          active: cfg.active
        }
      });
      const prices = getAllPrices();
      let fromUsd: number | null = prices[fromInfo.mint]?.usdc ?? null;
      let toUsd: number | null = prices[toInfo.mint]?.usdc ?? null;
      let solUsd: number | null = prices[SOL_MINT]?.usdc ?? null;
      
      if (!fromUsd || !toUsd || !solUsd) {
        try {
          const fresh = await fetchPricesByMints([fromInfo.mint, toInfo.mint, SOL_MINT], { catOverride: 'strategy' });
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

      logger.info('Price calculation', {
        fromToken: fromSym,
        toToken: toSym,
        fromUsd,
        toUsd,
        pairPrice,
        calculation: `${toUsd} / ${fromUsd} = ${pairPrice}`
      });

      const pairKey = `${fromInfo.mint}->${toInfo.mint}`;
      const configSignature = JSON.stringify({
        fromToken: fromSym,
        toToken: toSym,
        gridType: cfg.gridType,
        gridSpacing: cfg.gridSpacing,
        gridLevels: cfg.gridLevels,
        levelAmount: cfg.levelAmount,
        initialBuyRange: cfg.initialBuyRange,
        initialSellRange: cfg.initialSellRange,
        bias: cfg.bias || 'neutral',
        biasStrength: Math.max(0, Math.min(1, cfg.biasStrength ?? 0))
      });
    
      // Initialize grid state if needed
      if (!GridTrader.gridState[instanceKey]) {
        GridTrader.gridState[instanceKey] = {
          centerPrice: cfg.centerPrice || pairPrice,
          originalCenterPrice: cfg.centerPrice || pairPrice,
          lastRebalance: Date.now(),
          volatility: 0,
          totalFilled: 0,
          totalPnl: 0,
          lastSlideUpdate: Date.now(),
          completedCycles: 0,
          totalTrades: 0,
          configSignature,
          fromToken: fromSym,
          toToken: toSym,
          strategyName: cfg.name || 'grid-default',
        };
      }

      const state = GridTrader.gridState[instanceKey];

      if (state.configSignature !== configSignature || state.fromToken !== fromSym || state.toToken !== toSym) {
        logger.info('Grid configuration changed, reconfiguring (preserve positions)', {
          instanceKey,
          oldConfig: { fromToken: state.fromToken, toToken: state.toToken },
          newConfig: { fromToken: fromSym, toToken: toSym }
        });
        GridTrader.reconfigureInstancePreserve(instanceKey, cfg.name || 'grid-default', cfg.centerPrice || pairPrice, configSignature, fromSym, toSym);
        // Rebuild pending levels under new configuration while keeping filled levels and positions
        this.rebuildPendingLevels(cfg, instanceKey, GridTrader.gridState[instanceKey]?.centerPrice || (cfg.centerPrice || pairPrice));
      }
    
    // Ensure ATAs for both legs exist once (pre-create to avoid churn)
    try {
      const stateRef = GridTrader.gridState[instanceKey];
      if (!stateRef.atasEnsured) {
        const { ensureWallet, getOrCreateTokenAccount } = await import('../wallet/wallet.js');
        const kp = await ensureWallet(CONFIG.walletPath);
        const { PublicKey } = await import('@solana/web3.js');
        await getOrCreateTokenAccount(new PublicKey(fromInfo.mint), kp.publicKey, kp);
        await getOrCreateTokenAccount(new PublicKey(toInfo.mint), kp.publicKey, kp);
        stateRef.atasEnsured = true;
        logger.info('ATAs ensured for strategy instance', { instanceKey, fromMint: fromInfo.mint, toMint: toInfo.mint });
      }
    } catch (e: any) {
      logger.warn('ATA pre-create skipped', { error: String(e?.message || e) });
    }

    // Update sliding center price if enabled
    if (cfg.slidingCenter && cfg.slideRate && cfg.slideMaxDistance) {
      this.updateSlidingCenter(cfg, state, pairPrice, instanceKey);
    }
    
    // Check if rebalancing is needed
    if (this.shouldRebalance(cfg, state, pairPrice)) {
      await this.rebalanceGrid(cfg, instanceKey, pairKey, pairPrice, fromInfo, toInfo);
    }
    
      // Update grid levels if not initialized
      if (!GridTrader.gridLevels[instanceKey] || GridTrader.gridLevels[instanceKey].length === 0) {
        await this.initializeGrid(cfg, instanceKey, state.centerPrice);
      }
      
      // Update grid level statuses based on active positions
      GridTrader.updateGridLevelStatuses(instanceKey);
      
      // Check for level hits and execute trades
      await this.checkAndExecuteLevels(cfg, instanceKey, pairKey, pairPrice, fromInfo, toInfo, fromUsd, toUsd, solUsd);
      
      // Emit activity update
      this.emitGridActivity(cfg, instanceKey, pairPrice, fromSym, toSym);
    } finally {
      this.isTicking = false;
    }
  }

  private updateSlidingCenter(cfg: GridStrategyConfig, state: any, currentPrice: number, instanceKey: string): void {
    const now = Date.now();
    const timeDelta = (now - state.lastSlideUpdate) / 1000; // Convert to seconds
    
    if (timeDelta < 0.1) return; // Update at most 10 times per second for more responsive sliding
    
    const slideRate = cfg.slideRate! / 10000; // Convert basis points to decimal
    const maxDistance = cfg.slideMaxDistance! / 100; // Convert percentage to decimal
    
    // Calculate the target center price (slide towards current price)
    const priceDifference = currentPrice - state.centerPrice;
    
    // Use percentage-based sliding that respects direction
    const slideAmount = priceDifference * slideRate * timeDelta;
    
    // Apply the slide with maximum distance constraint
    const newCenterPrice = state.centerPrice + slideAmount;
    const maxSlideDistance = state.originalCenterPrice * maxDistance;
    
    // Constrain the new center price within the maximum distance
    const constrainedCenterPrice = Math.max(
      state.originalCenterPrice - maxSlideDistance,
      Math.min(state.originalCenterPrice + maxSlideDistance, newCenterPrice)
    );
    
    // Additional safety: ensure we're sliding towards the current price, not away from it
    const finalCenterPrice = Math.abs(constrainedCenterPrice - currentPrice) < Math.abs(state.centerPrice - currentPrice) 
      ? constrainedCenterPrice 
      : state.centerPrice;
    
    // Only update if the change is significant enough (lowered threshold for more responsive sliding)
    const priceChange = Math.abs(finalCenterPrice - state.centerPrice) / state.centerPrice;
    if (priceChange > 0.0001) { // 0.01% minimum change (more sensitive)
      const oldCenterPrice = state.centerPrice;
      state.centerPrice = finalCenterPrice;
      state.lastSlideUpdate = now;
      
      // Adjust grid levels to match the new center price
      this.adjustGridLevelsForSlidingCenter(cfg, instanceKey, oldCenterPrice, state.centerPrice);
      
      logger.info('Sliding center price updated', {
        originalCenter: state.originalCenterPrice,
        oldCenter: oldCenterPrice,
        newCenter: state.centerPrice,
        currentPrice,
        priceDifference,
        slideAmount,
        priceChange: priceChange * 100,
        direction: priceDifference > 0 ? 'up' : 'down'
      });
    }
  }

  private adjustGridLevelsForSlidingCenter(cfg: GridStrategyConfig, instanceKey: string, oldCenterPrice: number, newCenterPrice: number): void {
    const levels = GridTrader.gridLevels[instanceKey];
    if (!levels || levels.length === 0) return;

    const priceRatio = newCenterPrice / oldCenterPrice;
    const adjustedLevels: any[] = [];
    
    // Adjust all unfilled levels to maintain their relative positions
    levels.forEach(level => {
      if (!level.filled) {
        // Calculate the new price based on the center price change
        const oldPrice = level.price;
        const newPrice = oldPrice * priceRatio;
        
        // Update the level price
        level.price = newPrice;
        
        // Note: We don't update the level ID to preserve pairing relationships
        // The original ID (e.g., "buy-6", "sell-6") is needed for pairedLevelId references
        
        adjustedLevels.push({
          side: level.side,
          oldPrice,
          newPrice,
          levelId: level.id,
          pairedLevelId: level.pairedLevelId
        });
        
        logger.debug('Adjusted grid level for sliding center', {
          side: level.side,
          oldPrice,
          newPrice,
          priceRatio,
          levelId: level.id,
          pairedLevelId: level.pairedLevelId
        });
      }
    });

    // Sort levels by price to maintain proper order
    levels.sort((a, b) => a.price - b.price);
    
    // Emit real-time update to frontend
    emit('gridLevels', { instanceKey, levels: GridTrader.gridLevels[instanceKey] });
    
    logger.info('Grid levels adjusted for sliding center', {
      instanceKey,
      oldCenterPrice,
      newCenterPrice,
      priceRatio,
      adjustedLevels: adjustedLevels.length,
      totalLevels: levels.length,
      adjustedLevelsDetails: adjustedLevels
    });
  }

  private shouldRebalance(cfg: GridStrategyConfig, state: any, currentPrice: number): boolean {
    if (!cfg.rebalanceThreshold) return false;
    
    const priceChange = Math.abs(currentPrice - state.centerPrice) / state.centerPrice;
    const timeSinceRebalance = Date.now() - state.lastRebalance;
    const minRebalanceInterval = 60000; // 1 minute minimum
    
    return priceChange >= cfg.rebalanceThreshold && timeSinceRebalance >= minRebalanceInterval;
  }

  private async rebalanceGrid(
    cfg: GridStrategyConfig, 
    instanceKey: string, 
    pairKey: string, 
    currentPrice: number,
    fromInfo: any,
    toInfo: any
  ): Promise<void> {
    if (GridTrader.isInflight(this.walletPubkey, pairKey, 'rebalance')) {
      return;
    }

    try {
    GridTrader.setInflight(instanceKey, pairKey, 'rebalance');
      
      logger.info('Rebalancing grid', { instanceKey, currentPrice });
      emit('log', { 
        level: 'info', 
        message: `Grid rebalancing: ${cfg.name || 'default'} at price ${currentPrice}`, 
        timestamp: new Date().toLocaleTimeString(),
        context: { cat: 'strategy' }
      });

      // Close all unfilled levels
      const unfilledLevels = GridTrader.gridLevels[instanceKey]?.filter(level => !level.filled) || [];
      for (const level of unfilledLevels) {
        // Mark as cancelled (in a real implementation, you might want to cancel actual orders)
        level.filled = true;
        level.filledAt = Date.now();
      }

      // Update center price and reinitialize grid
      GridTrader.gridState[instanceKey].centerPrice = currentPrice;
      GridTrader.gridState[instanceKey].originalCenterPrice = currentPrice; // Reset original center on rebalance
      GridTrader.gridState[instanceKey].lastRebalance = Date.now();
      
      await this.initializeGrid(cfg, instanceKey, currentPrice);
      
      GridTrader.clearInflight(instanceKey, pairKey, 'rebalance');
    } catch (e: any) {
      logger.error('Grid rebalancing failed', { error: String(e?.message || e) });
      GridTrader.clearInflight(instanceKey, pairKey, 'rebalance');
    }
  }

  private async initializeGrid(cfg: GridStrategyConfig, instanceKey: string, centerPrice: number): Promise<void> {
    const levels: GridLevel[] = [];
    const spacing = cfg.gridSpacing;
    const numLevels = cfg.gridLevels;
    const levelAmount = cfg.levelAmount;
    // Bias handling (clamped)
    const bias = cfg.bias || 'neutral';
    const biasStrength = Math.max(0, Math.min(1, cfg.biasStrength ?? 0));
    const buyMult = 1 + (bias === 'long' ? -biasStrength : bias === 'short' ? biasStrength : 0);
    const sellMult = 1 + (bias === 'short' ? -biasStrength : bias === 'long' ? biasStrength : 0);
    const buySpacing = spacing * buyMult;
    const sellSpacing = spacing * sellMult;
    const initialBuyRange = (cfg.initialBuyRange || 0.05) * buyMult; // Default 5% adjusted by bias
    const initialSellRange = (cfg.initialSellRange || 0.05) * sellMult; // Default 5% adjusted by bias

    // Calculate grid levels based on type
    for (let i = 1; i <= numLevels; i++) {
      // Buy levels (below center) - use initial range for first level, then spacing
      const buyPrice = cfg.gridType === 'arithmetic'
        ? centerPrice * (1 - (initialBuyRange + (i - 1) * buySpacing))
        : i === 1
          ? centerPrice * (1 - initialBuyRange)
          : this.calculateGridPrice(cfg.gridType, centerPrice * (1 - initialBuyRange), -(i - 1), buySpacing);
      const buyLevelId = `buy-${i}`;
      levels.push({
        id: buyLevelId,
        price: buyPrice,
        side: 'buy',
        amount: levelAmount, // Amount of fromToken to spend
        filled: false,
      });

      // Sell levels (above center) - use initial range for first level, then spacing
      const sellPrice = cfg.gridType === 'arithmetic'
        ? centerPrice * (1 + (initialSellRange + (i - 1) * sellSpacing))
        : i === 1
          ? centerPrice * (1 + initialSellRange)
          : this.calculateGridPrice(cfg.gridType, centerPrice * (1 + initialSellRange), i - 1, sellSpacing);
      const sellLevelId = `sell-${i}`;
      levels.push({
        id: sellLevelId,
        price: sellPrice,
        side: 'sell',
        amount: levelAmount,
        filled: false,
        pairedLevelId: buyLevelId, // Link to corresponding buy level
      });
    }

    GridTrader.gridLevels[instanceKey] = levels;
    
    logger.info('Grid initialized', { 
      instanceKey, 
      centerPrice, 
      levels: levels.length,
      buyLevels: levels.filter(l => l.side === 'buy').length,
      sellLevels: levels.filter(l => l.side === 'sell').length,
      levelPrices: levels.map(l => ({ id: l.id, side: l.side, price: l.price }))
    });
  }

  private calculateGridPrice(type: string, centerPrice: number, level: number, spacing: number): number {
    switch (type) {
      case 'arithmetic':
        return centerPrice + (level * centerPrice * spacing);
      case 'geometric':
        return centerPrice * Math.pow(1 + spacing, level);
      case 'fibonacci':
        const fibRatio = this.getFibonacciRatio(Math.abs(level));
        return centerPrice * (1 + (level > 0 ? fibRatio : -fibRatio) * spacing);
      default:
        return centerPrice + (level * centerPrice * spacing);
    }
  }

  // Rebuild only pending (unfilled) levels using current configuration and center price
  private rebuildPendingLevels(cfg: GridStrategyConfig, instanceKey: string, centerPrice: number): void {
    const existing = GridTrader.gridLevels[instanceKey] || [];
    const filled = existing.filter(l => l.filled);

    const levels: GridLevel[] = [];
    const spacing = cfg.gridSpacing;
    const numLevels = cfg.gridLevels;
    const levelAmount = cfg.levelAmount;
    // Bias handling aligns with initializeGrid
    const bias = cfg.bias || 'neutral';
    const biasStrength = Math.max(0, Math.min(1, cfg.biasStrength ?? 0));
    const buyMult = 1 + (bias === 'long' ? -biasStrength : bias === 'short' ? biasStrength : 0);
    const sellMult = 1 + (bias === 'short' ? -biasStrength : bias === 'long' ? biasStrength : 0);
    const buySpacing = spacing * buyMult;
    const sellSpacing = spacing * sellMult;
    const initialBuyRange = (cfg.initialBuyRange || 0.05) * buyMult;
    const initialSellRange = (cfg.initialSellRange || 0.05) * sellMult;

    // Map existing filled levels by id for pairing preservation
    const filledById = new Map(filled.map(l => [l.id, l] as const));

    for (let i = 1; i <= numLevels; i++) {
      const buyId = `buy-${i}`;
      const sellId = `sell-${i}`;
      const hasFilledBuy = filledById.has(buyId);
      const hasFilledSell = filledById.has(sellId);

      // Buy level
      if (!hasFilledBuy) {
        const buyPrice = cfg.gridType === 'arithmetic'
          ? centerPrice * (1 - (initialBuyRange + (i - 1) * buySpacing))
          : i === 1
            ? centerPrice * (1 - initialBuyRange)
            : this.calculateGridPrice(cfg.gridType, centerPrice * (1 - initialBuyRange), -(i - 1), buySpacing);
        levels.push({ id: buyId, price: buyPrice, side: 'buy', amount: levelAmount, filled: false });
      }

      // Sell level
      if (!hasFilledSell) {
        const sellPrice = cfg.gridType === 'arithmetic'
          ? centerPrice * (1 + (initialSellRange + (i - 1) * sellSpacing))
          : i === 1
            ? centerPrice * (1 + initialSellRange)
            : this.calculateGridPrice(cfg.gridType, centerPrice * (1 + initialSellRange), i - 1, sellSpacing);
        levels.push({ id: sellId, price: sellPrice, side: 'sell', amount: 0, filled: false, pairedLevelId: buyId });
      }
    }

    // Keep all previously filled levels
    GridTrader.gridLevels[instanceKey] = [...filled, ...levels];

    emit('gridLevels', { instanceKey, levels: GridTrader.gridLevels[instanceKey] });
    logger.info('Rebuilt pending grid levels after reconfiguration', {
      instanceKey,
      centerPrice,
      filledCount: filled.length,
      rebuiltPending: levels.length
    });
  }

  private getFibonacciRatio(n: number): number {
    if (n <= 1) return 1;
    let a = 1, b = 1;
    for (let i = 2; i <= n; i++) {
      const temp = a + b;
      a = b;
      b = temp;
    }
    return b / a;
  }

  private async checkAndExecuteLevels(
    cfg: GridStrategyConfig,
    instanceKey: string,
    pairKey: string,
    currentPrice: number,
    fromInfo: any,
    toInfo: any,
    fromUsd: number | null,
    toUsd: number | null,
    solUsd: number | null
  ): Promise<void> {
    const levels = GridTrader.gridLevels[instanceKey] || [];
    const unfilledLevels = levels.filter(level => !level.filled);

    logger.info(`Executing grid levels check`, {
      strategy: cfg.name,
      totalLevels: levels.length,
      unfilledLevels: unfilledLevels.length,
      currentPrice,
      levels: unfilledLevels.map(l => ({ id: l.id, side: l.side, price: l.price, amount: l.amount }))
    });

    // Sort levels by priority (closer to current price = higher priority)
    const prioritizedLevels = unfilledLevels
      .filter(level => {
        // When onlyClose is enabled, skip BUY levels entirely
        if (cfg.onlyClose && level.side === 'buy') return false;
        return this.shouldExecuteLevel(level, currentPrice);
      })
      .map(level => ({
        level,
        priority: this.calculateLevelPriority(cfg, level, currentPrice)
      }))
      .sort((a, b) => b.priority - a.priority); // Higher priority first

    logger.info(`Executing prioritized grid levels`, {
      strategy: cfg.name,
      totalLevels: levels.length,
      unfilledLevels: unfilledLevels.length,
      executableLevels: prioritizedLevels.length,
      currentPrice,
      prioritizedLevels: prioritizedLevels.map(p => ({ 
        id: p.level.id, 
        side: p.level.side, 
        price: p.level.price, 
        priority: p.priority 
      }))
    });

    // Execute levels in priority order
    for (const { level, priority } of prioritizedLevels) {
      logger.info(`Executing high-priority grid level`, {
          levelId: level.id,
          side: level.side,
          price: level.price,
          amount: level.amount,
          currentPrice,
          pairedLevelId: level.pairedLevelId,
        isSellWithAmount: level.side === 'sell' && level.amount > 0,
        priority
        });
      
      // Execute the level immediately with high priority
        await this.executeGridLevel(cfg, instanceKey, pairKey, level, currentPrice, fromInfo, toInfo, fromUsd, toUsd, solUsd);
      }
    }

  private calculateLevelPriority(cfg: GridStrategyConfig, level: GridLevel, currentPrice: number): number {
    // Calculate priority based on how close the level is to current price
    // Closer levels get higher priority (higher number)
    const priceDifference = Math.abs(level.price - currentPrice);
    const priceRatio = priceDifference / currentPrice;
    
    // Base priority: 1000 - (price difference as percentage * 1000)
    // This means levels closer to current price get higher priority
    let priority = Math.max(0, 1000 - (priceRatio * 1000));
    
    // Boost priority for sell levels with amount (ready to execute)
    if (level.side === 'sell' && level.amount > 0) {
      priority += 500;
    }
    
    // Boost priority for buy levels (usually more critical)
    if (level.side === 'buy') {
      priority += 200;
    }
    
    // Bias-based nudging
    const bias = cfg.bias || 'neutral';
    const biasStrength = Math.max(0, Math.min(1, cfg.biasStrength ?? 0));
    const biasBoost = Math.floor(300 * biasStrength);
    if (bias === 'long' && level.side === 'buy') {
      priority += biasBoost;
    } else if (bias === 'short' && level.side === 'sell') {
      priority += biasBoost;
    }
    
    return priority;
  }

  private shouldExecuteLevel(level: GridLevel, currentPrice: number): boolean {
    // Add a tiny epsilon to avoid simultaneous buy/sell triggers at identical prices
    const eps = Math.max(1e-9, currentPrice * 1e-6);
    if (level.side === 'buy') {
      return currentPrice < (level.price - eps);
    } else {
      return currentPrice > (level.price + eps);
    }
  }

  private async executeGridLevel(
    cfg: GridStrategyConfig,
    instanceKey: string,
    pairKey: string,
    level: GridLevel,
    currentPrice: number,
    fromInfo: any,
    toInfo: any,
    fromUsd: number | null,
    toUsd: number | null,
    solUsd: number | null
  ): Promise<void> {
    const operation = level.side === 'buy' ? 'gridBuy' : 'gridSell';
    
    if (GridTrader.isInflight(instanceKey, pairKey, operation)) {
      return;
    }

    try {
      GridTrader.setInflight(instanceKey, pairKey, operation);
      
      logger.info(`Executing grid ${level.side}`, { 
        level: level.id, 
        price: level.price, 
        currentPrice,
        amount: level.amount 
      });

      emit('log', { 
        level: 'info', 
        message: `Grid ${level.side}: ${level.id} at ${currentPrice} (target: ${level.price})`, 
        timestamp: new Date().toLocaleTimeString(),
        context: { cat: 'strategy' }
      });

      if (cfg.testMode) {
        // Simulate execution
        level.filled = true;
        level.filledAt = Date.now();
        level.filledPrice = Math.abs(currentPrice);
        level.filledAmount = level.amount;
        level.transactionSignature = `test-${Date.now()}`;
        
        // Do not emit a second current-price activity; executed activity already emitted above
      } else {
        // Execute actual trade
        const inputMint = level.side === 'buy' ? fromInfo.mint : toInfo.mint;
        const outputMint = level.side === 'buy' ? toInfo.mint : fromInfo.mint;
        
        // Use correct decimals for the input token
        const inputDecimals = level.side === 'buy' ? fromInfo.decimals : toInfo.decimals;
        
        // Determine amount to use
        // - Buy: use configured level.amount (fromToken units)
        // - Sell: require preset amount from paired buy; skip sell-first path
        let amountToUse = level.amount;
        if (level.side === 'sell' && (!amountToUse || amountToUse <= 0)) {
          logger.warn('Skipping sell without paired buy amount', {
            levelId: level.id,
            pairedLevelId: level.pairedLevelId,
            amountToUse
          });
          GridTrader.clearInflight(instanceKey, pairKey, operation);
          return;
        }
        
        logger.debug('Amount calculation for execution', {
          levelId: level.id,
          levelSide: level.side,
          amountToUse,
          inputDecimals,
          amountInSmallest: Math.round(amountToUse * Math.pow(10, inputDecimals)),
          pairedLevelId: level.pairedLevelId,
          actualReceivedAmount: level.actualReceivedAmount
        });
        
        // Prefer exact raw smallest-unit amounts when available to avoid rounding drift
        let amountInSmallest: number;
        if (level.side === 'sell') {
          const raw = (level as any).amountRaw as string | undefined;
          if (typeof raw === 'string' && /^\d+$/.test(raw)) amountInSmallest = Number(raw);
          else amountInSmallest = Math.round(amountToUse * Math.pow(10, inputDecimals));
        } else {
          amountInSmallest = Math.round(amountToUse * Math.pow(10, inputDecimals));
        }
        
        // Check balances
        const bal = await getBalances(new PublicKey(this.walletPubkey));
        
        // Debug: Check if wallet has any balance at all
        if (bal.sol === 0 && Object.keys(bal.tokens).length === 0) {
          logger.warn(`Wallet appears to have no balance at all`, {
            walletPubkey: this.walletPubkey,
            balSol: bal.sol,
            tokenCount: Object.keys(bal.tokens).length
          });
        }
        
        // Determine which token we need for this operation
        let haveInput: number;
        if (level.side === 'buy') {
          // For buy: we need fromToken (the token we're spending)
          if (cfg.fromToken?.toUpperCase() === 'SOL') {
            haveInput = bal.sol || 0;
          } else {
            haveInput = bal.tokens[fromInfo.mint] || 0;
          }
        } else {
          // For sell: we need toToken (the token we're selling)
          if (cfg.toToken?.toUpperCase() === 'SOL') {
            haveInput = bal.sol || 0;
          } else {
            haveInput = bal.tokens[toInfo.mint] || 0;
          }
        }
        
        // For balance check, compare required input amount to wallet holdings
        const requiredInput = amountToUse;
        
        logger.info(`Grid balance check`, {
          side: level.side,
          fromToken: cfg.fromToken,
          toToken: cfg.toToken,
          fromMint: fromInfo.mint,
          toMint: toInfo.mint,
          inputMint,
          haveInput,
          need: requiredInput,
          levelAmount: level.amount,
          balSol: bal.sol,
          balTokens: Object.keys(bal.tokens).length,
          tokenBalances: Object.entries(bal.tokens).map(([mint, amount]) => ({ mint, amount })),
          walletPubkey: this.walletPubkey
        });
        
        if (haveInput < requiredInput) {
          logger.warn(`Insufficient balance for grid ${level.side}`, { 
            need: requiredInput, 
            have: haveInput,
            levelAmount: level.amount
          });
          GridTrader.clearInflight(instanceKey, pairKey, operation);
          return;
        }

        // Enforce epsilon for SELL execution to avoid zero-amount operations
        if (level.side === 'sell') {
          const EPS = 1e-9;
          if (!(amountToUse > EPS)) {
            logger.warn('Skipping sell execution due to non-positive amount after checks', {
              levelId: level.id,
              amountToUse
            });
            GridTrader.clearInflight(instanceKey, pairKey, operation);
            return;
          }
        }

        // Get the correct output decimals for the received amount calculation
        const outputDecimals = level.side === 'buy' ? toInfo.decimals : fromInfo.decimals;
        
        logger.debug('Grid level execution decimal info', {
          levelSide: level.side,
          fromToken: cfg.fromToken,
          toToken: cfg.toToken,
          fromDecimals: fromInfo.decimals,
          toDecimals: toInfo.decimals,
          outputDecimals,
          inputMint,
          outputMint
        });
        
        // Pre-send price re-check: ensure the trigger condition still holds
        try {
          const fresh = await fetchPricesByMints([fromInfo.mint, toInfo.mint, SOL_MINT], { catOverride: 'strategy' });
          const freshFromUsd = fresh[fromInfo.mint]?.usdc ?? fromUsd;
          const freshToUsd = fresh[toInfo.mint]?.usdc ?? toUsd;
          const freshPairPrice = (freshFromUsd && freshToUsd) ? (freshToUsd / freshFromUsd) : undefined;
          if (typeof freshPairPrice === 'number') {
            if (!this.shouldExecuteLevel(level, freshPairPrice)) {
              logger.info('Grid level condition no longer holds at send time, skipping', {
                levelId: level.id,
                side: level.side,
                targetPrice: level.price,
                freshPairPrice
              });
              GridTrader.clearInflight(instanceKey, pairKey, operation);
              return;
            }
          }
        } catch (e: any) {
          logger.warn('Pre-send price re-check failed, proceeding with caution', { error: String(e?.message || e) });
        }

        const swapResult = await executeSwap(
          { 
            inputMint, 
            outputMint, 
            amount: amountInSmallest, 
            userPublicKey: this.walletPubkey, 
            slippageBps: cfg.slippageBps ?? 100,
            prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
            maxAccounts: CONFIG.fees.jupiterMaxAccounts,
            dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
            asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
          },
          this.walletSignAndSend,
          false, // priority
          outputDecimals,
          'strategy'
        );
        
        const sig = (swapResult as any).signature || (typeof (swapResult as any) === 'string' ? (swapResult as any) : undefined);
        const actualReceivedAmount = (swapResult as any).receivedAmountActual ?? swapResult.receivedAmount;
        const actualReceivedRaw = (swapResult as any).receivedAmountRawActual as string | undefined;
        
        logger.debug('Grid level execution result', {
          levelSide: level.side,
          levelId: level.id,
          signature: sig,
          actualReceivedAmount,
          outputDecimals,
          fromToken: cfg.fromToken,
          toToken: cfg.toToken
        });

        // Validate transaction success before proceeding
        const transactionSuccess = sig ? await this.validateTransactionSuccess(sig) : false;
        if (!transactionSuccess) {
          logger.error('Grid level transaction failed', {
            levelSide: level.side,
            levelId: level.id,
            signature: sig,
            fromToken: cfg.fromToken,
            toToken: cfg.toToken
          });
          GridTrader.clearInflight(instanceKey, pairKey, operation);
          return;
        }

        // Compute effective executed price using actual swap I/O
        let effectivePrice: number | undefined;
        try {
          const sentActual = (swapResult as any).sentAmountActual;
          if (level.side === 'buy') {
            const sentUi = typeof sentActual === 'number' ? sentActual : amountToUse;
            const recvUi = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : swapResult.receivedAmount;
            effectivePrice = (sentUi > 0) ? (recvUi / sentUi) : undefined; // toToken per fromToken
          } else {
            const sentUi = typeof sentActual === 'number' ? sentActual : amountToUse; // toToken
            const recvUi = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : swapResult.receivedAmount; // fromToken
            effectivePrice = (recvUi > 0) ? (sentUi / recvUi) : undefined; // toToken per fromToken
          }
        } catch {}
        if (typeof effectivePrice !== 'number' || !isFinite(effectivePrice!) || effectivePrice! <= 0) {
          effectivePrice = Math.abs(currentPrice);
        }

        // Derive executed USD price per toToken when possible (consistent with Activity/UI display)
        let executedUsdPerTo: number | undefined;
        try {
          const sentActual = (swapResult as any).sentAmountActual;
          if (typeof fromUsd === 'number' && typeof actualReceivedAmount === 'number' && actualReceivedAmount > 0) {
            if (level.side === 'buy') {
              // Spent fromToken to receive toToken: $/to = (spentFrom * $/from) / receivedTo
              const spentFrom = (typeof sentActual === 'number' && sentActual > 0) ? sentActual : amountToUse;
              if (spentFrom > 0) executedUsdPerTo = (spentFrom * fromUsd) / actualReceivedAmount;
            } else {
              // Sold toToken to receive fromToken: $/to = (receivedFrom * $/from) / soldTo
              const soldTo = (typeof sentActual === 'number' && sentActual > 0) ? sentActual : amountToUse;
              if (soldTo > 0) executedUsdPerTo = (actualReceivedAmount * fromUsd) / soldTo;
            }
          }
        } catch {}

        // Update level with execution details only after successful transaction
        level.filled = true;
        level.filledAt = Date.now();
        level.filledPrice = effectivePrice;
        level.filledAmount = actualReceivedAmount; // Use actual received amount, not input amount
        level.transactionSignature = sig;

        // Log activity entry using executed price (with USD when available)
        try {
          const strategyName = cfg.name || 'grid-default';
          const pairLabel = `${cfg.fromToken || 'USDC'}/${cfg.toToken || 'SOL'}`;
          const priceForActivity = (typeof executedUsdPerTo === 'number' && executedUsdPerTo > 0)
            ? executedUsdPerTo
            : (typeof currentPrice === 'number' ? currentPrice : (typeof effectivePrice === 'number' ? effectivePrice : 0));
          GridTrader.addActivity(instanceKey, strategyName, {
            time: new Date().toISOString(),
            action: `grid-${level.side}`,
            token: pairLabel,
            amount: level.amount,
            price: priceForActivity,
            ...(typeof executedUsdPerTo === 'number' ? { priceUsd: executedUsdPerTo } : {})
          } as any);
        } catch {}

        // For buy operations, we need to use the actual received amount
        // and update the corresponding sell level
        if (level.side === 'buy') {
          // Use the actual received amount from the swap transaction
          level.actualReceivedAmount = actualReceivedAmount;
          (level as any).actualReceivedRaw = actualReceivedRaw;
          
          // Find and update the corresponding sell level
          const sellLevel = GridTrader.gridLevels[instanceKey]?.find(l => l.pairedLevelId === level.id);
          if (sellLevel) {
            sellLevel.amount = actualReceivedAmount;
            (sellLevel as any).actualReceivedRaw = actualReceivedRaw;
            if (actualReceivedRaw) (sellLevel as any).amountRaw = actualReceivedRaw;
            logger.info('Updated sell level with actual received amount', {
              buyLevelId: level.id,
              sellLevelId: sellLevel.id,
              receivedAmount: actualReceivedAmount,
              buyAmount: level.amount,
              price: currentPrice,
              sellLevelBeforeUpdate: {
                id: sellLevel.id,
                amount: sellLevel.amount,
                pairedLevelId: sellLevel.pairedLevelId
              }
            });
          } else {
            logger.warn('Could not find corresponding sell level for buy', {
              buyLevelId: level.id,
              availableSellLevels: GridTrader.gridLevels[instanceKey]?.filter(l => l.side === 'sell').map(l => ({
                id: l.id,
                pairedLevelId: l.pairedLevelId
              }))
            });
          }
        } else {
          // For sell operations:
          // If there is a filled paired buy, align sell amount to the bought quantity; otherwise, proceed without warnings (sell-first path)
          if (level.pairedLevelId) {
            const pairedBuyLevel = GridTrader.gridLevels[instanceKey]?.find(l => l.id === level.pairedLevelId);
            if (pairedBuyLevel && pairedBuyLevel.filled && pairedBuyLevel.actualReceivedAmount && pairedBuyLevel.actualReceivedAmount > 0) {
              const originalAmount = level.amount;
              level.amount = pairedBuyLevel.actualReceivedAmount;
              const pairedRaw = (pairedBuyLevel as any).actualReceivedRaw;
              if (pairedRaw) (level as any).amountRaw = pairedRaw;
              logger.info('Aligned sell amount to paired buy quantity', {
                sellLevelId: level.id,
                pairedBuyLevelId: level.pairedLevelId,
                originalAmount,
                alignedAmount: level.amount
              });
            } else {
              logger.debug('Sell-first path or unfilled buy pair; keeping sell amount as-is', {
                sellLevelId: level.id,
                pairedLevelId: level.pairedLevelId,
                amount: level.amount
              });
            }
          }
        }

        // Note: Do not mutate paired BUY amounts from sell proceeds; buy amounts remain configured

        // Determine planned exit metadata for accurate rendering
        let plannedExitSide: 'buy' | 'sell' | undefined;
        let plannedExitLevelId: string | undefined;
        let plannedExitPrice: number | undefined;
        let plannedExitQtyIn: number | undefined;
        let plannedExitQtyOutEst: number | undefined;
        let plannedExitUsdPerTo: number | undefined;

        if (level.side === 'buy') {
          // Planned exit is the paired sell level above center
          const pairedSell = GridTrader.gridLevels[instanceKey]?.find(l => l.side === 'sell' && l.pairedLevelId === level.id);
          plannedExitSide = 'sell';
          plannedExitLevelId = pairedSell?.id;
          plannedExitPrice = pairedSell?.price;
          // We will sell the toToken amount we actually received on the buy
          plannedExitQtyIn = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : (level.amount || 0);
          plannedExitQtyOutEst = (typeof plannedExitPrice === 'number' && typeof plannedExitQtyIn === 'number')
            ? (plannedExitQtyIn * plannedExitPrice)
            : undefined;
          // $ per toToken at planning time: pair price is to per from, so USD/to = fromUsd * (to/from)
          if (typeof fromUsd === 'number' && typeof plannedExitPrice === 'number' && plannedExitPrice > 0) {
            plannedExitUsdPerTo = fromUsd * plannedExitPrice;
          }
        } else {
          // Planned exit is the paired buy level below center
          const pairedBuy = GridTrader.gridLevels[instanceKey]?.find(l => l.id === level.pairedLevelId);
          plannedExitSide = 'buy';
          plannedExitLevelId = pairedBuy?.id;
          plannedExitPrice = pairedBuy?.price;
          // We will spend the fromToken proceeds received by this sell to buy back toToken
          const spendFrom = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : (level.amount || 0);
          plannedExitQtyIn = spendFrom;
          plannedExitQtyOutEst = (typeof plannedExitPrice === 'number' && typeof plannedExitQtyIn === 'number' && plannedExitPrice > 0)
            ? (plannedExitQtyIn / plannedExitPrice)
            : undefined;
          // $ per toToken at planning time: pair price is to per from, so USD/to = fromUsd * (to/from)
          if (typeof fromUsd === 'number' && typeof plannedExitPrice === 'number' && plannedExitPrice > 0) {
            plannedExitUsdPerTo = fromUsd * plannedExitPrice;
          }
        }

        // Create grid position (after both buy and sell logic) with structured planned exit
        const position: GridPosition = {
          id: `${level.id}-${Date.now()}`,
          side: level.side,
          entryPrice: effectivePrice,
          entryUsdPerTo: (typeof executedUsdPerTo === 'number' ? executedUsdPerTo : undefined),
          amount: level.amount,
          filledAmount: actualReceivedAmount, // Use actual received amount
          pnl: 0,
          openedAt: Date.now(),
          transactionSignature: sig,
          status: 'filled',
          strategyName: cfg.name,
          intention: (typeof plannedExitPrice === 'number')
            ? `${level.side}ID${level.id.split('-')[1] || 'unknown'} - ${(plannedExitSide === 'sell' ? 'Sell' : 'Buy')}@${plannedExitPrice.toFixed(6)}`
            : undefined,
          timeSinceOpen: 0,
          levelId: level.id,
          pairedLevelId: level.pairedLevelId,
          plannedExitSide,
          plannedExitLevelId,
          plannedExitPrice,
          plannedExitQtyIn,
          plannedExitQtyOutEst,
          plannedExitUsdPerTo
        };
        
        // Close the corresponding buy position if this is a sell
        if (level.side === 'sell' && level.pairedLevelId) {
          // First, find the corresponding buy level to get its transaction signature
          const buyLevel = GridTrader.gridLevels[instanceKey]?.find(l => l.id === level.pairedLevelId);
          
          if (buyLevel && buyLevel.filled && buyLevel.transactionSignature) {
            // Find the buy position that corresponds to this buy level
            const buyPosition = GridTrader.gridPositions[instanceKey]?.find(p => 
              p.side === 'buy' && p.status === 'filled' && !p.closedAt && 
              p.transactionSignature === buyLevel.transactionSignature
            );
            
            if (buyPosition) {
              // Validate that the sell transaction was successful before closing the position
              const sellTransactionSuccess = await this.validateTransactionSuccess(sig);
              if (!sellTransactionSuccess) {
                logger.error('Sell transaction failed, not closing buy position', {
                  sellLevelId: level.id,
                  buyPositionId: buyPosition.id,
                  sellSignature: sig
                });
                // Don't close the position if the sell transaction failed
                return;
              }
              
              const closeTs = Date.now();
              buyPosition.closedAt = closeTs;
              buyPosition.exitPrice = effectivePrice;
              buyPosition.exitTransactionSignature = sig;
              try {
                if (typeof fromUsd === 'number' && typeof buyPosition.filledAmount === 'number' && buyPosition.filledAmount > 0) {
                  // For buy position close via sell: $/to = (receivedFrom * $/from) / soldTo
                  const soldTo = buyPosition.filledAmount;
                  const receivedFrom = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : 0;
                  if (receivedFrom > 0) buyPosition.exitUsdPerTo = (receivedFrom * fromUsd) / soldTo;
                }
              } catch {}
              // Calculate PNL based on effective executed prices
              // For buy positions: PNL (in toToken units valued in fromToken) = (exitPrice - entryPrice) * qty_to
              buyPosition.pnl = (buyPosition.filledAmount || 0) * ((buyPosition.exitPrice || buyPosition.entryPrice) - buyPosition.entryPrice);
              
              logger.debug('PNL calculation for closed position', {
                buyPositionId: buyPosition.id,
                entryPrice: buyPosition.entryPrice,
                exitPrice: currentPrice,
                filledAmount: buyPosition.filledAmount,
                pnl: buyPosition.pnl,
                priceDifference: currentPrice - buyPosition.entryPrice
              });
              buyPosition.status = 'closed';
              buyPosition.timeSinceOpen = Math.max(0, closeTs - (buyPosition.openedAt || closeTs));
              
              // Update the sell position to reference the closed buy position
              position.pairedPositionId = buyPosition.id;
              position.status = 'closed';
              position.closedAt = closeTs;
              position.exitPrice = effectivePrice;
              position.exitTransactionSignature = sig;
              try {
                if (typeof fromUsd === 'number' && typeof position.amount === 'number' && position.amount > 0) {
                  const soldTo = position.amount;
                  const receivedFrom = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : 0;
                  if (receivedFrom > 0) position.exitUsdPerTo = (receivedFrom * fromUsd) / soldTo;
                }
              } catch {}
              position.timeSinceOpen = Math.max(0, closeTs - (position.openedAt || closeTs));
              
              // Increment completed cycles counter
              const gridState = GridTrader.gridState[instanceKey];
              if (gridState) {
                gridState.completedCycles++;
              }

            // Realized PnL in from token units: sell received (from) minus buy spent (from)
            try {
              const fromSym = cfg.fromToken || 'USDC';
              const sellReceivedFrom = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : 0;
              const buySpentFrom = typeof (buyLevel?.amount) === 'number' ? (buyLevel?.amount || 0) : (buyPosition.amount || 0);
              const realizedFrom = sellReceivedFrom - buySpentFrom;
              GridTrader.addPnl(instanceKey, fromSym, realizedFrom);
              if (gridState) {
                gridState.totalPnl = (gridState.totalPnl || 0) + realizedFrom;
              }
            } catch {}
              
              // Write trade summary (buy then sell cycle) in USDC if available
              try {
                const fromSymLocal = cfg.fromToken || 'USDC';
                const pair = `${fromSymLocal}/${cfg.toToken || 'TO'}`;
                const entryPair = buyPosition.entryPrice;
                const exitPair = buyPosition.exitPrice;
                const baseAmount = buyPosition.filledAmount;
                // Recompute realized in from token units
                const sellReceivedFrom2 = typeof actualReceivedAmount === 'number' ? actualReceivedAmount : 0;
                const buySpentFrom2 = typeof (buyLevel?.amount) === 'number' ? (buyLevel?.amount || 0) : (buyPosition.amount || 0);
                const realizedFrom2 = sellReceivedFrom2 - buySpentFrom2;
                // Convert to USDC if price available
                let pnlUSDC: number | null = null;
                try {
                  const prices = getAllPrices();
                  const fromUsdNow = prices[fromInfo.mint]?.usdc;
                  if (typeof fromUsdNow === 'number') pnlUSDC = realizedFrom2 * fromUsdNow;
                } catch {}
                await writeTradeSummary({
                  time: new Date().toISOString(),
                  strategy: cfg.name || 'grid-default',
                  side: 'long',
                  pair,
                  entryPair,
                  exitPair,
                  baseAmount,
                  pnlUSDC,
                  pairFrom: fromSymLocal,
                  pairTo: cfg.toToken || 'TO',
                  pairOrientation: `${fromSymLocal}->${cfg.toToken || 'TO'}`,
                } as any);
              } catch {}

              logger.info('Closed paired buy position', {
                buyPositionId: buyPosition.id,
                sellPositionId: position.id,
                buyLevelId: level.pairedLevelId,
                sellLevelId: level.id,
                pnl: buyPosition.pnl,
                entryPrice: buyPosition.entryPrice,
                exitPrice: currentPrice,
                buyTransactionSignature: buyLevel.transactionSignature,
                completedCycles: gridState?.completedCycles || 0
              });
            } else {
              logger.warn('Could not find paired buy position by transaction signature', {
                sellLevelId: level.id,
                pairedLevelId: level.pairedLevelId,
                buyLevelFilled: buyLevel.filled,
                buyLevelTransactionSignature: buyLevel.transactionSignature,
                availablePositions: GridTrader.gridPositions[instanceKey]?.map(p => ({
                  id: p.id,
                  side: p.side,
                  status: p.status,
                  closedAt: p.closedAt,
                  transactionSignature: p.transactionSignature
                }))
              });
            }
          } else {
            logger.warn('Could not find filled buy level for pairing', {
              sellLevelId: level.id,
              pairedLevelId: level.pairedLevelId,
              buyLevelFound: !!buyLevel,
              buyLevelFilled: buyLevel?.filled,
              buyLevelTransactionSignature: buyLevel?.transactionSignature
            });
          }
        } else if (level.side === 'buy') {
          const pairedSellLevel = GridTrader.gridLevels[instanceKey]?.find(l => l.side === 'sell' && l.pairedLevelId === level.id);
          if (pairedSellLevel && pairedSellLevel.filled && pairedSellLevel.transactionSignature) {
            const sellPosition = GridTrader.gridPositions[instanceKey]?.find(p => 
              p.side === 'sell' && p.status === 'filled' && !p.closedAt && 
              p.transactionSignature === pairedSellLevel.transactionSignature
            );

            if (sellPosition) {
              const closeTs = Date.now();
              sellPosition.closedAt = closeTs;
              sellPosition.exitPrice = effectivePrice;
              sellPosition.exitTransactionSignature = sig;
              const quantitySold = sellPosition.amount || 0;
              // For sell positions: PNL = (entryPrice - exitPrice) * qty_to
              sellPosition.pnl = (sellPosition.entryPrice - (sellPosition.exitPrice || sellPosition.entryPrice)) * quantitySold;
              sellPosition.status = 'closed';
              sellPosition.timeSinceOpen = Math.max(0, closeTs - (sellPosition.openedAt || closeTs));

              position.pairedPositionId = sellPosition.id;
              position.status = 'closed';
              position.closedAt = closeTs;
              position.exitPrice = effectivePrice;
              position.exitTransactionSignature = sig;
              position.timeSinceOpen = Math.max(0, closeTs - (position.openedAt || closeTs));

              const gridState = GridTrader.gridState[instanceKey];
              if (gridState) {
                gridState.completedCycles++;
              }

              try {
                const fromSym = cfg.fromToken || 'USDC';
                const sellProceedsFrom = typeof pairedSellLevel.actualReceivedAmount === 'number'
                  ? pairedSellLevel.actualReceivedAmount
                  : (sellPosition.filledAmount || 0);
                const buyCostFrom = typeof level.amount === 'number' ? level.amount : 0;
                const realizedFrom = sellProceedsFrom - buyCostFrom;
                GridTrader.addPnl(instanceKey, fromSym, realizedFrom);
                if (gridState) {
                  gridState.totalPnl = (gridState.totalPnl || 0) + realizedFrom;
                }
              } catch {}

              // Write trade summary (sell then buy cycle) in USDC if available
              try {
                const fromSymLocal = cfg.fromToken || 'USDC';
                const pair = `${fromSymLocal}/${cfg.toToken || 'TO'}`;
                const entryPair = sellPosition.entryPrice;
                const exitPair = sellPosition.exitPrice;
                const baseAmount = sellPosition.amount;
                // Recompute realized in from token units
                const sellProceedsFrom2 = typeof pairedSellLevel.actualReceivedAmount === 'number'
                  ? pairedSellLevel.actualReceivedAmount
                  : (sellPosition.filledAmount || 0);
                const buyCostFrom2 = typeof level.amount === 'number' ? level.amount : 0;
                const realizedFrom2 = sellProceedsFrom2 - buyCostFrom2;
                let pnlUSDC: number | null = null;
                try {
                  const prices = getAllPrices();
                  const fromUsdNow = prices[fromInfo.mint]?.usdc;
                  if (typeof fromUsdNow === 'number') pnlUSDC = realizedFrom2 * fromUsdNow;
                } catch {}
                await writeTradeSummary({
                  time: new Date().toISOString(),
                  strategy: cfg.name || 'grid-default',
                  side: 'short',
                  pair,
                  entryPair,
                  exitPair,
                  baseAmount,
                  pnlUSDC,
                  pairFrom: fromSymLocal,
                  pairTo: cfg.toToken || 'TO',
                  pairOrientation: `${fromSymLocal}->${cfg.toToken || 'TO'}`,
                } as any);
              } catch {}

              logger.info('Closed paired sell position', {
                sellPositionId: sellPosition.id,
                buyPositionId: position.id,
                sellLevelId: pairedSellLevel.id,
                buyLevelId: level.id,
                pnl: sellPosition.pnl,
                entryPrice: sellPosition.entryPrice,
                exitPrice: currentPrice,
                sellTransactionSignature: pairedSellLevel.transactionSignature,
                completedCycles: gridState?.completedCycles || 0
              });
            } else {
              logger.warn('Could not find paired sell position by transaction signature', {
                buyLevelId: level.id,
                pairedSellLevelId: pairedSellLevel.id,
                sellLevelTransactionSignature: pairedSellLevel.transactionSignature,
                availablePositions: GridTrader.gridPositions[instanceKey]?.map(p => ({
                  id: p.id,
                  side: p.side,
                  status: p.status,
                  closedAt: p.closedAt,
                  transactionSignature: p.transactionSignature
                }))
              });
            }
          }
        }

        if (!GridTrader.gridPositions[instanceKey]) {
          GridTrader.gridPositions[instanceKey] = [];
        }
        GridTrader.gridPositions[instanceKey].push(position);
        
        // Add to trade history for persistent logging
        if (!GridTrader.tradeHistory[instanceKey]) {
          GridTrader.tradeHistory[instanceKey] = [];
        }
        GridTrader.tradeHistory[instanceKey].push(position);
        // Rotate if too large (keep last 500)
        if (GridTrader.tradeHistory[instanceKey].length > 500) {
          GridTrader.tradeHistory[instanceKey] = GridTrader.tradeHistory[instanceKey].slice(-500);
        }
        
        // Increment total trades counter
        const gridState = GridTrader.gridState[instanceKey];
        if (gridState) {
          gridState.totalTrades++;
        }

        // Update wallet history
        addWalletHistory({
          type: 'swap',
          time: new Date().toISOString(),
          fromToken: cfg.fromToken || 'USDC',
          fromAmount: level.amount,
          toToken: cfg.toToken || 'SOL',
        });

        logger.info(`Grid ${level.side} executed`, { level: level.id, strategy: cfg.name, fromToken: cfg.fromToken, toToken: cfg.toToken, amount: level.amount, price: currentPrice });
        // Emit user-friendly trade fill without signature; include strategy and amounts
        emit('log', { 
          level: 'info', 
          message: `trade: grid ${cfg.name || 'grid-default'} ${level.side} ${level.amount} ${level.side === 'buy' ? (cfg.fromToken || 'FROM') : (cfg.toToken || 'TO')} -> ${level.side === 'buy' ? (cfg.toToken || 'TO') : (cfg.fromToken || 'FROM')} @ ${typeof effectivePrice === 'number' ? effectivePrice : currentPrice}`,
          timestamp: new Date().toLocaleTimeString(),
          context: { cat: 'trade', strategy: cfg.name, side: level.side, levelId: level.id }
        });
      }

            GridTrader.clearInflight(instanceKey, pairKey, operation);
    } catch (e: any) {
      logger.error(`Grid ${level.side} execution failed`, { error: String(e?.message || e) });
      GridTrader.clearInflight(instanceKey, pairKey, operation);
    }
  }

  private emitGridActivity(cfg: GridStrategyConfig, instanceKey: string, currentPrice: number, fromSym: string, toSym: string): void {
    const levels = GridTrader.gridLevels[instanceKey] || [];
    const positions = GridTrader.gridPositions[instanceKey] || [];
    const state = GridTrader.gridState[instanceKey];
    
    const activeLevels = levels.filter(l => !l.filled);
    const filledLevels = levels.filter(l => l.filled);
    const openPositions = positions.filter(p => !p.closedAt);
    
    // Clean up old closed positions (keep only last 50)
    const closedPositions = positions.filter(p => p.closedAt);
    if (closedPositions.length > 50) {
      const sortedClosed = closedPositions.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
      const toKeep = sortedClosed.slice(0, 50);
      const toRemove = sortedClosed.slice(50);
      
      // Remove old closed positions
      GridTrader.gridPositions[instanceKey] = positions.filter(p => !toRemove.includes(p));
      
      logger.info('Cleaned up old closed positions', {
        instanceKey,
        removed: toRemove.length,
        remaining: GridTrader.gridPositions[instanceKey].length
      });
    }
    
    // Calculate next levels
    const nextBuyLevel = activeLevels
      .filter(l => l.side === 'buy' && l.price < currentPrice)
      .sort((a, b) => b.price - a.price)[0];
    const nextSellLevel = activeLevels
      .filter(l => l.side === 'sell' && l.price > currentPrice)
      .sort((a, b) => a.price - b.price)[0];

    // Compute unrealized PnL in from token units across open positions
    let unrealizedFrom = 0;
    for (const p of openPositions) {
      if (p.side === 'buy') {
        // Exposure in toToken. Convert to fromToken using currentPrice: (current - entry) * qty_in_to
        const qtyTo = (p.filledAmount || p.amount || 0);
        unrealizedFrom += (currentPrice - p.entryPrice) * qtyTo;
      } else {
        // Exposure: short toToken qty
        const qtyTo = (p.filledAmount || p.amount || 0);
        unrealizedFrom += (p.entryPrice - currentPrice) * qtyTo;
      }
    }
    const realized = GridTrader.realizedPnlByInstance[instanceKey] || {};

    const activityData = {
      strategy: cfg.name || 'grid-default',
      status: 'active',
      pair: `${fromSym}/${toSym}`,
      current: currentPrice,
      centerPrice: state?.centerPrice,
      nextBuyLevel: nextBuyLevel?.price,
      nextSellLevel: nextSellLevel?.price,
      activeLevels: activeLevels.length,
      filledLevels: filledLevels.length,
      openPositions: openPositions.length,
      completedCycles: state?.completedCycles || 0,
      realizedPnlFrom: realized[fromSym.toUpperCase()] || 0,
      unrealizedPnlFrom: unrealizedFrom,
      totalPnl: state?.totalPnl || 0,
      gridLevels: levels, // Include all grid levels for display
      trades: (GridTrader.activityLogByInstance[instanceKey] || []).slice(-50)
    };
    
    logger.info('Emitting grid activity', { 
      strategy: cfg.name, 
      gridLevelsCount: levels.length,
      hasGridLevels: !!levels.length
    });
    
    emit('activity', activityData);

    // Emit summarized grid active positions for Positions card (per strategy)
    try {
      const strategyName = cfg.name || 'grid-default';
      const nowMs = Date.now();
      const count = openPositions.length;
      let totalFromToken = 0;
      let sumOpenMs = 0;
      for (const p of openPositions) {
        // Value measured in fromToken units
        if (p.side === 'buy') totalFromToken += (p as any).amount || 0;
        else totalFromToken += (p as any).filledAmount || 0; // proceeds from sell
        sumOpenMs += Math.max(0, nowMs - (p.openedAt || nowMs));
      }
      const avgOpenMs = count ? (sumOpenMs / count) : 0;
      emit('grid-positions', [{ strategy: strategyName, fromSymbol: fromSym, toSymbol: toSym, count, totalFromToken, avgOpenMs }]);
    } catch {}
  }

  // Static methods for position management
  static activityLogByInstance: Record<string, Array<{ time: string; action: string; token: string; amount: number; price: number; priceUsd?: number }>> = {};
  static activityLogByStrategy: Record<string, Array<{ time: string; action: string; token: string; amount: number; price: number }>> = {} as any;

  static addActivity(a: string, b: any, c?: any) {
    // Two forms supported:
    // - addActivity(strategyName, item)
    // - addActivity(instanceKey, strategyName, item)
    if (typeof c === 'undefined') {
      const strategyName = a || 'default';
      const item = b as { time: string; action: string; token: string; amount: number; price: number };
      if (!this.activityLogByStrategy[strategyName]) this.activityLogByStrategy[strategyName] = [];
      this.activityLogByStrategy[strategyName].push(item);
      if (this.activityLogByStrategy[strategyName].length > 200) this.activityLogByStrategy[strategyName].shift();
      return;
    }
    const instanceKey = a;
    const item = c as { time: string; action: string; token: string; amount: number; price: number; priceUsd?: number };
    if (!this.activityLogByInstance[instanceKey]) this.activityLogByInstance[instanceKey] = [];
    this.activityLogByInstance[instanceKey].push(item);
    if (this.activityLogByInstance[instanceKey].length > 200) this.activityLogByInstance[instanceKey].shift();
  }

  private static resetInstance(instanceKey: string, strategyName: string, centerPrice: number, configSignature: string, fromToken: string, toToken: string): void {
    this.gridLevels[instanceKey] = [];
    this.gridPositions[instanceKey] = [];
    this.tradeHistory[instanceKey] = [];
    this.activityLogByInstance[instanceKey] = [];
    this.realizedPnlByInstance[instanceKey] = {};
    this.inflightByInstance[instanceKey] = {} as any;

    this.gridState[instanceKey] = {
      centerPrice,
      originalCenterPrice: centerPrice,
      lastRebalance: Date.now(),
      volatility: 0,
      totalFilled: 0,
      totalPnl: 0,
      lastSlideUpdate: Date.now(),
      completedCycles: 0,
      totalTrades: 0,
      configSignature,
      fromToken,
      toToken,
      strategyName,
    };

    emit('gridLevels', { instanceKey, levels: [] });
    emit('activity', { strategy: strategyName, status: 'reset', instanceKey, trades: [] });
  }

  // Soft reconfiguration: update state and grid levels while preserving positions and trade history
  static reconfigureInstancePreserve(instanceKey: string, strategyName: string, centerPrice: number, configSignature: string, fromToken: string, toToken: string): void {
    const existingState = this.gridState[instanceKey];
    const existingLevels = this.gridLevels[instanceKey] || [];
    const existingPositions = this.gridPositions[instanceKey] || [];
    const existingHistory = this.tradeHistory[instanceKey] || [];
    const existingActivity = this.activityLogByInstance[instanceKey] || [];
    const existingRealized = this.realizedPnlByInstance[instanceKey] || {};
    const existingInflight = this.inflightByInstance[instanceKey] || {} as any;

    // Update state but keep counters and timestamps where meaningful
    this.gridState[instanceKey] = {
      centerPrice,
      originalCenterPrice: existingState?.originalCenterPrice ?? centerPrice,
      lastRebalance: existingState?.lastRebalance ?? Date.now(),
      volatility: existingState?.volatility ?? 0,
      totalFilled: existingState?.totalFilled ?? 0,
      totalPnl: existingState?.totalPnl ?? 0,
      lastSlideUpdate: Date.now(),
      completedCycles: existingState?.completedCycles ?? 0,
      totalTrades: existingState?.totalTrades ?? 0,
      atasEnsured: existingState?.atasEnsured,
      configSignature,
      fromToken,
      toToken,
      strategyName,
    };

    // Preserve positions and history as-is
    this.gridPositions[instanceKey] = existingPositions;
    this.tradeHistory[instanceKey] = existingHistory;
    this.activityLogByInstance[instanceKey] = existingActivity;
    this.realizedPnlByInstance[instanceKey] = existingRealized;
    this.inflightByInstance[instanceKey] = existingInflight;

    // Rebuild levels around new center but attempt to preserve linkage:
    // - Keep already filled levels as-is (they reflect past actions)
    // - Recompute only unfilled levels using new center price
    const filledLevels = existingLevels.filter(l => l.filled);
    const pendingLevels = existingLevels.filter(l => !l.filled);

    // Replace pending levels with an empty list; initializeGrid will repopulate on next tick
    // We emit levels now to keep UI consistent; filled levels remain visible until positions close
    this.gridLevels[instanceKey] = [...filledLevels];

    emit('gridLevels', { instanceKey, levels: this.gridLevels[instanceKey] });
    emit('activity', { strategy: strategyName, status: 'reconfigured', instanceKey, trades: (this.activityLogByInstance[instanceKey] || []).slice(-50) });
  }

  // Track realized PnL by instance and token symbol
  static addPnl(instanceKey: string, tokenSymbol: string, amount: number): void {
    if (!this.realizedPnlByInstance[instanceKey]) this.realizedPnlByInstance[instanceKey] = {};
    const sym = (tokenSymbol || '').toUpperCase();
    this.realizedPnlByInstance[instanceKey][sym] = (this.realizedPnlByInstance[instanceKey][sym] || 0) + amount;
  }

  static getGridLevels(instanceKey: string): GridLevel[] {
    return this.gridLevels[instanceKey] || [];
  }

  static getGridPositions(instanceKey: string): GridPosition[] {
    return this.gridPositions[instanceKey] || [];
  }

  static getSuccessfulPositions(instanceKey: string): GridPosition[] {
    const positions = this.getGridPositions(instanceKey);
    return positions.filter(pos => pos.status === 'filled' || pos.status === 'closed');
  }

  static getActivePositions(instanceKey: string): GridPosition[] {
    const positions = this.getGridPositions(instanceKey);
    return positions.filter(pos => pos.status === 'filled' && !pos.closedAt);
  }

  static getTradeHistory(instanceKey: string): GridPosition[] {
    const all = this.tradeHistory[instanceKey] || [];
    // Simple server-side cap/pagination placeholder: return last 200
    return all.slice(-200);
  }

  static hasActivePositionForLevel(instanceKey: string, levelId: string, transactionSignature?: string): boolean {
    const positions = this.gridPositions[instanceKey] || [];
    return positions.some(pos => 
      pos.status === 'filled' && 
      !pos.closedAt && 
      (transactionSignature ? pos.transactionSignature === transactionSignature : pos.levelId === levelId)
    );
  }

  static updateGridLevelStatuses(instanceKey: string): void {
    const levels = this.gridLevels[instanceKey];
    if (!levels) return;

    levels.forEach(level => {
      if (level.filled) {
        // Check if there's still an active position for this level
        const hasActivePosition = this.hasActivePositionForLevel(instanceKey, level.id, level.transactionSignature);
        
        if (!hasActivePosition) {
          // Reset the level back to pending status
          level.filled = false;
          level.filledAt = undefined;
          level.filledPrice = undefined;
          level.filledAmount = undefined;
          level.actualReceivedAmount = undefined;
          level.transactionSignature = undefined;
          level.pnl = undefined;
          
          // For sell levels, reset amount to 0 since there's no active paired buy
          if (level.side === 'sell') {
            level.amount = 0;
          }
          
          logger.debug('Reset grid level to pending - no active position', {
            levelId: level.id,
            side: level.side,
            price: level.price
          });
        }
      }
    });
  }

  static cleanupClosedPositions(instanceKey: string): void {
    // Remove closed positions from the positions array
    if (this.gridPositions[instanceKey]) {
      this.gridPositions[instanceKey] = this.gridPositions[instanceKey].filter(pos => pos.status !== 'closed');
    }
    
    // Reset filled levels that have corresponding closed positions back to pending
    if (this.gridLevels[instanceKey]) {
      this.gridLevels[instanceKey].forEach(level => {
        if (level.filled) {
          // Check if there's a closed position for this level
          const hasClosedPosition = this.gridPositions[instanceKey]?.some(pos => 
            pos.transactionSignature === level.transactionSignature && pos.status === 'closed'
          );
          
          if (hasClosedPosition) {
            // Reset the level back to pending status
            level.filled = false;
            level.filledAt = undefined;
            level.filledPrice = undefined;
            level.filledAmount = undefined;
            level.actualReceivedAmount = undefined;
            level.transactionSignature = undefined;
            level.pnl = undefined;
            
            // For sell levels, reset amount to 0 since the paired buy is closed
            if (level.side === 'sell') {
              level.amount = 0;
            }
            
            logger.info('Reset grid level to pending after position closure', {
              levelId: level.id,
              side: level.side,
              price: level.price,
              pairedLevelId: level.pairedLevelId
            });
          }
        }
      });
    }
  }

  static getGridState(instanceKey: string) {
    return this.gridState[instanceKey];
  }

  static manualClosePosition(
    instanceKey: string,
    positionId: string,
    exitPrice?: number,
    exitSignature?: string,
    actualOutputAmount?: number,
    inputAmountForClose?: number
  ): boolean {
    const positions = this.gridPositions[instanceKey] || [];
    const idx = positions.findIndex(p => p.id === positionId && !p.closedAt);
    if (idx === -1) return false;
    const pos = positions[idx];
    pos.closedAt = Date.now();
    if (exitPrice !== undefined) pos.exitPrice = exitPrice;
    if (exitSignature) pos.exitTransactionSignature = exitSignature;
    pos.status = 'closed';
    pos.timeSinceOpen = Math.max(0, (pos.closedAt || 0) - (pos.openedAt || 0));
    // Compute PnL
    try {
      const qty = pos.side === 'buy' ? (pos.filledAmount || 0) : (pos.amount || 0);
      const ep = pos.exitPrice ?? pos.entryPrice;
      if (typeof ep === 'number' && typeof pos.entryPrice === 'number') {
        pos.pnl = (pos.side === 'buy') ? ((ep - pos.entryPrice) * qty) : ((pos.entryPrice - ep) * qty);
      }
    } catch {}

    // Reset corresponding level(s)
    const levels = this.gridLevels[instanceKey] || [];
    if (pos.levelId) {
      const lvl = levels.find(l => l.id === pos.levelId);
      if (lvl) {
        lvl.filled = false;
        lvl.filledAt = undefined;
        lvl.filledPrice = undefined;
        lvl.filledAmount = undefined;
        lvl.actualReceivedAmount = undefined;
        lvl.transactionSignature = undefined;
        lvl.pnl = undefined;
        if (lvl.side === 'sell') lvl.amount = 0; // clear sell amount set by paired buy
      }
    }
    if (pos.pairedLevelId) {
      const pl = levels.find(l => l.id === pos.pairedLevelId);
      if (pl) {
        // Clear any pre-set amount on the paired leg
        if (pl.side === 'sell') pl.amount = 0;
        pl.filled = false;
        pl.filledAt = undefined;
        pl.filledPrice = undefined;
        pl.filledAmount = undefined;
        pl.actualReceivedAmount = undefined;
        pl.transactionSignature = undefined;
        pl.pnl = undefined;
      }
    }
    this.updateGridLevelStatuses(instanceKey);

    // Create a synthetic counter position to complete the cycle for Trade Summary
    try {
      const nowTs = Date.now();
      const counterSide: 'buy' | 'sell' = (pos.side === 'buy') ? 'sell' : 'buy';
      // Determine amounts for the synthetic counter trade
      // For closing a BUY → counter is SELL:
      //   amount (sold, toToken) = inputAmountForClose or original filledAmount/amount
      //   filledAmount (received, fromToken) = actualOutputAmount or amount * exitPrice
      // For closing a SELL → counter is BUY:
      //   amount (spent, fromToken) = inputAmountForClose or original filledAmount/amount
      //   filledAmount (received, toToken) = actualOutputAmount or amount * exitPrice
      const baseAmount = Math.max(0, Number(inputAmountForClose ?? pos.filledAmount ?? pos.amount ?? 0));
      const inferredFill = (typeof actualOutputAmount === 'number' && !Number.isNaN(actualOutputAmount))
        ? Math.max(0, Number(actualOutputAmount))
        : (typeof exitPrice === 'number' && !Number.isNaN(exitPrice))
          ? (baseAmount * Number(exitPrice))
          : 0;

      const counter: GridPosition = {
        id: `${positionId}-manual-counter-${nowTs}`,
        side: counterSide,
        entryPrice: (typeof exitPrice === 'number' ? exitPrice : (pos.exitPrice ?? pos.entryPrice)),
        exitPrice: (typeof exitPrice === 'number' ? exitPrice : undefined),
        amount: baseAmount,
        filledAmount: inferredFill,
        pnl: 0,
        openedAt: nowTs,
        closedAt: nowTs,
        transactionSignature: exitSignature,
        exitTransactionSignature: exitSignature,
        status: 'closed',
        strategyName: pos.strategyName,
        pairedPositionId: positionId,
        intention: `manual-close-${counterSide}`,
        timeSinceOpen: 0,
        // level links are not meaningful for synthetic record
      };

      // Push synthetic counter trade to positions (short-lived) and trade history (persistent)
      if (!GridTrader.gridPositions[instanceKey]) GridTrader.gridPositions[instanceKey] = [];
      GridTrader.gridPositions[instanceKey].push(counter);
      if (!GridTrader.tradeHistory[instanceKey]) GridTrader.tradeHistory[instanceKey] = [];
      GridTrader.tradeHistory[instanceKey].push(counter);
      if (GridTrader.tradeHistory[instanceKey].length > 500) {
        GridTrader.tradeHistory[instanceKey] = GridTrader.tradeHistory[instanceKey].slice(-500);
      }

      // Increment completed cycles
      const gridState = GridTrader.gridState[instanceKey];
      if (gridState) {
        gridState.completedCycles = (gridState.completedCycles || 0) + 1;
      }
    } catch {}

    return true;
  }

  start(pollMs = Math.max(500, (CONFIG as any).websocketIntervalMs || 1000)): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.interval = setInterval(() => {
      this.tick().catch((e) => logger.error('grid tick error', { error: String(e) }));
    }, pollMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.isRunning = false;
  }
}
