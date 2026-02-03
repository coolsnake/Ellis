/**
 * Discovery API Routes
 * 
 * Routes for managing the token discovery service.
 */

import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import {
  isDiscoveryRunning,
  isDiscoveryCycleInProgress,
  getLastDiscoveryResult,
  getDiscoveryStatus,
  runDiscovery,
  startDiscoveryLoop,
  stopDiscoveryLoop,
  restartDiscoveryLoop,
} from '../tasks/discovery.js';
import { getDiscoveryConfig, runFullUniverseDiscoveryCycle } from '../discovery/tokenDiscovery.js';

export function createDiscoveryRouter(io: SocketIOServer): Router {
  const api = Router();
  
  // ============================================================================
  // GET /api/discovery/status
  // Get the current status of the discovery service
  // ============================================================================
  api.get('/discovery/status', async (req, res) => {
    try {
      const status = getDiscoveryStatus();
      res.json(status);
    } catch (err: any) {
      logger.error('discovery.route.status.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // GET /api/discovery/config
  // Get the current discovery configuration
  // ============================================================================
  api.get('/discovery/config', async (req, res) => {
    try {
      const cfg = getDiscoveryConfig();
      // Mask the API key for security
      const safeConfig = {
        ...cfg,
        jupiterApiKey: cfg.jupiterApiKey ? '****' + cfg.jupiterApiKey.slice(-4) : '',
      };
      res.json(safeConfig);
    } catch (err: any) {
      logger.error('discovery.route.config.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // POST /api/discovery/config
  // Update discovery configuration (runtime only, not persisted)
  // ============================================================================
  api.post('/discovery/config', async (req, res) => {
    try {
      const body = req.body || {};
      const disc = (CONFIG as any).discovery || {};
      
      // Update allowed fields
      if (typeof body.enabled === 'boolean') disc.enabled = body.enabled;
      if (typeof body.intervalMs === 'number' && body.intervalMs > 0) disc.intervalMs = body.intervalMs;
      if (body.jupiterApiKey !== undefined) disc.jupiterApiKey = String(body.jupiterApiKey);
      if (body.jupiterCategory) disc.jupiterCategory = body.jupiterCategory;
      if (body.jupiterInterval) disc.jupiterInterval = body.jupiterInterval;
      if (typeof body.jupiterLimit === 'number') disc.jupiterLimit = Math.max(1, Math.min(100, body.jupiterLimit));
      if (typeof body.minLiquidityUsd === 'number') disc.minLiquidityUsd = Math.max(0, body.minLiquidityUsd);
      if (typeof body.maxPoolsPerToken === 'number') disc.maxPoolsPerToken = Math.max(1, body.maxPoolsPerToken);
      if (Array.isArray(body.supportedDexIds)) disc.supportedDexIds = body.supportedDexIds;
      
      (CONFIG as any).discovery = disc;
      
      // Restart loop if running and interval changed
      if (isDiscoveryRunning() && body.intervalMs) {
        restartDiscoveryLoop(body.intervalMs);
      }
      
      logger.info('discovery.route.config.updated', { cat: 'discovery' });
      
      res.json({ success: true, config: getDiscoveryConfig() });
    } catch (err: any) {
      logger.error('discovery.route.config.update.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // POST /api/discovery/run
  // Manually trigger a discovery cycle
  // ============================================================================
  api.post('/discovery/run', async (req, res) => {
    try {
      if (isDiscoveryCycleInProgress()) {
        res.status(409).json({ 
          error: 'Discovery cycle already in progress',
          inProgress: true,
        });
        return;
      }
      
      const body = req.body || {};
      const options = {
        maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
        maxPoolsPerToken: typeof body.maxPoolsPerToken === 'number' ? body.maxPoolsPerToken : undefined,
        minLiquidityUsd: typeof body.minLiquidityUsd === 'number' ? body.minLiquidityUsd : undefined,
        dryRun: body.dryRun === true,
      };
      
      logger.info('discovery.route.run.start', { options, cat: 'discovery' });
      
      // Run asynchronously and return immediately
      const runPromise = runDiscovery(options);
      
      // If client wants to wait, do so with timeout
      if (body.wait === true) {
        const timeout = Number(body.timeoutMs || 60000);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout));
        
        const result = await Promise.race([runPromise, timeoutPromise]);
        
        if (result === null) {
          res.json({ 
            started: true, 
            timeout: true,
            message: 'Discovery cycle is still running',
          });
        } else {
          res.json({ started: true, result });
        }
      } else {
        // Return immediately
        res.json({ 
          started: true, 
          message: 'Discovery cycle started',
          inProgress: true,
        });
        
        // Let the cycle run in background
        runPromise.catch(err => {
          logger.error('discovery.route.run.background_error', { 
            error: String(err?.message || err),
            cat: 'discovery' 
          });
        });
      }
      
    } catch (err: any) {
      logger.error('discovery.route.run.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // POST /api/discovery/full-universe
  // Run a full universe discovery (all tokens + Jupiter top 100)
  // WARNING: This is slow and rate-limited, can take 10+ minutes
  // ============================================================================
  api.post('/discovery/full-universe', async (req, res) => {
    try {
      if (isDiscoveryCycleInProgress()) {
        res.status(409).json({ 
          error: 'Discovery cycle already in progress',
          inProgress: true,
        });
        return;
      }
      
      const body = req.body || {};
      const options = {
        minLiquidityUsd: typeof body.minLiquidityUsd === 'number' ? body.minLiquidityUsd : undefined,
        maxPoolsPerToken: typeof body.maxPoolsPerToken === 'number' ? body.maxPoolsPerToken : undefined,
        batchSize: typeof body.batchSize === 'number' ? body.batchSize : 20,
        batchDelayMs: typeof body.batchDelayMs === 'number' ? body.batchDelayMs : 2000,
        dryRun: body.dryRun === true,
      };
      
      logger.info('discovery.route.full_universe.start', { options, cat: 'discovery' });
      
      // Run the full universe discovery
      const runPromise = runFullUniverseDiscoveryCycle(options);
      
      // If client wants to wait, do so with timeout
      if (body.wait === true) {
        const timeout = Number(body.timeoutMs || 600000); // 10 min default
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout));
        
        const result = await Promise.race([runPromise, timeoutPromise]);
        
        if (result === null) {
          res.json({ 
            started: true, 
            timeout: true,
            message: 'Full universe discovery is still running (timed out waiting)',
          });
        } else {
          res.json({ started: true, result });
        }
      } else {
        // Return immediately
        res.json({ 
          started: true, 
          message: 'Full universe discovery started (this may take 10+ minutes)',
          inProgress: true,
        });
        
        // Let the cycle run in background
        runPromise.catch(err => {
          logger.error('discovery.route.full_universe.background_error', { 
            error: String(err?.message || err),
            cat: 'discovery' 
          });
        });
      }
      
    } catch (err: any) {
      logger.error('discovery.route.full_universe.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // POST /api/discovery/start
  // Start the discovery background loop
  // ============================================================================
  api.post('/discovery/start', async (req, res) => {
    try {
      if (isDiscoveryRunning()) {
        res.status(409).json({ 
          error: 'Discovery loop already running',
          running: true,
        });
        return;
      }
      
      const body = req.body || {};
      const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : undefined;
      const runImmediately = body.runImmediately === true;
      
      startDiscoveryLoop(intervalMs, runImmediately);
      
      logger.info('discovery.route.start', { intervalMs, runImmediately, cat: 'discovery' });
      
      res.json({ 
        success: true, 
        running: true,
        status: getDiscoveryStatus(),
      });
      
    } catch (err: any) {
      logger.error('discovery.route.start.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // POST /api/discovery/stop
  // Stop the discovery background loop
  // ============================================================================
  api.post('/discovery/stop', async (req, res) => {
    try {
      if (!isDiscoveryRunning()) {
        res.status(409).json({ 
          error: 'Discovery loop not running',
          running: false,
        });
        return;
      }
      
      stopDiscoveryLoop();
      
      logger.info('discovery.route.stop', { cat: 'discovery' });
      
      res.json({ 
        success: true, 
        running: false,
        lastResult: getLastDiscoveryResult(),
      });
      
    } catch (err: any) {
      logger.error('discovery.route.stop.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  // ============================================================================
  // GET /api/discovery/last
  // Get the last discovery cycle result
  // ============================================================================
  api.get('/discovery/last', async (req, res) => {
    try {
      const result = getLastDiscoveryResult();
      if (!result) {
        res.status(404).json({ error: 'No discovery results yet' });
        return;
      }
      res.json(result);
    } catch (err: any) {
      logger.error('discovery.route.last.error', { 
        error: String(err?.message || err),
        cat: 'discovery' 
      });
      res.status(500).json({ error: String(err?.message || 'Internal error') });
    }
  });
  
  return api;
}
