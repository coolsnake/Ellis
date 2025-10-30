import { logger } from '../utils/logger.js';

let cache: { labels: Record<string, string>; ts: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

async function fetchProgramLabels(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && (now - cache.ts) < TTL_MS) return cache.labels;
  const url = 'https://lite-api.jup.ag/swap/v1/program-id-to-label';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`program-id-to-label failed ${res.status}`);
  const json = (await res.json()) as Record<string, string>;
  cache = { labels: json, ts: now };
  try { logger.debug('jup.labels.loaded', { cat: 'jupiter', count: Object.keys(json).length }); } catch {}
  return json;
}

function staticSynonymsForDex(name: string): string[] {
  const v = String(name || '').toLowerCase();
  if (v.includes('raydiumclmm') || v.includes('raydium clmm')) return ['Raydium CLMM'];
  if (v === 'raydium' || v.includes('raydium')) return ['Raydium CLMM', 'Raydium', 'Raydium CP', 'Raydium CPMM'];
  if (v.includes('orca')) return ['Whirlpool', 'Orca V2', 'Orca V1'];
  if (v.includes('meteora')) return ['Meteora DLMM', 'Meteora', 'Meteora DAMM v2'];
  return [name];
}

export async function labelsForDex(name: string): Promise<string[]> {
  const map = await fetchProgramLabels();
  const available = new Set(Object.values(map));
  const candidates = staticSynonymsForDex(name);
  return candidates.filter(l => available.has(l));
}

export async function buildDexesParam(includeDexes?: string[]): Promise<string | undefined> {
  if (!includeDexes || includeDexes.length === 0) return undefined;
  const all: string[] = [];
  for (const d of includeDexes) {
    try {
      const ls = await labelsForDex(d);
      for (const l of ls) all.push(l);
    } catch {}
  }
  const uniq = Array.from(new Set(all));
  if (!uniq.length) return undefined;
  return uniq.map(x => x.replace(/\s+/g, '+')).join(',');
}


