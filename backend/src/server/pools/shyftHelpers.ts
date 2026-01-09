import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { logCatchError } from '../../utils/errorHandler.js';

type SupportedDex = 'raydium' | 'raydium-clmm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'pumpswap';

// ============================================================================
// GLOBAL SHYFT RATE LIMITER
// Shyft has a 1 request/second limit. This enforces that limit process-wide
// and adds a cooldown period when 429s are detected.
// ============================================================================

interface ShyftRateLimiterState {
  /** Timestamp (ms) when cooldown ends. 0 = no active cooldown */
  cooldownUntilMs: number;
  /** Timestamp of last successful request dispatch */
  lastRequestMs: number;
  /** Count of 429s in current window (for logging) */
  recentRateLimitCount: number;
  /** Timestamp when rate limit count was last reset */
  rateLimitCountResetMs: number;
}

const shyftState: ShyftRateLimiterState = {
  cooldownUntilMs: 0,
  lastRequestMs: 0,
  recentRateLimitCount: 0,
  rateLimitCountResetMs: Date.now(),
};

// ============================================================================
// GRAPHQL METRICS TRACKING
// Track request activity for UI monitoring
// ============================================================================

interface GraphQLRequestMetrics {
  /** Currently in-flight requests by DEX */
  inFlight: Record<SupportedDex, number>;
  /** Total requests by DEX (since startup) */
  totalRequests: Record<SupportedDex, number>;
  /** Successful requests by DEX */
  successCount: Record<SupportedDex, number>;
  /** Failed requests by DEX */
  errorCount: Record<SupportedDex, number>;
  /** Recent latencies (last 10) by DEX for averaging */
  recentLatencies: Record<SupportedDex, number[]>;
  /** Timestamp of last request by DEX */
  lastRequestTime: Record<SupportedDex, number>;
  /** Request start times for in-flight tracking */
  activeRequests: Map<string, { dex: SupportedDex; startTime: number }>;
}

const graphqlMetrics: GraphQLRequestMetrics = {
  inFlight: { raydium: 0, 'raydium-clmm': 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0 },
  totalRequests: { raydium: 0, 'raydium-clmm': 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0 },
  successCount: { raydium: 0, 'raydium-clmm': 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0 },
  errorCount: { raydium: 0, 'raydium-clmm': 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0 },
  recentLatencies: { raydium: [], 'raydium-clmm': [], 'raydium-cpmm': [], orca: [], meteora: [], pumpswap: [] },
  lastRequestTime: { raydium: 0, 'raydium-clmm': 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0 },
  activeRequests: new Map(),
};

let graphqlRequestIdCounter = 0;

function startGraphQLRequest(dex: SupportedDex): string {
  const requestId = `gql-${++graphqlRequestIdCounter}`;
  graphqlMetrics.inFlight[dex]++;
  graphqlMetrics.totalRequests[dex]++;
  graphqlMetrics.lastRequestTime[dex] = Date.now();
  graphqlMetrics.activeRequests.set(requestId, { dex, startTime: Date.now() });
  return requestId;
}

function endGraphQLRequest(requestId: string, success: boolean): void {
  const request = graphqlMetrics.activeRequests.get(requestId);
  if (!request) return;
  
  const { dex, startTime } = request;
  const latency = Date.now() - startTime;
  
  graphqlMetrics.inFlight[dex] = Math.max(0, graphqlMetrics.inFlight[dex] - 1);
  
  if (success) {
    graphqlMetrics.successCount[dex]++;
  } else {
    graphqlMetrics.errorCount[dex]++;
  }
  
  // Keep last 10 latencies for averaging
  const latencies = graphqlMetrics.recentLatencies[dex];
  latencies.push(latency);
  if (latencies.length > 10) latencies.shift();
  
  graphqlMetrics.activeRequests.delete(requestId);
}

/**
 * Get current GraphQL metrics for UI monitoring
 */
export function getGraphQLMetrics(): {
  inFlight: Record<SupportedDex, number>;
  totalInFlight: number;
  byDex: Record<SupportedDex, {
    inFlight: number;
    total: number;
    success: number;
    errors: number;
    avgLatencyMs: number;
    lastRequestMs: number;
  }>;
  rateLimiter: {
    inCooldown: boolean;
    cooldownRemainingMs: number;
    recentRateLimitCount: number;
  };
  timestamp: number;
} {
  const now = Date.now();
  const dexes: SupportedDex[] = ['raydium', 'raydium-clmm', 'raydium-cpmm', 'orca', 'meteora', 'pumpswap'];
  
  const byDex = {} as Record<SupportedDex, {
    inFlight: number;
    total: number;
    success: number;
    errors: number;
    avgLatencyMs: number;
    lastRequestMs: number;
  }>;
  
  let totalInFlight = 0;
  
  for (const dex of dexes) {
    const latencies = graphqlMetrics.recentLatencies[dex];
    const avgLatencyMs = latencies.length > 0 
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    
    byDex[dex] = {
      inFlight: graphqlMetrics.inFlight[dex],
      total: graphqlMetrics.totalRequests[dex],
      success: graphqlMetrics.successCount[dex],
      errors: graphqlMetrics.errorCount[dex],
      avgLatencyMs,
      lastRequestMs: graphqlMetrics.lastRequestTime[dex],
    };
    
    totalInFlight += graphqlMetrics.inFlight[dex];
  }
  
  return {
    inFlight: { ...graphqlMetrics.inFlight },
    totalInFlight,
    byDex,
    rateLimiter: {
      inCooldown: shyftState.cooldownUntilMs > now,
      cooldownRemainingMs: Math.max(0, shyftState.cooldownUntilMs - now),
      recentRateLimitCount: shyftState.recentRateLimitCount,
    },
    timestamp: now,
  };
}

