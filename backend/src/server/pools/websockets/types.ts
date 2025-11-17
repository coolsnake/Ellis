/**
 * Shared types and interfaces for the WebSocket pool monitoring system
 */

import type { PoolsPayload } from '../types.js';

/**
 * Handler function for refreshing all pool sources
 */
export type RefreshAllSourcesHandler = (force?: boolean, subscribe?: boolean, opts?: any) => Promise<{
  raydium: PoolsPayload;
  orca: PoolsPayload;
  meteora: PoolsPayload;
  meteora_balanced: PoolsPayload;
  pumpswap: PoolsPayload;
}>;

/**
 * Options for refreshing pool sources
 */
export interface RefreshSourcesOptions {
  force?: boolean;
  subscribe?: boolean;
  [key: string]: any;
}

/**
 * DEX source identifier
 */
export type DexSource = 'raydium' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced';

/**
 * Pool decoder interface - each DEX decoder must implement these methods
 */
export interface PoolDecoder {
  /**
   * Decode a pool from raw account data
   * @param accountData Raw account data buffer
   * @param poolId Pool address
   * @returns Decoded pool object or null if decoding fails
   */
  decodePool(accountData: Buffer, poolId: string): any | null;

  /**
   * Handle account update event from WebSocket
   * @param account Account info from WebSocket
   * @param poolId Pool address
   */
  handleAccountUpdate(account: any, poolId: string): Promise<void>;
}

/**
 * Validation result for decoded pools
 */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Validation statistics per DEX
 */
export interface ValidationStats {
  missingMints: number;
  invalidPrice: number;
  invalidLiquidity: number;
  invalidFee: number;
  invalidTick: number;
  emptyMints: number;
}

/**
 * WebSocket subscription state
 */
export interface WsSubscriptionState {
  raydium: number;
  orca: number;
  meteora: number;
  pumpswap: number;
  meteora_balanced: number;
}

/**
 * WebSocket connection state
 */
export interface WsConnectionState {
  conn: any | undefined;
  closePromise: Promise<void> | null;
  unsubscribe: (() => void) | undefined;
  healthy: boolean;
  lastEventMs: number;
}

/**
 * Meteora bin tracker for DLMM pools
 */
export interface MeteoraBinTracker {
  indexes: Set<number>;
  accounts: Map<string, { id: number; index: number }>;
  binHashes: Map<string, string>;
  aggregate?: string;
}

/**
 * Derived account mapping
 */
export interface DerivedAccountInfo {
  poolId: string;
  accountType: 'vault' | 'reserve' | 'tick_array' | 'oracle' | 'observation';
}

/**
 * Debounce state for DEX apply operations
 */
export interface DexApplyState {
  baseline: any | null;
  timer: NodeJS.Timeout | null;
}

