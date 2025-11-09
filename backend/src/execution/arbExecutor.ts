import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';
import WebSocket from 'ws';
import { resolveDirectPlan } from './resolver/index.js';
import { assembleAndSend, assembleAndSimulate } from './sender.js';
import { loadExecConfig } from '../server/execConfigStore.js';
import { addTxRecord } from '../server/txHistory.js';
import type { ArbBuildResult } from '../workers/arbBuild.types.js';

interface Opportunity {
  path: string[];
  dexes: string[];
  profit_bps: number;
  net_bps?: number;
  hop_count?: number;
  hop_pool_ids?: string[];
  reserves_min?: number;
  estimated_input_amount?: number;
  estimated_output_amount?: number;
  first_seen_ms?: number;
  detected_ms?: number;
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
  private running = false;

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

    // Connect to arb-rs opportunity stream
    this.connectToOpportunityStream();

    // Start cleanup timer for expired cooldowns
    this.cleanupTimer = setInterval(() => this.cleanupState(), 60000);
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
    if (!this.config.enabled) return;

    // Reset per-minute counter if needed
    const now = Date.now();
    if (now - this.state.lastMinuteReset > 60000) {
      this.state.executionsThisMinute = 0;
      this.state.lastMinuteReset = now;
    }

    // Check rate limit
    if (this.config.maxExecutionsPerMinute && 
        this.state.executionsThisMinute >= this.config.maxExecutionsPerMinute) {
      return;
    }

    // Check concurrent execution limit
    if (this.state.inFlight.size >= this.config.maxConcurrentExecutions) {
      return;
    }

    // Process opportunities in order until we hit limits
    for (const opp of opportunities) {
      if (this.state.inFlight.size >= this.config.maxConcurrentExecutions) {
        break;
      }

      if (this.shouldExecute(opp)) {
        // Don't await - execute in background
        this.executeOpportunity(opp).catch((e) => {
          logger.error('arb.executor.execution_failed', {
            cat: 'arb',
            path: opp.path.join('->'),
            error: String((e as any)?.message || e),
          });
        });
      }
    }
  }

  private shouldExecute(opp: Opportunity): boolean {
    // Create opportunity key
    const oppKey = this.getOpportunityKey(opp);

    // Check if already in flight
    if (this.state.inFlight.has(oppKey)) {
      return false;
    }

    // Check profit threshold
    const profitBps = opp.net_bps ?? opp.profit_bps;
    if (profitBps < this.config.minProfitBps) {
      return false;
    }

    // Check hop count
    if (this.config.maxHops && opp.hop_count && opp.hop_count > this.config.maxHops) {
      return false;
    }

    // Check reserves
    if (this.config.minReservesUsd && opp.reserves_min && 
        opp.reserves_min < this.config.minReservesUsd) {
      return false;
    }

    // Check cooldown
    const lastExecution = this.state.recentExecutions.get(oppKey);
    if (lastExecution) {
      const elapsed = Date.now() - lastExecution;
      if (elapsed < this.config.cooldownMs) {
        return false;
      }
    }

    // Check blacklist
    const pathStr = opp.path.join('->');
    if (this.config.blacklistedPaths?.some(bp => pathStr.includes(bp))) {
      logger.debug('arb.executor.blacklisted', { cat: 'arb', path: pathStr });
      return false;
    }

    // Check global cooldown
    const timeSinceLastExec = Date.now() - this.state.lastExecutionTime;
    if (timeSinceLastExec < 100) { // Minimum 100ms between any executions
      return false;
    }

    return true;
  }

  private async executeOpportunity(opp: Opportunity): Promise<void> {
    const oppKey = this.getOpportunityKey(opp);
    const pathStr = opp.path.join('->');
    
    this.state.inFlight.add(oppKey);
    this.state.lastExecutionTime = Date.now();
    this.state.executionsThisMinute++;
    this.state.totalExecutions++;

    const startTime = Date.now();
    let signature: string | null = null;

    try {
      logger.info('arb.executor.attempt', {
        cat: 'arb',
        path: pathStr,
        dexes: opp.dexes.join(','),
        profitBps: opp.profit_bps,
        netBps: opp.net_bps,
      });

      // Debug: Log what we're receiving from arb-rs
      logger.debug('arb.executor.opportunity_data', {
        cat: 'arb',
        path: opp.path,
        pathLength: opp.path.length,
        dexes: opp.dexes,
        dexesLength: opp.dexes?.length,
        hopPoolIds: opp.hop_pool_ids,
        hopPoolIdsLength: opp.hop_pool_ids?.length,
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
          originalPath: opp.path,
          closedPath: executionPath,
          nodes: opp.path.length,
          edges: opp.hop_pool_ids.length,
        });
      }

      // Resolve execution plan
      const plan = await resolveDirectPlan(
        {
          path: executionPath,
          hopPoolIds: opp.hop_pool_ids || [],
          dexes: opp.dexes || [],
          sizeUsd: this.config.sizeUsd,
          slippageBps: this.config.slippageBps,
        } as any,
        {} as any
      );

      // Build transaction using the same method as arb routes
      const { buildTransactionSummary } = await import('../server/arb.build.worker.compute.js');
      const built: ArbBuildResult = await buildTransactionSummary(plan, undefined, undefined);

      // Load execution config
      const execCfg = await loadExecConfig();

      // Execute based on mode
      const mode = execCfg.mode || 'simulate';
      
      // Use ALT addresses from built transaction, fallback to exec config
      const altAddresses = built.lookupTableAddresses || execCfg.lookupTableAddresses || [];
      
      if (mode === 'simulate') {
        // Simulate only
        const simResult = await assembleAndSimulate(built.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
        });
        logger.info('arb.executor.simulated', {
          cat: 'arb',
          path: pathStr,
          result: simResult,
        });
        this.state.successfulExecutions++;
      } else {
        // Execute on-chain
        const sendResult = await assembleAndSend(built.instructions, {
          computeUnitLimit: execCfg.computeUnitLimit,
          computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
          lookupTableAddresses: altAddresses,
        });
        signature = sendResult?.signature || null;

        if (signature) {
          logger.info('arb.executor.success', {
            cat: 'arb',
            path: pathStr,
            signature,
            durationMs: Date.now() - startTime,
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
      
      logger.error('arb.executor.failed', {
        cat: 'arb',
        path: pathStr,
        error: String(e?.message || e),
        durationMs: Date.now() - startTime,
      });

      // Emit failure to frontend
      emit('arb:execution:failed', {
        path: pathStr,
        error: String(e?.message || e),
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

