import type { DirectHop } from '../types.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { createBuilderError } from './errors.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';

/**
 * Validates hop amounts are positive and reasonable
 * @throws Error if amounts are invalid
 */
export function validateHopAmounts(hop: DirectHop, context?: Record<string, unknown>): void {
  const amountIn = hop.amountInRaw ?? 0n;
  const minOut = hop.minOutRaw ?? 0n;

  if (amountIn <= 0n) {
    throw new Error(`INVALID_AMOUNT_IN: amountIn must be positive, got ${amountIn.toString()}`);
  }

  if (minOut < 0n) {
    throw new Error(`INVALID_MIN_OUT: minOut must be non-negative, got ${minOut.toString()}`);
  }

  // Sanity check: minOut vs amountIn comparison only makes sense for same-token operations
  // For swaps, minOut and amountIn are in different token units (different decimals),
  // so direct comparison is invalid. Skip this check when tokens differ.
  const inputMint = hop.inputMint;
  const outputMint = hop.outputMint;
  const isSameToken = inputMint && outputMint && inputMint === outputMint;
  
  if (isSameToken && minOut > amountIn) {
    // Only validate when tokens are the same (e.g., token transfers, not swaps)
    const slippage = Number((minOut - amountIn) * 10000n / amountIn);
    if (slippage > 10000) {
      throw new Error(`INVALID_SLIPPAGE: minOut (${minOut.toString()}) exceeds amountIn (${amountIn.toString()}) by more than 100%`);
    }
    try {
      logger.warn('validation.amounts.high_slippage', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: { amountIn: amountIn.toString(), minOut: minOut.toString(), slippageBps: slippage, ...context }
      });
    } catch (e) { logCatchError('builder.validation', e); }
  }

  // Overflow protection: check amounts don't exceed safe JS number range
  const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
  if (amountIn > MAX_SAFE_INTEGER || minOut > MAX_SAFE_INTEGER) {
    throw new Error(`AMOUNT_OVERFLOW: amounts exceed safe integer range`);
  }
}

/**
 * Validates a PublicKey string or object
 * @returns true if valid, throws Error if invalid
 */
export function validatePublicKey(value: any, fieldName: string, context?: Record<string, unknown>): PublicKey {
  if (!value) {
    throw new Error(`INVALID_PUBLICKEY: ${fieldName} is required`);
  }

  try {
    let keyString: string;
    if (value instanceof PublicKey) {
      return value;
    } else if (typeof value === 'string') {
      keyString = value.trim();
    } else if (value && typeof value === 'object') {
      // Try to extract string representation
      keyString = String(value.toBase58?.() || value.toString?.() || value.address || value.pubkey || value);
    } else {
      throw new Error(`INVALID_PUBLICKEY: ${fieldName} is not a valid PublicKey type`);
    }

    // Check for placeholder keys (common pattern: all 1s or system default)
    if (/^11111+$/.test(keyString)) {
      throw new Error(`INVALID_PUBLICKEY: ${fieldName} appears to be a placeholder key (${keyString})`);
    }

    // Check for system default
    if (keyString === PublicKey.default.toBase58()) {
      throw new Error(`INVALID_PUBLICKEY: ${fieldName} is using system default PublicKey`);
    }

    return new PublicKey(keyString);
  } catch (e) {
    if (e instanceof Error && e.message.includes('INVALID_PUBLICKEY')) {
      throw e;
    }
    throw new Error(`INVALID_PUBLICKEY: ${fieldName} failed to parse: ${String((e as any)?.message || e)}`);
  }
}

/**
 * Validates pool accounts exist on-chain
 * Note: This performs RPC calls, use sparingly
 * Optimized: Uses getMultipleAccountsInfo to batch RPC calls
 */
export async function validatePoolAccounts(
  poolId: string,
  vaultA?: string,
  vaultB?: string,
  context?: Record<string, unknown>
): Promise<void> {
  const connection = getConnection();
  const missing: string[] = [];

  try {
    // Batch all account checks into a single RPC call for efficiency
    const keysToCheck: PublicKey[] = [new PublicKey(poolId)];
    const keyLabels: string[] = ['pool'];
    
    if (vaultA) {
      try {
        keysToCheck.push(new PublicKey(vaultA));
        keyLabels.push('vaultA');
      } catch {
        missing.push('vaultA');
      }
    }
    
    if (vaultB) {
      try {
        keysToCheck.push(new PublicKey(vaultB));
        keyLabels.push('vaultB');
      } catch {
        missing.push('vaultB');
      }
    }

    // Batch fetch all accounts at once
    if (keysToCheck.length > 0) {
      const weight = Math.max(1, Math.ceil(keysToCheck.length / 5));
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(keysToCheck),
        weight
      ).catch(() => null);

      if (!accountInfos || accountInfos.length !== keysToCheck.length) {
        // If batch fetch failed, mark all as missing
        missing.push(...keyLabels);
      } else {
        // Check each account in order
        for (let i = 0; i < accountInfos.length; i++) {
          if (!accountInfos[i]) {
            missing.push(keyLabels[i]);
          }
        }
      }
    }

    if (missing.length > 0) {
      throw new Error(`POOL_ACCOUNTS_MISSING: ${missing.join(', ')} not found on-chain`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('POOL_ACCOUNTS_MISSING')) {
      throw e;
    }
    try {
      logger.warn('validation.pool_accounts.rpc_error', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: { poolId, error: String((e as any)?.message || e), ...context }
      });
    } catch (e) { logCatchError('builder.validation', e); }
    // Don't throw on RPC errors - validation is best-effort
  }
}


