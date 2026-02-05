import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type TriggerNodesRequest = {
  markets: Array<{ marketIndex: number; marketType?: string | { perp?: unknown; spot?: unknown }; triggerPrice?: string }>;
  limitPerMarket?: number;
};

export type TriggerNodesResponse = {
  slot?: number;
  results?: Array<{ marketIndex: number; marketType?: string; nodes: any[] }>;
};

export type FillNodesRequest = {
  markets: number[];
  limitPerMarket?: number;
};

export type FillNodesResponse = {
  slot?: number;
  results?: Array<{ marketIndex: number; vBid?: string; vAsk?: string; oracle?: string; oracleDelay?: number; oracleStale?: boolean; nodes: any[] }>;
};

export type UserAccountsResponse = {
  accounts?: Record<string, { data: string | null; slot?: number }>;
};

export type PricesResponse = {
  prices?: Record<string, any>;
};

export type EventIndexResponse = {
  stats?: any;
  condMarkets?: number[];
  activeMarkets?: number[];
};

function getInfraBaseUrl(): string | null {
  try {
    const env = String(process.env.DRIFT_INFRA_URL || '').trim();
    if (env) return env;
  } catch {}
  const cfg: any = (CONFIG as any)?.driftInfra || {};
  if (cfg?.baseUrl) return String(cfg.baseUrl);
  const port = Math.max(1, Number(process.env.DRIFT_INFRA_PORT || cfg?.port || 3020));
  if (port > 0) return `http://127.0.0.1:${port}`;
  return null;
}

function getInfraSecretHeader(): Record<string, string> {
  try {
    const cfg: any = (CONFIG as any)?.driftInfra || {};
    const secret = String(process.env.DRIFT_INFRA_SECRET || cfg?.secret || '');
    if (secret) return { 'x-drift-infra-secret': secret };
  } catch {}
  try {
    const cfgBots: any = (CONFIG as any)?.driftBots || {};
    const secret = String(process.env.DRIFT_BOTS_SECRET || cfgBots?.secret || '');
    if (secret) return { 'x-drift-bots-secret': secret };
  } catch {}
  return {};
}

async function requestJson<T>(path: string, opts?: { method?: string; body?: any; timeoutMs?: number }): Promise<T> {
  const base = getInfraBaseUrl();
  if (!base) throw new Error('infra_unconfigured');
  const url = `${base}${path}`;
  const method = String(opts?.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...getInfraSecretHeader(),
  };
  const body = (method === 'GET' || method === 'HEAD') ? undefined : JSON.stringify(opts?.body || {});
  const ac = new AbortController();
  const timeoutMs = Math.max(1000, Number(opts?.timeoutMs ?? 8000));
  const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`infra_http_${res.status}`);
    try { return JSON.parse(text || '{}') as T; } catch { return {} as T; }
  } finally {
    clearTimeout(t);
  }
}

export function hasInfra(): boolean {
  return !!getInfraBaseUrl();
}

export async function fetchTriggerNodes(req: TriggerNodesRequest): Promise<TriggerNodesResponse> {
  try {
    return await requestJson<TriggerNodesResponse>('/api/drift/infra/dlob/trigger-nodes', { method: 'POST', body: req, timeoutMs: 12000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.trigger_nodes_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return {};
  }
}

export async function fetchFillNodes(req: FillNodesRequest): Promise<FillNodesResponse> {
  try {
    return await requestJson<FillNodesResponse>('/api/drift/infra/dlob/fill-nodes', { method: 'POST', body: req, timeoutMs: 15000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.fill_nodes_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return {};
  }
}

export async function fetchUserAccounts(pubkeys: string[]): Promise<UserAccountsResponse> {
  try {
    return await requestJson<UserAccountsResponse>('/api/drift/infra/users/accounts', { method: 'POST', body: { pubkeys }, timeoutMs: 12000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.user_accounts_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return {};
  }
}

export async function fetchPrices(markets: number[], opts?: { track?: boolean; pollMs?: number }): Promise<PricesResponse> {
  try {
    return await requestJson<PricesResponse>('/api/drift/infra/prices', { method: 'POST', body: { markets, track: !!opts?.track, pollMs: opts?.pollMs }, timeoutMs: 8000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.prices_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return {};
  }
}

export async function fetchEventIndex(limit?: number): Promise<EventIndexResponse> {
  try {
    const qs = Number.isFinite(Number(limit)) ? `?limit=${Number(limit)}` : '';
    return await requestJson<EventIndexResponse>(`/api/drift/infra/event-index${qs}`, { method: 'GET', timeoutMs: 5000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.event_index_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return {};
  }
}

export async function fetchUserKeys(limit?: number): Promise<{ keys: string[] }> {
  try {
    const qs = Number.isFinite(Number(limit)) ? `?limit=${Number(limit)}` : '';
    return await requestJson<{ keys: string[] }>(`/api/drift/infra/users/keys${qs}`, { method: 'GET', timeoutMs: 8000 });
  } catch (e: any) {
    try { logger.warn('drift.infra.user_keys_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    return { keys: [] };
  }
}

