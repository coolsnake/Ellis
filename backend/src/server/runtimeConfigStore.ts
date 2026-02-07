/**
 * Runtime config store – persists UI-set values (Jupiter API key, etc.)
 * so they survive server restarts. Same pattern as rpcLimiterConfigStore.
 */

import { resolve } from 'path';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export type RuntimeConfig = {
  jupiterApiKey?: string;
};

const CONFIG_DIR = process.env.CONFIG_DIR || resolve(process.cwd(), 'backend', 'config');
const file = resolve(CONFIG_DIR, 'runtime-config.json');

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const obj = await readJson<RuntimeConfig>(file, {});
    if (obj && (obj.jupiterApiKey != null && obj.jupiterApiKey !== '')) {
      try {
        logger.debug('runtime-config.loaded', { hasJupiterApiKey: true, cat: 'server' });
      } catch {}
    }
    return obj || {};
  } catch {
    return {};
  }
}

/**
 * Merge persisted runtime config into CONFIG (call once at startup).
 */
export async function applyRuntimeConfigToConfig(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  if (runtime.jupiterApiKey != null && runtime.jupiterApiKey !== '') {
    if (!(CONFIG as any).system) (CONFIG as any).system = {};
    if (!(CONFIG as any).system.jupiterTopTokens) (CONFIG as any).system.jupiterTopTokens = {};
    (CONFIG as any).system.jupiterTopTokens.apiKey = String(runtime.jupiterApiKey);
    if (!(CONFIG as any).discovery) (CONFIG as any).discovery = {};
    (CONFIG as any).discovery.jupiterApiKey = String(runtime.jupiterApiKey);
    try {
      logger.info('runtime-config.applied', { jupiterApiKey: true, cat: 'server' });
    } catch {}
  }
}

/**
 * Save runtime config (merge with existing file).
 */
export async function saveRuntimeConfig(updates: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  const current = await loadRuntimeConfig();
  const merged: RuntimeConfig = { ...current, ...updates };
  try {
    await ensureDir(resolve(file, '..'));
    await writeJson(file, merged);
    try {
      logger.info('runtime-config.saved', {
        keys: Object.keys(updates),
        cat: 'server',
      });
    } catch {}
  } catch (err: any) {
    try {
      logger.error('runtime-config.save_failed', { error: String(err?.message || err), cat: 'server' });
    } catch {}
  }
  return merged;
}
