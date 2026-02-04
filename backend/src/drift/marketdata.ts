import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type Dl2Level = { price: number; size: number };
export type DlobL2 = { bid: Dl2Level[]; ask: Dl2Level[]; oracle?: number; symbol?: string };
export type DlobTopMakers = { makers: Array<{ maker: string; marketIndex?: number; size?: number }>; marketIndex?: number };
export type DlobL3 = { bids: Array<{ price: number; size: number; maker?: string }>; asks: Array<{ price: number; size: number; maker?: string }>; symbol?: string };

type RawLevel = [unknown, unknown] | { price?: unknown; size?: unknown };
interface RawDlobL2 {
  oracle?: number;
  symbol?: string;
  bids?: RawLevel[];
  bid?: RawLevel[];
  asks?: RawLevel[];
  ask?: RawLevel[];
}

const DLOB_BAD_REQUEST_COOLDOWN_MS = 60_000;
const dlobBadRequestUntil = new Map<number, number>();
const isBadRequestStatus = (status?: number) => status === 400 || status === 404;
const shouldSkipDlob = (marketIndex: number): boolean => {
  const until = dlobBadRequestUntil.get(Number(marketIndex));
  if (typeof until !== 'number') return false;
  if (Date.now() < until) return true;
  dlobBadRequestUntil.delete(Number(marketIndex));
  return false;
};
const markDlobBadRequest = (marketIndex: number, status?: number): void => {
  dlobBadRequestUntil.set(Number(marketIndex), Date.now() + DLOB_BAD_REQUEST_COOLDOWN_MS);
  try {
    logger.warn('drift.dlob.bad_request_skip', { marketIndex, status, cooldownMs: DLOB_BAD_REQUEST_COOLDOWN_MS, cat: 'drift' });
  } catch {}
};

