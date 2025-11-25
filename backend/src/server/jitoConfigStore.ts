import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';

export type JitoConfig = {
  enabled: boolean;
  tipMode: 'fixed' | 'dynamic';
  tipShare: number;         // 0.0-1.0, portion of profit to tip
  minTipLamports: number;   // Minimum tip floor
  maxTipLamports: number;   // Maximum tip cap
  fixedTipLamports: number; // Fixed tip amount if tipMode='fixed'
};

const file = resolve(CONFIG.cacheDir, 'jito-config.json');
let current: JitoConfig | null = null;

// Build defaults from CONFIG (env vars)
function getDefaults(): JitoConfig {
  const jitoCfg = (CONFIG as any)?.jito || {};
  return {
    enabled: jitoCfg.enabled !== false,
    tipMode: jitoCfg.tipMode || 'dynamic',
    tipShare: typeof jitoCfg.tipShare === 'number' ? jitoCfg.tipShare : 0.35,
    minTipLamports: typeof jitoCfg.minTipLamports === 'number' ? jitoCfg.minTipLamports : 10000,
    maxTipLamports: typeof jitoCfg.maxTipLamports === 'number' ? jitoCfg.maxTipLamports : 5_000_000,
    fixedTipLamports: typeof jitoCfg.fixedTipLamports === 'number' ? jitoCfg.fixedTipLamports : 10000,
  };
}

export async function loadJitoConfig(): Promise<JitoConfig> {
  if (current) return current;
  try {
    const defaults = getDefaults();
    const obj = await readJson<JitoConfig>(file, defaults);
    current = { ...defaults, ...(obj || {}) };
    return current;
  } catch {
    current = getDefaults();
    return current;
  }
}

export async function saveJitoConfig(next: Partial<JitoConfig>): Promise<JitoConfig> {
  const base = current || (await loadJitoConfig());
  const merged: JitoConfig = { ...base, ...next };
  current = merged;
  try { 
    await ensureDir(resolve(file, '..')); 
    await writeJson(file, merged); 
  } catch {}
  return merged;
}

export function getJitoConfigSync(): JitoConfig | null {
  return current;
}

