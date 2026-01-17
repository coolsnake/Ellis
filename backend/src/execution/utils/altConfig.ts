import { resolve } from 'path';
import { CONFIG } from '../../utils/config.js';
import { ensureDir, readJson, writeJson } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

/**
 * DEX-specific ALT set for tracking multiple ALTs per DEX
 */
export type DexAltSet = {
  /** Array of ALT addresses for this DEX */
  addresses: string[];
  /** Which pools are in each ALT (ALT address -> pool IDs) */
  altContents: Record<string, string[]>;
  /** Total pools tracked across all ALTs for this DEX */
  totalPools: number;
  /** Total accounts across all ALTs for this DEX */
  totalAccounts: number;
};

export type AltConfig = {
  // Static ALTs (rarely change)
  alts: {
    common?: string;      // Programs, sysvars, common mints
    flashloan?: string;   // Vault PDAs and vault token accounts
    userPdas?: string;    // Wallet ATAs for common mints
    // Legacy fields for backward compatibility
    pools?: string;       // Frequently used pools (legacy)
    clmm?: string;        // CLMM tick arrays (legacy)
    tokens?: string;      // Additional token mints (legacy)
  };

  // DEX-specific ALTs (multiple per DEX)
  dexAlts?: {
    raydium?: DexAltSet;
    'raydium-amm'?: DexAltSet;
    'raydium-cpmm'?: DexAltSet;
    orca?: DexAltSet;
    meteora?: DexAltSet;
    'meteora-balanced'?: DexAltSet;
    'meteora-damm-v1'?: DexAltSet;
    'meteora-damm-v2'?: DexAltSet;
    pumpswap?: DexAltSet;
  };

  // Reverse lookup: poolId -> ALT address (O(1) lookup)
  poolToAlt?: Record<string, string>;

  // Metadata
  createdAt?: number;
  lastValidated?: number;
  walletPublicKey?: string; // Which wallet owns these ALTs
};

const file = resolve(CONFIG.cacheDir, 'alt-config.json');
let current: AltConfig | null = null;

const defaults: AltConfig = {
  alts: {},
  dexAlts: {},
  poolToAlt: {},
};

/**
 * Migrate old config format to new format if needed
 */
function migrateConfig(config: AltConfig): AltConfig {
  // Ensure new fields exist
  if (!config.dexAlts) {
    config.dexAlts = {};
  }
  if (!config.poolToAlt) {
    config.poolToAlt = {};
  }
  return config;
}

export async function loadAltConfig(): Promise<AltConfig> {
  if (current) return current;
  try {
    const obj = await readJson<AltConfig>(file, defaults);
    current = migrateConfig({ ...defaults, ...(obj || {}) });
    return current;
  } catch {
    current = { ...defaults };
    return current;
  }
}

export async function saveAltConfig(config: AltConfig): Promise<void> {
  current = migrateConfig(config);
  try {
    await ensureDir(resolve(file, '..'));
    await writeJson(file, current);
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

/**
 * Update the pool-to-ALT mapping for a single pool
 */
export async function updatePoolToAlt(poolId: string, altAddress: string): Promise<void> {
  const config = await loadAltConfig();
  if (!config.poolToAlt) {
    config.poolToAlt = {};
  }
  // Strip directional suffixes for consistent lookup
  const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
  config.poolToAlt[cleanPoolId] = altAddress;
  await saveAltConfig(config);
}

/**
 * Update pool-to-ALT mapping for multiple pools
 */
export async function updatePoolToAltBatch(mappings: Record<string, string>): Promise<void> {
  const config = await loadAltConfig();
  if (!config.poolToAlt) {
    config.poolToAlt = {};
  }
  for (const [poolId, altAddress] of Object.entries(mappings)) {
    const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
    config.poolToAlt[cleanPoolId] = altAddress;
  }
  await saveAltConfig(config);
}

/**
 * Get ALT address for a pool (O(1) lookup)
 */
export function getAltForPool(poolId: string): string | undefined {
  if (!current?.poolToAlt) return undefined;
  const cleanPoolId = poolId.replace(/[#-](rev|fwd)$/, '');
  return current.poolToAlt[cleanPoolId];
}

/**
 * Update DEX ALT set configuration
 */
export async function updateDexAltSet(
  dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap',
  altSet: DexAltSet
): Promise<void> {
  const config = await loadAltConfig();
  if (!config.dexAlts) {
    config.dexAlts = {};
  }
  config.dexAlts[dex] = altSet;
  await saveAltConfig(config);
}

/**
 * Get DEX ALT set
 */
export function getDexAltSet(dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-balanced' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'pumpswap'): DexAltSet | undefined {
  return current?.dexAlts?.[dex];
}
