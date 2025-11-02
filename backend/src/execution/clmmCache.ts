import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ClmmPoolStatic = {
  programId: string;
  tickSpacing: number;
  oracle: string;
  vaultA: string;
  vaultB: string;
  tickArrays: { lower: string; center: string; upper: string };
  observationId?: string;
  lastUpdateMs: number;
};

const mem = new Map<string, ClmmPoolStatic>();

function getCacheFilePath(): string {
  const here = fileURLToPath(new URL('../../', import.meta.url));
  const base = path.resolve(here); // backend/
  return path.join(base, 'cache', 'raydium-clmm-cache.json');
}

export function getClmmStatic(poolId: string): ClmmPoolStatic | null {
  return mem.get(poolId) || null;
}

export function setClmmStatic(poolId: string, v: ClmmPoolStatic): void {
  mem.set(poolId, v);
}

export async function loadClmmCacheFromDisk(): Promise<void> {
  const fp = getCacheFilePath();
  try {
    const raw = await readFile(fp, 'utf8');
    const obj = JSON.parse(raw) as Record<string, ClmmPoolStatic>;
    mem.clear();
    for (const [k, v] of Object.entries(obj)) mem.set(k, v);
  } catch {}
}

export async function saveClmmCacheToDisk(): Promise<void> {
  const fp = getCacheFilePath();
  const dir = path.dirname(fp);
  try { await mkdir(dir, { recursive: true }); } catch {}
  const obj: Record<string, ClmmPoolStatic> = {};
  for (const [k, v] of mem.entries()) obj[k] = v;
  await writeFile(fp, JSON.stringify(obj), 'utf8');
}


