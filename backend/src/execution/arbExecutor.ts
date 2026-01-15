import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';
import WebSocket from 'ws';
import { resolveDirectPlan } from './resolver/index.js';
import { assembleAndSend, assembleAndSimulate } from './sender.js';
import { loadExecConfig } from '../server/execConfigStore.js';
import { addTxRecord } from '../server/txHistory.js';
import type { ArbBuildResult } from '../workers/arbBuild.types.js';
import { calculateProfitBasedTip, type TipResult } from './arbTip.js';
import { sendToBlockEngine } from './jitoClient.js';
import { startTipFeed } from './jitoTipCache.js';
import { CONFIG } from '../utils/config.js';
import { ensureWallet, getBalances, getConnection } from '../wallet/wallet.js';
import {
  initializeTracker,
  setQuarantineConfig,
  setManualBlocklist,
  filterQuarantinedPools,
  recordPoolFailure,
  hasQuarantinedPool,
} from './poolFailureTracker.js';
import { analyzeTransactionFailure } from './poolFailureAnalyzer.js';
import { parseSimulationLogs, buildSimulationReport, formatSimReportForLog } from './simLogParser.js';
// PERF: Static imports to avoid dynamic import overhead in hot paths
import { buildTransactionSummary } from '../server/arb.build.worker.compute.js';
import { writeTxFullDump } from '../utils/txTrace.js';
import { getTxRelatedLogs } from '../utils/sessionLogs.js';
import { buildRouterTransaction } from './builder/routerTx.js';
import { warmupSdks } from './builder/sdkQuoteBuilder.js';
import { ExecutionMode } from '../router/types.js';
import { loadJitoConfig } from '../server/jitoConfigStore.js';
import { getPriceByMint } from '../server/priceStore.js';
import { calculateOptimalSizeFromOpportunity } from './optimalSizing.js';
import { loadRouterConfig } from '../server/routerConfigStore.js';
import { deriveVaultPda, fetchVault } from '../router/sdk.js';
import { PublicKey } from '@solana/web3.js';
import { resolveDecimals } from '../server/pools/decimals.js';

interface Opportunity {
  path: string[];
  dexes: string[];           // Deduplicated set of DEX families
  hop_dexes?: string[];      // Per-hop DEX array (matches hop_pool_ids length)
  profit_bps: number;
  net_bps?: number;
  est_profit_usd?: number;
  hop_count?: number;
  hop_pool_ids?: string[];
  hop_rates?: number[];
  hop_outs?: number[];
  hop_fee_bps?: number[];
  hop_liquidity_display?: number[];
  rate_product?: number;
  link_edges_used?: number;
  link_penalty_bps_total?: number;
  min_edge_liquidity?: number;
  est_capacity?: number;
  bottleneck?: {
    from?: string;
    to?: string;
    dex?: string;
    rate?: number;
    liquidity?: number;
    fee_bps?: number;
  };
  reserves_min?: number;
  estimated_input_amount?: number;
  estimated_output_amount?: number;
  first_seen_ms?: number;
  detected_ms?: number;
  last_verified_ms?: number;
  detections?: number;
}

export interface ExecutorConfig {
  enabled: boolean;
  minProfitBps: number;
  maxConcurrentExecutions: number;
  executionTimeoutMs: number;
  cooldownMs: number;
  sizeUsd?: number;
  slippageBps?: number;
  // Filters
  maxHops?: number;
  minReservesUsd?: number;
  // Risk management
  maxExecutionsPerMinute?: number;
  blacklistedPaths?: string[];
  requireStartBalance?: boolean;
  // Dynamic sizing - calculates trade size based on liquidity and profit optimization
  dynamicSizing?: {
    enabled: boolean;
    minSizeUsd: number;      // Floor for trade size
    maxSizeUsd: number;      // Ceiling for trade size
    
    // Sizing method: 'heuristic' | 'optimal_analytical' | 'optimal_iterative'
    method: 'heuristic' | 'optimal_analytical' | 'optimal_iterative';
    
    // Heuristic mode settings
    bottleneckFraction: number; // Fraction of bottleneck liquidity (e.g., 0.10 = 10%)
    profitScaling: boolean;     // Scale size up with higher profit margins
    
    // Optimal mode settings
    optimalSettings?: {
      // Slippage model multipliers (1.0 = standard, higher = more conservative)
      ammSlippageMultiplier: number;     // Default 2.0
      clmmSlippageMultiplier: number;    // Default 3.0
      dlmmSlippageMultiplier: number;    // Default 1.3
      
      // Iterative search settings
      iterativeMaxIterations: number;    // Default 15
      iterativeTolerance: number;        // Default 1.0 (USD)
      
      // Safety margin on optimal (0.9 = use 90% of calculated optimal)
      safetyFactor: number;              // Default 0.85
    };
  };
  // Flashloan settings - use flashloans when optimal size > wallet balance
  flashloanSettings?: {
    enabled: boolean;
    // Prefer SOL or USDC flashloans (based on cycle start token)
    preferredToken: 'SOL' | 'USDC' | 'auto';
    // Minimum profit in USD to justify flashloan fee (covers 9 bps fee)
    minProfitForFlashloan: number;   // Default: 0.50 USD
    // Maximum flashloan amount in USD
    maxFlashloanUsd: number;         // Default: 10000
    // Include flashloan fee (9 bps) in profit calculation
    accountForFee: boolean;          // Default: true
    // Fallback to wallet balance if flashloan unavailable
    fallbackToWallet: boolean;       // Default: true
  };
  // On-chain router settings - route swaps through deployed router program
  useRouter?: boolean;  // Use on-chain router for execution (when enabled and deployed)
  routerExecutionMode?: 'direct' | 'flash_loan' | 'auto' | 'sdk_quote';  // Router execution mode
  // Pool quarantine settings - automatically quarantine pools that fail repeatedly
  quarantineSettings?: {
    enabled: boolean;
    maxFailures: number;      // Failures before quarantine (default: 5)
    windowMs: number;         // Time window in ms (default: 5 min)
    quarantineDurationMs: number; // How long to quarantine in ms (default: 15 min)
  };
  // Manual pool blocklist - pools to always skip (persisted)
  manualPoolBlocklist?: string[];
  // Adaptive sizing - retry with smaller sizes on profit check failures
  adaptiveSizing?: {
    enabled: boolean;
    maxRetries: number;           // Max retry attempts (default: 3)
    reductionFactor: number;      // Size multiplier per retry (default: 0.5 = halve each time)
    minSizeUsd: number;           // Don't retry below this size (default: 5)
    timeoutMs: number;            // Total timeout for all retries (default: 500ms)
  };
}

interface ExecutionState {
  inFlight: Set<string>;
  recentExecutions: Map<string, number>; // oppKey -> timestamp
  executionCounts: Map<string, number>; // oppKey -> count
  lastExecutionTime: number;
  executionsThisMinute: number;
  lastMinuteReset: number;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
}

// PERF: Balance cache to avoid RPC calls on every opportunity check
interface BalanceCache {
  balances: { sol: number; tokens: Record<string, number> } | null;
  fetchedAt: number;
}
const BALANCE_CACHE_TTL_MS = 2000; // 2 seconds - keep cache fresh, but avoid RPC spam

export class ArbExecutor {
  private config: ExecutorConfig;
  private state: ExecutionState;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null; // For periodic status logging
  private running = false;
  private walletPublicKey: any = null; // Cached wallet for balance checks
  // PERF: Cache balances to avoid RPC calls on every opportunity
  private balanceCache: BalanceCache = { balances: null, fetchedAt: 0 };

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.state = {
      inFlight: new Set(),
      recentExecutions: new Map(),
      executionCounts: new Map(),
      lastExecutionTime: 0,
      executionsThisMinute: 0,
      lastMinuteReset: Date.now(),
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.info('arb.executor.already_running', { cat: 'arb' });
      return;
    }

    this.running = true;
    logger.info('arb.executor.starting', { cat: 'arb', config: this.config });

    // Start Jito tip feed cache (non-blocking) - same as Drift runners
    try { 
      startTipFeed(Math.max(10_000, Number(((CONFIG as any)?.jito?.tipRefreshMs) ?? 15_000))); 
      logger.info('arb.executor.jito_tip_feed_started', { cat: 'arb' });
    } catch (e) {
      logger.warn('arb.executor.jito_tip_feed_failed', { cat: 'arb', error: String(e?.message || e) });
    }

    // Pre-warm SDK imports (non-blocking) - avoids lazy init overhead on first execution
    warmupSdks().catch(e => {
      logger.warn('arb.executor.sdk_warmup_failed', { cat: 'arb', error: String(e?.message || e) });
    });

    // Cache wallet public key for balance checks
    try {
      // PERF: Use static imports instead of dynamic imports
      const wallet = await ensureWallet(CONFIG.walletPath);
      this.walletPublicKey = wallet.publicKey;
      logger.debug('arb.executor.wallet_cached', { cat: 'arb', publicKey: wallet.publicKey.toBase58() });
      
      // Immediately fetch and cache balances on startup
      await this.refreshBalances();
    } catch (e) {
      logger.warn('arb.executor.wallet_cache_failed', { cat: 'arb', error: String(e?.message || e) });
    }

    // Initialize pool failure tracker with config
    try {
      initializeTracker(
        this.config.quarantineSettings,
        this.config.manualPoolBlocklist
      );
    } catch (e) {
      logger.warn('arb.executor.tracker_init_failed', { cat: 'arb', error: String((e as any)?.message || e) });
    }

    // Connect to arb-rs opportunity stream
    this.connectToOpportunityStream();

    // Start cleanup timer for expired cooldowns
    this.cleanupTimer = setInterval(() => this.cleanupState(), 60000);

