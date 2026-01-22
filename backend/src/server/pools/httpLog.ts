import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { LogCat, LogSubcat, LogCode } from '../../utils/logging.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { startHttpRequest, endHttpRequest, recordHttp429, type HttpSource } from './httpMetrics.js';

export type HttpLogCtx = {
  source: 'raydium' | 'raydium-clmm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora_balanced' | 'meteora_balanced_v1' | 'meteora_balanced_v2' | 'pumpswap';
  url: string;
  cid?: string;
  extra?: Record<string, unknown>;
};

export function httpLogStart(ctx: HttpLogCtx): string {
  // Use metrics-generated request ID as correlation ID
  const cid = ctx.cid || startHttpRequest(ctx.source as HttpSource);
  try {
    logger.debug('pools.http request', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_REQUEST, cid, source: ctx.source, url: ctx.url, ...(ctx.extra || {}) });
  } catch (e) { logCatchError('pools.httpLog', e); }
  return cid;
}

export function httpLogResponse(ctx: HttpLogCtx & { cid: string; status: number; ms: number; count?: number }): void {
  // End metrics tracking - success if status is 2xx
  const success = ctx.status >= 200 && ctx.status < 300;
  try { endHttpRequest(ctx.cid, success); } catch (e) { logCatchError('pools.httpLog.metrics', e); }
  try {
    logger.debug('pools.http response', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_RESPONSE, cid: ctx.cid, source: ctx.source, url: ctx.url, status: ctx.status, ms: ctx.ms, ...(ctx.count != null ? { count: ctx.count } : {}), ...(ctx.extra || {}) });
  } catch (e) { logCatchError('pools.httpLog', e); }
}

export function httpLog429(ctx: HttpLogCtx & { cid: string }): void {
  // Record 429 for metrics (doesn't end request - may retry)
  try { recordHttp429(ctx.source as HttpSource); } catch (e) { logCatchError('pools.httpLog.metrics', e); }
  try { emit('log', { level: 'warn', message: `arb:429 source=${ctx.source} kind=http`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch (e) { logCatchError('pools.httpLog', e); }
  try { logger.warn('pools.http 429', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_429, cid: ctx.cid, source: ctx.source, url: ctx.url }); } catch (e) { logCatchError('pools.httpLog', e); }
}

export function httpLogNonOk(ctx: HttpLogCtx & { cid: string; status: number; bodySample?: string }): void {
  // Don't end metrics tracking here - may retry, httpLogResponse will be called at the end
  try { logger.warn('pools.http non-ok', { cat: LogCat.pools, subcat: LogSubcat.http, code: LogCode.POOLS_HTTP_NON_OK, cid: ctx.cid, source: ctx.source, url: ctx.url, status: ctx.status, body: ctx.bodySample }); } catch (e) { logCatchError('pools.httpLog', e); }
}


