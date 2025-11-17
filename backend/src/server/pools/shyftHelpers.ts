import { CONFIG } from '../../utils/config.js';

/**
 * Get Shyft API key for a specific DEX with fallback chain
 * Priority: DEX-specific key → Pumpswap key → Global Shyft key
 */
export function getShyftApiKey(dex: 'raydium' | 'orca' | 'meteora' | 'pumpswap'): string {
  // Try DEX-specific key first
  const dexKey = (CONFIG as any)?.[dex]?.shyftApiKey;
  if (dexKey) return dexKey;
  
  // Fall back to pumpswap key (per user's choice 4c - use existing Pumpswap key for all DEXs initially)
  const pumpswapKey = (CONFIG as any)?.pumpswap?.shyftApiKey;
  if (pumpswapKey) return pumpswapKey;
  
  // Fall back to global key
  const globalKey = (CONFIG as any)?.shyft?.apiKey;
  if (globalKey) return globalKey;
  
  return '';
}

/**
 * Get Shyft endpoint URL
 */
export function getShyftEndpoint(): string {
  return (CONFIG as any)?.shyft?.endpoint || 'https://programs.shyft.to/v0/graphql';
}

/**
 * Get Shyft network
 */
export function getShyftNetwork(): 'mainnet-beta' | 'devnet' {
  return (CONFIG as any)?.shyft?.network || 'mainnet-beta';
}

