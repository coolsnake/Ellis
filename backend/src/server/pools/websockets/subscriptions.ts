/**
 * Subscription management for WebSocket pool monitoring
 * 
 * Handles account and program subscriptions with retry logic and backoff
 */

import { logger } from '../../../utils/logger.js';
import type { DexSource } from './types.js';

/**
 * Subscription state tracking
 */
export interface SubscriptionState {
  attachedRaydiumPools: number;
  attachedRaydiumCpmmPools: number;
  attachedOrcaPools: number;
  attachedMeteoraPools: number;
  attachedPumpswapPools: number;
  attachedMeteoraBalancedPools: number;
}

const subscriptionState: SubscriptionState = {
  attachedRaydiumPools: 0,
  attachedRaydiumCpmmPools: 0,
  attachedOrcaPools: 0,
  attachedMeteoraPools: 0,
  attachedPumpswapPools: 0,
  attachedMeteoraBalancedPools: 0,
};

/**
 * Get current subscription state
 */
export function getSubscriptionState(): SubscriptionState {
  return { ...subscriptionState };
}

/**
 * Update subscription count for a DEX
 */
export function setSubscriptionCount(dex: DexSource, count: number): void {
  switch (dex) {
    case 'raydium':
      subscriptionState.attachedRaydiumPools = count;
      break;
    case 'raydium-cpmm':
      subscriptionState.attachedRaydiumCpmmPools = count;
      break;
    case 'orca':
      subscriptionState.attachedOrcaPools = count;
      break;
    case 'meteora_dlmm':
      subscriptionState.attachedMeteoraPools = count;
      break;
    case 'meteora_damm_v1':
    case 'meteora_damm_v2':
      subscriptionState.attachedMeteoraBalancedPools = count;
      break;
    case 'pumpswap':
      subscriptionState.attachedPumpswapPools = count;
      break;
  }
}

/**
 * Get subscription count for a DEX
 */
export function getSubscriptionCount(dex: DexSource): number {
  switch (dex) {
    case 'raydium':
      return subscriptionState.attachedRaydiumPools;
    case 'raydium-cpmm':
      return subscriptionState.attachedRaydiumCpmmPools;
    case 'orca':
      return subscriptionState.attachedOrcaPools;
    case 'meteora_dlmm':
      return subscriptionState.attachedMeteoraPools;
    case 'meteora_damm_v1':
    case 'meteora_damm_v2':
      return subscriptionState.attachedMeteoraBalancedPools;
    case 'pumpswap':
      return subscriptionState.attachedPumpswapPools;
  }
}

/**
 * Subscribe to an account with retry and backoff
 */
export async function subscribeAccountWithRetry(
  conn: any,
  publicKey: any,
  handler: (accountInfo: any, context: any) => void,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<number | null> {
  let lastError: any;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const subscriptionId = await conn.onAccountChange(publicKey, handler);
      return subscriptionId;
    } catch (err) {
      lastError = err;
      logger.warn('ws.subscribe.account.retry', {
        attempt: attempt + 1,
        maxRetries,
        error: String((err as any)?.message || err),
        cat: 'pools'
      });
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  logger.error('ws.subscribe.account.failed', {
    error: String((lastError as any)?.message || lastError),
    cat: 'pools'
  });
  
  return null;
}

/**
 * Subscribe to a program with retry and backoff
 */
export async function subscribeProgramWithRetry(
  conn: any,
  programId: any,
  handler: (accountInfo: any, context: any) => void,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<number | null> {
  let lastError: any;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const subscriptionId = await conn.onProgramAccountChange(programId, handler);
      return subscriptionId;
    } catch (err) {
      lastError = err;
      logger.warn('ws.subscribe.program.retry', {
        attempt: attempt + 1,
        maxRetries,
        error: String((err as any)?.message || err),
        cat: 'pools'
      });
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  logger.error('ws.subscribe.program.failed', {
    error: String((lastError as any)?.message || lastError),
    cat: 'pools'
  });
  
  return null;
}

/**
 * Clear all subscription state
 */
export function clearSubscriptionState(): void {
  subscriptionState.attachedRaydiumPools = 0;
  subscriptionState.attachedOrcaPools = 0;
  subscriptionState.attachedMeteoraPools = 0;
  subscriptionState.attachedPumpswapPools = 0;
  subscriptionState.attachedMeteoraBalancedPools = 0;
}

