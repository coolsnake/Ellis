import { readJson, writeJson } from './fs.js';
import { CONFIG } from './config.js';
import { searchTokens } from '../jupiter/tokenApi.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export type TokenMap = Record<string, { mint: string; decimals: number }>;
export type JupToken = { address: string; name: string; symbol: string; decimals: number };

export async function loadTokenMap(): Promise<TokenMap> {
  return readJson<TokenMap>(CONFIG.tokensPath, {
    SOL: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  });
}

const resolveCache: Record<string, { mint: string; decimals: number }> = {};

export async function resolveMint(symbolOrMint: string): Promise<{ mint: string; decimals: number }> {
  const input = symbolOrMint || '';
  const upper = input.toUpperCase();
  if (resolveCache[upper]) return resolveCache[upper];
  const map = await loadTokenMap();
  if (map[upper]) {
    resolveCache[upper] = map[upper];
    return map[upper];
  }
  // If looks like a mint (base58-ish and long), assume provided is a mint address
  if (input.length > 30) {
    // Try to fetch decimals on-chain for accurate handling
    try {
      const conn = new Connection(CONFIG.rpcUrl, 'confirmed');
      const mintInfo = await getMint(conn, new PublicKey(input));
      const decimals = Number(mintInfo.decimals ?? 6);
      const out = { mint: input, decimals };
      resolveCache[upper] = out;
      return out;
    } catch {
      return { mint: input, decimals: 6 };
    }
  }
  // Otherwise, try Token API V2 search
  const results = await searchTokens(input).catch(() => []);
  const first = results[0];
  if (first?.id) {
    // persist mapping for future lookups
    const current = await loadTokenMap();
    current[upper] = { mint: first.id, decimals: first.decimals ?? 6 };
    await writeJson(CONFIG.tokensPath, current);
    // Opportunistic price bootstrap for the newly discovered token
    try {
      const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
      const { setPrices } = await import('../server/priceStore.js');
      const fresh = await fetchPricesByMints([first.id], { catOverride: 'token-resolve' });
      setPrices(fresh);
    } catch {}
    resolveCache[upper] = current[upper];
    return current[upper];
  }
  throw new Error(`Unknown token: ${symbolOrMint}`);
}

// Jupiter token list support (separate from local tokens.json)
const JUP_TOKENS_URL = 'https://tokens.jup.ag/tokens?tags=verified';

export async function fetchAndCacheJupiterTokens(): Promise<JupToken[]> {
  try {
    const res = await fetch(JUP_TOKENS_URL, { headers: { accept: 'application/json' } as any } as any);
    if (!res.ok) throw new Error(`jup tokens http ${res.status}`);
    const data = await res.json();
    const arr: JupToken[] = Array.isArray(data) ? data.map((t: any) => ({ address: String(t?.address || t?.id || ''), name: String(t?.name || ''), symbol: String(t?.symbol || ''), decimals: Number(t?.decimals ?? 0) })) : [];
    await writeJson(CONFIG.jupTokensPath, arr);
    return arr;
  } catch (e: any) {
    // Fallback to cached file
    const cached = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
    return cached;
  }
}

export async function loadJupiterTokenMap(): Promise<Record<string, { symbol: string; decimals: number }>> {
  const cached = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
  const map: Record<string, { symbol: string; decimals: number }> = {};
  for (const t of (cached || [])) {
    if (t?.address) map[t.address] = { symbol: t.symbol || t.name || t.address.slice(0, 4), decimals: Number(t.decimals ?? 0) };
  }
  return map;
}

export async function resolveMintViaJupiter(mint: string): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const url = `https://tokens.jup.ag/token/${mint}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } as any } as any);
    if (!res.ok) throw new Error(`jup token http ${res.status}`);
    const t: any = await res.json();
    if (t?.address) {
      const out = { symbol: String(t.symbol || t.name || ''), decimals: Number(t.decimals ?? 0) };
      // Update cache file
      try {
        const cur = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
        const idx = cur.findIndex(x => x.address === mint);
        if (idx >= 0) cur[idx] = { address: mint, name: String(t.name || ''), symbol: out.symbol, decimals: out.decimals };
        else cur.push({ address: mint, name: String(t.name || ''), symbol: out.symbol, decimals: out.decimals });
        await writeJson(CONFIG.jupTokensPath, cur);
      } catch {}
      return out;
    }
  } catch {}
  return null;
}


