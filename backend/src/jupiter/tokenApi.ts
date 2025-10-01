export type TokenInfo = {
  id: string; // mint
  name: string;
  symbol: string;
  decimals: number;
};

const TOKEN_SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search';
import { jupiterLimiter } from './rateLimiter.js';

const cache = new Map<string, { data: TokenInfo[]; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function searchTokens(query: string, priority: boolean = false): Promise<TokenInfo[]> {
  const url = new URL(TOKEN_SEARCH_URL);
  url.searchParams.set('query', query);
  const now = Date.now();
  const cached = cache.get(query);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.data;
  await jupiterLimiter.acquire(priority);
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`token search failed ${res.status}`);
  const data = (await res.json()) as any[];
  // Normalize
  const normalized = (data || []).map((t) => ({ id: t.id, name: t.name, symbol: t.symbol, decimals: t.decimals }));
  cache.set(query, { data: normalized, ts: now });
  return normalized;
}


