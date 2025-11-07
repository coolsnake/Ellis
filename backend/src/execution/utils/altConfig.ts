import { resolve } from 'path';
import { CONFIG } from '../../utils/config.js';
import { ensureDir, readJson, writeJson } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

export type AltConfig = {
  // Categorized ALT addresses
  alts: {
    common?: string;      // Programs + common mints
    pools?: string;        // Frequently used pools
    clmm?: string;         // CLMM tick arrays
    tokens?: string;       // Additional token mints
  };
  // Metadata
  createdAt?: number;
  lastValidated?: number;
  walletPublicKey?: string; // Which wallet owns these ALTs
};

const file = resolve(CONFIG.cacheDir, 'alt-config.json');
let current: AltConfig | null = null;

const defaults: AltConfig = {
  alts: {},
};

export async function loadAltConfig(): Promise<AltConfig> {
  if (current) return current;
  try {
    const obj = await readJson<AltConfig>(file, defaults);
    current = { ...defaults, ...(obj || {}) };
    return current;
  } catch {
    current = defaults;
    return current;
  }
}

export async function saveAltConfig(config: AltConfig): Promise<void> {
  current = config;
  try {
    await ensureDir(resolve(file, '..'));
    await writeJson(file, config);
  } catch (error) {
    try {
      logger.warn('alt.config.save.failed', {
        cat: 'tx',
        ctx: { error: String((error as any)?.message || error) },
      });
    } catch {}
  }
}

export function getAltConfig(): AltConfig | null {
  return current;
}

