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
import { ensureWallet } from '../wallet/wallet.js';

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
  // Dynamic sizing - calculates trade size based on bottleneck liquidity
  dynamicSizing?: {
    enabled: boolean;
    minSizeUsd: number;      // Floor for trade size
    maxSizeUsd: number;      // Ceiling for trade size
    bottleneckFraction: number; // Fraction of bottleneck liquidity (e.g., 0.10 = 10%)
    profitScaling: boolean;  // Scale size up with higher profit margins
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

export class ArbExecutor {
  private config: ExecutorConfig;
  private state: ExecutionState;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null; // For periodic status logging
  private running = false;
  private walletPublicKey: any = null; // Cached wallet for balance checks

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

    // Cache wallet public key for balance checks
    try {
      const { ensureWallet } = await import('../wallet/wallet.js');
      const { CONFIG } = await import('../utils/config.js');
      const wallet = await ensureWallet(CONFIG.walletPath);
      this.walletPublicKey = wallet.publicKey;
      logger.debug('arb.executor.wallet_cached', { cat: 'arb', publicKey: wallet.publicKey.toBase58() });
    } catch (e) {
      logger.warn('arb.executor.wallet_cache_failed', { cat: 'arb', error: String(e?.message || e) });
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
    // Log incoming batch
    logger.info('arb.executor.batch_received', {
      cat: 'arb',
      count: opportunities.length,
      enabled: this.config.enabled,
    });

    if (!this.config.enabled) {
      logger.info('arb.executor.batch_skipped', {
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
      logger.info('arb.executor.batch_rate_limited', {
        cat: 'arb',
        count: opportunities.length,
        executionsThisMinute: this.state.executionsThisMinute,
        maxPerMinute: this.config.maxExecutionsPerMinute,
      });
      return;
    }

    // Check concurrent execution limit
    if (this.state.inFlight.size >= this.config.maxConcurrentExecutions) {
      logger.info('arb.executor.batch_concurrency_limit', {
        cat: 'arb',
        count: opportunities.length,
        inFlight: this.state.inFlight.size,
        maxConcurrent: this.config.maxConcurrentExecutions,
      });
      return;
    }

    // Process opportunities in order until we hit limits
    let accepted = 0;
    let filtered = 0;
    for (const opp of opportunities) {
      if (this.state.inFlight.size >= this.config.maxConcurrentExecutions) {
        logger.info('arb.executor.batch_stopped_concurrency', {
          cat: 'arb',
          processed: accepted + filtered,
          remaining: opportunities.length - (accepted + filtered),
        });
        break;
      }

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
    
    // Summary log
    logger.info('arb.executor.batch_processed', {
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

    // Log incoming opportunity for detailed tracing
    logger.info('arb.executor.opportunity_check', {
      cat: 'arb',
      path: pathStr,
      profitBps,
      netBps: opp.net_bps,
      hopCount: opp.hop_count,
      reservesMin: opp.reserves_min,
    });

    // Check if already in flight
    if (this.state.inFlight.has(oppKey)) {
      logger.info('arb.executor.filtered', {
        cat: 'arb',
        reason: 'already_in_flight',
        path: pathStr,
        profitBps,
      });
      return false;
    }

    // Check profit threshold
    if (profitBps < this.config.minProfitBps) {
      logger.info('arb.executor.filtered', {
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
      logger.info('arb.executor.filtered', {
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
      logger.info('arb.executor.filtered', {
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
        logger.info('arb.executor.filtered', {
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
      logger.info('arb.executor.filtered', {
        cat: 'arb',
        reason: 'blacklisted',
        path: pathStr,
      });
      return false;
    }

    // Check global cooldown
    const timeSinceLastExec = Date.now() - this.state.lastExecutionTime;
    if (timeSinceLastExec < 100) { // Minimum 100ms between any executions
      logger.info('arb.executor.filtered', {
        cat: 'arb',
        reason: 'global_cooldown',
        path: pathStr,
        elapsedMs: timeSinceLastExec,
      });
      return false;
    }

    // Balance validation
    if (this.config.requireStartBalance !== false && this.walletPublicKey) {
      try {
        const { getBalances } = await import('../wallet/wallet.js');
        const balances = await getBalances(this.walletPublicKey);
        const startToken = opp.path[0];
        
        if (startToken) {
          const SOL_MINT = 'So11111111111111111111111111111111111111112';
          const balance = startToken === SOL_MINT 
            ? balances.sol 
            : (balances.tokens[startToken] || 0);
          const hasBalance = balance > 0;
          
          if (!hasBalance) {
            logger.info('arb.executor.filtered', {
              cat: 'arb',
              reason: 'no_balance',
              path: pathStr,
              startToken: startToken.slice(0, 8) + '...',
              balance: 0,
            });
            return false;
          }
          
          // Log balance check passed
          logger.info('arb.executor.balance_check_passed', {
            cat: 'arb',
            path: pathStr,
            startToken: startToken.slice(0, 8) + '...',
            balance,
          });
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
      
      try {
        // Calculate dynamic size based on opportunity characteristics
        const sizeUsd = this.calculateDynamicSize(opp);
        
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
        });
        
        // Resolve execution plan - pass traceId for complete log correlation
        plan = await resolveDirectPlan(
          {
            path: executionPath,
            hopPoolIds: opp.hop_pool_ids || [],
            dexes: executionDexes,
            sizeUsd,
            slippageBps: this.config.slippageBps,
            traceId,
          } as any,
          {} as any
        );

        // Build transaction using the same method as arb routes - pass traceId
        const { buildTransactionSummary } = await import('../server/arb.build.worker.compute.js');
        built = await buildTransactionSummary(plan, undefined, undefined, traceId);

        // Load execution config
        execCfg = await loadExecConfig();
      } catch (buildError: any) {
        // Log build/resolution failure to execute-attempts
        try {
          const { writeTxFullDump } = await import('../utils/txTrace.js');
          const { getTxRelatedLogs } = await import('../utils/sessionLogs.js');
          const dexes = Array.from(new Set((executionDexes || []).filter(Boolean)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 30000, Date.now(), 500);
          
          await writeTxFullDump('preflight', {
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
      
      if (mode === 'simulate') {
        // Simulate only - pass traceId for log correlation
        const simResult = await assembleAndSimulate(built.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
          traceId,
        });
        
        // Log full dump with opportunity data
        try {
          const { writeTxFullDump } = await import('../utils/txTrace.js');
          const { getTxRelatedLogs } = await import('../utils/sessionLogs.js');
          const dexes = Array.from(new Set(plan.hops.map((h: any) => h.dex)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 30000, Date.now(), 500);
          
          // Write single consolidated file instead of one per DEX
          await writeTxFullDump('preflight', {
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
        
        logger.info('arb.executor.simulated', {
          cat: 'arb',
          traceId,
          path: pathStr,
          result: simResult,
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

        // Prepend tip instruction if calculated
        const instructionsWithTip = tipResult?.tipIx 
          ? [tipResult.tipIx, ...built.instructions] 
          : built.instructions;

        // Always use Jito parallel sending when Jito is enabled (not just when we have a tip)
        // Use the same config source as tip calculation for consistency
        const { loadJitoConfig } = await import('../server/jitoConfigStore.js');
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
        try {
          const { writeTxFullDump } = await import('../utils/txTrace.js');
          const { getTxRelatedLogs } = await import('../utils/sessionLogs.js');
          const dexes = Array.from(new Set(plan.hops.map((h: any) => h.dex)));
          const txLogs = getTxRelatedLogs(traceId, Date.now() - 60000, Date.now(), 500);
          
          // Write single consolidated file instead of one per DEX
          await writeTxFullDump('execute', {
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
      try {
        const { writeTxFullDump } = await import('../utils/txTrace.js');
        const { getTxRelatedLogs } = await import('../utils/sessionLogs.js');
        const txLogs = getTxRelatedLogs(traceId, Date.now() - 60000, Date.now(), 500);
        
        // Try to get plan and built if they exist (might be undefined if error occurred early)
        const plan = (e as any)?.plan || null;
        const built = (e as any)?.built || null;
        const execCfg = (e as any)?.execCfg || null;
        const executionDexes = opp.hop_dexes || opp.dexes || [];
        
        await writeTxFullDump('execute', {
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
    } finally {
      this.state.inFlight.delete(oppKey);
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
   * Uses bottleneck liquidity and profit margin to determine optimal size.
   */
  private calculateDynamicSize(opp: Opportunity): number {
    const dynamicCfg = this.config.dynamicSizing;
    
    // If dynamic sizing disabled, use fixed config
    if (!dynamicCfg?.enabled) {
      return this.config.sizeUsd || 10;
    }
    
    const minSize = dynamicCfg.minSizeUsd || 5;
    const maxSize = dynamicCfg.maxSizeUsd || this.config.sizeUsd || 200;
    const baseFraction = dynamicCfg.bottleneckFraction || 0.10;
    
    // Get bottleneck liquidity (USD)
    const bottleneckUsd = opp.est_capacity ?? opp.min_edge_liquidity ?? 0;
    
    if (bottleneckUsd <= 0) {
      // No liquidity info - use minimum safe size
      logger.debug('arb.executor.sizing.no_liquidity', {
        cat: 'arb',
        path: opp.path.join('->'),
        fallbackSize: minSize,
      });
      return minSize;
    }
    
    // Base size: fraction of bottleneck liquidity
    let sizeUsd = bottleneckUsd * baseFraction;
    
    // Optional: Scale based on profit margin
    // Higher profit = can afford more slippage = larger size
    if (dynamicCfg.profitScaling) {
      const profitBps = opp.net_bps ?? opp.profit_bps;
      
      // Scaling factor: 0.5x at 10bps profit, 1.0x at 50bps, 1.5x at 100bps+
      // This is conservative - we size down when margins are thin
      const profitMultiplier = Math.min(1.5, Math.max(0.5, profitBps / 50));
      sizeUsd *= profitMultiplier;
    }
    
    // Clamp to configured bounds
    sizeUsd = Math.max(minSize, Math.min(maxSize, sizeUsd));
    
    logger.debug('arb.executor.sizing.calculated', {
      cat: 'arb',
      path: opp.path.join('->'),
      bottleneckUsd,
      baseFraction,
      profitBps: opp.net_bps ?? opp.profit_bps,
      calculatedSize: sizeUsd,
      dynamicSizingEnabled: true,
    });
    
    return sizeUsd;
  }

  private getOpportunityKey(opp: Opportunity): string {
    const sortedDexes = [...opp.dexes].sort();
    return `${opp.path.join('->')}|${sortedDexes.join(',')}`;
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
    this.config = { ...this.config, ...updates };
    logger.info('arb.executor.config_updated', { cat: 'arb', config: this.config });
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

