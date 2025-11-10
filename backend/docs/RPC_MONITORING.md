# RPC Monitoring System

## Overview

The RPC monitoring system provides comprehensive real-time visibility into all Solana RPC calls made by the Lockstone backend. It tracks performance metrics, error rates, and resource usage across all modules.

## Architecture

### Backend Components

#### 1. RPC Limiter with Metrics (`backend/src/utils/rpcLimiter.ts`)

The enhanced RPC limiter now tracks:
- **Per-call metrics**: timestamp, module, method, duration, weight, success/failure
- **Aggregated stats**: by module and by RPC method
- **Rate limiter state**: available tokens, queue depth, capacity
- **Error tracking**: recent errors with context

**Key Functions:**

```typescript
// Get comprehensive metrics snapshot
getRpcMetrics(): RpcMetricsSnapshot

// Execute RPC call with tracking (use this instead of direct calls)
withRpcLimit<T>(fn: () => Promise<T>, weight?: number, context?: { module?: string; method?: string }): Promise<T>

// Execute with retry and tracking
withRpcRetry<T>(fn: () => Promise<T>, opts?: { 
  weight?: number; 
  module?: string; 
  method?: string;
  // ... other retry options
}): Promise<T>
```

#### 2. API Endpoint (`backend/src/server/routes/system.ts`)

- **Route**: `GET /api/system/rpc/metrics`
- **Returns**: Current RPC metrics snapshot
- **Update frequency**: Real-time via socket, HTTP polling available

#### 3. Socket Emission (`backend/src/server/routes.ts`)

- **Event**: `rpc-metrics`
- **Frequency**: Every 2 seconds
- **Payload**: Full metrics snapshot

### Frontend Components

#### 1. RpcMonitor Component (`frontend/src/components/RpcMonitor.tsx`)

A collapsible UI panel displaying:
- **Overview**: RPS, rate limiter status, success rate, latency
- **Modules View**: Breakdown by module (drift, arb, pools, etc.)
- **Methods View**: Breakdown by RPC method (getAccountInfo, sendTransaction, etc.)
- **Errors View**: Recent errors with details

**Features:**
- Real-time updates via WebSocket
- Color-coded health indicators
- Sortable tables
- Time-windowed statistics (1s, 5s, 30s, 60s)

#### 2. Integration (`frontend/src/features/logs/LogsColumn.tsx`)

The RPC Monitor is placed after the System log window, maintaining consistency with the log panel layout.

## Instrumentation

### How to Track RPC Calls

When making RPC calls, use the instrumented wrappers:

```typescript
import { withRpcLimit, withRpcRetry } from '../utils/rpcLimiter.js';

// Simple rate-limited call with tracking
const result = await withRpcLimit(
  () => connection.getAccountInfo(address),
  1, // weight
  { module: 'drift', method: 'getAccountInfo' }
);

// With retry logic
const result = await withRpcRetry(
  () => connection.getAccountInfo(address),
  {
    weight: 1,
    module: 'drift',
    method: 'getAccountInfo',
    retries: 3,
    timeoutMs: 2500,
  }
);
```

### Module Categories

Current modules tracked:
- `drift` - Drift protocol operations
- `arb` - Arbitrage detection and execution
- `pools` - Pool data fetching and subscriptions
- `execution` - Transaction building and sending
- `jupiter` - Jupiter aggregator calls
- `wallet` - Wallet operations
- `alt` - Address Lookup Table operations
- `unknown` - Uncategorized calls (should be minimized)

### RPC Method Names

Common Solana RPC methods:
- `getAccountInfo` - Single account data fetch
- `getMultipleAccounts` - Batch account fetch
- `getProgramAccounts` - Query accounts by program
- `sendTransaction` - Submit transaction
- `simulateTransaction` - Preflight simulation
- `getSignatureStatuses` - Check transaction status
- `getAddressLookupTable` - Fetch ALT data
- `accountSubscribe` / `accountUnsubscribe` - WebSocket subscriptions

## Metrics Breakdown

### Overall Metrics

