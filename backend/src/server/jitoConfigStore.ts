import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

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
let loadedAt = 0;
const CACHE_TTL_MS = 30000; // Refresh cache every 30 seconds

// Build defaults from CONFIG (env vars)
function getDefaults(): JitoConfig {
  const jitoCfg = (CONFIG as any)?.jito || {};
  return {
    enabled: jitoCfg.enabled !== false, // Default to true unless explicitly disabled
    tipMode: jitoCfg.tipMode || 'dynamic',
    tipShare: typeof jitoCfg.tipShare === 'number' ? jitoCfg.tipShare : 0.35,
    minTipLamports: typeof jitoCfg.minTipLamports === 'number' ? jitoCfg.minTipLamports : 10000,
    maxTipLamports: typeof jitoCfg.maxTipLamports === 'number' ? jitoCfg.maxTipLamports : 5_000_000,
    fixedTipLamports: typeof jitoCfg.fixedTipLamports === 'number' ? jitoCfg.fixedTipLamports : 10000,
  };
}

export async function loadJitoConfig(): Promise<JitoConfig> {
  const now = Date.now();
  // Return cached if fresh
  if (current && (now - loadedAt) < CACHE_TTL_MS) {
    return current;
  }
  
  try {
    const defaults = getDefaults();
    const obj = await readJson<JitoConfig>(file, defaults);
    current = { ...defaults, ...(obj || {}) };
    loadedAt = now;
    
    try {
      logger.debug('jito.config.loaded', {
        cat: 'jito',
        ctx: { 
          enabled: current.enabled,
          tipMode: current.tipMode,
          tipShare: current.tipShare,
          source: obj ? 'file' : 'defaults',
        },
      });
    } catch {}
    
    return current;
  } catch {
    current = getDefaults();
    loadedAt = now;
    return current;
  }
}

export async function saveJitoConfig(next: Partial<JitoConfig>): Promise<JitoConfig> {
  const base = current || (await loadJitoConfig());
  const merged: JitoConfig = { ...base, ...next };
  current = merged;
  loadedAt = Date.now(); // Reset cache timer on save
  
  try { 
    await ensureDir(resolve(file, '..')); 
    await writeJson(file, merged);
    
    try {
      logger.info('jito.config.saved', {
        cat: 'jito',
        ctx: { 
          enabled: merged.enabled,
          tipMode: merged.tipMode,
          tipShare: merged.tipShare,
          filePath: file,
        },
      });
    } catch {}
  } catch (err: any) {
    try {
      logger.error('jito.config.save_failed', {
        cat: 'jito',
        ctx: { error: String(err?.message || err) },
      });
    } catch {}
  }
  
  return merged;
}

export function getJitoConfigSync(): JitoConfig | null {
  return current;
}

// Force refresh the config from disk (useful after external changes)
export async function refreshJitoConfig(): Promise<JitoConfig> {
  current = null;
  loadedAt = 0;
  return loadJitoConfig();
}

