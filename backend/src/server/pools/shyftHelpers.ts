import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

type SupportedDex = 'raydium' | 'orca' | 'meteora' | 'pumpswap';

/**
 * Get Shyft API key for a specific DEX with fallback chain
 * Priority: DEX-specific key → Pumpswap key → Global Shyft key
 */
export function getShyftApiKey(dex: SupportedDex): string {
  // Try DEX-specific key first
  const dexKey = (CONFIG as any)?.[dex]?.shyftApiKey;
  if (dexKey) return dexKey;
  
  // Fall back to pumpswap key (per user's choice 4c - use existing Pumpswap key for all DEXs initially)
  const pumpswapKey = (CONFIG as any)?.pumpswap?.shyftApiKey;
  if (pumpswapKey) return pumpswapKey;
  
  // Fall back to global key
  const globalKey = (CONFIG as any)?.shyft?.apiKey;
  if (globalKey) return globalKey;
  
  return '';
}

/**
 * Get Shyft endpoint URL
 */
export function getShyftEndpoint(): string {
  return (CONFIG as any)?.shyft?.endpoint || 'https://programs.shyft.to/v0/graphql';
}

/**
 * Get Shyft network
 */
export function getShyftNetwork(): 'mainnet-beta' | 'devnet' {
  return (CONFIG as any)?.shyft?.network || 'mainnet-beta';
}

function normalizeEndpoint(base: string): string {
  if (!base) return 'https://programs.shyft.to/v0/graphql/accounts';
  const trimmed = base.replace(/\s+/g, '').replace(/\/+$/, '');
  if (trimmed.endsWith('/accounts')) return trimmed;
  return `${trimmed}/accounts`;
}

export interface ShyftGraphQLRequest {
  dex: SupportedDex;
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
  retries?: number;
  backoffMs?: number;
  extraLogContext?: Record<string, any>;
}

export async function executeShyftGraphQL<T = any>(req: ShyftGraphQLRequest): Promise<T> {
  const apiKey = getShyftApiKey(req.dex);
  if (!apiKey) {
    throw new Error(`shyft.apiKey.missing.${req.dex}`);
  }

  const endpoint = normalizeEndpoint(getShyftEndpoint());
  const params = new URLSearchParams({
    api_key: apiKey,
    network: getShyftNetwork(),
  });
  const url = `${endpoint}?${params.toString()}`;

  const fetchFn: typeof fetch = (globalThis as any).fetch || fetch;
  if (!fetchFn) throw new Error('fetch.unavailable');

  const retries = req.retries ?? Number((CONFIG as any)?.shyft?.maxRetries ?? 2);
  const backoffMs = req.backoffMs ?? Number((CONFIG as any)?.shyft?.backoffMs ?? 500);

  const body = JSON.stringify({
    query: req.query,
    variables: req.variables,
    operationName: req.operationName,
  });

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const cid = httpLogStart({
      source: req.dex,
      url,
      extra: { ...req.extraLogContext, attempt },
    });
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res?.status === 429) {
        httpLog429({ source: req.dex, url, cid });
        lastErr = new Error('429');
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }

      if (!res?.ok) {
        httpLogNonOk({ source: req.dex, url, cid, status: res?.status });
        lastErr = new Error(`http ${res?.status}`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }

      const json = await res.json();
      if (json?.errors) {
        const errors = json.errors || [];
        const isDatabaseError = errors.some((e: any) => 
          e?.extensions?.code === 'unexpected' || 
          e?.message?.toLowerCase().includes('database')
        );
        const isValidationError = errors.some((e: any) => 
          e?.extensions?.code === 'validation-error' ||
          (res.status >= 400 && res.status < 500 && !isDatabaseError)
        );
        
        lastErr = new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
        
        // Enhanced error logging with context
        try {
          const errorDetails: any = {
            dex: req.dex,
            errors: errors,
            errorCount: errors.length,
            isDatabaseError,
            isValidationError,
            extraLogContext: req.extraLogContext,
          };
          
          // Include variable info if available (sanitized)
          if (req.variables) {
            errorDetails.variableInfo = {
              keys: Object.keys(req.variables),
              arrayLengths: Object.entries(req.variables).reduce((acc, [k, v]) => {
                if (Array.isArray(v)) acc[k] = v.length;
                return acc;
              }, {} as Record<string, number>)
            };
          }
          
          if (isDatabaseError) {
            logger.warn('shyft.graphql.errors.database', errorDetails);
          } else if (isValidationError) {
            logger.warn('shyft.graphql.errors.validation', errorDetails);
          } else {
            logger.warn('shyft.graphql.errors', {
              ...errorDetails,
              errors: JSON.stringify(errors).slice(0, 300), // Truncate for general errors
            });
          }
        } catch {}
        
        // Don't retry validation errors - they won't succeed
        if (isValidationError && !isDatabaseError) {
          logger.warn('shyft.graphql.errors.non_retryable', {
            dex: req.dex,
            errors: JSON.stringify(errors).slice(0, 300),
            extraLogContext: req.extraLogContext,
          });
          throw lastErr; // Fail immediately
        }
        
        // Database errors might be transient - retry with exponential backoff
        if (isDatabaseError) {
          logger.warn('shyft.graphql.errors.database.retrying', {
            dex: req.dex,
            attempt,
            willRetry: attempt < retries,
            extraLogContext: req.extraLogContext,
          });
          
          // Use longer backoff for database errors (2x multiplier)
          if (attempt < retries) {
            const dbBackoffMs = backoffMs * 2;
            await new Promise(r => setTimeout(r, dbBackoffMs * (attempt + 1)));
            continue;
          }
        }
        
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }

      httpLogResponse({
        source: req.dex,
        url,
        cid,
        status: res.status,
        ms: 0,
      });
      return json?.data as T;
    } catch (err) {
      lastErr = err;
      try {
        logger.warn('shyft.graphql.attempt.failed', {
          dex: req.dex,
          attempt,
          error: String((err as any)?.message || err),
        });
      } catch {}
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