```typescript
{
  overall: {
    rps: {
      current: number,  // Current RPS
      avg1s: number,    // 1-second average
      avg5s: number,    // 5-second average
      avg30s: number,   // 30-second average
      avg60s: number,   // 60-second average
    },
    rateLimiter: {
      availableTokens: number,  // Current token bucket level
      capacity: number,         // Max bucket capacity
      maxRps: number,          // Configured RPS limit
      queueDepth: number,      // Requests waiting for tokens
    },
    success: {
      total: number,   // Total successful calls
      rate: number,    // Success rate percentage
    },
    errors: {
      total: number,   // Total failed calls
      rate: number,    // Error rate percentage
    },
    latency: {
      p50: number,     // Median latency (ms)
      p90: number,     // 90th percentile
      p95: number,     // 95th percentile
      p99: number,     // 99th percentile
    },
    totalCalls: number,
  }
}
```

### Module-Level Metrics

Each module tracks:
- Call count
- Error count
- Latency percentiles (p50, p90, p95, p99)
- Last call timestamp

### Method-Level Metrics

Each RPC method tracks:
- Call count
- Error count
- Latency percentiles
- Average weight (cost)
- Total weight consumed
- Last call timestamp

### Error Records

Recent errors include:
- Timestamp
- Module name
- Method name
- Error message
- Call duration

## Performance Considerations

### Memory Management

- **Latency samples**: Limited to 1000 per method/module
- **Timestamps**: Limited to 3600 (1 hour of history)
- **Error history**: Limited to 50 recent errors

These limits prevent unbounded memory growth while maintaining useful historical data.

### Rate Limiting

The system uses a token bucket algorithm:
- **Tokens**: Refilled at `RPC_MAX_RPS` per second
- **Capacity**: Limited to `RPC_BURST` tokens
- **Min gap**: `RPC_MIN_GAP_MS` between requests (prevents micro-bursts)

Configure via environment variables:
```bash
RPC_MAX_RPS=50       # Match your RPC provider's limit
RPC_BURST=12         # Burst capacity (default: 25% of max RPS)
RPC_MIN_GAP_MS=20    # Minimum gap between requests
```

## Monitoring Best Practices

### Health Indicators

**Good** (Green):
- Error rate < 5%
- P95 latency < 2000ms
- Queue depth consistently 0

**Warning** (Yellow):
- Error rate 5-10%
- P95 latency 2000-5000ms
- Occasional queue buildup

**Error** (Red):
- Error rate > 10%
- P95 latency > 5000ms
- Persistent queue depth > 0

### Common Issues

1. **High Error Rate**
   - Check for rate limiting (429 errors)
   - Verify RPC endpoint health
   - Review recent error messages

2. **High Latency**
   - May indicate RPC provider issues
   - Check network connectivity
   - Consider reducing request frequency

3. **Queue Buildup**
   - RPC calls exceeding rate limit
   - Increase `RPC_MAX_RPS` if provider allows
   - Optimize code to reduce call frequency

4. **Unknown Module**
   - RPC calls not properly instrumented
   - Add module/method context to `withRpcLimit` calls

## Extending the System

### Adding New Modules

1. Update your RPC calls to use the instrumented wrappers
2. Use descriptive module names (lowercase, consistent)
3. Module names will automatically appear in the UI

### Adding Custom Metrics

To add custom metrics beyond the built-in tracking:

```typescript
// In rpcLimiter.ts, extend the RpcCallRecord interface
interface RpcCallRecord {
  // ... existing fields
  customField?: string;
}

// Update recordRpcCall() to handle the new field
// Update getRpcMetrics() to expose it in the snapshot
```

### Alerting Integration

The metrics endpoint can be polled by external monitoring systems:

```bash
# Example: Prometheus scraping
curl http://localhost:3003/api/system/rpc/metrics

# Example: Alert on error rate
if [ $(jq '.overall.errors.rate' metrics.json) -gt 10 ]; then
  echo "High RPC error rate!"
fi
```

## Troubleshooting

### Metrics Not Updating

1. Check that the backend is running
2. Verify WebSocket connection in browser console
3. Check for errors in backend logs

### Missing Module/Method Data

1. Ensure RPC calls use `withRpcLimit` or `withRpcRetry`
2. Verify module/method context is provided
3. Check for direct RPC calls bypassing instrumentation

### High Memory Usage

1. Check the number of unique methods/modules
2. Reduce `MAX_LATENCY_SAMPLES` if needed
3. Monitor the `recentErrors` array size

## Future Enhancements

Potential improvements:
- Historical data persistence (database)
- Alerting/notification system
- Custom dashboards
- Export metrics to external systems (Prometheus, Grafana)
- Per-endpoint RPC URL tracking (multi-RPC support)
- Cost tracking (if using paid RPC services)
- Automatic rate limit adjustment based on 429 responses

