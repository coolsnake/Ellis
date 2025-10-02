import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type Dl2Level = { price: number; size: number };
export type DlobL2 = { bid: Dl2Level[]; ask: Dl2Level[]; oracle?: number; symbol?: string };

type RawLevel = [unknown, unknown] | { price?: unknown; size?: unknown };
interface RawDlobL2 {
  oracle?: number;
  symbol?: string;
  bids?: RawLevel[];
  bid?: RawLevel[];
  asks?: RawLevel[];
  ask?: RawLevel[];
}

export async function fetchDlobL2(marketIndex: number): Promise<DlobL2 | null> {
  const base = (CONFIG as any).drift?.dlobUrl || 'https://dlob.drift.trade';
  const cluster = (CONFIG as any).drift?.cluster || 'mainnet-beta';
  const candidates = [
    `${base}/l2?marketIndex=${marketIndex}&marketType=perp&includeOracle=true&cluster=${encodeURIComponent(cluster)}`,
    `${base}/l2?marketIndex=${marketIndex}&marketType=perp&includeOracle=true`,
    `${base}/l2?marketIndex=${marketIndex}&includeOracle=true`,
  ];
  const fetchAny: any = (globalThis as any).fetch;
  let lastError: any = null;
  for (const url of candidates) {
    try {
      logger.debug('drift.dlob.fetch_l2', { url, marketIndex, cat: 'drift' });
      const res = await fetchAny(url as any, { headers: { Accept: 'application/json' } } as any);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
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
      out.bid = (b || [])
        .map((x: any) => ({ price: scaleIfNeeded(Number(x[0] ?? x.price)), size: Number(x[1] ?? x.size) }))
        .filter((v: Dl2Level) => isFinite(v.price) && isFinite(v.size));
      out.ask = (a || [])
        .map((x: any) => ({ price: scaleIfNeeded(Number(x[0] ?? x.price)), size: Number(x[1] ?? x.size) }))
        .filter((v: Dl2Level) => isFinite(v.price) && isFinite(v.size));
      logger.debug('drift.dlob.l2_ready', { marketIndex, bid: out.bid.length, ask: out.ask.length, oracle: out.oracle, cat: 'drift' });
      return out;
    } catch (e: any) {
      lastError = e;
      logger.warn('drift.dlob.fetch_l2_variant_failed', { error: String(e?.message || e), url, marketIndex, cat: 'drift' });
      continue;
    }
  }
  logger.warn('drift.dlob.fetch_l2_failed', { error: String(lastError?.message || lastError || 'unknown'), tried: candidates, marketIndex, cat: 'drift' });
  return null;
}


