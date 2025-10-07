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
  status: 'sim_ok' | 'send_ok' | 'send_err' | 'sim_err';
  error?: string;
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


