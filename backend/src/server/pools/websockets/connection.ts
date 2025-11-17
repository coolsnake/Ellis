/**
 * WebSocket connection lifecycle management
 * 
 * Handles connection creation, teardown, health monitoring, and protection utilities
 */

import { logger } from '../../../utils/logger.js';

/**
 * WebSocket connection manager state
 */
export interface ConnectionManager {
  conn: any | undefined;
  closePromise: Promise<void> | null;
  unsubscribe: (() => void) | undefined;
  healthy: boolean;
  lastEventMs: number;
  healthTimer: any | undefined;
}

let connectionState: ConnectionManager = {
  conn: undefined,
  closePromise: null,
  unsubscribe: undefined,
  healthy: false,
  lastEventMs: Date.now(),
  healthTimer: undefined,
};

/**
 * Get current connection state
 */
export function getConnectionState(): ConnectionManager {
  return connectionState;
}

/**
 * Update last event timestamp (called on WebSocket activity)
 */
export function markWsEvent(): void {
  connectionState.lastEventMs = Date.now();
}

/**
 * Check if WebSocket is healthy
 */
export function isWsHealthy(): boolean {
  return connectionState.healthy;
}

/**
 * Set WebSocket health status
 */
export function setWsHealthy(healthy: boolean): void {
  connectionState.healthy = healthy;
}

/**
 * Start health monitoring timer
 */
export function startHealthMonitoring(intervalMs: number = 5000): void {
  if (connectionState.healthTimer) {
    clearInterval(connectionState.healthTimer);
  }
  
  connectionState.healthTimer = setInterval(() => {
    const elapsed = Date.now() - connectionState.lastEventMs;
    const wasHealthy = connectionState.healthy;
    connectionState.healthy = elapsed < 30000; // 30 second threshold
    
    if (wasHealthy !== connectionState.healthy) {
      logger.info('ws.health.changed', {
        healthy: connectionState.healthy,
        elapsedMs: elapsed,
        cat: 'pools'
      });
    }
  }, intervalMs);
}

/**
 * Stop health monitoring timer
 */
export function stopHealthMonitoring(): void {
  if (connectionState.healthTimer) {
    clearInterval(connectionState.healthTimer);
    connectionState.healthTimer = undefined;
  }
}

/**
 * Set WebSocket connection
 */
export function setWsConnection(conn: any, unsubscribe?: () => void): void {
  connectionState.conn = conn;
  if (unsubscribe) {
    connectionState.unsubscribe = unsubscribe;
  }
  connectionState.lastEventMs = Date.now();
  connectionState.healthy = true;
}

/**
 * Get WebSocket connection
 */
export function getWsConnection(): any | undefined {
  return connectionState.conn;
}

/**
 * Set close promise for connection teardown coordination
 */
export function setClosePromise(promise: Promise<void> | null): void {
  connectionState.closePromise = promise;
}

/**
 * Get close promise
 */
export function getClosePromise(): Promise<void> | null {
  return connectionState.closePromise;
}

/**
 * Clear WebSocket connection state
 */
export function clearWsConnection(): void {
  if (connectionState.unsubscribe) {
    try {
      connectionState.unsubscribe();
    } catch (err) {
      logger.warn('ws.unsubscribe.failed', { error: String(err), cat: 'pools' });
    }
  }
  
  connectionState.conn = undefined;
  connectionState.unsubscribe = undefined;
  connectionState.healthy = false;
}

/**
 * Execute function with WebSocket connection protection
 * Ensures connection is available before executing
 */
export async function withWsProtection<T>(
  fn: (conn: any) => Promise<T>,
  fallback?: T
): Promise<T | undefined> {
  const conn = connectionState.conn;
  if (!conn) {
    logger.warn('ws.protection.no_connection', { cat: 'pools' });
    return fallback;
  }
  
  try {
    return await fn(conn);
  } catch (err) {
    logger.error('ws.protection.error', {
      error: String((err as any)?.message || err),
      cat: 'pools'
    });
    return fallback;
  }
}

