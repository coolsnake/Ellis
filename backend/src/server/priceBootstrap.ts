import { logger } from '../utils/logger.js';
import { computeTokenUniverse } from './universe.js';
import { readJson, writeJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { loadTokenMap, loadJupiterTokenMap } from '../utils/tokens.js';
import { fetchPricesByMints } from '../jupiter/jupiter.js';
import { setPrices, getAllPrices } from './priceStore.js';
import { emit } from './realtime.js';

type BootstrapOpts = {
  chunkSize?: number;
  maxRequests?: number;
  priority?: boolean;
  cat?: string;
};

export async function bootstrapPricesForUniverse(opts: BootstrapOpts = {}): Promise<{
  total: number;
  priced: number;
  missing: number;
}> {
  const cat = opts.cat || 'price-bootstrap';
  const chunkSize = Math.max(10, Math.min(500, Number(opts.chunkSize ?? 80)));
  const maxRequests = Math.max(1, Number(opts.maxRequests ?? 5));

  const uni = await computeTokenUniverse('jupiter');
  const mints = new Set<string>(Array.from(uni));
  // Enrich with configured tokens.json and jupTokens.json
  try {
    const tok = await loadTokenMap().catch(() => ({} as any));
    for (const v of Object.values(tok || {})) { const mint = (v as any)?.mint; if (mint) mints.add(String(mint)); }
  } catch {}
  try {
    const j = await loadJupiterTokenMap().catch(() => ({} as any));
    for (const k of Object.keys(j || {})) { if (k) mints.add(String(k)); }
  } catch {}
  // Optionally include cached pools' mints if present in dist caches
  try {
    const poolsPath = (CONFIG as any)?.cacheDir ? `${(CONFIG as any).cacheDir}/pools-startup.json` : '';
    if (poolsPath) {
      const pools: any = await readJson<any>(poolsPath, null as any);
      const addFrom = (arr?: any[]) => {
        for (const p of (arr || [])) { if (p?.mint_a) mints.add(String(p.mint_a)); if (p?.mint_b) mints.add(String(p.mint_b)); }
      };
      if (pools) { addFrom(pools.amm); addFrom(pools.clmm); }
    }
  } catch {}
  const mintList = Array.from(mints);
  if (mintList.length === 0) {
    logger.warn('price.bootstrap empty universe');
    // Still emit structured start/done logs for UI observability when universe is empty
    try { emit('log', { level: 'info', message: `pools:bootstrap.mints start total=0 chunk=${chunkSize} max=${maxRequests} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    try { emit('log', { level: 'info', message: `pools:bootstrap.mints done total=0 priced=0 missing=0 cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    return { total: 0, priced: 0, missing: 0 };
  }
  logger.info('price.bootstrap start', { cat, totalMints: mintList.length, chunkSize, maxRequests });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints start total=${mintList.length} chunk=${chunkSize} max=${maxRequests} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  try { logger.info(`pools:bootstrap.mints start total=${mintList.length} chunk=${chunkSize} max=${maxRequests} cat=${cat}`, { cat: 'pools' }); } catch {}

  // Skip already priced mints to reduce calls
  const existing = getAllPrices();
  const toFetch = mintList.filter((m) => !existing[m]?.usdc);
  let requests = 0;
  let i = 0;
  let curChunk = chunkSize;
  while (i < toFetch.length && requests < maxRequests) {
    const batch = toFetch.slice(i, Math.min(i + curChunk, toFetch.length));
    if (batch.length === 0) break;
    try {
      const fresh = await fetchPricesByMints(batch, { catOverride: cat, ignorePause: true });
      setPrices(fresh);
      requests += 1;
      i += batch.length;
    } catch (e: any) {
      const msg = String(e?.message || e);
      const is413 = /\b413\b/.test(msg) || /payload too large/i.test(msg);
      if (is413 && curChunk > 50) {
        const prev = curChunk;
        curChunk = Math.max(50, Math.floor(curChunk / 2));
        logger.warn('price.bootstrap batch 413, reducing chunk', { prev, next: curChunk, cat });
        continue; // retry same i with smaller chunk
      }
      logger.warn('price.bootstrap batch failed', { error: msg, cat });
      try { emit('log', { level: 'warn', message: `pools:bootstrap.mints batch.fail cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      try { logger.info(`pools:bootstrap.mints batch.fail cat=${cat}`, { cat: 'pools' }); } catch {}
      // Move past this batch to avoid stalling, but keep going for remainder
      i += batch.length;
    }
  }
  const after = getAllPrices();
  let priced = 0;
  for (const m of mintList) { if (typeof after[m]?.usdc === 'number') priced += 1; }
  const out = { total: mintList.length, priced, missing: mintList.length - priced };
  logger.info('price.bootstrap done', { cat, ...out });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  try { logger.info(`pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, { cat: 'pools' }); } catch {}
  // Persist prices into tokens.json for any tokens present there
  try {
    const tokenMap = await loadTokenMap().catch(() => ({} as any));
    let changed = false;
    for (const [sym, info] of Object.entries(tokenMap || {})) {
      const mint = (info as any)?.mint;
      if (!mint) continue;
      const p = after[mint];
      if (p) {
        const usdc = (typeof p.usdc === 'number') ? p.usdc : null;
        const sol = (typeof p.sol === 'number') ? p.sol : null;
        if ((info as any).usdc !== usdc || (info as any).sol !== sol) {
          (info as any).usdc = usdc;
          (info as any).sol = sol;
          changed = true;
        }
      }
    }
    if (changed) await writeJson(CONFIG.tokensPath, tokenMap);
  } catch {}
  return out;
}

export async function bootstrapPricesForMints(mintsIn: string[], opts: BootstrapOpts = {}): Promise<{
  total: number;
  priced: number;
  missing: number;
}> {
  const cat = opts.cat || 'price-bootstrap';
  const chunkSize = Math.max(10, Math.min(500, Number(opts.chunkSize ?? 80)));
  const maxRequests = Math.max(1, Number(opts.maxRequests ?? 5));
  const mints = Array.from(new Set((mintsIn || []).filter(Boolean)));
  if (mints.length === 0) return { total: 0, priced: 0, missing: 0 };
  logger.info('price.bootstrap.mints start', { cat, totalMints: mints.length, chunkSize, maxRequests });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints start total=${mints.length} chunk=${chunkSize} max=${maxRequests} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  try { logger.info(`pools:bootstrap.mints start total=${mints.length} chunk=${chunkSize} max=${maxRequests} cat=${cat}`, { cat: 'pools' }); } catch {}
  const existing = getAllPrices();
  const toFetch = mints.filter((m) => !existing[m]?.usdc);
  let requests = 0;
  let idx = 0;
  let curChunk = chunkSize;
  while (idx < toFetch.length && requests < maxRequests) {
    const batch = toFetch.slice(idx, Math.min(idx + curChunk, toFetch.length));
    if (batch.length === 0) break;
    try {
      const fresh = await fetchPricesByMints(batch, { catOverride: cat, ignorePause: true });
      setPrices(fresh);
      requests += 1;
      idx += batch.length;
    } catch (e: any) {
      const msg = String(e?.message || e);
      const is413 = /\b413\b/.test(msg) || /payload too large/i.test(msg);
      if (is413 && curChunk > 50) {
        const prev = curChunk;
        curChunk = Math.max(50, Math.floor(curChunk / 2));
        logger.warn('price.bootstrap.mints 413, reducing chunk', { prev, next: curChunk, cat });
        continue; // retry same idx with smaller chunk
      }
      logger.warn('price.bootstrap.mints batch failed', { error: msg, cat });
      try { emit('log', { level: 'warn', message: `pools:bootstrap.mints batch.fail cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      try { logger.info(`pools:bootstrap.mints batch.fail cat=${cat}`, { cat: 'pools' }); } catch {}
      idx += batch.length; // skip past this batch to avoid stalling
    }
  }
  const after = getAllPrices();
  let priced = 0;
  for (const m of mints) { if (typeof after[m]?.usdc === 'number') priced += 1; }
  const out = { total: mints.length, priced, missing: mints.length - priced };
  logger.info('price.bootstrap.mints done', { cat, ...out });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  try { logger.info(`pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, { cat: 'pools' }); } catch {}
  // Persist to tokens.json for any known tokens
  try {
    const tokenMap = await loadTokenMap().catch(() => ({} as any));
    let changed = false;
    for (const [sym, info] of Object.entries(tokenMap || {})) {
      const mint = (info as any)?.mint;
      if (!mint) continue;
      const p = after[mint];
      if (p) {
        const usdc = (typeof p.usdc === 'number') ? p.usdc : null;
        const sol = (typeof p.sol === 'number') ? p.sol : null;
        if ((info as any).usdc !== usdc || (info as any).sol !== sol) {
          (info as any).usdc = usdc;
          (info as any).sol = sol;
          changed = true;
        }
      }
    }
    if (changed) await writeJson(CONFIG.tokensPath, tokenMap);
  } catch {}
  return out;
}


