import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { LogCat, LogSubcat, LogCode } from '../../utils/logging.js';

export type HttpLogCtx = {
  source: 'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'meteora_balanced_v2';
  url: string;
  cid?: string;
  extra?: Record<string, unknown>;
};

export function httpLogStart(ctx: HttpLogCtx): string {
  const cid = ctx.cid || `http-${Math.random().toString(36).slice(2, 8)}`;
  try {
    logger.debug('pools.http request', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_REQUEST, cid, source: ctx.source, url: ctx.url, ...(ctx.extra || {}) });
  } catch {}
  return cid;
}

export function httpLogResponse(ctx: HttpLogCtx & { cid: string; status: number; ms: number; count?: number }): void {
  try {
    logger.debug('pools.http response', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_RESPONSE, cid: ctx.cid, source: ctx.source, url: ctx.url, status: ctx.status, ms: ctx.ms, ...(ctx.count != null ? { count: ctx.count } : {}), ...(ctx.extra || {}) });
  } catch {}
}

export function httpLog429(ctx: HttpLogCtx & { cid: string }): void {
  try { emit('log', { level: 'warn', message: `arb:429 source=${ctx.source} kind=http`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
  try { logger.warn('pools.http 429', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_429, cid: ctx.cid, source: ctx.source, url: ctx.url }); } catch {}
}

export function httpLogNonOk(ctx: HttpLogCtx & { cid: string; status: number; bodySample?: string }): void {
  try { logger.warn('pools.http non-ok', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_NON_OK, cid: ctx.cid, source: ctx.source, url: ctx.url, status: ctx.status, body: ctx.bodySample }); } catch {}
}


