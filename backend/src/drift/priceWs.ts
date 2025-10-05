import { getDriftConfig } from '../utils/driftConfig.js';
import { indexToSymbol, symbolToIndex } from './marketMapping.js';
import { logger } from '../utils/logger.js';

function getWebSocketCtor(): any {
  const g: any = (globalThis as any);
  return g.WebSocket || g.webkitWebSocket || g.MozWebSocket || g.ws || null;
}

async function ensureWsCtor(): Promise<any> {
  let WS = getWebSocketCtor();
  if (WS) return WS;
  try {
    // Dynamically import 'ws' for Node runtime
    const mod: any = await import('ws');
    WS = mod?.WebSocket || mod?.default || mod;
    if (WS) return WS;
  } catch {}
  return null;
}

type Listener<T> = (payload: T) => void;

export type L2Update = {
  marketIndex: number;
  bids?: Array<[number, number]> | Array<{ price: number; size: number }>;
  asks?: Array<[number, number]> | Array<{ price: number; size: number }>;
  bid?: any;
  ask?: any;
  oracle?: number;
  symbol?: string;
  ts?: number;
};

type NormalizedL2 = {
  marketIndex: number;
  bid?: number;
  ask?: number;
  mid?: number;
  oracle?: number;
  symbol?: string;
  updatedAt: number;
};

export class DriftDlobWs {
  private socket: any | null = null;
  private connected = false;
  private wantMarkets: Set<number> = new Set();
  private lastUpdateByMarket: Map<number, number> = new Map();
  private listeners: Map<string, Set<Listener<any>>> = new Map();
  private reconnectTimer: any | null = null;
  private heartbeatTimer: any | null = null;
  private wsCid: string | null = null;

  async start(): Promise<void> {
    if (this.connected || this.socket) return;
    const url = String(getDriftConfig().dlobWsUrl || 'wss://dlob.drift.trade/ws');
    try {
      const WS: any = await ensureWsCtor();
      if (!WS) {
        logger.warn('drift.ws.unavailable_env', { url, cat: 'drift', code: 'DRIFT.WS.ENV_UNAVAILABLE', cid: `ws:${url}` });
        return;
      }
      this.wsCid = `ws-${Math.random().toString(36).slice(2, 8)}`;
      this.socket = new WS(url);
      this.wireSocket();
    } catch (e: any) {
      logger.warn('drift.ws.connect_failed', { url, error: String(e?.message || e), cat: 'drift', code: 'DRIFT.WS.CONNECT_FAILED', cid: this.wsCid || `ws:${url}` });
      this.scheduleReconnect();
    }
  }

  stop(): void {
    try { if (this.socket) this.socket.close(); } catch {}
    this.socket = null;
    this.connected = false;
    if (this.reconnectTimer) { try { (globalThis as any).clearTimeout(this.reconnectTimer); } catch {} this.reconnectTimer = null; }
    if (this.heartbeatTimer) { try { (globalThis as any).clearInterval(this.heartbeatTimer); } catch {} this.heartbeatTimer = null; }
  }

