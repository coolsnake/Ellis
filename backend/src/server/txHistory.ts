import { joinPath } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export type TxRecord = {
  id: string;
  timeMs: number;
  path: string[];
  hops: Array<{ dex: string; variant: string; poolId: string }>;
  ixCount: number;
  txSizeBytes: number;
  signature?: string | null;
  status: 'sim_ok' | 'send_ok' | 'send_err' | 'sim_err' | 'confirmed' | 'confirmed_ok' | 'confirmed_err';
  error?: string;
  confirmedAt?: number;
  confirmationSlot?: number;
  skipSimulation?: boolean;
  logFile?: string; // Filename of execution log dump for linking
  // Skip simulation feedback context
  sizeUsd?: number;           // Trade size for capacity feedback calculation
  expectedProfitBps?: number; // Expected profit for slippage delta estimation
  // Actual profit from confirmed transaction (calculated from on-chain logs)
  actualProfitUsd?: number;   // Real profit in USD from transaction execution
  actualProfitRaw?: string;   // Raw profit in base token units (for debugging)
};

/**
 * Fetch transaction logs from chain and calculate actual profit in USD.
 * 
 * @param signature - Transaction signature
 * @param baseMint - The base token mint (first token in arb cycle path)
 * @returns Object with actualProfitUsd and actualProfitRaw, or null if calculation failed
 */
async function calculateActualProfit(
  signature: string,
  baseMint: string
): Promise<{ actualProfitUsd: number; actualProfitRaw: string } | null> {
  try {
    const { getConnection } = await import('../wallet/wallet.js');
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    const { parseSimulationLogs } = await import('../execution/simLogParser.js');
    const { getPriceByMint } = await import('./priceStore.js');
    const { loadJupiterTokenMap } = await import('../utils/tokens.js');
    
    const connection = getConnection();
    
    // Fetch transaction with logs
    const tx = await withRpcLimit(
      () => connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
      1,
      { module: 'txHistory', method: 'getTransaction' }
    );
    
    if (!tx?.meta?.logMessages) {
      logger.info('txHistory.actualProfit.no_logs', {
        signature,
        cat: 'notifications',
      });
      return null;
    }
    
    logger.info('txHistory.actualProfit.parsing', {
      signature,
      logCount: tx.meta.logMessages.length,
      cat: 'notifications',
    });
    
    // Parse the transaction logs to extract profit value
    const analysis = parseSimulationLogs(tx.meta.logMessages, tx.meta.err);
    
    if (analysis.profitValue === undefined) {
      // Log some of the actual logs to help debug pattern matching
      const relevantLogs = tx.meta.logMessages.filter(log => 
        log.includes('Profit') || log.includes('executed') || log.includes('Route')
      );
      logger.info('txHistory.actualProfit.no_profit_value', {
        signature,
        hasLogs: tx.meta.logMessages.length,
        relevantLogs: relevantLogs.slice(0, 5),
        cat: 'notifications',
      });
      return null;
    }
    
    // profitValue is in raw token units (lamports for SOL, etc.)
    const profitRaw = analysis.profitValue;
    
    // Get decimals for base token
    const jupMap = await loadJupiterTokenMap();
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    let decimals: number;
    if (baseMint === SOL_MINT) {
      decimals = 9;
    } else if (jupMap[baseMint]?.decimals !== undefined) {
      decimals = jupMap[baseMint].decimals;
    } else {
      // Default to 6 for stablecoins, 9 for others
      decimals = baseMint.startsWith('EPjFWdd5') || baseMint.startsWith('Es9vMFrz') ? 6 : 9;
    }
    
    // Convert raw profit to human-readable amount
    const profitAmount = Number(profitRaw) / Math.pow(10, decimals);
    
    // Get current USD price for the base token
    const priceData = getPriceByMint(baseMint);
    const usdPrice = priceData?.usdc ?? 0;
    
    if (usdPrice <= 0) {
      logger.info('txHistory.actualProfit.no_price', {
        signature,
        baseMint: baseMint.slice(0, 8),
        profitRaw: profitRaw.toString(),
        cat: 'notifications',
      });
      // Return raw profit without USD conversion
      return {
        actualProfitUsd: 0,
        actualProfitRaw: profitRaw.toString(),
      };
    }
    
    const actualProfitUsd = profitAmount * usdPrice;
    
    logger.info('txHistory.actualProfit.calculated', {
      signature,
      baseMint: baseMint.slice(0, 8),
      profitRaw: profitRaw.toString(),
      profitAmount: profitAmount.toFixed(6),
      usdPrice: usdPrice.toFixed(4),
      actualProfitUsd: actualProfitUsd.toFixed(4),
      decimals,
      cat: 'notifications',
    });
    
    return {
      actualProfitUsd,
      actualProfitRaw: profitRaw.toString(),
    };
  } catch (e: any) {
    logger.warn('txHistory.actualProfit.error', {
      signature,
      baseMint,
      error: String(e?.message || e),
      cat: 'notifications',
    });
    return null;
  }
}

const capacity = 200;
const items: TxRecord[] = [];
const filePath = joinPath(CONFIG.cacheDir, 'tx-history.json');

export async function addTxRecord(rec: TxRecord): Promise<void> {
  items.unshift(rec);
  if (items.length > capacity) items.pop();
  try { await ensureDir(joinPath(filePath, '..')); await writeJson(filePath, { items }); } catch {}
}

export async function getTxHistory(limit = 50): Promise<TxRecord[]> {
  if (items.length > 0) return items.slice(0, Math.max(1, Math.min(limit, capacity)));
  try {
    const saved = await readJson(filePath, { items: [] as TxRecord[] });
    if (Array.isArray(saved?.items)) {
      for (const it of saved.items.slice().reverse()) {
        items.unshift(it);
        if (items.length > capacity) items.pop();
      }
    }
  } catch {}
  return items.slice(0, Math.max(1, Math.min(limit, capacity)));
}

