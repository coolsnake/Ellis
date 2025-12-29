import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';

interface ActivityResult {
  active: boolean;
  lastActivityMs: number | null;
  error?: string;
}

/**
 * Check if a pool has had any on-chain activity within the specified time window
 * @param poolId - Pool account address (base58 string)
 * @param maxInactiveMs - Maximum milliseconds since last activity (default: 12 hours)
 * @param checkSuccess - Whether to filter for successful transactions only (default: true)
 * @returns Activity result with active status and last activity timestamp
 */
export async function checkPoolActivity(
  poolId: string,
  maxInactiveMs: number = 12 * 60 * 60 * 1000, // 12 hours default
  checkSuccess: boolean = true
): Promise<ActivityResult> {
  const connection = getConnection();
  
  try {
    const poolPubkey = new PublicKey(poolId);
    
    // Get recent transaction signatures for this pool
    // Fetch more if checking success, since some may have failed
    const signatureLimit = checkSuccess ? 10 : 1;
    const signatures = await withRpcLimit(
      () => connection.getSignaturesForAddress(
        poolPubkey,
        { limit: signatureLimit },
        'confirmed'
      ),
      1,
      { module: 'pools', method: 'getSignaturesForAddress' }
    );
    
    if (!signatures || signatures.length === 0) {
      return {
        active: false,
        lastActivityMs: null,
      };
    }
    
    // Find the most recent successful transaction
    // getSignaturesForAddress returns err field: null means success, non-null means failed
    let mostRecent = signatures[0];
    
    if (checkSuccess) {
      const successfulSig = signatures.find(sig => sig.err === null && sig.blockTime);
      if (!successfulSig) {
        // No successful transactions found in the batch
        return {
          active: false,
          lastActivityMs: null,
          error: 'no_successful_transactions_found',
        };
      }
      mostRecent = successfulSig;
    }
    
    // If blockTime is null, we can't determine activity
    if (!mostRecent.blockTime) {
      return {
        active: false,
        lastActivityMs: null,
        error: 'blockTime_not_available',
      };
    }
    
    // Convert blockTime from seconds to milliseconds
    const lastActivityMs = mostRecent.blockTime * 1000;
    const now = Date.now();
    const age = now - lastActivityMs;
    
    return {
      active: age <= maxInactiveMs,
      lastActivityMs,
    };
  } catch (error: any) {
    // If we can't check (e.g., invalid address, RPC error), assume inactive to be safe
    return {
      active: false,
      lastActivityMs: null,
      error: String(error?.message || error),
    };
  }
}

/**
 * Batch check activity for multiple pools with rate limiting
 * @param poolIds - Array of pool account addresses
 * @param maxInactiveMs - Maximum milliseconds since last activity
 * @param batchSize - Number of pools to check concurrently (default: 10)
 * @param delayBetweenBatches - Delay in ms between batches (default: 100)
 * @returns Map of poolId -> ActivityResult
 */
export async function checkPoolsActivityBatch(
  poolIds: string[],
  maxInactiveMs: number = 12 * 60 * 60 * 1000,
  batchSize: number = 10,
  delayBetweenBatches: number = 100
): Promise<Map<string, ActivityResult>> {
  const results = new Map<string, ActivityResult>();
  
  if (poolIds.length === 0) {
    return results;
  }
  
  logger.info('pools.activity_check.batch_start', {
    totalPools: poolIds.length,
    maxInactiveMs,
    batchSize,
    cat: 'pools',
  });
  
  const startTime = Date.now();
  let checked = 0;
  let active = 0;
  let inactive = 0;
  let errors = 0;
  
  // Process in batches to avoid overwhelming RPC
  for (let i = 0; i < poolIds.length; i += batchSize) {
    const batch = poolIds.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (poolId) => {
      const result = await checkPoolActivity(poolId, maxInactiveMs);
      results.set(poolId, result);
      
      checked++;
      if (result.active) {
        active++;
      } else {
        inactive++;
      }
      if (result.error) {
        errors++;
      }
      
      // Log progress every 50 pools
      if (checked % 50 === 0) {
        logger.debug('pools.activity_check.progress', {
          checked,
          total: poolIds.length,
          active,
          inactive,
          errors,
          cat: 'pools',
        });
      }
    });
    
    await Promise.all(batchPromises);
    
    // Small delay between batches to avoid rate limiting
    if (i + batchSize < poolIds.length && delayBetweenBatches > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }
  
  const duration = Date.now() - startTime;
  
  logger.info('pools.activity_check.batch_complete', {
    total: poolIds.length,
    checked,
    active,
    inactive,
    errors,
    durationMs: duration,
    avgMsPerPool: checked > 0 ? Math.round(duration / checked) : 0,
    cat: 'pools',
  });
  
  return results;
}

