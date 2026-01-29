import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

export type ExecConfig = {
  mode: 'direct' | 'simulate' | 'jupiter' | 'simulate_then_execute';
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
  // Transaction resend settings
  resendEnabled?: boolean; // Enable resend-until-confirmed loop (default: true)
  maxResendAttempts?: number; // Max resend attempts (default: 10)
  maxConfirmTimeMs?: number; // Max time to wait for confirmation (default: 30000)
  // Dynamic CU limits (use simulation CU + buffer instead of fixed limit)
  dynamicCuLimits?: boolean;           // default: false
  dynamicCuBuffer?: number;            // buffer multiplier, default: 1.15 (15%)
  // Dynamic priority fees (use background-polled network fees)
  dynamicPriorityFees?: boolean;       // default: false
  priorityFeeUrgency?: 'low' | 'medium' | 'high' | 'critical';  // default: 'medium'
  priorityFeeRefreshMs?: number;       // polling interval, default: 10000
  priorityFeeMinFloor?: number;        // minimum fee floor in micro-lamports, default: 1000
  priorityFeeMaxCap?: number;          // maximum fee cap in micro-lamports, default: 2000000
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
  // Transaction resend settings
  resendEnabled: true, // Enable by default for better tx landing
  maxResendAttempts: 10,
  maxConfirmTimeMs: 30000,
  // Dynamic CU limits - disabled by default (use fixed computeUnitLimit)
  dynamicCuLimits: false,
  dynamicCuBuffer: 1.15,
  // Dynamic priority fees - disabled by default (use fixed computeUnitPriceMicroLamports)
  dynamicPriorityFees: false,
  priorityFeeUrgency: 'medium',
  priorityFeeRefreshMs: 10_000,
  priorityFeeMinFloor: 1_000,
  priorityFeeMaxCap: 2_000_000,
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