    // Start periodic status logging
    this.statusTimer = setInterval(() => {
      logger.info('arb.executor.status', {
        cat: 'arb',
        enabled: this.config.enabled,
        inFlight: this.state.inFlight.size,
        totalExecutions: this.state.totalExecutions,
        successful: this.state.successfulExecutions,
        failed: this.state.failedExecutions,
        successRate: this.state.totalExecutions > 0 
          ? (this.state.successfulExecutions / this.state.totalExecutions * 100).toFixed(1) + '%'
          : '0%',
        executionsThisMinute: this.state.executionsThisMinute,
      });
    }, 30000); // Every 30 seconds
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    logger.info('arb.executor.stopped', { cat: 'arb' });
  }

  private connectToOpportunityStream(): void {
    const arbHost = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
    const wsUrl = arbHost.replace(/^http/, 'ws') + '/ws/opportunities';

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        logger.info('arb.executor.ws.connected', { cat: 'arb', url: wsUrl });
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const text = data.toString();
          const payload = JSON.parse(text);
          
          if (Array.isArray(payload?.items)) {
            // Process opportunities in priority order (already sorted by profit)
            this.processOpportunities(payload.items);
          }
        } catch (e: any) {
          logger.warn('arb.executor.ws.parse_error', { 
            cat: 'arb', 
            error: String(e?.message || e) 
          });
        }
      });

      this.ws.on('close', () => {
        logger.warn('arb.executor.ws.closed', { cat: 'arb' });
        if (this.running) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (e) => {
        logger.error('arb.executor.ws.error', { 
          cat: 'arb', 
          error: String((e as any)?.message || e) 
        });
      });
    } catch (e: any) {
      logger.error('arb.executor.ws.connect_failed', { 
        cat: 'arb', 
        error: String(e?.message || e) 
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) {
        this.connectToOpportunityStream();
      }
    }, 5000);
  }

  private async processOpportunities(opportunities: Opportunity[]): Promise<void> {
    // Log incoming batch (debug - fires every ~100ms)
    logger.debug('arb.executor.batch_received', {
      cat: 'arb',
      count: opportunities.length,
      enabled: this.config.enabled,
    });

    if (!this.config.enabled) {
      logger.debug('arb.executor.batch_skipped', {
        cat: 'arb',
        reason: 'executor_disabled',
        count: opportunities.length,
      });
      return;
    }

    // Reset per-minute counter if needed
    const now = Date.now();
    if (now - this.state.lastMinuteReset > 60000) {
      this.state.executionsThisMinute = 0;
      this.state.lastMinuteReset = now;
    }

    // Check rate limit
    if (this.config.maxExecutionsPerMinute && 
        this.state.executionsThisMinute >= this.config.maxExecutionsPerMinute) {
      logger.debug('arb.executor.batch_rate_limited', {
        cat: 'arb',
        count: opportunities.length,
        executionsThisMinute: this.state.executionsThisMinute,
        maxPerMinute: this.config.maxExecutionsPerMinute,
      });
      return;
    }

    // REMOVED: Concurrent execution limit check - no limit on concurrency
    // Transactions awaiting confirmation no longer count towards a limit

    // Process opportunities in order
    let accepted = 0;
    let filtered = 0;
    for (const opp of opportunities) {
      // REMOVED: Concurrency check inside loop - no limit on concurrency

      // Check if we should execute (now async)
      const shouldExec = await this.shouldExecute(opp);
      if (shouldExec) {
        accepted++;
        // Don't await - execute in background
        this.executeOpportunity(opp).catch((e) => {
          logger.error('arb.executor.execution_failed', {
            cat: 'arb',
            path: opp.path.join('->'),
            error: String((e as any)?.message || e),
          });
        });
      } else {
        filtered++;
      }
    }
    
    // Summary log (debug - fires every batch)
    logger.debug('arb.executor.batch_processed', {
      cat: 'arb',
      total: opportunities.length,
      accepted,
      filtered,
      inFlight: this.state.inFlight.size,
    });
  }

  private async shouldExecute(opp: Opportunity): Promise<boolean> {
    // Create opportunity key
    const oppKey = this.getOpportunityKey(opp);
    const pathStr = opp.path.join('->');
    const profitBps = opp.net_bps ?? opp.profit_bps;

    // Log incoming opportunity for detailed tracing (debug - fires per opportunity)
    logger.debug('arb.executor.opportunity_check', {
      cat: 'arb',
      path: pathStr,
      profitBps,
      netBps: opp.net_bps,
      hopCount: opp.hop_count,
      reservesMin: opp.reserves_min,
    });

    // Check if already in flight
    if (this.state.inFlight.has(oppKey)) {
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'already_in_flight',
        path: pathStr,
        profitBps,
      });
      return false;
    }

    // Check profit threshold
    if (profitBps < this.config.minProfitBps) {
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'low_profit',
        path: pathStr,
        profitBps,
        threshold: this.config.minProfitBps,
      });
      return false;
    }

    // Check hop count
    if (this.config.maxHops && opp.hop_count && opp.hop_count > this.config.maxHops) {
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'too_many_hops',
        path: pathStr,
        hopCount: opp.hop_count,
        maxHops: this.config.maxHops,
      });
      return false;
    }

    // Check reserves
    if (this.config.minReservesUsd && opp.reserves_min && 
        opp.reserves_min < this.config.minReservesUsd) {
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'low_reserves',
        path: pathStr,
        reservesMin: opp.reserves_min,
        threshold: this.config.minReservesUsd,
      });
      return false;
    }

    // Check cooldown
    const lastExecution = this.state.recentExecutions.get(oppKey);
    if (lastExecution) {
      const elapsed = Date.now() - lastExecution;
      if (elapsed < this.config.cooldownMs) {
        logger.debug('arb.executor.filtered', {
          cat: 'arb',
          reason: 'cooldown',
          path: pathStr,
          elapsedMs: elapsed,
          cooldownMs: this.config.cooldownMs,
        });
        return false;
      }
    }

    // Check blacklist
    if (this.config.blacklistedPaths?.some(bp => pathStr.includes(bp))) {
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'blacklisted',
        path: pathStr,
      });
      return false;
    }

    // Check global cooldown
    const timeSinceLastExec = Date.now() - this.state.lastExecutionTime;
    if (timeSinceLastExec < 100) { // Minimum 100ms between any executions
      logger.debug('arb.executor.filtered', {
        cat: 'arb',
        reason: 'global_cooldown',
        path: pathStr,
        elapsedMs: timeSinceLastExec,
      });
      return false;
    }

    // Pool quarantine check - skip opportunities with quarantined/blocked pools
    if (opp.hop_pool_ids && opp.hop_pool_ids.length > 0) {
      try {
        const result = filterQuarantinedPools(opp.hop_pool_ids);
        if (result.blocked.length > 0) {
          const reasons = Array.from(result.reasons.entries())
            .map(([id, reason]) => `${id.slice(0, 8)}...: ${reason}`)
            .join(', ');
          logger.debug('arb.executor.filtered', {
            cat: 'arb',
            reason: 'quarantined_pool',
            path: pathStr,
            blockedPools: result.blocked.map(id => id.slice(0, 8) + '...'),
            reasons,
          });
          return false;
        }
      } catch (e) {
        // Non-blocking - continue if quarantine check fails
        logger.warn('arb.executor.quarantine_check_failed', {
          cat: 'arb',
          path: pathStr,
          error: String((e as any)?.message || e),
        });
      }
    }

    // Balance validation (skip if flashloans enabled for flashloanable tokens)
    if (this.config.requireStartBalance !== false && this.walletPublicKey) {
      try {
        // PERF: Use cached balances to avoid RPC calls on every opportunity
        const balances = await this.getCachedBalances();
        const startToken = opp.path[0];
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        
        if (!balances) {
          // Can't validate balance - continue anyway if flashloan available
          const canUseFlashloan = this.config.flashloanSettings?.enabled && 
            (startToken === SOL_MINT || startToken === USDC_MINT);
          if (!canUseFlashloan) {
            logger.debug('arb.executor.filtered', {
              cat: 'arb',
              reason: 'balance_unknown',
              path: pathStr,
            });
            return false;
          }
          // Flashloan available, skip balance check
        } else if (startToken) {
          const balance = startToken === SOL_MINT 
            ? balances.sol 
            : (balances.tokens[startToken] || 0);
          const hasBalance = balance > 0;
          
          // Check if this token can use flashloans
          const canUseFlashloan = this.config.flashloanSettings?.enabled && 
            (startToken === SOL_MINT || startToken === USDC_MINT);
          
          if (!hasBalance && !canUseFlashloan) {
            logger.debug('arb.executor.filtered', {
              cat: 'arb',
              reason: 'no_balance',
              path: pathStr,
              startToken: startToken.slice(0, 8) + '...',
              balance: 0,
              flashloanEnabled: !!this.config.flashloanSettings?.enabled,
            });
            return false;
          }
          
          // Log balance check (debug - fires per opportunity)
          if (hasBalance) {
            logger.debug('arb.executor.balance_check_passed', {
              cat: 'arb',
              path: pathStr,
              startToken: startToken.slice(0, 8) + '...',
              balance,
            });
          } else {
            logger.debug('arb.executor.balance_check_flashloan_available', {
              cat: 'arb',
              path: pathStr,
              startToken: startToken.slice(0, 8) + '...',
              balance: 0,
              flashloanAvailable: true,
            });
          }
        }
      } catch (e) {
        logger.warn('arb.executor.balance_check_failed', {
          cat: 'arb',
          path: pathStr,
          error: String((e as any)?.message || e),
        });
      }
    }

    // All checks passed!
    logger.info('arb.executor.accepted', {
      cat: 'arb',
      path: pathStr,
      profitBps,
      netBps: opp.net_bps,
      hopCount: opp.hop_count,
      // Include all opportunity fields for full context
      opportunity: {
        path: opp.path,
        profit_bps: opp.profit_bps,
        net_bps: opp.net_bps,
        est_profit_usd: opp.est_profit_usd,
        dexes: opp.dexes,
        hop_dexes: opp.hop_dexes,
        hop_rates: opp.hop_rates,
        hop_outs: opp.hop_outs,
        hop_pool_ids: opp.hop_pool_ids,
        hop_fee_bps: opp.hop_fee_bps,
        hop_liquidity_display: opp.hop_liquidity_display,
        hop_count: opp.hop_count,
        rate_product: opp.rate_product,
        link_edges_used: opp.link_edges_used,
        link_penalty_bps_total: opp.link_penalty_bps_total,
        min_edge_liquidity: opp.min_edge_liquidity,
        est_capacity: opp.est_capacity,
        bottleneck: opp.bottleneck,
        detected_ms: opp.detected_ms,
        first_seen_ms: opp.first_seen_ms,
        last_verified_ms: opp.last_verified_ms,
        detections: opp.detections,
      },
    });

    return true;
  }

  private async executeOpportunity(opp: Opportunity): Promise<void> {
    const oppKey = this.getOpportunityKey(opp);
    const pathStr = opp.path.join('->');
    
    // Generate unified trace ID at the VERY START of execution
    // This ID will be propagated through resolver -> builder -> sender for complete log correlation
    const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    
    this.state.inFlight.add(oppKey);
    this.state.lastExecutionTime = Date.now();
    this.state.executionsThisMinute++;
    this.state.totalExecutions++;

    const startTime = Date.now();
    let signature: string | null = null;

    try {
      logger.info('arb.executor.attempt', {
        cat: 'arb',
        traceId,
        path: pathStr,
        dexes: opp.dexes.join(','),
        profitBps: opp.profit_bps,
        netBps: opp.net_bps,
        // Include all opportunity fields for full context
        opportunity: {
          path: opp.path,
          profit_bps: opp.profit_bps,
          net_bps: opp.net_bps,
          est_profit_usd: opp.est_profit_usd,
          dexes: opp.dexes,
          hop_dexes: opp.hop_dexes,
          hop_rates: opp.hop_rates,
          hop_outs: opp.hop_outs,
          hop_pool_ids: opp.hop_pool_ids,
          hop_fee_bps: opp.hop_fee_bps,
          hop_liquidity_display: opp.hop_liquidity_display,
          hop_count: opp.hop_count,
          rate_product: opp.rate_product,
          link_edges_used: opp.link_edges_used,
          link_penalty_bps_total: opp.link_penalty_bps_total,
          min_edge_liquidity: opp.min_edge_liquidity,
          est_capacity: opp.est_capacity,
          bottleneck: opp.bottleneck,
          detected_ms: opp.detected_ms,
          first_seen_ms: opp.first_seen_ms,
          last_verified_ms: opp.last_verified_ms,
          detections: opp.detections,
        },
      });

      // Debug: Log what we're receiving from arb-rs
      logger.debug('arb.executor.opportunity_data', {
        cat: 'arb',
        traceId,
        path: opp.path,
        pathLength: opp.path.length,
        dexes: opp.dexes,
        dexesLength: opp.dexes?.length,
        hopDexes: opp.hop_dexes,
        hopDexesLength: opp.hop_dexes?.length,
        hopPoolIds: opp.hop_pool_ids,
        hopPoolIdsLength: opp.hop_pool_ids?.length,
        // Include all opportunity fields
        opportunity: {
          path: opp.path,
          profit_bps: opp.profit_bps,
          net_bps: opp.net_bps,
          est_profit_usd: opp.est_profit_usd,
          dexes: opp.dexes,
          hop_dexes: opp.hop_dexes,
          hop_rates: opp.hop_rates,
          hop_outs: opp.hop_outs,
          hop_pool_ids: opp.hop_pool_ids,
          hop_fee_bps: opp.hop_fee_bps,
          hop_liquidity_display: opp.hop_liquidity_display,
          hop_count: opp.hop_count,
          rate_product: opp.rate_product,
          link_edges_used: opp.link_edges_used,
          link_penalty_bps_total: opp.link_penalty_bps_total,
          min_edge_liquidity: opp.min_edge_liquidity,
          est_capacity: opp.est_capacity,
          bottleneck: opp.bottleneck,
          detected_ms: opp.detected_ms,
          first_seen_ms: opp.first_seen_ms,
          last_verified_ms: opp.last_verified_ms,
          detections: opp.detections,
        },
      });

      // Handle cycles: arb-rs sends N-node cycles but the resolver expects
      // the full roundtrip path. For an N-node cycle, we need N+1 tokens.
      // arb-rs pattern: path.length === hop_pool_ids.length (N nodes, N edges)
      // Resolver expects: path.length === hopPoolIds.length + 1 (N+1 tokens, N hops)
      let executionPath = opp.path;
      if (opp.hop_pool_ids && opp.path.length === opp.hop_pool_ids.length && opp.path.length > 0) {
        // This is a cycle - close it by appending the starting token
        // Examples:
        //   2-node: [USDC, SOL] -> [USDC, SOL, USDC]
        //   3-node: [TOKEN, SOL, USDC] -> [TOKEN, SOL, USDC, TOKEN]
        executionPath = [...opp.path, opp.path[0]];
        logger.debug('arb.executor.cycle_closed', {
          cat: 'arb',
          traceId,
          originalPath: opp.path,
          closedPath: executionPath,
          nodes: opp.path.length,
          edges: opp.hop_pool_ids.length,
        });
      }

      // CRITICAL: Use hop_dexes (per-hop array), not dexes (deduplicated set)
      // dexes = ["Meteora"] (unique set)
      // hop_dexes = ["Meteora", "Meteora"] (per-hop, matches hop_pool_ids length)
      const executionDexes = opp.hop_dexes || opp.dexes || [];

      // Resolve execution plan and build transaction - wrap in try-catch to log failures
      let plan: any;
      let built: ArbBuildResult;
      let execCfg: any;
      
      // Track whether we're using flashloan mode
      let useFlashloan = false;
      let flashloanAmountUsd = 0;
      
      try {
        // Calculate dynamic size based on opportunity characteristics
        const sizeUsd = await this.calculateDynamicSize(opp);
        
        // Check if flashloan is needed (optimal size > wallet balance)
        const startToken = executionPath[0];
        const flashloanCheck = await this.checkFlashloanNeeded(opp, sizeUsd, startToken);
        useFlashloan = flashloanCheck.needed;
        flashloanAmountUsd = flashloanCheck.flashloanAmountUsd;
        
        // Log what we're passing to the resolver
        logger.debug('arb.executor.resolving_plan', {
          cat: 'arb',
          traceId,
          path: executionPath.join('->'),
          sizeUsd,
          slippageBps: this.config.slippageBps,
          bottleneckUsd: opp.est_capacity ?? opp.min_edge_liquidity,
          profitBps: opp.net_bps ?? opp.profit_bps,
          dynamicSizingEnabled: !!this.config.dynamicSizing?.enabled,
          flashloanNeeded: useFlashloan,
          flashloanAmountUsd,
          walletBalanceUsd: flashloanCheck.walletBalanceUsd,
          flashloanReason: flashloanCheck.reason,
        });
        
        // FINAL SAFETY: Cap size to wallet balance unless using flashloan
        // This is the definitive check that ensures we never try to spend more than we have
        let effectiveSizeUsd = sizeUsd;
        
        if (!useFlashloan) {
          // Get wallet balance for the start token (cached, refreshed after each execution)
          const SOL_MINT = 'So11111111111111111111111111111111111111112';
          const balances = await this.getCachedBalances();
          
          if (balances) {
            const balance = startToken === SOL_MINT 
              ? balances.sol 
              : (balances.tokens[startToken] || 0);
            
            // First check: do we have any balance at all?
            if (balance <= 0) {
              logger.debug('arb.executor.skipped.no_balance', {
                cat: 'arb',
                traceId,
                path: executionPath.join('->'),
                startToken: startToken.slice(0, 8) + '...',
                balance,
                requestedSize: sizeUsd,
                reason: 'zero_balance_no_flashloan',
              });
              throw new Error('insufficient_balance: wallet has no balance for start token and flashloan unavailable');
            }
            
            const price = Number(getPriceByMint(startToken)?.usdc ?? 0);
            
            if (price > 0) {
              // Have price data - use USD-based capping
              const walletBalanceUsd = balance * price;
              
              if (walletBalanceUsd < effectiveSizeUsd) {
                logger.debug('arb.executor.sizing.capped_to_wallet', {
                  cat: 'arb',
                  traceId,
                  originalSize: effectiveSizeUsd,
                  walletBalanceUsd,
                  effectiveSize: walletBalanceUsd,
                  reason: 'final_safety_cap',
                });
                effectiveSizeUsd = walletBalanceUsd;
              }
            } else {
              // Have balance but no price - use FRESH balance for raw size
              // Don't rely on stale _rawBalanceFallback from sizing phase
              logger.debug('arb.executor.using_raw_balance', {
                cat: 'arb',
                traceId,
                path: executionPath.join('->'),
                startToken: startToken.slice(0, 8) + '...',
                balance,
                reason: 'no_price_data_using_fresh_balance',
              });
              // Store fresh balance and mark for raw size in resolver
              (opp as any)._useRawSize = true;
              (opp as any)._rawBalanceFallback = balance; // Always use fresh balance
            }
          } else {
            // Cannot verify balance - use minimum safe size or the flashloan check's balance if available
            if (flashloanCheck.walletBalanceUsd > 0) {
              effectiveSizeUsd = Math.min(effectiveSizeUsd, flashloanCheck.walletBalanceUsd);
              logger.debug('arb.executor.sizing.capped_to_flashcheck_balance', {
                cat: 'arb',
                traceId,
                originalSize: sizeUsd,
                walletBalanceUsd: flashloanCheck.walletBalanceUsd,
                effectiveSize: effectiveSizeUsd,
              });
            } else {
              // No balance info at all - use minimum safe size
              const minSafeSize = this.config.dynamicSizing?.minSizeUsd || 1;
              logger.warn('arb.executor.sizing.balance_unknown', {
                cat: 'arb',
                traceId,
                path: executionPath.join('->'),
                originalSize: effectiveSizeUsd,
                fallbackSize: minSafeSize,
              });
              effectiveSizeUsd = Math.min(effectiveSizeUsd, minSafeSize);
            }
          }
        }
        
        // Resolve execution plan - pass traceId for complete log correlation
        // Pass minProfitBps to enforce profitability at the final hop for arb cycles
        
        // Check if we need to use raw size instead of USD size (when price data unavailable)
        let resolverInput: any = {
          path: executionPath,
          hopPoolIds: opp.hop_pool_ids || [],
          dexes: executionDexes,
          sizeUsd: effectiveSizeUsd,
          slippageBps: this.config.slippageBps,
          traceId,
          minProfitBps: this.config.minProfitBps || 0,  // Enforce profitability for arb cycles
        };
        
        // If we have raw balance fallback (no price data), convert to raw atoms and pass as `size`
        if ((opp as any)._useRawSize && (opp as any)._rawBalanceFallback) {
          const rawBalance = (opp as any)._rawBalanceFallback as number;
          const startMint = executionPath[0];
          
          try {
            // Resolve decimals for the start token
            const decimals = await resolveDecimals(startMint);
            if (decimals !== undefined && decimals >= 0 && decimals <= 18) {
              // Convert whole token balance to raw atoms
              // Use 90% of balance for safety margin (accounts for rounding, fees, etc.)
              const useFraction = 0.90;
              const rawAtoms = BigInt(Math.floor(rawBalance * useFraction * Math.pow(10, decimals)));
              
              // Sanity check: ensure rawAtoms is positive and reasonable
              if (rawAtoms > 0n) {
                logger.debug('arb.executor.using_raw_size', {
                  cat: 'arb',
                  traceId,
                  path: executionPath.join('->'),
                  startMint: startMint.slice(0, 8) + '...',
                  rawBalance,
                  decimals,
                  rawAtoms: rawAtoms.toString(),
                  useFraction,
                });
                
                // Pass raw size instead of USD size
                resolverInput.size = rawAtoms;
                // Remove sizeUsd to ensure resolver uses raw size
                delete resolverInput.sizeUsd;
              } else {
                logger.warn('arb.executor.raw_size_zero', {
                  cat: 'arb',
                  traceId,
                  path: executionPath.join('->'),
                  rawBalance,
                  decimals,
                  reason: 'calculated_raw_atoms_is_zero',
                });
                // Don't proceed - balance too small
                throw new Error('insufficient_balance: calculated raw size is zero');
              }
            } else {
              logger.warn('arb.executor.decimals_resolve_failed', {
                cat: 'arb',
                traceId,
                path: executionPath.join('->'),
                startMint: startMint.slice(0, 8) + '...',
                decimals,
                fallback: 'using_sizeUsd',
              });
            }
          } catch (e) {
            logger.warn('arb.executor.raw_size_conversion_failed', {
              cat: 'arb',
              traceId,
              error: String((e as any)?.message || e),
            });
            throw e; // Re-throw to prevent execution with wrong size
          }
        }
        
        plan = await resolveDirectPlan(resolverInput, {} as any);

        // Build transaction using the same method as arb routes - pass traceId
        // Pass useRouter config to use on-chain router when enabled
        // PERF: Use static import instead of dynamic import
        built = await buildTransactionSummary(plan, undefined, {
          useRouter: this.config.useRouter,
          routerExecutionMode: this.config.routerExecutionMode,
        }, traceId);

        // Load execution config
        execCfg = await loadExecConfig();
        
        // Log flashloan status
        if (useFlashloan) {
          logger.info('arb.executor.flashloan.using', {
            cat: 'arb',
            traceId,
            path: executionPath.join('->'),
            flashloanAmountUsd,
            walletBalanceUsd: flashloanCheck.walletBalanceUsd,
            totalSizeUsd: sizeUsd,
            estFeeUsd: flashloanAmountUsd * 0.0009,
          });
        }
      } catch (buildError: any) {
        // Log build/resolution failure to execute-attempts
        // PERF: Use static imports and non-blocking write
        try {
          const dexes = Array.from(new Set((executionDexes || []).filter(Boolean)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 30000, Date.now(), 500);
          
          // PERF: Non-blocking - don't await the file write
          void writeTxFullDump('preflight', {
            id: traceId,
            txId: traceId,
            traceId,
            opportunity: {
              ...opp,
              path: opp.path,
              profit_bps: opp.profit_bps,
              net_bps: opp.net_bps,
              est_profit_usd: opp.est_profit_usd,
              dexes: opp.dexes,
              hop_dexes: opp.hop_dexes,
              hop_rates: opp.hop_rates,
              hop_outs: opp.hop_outs,
              hop_pool_ids: opp.hop_pool_ids,
              hop_fee_bps: opp.hop_fee_bps,
              hop_liquidity_display: opp.hop_liquidity_display,
              hop_count: opp.hop_count,
              rate_product: opp.rate_product,
              link_edges_used: opp.link_edges_used,
              link_penalty_bps_total: opp.link_penalty_bps_total,
              min_edge_liquidity: opp.min_edge_liquidity,
              est_capacity: opp.est_capacity,
              bottleneck: opp.bottleneck,
              detected_ms: opp.detected_ms,
              first_seen_ms: opp.first_seen_ms,
              last_verified_ms: opp.last_verified_ms,
              detections: opp.detections,
            },
            plan: null, // Plan resolution or build failed
            dexes,
            execConfig: null,
            built: null,
            err: {
              type: 'build_failed',
              message: String(buildError?.message || buildError),
              stack: buildError?.stack,
            },
            executorLogs: txLogs,
          });
        } catch (logErr) {
          try { 
            logger.error('arb.executor.build.log_failed', { 
              cat: 'arb', 
              traceId,
              ctx: { 
                oppKey,
                traceId,
                buildError: String(buildError?.message || buildError),
                logError: String(logErr?.message || logErr)
              } 
            }); 
          } catch {}
        }
        throw buildError; // Re-throw to maintain existing error handling
      }

      // Execute based on mode
      const mode = execCfg.mode || 'simulate';
      
      // Use ALT addresses from built transaction, fallback to exec config
      const altAddresses = built.lookupTableAddresses || execCfg.lookupTableAddresses || [];
      
      // If flashloan is needed and mode is direct or simulate_then_execute, use router's flashloan execution
      if (useFlashloan && (mode === 'direct' || mode === 'simulate_then_execute')) {
        logger.info('arb.executor.flashloan.executing', {
          cat: 'arb',
          traceId,
          path: pathStr,
          flashloanAmountUsd,
        });
        
        try {
          // PERF: Use static imports instead of dynamic imports
          const kp = await ensureWallet(CONFIG.walletPath);
          
          // minProfit is now calculated automatically from plan.initialInputRaw and plan.minProfitBps
          // by buildRouterTransaction when plan.isArbCycle is true (router-level enforcement)
          // verbose: false for actual execution to avoid revealing trade details in public logs
          const routerResult = await buildRouterTransaction(plan, kp, {
            mode: ExecutionMode.FlashLoan,
            verbose: false,
          });
          
          if (!routerResult.usedRouter || routerResult.error) {
            logger.warn('arb.executor.flashloan.router_failed', {
              cat: 'arb',
              traceId,
              error: routerResult.error || 'Router not available',
              fallbackToWallet: !!this.config.flashloanSettings?.fallbackToWallet,
            });
            
            // Fallback to regular execution if configured
            if (!this.config.flashloanSettings?.fallbackToWallet) {
              throw new Error(`Flashloan failed: ${routerResult.error}`);
            }
            // Continue with regular execution below
          } else {
            // Execute flashloan transaction
            const sendResult = await assembleAndSend(routerResult.instructions, {
              computeUnitLimit: execCfg.computeUnitLimit,
              computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
              lookupTableAddresses: altAddresses,
              traceId,
            });
            signature = sendResult?.signature || null;
            
            // Log success
            logger.info('arb.executor.flashloan.executed', {
              cat: 'arb',
              traceId,
              path: pathStr,
              signature: signature?.slice(0, 16),
              flashloanAmountUsd,
              usedFlashLoan: routerResult.usedFlashLoan,
            });
            
            // Log to tx history
            addTxRecord({
              id: traceId,
              timeMs: Date.now(),
              path: executionPath,
              hops: plan.hops.map((h: any) => ({
                dex: h.dex,
                variant: h.variant || '',
                poolId: h.poolId,
              })),
              ixCount: routerResult.instructions.length,
              txSizeBytes: 0, // Not available here
              signature: signature || null,
              status: signature ? 'send_ok' : 'send_err',
            });
            
            this.state.successfulExecutions++;
            await this.notifyExecuted(opp);
            return;
          }
        } catch (flashErr: any) {
          logger.error('arb.executor.flashloan.error', {
            cat: 'arb',
            traceId,
            error: String(flashErr?.message || flashErr),
          });
          
          if (!this.config.flashloanSettings?.fallbackToWallet) {
            throw flashErr;
          }
          // Continue with regular execution below
        }
      }
      
      if (mode === 'simulate') {
        // Simulate only - pass traceId for log correlation
        const simResult = await assembleAndSimulate(built.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
          traceId,
        });
        
        // Log full dump with opportunity data
        // PERF: Use static imports and non-blocking write
        try {
          const dexes = Array.from(new Set(plan.hops.map((h: any) => h.dex)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 30000, Date.now(), 500);
          
          // PERF: Non-blocking - don't await the file write
          void writeTxFullDump('preflight', {
            id: traceId,
            txId: traceId,
            traceId,
            opportunity: {
              // Include ALL opportunity fields from arb-rs
              ...opp,
              // Ensure all fields are explicitly included
              path: opp.path,
              profit_bps: opp.profit_bps,
              net_bps: opp.net_bps,
              est_profit_usd: opp.est_profit_usd,
              dexes: opp.dexes,
              hop_dexes: opp.hop_dexes,
              hop_rates: opp.hop_rates,
              hop_outs: opp.hop_outs,
              hop_pool_ids: opp.hop_pool_ids,
              hop_fee_bps: opp.hop_fee_bps,
              hop_liquidity_display: opp.hop_liquidity_display,
              hop_count: opp.hop_count,
              rate_product: opp.rate_product,
              link_edges_used: opp.link_edges_used,
              link_penalty_bps_total: opp.link_penalty_bps_total,
              min_edge_liquidity: opp.min_edge_liquidity,
              est_capacity: opp.est_capacity,
              bottleneck: opp.bottleneck,
              detected_ms: opp.detected_ms,
              first_seen_ms: opp.first_seen_ms,
              last_verified_ms: opp.last_verified_ms,
              detections: opp.detections,
            },
            plan,
            dexes, // Include all DEXes involved
            execConfig: execCfg,
            built,
            sim: simResult,
            executorLogs: txLogs,
            // Add calculated expected outputs for sanity checking
            expectedOutputs: opp.hop_outs ? {
              // Expected output at each hop (from arb-rs calculations)
              hopOutputs: opp.hop_outs,
              // Expected rates at each hop
              hopRates: opp.hop_rates,
              // Expected fees at each hop
              hopFees: opp.hop_fee_bps,
              // Overall rate product (should be > 1.0 for profitable arb)
              rateProduct: opp.rate_product,
              // Expected final output (last hop output)
              finalOutput: opp.hop_outs && opp.hop_outs.length > 0 ? opp.hop_outs[opp.hop_outs.length - 1] : null,
            } : null,
          });
        } catch (logErr) {
          try { 
            logger.error('tx.log.write_failed', { 
              cat: 'tx', 
              traceId,
              ctx: { 
                id: traceId,
                traceId,
                phase: 'preflight',
                error: String(logErr?.message || logErr)
              } as any 
            }); 
          } catch {}
        }
        
        // Parse simulation logs for analysis (both success and failure)
        const simAnalysis = parseSimulationLogs(simResult.logs);
        const simReport = buildSimulationReport(opp, plan, simAnalysis);
        const condensedReport = formatSimReportForLog(simReport);
        
        if (simResult.err) {
          // Simulation failed - log detailed error analysis
          logger.error('arb.executor.simulate.failed', {
            cat: 'arb',
            traceId,
            path: pathStr,
            error: simResult.err,
            simulation: {
              swapsExecuted: simAnalysis.swapsExecuted.length,
              totalHops: plan.hops.length,
              profitCheckFailed: simAnalysis.profitCheckFailed,
              errorCode: simAnalysis.errorCode,
              errorMessage: simAnalysis.errorMessage,
              lastSuccessfulStep: simAnalysis.lastSuccessfulStep,
            },
            comparison: {
              expectedProfitBps: opp.profit_bps,
              expectedNetBps: opp.net_bps,
              expectedRateProduct: opp.rate_product,
              quotedMinProfit: simReport.quoted?.calculatedMinProfit,
              actualProfit: simAnalysis.profitValue?.toString(),
              isArbCycle: plan.isArbCycle,
              initialInputRaw: plan.initialInputRaw?.toString(),
            },
            hopComparison: condensedReport.hopComparison,
            logs: simResult.logs?.slice(-10),
          });
          
          emit('arb:simulation:failed', {
            path: pathStr,
            error: `Simulation failed: ${simResult.err}`,
            timestamp: Date.now(),
            analysis: {
              swapsExecuted: simAnalysis.swapsExecuted.length,
              totalHops: plan.hops.length,
              profitCheckFailed: simAnalysis.profitCheckFailed,
              failedAt: simReport.analysis?.failedAtHop,
            },
          });
        } else {
          // Simulation succeeded - log with analysis
          logger.info('arb.executor.simulated', {
            cat: 'arb',
            traceId,
            path: pathStr,
            simResult: {
              err: simResult.err,
              logsCount: simResult.logs?.length,
            },
            analysis: {
              swapsExecuted: simAnalysis.swapsExecuted.length,
              totalHops: plan.hops.length,
              profitValue: simAnalysis.profitValue?.toString(),
              profitCheckFailed: simAnalysis.profitCheckFailed,
            },
            // Include opportunity data for context
            opportunity: {
              path: opp.path,
              profit_bps: opp.profit_bps,
              net_bps: opp.net_bps,
              est_profit_usd: opp.est_profit_usd,
              hop_dexes: opp.hop_dexes,
              hop_rates: opp.hop_rates,
              hop_outs: opp.hop_outs,
              hop_pool_ids: opp.hop_pool_ids,
              rate_product: opp.rate_product,
            },
            hopComparison: condensedReport.hopComparison,
          });
        }
        this.state.successfulExecutions++;
      } else if (mode === 'simulate_then_execute') {
        // Adaptive sizing: try progressively smaller sizes on profit check failures
        const adaptiveCfg = this.config.adaptiveSizing;
        const adaptiveEnabled = adaptiveCfg?.enabled ?? false;
        const maxRetries = adaptiveEnabled ? (adaptiveCfg?.maxRetries ?? 3) : 0;
        const reductionFactor = adaptiveCfg?.reductionFactor ?? 0.5;
        const adaptiveMinSizeUsd = adaptiveCfg?.minSizeUsd ?? this.config.dynamicSizing?.minSizeUsd ?? 5;
        const adaptiveTimeoutMs = adaptiveCfg?.timeoutMs ?? 500;
        
        let currentSizeUsd = effectiveSizeUsd;
        let attempt = 0;
        let lastSimResult: { logs?: string[]; err?: any; wireBase64?: string } | null = null;
        let lastSimAnalysis: ReturnType<typeof parseSimulationLogs> | null = null;
        let currentPlan = plan;
        let currentBuilt = built;
        const adaptiveStartTime = Date.now();
        const originalSizeUsd = effectiveSizeUsd;
        
        // Adaptive retry loop
        while (attempt <= maxRetries) {
          // Check timeout (skip for first attempt)
          if (attempt > 0 && (Date.now() - adaptiveStartTime) > adaptiveTimeoutMs) {
            logger.warn('arb.executor.adaptive.timeout', {
              cat: 'arb',
              traceId,
              path: pathStr,
              attempts: attempt,
              elapsedMs: Date.now() - adaptiveStartTime,
              timeoutMs: adaptiveTimeoutMs,
            });
            break;
          }
          
          // Rebuild plan and transaction with reduced size (skip for first attempt)
          if (attempt > 0) {
            logger.info('arb.executor.adaptive.retry', {
              cat: 'arb',
              traceId,
              path: pathStr,
              attempt,
              previousSize: currentSizeUsd / reductionFactor,
              newSize: currentSizeUsd,
              reason: 'profit_check_failed',
            });
            
            try {
              // Re-resolve plan with reduced size
              currentPlan = await resolveDirectPlan({
                path: executionPath,
                hopPoolIds: opp.hop_pool_ids || [],
                dexes: executionDexes,
                sizeUsd: currentSizeUsd,
                slippageBps: this.config.slippageBps,
                traceId,
                minProfitBps: this.config.minProfitBps || 0,
              }, {} as any);
              
              // Rebuild transaction
              currentBuilt = await buildTransactionSummary(currentPlan, undefined, {
                useRouter: this.config.useRouter,
                routerExecutionMode: this.config.routerExecutionMode,
              }, traceId);
            } catch (rebuildErr: any) {
              logger.warn('arb.executor.adaptive.rebuild_failed', {
                cat: 'arb',
                traceId,
                path: pathStr,
                attempt,
                error: String(rebuildErr?.message || rebuildErr),
              });
              break;
            }
          }
          
          // Simulate with current size
          const simResult = await assembleAndSimulate(currentBuilt.instructions, {
            computeUnitLimit: execCfg.computeUnitLimit,
            computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
            lookupTableAddresses: altAddresses,
            traceId,
          });
          
          lastSimResult = simResult;
          lastSimAnalysis = parseSimulationLogs(simResult.logs);
          
          // Success! Break out of retry loop
          if (!simResult.err) {
            if (attempt > 0) {
              logger.info('arb.executor.adaptive.success', {
                cat: 'arb',
                traceId,
                path: pathStr,
                attempt,
                finalSizeUsd: currentSizeUsd,
                originalSizeUsd,
                reductionPercent: ((1 - currentSizeUsd / originalSizeUsd) * 100).toFixed(1),
                elapsedMs: Date.now() - adaptiveStartTime,
              });
            }
            // Update plan and built to use the successful versions
            plan = currentPlan;
            built = currentBuilt;
            break;
          }
          
          // Check if this is a retryable error (profit check failed)
          const isRetryable = adaptiveEnabled && lastSimAnalysis.profitCheckFailed;
          
          if (!isRetryable) {
            // Not a profit check failure, don't retry
            if (adaptiveEnabled && !lastSimAnalysis.profitCheckFailed) {
              logger.debug('arb.executor.adaptive.not_retryable', {
                cat: 'arb',
                traceId,
                path: pathStr,
                errorCode: lastSimAnalysis.errorCode,
                errorMessage: lastSimAnalysis.errorMessage,
                profitCheckFailed: lastSimAnalysis.profitCheckFailed,
              });
            }
            break;
          }
          
          // Calculate next size
          const nextSizeUsd = currentSizeUsd * reductionFactor;
          
          // Check if we'd go below minimum
          if (nextSizeUsd < adaptiveMinSizeUsd) {
            logger.info('arb.executor.adaptive.min_size_reached', {
              cat: 'arb',
              traceId,
              path: pathStr,
              attempt,
              currentSizeUsd,
              minSizeUsd: adaptiveMinSizeUsd,
            });
            break;
          }
          
          currentSizeUsd = nextSizeUsd;
          attempt++;
        }
        
        // Check if simulation ultimately failed
        if (lastSimResult?.err) {
          // Parse simulation logs for detailed analysis
          const simReport = buildSimulationReport(opp, currentPlan, lastSimAnalysis!);
          const condensedReport = formatSimReportForLog(simReport);
          
          logger.error('arb.executor.simulate_then_execute.sim_failed', {
            cat: 'arb',
            traceId,
            path: pathStr,
            error: lastSimResult.err,
            adaptiveAttempts: attempt,
            finalSizeUsd: currentSizeUsd,
            originalSizeUsd,
            // Include detailed simulation analysis
            simulation: {
              swapsExecuted: lastSimAnalysis!.swapsExecuted.length,
              totalHops: currentPlan.hops.length,
              profitCheckFailed: lastSimAnalysis!.profitCheckFailed,
              errorCode: lastSimAnalysis!.errorCode,
              errorMessage: lastSimAnalysis!.errorMessage,
              lastSuccessfulStep: lastSimAnalysis!.lastSuccessfulStep,
            },
            // Expected vs actual comparison
            comparison: {
              expectedProfitBps: opp.profit_bps,
              expectedNetBps: opp.net_bps,
              expectedRateProduct: opp.rate_product,
              quotedMinProfit: simReport.quoted?.calculatedMinProfit,
              actualProfit: lastSimAnalysis!.profitValue?.toString(),
              isArbCycle: currentPlan.isArbCycle,
              initialInputRaw: currentPlan.initialInputRaw?.toString(),
            },
            // Condensed hop comparison for quick debugging
            hopComparison: condensedReport.hopComparison,
            // Last 10 logs for context
            logs: lastSimResult.logs?.slice(-10),
          });

          emit('arb:execution:failed', {
            path: pathStr,
            error: `Simulation failed after ${attempt} attempts: ${lastSimResult.err}`,
            timestamp: Date.now(),
            analysis: {
              swapsExecuted: lastSimAnalysis!.swapsExecuted.length,
              totalHops: currentPlan.hops.length,
              profitCheckFailed: lastSimAnalysis!.profitCheckFailed,
              failedAt: simReport.analysis?.failedAtHop,
              adaptiveAttempts: attempt,
            },
          });

          throw new Error(`Simulation failed after ${attempt} attempt(s): ${lastSimResult.err}`);
        }

        logger.info('arb.executor.simulate_then_execute.sim_ok', {
          cat: 'arb',
          traceId,
          path: pathStr,
          adaptiveAttempts: attempt,
          finalSizeUsd: currentSizeUsd,
          originalSizeUsd,
          logs: lastSimResult?.logs?.slice(-3),
        });

        // Simulation passed - proceed with actual execution
        let tipResult: TipResult | null = null;
        const firstHop = plan.hops[0];
        if (firstHop && opp.profit_bps > 0) {
          try {
            const kp = await ensureWallet(CONFIG.walletPath);
            tipResult = await calculateProfitBasedTip(kp.publicKey, {
              inputMint: firstHop.inputMint,
              inputAmountRaw: firstHop.amountInRaw,
              inputDecimals: firstHop.inputDecimals ?? 6,
              profitBps: opp.profit_bps,
            });
          } catch (tipErr: any) {
            logger.warn('arb.executor.tip_calc_failed', { 
              cat: 'arb', 
              traceId,
              error: String(tipErr?.message || tipErr) 
            });
          }
        }

        const instructionsWithTip = tipResult?.tipIx 
          ? [...built.instructions, tipResult.tipIx] 
          : built.instructions;

        const jitoCfg = await loadJitoConfig();
        const jitoEnabled = jitoCfg.enabled;

        const sendResult = await assembleAndSend(instructionsWithTip, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
          traceId,
          jito: jitoEnabled ? {
            enabled: true,
            sendToBlockEngine: async (wireBase64: string) => {
              const sig = await sendToBlockEngine(wireBase64);
              logger.info('arb.jito.parallel_sent', { 
                cat: 'tx', 
                traceId,
                signature: sig.slice(0, 16),
                tipLamports: tipResult?.tipLamports ?? 0,
                hasTip: !!tipResult,
              });
              return sig;
            },
          } : undefined,
        });
        signature = sendResult?.signature || null;

        if (signature) {
          logger.info('arb.executor.simulate_then_execute.success', {
            cat: 'arb',
            traceId,
            path: pathStr,
            signature,
            durationMs: Date.now() - startTime,
          });

          this.state.successfulExecutions++;
          await this.notifyExecuted(opp);

          await addTxRecord({
            id: signature.slice(0, 8),
            timeMs: Date.now(),
            path: plan.path,
            hops: plan.hops.map((h: any) => ({
              dex: h.dex,
              variant: h.variant,
              poolId: h.poolId,
            })),
            ixCount: built.ixCount,
            txSizeBytes: built.sizeBytes,
            signature,
            status: 'send_ok',
          });

          emit('arb:execution', {
            path: pathStr,
            signature,
            profitBps: opp.profit_bps,
            netBps: opp.net_bps,
            timestamp: Date.now(),
          });
        }
      } else {
        // Calculate Jito tip based on expected profit
        // Note: calculateProfitBasedTip checks stored jito config internally and returns null if disabled
        let tipResult: TipResult | null = null;
        const firstHop = plan.hops[0];
        if (firstHop && opp.profit_bps > 0) {
          try {
            const kp = await ensureWallet(CONFIG.walletPath);
            tipResult = await calculateProfitBasedTip(kp.publicKey, {
              inputMint: firstHop.inputMint,
              inputAmountRaw: firstHop.amountInRaw,
              inputDecimals: firstHop.inputDecimals ?? 6,
              profitBps: opp.profit_bps,
            });
          } catch (tipErr: any) {
            logger.warn('arb.executor.tip_calc_failed', { 
              cat: 'arb', 
              traceId,
              error: String(tipErr?.message || tipErr) 
            });
          }
        }

        // Append tip instruction if calculated (so it only executes if transaction succeeds)
        const instructionsWithTip = tipResult?.tipIx 
          ? [...built.instructions, tipResult.tipIx] 
          : built.instructions;

        // Always use Jito parallel sending when Jito is enabled (not just when we have a tip)
        // Use the same config source as tip calculation for consistency
        // PERF: Use static import instead of dynamic import
        const jitoCfg = await loadJitoConfig();
        const jitoEnabled = jitoCfg.enabled;

        // Execute on-chain - with Jito parallel sending when enabled - pass traceId
        const sendResult = await assembleAndSend(instructionsWithTip, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
          traceId,
          // Send to Jito in parallel with RPC when Jito is enabled
          jito: jitoEnabled ? {
            enabled: true,
            sendToBlockEngine: async (wireBase64: string) => {
              const sig = await sendToBlockEngine(wireBase64);
              logger.info('arb.jito.parallel_sent', { 
                cat: 'tx', 
                traceId,
                signature: sig.slice(0, 16),
                tipLamports: tipResult?.tipLamports ?? 0,
                expectedProfitLamports: tipResult?.expectedProfitLamports ?? 0,
                hasTip: !!tipResult,
              });
              return sig;
            },
          } : undefined,
        });
        signature = sendResult?.signature || null;

        // Log full dump with opportunity data
        // PERF: Use static imports and non-blocking write
        try {
          const dexes = Array.from(new Set(plan.hops.map((h: any) => h.dex)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 60000, Date.now(), 500);
          
          // PERF: Non-blocking - don't await the file write
          void writeTxFullDump('execute', {
            id: traceId,
            txId: traceId,
            traceId,
            opportunity: {
              // Include ALL opportunity fields from arb-rs
              ...opp,
              // Ensure all fields are explicitly included
              path: opp.path,
              profit_bps: opp.profit_bps,
              net_bps: opp.net_bps,
              est_profit_usd: opp.est_profit_usd,
              dexes: opp.dexes,
              hop_dexes: opp.hop_dexes,
              hop_rates: opp.hop_rates,
              hop_outs: opp.hop_outs,
              hop_pool_ids: opp.hop_pool_ids,
              hop_fee_bps: opp.hop_fee_bps,
              hop_liquidity_display: opp.hop_liquidity_display,
              hop_count: opp.hop_count,
              rate_product: opp.rate_product,
              link_edges_used: opp.link_edges_used,
              link_penalty_bps_total: opp.link_penalty_bps_total,
              min_edge_liquidity: opp.min_edge_liquidity,
              est_capacity: opp.est_capacity,
              bottleneck: opp.bottleneck,
              detected_ms: opp.detected_ms,
              first_seen_ms: opp.first_seen_ms,
              last_verified_ms: opp.last_verified_ms,
              detections: opp.detections,
            },
            plan,
            dexes, // Include all DEXes involved
            execConfig: execCfg,
            built,
            send: sendResult,
            signature,
            executorLogs: txLogs,
            // Jito tip info if applied
            jitoTip: tipResult ? {
              tipLamports: tipResult.tipLamports,
              tipAccount: tipResult.tipAccount,
              expectedProfitLamports: tipResult.expectedProfitLamports,
              breakdown: tipResult.breakdown,
            } : null,
            // Add calculated expected outputs for sanity checking
            expectedOutputs: opp.hop_outs ? {
              // Expected output at each hop (from arb-rs calculations)
              hopOutputs: opp.hop_outs,
              // Expected rates at each hop
              hopRates: opp.hop_rates,
              // Expected fees at each hop
              hopFees: opp.hop_fee_bps,
              // Overall rate product (should be > 1.0 for profitable arb)
              rateProduct: opp.rate_product,
              // Expected final output (last hop output)
              finalOutput: opp.hop_outs && opp.hop_outs.length > 0 ? opp.hop_outs[opp.hop_outs.length - 1] : null,
            } : null,
          });
        } catch (logErr) {
          try { 
            logger.error('tx.log.write_failed', { 
              cat: 'tx', 
              traceId,
              ctx: { 
                id: traceId,
                traceId,
                phase: 'execute',
                error: String(logErr?.message || logErr)
              } as any 
            }); 
          } catch {}
        }

        if (signature) {
          logger.info('arb.executor.success', {
            cat: 'arb',
            traceId,
            path: pathStr,
            signature,
            durationMs: Date.now() - startTime,
            // Include opportunity data for context
            opportunity: {
              path: opp.path,
              profit_bps: opp.profit_bps,
              net_bps: opp.net_bps,
              est_profit_usd: opp.est_profit_usd,
              dexes: opp.dexes,
              hop_dexes: opp.hop_dexes,
              hop_rates: opp.hop_rates,
              hop_outs: opp.hop_outs,
              hop_pool_ids: opp.hop_pool_ids,
              hop_fee_bps: opp.hop_fee_bps,
              hop_liquidity_display: opp.hop_liquidity_display,
              hop_count: opp.hop_count,
              rate_product: opp.rate_product,
              link_edges_used: opp.link_edges_used,
              link_penalty_bps_total: opp.link_penalty_bps_total,
              min_edge_liquidity: opp.min_edge_liquidity,
              est_capacity: opp.est_capacity,
              bottleneck: opp.bottleneck,
              detected_ms: opp.detected_ms,
              first_seen_ms: opp.first_seen_ms,
              last_verified_ms: opp.last_verified_ms,
              detections: opp.detections,
            },
          });

          this.state.successfulExecutions++;

          // Notify arb-rs that this was executed
          await this.notifyExecuted(opp);

          // Record in tx history
          await addTxRecord({
            id: signature.slice(0, 8),
            timeMs: Date.now(),
            path: plan.path,
            hops: plan.hops.map((h: any) => ({
              dex: h.dex,
              variant: h.variant,
              poolId: h.poolId,
            })),
            ixCount: built.ixCount,
            txSizeBytes: built.sizeBytes,
            signature,
            status: 'send_ok',
          });

          // Emit to frontend
          emit('arb:execution', {
            path: pathStr,
            signature,
            profitBps: opp.profit_bps,
            netBps: opp.net_bps,
            timestamp: Date.now(),
          });
        }
      }

      // Update execution tracking
      this.state.recentExecutions.set(oppKey, Date.now());
      const count = (this.state.executionCounts.get(oppKey) || 0) + 1;
      this.state.executionCounts.set(oppKey, count);

    } catch (e: any) {
      this.state.failedExecutions++;
      
      // Better error serialization
      const errorMsg = e?.message || (e instanceof Error ? e.toString() : JSON.stringify(e));
      
      // Log to execute-attempts even on failure
      // PERF: Use static imports and non-blocking write
      try {
        const txLogs = getTxRelatedLogs(traceId, Date.now() - 60000, Date.now(), 500);
        
        // Try to get plan and built if they exist (might be undefined if error occurred early)
        const plan = (e as any)?.plan || null;
        const built = (e as any)?.built || null;
        const execCfg = (e as any)?.execCfg || null;
        const executionDexes = opp.hop_dexes || opp.dexes || [];
        
        // PERF: Non-blocking - don't await the file write
        void writeTxFullDump('execute', {
          id: traceId,
          txId: traceId,
          traceId,
          opportunity: {
            ...opp,
            path: opp.path,
            profit_bps: opp.profit_bps,
            net_bps: opp.net_bps,
            est_profit_usd: opp.est_profit_usd,
            dexes: opp.dexes,
            hop_dexes: opp.hop_dexes,
            hop_rates: opp.hop_rates,
            hop_outs: opp.hop_outs,
            hop_pool_ids: opp.hop_pool_ids,
            hop_fee_bps: opp.hop_fee_bps,
            hop_liquidity_display: opp.hop_liquidity_display,
            hop_count: opp.hop_count,
            rate_product: opp.rate_product,
            link_edges_used: opp.link_edges_used,
            link_penalty_bps_total: opp.link_penalty_bps_total,
            min_edge_liquidity: opp.min_edge_liquidity,
            est_capacity: opp.est_capacity,
            bottleneck: opp.bottleneck,
            detected_ms: opp.detected_ms,
            first_seen_ms: opp.first_seen_ms,
            last_verified_ms: opp.last_verified_ms,
            detections: opp.detections,
          },
          plan,
          dexes: plan ? Array.from(new Set(plan.hops.map((h: any) => h.dex))) : Array.from(new Set(executionDexes || [])),
          execConfig: execCfg,
          built,
          err: {
            type: 'execution_failed',
            message: errorMsg,
            stack: e?.stack,
          },
          executorLogs: txLogs,
        });
      } catch (logErr) {
        try { 
          logger.error('arb.executor.log_failed', { 
            cat: 'arb', 
            traceId,
            ctx: { 
              oppKey,
              traceId,
              executionError: errorMsg,
              logError: String(logErr?.message || logErr)
            } 
          }); 
        } catch {}
      }
      
      logger.error('arb.executor.failed', {
        cat: 'arb',
        traceId,
        path: pathStr,
        error: errorMsg,
        durationMs: Date.now() - startTime,
        // Include opportunity data for context
        opportunity: {
          path: opp.path,
          profit_bps: opp.profit_bps,
          net_bps: opp.net_bps,
          est_profit_usd: opp.est_profit_usd,
          dexes: opp.dexes,
          hop_dexes: opp.hop_dexes,
          hop_rates: opp.hop_rates,
          hop_outs: opp.hop_outs,
          hop_pool_ids: opp.hop_pool_ids,
          hop_fee_bps: opp.hop_fee_bps,
          hop_liquidity_display: opp.hop_liquidity_display,
          hop_count: opp.hop_count,
          rate_product: opp.rate_product,
          link_edges_used: opp.link_edges_used,
          link_penalty_bps_total: opp.link_penalty_bps_total,
          min_edge_liquidity: opp.min_edge_liquidity,
          est_capacity: opp.est_capacity,
          bottleneck: opp.bottleneck,
          detected_ms: opp.detected_ms,
          first_seen_ms: opp.first_seen_ms,
          last_verified_ms: opp.last_verified_ms,
          detections: opp.detections,
        },
      });

      // Emit failure to frontend
      emit('arb:execution:failed', {
        path: pathStr,
        error: errorMsg,
        timestamp: Date.now(),
      });

      // Pool failure tracking - identify and record which pool caused the failure
      try {
        // Get simulation result from error if available
        const simResult = (e as any)?.simResult || (e as any)?.sim || null;
        const programs = (e as any)?.programs || [];
        
        if (opp.hop_pool_ids && opp.hop_pool_ids.length > 0) {
          // Try to analyze the failure to identify the failing pool
          if (simResult && programs.length > 0) {
            const analysis = analyzeTransactionFailure(
              simResult,
              programs,
              opp.hop_pool_ids,
              opp.hop_dexes || []
            );
            
            if (analysis.failingPool) {
              recordPoolFailure(
                analysis.failingPool.poolId,
                analysis.failingPool.dex,
                analysis.errorMessage || errorMsg,
                traceId
              );
            }
          } else {
            // Fallback: if we can't identify the specific pool, record failure for all pools
            // with a lower weight (don't immediately quarantine)
            // Only do this for certain error types that suggest pool issues
            const isPoolRelatedError = /slippage|liquidity|insufficient|exceeded|custom/i.test(errorMsg);
            if (isPoolRelatedError && opp.hop_pool_ids.length === 1) {
              // Single-hop: we know which pool failed
              recordPoolFailure(
                opp.hop_pool_ids[0],
                opp.hop_dexes?.[0] || opp.dexes?.[0] || 'unknown',
                errorMsg,
                traceId
              );
            }
          }
        }
      } catch (trackErr) {
        // Non-blocking - don't let tracking errors affect execution flow
        try {
          logger.warn('arb.executor.failure_tracking_error', {
            cat: 'arb',
            traceId,
            error: String((trackErr as any)?.message || trackErr),
          });
        } catch {}
      }
    } finally {
      this.state.inFlight.delete(oppKey);
      
      // Always refresh balances after execution attempt (success or failure)
      // This ensures we have accurate balance data for the next opportunity
      // Non-blocking: don't await to avoid slowing down the executor
      void this.refreshBalances().catch((e) => {
        logger.warn('arb.executor.post_execution_balance_refresh_failed', {
          cat: 'arb',
          traceId,
          error: String((e as any)?.message || e),
        });
      });
    }
  }

  private async notifyExecuted(opp: Opportunity): Promise<void> {
    try {
      const arbHost = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const secret = process.env.ARB_SHARED_SECRET;
      
      await fetch(`${arbHost}/arb/opportunity/executed`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          path: opp.path,
          dexes: opp.dexes,
        }),
      });
    } catch (e) {
      // Best effort - don't throw
      logger.warn('arb.executor.notify_failed', { cat: 'arb' });
    }
  }

  /**
   * Calculate dynamic trade size based on opportunity characteristics.
   * 
   * Supports three methods:
   * - 'heuristic': Simple fraction of bottleneck liquidity (fast)
   * - 'optimal_analytical': Closed-form profit maximization (AMM-only, fast)
   * - 'optimal_iterative': Golden section search profit maximization (any pool type)
   */
  private async calculateDynamicSize(opp: Opportunity): Promise<number> {
    const dynamicCfg = this.config.dynamicSizing;
    
    // Common constants used in both paths
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const startToken = opp.path[0];
    const isFlashloanable = startToken === SOL_MINT || startToken === USDC_MINT;
    const flashloanEnabled = this.config.flashloanSettings?.enabled ?? false;
    
    // If dynamic sizing disabled, use fixed config BUT still cap to wallet balance
    if (!dynamicCfg?.enabled) {
      const fixedSize = this.config.sizeUsd || 10;
      
      // Still need to check wallet balance for non-flashloanable tokens or when flashloan disabled
      if (!isFlashloanable || !flashloanEnabled) {
        try {
          if (this.walletPublicKey) {
            const balances = await this.getCachedBalances();
            if (balances) {
              const balance = startToken === SOL_MINT 
                ? balances.sol 
                : (balances.tokens[startToken] || 0);
              const price = Number(getPriceByMint(startToken)?.usdc ?? 0);
              const walletBalanceUsd = balance * price;
              
              if (walletBalanceUsd <= 0) {
                logger.warn('arb.executor.sizing.no_balance_fixed', {
                  cat: 'arb',
                  path: opp.path.join('->'),
                  startToken: startToken.slice(0, 8) + '...',
                  balance,
                  price,
                  fixedSize,
                });
                return 0; // Cannot trade - no balance
              }
              
              const cappedSize = Math.min(fixedSize, walletBalanceUsd);
              if (cappedSize < fixedSize) {
                logger.debug('arb.executor.sizing.fixed_capped_to_wallet', {
                  cat: 'arb',
                  path: opp.path.join('->'),
                  fixedSize,
                  walletBalanceUsd,
                  cappedSize,
                });
              }
              return cappedSize;
            }
          }
          // If balance check fails, use minimum safe size
          return Math.min(fixedSize, 1);
        } catch (e) {
          logger.warn('arb.executor.sizing.balance_check_failed_fixed', {
            cat: 'arb',
            path: opp.path.join('->'),
            error: String((e as any)?.message || e),
          });
          return Math.min(fixedSize, 1);
        }
      }
      
      return fixedSize;
    }
    
    const minSize = dynamicCfg.minSizeUsd || 5;
    const maxSize = dynamicCfg.maxSizeUsd || this.config.sizeUsd || 200;
    const method = dynamicCfg.method || 'heuristic';
    
    // Get wallet balance for non-flashloanable tokens to cap sizing
    let walletBalanceUsd = Infinity; // Default to no cap
    let rawBalanceFallback: number | undefined; // For when price is unavailable
    if (!isFlashloanable || !flashloanEnabled) {
      try {
        if (this.walletPublicKey) {
          // PERF: Use cached balances to avoid RPC calls
          const balances = await this.getCachedBalances();
          if (!balances) {
            // Can't determine balance, use minimum size
            return minSize;
          }
          
          const balance = startToken === SOL_MINT 
            ? balances.sol 
            : (balances.tokens[startToken] || 0);
          
          // Check if we have any balance at all
          if (balance <= 0) {
            logger.warn('arb.executor.sizing.no_wallet_balance', {
              cat: 'arb',
              path: opp.path.join('->'),
              startToken: startToken.slice(0, 8) + '...',
              balance,
              reason: 'zero_balance',
            });
            // Truly no balance - can't trade
            return 0;
          }
          
          const price = Number(getPriceByMint(startToken)?.usdc ?? 0);
          
          if (price > 0) {
            walletBalanceUsd = balance * price;
            logger.debug('arb.executor.sizing.wallet_constraint', {
              cat: 'arb',
              path: opp.path.join('->'),
              startToken: startToken.slice(0, 8) + '...',
              walletBalanceUsd,
              isFlashloanable,
              flashloanEnabled,
            });
          } else {
            // Have balance but no price data - skip USD wallet cap, use raw balance fallback
            // Store raw balance so we can pass it to resolver as token amount
            rawBalanceFallback = balance;
            // Store on opportunity so execution can use raw size instead of USD
            (opp as any)._rawBalanceFallback = balance;
            (opp as any)._rawBalanceStartToken = startToken;
            logger.debug('arb.executor.sizing.no_price_using_raw_balance', {
              cat: 'arb',
              path: opp.path.join('->'),
              startToken: startToken.slice(0, 8) + '...',
              balance,
              reason: 'missing_price_data',
            });
            // Keep walletBalanceUsd = Infinity (no USD-based cap)
          }
        }
      } catch (e) {
        logger.warn('arb.executor.sizing.balance_check_failed', {
          cat: 'arb',
          error: String((e as any)?.message || e),
        });
        // Conservative: if we can't check balance, use minimum size
        walletBalanceUsd = minSize;
      }
    }
    
    // Get bottleneck liquidity (USD)
    const bottleneckUsd = opp.est_capacity ?? opp.min_edge_liquidity ?? 0;
    
    // Calculate uncapped optimal/heuristic size
    let sizeUsd = 0;
    
    // For optimal methods, try to use the analytical/iterative calculator
    if (method === 'optimal_analytical' || method === 'optimal_iterative') {
      try {
        // PERF: Use static import instead of dynamic import
        const result = await calculateOptimalSizeFromOpportunity(
          opp as any,
          minSize,
          maxSize,
          method,
          dynamicCfg.optimalSettings || {}
        );
        
        if (result.optimalSizeUsd > 0 && result.expectedProfitUsd > 0) {
          sizeUsd = result.optimalSizeUsd;
          
          // Log capacity constraint info if present (important for CLMM/DLMM sizing)
          if (result.capacityInfo?.wasConstrained) {
            logger.debug('arb.executor.sizing.capacity_constrained', {
              cat: 'arb',
              path: opp.path.join('->'),
              capacityConstraintUsd: result.capacityInfo.capacityConstraintUsd.toFixed(2),
              finalSizeUsd: result.optimalSizeUsd.toFixed(2),
              bottleneckHop: result.capacityInfo.bottleneckHop,
              limitingFactor: result.capacityInfo.limitingFactor,
              vaultImbalance: result.capacityInfo.vaultImbalance,
              warnings: result.capacityInfo.warnings,
            });
          }
          
          logger.debug('arb.executor.sizing.optimal', {
            cat: 'arb',
            path: opp.path.join('->'),
            method: result.method,
            optimalSizeUsd: result.optimalSizeUsd,
            expectedProfitUsd: result.expectedProfitUsd,
            grossProfit: result.breakdown.grossProfitUsd,
            slippageCost: result.breakdown.slippageCostUsd,
            capacityConstrained: result.capacityInfo?.wasConstrained ?? false,
          });
        } else {
          // Fall through to heuristic if optimal calculation fails
          // Check if this was due to capacity constraints
          if (result.capacityInfo?.wasConstrained) {
            logger.debug('arb.executor.sizing.capacity_rejection', {
              cat: 'arb',
              path: opp.path.join('->'),
              reason: 'capacity_below_minimum',
              capacityConstraintUsd: result.capacityInfo.capacityConstraintUsd.toFixed(2),
              limitingFactor: result.capacityInfo.limitingFactor,
              vaultImbalance: result.capacityInfo.vaultImbalance,
              warnings: result.capacityInfo.warnings,
            });
          } else {
            logger.debug('arb.executor.sizing.optimal_fallback', {
              cat: 'arb',
              path: opp.path.join('->'),
              reason: 'zero_size_or_profit',
            });
          }
        }
      } catch (e: any) {
        logger.warn('arb.executor.sizing.optimal_error', {
          cat: 'arb',
          path: opp.path.join('->'),
          error: String(e?.message || e),
        });
        // Fall through to heuristic
      }
    }
    
    // Heuristic method (default fallback if optimal didn't produce a result)
    if (sizeUsd === 0) {
      const baseFraction = dynamicCfg.bottleneckFraction || 0.10;
      
      if (bottleneckUsd <= 0) {
        // No liquidity info - use minimum safe size
        logger.debug('arb.executor.sizing.no_liquidity', {
          cat: 'arb',
          path: opp.path.join('->'),
          fallbackSize: minSize,
        });
        sizeUsd = minSize;
      } else {
        // Base size: fraction of bottleneck liquidity
        sizeUsd = bottleneckUsd * baseFraction;
        
        // Optional: Scale based on profit margin
        // Higher profit = can afford more slippage = larger size
        if (dynamicCfg.profitScaling) {
          const profitBps = opp.net_bps ?? opp.profit_bps;
          
          // Scaling factor: 0.5x at 10bps profit, 1.0x at 50bps, 1.5x at 100bps+
          // This is conservative - we size down when margins are thin
          const profitMultiplier = Math.min(1.5, Math.max(0.5, profitBps / 50));
          sizeUsd *= profitMultiplier;
        }
      }
    }
    
    // Clamp to configured bounds
    sizeUsd = Math.max(minSize, Math.min(maxSize, sizeUsd));
    
    // CRITICAL: For non-flashloanable tokens, cap to wallet balance
    // For flashloanable tokens with flashloan enabled, let it exceed (flashloan logic handles it)
    const originalSize = sizeUsd;
    if (!isFlashloanable || !flashloanEnabled) {
      sizeUsd = Math.min(sizeUsd, walletBalanceUsd);
    }
    
    logger.debug('arb.executor.sizing.final', {
      cat: 'arb',
      path: opp.path.join('->'),
      method: method,
      uncappedSize: originalSize,
      walletBalanceUsd: walletBalanceUsd === Infinity ? 'unlimited' : walletBalanceUsd,
      finalSize: sizeUsd,
      cappedByWallet: sizeUsd < originalSize,
      isFlashloanable,
      flashloanEnabled,
      bottleneckUsd,
      profitBps: opp.net_bps ?? opp.profit_bps,
      rawBalanceFallback: rawBalanceFallback ?? null,
    });
    
    return sizeUsd;
  }

  /**
   * Check if flashloan should be used for this opportunity.
   * Returns the flashloan amount needed, or 0 if flashloan not needed/available.
   */
  private async checkFlashloanNeeded(
    opp: Opportunity,
    sizeUsd: number,
    startToken: string
  ): Promise<{ needed: boolean; flashloanAmountUsd: number; walletBalanceUsd: number; reason?: string }> {
    const flashCfg = this.config.flashloanSettings;
    
    // If flashloans disabled, not needed
    if (!flashCfg?.enabled) {
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd: 0, reason: 'disabled' };
    }
    
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    // Check if start token is flashloanable (SOL or USDC)
    const isFlashloanable = startToken === SOL_MINT || startToken === USDC_MINT;
    if (!isFlashloanable) {
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd: 0, reason: 'token_not_flashloanable' };
    }
    
    // Get wallet balance for this token
    let walletBalanceUsd = 0;
    try {
      if (this.walletPublicKey) {
        // PERF: Use cached balances to avoid RPC calls
        const balances = await this.getCachedBalances();
        if (balances) {
          const balance = startToken === SOL_MINT 
            ? balances.sol 
            : (balances.tokens[startToken] || 0);
          
          // Convert to USD
          const price = Number(getPriceByMint(startToken)?.usdc ?? 0);
          walletBalanceUsd = balance * price;
        }
      }
    } catch (e) {
      logger.warn('arb.executor.flashloan.balance_check_failed', {
        cat: 'arb',
        error: String((e as any)?.message || e),
      });
    }
    
    // If wallet has enough balance, no flashloan needed
    if (walletBalanceUsd >= sizeUsd) {
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'sufficient_balance' };
    }
    
    // Calculate flashloan amount needed
    const flashloanAmountUsd = sizeUsd - walletBalanceUsd;
    
    // Check minimum profit threshold (must cover flashloan fee + min profit)
    const estProfitUsd = opp.est_profit_usd ?? (sizeUsd * (opp.profit_bps ?? 0) / 10000);
    const flashloanFeeUsd = flashloanAmountUsd * 0.0009; // 9 bps fee
    const netProfitAfterFee = estProfitUsd - (flashCfg.accountForFee ? flashloanFeeUsd : 0);
    
    if (netProfitAfterFee < (flashCfg.minProfitForFlashloan || 0.50)) {
      if (flashCfg.fallbackToWallet && walletBalanceUsd > 0) {
        return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'profit_too_low_fallback_wallet' };
      }
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'profit_too_low' };
    }
    
    // Check max flashloan cap
    if (flashloanAmountUsd > (flashCfg.maxFlashloanUsd || 10000)) {
      if (flashCfg.fallbackToWallet && walletBalanceUsd > 0) {
        return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'exceeds_max_fallback_wallet' };
      }
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'exceeds_max' };
    }
    
    // Check if vault has funds available
    const vaultAvailable = await this.checkVaultBalance(startToken, flashloanAmountUsd);
    if (!vaultAvailable) {
      if (flashCfg.fallbackToWallet && walletBalanceUsd > 0) {
        return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'vault_insufficient_fallback_wallet' };
      }
      return { needed: false, flashloanAmountUsd: 0, walletBalanceUsd, reason: 'vault_insufficient' };
    }
    
    return { needed: true, flashloanAmountUsd, walletBalanceUsd };
  }

  /**
   * Check if vault has sufficient balance for flashloan
   */
  private async checkVaultBalance(mint: string, requiredUsd: number): Promise<boolean> {
    try {
      // PERF: Use static imports instead of dynamic imports
      const routerConfig = await loadRouterConfig();
      if (!routerConfig.enabled || !routerConfig.vaultOwner) {
        return false;
      }
      
      const connection = getConnection();
      const vaultOwner = new PublicKey(routerConfig.vaultOwner);
      const mintPubkey = new PublicKey(mint);
      
      const [vaultAddress] = deriveVaultPda(vaultOwner, mintPubkey);
      const vault = await fetchVault(connection, vaultAddress);
      
      if (!vault) {
        return false;
      }
      
      // Get price for conversion
      const price = Number(getPriceByMint(mint)?.usdc ?? 0);
      if (price <= 0) {
        return false;
      }
      
      // Calculate available balance in USD
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const decimals = mint === SOL_MINT ? 9 : 6;
      const availableBalance = Number(vault.balance - vault.borrowedAmount) / Math.pow(10, decimals);
      const availableUsd = availableBalance * price;
      
      logger.debug('arb.executor.flashloan.vault_check', {
        cat: 'arb',
        mint: mint.slice(0, 8) + '...',
        availableBalance,
        availableUsd,
        requiredUsd,
        sufficient: availableUsd >= requiredUsd,
      });
      
      return availableUsd >= requiredUsd;
    } catch (e) {
      logger.warn('arb.executor.flashloan.vault_check_failed', {
        cat: 'arb',
        error: String((e as any)?.message || e),
      });
      return false;
    }
  }

  private getOpportunityKey(opp: Opportunity): string {
    const sortedDexes = [...opp.dexes].sort();
    return `${opp.path.join('->')}|${sortedDexes.join(',')}`;
  }

  /**
   * PERF: Get cached balances to avoid RPC calls on every opportunity check.
   * Fetches fresh balances if cache is stale (older than BALANCE_CACHE_TTL_MS).
   * @param forceRefresh - If true, bypass cache and fetch fresh balances
   */
  private async getCachedBalances(forceRefresh = false): Promise<{ sol: number; tokens: Record<string, number> } | null> {
    const now = Date.now();
    const cacheAge = now - this.balanceCache.fetchedAt;
    
    // Return cached balances if still fresh and not forcing refresh
    if (!forceRefresh && this.balanceCache.balances && cacheAge < BALANCE_CACHE_TTL_MS) {
      return this.balanceCache.balances;
    }
    
    // Fetch fresh balances
    if (!this.walletPublicKey) return null;
    
    try {
      const balances = await getBalances(this.walletPublicKey);
      this.balanceCache = { balances, fetchedAt: now };
      
      logger.debug('arb.executor.balance_cache.refreshed', {
        cat: 'arb',
        cacheAge,
        forceRefresh,
        sol: balances.sol,
        tokenCount: Object.keys(balances.tokens).length,
      });
      
      return balances;
    } catch (e) {
      logger.warn('arb.executor.balance_cache.fetch_failed', {
        cat: 'arb',
        error: String((e as any)?.message || e),
        cacheAge,
        hasStaleCache: !!this.balanceCache.balances,
      });
      // Return stale cache if available, otherwise null
      return this.balanceCache.balances;
    }
  }

  /**
   * Force refresh wallet balances. Call this:
   * - On executor startup
   * - After every execution attempt (success or failure)
   * This ensures we always have accurate balance data.
   */
  private async refreshBalances(): Promise<void> {
    if (!this.walletPublicKey) {
      logger.warn('arb.executor.balance_refresh.no_wallet', { cat: 'arb' });
      return;
    }
    
    try {
      const balances = await getBalances(this.walletPublicKey);
      this.balanceCache = { balances, fetchedAt: Date.now() };
      
      // Log key balances for visibility
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const tokenCount = Object.keys(balances.tokens).length;
      
      logger.info('arb.executor.balance_refresh.success', {
        cat: 'arb',
        sol: balances.sol,
        usdc: balances.tokens[USDC_MINT] ?? 0,
        tokenCount,
      });
    } catch (e) {
      logger.error('arb.executor.balance_refresh.failed', {
        cat: 'arb',
        error: String((e as any)?.message || e),
      });
    }
  }

  /**
   * Invalidate the balance cache to force a refresh on next access.
   */
  private invalidateBalanceCache(): void {
    this.balanceCache.fetchedAt = 0;
  }

  private cleanupState(): void {
    const now = Date.now();
    const maxAge = this.config.cooldownMs * 5; // Keep 5x cooldown period

    // Clean up old executions
    for (const [key, timestamp] of this.state.recentExecutions.entries()) {
      if (now - timestamp > maxAge) {
        this.state.recentExecutions.delete(key);
      }
    }
  }

  // Public API for runtime configuration
  updateConfig(updates: Partial<ExecutorConfig>): void {
    // Deep merge nested objects to avoid losing fields when only updating a subset
    // For top-level primitives, use the update value if provided, else keep existing
    this.config = {
      ...this.config,
      ...updates,
      // Deep merge dynamicSizing - preserve existing fields when updating subset
      dynamicSizing: updates.dynamicSizing !== undefined
        ? { ...this.config.dynamicSizing, ...updates.dynamicSizing }
        : this.config.dynamicSizing,
      // Deep merge flashloanSettings
      flashloanSettings: updates.flashloanSettings !== undefined
        ? { ...this.config.flashloanSettings, ...updates.flashloanSettings }
        : this.config.flashloanSettings,
      // Deep merge quarantineSettings
      quarantineSettings: updates.quarantineSettings !== undefined
        ? { ...this.config.quarantineSettings, ...updates.quarantineSettings }
        : this.config.quarantineSettings,
      // Deep merge adaptiveSizing
      adaptiveSizing: updates.adaptiveSizing !== undefined
        ? { ...this.config.adaptiveSizing, ...updates.adaptiveSizing }
        : this.config.adaptiveSizing,
    };
    logger.info('arb.executor.config_updated', { cat: 'arb', config: this.config });
    
    // Update pool failure tracker configuration if quarantine settings changed
    try {
      if (updates.quarantineSettings) {
        // Pass the merged config, not just the update
        setQuarantineConfig(this.config.quarantineSettings);
      }
      if (updates.manualPoolBlocklist !== undefined) {
        setManualBlocklist(updates.manualPoolBlocklist);
      }
    } catch (e) {
      logger.warn('arb.executor.tracker_update_failed', { 
        cat: 'arb', 
        error: String((e as any)?.message || e) 
      });
    }
  }

  getStatus() {
    return {
      running: this.running,
      config: this.config,
      state: {
        inFlight: this.state.inFlight.size,
        inFlightKeys: Array.from(this.state.inFlight),
        recentExecutions: this.state.recentExecutions.size,
        executionsThisMinute: this.state.executionsThisMinute,
        lastExecutionTime: this.state.lastExecutionTime,
        totalExecutions: this.state.totalExecutions,
        successfulExecutions: this.state.successfulExecutions,
        failedExecutions: this.state.failedExecutions,
        successRate: this.state.totalExecutions > 0 
          ? (this.state.successfulExecutions / this.state.totalExecutions * 100).toFixed(1) + '%'
          : '0%',
      },
    };
  }
}

// Singleton instance
let executorInstance: ArbExecutor | null = null;

export function getArbExecutor(config?: ExecutorConfig): ArbExecutor {
  if (!executorInstance && config) {
    executorInstance = new ArbExecutor(config);
  } else if (executorInstance && config) {
    // Update existing instance's config - ensures runtime config stays in sync
    executorInstance.updateConfig(config);
  }
  if (!executorInstance) {
    throw new Error('ArbExecutor not initialized - provide config first');
  }
  return executorInstance;
}

export function stopArbExecutor(): void {
  if (executorInstance) {
    executorInstance.stop();
    executorInstance = null;
  }
}

