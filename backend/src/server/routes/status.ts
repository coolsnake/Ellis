// Status aggregation routes for mobile app consumption

import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';

// Response types
export interface ArbStatusResponse {
  running: boolean;
  health: 'healthy' | 'degraded' | 'offline';
  executor: {
    inFlight: number;
    executionsThisMinute: number;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: string;
    lastExecutionTime: number | null;
  };
  graph: {
    synced: boolean;
    versionLag: number;
    lastPushMs: number;
  };
  pools: {
    quarantined: number;
    total: number;
  };
  timings: {
    buildP50Ms: number;
    sendP50Ms: number;
  };
}

export interface DriftStatusResponse {
  active: boolean;
  health: 'healthy' | 'degraded' | 'offline';
  infrastructure: {
    bots: number;
    userCount: number | null;
    indexStats: { users: number; markets: number; marketToOrders: number } | null;
  };
  fillers: {
    count: number;
    running: number;
    fillsLast5Min: number;
  };
  liquidators: {
    count: number;
    running: number;
  };
  triggers: {
    count: number;
    running: number;
  };
  metrics: {
    attempts: number;
    successes: number;
    failureRate: number;
    costSolLast1Hr: number;
    revenueUsdcLast1Hr: number;
  };
  recentTxs: Array<{
    sig: string;
    action: string;
    success: boolean;
    ts: number;
    marketIndex?: number;
    rewardUsd?: number;
  }>;
}

