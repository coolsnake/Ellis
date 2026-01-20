import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export type RpcLimiterConfig = {
  maxRps: number;      // Max requests per second
  burst: number;      // Burst capacity (0 = auto-calculate as maxRps/4)
  minGapMs: number;   // Minimum gap between requests in milliseconds
};

const file = resolve(CONFIG.cacheDir, 'rpc-limiter-config.json');
let current: RpcLimiterConfig | null = null;
let loadedAt = 0;
const CACHE_TTL_MS = 30000; // Refresh cache every 30 seconds

// Build defaults from CONFIG (env vars)
function getDefaults(): RpcLimiterConfig {
  // Check environment variables first, then CONFIG object
  const envMaxRps = process.env.RPC_MAX_RPS ? Number(process.env.RPC_MAX_RPS) : null;
  const envBurst = process.env.RPC_BURST ? Number(process.env.RPC_BURST) : null;
  const envMinGap = process.env.RPC_MIN_GAP_MS ? Number(process.env.RPC_MIN_GAP_MS) : null;
  
  return {
    maxRps: envMaxRps ?? CONFIG.rpcMaxRps ?? 50,
    burst: envBurst ?? CONFIG.rpcBurst ?? 0, // 0 means auto-calculate
    minGapMs: envMinGap ?? CONFIG.rpcMinGapMs ?? 20,
  };
}

export async function loadRpcLimiterConfig(): Promise<RpcLimiterConfig> {
  const now = Date.now();
  // Return cached if fresh
  if (current && (now - loadedAt) < CACHE_TTL_MS) {
    return current;
  }
  
  try {
    const defaults = getDefaults();
    const obj = await readJson<RpcLimiterConfig>(file, defaults);
    current = { ...defaults, ...(obj || {}) };
    loadedAt = now;
    
    try {
      logger.debug('rpc-limiter.config.loaded', {
        cat: 'rpc',
        ctx: { 
          maxRps: current.maxRps,
          burst: current.burst,
          minGapMs: current.minGapMs,
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

export async function saveRpcLimiterConfig(next: Partial<RpcLimiterConfig>): Promise<RpcLimiterConfig> {
  const base = current || (await loadRpcLimiterConfig());
  const merged: RpcLimiterConfig = { ...base, ...next };
  current = merged;
  loadedAt = Date.now(); // Reset cache timer on save
  
  try { 
    await ensureDir(resolve(file, '..')); 
    await writeJson(file, merged);
    
    try {
      logger.info('rpc-limiter.config.saved', {
        cat: 'rpc',
        ctx: { 
          maxRps: merged.maxRps,
          burst: merged.burst,
          minGapMs: merged.minGapMs,
          filePath: file,
        },
      });
    } catch {}
  } catch (err: any) {
    try {
      logger.error('rpc-limiter.config.save_failed', {
        cat: 'rpc',
        ctx: { error: String(err?.message || err) },
      });
    } catch {}
  }
  
  return merged;
}

export function getRpcLimiterConfigSync(): RpcLimiterConfig | null {
  return current;
}

// Force refresh the config from disk (useful after external changes)
export async function refreshRpcLimiterConfig(): Promise<RpcLimiterConfig> {
  current = null;
  loadedAt = 0;
  return loadRpcLimiterConfig();
}