  subscribeMarket(marketIndex: number): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    this.wantMarkets.add(idx);
    this.flushSubscription('subscribe', [idx]);
  }

  unsubscribeMarket(marketIndex: number): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    this.wantMarkets.delete(idx);
    this.flushSubscription('unsubscribe', [idx]);
  }

  on(event: 'l2', handler: Listener<NormalizedL2>): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    (this.listeners.get(event) as Set<Listener<NormalizedL2>>).add(handler as any);
    return this;
  }

  off(event: 'l2', handler: Listener<NormalizedL2>): this {
    (this.listeners.get(event) as Set<Listener<NormalizedL2>>)?.delete(handler as any);
    return this;
  }

  getLastUpdateTs(marketIndex: number): number | undefined {
    return this.lastUpdateByMarket.get(Number(marketIndex));
  }

  private emit<T>(event: string, payload: T): void {
    const ls = this.listeners.get(event);
    if (!ls || ls.size === 0) return;
    for (const fn of Array.from(ls)) {
      try { (fn as Listener<T>)(payload); } catch {}
    }
  }

  private wireSocket(): void {
    const s: any = this.socket;
    if (!s) return;
    s.onopen = () => {
      this.connected = true;
      logger.info('drift.ws.open', { url: (s?.url || getDriftConfig().dlobWsUrl), cat: 'drift', code: 'DRIFT.WS.OPEN', cid: this.wsCid || `ws:${s?.url || getDriftConfig().dlobWsUrl}`, span: 'start' });
      // Resubscribe desired markets
      if (this.wantMarkets.size > 0) this.flushSubscription('subscribe', Array.from(this.wantMarkets));
      // Heartbeat
      const hbMs = Math.max(5000, Number(getDriftConfig().wsHeartbeatMs || 15000));
      if (this.heartbeatTimer) { try { (globalThis as any).clearInterval(this.heartbeatTimer); } catch {} }
      this.heartbeatTimer = (globalThis as any).setInterval(() => {
        try { s.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {}
      }, hbMs);
    };
    s.onclose = () => {
      this.connected = false;
      logger.warn('drift.ws.close', { cat: 'drift', code: 'DRIFT.WS.CLOSE', cid: this.wsCid || undefined, span: 'end' });
      if (this.heartbeatTimer) { try { (globalThis as any).clearInterval(this.heartbeatTimer); } catch {} this.heartbeatTimer = null; }
      this.scheduleReconnect();
    };
    s.onerror = (e: any) => {
      logger.warn('drift.ws.error', { error: String(e?.message || e), cat: 'drift', code: 'DRIFT.WS.ERROR', cid: this.wsCid || undefined });
    };
    s.onmessage = (ev: any) => {
      try {
        const data = typeof ev?.data === 'string' ? JSON.parse(ev.data) : (ev?.data || {});
        // DLOB WS messages structure: { channel: 'orderbook', market: 'SOL-PERP', bids: [], asks: [], oracle, ... }
        const marketName: string | undefined = String(data?.market || data?.symbol || '').trim() || undefined;
        const mktIdx = this.resolveMarketIndex(marketName, data);
        if (!Number.isFinite(mktIdx)) return;
        const norm = this.normalizeL2(Number(mktIdx), data as any);
        if (!norm) return;
        this.lastUpdateByMarket.set(Number(mktIdx), norm.updatedAt);
        this.emit('l2', norm);
      } catch (e: any) {
        logger.warn('drift.ws.message_parse_failed', { error: String(e?.message || e), cat: 'drift' });
      }
    };
  }

  private flushSubscription(type: 'subscribe' | 'unsubscribe', indices: number[]): void {
    try {
      if (!this.socket || !this.connected) return;
      if (!Array.isArray(indices) || indices.length === 0) return;
      // Drift DLOB expects market names for orderbook channel; keep numeric index for our state
      const names = indices.map(i => this.mapMarketIndexToName(i)).filter(Boolean) as string[];
      // Chunk to avoid throttling
      const chunkSize = Math.max(10, Math.min(50, Number(getDriftConfig().wsResubChunkSize || 25)));
      for (let i = 0; i < names.length; i += chunkSize) {
        const markets = names.slice(i, i + chunkSize);
        const msg = { type, channel: 'orderbook', markets };
        (this.socket as any).send(JSON.stringify(msg));
      }
    } catch {}
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const minMs = Math.max(500, Number(getDriftConfig().wsReconnectMinMs || 1000));
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectTimer = (globalThis as any).setTimeout(() => {
      this.reconnectTimer = null;
      try { this.stop(); } catch {}
      this.start();
    }, minMs + jitter);
  }

  private normalizeL2(marketIndex: number, raw: L2Update): NormalizedL2 | null {
    try {
      const bidsArr: any[] = Array.isArray((raw as any).bids) ? (raw as any).bids : (Array.isArray((raw as any).bid) ? (raw as any).bid : []);
      const asksArr: any[] = Array.isArray((raw as any).asks) ? (raw as any).asks : (Array.isArray((raw as any).ask) ? (raw as any).ask : []);
      const parsePx = (x: any): number => Number((Array.isArray(x) ? x[0] : (x?.price)) ?? NaN);
      const bidPx = bidsArr.length > 0 ? parsePx(bidsArr[0]) : undefined;
      const askPx = asksArr.length > 0 ? parsePx(asksArr[0]) : undefined;
      const mid = (typeof bidPx === 'number' && isFinite(bidPx) && typeof askPx === 'number' && isFinite(askPx)) ? (bidPx + askPx) / 2 : undefined;
      return {
        marketIndex: Number(marketIndex),
        bid: (typeof bidPx === 'number' && isFinite(bidPx)) ? bidPx : undefined,
        ask: (typeof askPx === 'number' && isFinite(askPx)) ? askPx : undefined,
        mid,
        oracle: (typeof (raw as any)?.oracle === 'number') ? (raw as any).oracle : undefined,
        symbol: (raw as any)?.symbol,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  // Map helpers: we need to translate between index and name when talking to DLOB
  private mapMarketIndexToName(idx: number): string | undefined {
    try { return indexToSymbol(Number(idx)); } catch { return undefined; }
  }

  private resolveMarketIndex(marketName: string | undefined, raw: any): number | undefined {
    try {
      // If message carried numeric index, use it
      const idx = Number(raw?.marketIndex ?? raw?.market_index ?? raw?.market?.index);
      if (Number.isFinite(idx)) return idx;
    } catch {}
    if (!marketName) return undefined;
    try { return symbolToIndex(String(marketName)); } catch { return undefined; }
  }
}


