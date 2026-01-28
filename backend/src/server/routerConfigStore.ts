/**
 * Router configuration store
 * Persists router program deployment info and execution settings
 */

import { resolve } from 'path';
import { Connection } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { RouterConfig, DEFAULT_ROUTER_CONFIG, ExecutionMode } from '../router/types.js';

const CONFIG_FILE = resolve(CONFIG.cacheDir || './cache', 'router.json');
let current: RouterConfig | null = null;

/**
 * Load router configuration from disk
 */
export async function loadRouterConfig(): Promise<RouterConfig> {
  if (current) return current;
  
  try {
    const obj = await readJson<RouterConfig>(CONFIG_FILE, DEFAULT_ROUTER_CONFIG);
    current = { ...DEFAULT_ROUTER_CONFIG, ...(obj || {}) };
    return current;
  } catch {
    current = { ...DEFAULT_ROUTER_CONFIG };
    return current;
  }
}

/**
 * Save router configuration to disk
 */
export async function saveRouterConfig(next: Partial<RouterConfig>): Promise<RouterConfig> {
  const base = current || (await loadRouterConfig());
  const merged: RouterConfig = { ...base, ...next };
  current = merged;
  
  try {
    await ensureDir(resolve(CONFIG_FILE, '..'));
    await writeJson(CONFIG_FILE, merged);
  } catch (err) {
    // Log but don't throw - config will still work in memory
    console.error('Failed to save router config:', err);
  }
  
  return merged;
}

/**
 * Get current router config (cached)
 */
export function getRouterConfig(): RouterConfig | null {
  return current;
}

/**
 * Clear cached config (forces reload on next access)
 */
export function clearRouterConfigCache(): void {
  current = null;
}

/**
 * Update program ID after deployment
 */
export async function setDeployedProgramId(
  programId: string,
  cluster: 'devnet' | 'mainnet-beta' | 'localnet'
): Promise<RouterConfig> {
  return saveRouterConfig({
    programId,
    deployedAt: new Date().toISOString(),
    cluster,
    enabled: true,
  });
}

/**
 * Update execution mode
 */
export async function setExecutionMode(mode: ExecutionMode): Promise<RouterConfig> {
  return saveRouterConfig({ executionMode: mode });
}

/**
 * Update vault owner for flash loans
 */
export async function setVaultOwner(vaultOwner: string): Promise<RouterConfig> {
  return saveRouterConfig({ vaultOwner });
}

/**
 * Enable or disable router
 */
export async function setRouterEnabled(enabled: boolean): Promise<RouterConfig> {
  return saveRouterConfig({ enabled });
}

/**
 * Configure WSOL mode settings
 * @param usePreWrappedWsol If true, use existing WSOL balance instead of wrapping fresh SOL
 * @param keepWsolAfterExecution If true, don't unwrap WSOL to native SOL after execution
 */
export async function setWsolMode(
  usePreWrappedWsol: boolean,
  keepWsolAfterExecution: boolean
): Promise<RouterConfig> {
  return saveRouterConfig({ usePreWrappedWsol, keepWsolAfterExecution });
}

/**
 * Set instruction mode for execute instructions
 * @param instructionMode - 'auto' | 'standard' | 'compact_v2'
 */
export async function setInstructionMode(
  instructionMode: 'auto' | 'standard' | 'compact_v2'
): Promise<RouterConfig> {
  return saveRouterConfig({ instructionMode });
}

/**
 * Check if router is configured and enabled
 */
export async function isRouterReady(): Promise<boolean> {
  const config = await loadRouterConfig();
  return !!(config.enabled && config.programId);
}

/**
 * Check if flash loan mode is available
 */
export async function isFlashLoanAvailable(): Promise<boolean> {
  const config = await loadRouterConfig();
  return !!(
    config.enabled &&
    config.programId &&
    config.vaultOwner &&
    (config.executionMode === ExecutionMode.FlashLoan || config.executionMode === ExecutionMode.Auto)
  );
}

/**
 * Get RPC URL for the router's configured cluster
 * Uses Helius devnet/mainnet endpoints with the existing API key
 */
export function getRouterRpcUrl(cluster?: 'devnet' | 'mainnet-beta' | 'localnet'): string {
  const clusterToUse = cluster || current?.cluster || 'mainnet-beta';
  
  // Extract API key from main RPC URL
  const mainRpcUrl = CONFIG.rpcUrl || '';
  const apiKeyMatch = mainRpcUrl.match(/api-key=([^&#]+)/i);
  const apiKey = apiKeyMatch?.[1] || '';
  
  switch (clusterToUse) {
    case 'devnet':
      return apiKey 
        ? `https://devnet.helius-rpc.com/?api-key=${apiKey}`
        : 'https://api.devnet.solana.com';
    case 'mainnet-beta':
      return mainRpcUrl || 'https://api.mainnet-beta.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
    default:
      return 'https://api.mainnet-beta.solana.com';
  }
}

/**
 * Get a Connection for the router's configured cluster
 * This uses the appropriate RPC endpoint based on the stored cluster setting
 */
export function getRouterConnection(cluster?: 'devnet' | 'mainnet-beta' | 'localnet'): Connection {
  const url = getRouterRpcUrl(cluster);
  return new Connection(url, { commitment: 'confirmed' });
}

