import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

export type ExecConfig = {
  mode: 'direct' | 'simulate';
  slippageBpsDefault: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  createAtasInTx: boolean;
  dynamicCompute: boolean;
  maxTxSizeBytes?: number;
};

const file = resolve(CONFIG.cacheDir, 'exec-config.json');
let current: ExecConfig | null = null;

const defaults: ExecConfig = {
  mode: 'simulate',
  slippageBpsDefault: 50,
  computeUnitLimit: 1_000_000,
  computeUnitPriceMicroLamports: 1000,
  createAtasInTx: true,
  dynamicCompute: true,
  maxTxSizeBytes: 1200,
};

export async function loadExecConfig(): Promise<ExecConfig> {
  if (current) return current;
  try {
    const obj = await readJson<ExecConfig>(file, defaults);
    current = { ...defaults, ...(obj || {}) };
    return current;
  } catch {
    current = defaults;
    return current;
  }
}

export async function saveExecConfig(next: Partial<ExecConfig>): Promise<ExecConfig> {
  const base = current || (await loadExecConfig());
  const merged: ExecConfig = { ...base, ...next } as ExecConfig;
  current = merged;
  try { await ensureDir(resolve(file, '..')); await writeJson(file, merged); } catch {}
  return merged;
}


