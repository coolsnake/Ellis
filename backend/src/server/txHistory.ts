import { joinPath } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

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
};

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
export async function updateTxConfirmation(signature: string, confirmed: boolean, success?: boolean, slot?: number, error?: string): Promise<void> {
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
          await updateTxConfirmation(rec.signature, true, result.success, result.slot, result.error);
          try {
            emit('tx:history.updated', { 
              id: rec.id, 
              status: result.success ? 'confirmed_ok' : 'confirmed_err',
              signature: rec.signature,
            });
          } catch {}
        }
      }
    } catch {}
  }, 5000); // Check every 5 seconds
}


