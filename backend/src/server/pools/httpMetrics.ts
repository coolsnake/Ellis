// ============================================================================
// HTTP METRICS TRACKING
// Track HTTP API request activity for UI monitoring
// Mirrors the GraphQL metrics pattern from shyftHelpers.ts
// ============================================================================

export type HttpSource =
  | 'raydium'
  | 'raydium-clmm'
  | 'raydium-cpmm'
  | 'orca'
  | 'meteora'
  | 'meteora_balanced'
  | 'meteora_balanced_v1'
  | 'meteora_balanced_v2'
  | 'pumpswap';

interface HttpRequestMetrics {
  /** Currently in-flight requests by source */
  inFlight: Record<HttpSource, number>;
  /** Total requests by source (since startup) */
  totalRequests: Record<HttpSource, number>;
  /** Successful requests by source */
  successCount: Record<HttpSource, number>;
  /** Failed requests by source */
  errorCount: Record<HttpSource, number>;
  /** Rate limit (429) responses by source */
  rateLimitCount: Record<HttpSource, number>;
  /** Recent latencies (last 10) by source for averaging */
  recentLatencies: Record<HttpSource, number[]>;
  /** Timestamp of last request by source */
  lastRequestTime: Record<HttpSource, number>;
  /** Request start times for in-flight tracking */
  activeRequests: Map<string, { source: HttpSource; startTime: number }>;
}

const ALL_SOURCES: HttpSource[] = [
  'raydium',
  'raydium-clmm',
  'raydium-cpmm',
  'orca',
  'meteora',
  'meteora_balanced',
  'meteora_balanced_v1',
  'meteora_balanced_v2',
  'pumpswap',
];

function createEmptyRecord<T>(defaultValue: () => T): Record<HttpSource, T> {
  const record = {} as Record<HttpSource, T>;
  for (const source of ALL_SOURCES) {
    record[source] = defaultValue();
  }
  return record;
}

const httpMetrics: HttpRequestMetrics = {
  inFlight: createEmptyRecord(() => 0),
  totalRequests: createEmptyRecord(() => 0),
  successCount: createEmptyRecord(() => 0),
  errorCount: createEmptyRecord(() => 0),
  rateLimitCount: createEmptyRecord(() => 0),
  recentLatencies: createEmptyRecord(() => []),
  lastRequestTime: createEmptyRecord(() => 0),
  activeRequests: new Map(),
};

let httpRequestIdCounter = 0;

/**
 * Start tracking an HTTP request
 * @param source The HTTP source identifier
 * @returns Request ID for tracking
 */
export function startHttpRequest(source: HttpSource): string {
  const requestId = `http-${++httpRequestIdCounter}`;
  httpMetrics.inFlight[source]++;
  httpMetrics.totalRequests[source]++;
  httpMetrics.lastRequestTime[source] = Date.now();
  httpMetrics.activeRequests.set(requestId, { source, startTime: Date.now() });
  return requestId;
}

/**
 * End tracking an HTTP request
 * @param requestId The request ID from startHttpRequest
 * @param success Whether the request succeeded
 */
export function endHttpRequest(requestId: string, success: boolean): void {
  const request = httpMetrics.activeRequests.get(requestId);
  if (!request) return;

  const { source, startTime } = request;
  const latency = Date.now() - startTime;

  httpMetrics.inFlight[source] = Math.max(0, httpMetrics.inFlight[source] - 1);

  if (success) {
    httpMetrics.successCount[source]++;
  } else {
    httpMetrics.errorCount[source]++;
  }

  // Keep last 10 latencies for averaging
  const latencies = httpMetrics.recentLatencies[source];
  latencies.push(latency);
  if (latencies.length > 10) latencies.shift();

  httpMetrics.activeRequests.delete(requestId);
}

/**
 * Record a 429 rate limit response (called during retries, doesn't end request)
 * @param source The HTTP source identifier
 */
export function recordHttp429(source: HttpSource): void {
  httpMetrics.rateLimitCount[source]++;
}

/**
 * Get current HTTP metrics for UI monitoring
 */
export function getHttpMetrics(): {
  inFlight: Record<HttpSource, number>;
  totalInFlight: number;
  bySource: Record<HttpSource, {
    inFlight: number;
    total: number;
    success: number;
    errors: number;
    rateLimits: number;
    avgLatencyMs: number;
    lastRequestMs: number;
  }>;
  timestamp: number;
} {
  const now = Date.now();

  const bySource = {} as Record<HttpSource, {
    inFlight: number;
    total: number;
    success: number;
    errors: number;
    rateLimits: number;
    avgLatencyMs: number;
    lastRequestMs: number;
  }>;

  let totalInFlight = 0;

  for (const source of ALL_SOURCES) {
    const latencies = httpMetrics.recentLatencies[source];
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    bySource[source] = {
      inFlight: httpMetrics.inFlight[source],
      total: httpMetrics.totalRequests[source],
      success: httpMetrics.successCount[source],
      errors: httpMetrics.errorCount[source],
      rateLimits: httpMetrics.rateLimitCount[source],
      avgLatencyMs,
      lastRequestMs: httpMetrics.lastRequestTime[source],
    };

    totalInFlight += httpMetrics.inFlight[source];
  }

  return {
    inFlight: { ...httpMetrics.inFlight },
    totalInFlight,
    bySource,
    timestamp: now,
  };
}
