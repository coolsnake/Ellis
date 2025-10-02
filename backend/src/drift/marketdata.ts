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
  const url = `${base}/l2?marketIndex=${marketIndex}&includeOracle=true`;
  try {
    const res = await fetch(url as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as RawDlobL2;
    // best-effort normalization
    const out: DlobL2 = { bid: [], ask: [], oracle: data?.oracle, symbol: data?.symbol };
    const b = Array.isArray(data?.bids) ? data.bids : (Array.isArray(data?.bid) ? data.bid : []);
    const a = Array.isArray(data?.asks) ? data.asks : (Array.isArray(data?.ask) ? data.ask : []);
    out.bid = (b || []).map((x: any) => ({ price: Number(x[0] ?? x.price), size: Number(x[1] ?? x.size) })).filter((v: Dl2Level) => isFinite(v.price) && isFinite(v.size));
    out.ask = (a || []).map((x: any) => ({ price: Number(x[0] ?? x.price), size: Number(x[1] ?? x.size) })).filter((v: Dl2Level) => isFinite(v.price) && isFinite(v.size));
    return out;
  } catch (e: any) {
    logger.warn('dlob: fetch L2 failed', { error: String(e?.message || e), url });
    return null;
  }
}


