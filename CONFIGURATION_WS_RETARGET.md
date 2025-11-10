# WebSocket Retarget Configuration Guide

## Environment Variables

Add these to your `.env` file to configure the sequential WebSocket retarget throttling:

### WebSocket Retarget Throttling (New)

```bash
# Cooldown period after unsubscribing all pools before starting resubscription
# This allows the RPC limiter to refill tokens
WS_RETARGET_COOLDOWN_MS=2000

# Stagger delay between each DEX source during retarget
# Orca completes → wait → Raydium starts → wait → Meteora starts
WS_RETARGET_STAGGER_MS=3000

# Subscription rate during retarget (pools per second)
# Slower than normal rate to avoid overwhelming RPC during burst
# Default: half of WS_ATTACH_PER_SEC
WS_RETARGET_ATTACH_PER_SEC=5

# How long to wait for all subscriptions to complete
# Should account for: cooldown + all_subscriptions + all_staggers
# Example: 2s + 6s (orca) + 3s + 8s (raydium) + 3s + 4s (meteora) = 26s
WS_RETARGET_ATTACH_WAIT_MS=15000
```

### WebSocket Subscriptions (Existing)

```bash
# Normal subscription rate (pools per second) during initial startup
WS_ATTACH_PER_SEC=10

# Enable WebSocket subscriptions for real-time pool updates
# Set to true for production, false to use polling only
ENABLE_POOL_WS=true
```

### RPC Rate Limiting (Existing)

```bash
# Maximum RPC requests per second
# Should match your RPC provider's rate limit
RPC_MAX_RPS=50

# Token bucket capacity for burst handling
# Recommend: match RPC_MAX_RPS for consistent burst capacity
RPC_BURST=50

# Minimum gap between consecutive RPC calls (milliseconds)
RPC_MIN_GAP_MS=20
```

## Configuration Scenarios

### Scenario 1: Standard Solana RPC (50 RPS)

**Pool Count:** ~100 pools across all DEXes
**RPC Limit:** 50 requests/second

```bash
# RPC Limits
RPC_MAX_RPS=50
RPC_BURST=50

# Normal subscriptions
WS_ATTACH_PER_SEC=10

# Retarget throttling
WS_RETARGET_COOLDOWN_MS=2000
WS_RETARGET_STAGGER_MS=3000
WS_RETARGET_ATTACH_PER_SEC=5
WS_RETARGET_ATTACH_WAIT_MS=20000
```

**Expected retarget time:** ~20-25 seconds
**Peak RPC usage:** ~5-8 calls/sec

### Scenario 2: Premium RPC Endpoint (100 RPS)

**Pool Count:** ~100 pools
**RPC Limit:** 100 requests/second

```bash
# RPC Limits
RPC_MAX_RPS=100
RPC_BURST=100

# Normal subscriptions
WS_ATTACH_PER_SEC=15

# Retarget throttling (can be faster)
WS_RETARGET_COOLDOWN_MS=1000
WS_RETARGET_STAGGER_MS=2000
WS_RETARGET_ATTACH_PER_SEC=10
WS_RETARGET_ATTACH_WAIT_MS=15000
```

**Expected retarget time:** ~15-18 seconds
**Peak RPC usage:** ~10-15 calls/sec

### Scenario 3: High Volume (200+ pools)

**Pool Count:** ~200 pools
**RPC Limit:** 50 requests/second

```bash
# RPC Limits
RPC_MAX_RPS=50
RPC_BURST=75

# Normal subscriptions
WS_ATTACH_PER_SEC=8

# Retarget throttling (very conservative)
WS_RETARGET_COOLDOWN_MS=3000
WS_RETARGET_STAGGER_MS=5000
WS_RETARGET_ATTACH_PER_SEC=3
WS_RETARGET_ATTACH_WAIT_MS=60000
```

**Expected retarget time:** ~60-70 seconds
**Peak RPC usage:** ~3-5 calls/sec

### Scenario 4: Development/Testing

**Pool Count:** ~20 pools
**RPC Limit:** 50 requests/second

```bash
# RPC Limits
RPC_MAX_RPS=50
RPC_BURST=50

# Normal subscriptions
WS_ATTACH_PER_SEC=10

# Retarget throttling (minimal delays for faster testing)
WS_RETARGET_COOLDOWN_MS=1000
WS_RETARGET_STAGGER_MS=1000
WS_RETARGET_ATTACH_PER_SEC=8
WS_RETARGET_ATTACH_WAIT_MS=5000
```

