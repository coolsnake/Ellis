import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

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
    const SOL = 'So11111111111111111111111111111111111111112';
    const STABLES = new Set<string>([
      ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
    ]);
    const a = String(p.mint_a);
    const b = String(p.mint_b);
    // Rule 1: SOL must be on A side
    if (a === SOL) { out.push(p); continue; }
    if (b === SOL) { out.push(swapABFields(p)); continue; }
    // Rule 2: If no SOL, ensure stable is on B side when exactly one stable present
    const aStable = STABLES.has(a);
    const bStable = STABLES.has(b);
    if (aStable !== bStable) { // exactly one is stable
      if (aStable && !bStable) { out.push(swapABFields(p)); continue; }
      out.push(p); continue; // bStable
    }
    // Fallback: lex ordering for stability
    if (a <= b) { out.push(p); continue; }
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
  let mode = 'quoteHierarchy';
  let preferA: Set<string> | null = null;
  let preferB: Set<string> | null = null;
  let quoteRank: Map<string, number> | null = null;
  try {
    const sys: any = (CONFIG as any)?.system || {};
    // Default to quoteHierarchy for global consistency unless explicitly overridden
    mode = String(sys.canonicalizePairs || 'quoteHierarchy');
    const aList: string[] = Array.isArray(sys.canonicalPreferAsA) ? sys.canonicalPreferAsA : [];
    const bList: string[] = Array.isArray(sys.canonicalPreferAsB) ? sys.canonicalPreferAsB : [];
    preferA = aList.length ? new Set(aList.map(String)) : null;
    preferB = bList.length ? new Set(bList.map(String)) : null;
    // Optional quote hierarchy list: highest-ranked mint should end up on B side
    const qList: string[] = Array.isArray(sys.quoteHierarchy) ? sys.quoteHierarchy : [];
    if (qList.length) {
      quoteRank = new Map(qList.map((m, i) => [String(m), i]));
    }
  } catch {}
  if (mode === 'lex') return canonicalizePairsLex(pools);
  const out: T[] = [];
  for (const p of pools) {
    const a = String(p.mint_a || '');
    const b = String(p.mint_b || '');
    const SOL = 'So11111111111111111111111111111111111111112';
    const STABLES = new Set<string>([
      ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
    ]);
    let keep = 0; // 0 unknown, 1 keep as-is, 2 swap
    // Hard rules first: SOL on A; else stable on B if exactly one stable present
    if (a === SOL || b === SOL) {
      keep = (a === SOL) ? 1 : 2;
    } else {
      const aStable = STABLES.has(a);
      const bStable = STABLES.has(b);
      if (aStable !== bStable) {
        keep = aStable ? 2 : 1; // move stable to B side
      }
    }
    if (mode === 'preferA' || mode === 'preferLists') {
      if (preferA && (preferA.has(a) || preferA.has(b))) { keep = preferA.has(a) ? 1 : 2; }
    }
    if (keep === 0 && (mode === 'preferB' || mode === 'preferLists')) {
      if (preferB && (preferB.has(a) || preferB.has(b))) { keep = preferB.has(b) ? 1 : 2; }
    }
    if (keep === 0 && (mode === 'quoteHierarchy') && quoteRank) {
      const INF = Number.POSITIVE_INFINITY;
      const ra = quoteRank.get(a) ?? INF;
      const rb = quoteRank.get(b) ?? INF;
      // Highest-ranked quote should be placed on the B side.
      if (ra < rb) { keep = 2; }
      else if (rb < ra) { keep = 1; }
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


// Basic SSRF guard for configured HTTP endpoints used by fetchers.
// Allows only http/https schemes and blocks obvious local/private hosts and IP literals.
export function validateHttpUrl(input: string): string | null {
  try {
    if (!input || typeof input !== 'string') return null;
    const url = new URL(input);
    const scheme = String(url.protocol || '').toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    const host = String(url.hostname || '').toLowerCase();
    // Quick denylist: localhost and common internal hostnames
    const badHosts = new Set<string>(['localhost', '127.0.0.1', '::1']);
    if (badHosts.has(host)) return null;
    // Block obvious internal domains
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.intranet')) return null;
    // Block private IP ranges when host is an IP literal
    const isIpV4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    if (isIpV4) {
      const [a, b] = host.split('.').map((s) => Number(s));
      // 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
      if (a === 10 || a === 127) return null;
      if (a === 169 && b === 254) return null;
      if (a === 172 && b >= 16 && b <= 31) return null;
      if (a === 192 && b === 168) return null;
    }
    return url.toString();
  } catch {
    try { logger.warn('ssrf.validate failed', { url: input }); } catch {}
    return null;
  }
}


