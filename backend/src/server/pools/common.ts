import { CONFIG } from '../../utils/config.js';

export function toFeeBpsSafe(value: any, defaultBps = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultBps;
  return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
}

// Generic swapper to keep A/B-side fields consistent whenever a pair is swapped.
function swapABFields<T extends Record<string, any>>(obj: T): T {
  const out: any = { ...obj };
  // Swap mints
  const aMint = out.mint_a; const bMint = out.mint_b;
  out.mint_a = bMint; out.mint_b = aMint;
  // Invert price once on swap (keep orientation as A per 1 B)
  if (typeof out.price_a_per_b === 'number' && out.price_a_per_b > 0) {
    out.price_a_per_b = 1 / out.price_a_per_b;
  }
  // Swap any keys that end with _a/_b (amount_a/_b, amount_a_whole/_b_whole, decimals_a/_b, account_a/_b, etc.)
  const keys = Object.keys(out);
  const touched = new Set<string>();
  for (const k of keys) {
    if (touched.has(k)) continue;
    if (k === 'mint_a' || k === 'mint_b') continue;
    let kb: string | null = null;
    if (k.includes('_a_')) {
      kb = k.replace('_a_', '_b_');
    } else if (k.endsWith('_a')) {
      kb = k.slice(0, -2) + '_b';
    }
    if (kb && (kb in out) && kb !== 'mint_b' && !touched.has(kb)) {
      const tmp = out[k]; out[k] = out[kb]; out[kb] = tmp;
      touched.add(k); touched.add(kb);
    }
  }
  // Common alias pairs which may not follow the exact *_a/_b suffix pattern across sources
  const aliasPairs: Array<[string,string]> = [['source_account','target_account']];
  for (const [ka, kb] of aliasPairs) {
    if (ka in out && kb in out) {
      const tmp = out[ka]; out[ka] = out[kb]; out[kb] = tmp;
    }
  }
  return out as T;
}

export function canonicalizePairsLex<T extends { mint_a: string; mint_b: string; price_a_per_b?: number }>(
  pools: T[]
): T[] {
  // Always enforce lex ordering here, independent of CONFIG.
  const out: T[] = [];
  for (const p of pools) {
    if (String(p.mint_a) <= String(p.mint_b)) { out.push(p); continue; }
    out.push(swapABFields(p));
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
      if (preferA && (preferA.has(a) || preferA.has(b))) { keep = preferA.has(a) ? 1 : 2; }
    }
    if (keep === 0 && (mode === 'preferB' || mode === 'preferLists')) {
      if (preferB && (preferB.has(a) || preferB.has(b))) { keep = preferB.has(b) ? 1 : 2; }
    }
    if (keep === 0) {
      // Fallback to lex for stability
      if (a <= b) { out.push(p); } else { out.push(swapABFields(p)); }
      continue;
    }
    out.push(keep === 1 ? p : swapABFields(p));
  }
  return out;
}