**Expected retarget time:** ~5-8 seconds
**Peak RPC usage:** ~8-10 calls/sec

## Tuning Guidelines

### If you see 429 errors during retarget:

1. **Increase cooldown:** `WS_RETARGET_COOLDOWN_MS=3000`
2. **Increase stagger:** `WS_RETARGET_STAGGER_MS=5000`
3. **Decrease rate:** `WS_RETARGET_ATTACH_PER_SEC=3`
4. **Increase wait time:** Add ~10 seconds per adjustment

### If retarget is too slow:

1. **Decrease cooldown:** `WS_RETARGET_COOLDOWN_MS=1000`
2. **Decrease stagger:** `WS_RETARGET_STAGGER_MS=2000`
3. **Increase rate:** `WS_RETARGET_ATTACH_PER_SEC=8`
4. **Monitor RPC metrics:** Ensure available tokens stay above 10

### If RPC limiter shows "STUCK" messages:

1. **Check RPC_BURST:** Should be ≥ RPC_MAX_RPS
2. **Verify RPC_MAX_RPS:** Matches your provider's actual limit
3. **Increase retarget cooldown:** Give more time for refill
4. **Check for other RPC activity:** Background tasks may be competing

## Monitoring

### Key Metrics to Watch

Monitor these in the RPC Monitor dashboard during retarget:

1. **Available Tokens:** Should stay above 10
2. **Queue Depth:** Should stay below 5
3. **Success Rate:** Should remain > 95%
4. **Current RPS:** Should stay below RPC_MAX_RPS

### Log Messages

Watch for these during retarget:

```
✅ Good:
[INFO] pools:ws retarget.start - sequential resubscription with throttling
[INFO] pools.ws sequential.mode { enabled: true, staggerMs: 3000 }
[INFO] pools.ws retarget.complete { attached: { orca: 30, raydium: 40, meteora: 20 } }

⚠️ Warning:
[WARN] pools:ws unhealthy after retarget
[RPC LIMITER] STUCK: waited 1710ms

❌ Error:
Server responded with 429 Too Many Requests
[ERROR] pools.ws setup failed
```

## Formulas

### Estimating Retarget Duration

```
Total Time = COOLDOWN + (Pools_Orca / Rate) + STAGGER + (Pools_Raydium / Rate) + STAGGER + (Pools_Meteora / Rate)

Example with defaults:
= 2s + (30/5)s + 3s + (40/5)s + 3s + (20/5)s
= 2 + 6 + 3 + 8 + 3 + 4
= 26 seconds
```

### Calculating Safe Rate

```
Safe Rate = RPC_MAX_RPS * 0.6  (60% of max for safety margin)

Example with 50 RPS:
Safe Rate = 50 * 0.6 = 30 RPS

If 3 DEXes subscribe in parallel:
Per-DEX Rate = 30 / 3 = 10 pools/sec

With sequential mode:
Single-DEX Rate = 30 RPS = 30 pools/sec (can be much faster!)
But we use 5 pools/sec for extra safety margin
```

## Troubleshooting

### Problem: Retarget never completes

**Solution:**
- Increase `WS_RETARGET_ATTACH_WAIT_MS`
- Check logs for subscription errors
- Verify WebSocket connection health

### Problem: Pools missing after retarget

**Solution:**
- Check `attached` counts in completion log
- Verify graph snapshot has correct pool IDs
- Look for subscription errors in logs
- Trigger manual retarget again

### Problem: System slow after retarget

**Solution:**
- Wait for all subscriptions to complete
- Check if retarget is still in progress
- Verify WebSocket health status
- Review RPC limiter metrics

## Best Practices

1. **Start conservative** - Use slower rates initially, then optimize
2. **Monitor first retarget** - Watch logs and RPC metrics closely
3. **Adjust gradually** - Change one parameter at a time
4. **Account for overhead** - RPC calls include retries, timeouts, etc.
5. **Test before production** - Verify configuration with actual pool counts
6. **Document your settings** - Note why you chose specific values

## Advanced: Dynamic Configuration

For production systems, consider adjusting based on:

1. **Time of day** - Slower during peak trading hours
2. **Pool count** - Scale stagger delay with pool count
3. **RPC health** - Slow down if high error rates detected
4. **Network conditions** - Adjust based on latency measurements

These can be implemented by modifying the config values at runtime before calling retarget.


