import { Connection, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { getConnection } from '../../utils/connection.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { logger } from '../../utils/logger.js';

/**
 * Measures compute units consumed by a set of instructions via simulation
 * Returns the measured compute units with a safety buffer
 */
export async function measureComputeUnits(
  instructions: TransactionInstruction[],
  lookupTableAddresses: string[] = [],
  bufferMultiplier: number = 1.2
): Promise<number> {
  if (instructions.length === 0) {
    return 0;
  }

  try {
    const connection = getConnection();
    const { blockhash } = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
    
    // Load lookup tables if provided
    const lookupTables = lookupTableAddresses.length > 0
      ? await loadLookupTables(connection, lookupTableAddresses)
      : [];

    // Create a test transaction without compute budget instructions
    // (we want to measure the actual compute, not the limit)
    const msg = new TransactionMessage({
      payerKey: PublicKey.default, // Dummy payer for simulation
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    
    const tx = new VersionedTransaction(msg);
    
    // Simulate without signature verification for speed
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (sim.value?.err) {
      // If simulation fails, return a conservative estimate
      try {
        logger.warn('compute.units.measure.failed', {
          cat: 'tx',
          ctx: {
            error: sim.value.err,
            instructionCount: instructions.length,
            fallback: 200000,
          },
        });
      } catch {}
      return 200000; // Conservative fallback
    }

    const unitsConsumed = sim.value?.unitsConsumed || 0;
    const measured = Math.ceil(unitsConsumed * bufferMultiplier);
    
    // Ensure minimum of 1 CU and reasonable maximum
    const result = Math.max(1, Math.min(measured, 1400000)); // Max CU limit on Solana
    
    try {
      logger.debug('compute.units.measured', {
        cat: 'tx',
        ctx: {
          consumed: unitsConsumed,
          measured: result,
          buffer: bufferMultiplier,
          instructionCount: instructions.length,
        },
      });
    } catch {}

    return result;
  } catch (error) {
    try {
      logger.warn('compute.units.measure.error', {
        cat: 'tx',
        ctx: {
          error: String((error as any)?.message || error),
          instructionCount: instructions.length,
          fallback: 200000,
        },
      });
    } catch {}
    // Return conservative estimate on error
    return 200000;
  }
}

/**
 * Estimates compute units based on transaction characteristics
 * Used as a fallback when simulation is not available
 */
export function estimateComputeUnits(
  instructionCount: number,
  isMultiHop: boolean,
  dexTypes: string[]
): number {
  // Base compute per instruction
  const basePerIx = 5000;
  
  // Additional compute for DEX-specific operations
  let dexMultiplier = 1.0;
  if (dexTypes.includes('raydium') && dexTypes.includes('clmm')) {
    dexMultiplier = 1.5; // CLMM is more compute-intensive
  } else if (dexTypes.includes('orca')) {
    dexMultiplier = 1.3;
  } else if (dexTypes.includes('meteora')) {
    dexMultiplier = 1.2;
  }
  
  // Multi-hop penalty
  const hopMultiplier = isMultiHop ? 1.4 : 1.0;
  
  const estimated = Math.ceil(instructionCount * basePerIx * dexMultiplier * hopMultiplier);
  
  // Add buffer and cap
  const result = Math.min(Math.ceil(estimated * 1.3), 1400000);
  
  return Math.max(50000, result); // Minimum 50k, max 1.4M
}

async function loadLookupTables(connection: Connection, addrs: string[]): Promise<any[]> {
  const out: any[] = [];
  for (const a of addrs) {
    try {
      const pk = new PublicKey(a);
      const acc = await connection.getAddressLookupTable(pk).then(r => r.value).catch(() => null);
      if (acc) out.push(acc);
    } catch {}
  }
  return out;
}

