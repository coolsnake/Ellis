import { CONFIG } from '../../utils/config.js';

export function toFeeBpsSafe(value: any, defaultBps = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultBps;
  return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
}

export function canonicalizePairsLex<T extends { mint_a: string; mint_b: string; price_a_per_b?: number }>(
  pools: T[]
): T[] {
  try {
    const mode = String((CONFIG.system as any)?.canonicalizePairs || 'none');
    if (mode !== 'lex') return pools;
  } catch {
    return pools;
  }
  const out: T[] = [];
  for (const p of pools) {
    if (String(p.mint_a) <= String(p.mint_b)) { out.push(p); continue; }
    const inv = (p.price_a_per_b && p.price_a_per_b > 0) ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b;
    out.push({ ...p, mint_a: p.mint_b, mint_b: p.mint_a, price_a_per_b: inv } as T);
  }
  return out;
}


