import type { Request, Response } from 'express';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';
import { systemStatus } from '../status.js';
import { emit } from '../realtime.js';
import { writeSessionLogAndClear } from '../../utils/sessionLogs.js';
import { logger, setLogLevel, setLoggingEnabled, setFileLogging } from '../../utils/logger.js';

export function createSystemRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/system', async (_req, res) => {
    const { getAppInfo } = await import('../../utils/appInfo.js');
    const info = await getAppInfo();
    res.json({
      version: info.version,
      name: info.name,
      status: 'ok',
      uptimeMs: Date.now() - systemStatus.startTimeMs,
      lastPriceUpdateMs: systemStatus.lastPriceUpdateMs,
      rateLimitActive: systemStatus.rateLimitActive,
      cooldownUntilMs: systemStatus.cooldownUntilMs,
      botName: info.name,
      bot: systemStatus.bot,
      targetTickTimeMs: systemStatus.targetTickTimeMs,
      rpcUrl: CONFIG.rpcUrl,
      fees: CONFIG.fees,
      system: CONFIG.system,
      logCategories: CONFIG.system.logCategories,
    });
  });

  api.get('/system/config', async (_req, res) => {
    try {
      // Get pool activation stats
      let poolsActivationStats: { enabled: boolean; activatedCount: number; pendingBatchCount: number } | null = null;
      try {
        const { getActivationStats } = await import('../pools.activation.js');
        poolsActivationStats = getActivationStats();
      } catch {}
      
      // Get pool data validation status
      let poolDataValidationEnabled = true;
      let reactiveValidationRunning = false;
      try {
        const { isPoolDataValidationEnabled, isReactiveValidationRunning } = await import('../../execution/cacheValidator.js');
        poolDataValidationEnabled = isPoolDataValidationEnabled();
        reactiveValidationRunning = isReactiveValidationRunning();
      } catch {}
      
      res.json({
        rpcUrl: CONFIG.rpcUrl,
        system: CONFIG.system,
        fees: CONFIG.fees,
        raydium: CONFIG.raydium,
        raydiumCpmm: (CONFIG as any).raydiumCpmm,
        raydiumClmm: (CONFIG as any).raydiumClmm,
        orca: CONFIG.orca,
        meteora: (CONFIG as any).meteora,
        meteoraBalanced: (CONFIG as any).meteoraBalanced,
        pumpswap: (CONFIG as any).pumpswap,
        sanity: (CONFIG as any).sanity,
        shyft: (CONFIG as any).shyft,
        pools: {
          activationMode: (CONFIG.system as any)?.poolActivationMode || 'immediate',
          activationStats: poolsActivationStats,
        },
        // Pool data validation status
        validation: {
          poolDataValidationEnabled,
          reactiveValidationRunning,
        },
      });
    } catch (e: any) {
      logger.error('server: failed to get system config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/system/config', async (req, res) => {
    try {
      const { rpcUrl, system, fees, raydium, raydiumCpmm, raydiumClmm, orca, meteora, meteoraBalanced, pumpswap, sanity, pools, validation } = req.body as {
        rpcUrl?: string;
        system?: any;
        fees?: any;
        raydium?: { enableOnChain?: boolean; ammV4Program?: string; clmmProgram?: string; cacheTtlMs?: number; concurrency?: number; pageSize?: number; maxPages?: number; maxHttpRetries?: number; httpBackoffMs?: number; minAmmLiqBase?: number; minClmmLiquidity?: number; graphqlPageSize?: number; graphqlMaxPages?: number; pageDelayMs?: number; mintBatchSize?: number; detailBatchSize?: number };
        raydiumCpmm?: { enabled?: boolean; pageDelayMs?: number; mintBatchSize?: number; graphqlPageSize?: number; graphqlMaxPages?: number; detailBatchSize?: number; pageSize?: number; maxPages?: number };
        raydiumClmm?: { pageDelayMs?: number; mintBatchSize?: number; graphqlPageSize?: number; graphqlMaxPages?: number; detailBatchSize?: number; pageSize?: number; maxPages?: number };
        orca?: { apiUrl?: string; programId?: string; configPubkey?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; pageSize?: number; maxPages?: number; minAmmLiqBase?: number; minClmmLiquidity?: number; graphqlPageSize?: number; graphqlMaxPages?: number; pageDelayMs?: number; mintBatchSize?: number; detailBatchSize?: number };
        meteora?: { apiUrl?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; pageSize?: number; maxPages?: number; minClmmLiquidity?: number; universePrefilter?: boolean; graphqlPageSize?: number; graphqlMaxPages?: number; pageDelayMs?: number; mintBatchSize?: number; detailBatchSize?: number };
        meteoraBalanced?: { apiUrl?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; pageSize?: number; maxPages?: number };
        pumpswap?: { shyftApiKey?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; defaultFeeBps?: number; minLiqBase?: number; pageSize?: number; maxPages?: number; pageDelayMs?: number; enableRpcEnrichment?: boolean; rpcBatchSize?: number; validatePrices?: boolean; validationSamples?: number; graphqlPageSize?: number; graphqlMaxPages?: number; mintBatchSize?: number };
        sanity?: { enabled?: boolean; maxPriceDeviation?: number; feeMin?: number; feeMax?: number; writeSamples?: boolean; sampleRate?: number; sanity_applyRaydiumAmm?: boolean; sanity_applyOrcaClmm?: boolean };
        pools?: { activationMode?: 'immediate' | 'lazy' };
        validation?: { poolDataValidationEnabled?: boolean };
      };
      if (rpcUrl) CONFIG.rpcUrl = rpcUrl;
      if (system) {
        const nextSystem = { ...CONFIG.system, ...system } as any;
        try {
          if (Array.isArray(system.enabledLogCategories)) {
            nextSystem.enabledLogCategories = (system.enabledLogCategories as string[]).map((s) => String(s).toLowerCase());
          }
          if (Array.isArray(system.frontendEnabledLogCategories)) {
            nextSystem.frontendEnabledLogCategories = (system.frontendEnabledLogCategories as string[]).map((s) => String(s).toLowerCase());
          }
          if (Array.isArray(nextSystem.enabledLogCategories) && nextSystem.enabledLogCategories.length) {
            nextSystem.log = nextSystem.log || {};
            const cats: Record<string, 'error'|'warn'|'info'|'debug'> = { ...(nextSystem.log?.categories || {}) };
            const on = new Set<string>(nextSystem.enabledLogCategories);
            const all: string[] = Array.isArray(nextSystem.logCategories) ? nextSystem.logCategories : [];
            for (const c of all) {
              const name = String(c || '').toLowerCase();
              if (!name) continue;
              cats[name] = on.has(name) ? (cats[name] || 'info') : 'error';
            }
            nextSystem.log.categories = cats;
          }
        } catch {}
        CONFIG.system = nextSystem;
      }
      if (fees) CONFIG.fees = { ...CONFIG.fees, ...fees };
      if (raydium) CONFIG.raydium = { ...CONFIG.raydium, ...raydium } as any;
      if (raydiumCpmm) (CONFIG as any).raydiumCpmm = { ...(CONFIG as any).raydiumCpmm, ...raydiumCpmm };
      if (raydiumClmm) (CONFIG as any).raydiumClmm = { ...(CONFIG as any).raydiumClmm, ...raydiumClmm };
      if (orca) CONFIG.orca = { ...CONFIG.orca, ...orca } as any;
      if (meteora) (CONFIG as any).meteora = { ...(CONFIG as any).meteora, ...meteora } as any;
      if (meteoraBalanced) (CONFIG as any).meteoraBalanced = { ...(CONFIG as any).meteoraBalanced, ...meteoraBalanced } as any;
      if (pumpswap) (CONFIG as any).pumpswap = { ...(CONFIG as any).pumpswap, ...pumpswap } as any;
      if (sanity) (CONFIG as any).sanity = { ...(CONFIG as any).sanity, ...sanity } as any;
      
      // Handle pool activation mode changes
      if (pools?.activationMode) {
        try {
          const { setLazyActivationEnabled } = await import('../pools.activation.js');
          const enabled = pools.activationMode === 'lazy';
          setLazyActivationEnabled(enabled);
          (CONFIG.system as any).poolActivationMode = pools.activationMode;
          logger.info('server: pool activation mode changed', { mode: pools.activationMode, enabled, cat: 'server' });
        } catch (activationErr) {
          logger.warn('server: failed to set pool activation mode', { error: String((activationErr as Error)?.message || activationErr), cat: 'server' });
        }
      }
      
      // Handle pool data validation toggle
      if (validation?.poolDataValidationEnabled !== undefined) {
        try {
          const { setPoolDataValidationEnabled, startReactiveValidation, isReactiveValidationRunning } = 
            await import('../../execution/cacheValidator.js');
          const enabled = !!validation.poolDataValidationEnabled;
          setPoolDataValidationEnabled(enabled);
          
          // If enabling and reactive validation is not running, start it
          if (enabled && !isReactiveValidationRunning()) {
            const intervalMs = Math.max(250, Number((CONFIG.system as any)?.tickArrayValidatorIntervalMs || 500));
            startReactiveValidation(intervalMs);
          }
          
          logger.info('server: pool data validation toggled', { enabled, cat: 'server' });
        } catch (validationErr) {
          logger.warn('server: failed to toggle pool data validation', { 
            error: String((validationErr as Error)?.message || validationErr), 
            cat: 'server' 
          });
        }
      }
      
      try {
        if (system && Object.prototype.hasOwnProperty.call(system, 'enableLogging')) {
          setLoggingEnabled(system.enableLogging !== false);
        }
        if (system && typeof system.logLevel === 'string') {
          setLogLevel((system.logLevel as string) as any);
        }
        if (system && (Object.prototype.hasOwnProperty.call(system, 'logToFile') || typeof system.logFilePath === 'string')) {
          setFileLogging(!!system.logToFile, system.logFilePath);
        }
      } catch {}
      res.json({ success: true, message: 'System configuration updated' });
      emit('log', { level: 'info', message: 'System configuration updated', timestamp: new Date().toISOString(), context: { cat: 'terminal' } });
    } catch (e: any) {
      logger.error('server: failed to update system config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/system/shutdown', async (_req, res) => {
    try {
      emit('log', { level: 'warn', message: 'terminal: shutdown requested from UI', timestamp: new Date().toISOString() });
      res.json({ ok: true });
      // Use proper shutdown function for comprehensive cleanup
      setTimeout(async () => {
        try {
          // Import and call the main shutdown function from index.ts
          const { shutdown } = await import('../index.js');
          await shutdown();
        } catch (e) {
          try { emit('log', { level: 'error', message: `terminal: shutdown error: ${String(e?.message || e)}`, timestamp: new Date().toISOString() }); } catch {}
          process.exit(1);
        }
      }, 250);
    } catch (e: any) {
      logger.error('server: shutdown failed', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.get('/system/rpc/metrics', async (_req, res) => {
    try {
      const { getRpcMetrics } = await import('../../utils/rpcLimiter.js');
      const metrics = getRpcMetrics();
      res.json(metrics);
    } catch (e: any) {
      logger.error('server: failed to get RPC metrics', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/system/rpc/limiter/config', async (_req, res) => {
    try {
      const { loadRpcLimiterConfig } = await import('../rpcLimiterConfigStore.js');
      const config = await loadRpcLimiterConfig();
      res.json(config);
    } catch (e: any) {
      logger.error('server: failed to get RPC limiter config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/system/rpc/limiter/config', async (req, res) => {
    try {
      const { maxRps, burst, minGapMs } = req.body as {
        maxRps?: number;
        burst?: number;
        minGapMs?: number;
      };

      // Validate input
      if (maxRps !== undefined && (!Number.isFinite(maxRps) || maxRps <= 0)) {
        return res.status(400).json({ error: 'maxRps must be a positive number' });
      }
      if (burst !== undefined && (!Number.isFinite(burst) || burst < 0)) {
        return res.status(400).json({ error: 'burst must be a non-negative number' });
      }
      if (minGapMs !== undefined && (!Number.isFinite(minGapMs) || minGapMs < 0)) {
        return res.status(400).json({ error: 'minGapMs must be a non-negative number' });
      }

      // Update the in-memory limiter first
      const { updateRpcLimiterConfig } = await import('../../utils/rpcLimiter.js');
      const updated = updateRpcLimiterConfig({
        maxRps,
        burst,
        minGapMs,
      });

      // Persist to file
      const { saveRpcLimiterConfig, loadRpcLimiterConfig } = await import('../rpcLimiterConfigStore.js');
      const currentConfig = await loadRpcLimiterConfig();
      const saved = await saveRpcLimiterConfig({
        maxRps: updated.maxRps,
        burst: burst !== undefined ? burst : currentConfig.burst,
        minGapMs: updated.minGapMs,
      });

      logger.info('server: RPC limiter config updated', {
        maxRps: saved.maxRps,
        burst: saved.burst,
        minGapMs: saved.minGapMs,
        cat: 'server',
      });

      emit('log', {
        level: 'info',
        message: `RPC rate limiter updated: maxRps=${saved.maxRps}, burst=${saved.burst}, minGapMs=${saved.minGapMs}ms`,
        timestamp: new Date().toISOString(),
        context: { cat: 'terminal' },
      });

      res.json({ success: true, config: saved });
    } catch (e: any) {
      logger.error('server: failed to update RPC limiter config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


