import { logger } from '../utils/logger.js';
import { computeTokenUniverse } from './universe.js';
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
  const mints = Array.from(uni);
  if (mints.length === 0) {
    logger.warn('price.bootstrap empty universe');
    return { total: 0, priced: 0, missing: 0 };
  }
  logger.info('price.bootstrap start', { cat, totalMints: mints.length, chunkSize, maxRequests });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints start total=${mints.length} chunk=${chunkSize} max=${maxRequests} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}

  // Skip already priced mints to reduce calls
  const existing = getAllPrices();
  const toFetch = mints.filter((m) => !existing[m]?.usdc);
  let requests = 0;
  for (let i = 0; i < toFetch.length && requests < maxRequests; i += chunkSize) {
    const batch = toFetch.slice(i, i + chunkSize);
    try {
      const fresh = await fetchPricesByMints(batch, { catOverride: cat });
      setPrices(fresh);
      requests += 1;
    } catch (e: any) {
      logger.warn('price.bootstrap batch failed', { error: String(e?.message || e), cat });
      // On 429/backoff, stop early; partial coverage is OK
      try { emit('log', { level: 'warn', message: `pools:bootstrap.mints batch.fail cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      break;
    }
  }
  const after = getAllPrices();
  let priced = 0;
  for (const m of mints) { if (typeof after[m]?.usdc === 'number') priced += 1; }
  const out = { total: mints.length, priced, missing: mints.length - priced };
  logger.info('price.bootstrap done', { cat, ...out });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
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
  const existing = getAllPrices();
  const toFetch = mints.filter((m) => !existing[m]?.usdc);
  let requests = 0;
  for (let i = 0; i < toFetch.length && requests < maxRequests; i += chunkSize) {
    const batch = toFetch.slice(i, i + chunkSize);
    try {
      const fresh = await fetchPricesByMints(batch, { catOverride: cat });
      setPrices(fresh);
      requests += 1;
    } catch (e: any) {
      logger.warn('price.bootstrap.mints batch failed', { error: String(e?.message || e), cat });
      try { emit('log', { level: 'warn', message: `pools:bootstrap.mints batch.fail cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      break;
    }
  }
  const after = getAllPrices();
  let priced = 0;
  for (const m of mints) { if (typeof after[m]?.usdc === 'number') priced += 1; }
  const out = { total: mints.length, priced, missing: mints.length - priced };
  logger.info('price.bootstrap.mints done', { cat, ...out });
  try { emit('log', { level: 'info', message: `pools:bootstrap.mints done total=${out.total} priced=${out.priced} missing=${out.missing} cat=${cat}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  return out;
}


