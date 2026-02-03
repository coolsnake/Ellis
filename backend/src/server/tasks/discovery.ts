/**
 * Discovery Background Task
 * 
 * Manages the background discovery loop that periodically runs the token
 * discovery cycle to find and integrate new pools.
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { runDiscoveryCycle, getDiscoveryConfig } from '../discovery/tokenDiscovery.js';
import type { DiscoveryResult, DiscoveryStatus } from '../discovery/types.js';

// ============================================================================
// State
// ============================================================================

let discoveryInterval: NodeJS.Timeout | null = null;
let lastResult: DiscoveryResult | null = null;
let nextRunAt: number | null = null;
let isRunning = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if the discovery loop is currently running
 */
export function isDiscoveryRunning(): boolean {
  return discoveryInterval !== null;
}

/**
 * Check if a discovery cycle is currently in progress
 */
export function isDiscoveryCycleInProgress(): boolean {
  return isRunning;
}

/**
 * Get the last discovery cycle result
 */
export function getLastDiscoveryResult(): DiscoveryResult | null {
  return lastResult;
}

/**
 * Get the next scheduled run time
 */
export function getNextDiscoveryRunTime(): number | null {
  return nextRunAt;
}

/**
 * Get full discovery status
 */
export function getDiscoveryStatus(): DiscoveryStatus {
  const cfg = getDiscoveryConfig();
  
  return {
    running: isDiscoveryRunning(),
    lastResult: lastResult || undefined,
    nextRunAt: nextRunAt || undefined,
    config: cfg,
  };
}

// ============================================================================
// Discovery Loop
// ============================================================================

/**
 * Run a single discovery cycle (can be called manually)
 */
export async function runDiscovery(options?: {
  maxTokens?: number;
  maxPoolsPerToken?: number;
  minLiquidityUsd?: number;
  dryRun?: boolean;
}): Promise<DiscoveryResult> {
  if (isRunning) {
    logger.warn('discovery.task.already_running', { cat: 'discovery' });
    return lastResult || {
      tokensChecked: 0,
      newTokensFound: 0,
      poolsDiscovered: 0,
      poolsFiltered: 0,
      poolsEnriched: 0,
      poolsAdded: 0,
      errors: ['Discovery cycle already in progress'],
      byDex: {},
      timestamp: Date.now(),
      durationMs: 0,
    };
  }
  
  isRunning = true;
  
  try {
    const result = await runDiscoveryCycle(options);
    lastResult = result;
    return result;
  } finally {
    isRunning = false;
  }
}

/**
 * Internal loop handler
 */
async function discoveryLoopTick(): Promise<void> {
  try {
    await runDiscovery();
  } catch (err: any) {
    logger.error('discovery.task.tick_error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
  
  // Schedule next run
  if (discoveryInterval) {
    const cfg = getDiscoveryConfig();
    nextRunAt = Date.now() + cfg.intervalMs;
  }
}

/**
 * Start the discovery background loop
 * 
 * @param intervalMs Interval between cycles (default: from config)
 * @param runImmediately Whether to run a cycle immediately (default: false)
 */
export function startDiscoveryLoop(
  intervalMs?: number,
  runImmediately = false
): void {
  if (discoveryInterval) {
    logger.warn('discovery.task.already_started', { cat: 'discovery' });
    return;
  }
  
  const cfg = getDiscoveryConfig();
  const interval = intervalMs || cfg.intervalMs;
  
  logger.info('discovery.task.start', { 
    intervalMs: interval,
    runImmediately,
    cat: 'discovery' 
  });
  
  // Set up the interval
  discoveryInterval = setInterval(discoveryLoopTick, interval);
  nextRunAt = Date.now() + interval;
  
  // Optionally run immediately
  if (runImmediately) {
    nextRunAt = Date.now();
    setImmediate(() => discoveryLoopTick());
  }
}

/**
 * Stop the discovery background loop
 */
export function stopDiscoveryLoop(): void {
  if (!discoveryInterval) {
    logger.debug('discovery.task.not_running', { cat: 'discovery' });
    return;
  }
  
  clearInterval(discoveryInterval);
  discoveryInterval = null;
  nextRunAt = null;
  
  logger.info('discovery.task.stopped', { cat: 'discovery' });
}

/**
 * Restart the discovery loop with new interval
 */
export function restartDiscoveryLoop(intervalMs?: number): void {
  stopDiscoveryLoop();
  startDiscoveryLoop(intervalMs);
}

// ============================================================================
// Startup Hook
// ============================================================================

/**
 * Initialize discovery service on startup if enabled
 */
export function initDiscoveryService(): void {
  const cfg = getDiscoveryConfig();
  
  if (cfg.enabled) {
    logger.info('discovery.service.init', { 
      enabled: true,
      intervalMs: cfg.intervalMs,
      cat: 'discovery' 
    });
    
    // Start loop with a delay to let other services initialize
    setTimeout(() => {
      startDiscoveryLoop(cfg.intervalMs, false);
    }, 10_000); // 10 second delay
    
  } else {
    logger.info('discovery.service.disabled', { cat: 'discovery' });
  }
}
