/**
 * Meteora bin tracking for DLMM pools
 * 
 * Manages bin array subscriptions and tracking for Meteora DLMM pools
 */

import { createHash } from 'crypto';
import type { MeteoraBinTracker } from './types.js';

/**
 * Meteora bin bitmap size (default coverage -512 to 511)
 */
export const METEORA_BIN_BITMAP_SIZE = 512;

/**
 * Meteora default program ID
 */
export const METEORA_DEFAULT_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/**
 * Map of pool ID to bin tracker
 */
const meteoraBinTrackers: Map<string, MeteoraBinTracker> = new Map();

/**
 * Map of bin account address to pool ID
 */
const meteoraBinAccountToPool: Map<string, string> = new Map();

/**
 * Check if a Meteora bin array is subscribed
 */
export function isMeteoraBinArraySubscribed(address: string): boolean {
  return meteoraBinAccountToPool.has(address);
}

/**
 * Get or create bin tracker for a pool
 */
export function getMeteoraTracker(poolId: string): MeteoraBinTracker {
  let tracker = meteoraBinTrackers.get(poolId);
  if (!tracker) {
    tracker = {
      indexes: new Set(),
      accounts: new Map(),
      binHashes: new Map(),
      aggregate: undefined,
    };
    meteoraBinTrackers.set(poolId, tracker);
  }
  return tracker;
}

/**
 * Get all bin trackers
 */
export function getAllMeteoraBinTrackers(): Map<string, MeteoraBinTracker> {
  return meteoraBinTrackers;
}

/**
 * Register bin account to pool mapping
 */
export function registerBinAccount(address: string, poolId: string): void {
  meteoraBinAccountToPool.set(address, poolId);
}

/**
 * Unregister bin account
 */
export function unregisterBinAccount(address: string): void {
  meteoraBinAccountToPool.delete(address);
}

/**
 * Get pool ID for a bin account
 */
export function getPoolIdForBinAccount(address: string): string | undefined {
  return meteoraBinAccountToPool.get(address);
}

/**
 * Hash a buffer using SHA256
 */
export function hashBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Apply bin hash aggregation for a pool
 * Computes aggregate hash from all bin hashes
 */
export function computeAggregateBinHash(poolId: string): string | undefined {
  const tracker = meteoraBinTrackers.get(poolId);
  if (!tracker || tracker.binHashes.size === 0) {
    return undefined;
  }

  const digest = createHash('sha256');
  const sorted = Array.from(tracker.binHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
  
  for (const [addr, hash] of sorted) {
    digest.update(addr);
    digest.update(':');
    digest.update(hash);
    digest.update('|');
  }
  
  return digest.digest('hex');
}

/**
 * Update bin hash for a pool
 */
export function updateBinHash(poolId: string, address: string, hash: string): void {
  const tracker = getMeteoraTracker(poolId);
  tracker.binHashes.set(address, hash);
}

/**
 * Set aggregate hash for a pool
 */
export function setAggregateHash(poolId: string, aggregate: string | undefined): void {
  const tracker = getMeteoraTracker(poolId);
  tracker.aggregate = aggregate;
}

/**
 * Get aggregate hash for a pool
 */
export function getAggregateHash(poolId: string): string | undefined {
  const tracker = meteoraBinTrackers.get(poolId);
  return tracker?.aggregate;
}

/**
 * Clear all bin trackers
 */
export function clearAllBinTrackers(): void {
  meteoraBinTrackers.clear();
  meteoraBinAccountToPool.clear();
}

/**
 * Clear bin tracker for a specific pool
 */
export function clearBinTracker(poolId: string): void {
  const tracker = meteoraBinTrackers.get(poolId);
  if (tracker) {
    // Remove all bin account mappings
    for (const [addr] of tracker.accounts) {
      meteoraBinAccountToPool.delete(addr);
    }
    meteoraBinTrackers.delete(poolId);
  }
}

