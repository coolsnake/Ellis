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
          quarantined: stats.quarantined || 0,
          total: stats.tracked || 0,
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

  // GET /api/status/drift - Lightweight drift module status
  // IMPORTANT: This endpoint must NOT import DriftService or any heavy SDK modules
  // It only reads from config JSON files to avoid triggering SDK initialization
  api.get('/status/drift', async (_req: Request, res: Response) => {
    try {
      const { readJson } = await import('../../utils/fs.js');
      const pathMod = await import('path');
      const configDir = pathMod.resolve(process.cwd(), 'backend', 'config');

      // Read filler status from JSON config (lightweight)
      let fillerStatus = { count: 0, running: 0, fillsLast5Min: 0 };
      try {
        const store = await readJson<any>(pathMod.join(configDir, 'fillers.json'), { fillers: [] });
        const fillers = store.fillers || [];
        fillerStatus = {
          count: fillers.length,
          running: fillers.filter((f: any) => f.running).length,
          fillsLast5Min: 0,
        };
      } catch {}

      // Read liquidator status from JSON config (lightweight)
      let liquidatorStatus = { count: 0, running: 0 };
      try {
        const store = await readJson<any>(pathMod.join(configDir, 'liquidators.json'), { liquidators: [] });
        const liquidators = store.liquidators || [];
        liquidatorStatus = {
          count: liquidators.length,
          running: liquidators.filter((l: any) => l.running).length,
        };
      } catch {}

      // Read trigger status from JSON config (lightweight)  
      let triggerStatus = { count: 0, running: 0 };
      try {
        const store = await readJson<any>(pathMod.join(configDir, 'triggers.json'), { triggers: [] });
        const triggers = store.triggers || [];
        triggerStatus = {
          count: triggers.length,
          running: triggers.filter((t: any) => t.running).length,
        };
      } catch {}

      // Calculate totals
      const totalBots = fillerStatus.running + liquidatorStatus.running + triggerStatus.running;
      const totalConfigured = fillerStatus.count + liquidatorStatus.count + triggerStatus.count;
      
      // Determine health based on config state only (no SDK calls)
      const active = totalConfigured > 0;
      let health: 'healthy' | 'degraded' | 'offline' = 'offline';
      if (totalBots > 0) {
        health = 'healthy';
      } else if (totalConfigured > 0) {
        health = 'degraded';
      }

      const response: DriftStatusResponse = {
        active,
        health,
        infrastructure: {
          bots: totalConfigured,
          userCount: null, // Skip - requires SDK
          indexStats: null, // Skip - requires SDK
        },
        fillers: fillerStatus,
        liquidators: liquidatorStatus,
        triggers: triggerStatus,
        metrics: {
          attempts: 0,
          successes: 0,
          failureRate: 0,
          costSolLast1Hr: 0,
          revenueUsdcLast1Hr: 0,
        },
        recentTxs: [], // Skip - reading history file can be slow
      };

      res.json(response);
    } catch (e: any) {
      logger.error('status.drift.failed', { cat: 'api', error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}
