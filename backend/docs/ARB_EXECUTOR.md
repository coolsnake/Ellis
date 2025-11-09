# Arbitrage Executor

The arbitrage executor automatically executes detected opportunities from arb-rs.

## Architecture

```
arb-rs (detector) → WebSocket → Backend Executor → Transaction Builder → On-chain Execution
```

The executor:
1. Connects to arb-rs WebSocket stream (`/ws/opportunities`)
2. Filters opportunities based on profit, reserves, and risk parameters
3. Automatically builds and executes transactions
4. Tracks cooldowns to avoid re-executing same paths
5. Enforces rate limits and concurrency controls

## Configuration

Configuration file: `backend/config/arbExecutor.json`

```json
{
  "enabled": false,
  "minProfitBps": 50,
  "maxConcurrentExecutions": 1,
  "executionTimeoutMs": 30000,
  "cooldownMs": 5000,
  "sizeUsd": 100,
  "slippageBps": 50,
  "maxHops": 3,
  "minReservesUsd": 10000,
  "maxExecutionsPerMinute": 10,
  "blacklistedPaths": []
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for executor |
| `minProfitBps` | number | `50` | Minimum profit in basis points (0.5%) |
| `maxConcurrentExecutions` | number | `1` | Max simultaneous transactions |
| `executionTimeoutMs` | number | `30000` | Timeout per execution (30s) |
| `cooldownMs` | number | `5000` | Cooldown between same path (5s) |
| `sizeUsd` | number | `100` | Trade size in USD |
| `slippageBps` | number | `50` | Slippage tolerance (0.5%) |
| `maxHops` | number | `3` | Maximum hops per arbitrage |
| `minReservesUsd` | number | `10000` | Minimum pool reserves |
| `maxExecutionsPerMinute` | number | `10` | Rate limit per minute |
| `blacklistedPaths` | string[] | `[]` | Paths to never execute |

## API Endpoints

### Start Executor

```bash
POST /arb/executor/start

# With custom config
curl -X POST http://localhost:3001/arb/executor/start \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "minProfitBps": 75,
    "sizeUsd": 200
  }'

# With config file
curl -X POST http://localhost:3001/arb/executor/start
```

### Stop Executor

```bash
POST /arb/executor/stop

curl -X POST http://localhost:3001/arb/executor/stop
```

### Get Status

```bash
GET /arb/executor/status

curl http://localhost:3001/arb/executor/status
```

Response:
```json
{
  "running": true,
  "config": {
    "enabled": true,
    "minProfitBps": 50,
    ...
  },
  "state": {
    "inFlight": 1,
    "inFlightKeys": ["USDC->SOL->USDC|orca,raydium"],
    "recentExecutions": 5,
    "executionsThisMinute": 3,
    "lastExecutionTime": 1699564800000,
    "totalExecutions": 42,
    "successfulExecutions": 38,
    "failedExecutions": 4,
    "successRate": "90.5%"
  }
}
```

### Update Config

```bash
POST /arb/executor/config

curl -X POST http://localhost:3001/arb/executor/config \
  -H "Content-Type: application/json" \
  -d '{
    "minProfitBps": 100,
    "maxConcurrentExecutions": 2
  }'
```

## Execution Flow

1. **Detection**: arb-rs detects opportunity
2. **Filtering**: Executor checks:
   - Profit >= minProfitBps
   - Not in flight
   - Not on cooldown
   - Passes reserve/hop limits
   - Not blacklisted
   - Rate limits not exceeded
3. **Execution**:
   - Resolve plan (quote amounts)
   - Build transaction
   - Simulate or send on-chain
4. **Tracking**:
   - Mark as executed in arb-rs
   - Record in tx history
   - Emit to frontend
   - Update cooldown

## Safety Features

### Concurrency Control
- Max concurrent executions (default: 1)
- Prevents parallel execution of same opportunity
- Global 100ms minimum between any executions

### Rate Limiting
- Per-minute execution cap
- Per-opportunity cooldown (default: 5s)
- Prevents spam/overtrading

### Risk Management
- Profit threshold filtering
- Reserve size filtering
- Hop count limiting
- Path blacklisting
- Execution timeouts

### Error Handling
- Graceful WebSocket reconnection
- Transaction failure tracking
- Success rate monitoring
- Detailed error logging

## Monitoring

### Logs
All executor actions are logged with category `arb`:
- `arb.executor.starting` - Executor starting
- `arb.executor.attempt` - Attempting execution
- `arb.executor.success` - Successful execution
- `arb.executor.failed` - Failed execution
- `arb.executor.blacklisted` - Path filtered by blacklist

### Metrics
Check `/arb/executor/status` for:
- Total executions
- Success rate
- Current in-flight transactions
- Rate limit status

### Frontend Events
The executor emits Socket.IO events:
- `arb:execution` - Successful execution
- `arb:execution:failed` - Failed execution

## Example Usage

### Conservative Setup (Recommended for Testing)
```json
{
  "enabled": true,
  "minProfitBps": 100,
  "maxConcurrentExecutions": 1,
  "sizeUsd": 50,
  "slippageBps": 100,
  "maxExecutionsPerMinute": 5,
  "cooldownMs": 10000
}
```

### Aggressive Setup (Production)
```json
{
  "enabled": true,
  "minProfitBps": 50,
  "maxConcurrentExecutions": 2,
  "sizeUsd": 500,
  "slippageBps": 50,
  "maxExecutionsPerMinute": 20,
  "cooldownMs": 3000
}
```

### Blacklist Example
```json
{
  "blacklistedPaths": [
    "USDT",
    "illiquid-token-address"
  ]
}
```

Any path containing these strings will be filtered out.

## Troubleshooting

### Executor not executing anything
1. Check `enabled: true` in config
2. Verify arb-rs is running and detecting opportunities
3. Check profit threshold isn't too high
4. Verify execution mode in `backend/config/execution.json`
5. Check rate limits aren't exceeded

### High failure rate
1. Increase `slippageBps`
2. Reduce `sizeUsd`
3. Increase `minReservesUsd`
4. Check network congestion
5. Review logs for specific errors

### WebSocket connection issues
1. Verify arb-rs is running on port 4010
2. Check `ARB_SERVICE_URL` environment variable
3. Review logs for connection errors
4. Executor auto-reconnects every 5s

## Development

### Adding Custom Filters

Edit `shouldExecute()` in `arbExecutor.ts`:

```typescript
private shouldExecute(opp: Opportunity): boolean {
  // Add custom logic here
  if (opp.path.includes('MY-TOKEN')) {
    return false;
  }
  // ... existing checks
  return true;
}
```

### Execution Modes

The executor respects `backend/config/execution.json`:
- `mode: "simulate"` - Only simulate (safe for testing)
- `mode: "direct"` - Execute on-chain (production)
- `mode: "jupiter"` - Use Jupiter for execution

## Best Practices

1. **Start with simulation mode** - Test thoroughly before live trading
2. **Use conservative profit thresholds** - Account for slippage and fees
3. **Monitor success rates** - Adjust parameters if < 80%
4. **Start with low size** - Scale up gradually
5. **Use cooldowns** - Prevent over-trading same paths
6. **Monitor gas costs** - Ensure they don't eat profits
7. **Blacklist problematic paths** - Remove consistently failing routes
8. **Watch for MEV** - Be aware of sandwich attacks on profitable arbs

