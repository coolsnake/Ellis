# WebSocket Subscription RPS Spike Diagnosis

## Current Status

You're still seeing RPS spikes with `accountSubscribe` calls. Let's diagnose what's happening.

## What We Know

### Configuration
- **RPC_MAX_RPS**: 50/sec (default)
- **RPC_BURST (capacity)**: 12 tokens (default)
- **RPC_MIN_GAP_MS**: 20ms (default)
- **Effective max throughput**: 50 RPS (enforced by gap chain)

### Subscription Load
With the account subscription fix, each pool triggers:
- **Orca Whirlpool**: 1 pool + 2 vaults + 1 oracle + 3 tick arrays = **7 subscriptions**
- **Raydium CLMM**: 1 pool + 2 vaults + 1 observation + 1 oracle + 3 tick arrays = **8 subscriptions**
- **Raydium AMM**: 1 pool + 2 vaults = **3 subscriptions**
- **Meteora DLMM**: 1 pool + 2 reserves + 1 oracle + dynamic bin arrays = **5+ subscriptions**

If you have **100 active pools**, that's **500-800 subscription calls** that need to be processed.

At **50 RPS**, that takes **10-16 seconds** to process all subscriptions.

## Possible Causes

### 1. **Token Bucket Burst (MOST LIKELY)**

**Issue**: The token bucket starts with 12 tokens (capacity). When subscriptions start, the first 12 calls go through almost immediately, creating a burst.

**Evidence**: RPS spikes to 90-100 initially, then settles.

**Why**: Multiple subscription helper functions (`attachOrcaWhirlpoolAccounts`, etc.) are called simultaneously, each queueing 5-7 subscriptions. The first 12 grab tokens quickly before the refill rate catches up.

**Solution**: Reduce `RPC_BURST` capacity to limit initial burst.

```bash
# Reduce burst capacity
RPC_BURST=5  # Only allow 5 tokens max (down from 12)
```

### 2. **Multiple Concurrent Helper Functions**

**Issue**: When a pool is being subscribed, `attachOrcaWhirlpoolAccounts` (or similar) fires off 5-7 subscription calls in rapid succession without waiting between them. If 10 pools are being processed simultaneously, that's 50-70 calls queued instantly.

**Evidence**: Logs show multiple pools being processed at the same time.

**Why**: The outer loop has delays between pools (`wsAttachPerSec=10/sec`), but the inner helper functions fire all subscriptions for a single pool immediately.

**Solution Options**:

#### Option A: Reduce Initial Token Capacity
```bash
# Conservative settings
RPC_MAX_RPS=40
RPC_BURST=4
RPC_MIN_GAP_MS=25
```

#### Option B: Increase Min Gap
```bash
# Force more time between calls
RPC_MIN_GAP_MS=30  # 30ms gap = max ~33 RPS effective
```

#### Option C: Add Delays in Helper Functions
Add small delays between subscriptions within `attachOrcaWhirlpoolAccounts`, etc.:

```typescript
// After each subscription
await subscribeAccountWithRetry(...);
await sleep(5); // 5ms delay between subscriptions within a pool
```

### 3. **RPC Provider's Rate Limit Window**

**Issue**: Your RPC provider might be measuring RPS in smaller time windows (e.g., per 100ms) rather than per full second.

**Evidence**: You see RPS spikes but they average out over time.

**Why**: If the provider checks "calls in last 100ms" and you send 10 calls in one 100ms window, that's 100 RPS from their perspective even though your average is 50 RPS.

**Solution**: Increase `RPC_MIN_GAP_MS` to spread calls more evenly.

### 4. **Gap Chain Not Enforcing Properly**

**Issue**: The gap chain might not be properly serializing all calls if there's a race condition.

**Evidence**: Multiple calls completing at nearly the same timestamp.

**Why**: If the gap chain promise handling has a bug, multiple calls could slip through.

**Solution**: Need to investigate `acquireRpcSlots()` implementation.

## Diagnostic Steps

### Step 1: Check What RPS You're Actually Seeing

**Question**: What RPS values are you seeing?
- Initial burst: ____
- Sustained rate: ____
- Are you getting 429 errors?: Yes / No

### Step 2: Check Time Window

**Question**: What time window is your RPS monitoring using?
- Per second (1000ms)
- Per 100ms
- Per 10ms
- Other: ____

### Step 3: Try Conservative Settings

Set these environment variables and restart:

```bash
# Very conservative - should eliminate ALL spikes
RPC_MAX_RPS=30
RPC_BURST=3
RPC_MIN_GAP_MS=35
```

With these settings:
- Max theoretical: 30 RPS
- Initial burst: only 3 calls
- Forced gap: 35ms = ~28 RPS effective max

**Does this eliminate the spikes?** Yes / No

If YES → Problem is burst capacity or gap enforcement
If NO → Problem is elsewhere (multiple connections, bypass, etc.)

### Step 4: Check for Multiple RPC Connections

**Question**: Are you creating multiple WebSocket/RPC connections?

Check logs for:
```
[RPC LIMITER] Initialized: maxRps=...
```

**How many times does this appear?** If it appears multiple times, you have multiple rate limiters running (one per connection), and each one allows 50 RPS!

### Step 5: Enable Detailed RPC Logging

Add this to see exactly when subscriptions are being made:

```typescript
// In subscribeAccountWithRetry, after withRpcLimit call
console.log(`[SUB ${Date.now()}] ${accountPk.toBase58().slice(0,8)}...`);
```

Look for patterns:
- Are they evenly spaced (20-30ms apart)? → Gap working
- Are they clustered (multiple within same ms)? → Gap NOT working

## Recommended Fix

Based on the symptoms, I recommend **reducing the burst capacity**:

```bash
# Add to your .env or environment
RPC_MAX_RPS=50       # Keep this the same
RPC_BURST=5          # Reduce from 12 to 5
RPC_MIN_GAP_MS=22    # Slightly increase from 20 to 22
```

This will:
- ✅ Limit initial burst to 5 calls instead of 12
- ✅ Maintain 50 RPS sustained rate
- ✅ Slightly increase gap between calls for smoother distribution

## Alternative: Sequential Pool Subscription

If reducing burst doesn't help, we can make the pool subscription loops fully sequential (process one pool at a time, including all its derived accounts, before moving to the next):

```typescript
// In the Orca subscription loop
for (const pool of pools) {
  await subscribeAccountWithRetry(pool, handle);
  await attachOrcaWhirlpoolAccounts(pool);  // Wait for all derived accounts
  // Move to next pool only after this one is fully subscribed
}
```

This would be MUCH slower but would guarantee no bursts.

## Questions for You

1. **What exact RPS values are you seeing?** (initial burst and sustained)
2. **Are you getting 429 errors from your RPC provider?**
3. **What time window does your RPC monitoring use?**
4. **How many times does `[RPC LIMITER] Initialized` appear in your logs?**

Please provide these answers and I can give you a more targeted solution!