// Check and update transaction confirmation status
export async function checkTxConfirmation(signature: string): Promise<{ confirmed: boolean; success?: boolean; slot?: number; error?: string }> {
  try {
    const { getConnection } = await import('../wallet/wallet.js');
    const connection = getConnection();
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    const response = await withRpcLimit(
      () => connection.getSignatureStatus(signature, { searchTransactionHistory: true }),
      1,
      { module: 'server', method: 'getSignatureStatus' }
    );
    if (!response || !response.value) return { confirmed: false };
    
    const status = response.value;
    const confirmed = status.confirmationStatus !== null && status.confirmationStatus !== undefined;
    const success = status.err === null || status.err === undefined;
    return {
      confirmed,
      success: confirmed ? success : undefined,
      slot: status.slot || undefined,
      error: status.err ? (typeof status.err === 'string' ? status.err : JSON.stringify(status.err)) : undefined,
    };
  } catch (e: any) {
    return { confirmed: false, error: String(e?.message || e) };
  }
}

// Update transaction record with confirmation status
export async function updateTxConfirmation(
  signature: string, 
  confirmed: boolean, 
  success?: boolean, 
  slot?: number, 
  error?: string,
  actualProfitUsd?: number,
  actualProfitRaw?: string
): Promise<void> {
  const idx = items.findIndex((r) => r.signature === signature);
  if (idx === -1) return;
  
  const rec = items[idx];
  const newStatus = confirmed 
    ? (success ? 'confirmed_ok' : 'confirmed_err')
    : 'confirmed';
  
  items[idx] = {
    ...rec,
    status: newStatus,
    confirmedAt: confirmed ? Date.now() : undefined,
    confirmationSlot: slot,
    error: error || rec.error,
    // Include actual profit from transaction execution
    actualProfitUsd: actualProfitUsd ?? rec.actualProfitUsd,
    actualProfitRaw: actualProfitRaw ?? rec.actualProfitRaw,
  };
  
  try {
    await ensureDir(joinPath(filePath, '..'));
    await writeJson(filePath, { items });
  } catch {}
}

// Start background task to check pending transactions
let confirmationTaskRunning = false;
export async function startTxConfirmationTask(io?: any): Promise<void> {
  if (confirmationTaskRunning) return;
  confirmationTaskRunning = true;
  
  const { emit } = await import('./realtime.js');
  
  setInterval(async () => {
    try {
      const pending = items.filter((r) => 
        r.signature && 
        r.status === 'send_ok' && 
        !r.confirmedAt &&
        (Date.now() - r.timeMs) < 120_000 // Only check transactions from last 2 minutes
      );
      
      if (pending.length === 0) return;
      
      for (const rec of pending.slice(0, 10)) { // Check up to 10 at a time
        if (!rec.signature) continue;
        const result = await checkTxConfirmation(rec.signature);
        if (result.confirmed) {
          // Calculate actual profit from on-chain transaction logs for successful txs
          let actualProfitData: { actualProfitUsd: number; actualProfitRaw: string } | null = null;
          if (result.success && rec.path && rec.path.length > 0) {
            try {
              logger.info('txHistory.confirmation.calculating_profit', {
                traceId: rec.id,
                txId: rec.id,
                signature: rec.signature,
                baseMint: rec.path[0].slice(0, 8),
                cat: 'notifications',
              });
              actualProfitData = await calculateActualProfit(rec.signature, rec.path[0]);
              logger.info('txHistory.confirmation.profit_result', {
                traceId: rec.id,
                txId: rec.id,
                signature: rec.signature,
                hasActualProfit: !!actualProfitData,
                actualProfitUsd: actualProfitData?.actualProfitUsd,
                actualProfitRaw: actualProfitData?.actualProfitRaw,
                sizeUsd: rec.sizeUsd,
                expectedProfitBps: rec.expectedProfitBps,
                cat: 'notifications',
              });
            } catch (profitErr: any) {
              logger.warn('txHistory.confirmation.profit_error', {
                traceId: rec.id,
                txId: rec.id,
                signature: rec.signature,
                error: String(profitErr?.message || profitErr),
                cat: 'notifications',
              });
              // Don't let profit calculation failure block confirmation
            }
          }
          
          await updateTxConfirmation(
            rec.signature, 
            true, 
            result.success, 
            result.slot, 
            result.error,
            actualProfitData?.actualProfitUsd,
            actualProfitData?.actualProfitRaw
          );
          
          try {
            emit('tx:history.updated', { 
              id: rec.id, 
              status: result.success ? 'confirmed_ok' : 'confirmed_err',
              signature: rec.signature,
              actualProfitUsd: actualProfitData?.actualProfitUsd,
            });
          } catch {}
          
          // Send push notification for successful arb confirmations
          if (result.success) {
            try {
              const { sendArbNotification } = await import('../notifications/push.js');
              // Get the updated record with confirmedAt and actualProfitUsd set
              const updatedRec = items.find(r => r.signature === rec.signature);
              if (updatedRec) {
                await sendArbNotification(updatedRec);
              }
            } catch {
              // Don't let notification failure block confirmation flow
            }
          }
          
          // Process skip simulation feedback for learning
          if (rec.skipSimulation) {
            try {
              const { processSkipSimConfirmation } = await import('../execution/skipSimFeedback.js');
              await processSkipSimConfirmation(rec, result.success ?? false, result.error);
            } catch (feedbackErr) {
              // Don't let feedback processing block confirmation updates
            }
          }
        }
      }
    } catch {}
  }, 5000); // Check every 5 seconds
}