export function createStatusRouter(_io: SocketIOServer): Router {
  const api = Router();

  // GET /api/status/arb - Aggregated arb module status
  api.get('/status/arb', async (_req: Request, res: Response) => {
    try {
      // Get executor status
      let executorStatus: any = { running: false };
      try {
        const { getArbExecutor } = await import('../../execution/arbExecutor.js');
        const executor = getArbExecutor();
        executorStatus = executor.getStatus();
      } catch {
        executorStatus = { running: false, error: 'not initialized' };
      }

      // Get graph sync status
      let graphStatus: any = { synced: false, versionLag: 0, lastPushMs: 0 };
      try {
        const { getGraphVersion } = await import('../graph.js');
        const { isArbStreamEnabled, getCachedArbVersion, getGraphPushStats } = await import('../realtime.js');
        
        const backendVersion = getGraphVersion();
        const arbVersion = getCachedArbVersion();
        const pushStats = getGraphPushStats();
        
        graphStatus = {
          synced: isArbStreamEnabled() && (backendVersion.version - arbVersion.version) <= 2,
          versionLag: backendVersion.version - arbVersion.version,
          lastPushMs: pushStats.p50 || 0,
        };
      } catch {}

      // Get quarantine status
      let quarantineStatus: any = { quarantined: 0, total: 0 };
      try {
        const { getQuarantineStats } = await import('../../execution/poolFailureTracker.js');
        const stats = getQuarantineStats();
        quarantineStatus = {
          quarantined: stats.quarantinedCount || 0,
          total: stats.totalTracked || 0,
        };
      } catch {}

      // Calculate health status
      const running = executorStatus?.running || false;
      const state = executorStatus?.state || {};
      const successRate = state.totalExecutions > 0 
        ? ((state.successfulExecutions || 0) / state.totalExecutions * 100)
        : 0;
      
      let health: 'healthy' | 'degraded' | 'offline' = 'offline';
      if (running) {
        if (graphStatus.synced && successRate >= 50) {
          health = 'healthy';
        } else {
          health = 'degraded';
        }
      }

      const response: ArbStatusResponse = {
        running,
        health,
        executor: {
          inFlight: state.inFlight || 0,
          executionsThisMinute: state.executionsThisMinute || 0,
          totalExecutions: state.totalExecutions || 0,
          successfulExecutions: state.successfulExecutions || 0,
          failedExecutions: state.failedExecutions || 0,
          successRate: state.successRate || '0%',
          lastExecutionTime: state.lastExecutionTime || null,
        },
        graph: graphStatus,
        pools: quarantineStatus,
        timings: {
          buildP50Ms: 0, // Could add from exec stats if needed
          sendP50Ms: 0,
        },
      };

      res.json(response);
    } catch (e: any) {
      logger.error('status.arb.failed', { cat: 'api', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // GET /api/status/drift - Aggregated drift module status
  api.get('/status/drift', async (_req: Request, res: Response) => {
    try {
      // Get infrastructure status
      let infraStatus: any = { active: false, bots: 0, userCount: null, indexStats: null };
      try {
        const { DriftService } = await import('../../drift/client.js');
        const svc = DriftService.getInstance() as any;
        const s = svc.getInfraStatus?.() || { active: false, forceActive: false, bots: 0, has: {} };
        let userCount: any = null;
        try { if (typeof svc.getUserCountCached === 'function') userCount = await svc.getUserCountCached({ wait: false }); } catch {}
        
        let indexStats: any = null;
        try {
          const { driftEventIndex } = await import('../../drift/eventIndex.js');
          indexStats = driftEventIndex.getStats();
        } catch {}
        
        infraStatus = {
          active: s.active || s.forceActive,
          bots: s.bots || 0,
          userCount,
          indexStats,
        };
      } catch {}

      // Get filler status
      let fillerStatus = { count: 0, running: 0, fillsLast5Min: 0 };
      try {
        const { readJson } = await import('../../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'fillers.json');
        const store = await readJson<any>(storePath, { fillers: [] });
        const fillers = store.fillers || [];
        fillerStatus = {
          count: fillers.length,
          running: fillers.filter((f: any) => f.running).length,
          fillsLast5Min: 0, // Could aggregate from metrics
        };
      } catch {}

      // Get liquidator status
      let liquidatorStatus = { count: 0, running: 0 };
      try {
        const { readJson } = await import('../../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'liquidators.json');
        const store = await readJson<any>(storePath, { liquidators: [] });
        const liquidators = store.liquidators || [];
        liquidatorStatus = {
          count: liquidators.length,
          running: liquidators.filter((l: any) => l.running).length,
        };
      } catch {}

      // Get trigger status
      let triggerStatus = { count: 0, running: 0 };
      try {
        const { readJson } = await import('../../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'triggers.json');
        const store = await readJson<any>(storePath, { triggers: [] });
        const triggers = store.triggers || [];
        triggerStatus = {
          count: triggers.length,
          running: triggers.filter((t: any) => t.running).length,
        };
      } catch {}

      // Get tx metrics from txTracker
      let metrics = { attempts: 0, successes: 0, failureRate: 0, costSolLast1Hr: 0, revenueUsdcLast1Hr: 0 };
      let recentTxs: any[] = [];
      try {
        const { getMetrics, readAttemptHistory } = await import('../../drift/txTracker.js');
        const m = getMetrics({ windowMs: 3600_000 }); // 1 hour
        metrics = {
          attempts: m.attempts,
          successes: m.successes,
          failureRate: m.failureRate,
          costSolLast1Hr: m.costSol,
          revenueUsdcLast1Hr: (m.revenueQuote || 0) / 1_000_000, // Convert from USDC precision
        };
        
        // Get recent transactions
        const history = await readAttemptHistory({ limit: 20 });
        recentTxs = history.slice(-20).reverse().map((tx: any) => ({
          sig: tx.sig,
          action: tx.action,
          success: tx.success,
          ts: tx.ts,
          marketIndex: tx.marketIndex,
          rewardUsd: tx.fillerRewardQuote ? (tx.fillerRewardQuote / 1_000_000) : undefined,
        }));
      } catch {}

      // Calculate health
      const active = infraStatus.active;
      const totalBots = fillerStatus.running + liquidatorStatus.running + triggerStatus.running;
      
      let health: 'healthy' | 'degraded' | 'offline' = 'offline';
      if (active) {
        if (totalBots > 0 && metrics.failureRate < 0.5) {
          health = 'healthy';
        } else {
          health = 'degraded';
        }
      }

      const response: DriftStatusResponse = {
        active,
        health,
        infrastructure: {
          bots: infraStatus.bots,
          userCount: infraStatus.userCount,
          indexStats: infraStatus.indexStats,
        },
        fillers: fillerStatus,
        liquidators: liquidatorStatus,
        triggers: triggerStatus,
        metrics,
        recentTxs,
      };

      res.json(response);
    } catch (e: any) {
      logger.error('status.drift.failed', { cat: 'api', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}
