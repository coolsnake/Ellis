import { executionCache } from '../cache.js';

export async function getTokenMeta(mint: string): Promise<{ decimals: number; program: 'spl-token'|'token-2022' }> {
  const cached = executionCache.getTokenMeta(mint);
  if (cached) return cached;
  // Placeholder: assume SPL and 9 decimals when unknown; real impl should query chain/token map
  const meta = { decimals: 9, program: 'spl-token' as const };
  executionCache.setTokenMeta(mint, meta);
  return meta;
}


