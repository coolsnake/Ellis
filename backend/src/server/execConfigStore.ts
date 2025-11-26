import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

export type ExecConfig = {
  mode: 'direct' | 'simulate' | 'jupiter';
  slippageBpsDefault: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  createAtasInTx: boolean;
  dynamicCompute: boolean;
  maxTxSizeBytes?: number;
  // New: optionally wrap/unwrap SOL inside tx where needed
  wrapSolInTx?: boolean;
  // New: optional Address Lookup Tables to include when assembling
  lookupTableAddresses?: string[];
};

const file = resolve(CONFIG.cacheDir, 'exec-config.json');
let current: ExecConfig | null = null;

const defaults: ExecConfig = {
  mode: 'simulate',
  slippageBpsDefault: 50,
  computeUnitLimit: 1_000_000,
  computeUnitPriceMicroLamports: 500_000, // 500k µLamports - much better tx landing rate
  createAtasInTx: true,
  dynamicCompute: true,
  maxTxSizeBytes: 0,
  wrapSolInTx: true,
  // ALT addresses are now managed via altConfig.json and DexAltManager
  lookupTableAddresses: [],
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