// Configuration (can be overridden via CONFIG.shyft.*)
const getShyftRateLimitConfig = () => ({
  /** Minimum gap between requests in ms (1000 = 1 req/sec) */
  minRequestGapMs: Number((CONFIG as any)?.shyft?.minRequestGapMs ?? 1100),
  /** Cooldown duration after a 429 in ms */
  cooldownDurationMs: Number((CONFIG as any)?.shyft?.cooldownDurationMs ?? 5000),
  /** Additional cooldown per consecutive 429 in ms */
  cooldownPerConsecutive429Ms: Number((CONFIG as any)?.shyft?.cooldownPerConsecutive429Ms ?? 2000),
  /** Max cooldown duration in ms */
  maxCooldownMs: Number((CONFIG as any)?.shyft?.maxCooldownMs ?? 30000),
  /** Window for counting consecutive 429s (ms) */
  rateLimitCountWindowMs: Number((CONFIG as any)?.shyft?.rateLimitCountWindowMs ?? 60000),
});

/**
 * Trigger a global cooldown after receiving a 429.
 * All Shyft requests will wait until cooldown expires.
 */
function triggerShyftCooldown(source: string): void {
  const config = getShyftRateLimitConfig();
  const now = Date.now();
  
  // Reset counter if window expired
  if (now - shyftState.rateLimitCountResetMs > config.rateLimitCountWindowMs) {
    shyftState.recentRateLimitCount = 0;
    shyftState.rateLimitCountResetMs = now;
  }
  
  shyftState.recentRateLimitCount++;
  
  // Calculate cooldown: base + (consecutive * extra)
  const cooldownMs = Math.min(
    config.maxCooldownMs,
    config.cooldownDurationMs + (shyftState.recentRateLimitCount - 1) * config.cooldownPerConsecutive429Ms
  );
  
  const newCooldownUntil = now + cooldownMs;
  
  // Only extend cooldown, never shorten it
  if (newCooldownUntil > shyftState.cooldownUntilMs) {
    shyftState.cooldownUntilMs = newCooldownUntil;
    
    logger.warn('shyft.rate_limit.cooldown.triggered', {
      source,
      cooldownMs,
      cooldownUntilMs: newCooldownUntil,
      consecutiveCount: shyftState.recentRateLimitCount,
      cat: 'shyft',
    });
  }
}

/**
 * Wait until it's safe to make a Shyft request.
 * Enforces: (1) global cooldown after 429s, (2) minimum gap between requests.
 */
async function waitForShyftSlot(): Promise<void> {
  const config = getShyftRateLimitConfig();
  const now = Date.now();
  
  // Check if we're in cooldown
  if (shyftState.cooldownUntilMs > now) {
    const waitMs = shyftState.cooldownUntilMs - now;
    logger.debug('shyft.rate_limit.cooldown.waiting', {
      waitMs,
      cooldownUntilMs: shyftState.cooldownUntilMs,
      cat: 'shyft',
    });
    await new Promise(r => setTimeout(r, waitMs));
  }
  
  // Enforce minimum gap between requests
  const timeSinceLastRequest = Date.now() - shyftState.lastRequestMs;
  if (timeSinceLastRequest < config.minRequestGapMs) {
    const gapWaitMs = config.minRequestGapMs - timeSinceLastRequest;
    await new Promise(r => setTimeout(r, gapWaitMs));
  }
  
  // Update last request time
  shyftState.lastRequestMs = Date.now();
}

/**
 * Get current Shyft rate limiter status (for debugging/monitoring)
 */
export function getShyftRateLimiterStatus(): {
  inCooldown: boolean;
  cooldownRemainingMs: number;
  recentRateLimitCount: number;
  lastRequestMs: number;
  config: ReturnType<typeof getShyftRateLimitConfig>;
} {
  const now = Date.now();
  const config = getShyftRateLimitConfig();
  return {
    inCooldown: shyftState.cooldownUntilMs > now,
    cooldownRemainingMs: Math.max(0, shyftState.cooldownUntilMs - now),
    recentRateLimitCount: shyftState.recentRateLimitCount,
    lastRequestMs: shyftState.lastRequestMs,
    config,
  };
}

// ============================================================================
// EXISTING CODE (with rate limiter integration)
// ============================================================================

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
  const backoffMs = req.backoffMs ?? Number((CONFIG as any)?.shyft?.backoffMs ?? 1000);

  const body = JSON.stringify({
    query: req.query,
    variables: req.variables,
    operationName: req.operationName,
  });

  // Track this request for UI monitoring
  const requestId = startGraphQLRequest(req.dex);
  let success = false;
  
  try {
    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // *** RATE LIMITER: Wait for slot before each attempt ***
      await waitForShyftSlot();
      
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
          
          // *** RATE LIMITER: Trigger global cooldown on 429 ***
          triggerShyftCooldown(req.dex);
          
          lastErr = new Error('429');
          if (attempt < retries) {
            // Don't add extra delay here - waitForShyftSlot will handle it on next iteration
            continue;
          }
          throw lastErr;
        }

        // Reset rate limit counter on successful response
        if (res?.ok) {
          shyftState.recentRateLimitCount = 0;
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
          } catch (e) { logCatchError('pools.shyftHelpers', e); }
          
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
        success = true;
        return json?.data as T;
      } catch (err) {
        lastErr = err;
        try {
          logger.warn('shyft.graphql.attempt.failed', {
            dex: req.dex,
            attempt,
            error: String((err as any)?.message || err),
          });
        } catch (e) { logCatchError('pools.shyftHelpers', e); }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    endGraphQLRequest(requestId, success);
  }
}
