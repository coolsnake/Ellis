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
      res.json({
        rpcUrl: CONFIG.rpcUrl,
        system: CONFIG.system,
        fees: CONFIG.fees,
        raydium: CONFIG.raydium,
        orca: CONFIG.orca,
        meteora: (CONFIG as any).meteora,
        sanity: (CONFIG as any).sanity,
      });
    } catch (e: any) {
      logger.error('server: failed to get system config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/system/config', async (req, res) => {
    try {
      const { rpcUrl, system, fees, raydium, orca, sanity } = req.body as {
        rpcUrl?: string;
        system?: any;
        fees?: any;
        raydium?: { enableOnChain?: boolean; ammV4Program?: string; clmmProgram?: string; cacheTtlMs?: number; sdkConcurrency?: number; sdkProbeMintsLimit?: number; sdkClmmPageSize?: number; filterToOrcaTokens?: boolean };
        orca?: { mode?: string; apiUrl?: string; programId?: string; configPubkey?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; pageSize?: number; maxPages?: number; minAmmLiqBase?: number; minClmmLiquidity?: number };
        sanity?: { enabled?: boolean; maxPriceDeviation?: number; feeMin?: number; feeMax?: number; writeSamples?: boolean; sampleRate?: number };
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
      if (orca) CONFIG.orca = { ...CONFIG.orca, ...orca } as any;
      if (sanity) (CONFIG as any).sanity = { ...(CONFIG as any).sanity, ...sanity } as any;
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
      setTimeout(() => {
        try { emit('log', { level: 'warn', message: 'terminal: shutting down now', timestamp: new Date().toISOString() }); } catch {}
        try { writeSessionLogAndClear().catch(() => null); } catch {}
        process.exit(0);
      }, 250);
    } catch (e: any) {
      logger.error('server: shutdown failed', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return api;
}