export async function fetchDlobL2(marketIndex: number): Promise<DlobL2 | null> {
  const base = (CONFIG as any).drift?.dlobUrl || 'https://dlob.drift.trade';
  const cluster = (CONFIG as any).drift?.cluster || 'mainnet-beta';
  if (shouldSkipDlob(marketIndex)) {
    try { logger.debug('drift.dlob.skip_bad_request', { marketIndex, kind: 'l2', cat: 'drift' }); } catch {}
    return null;
  }
  const candidates = [
    `${base}/l2?marketIndex=${marketIndex}&marketType=perp&includeOracle=true&cluster=${encodeURIComponent(cluster)}`,
    `${base}/l2?marketIndex=${marketIndex}&marketType=perp&includeOracle=true`,
    `${base}/l2?marketIndex=${marketIndex}&includeOracle=true`,
  ];
  const fetchAny: any = (globalThis as any).fetch;
  let lastError: any = null;
  let lastStatus: number | undefined = undefined;
  for (const url of candidates) {
    try {
      logger.debug('drift.dlob.fetch_l2', { url, marketIndex, cat: 'drift' });
      const res = await fetchAny(url as any, { headers: { Accept: 'application/json' } } as any);
      if (res && typeof res.status === 'number' && res.status === 429) {
        try { const { emit } = await import('../server/realtime.js'); emit('log', { level: 'warn', message: `arb:429 source=drift kind=dlob_l2 marketIndex=${marketIndex}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
        logger.warn('drift.dlob 429', { marketIndex, url, cat: 'drift' });
        throw new Error('HTTP 429');
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        lastStatus = res.status;
        if (isBadRequestStatus(res.status)) {
          lastError = new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText}` : ''}`);
          continue;
        }
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText}` : ''}`);
      }
      const data = (await res.json()) as RawDlobL2;
      // best-effort normalization
      const scaleIfNeeded = (v: number | undefined): number | undefined => {
        if (typeof v !== 'number' || !isFinite(v)) return undefined;
        // DLOB often returns micro-price (1e6). Detect and scale down.
        return Math.abs(v) > 1e6 ? v / 1e6 : v;
      };
      const out: DlobL2 = { bid: [], ask: [], oracle: scaleIfNeeded(data?.oracle), symbol: data?.symbol };
      const b = Array.isArray(data?.bids) ? data.bids : (Array.isArray(data?.bid) ? data.bid : []);
      const a = Array.isArray(data?.asks) ? data.asks : (Array.isArray(data?.ask) ? data.ask : []);
      const toLevel = (x: any) => ({ price: scaleIfNeeded(Number(x[0] ?? x.price)), size: Number(x[1] ?? x.size) });
      const isLevel = (v: { price: number | undefined; size: number }): v is Dl2Level =>
        typeof v.price === 'number' && isFinite(v.price) && isFinite(v.size);
      out.bid = (b || []).map(toLevel).filter(isLevel);
      out.ask = (a || []).map(toLevel).filter(isLevel);
      logger.debug('drift.dlob.l2_ready', { marketIndex, bid: out.bid.length, ask: out.ask.length, oracle: out.oracle, cat: 'drift' });
      return out;
    } catch (e: any) {
      lastError = e;
      logger.warn('drift.dlob.fetch_l2_variant_failed', { error: String(e?.message || e), url, marketIndex, cat: 'drift' });
      continue;
    }
  }
  if (isBadRequestStatus(lastStatus)) {
    markDlobBadRequest(marketIndex, lastStatus);
  }
  logger.warn('drift.dlob.fetch_l2_failed', { error: String(lastError?.message || lastError || 'unknown'), tried: candidates, marketIndex, cat: 'drift' });
  return null;
}

export async function fetchDlobTopMakers(marketIndex: number): Promise<DlobTopMakers | null> {
  const base = (CONFIG as any).drift?.dlobUrl || 'https://dlob.drift.trade';
  const cluster = (CONFIG as any).drift?.cluster || 'mainnet-beta';
  if (shouldSkipDlob(marketIndex)) {
    try { logger.debug('drift.dlob.skip_bad_request', { marketIndex, kind: 'topMakers', cat: 'drift' }); } catch {}
    return null;
  }
  const candidates = [
    `${base}/topMakers?marketIndex=${marketIndex}&marketType=perp&cluster=${encodeURIComponent(cluster)}`,
    `${base}/topMakers?marketIndex=${marketIndex}&marketType=perp`,
  ];
  const fetchAny: any = (globalThis as any).fetch;
  let lastError: any = null;
  let lastStatus: number | undefined = undefined;
  try {
    for (const url of candidates) {
      try {
        logger.debug('drift.dlob.fetch_topMakers', { url, marketIndex, cat: 'drift' });
        const res = await fetchAny(url as any, { headers: { Accept: 'application/json' } } as any);
        if (!res.ok) {
          lastStatus = res.status;
          if (isBadRequestStatus(res.status)) {
            lastError = new Error(`HTTP ${res.status}`);
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        const makers = Array.isArray(data?.makers) ? data.makers : Array.isArray(data) ? data : [];
        const out: DlobTopMakers = { makers: [], marketIndex };
        for (const m of makers) {
          const maker = String(m?.maker || m?.pubkey || m?.user || '').trim();
          if (maker) out.makers.push({ maker, marketIndex, size: Number(m?.size || m?.qty || 0) || undefined });
        }
        return out;
      } catch (e: any) {
        lastError = e;
      }
    }
  } catch (e: any) {
    lastError = e;
  }
  if (isBadRequestStatus(lastStatus)) {
    markDlobBadRequest(marketIndex, lastStatus);
  }
  logger.warn('drift.dlob.fetch_topMakers_failed', { error: String(lastError?.message || lastError), marketIndex, cat: 'drift' });
  return null;
}

export async function fetchDlobL3Makers(marketIndex: number): Promise<string[]> {
  const base = (CONFIG as any).drift?.dlobUrl || 'https://dlob.drift.trade';
  const cluster = (CONFIG as any).drift?.cluster || 'mainnet-beta';
  if (shouldSkipDlob(marketIndex)) {
    try { logger.debug('drift.dlob.skip_bad_request', { marketIndex, kind: 'l3', cat: 'drift' }); } catch {}
    return [];
  }
  const candidates = [
    `${base}/l3?marketIndex=${marketIndex}&marketType=perp&cluster=${encodeURIComponent(cluster)}`,
    `${base}/l3?marketIndex=${marketIndex}&marketType=perp`,
  ];
  const fetchAny: any = (globalThis as any).fetch;
  const makers: Set<string> = new Set();
  let lastError: any = null;
  let lastStatus: number | undefined = undefined;
  try {
    for (const url of candidates) {
      try {
        logger.debug('drift.dlob.fetch_l3', { url, marketIndex, cat: 'drift' });
        const res = await fetchAny(url as any, { headers: { Accept: 'application/json' } } as any);
        if (!res.ok) {
          lastStatus = res.status;
          if (isBadRequestStatus(res.status)) {
            lastError = new Error(`HTTP ${res.status}`);
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        const bids = Array.isArray(data?.bids) ? data.bids : [];
        const asks = Array.isArray(data?.asks) ? data.asks : [];
        const dig = (arr: any[]) => {
          for (const x of arr) {
            const mk = String(x?.maker || x?.user || x?.pubkey || '').trim();
            if (mk) makers.add(mk);
          }
        };
        dig(bids); dig(asks);
        return Array.from(makers);
      } catch (e: any) {
        lastError = e;
      }
    }
  } catch (e: any) {
    lastError = e;
  }
  if (isBadRequestStatus(lastStatus)) {
    markDlobBadRequest(marketIndex, lastStatus);
  }
  logger.warn('drift.dlob.fetch_l3_failed', { error: String(lastError?.message || lastError), marketIndex, cat: 'drift' });
  return [];
}


