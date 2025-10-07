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

// Generalized canonicalization: prefer certain tokens as A or B when configured.
// Modes:
// - 'lex' (default): use canonicalizePairsLex behavior
// - 'preferA': keep any mint from canonicalPreferAsA on the A side when present
// - 'preferB': keep any mint from canonicalPreferAsB on the B side when present
// - 'preferLists': apply both preferA then preferB; else fallback to lex
export function canonicalizePairs<T extends { mint_a: string; mint_b: string; price_a_per_b?: number }>(
  pools: T[]
): T[] {
  let mode = 'lex';
  let preferA: Set<string> | null = null;
  let preferB: Set<string> | null = null;
  try {
    const sys: any = (CONFIG as any)?.system || {};
    mode = String(sys.canonicalizePairs || 'lex');
    const aList: string[] = Array.isArray(sys.canonicalPreferAsA) ? sys.canonicalPreferAsA : [];
    const bList: string[] = Array.isArray(sys.canonicalPreferAsB) ? sys.canonicalPreferAsB : [];
    preferA = aList.length ? new Set(aList.map(String)) : null;
    preferB = bList.length ? new Set(bList.map(String)) : null;
  } catch {}
  if (mode === 'lex') return canonicalizePairsLex(pools);
  const out: T[] = [];
  for (const p of pools) {
    const a = String(p.mint_a || '');
    const b = String(p.mint_b || '');
    let keep = 0; // 0 unknown, 1 keep as-is, 2 swap
    if (mode === 'preferA' || mode === 'preferLists') {
      if (preferA && (preferA.has(a) || preferA.has(b))) {
        if (preferA.has(a)) keep = 1; else keep = 2;
      }
    }
    if (keep === 0 && (mode === 'preferB' || mode === 'preferLists')) {
      if (preferB && (preferB.has(a) || preferB.has(b))) {
        if (preferB.has(b)) keep = 1; else keep = 2;
      }
    }
    if (keep === 0) {
      // Fallback to lex for stability
      if (a <= b) { out.push(p); } else {
        const inv = (p.price_a_per_b && p.price_a_per_b > 0) ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b;
        out.push({ ...p, mint_a: p.mint_b, mint_b: p.mint_a, price_a_per_b: inv } as T);
      }
      continue;
    }
    if (keep === 1) { out.push(p); continue; }
    const inv = (p.price_a_per_b && p.price_a_per_b > 0) ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b;
    out.push({ ...p, mint_a: p.mint_b, mint_b: p.mint_a, price_a_per_b: inv } as T);
  }
  return out;
}


