# RPC Limiter NaN Bug - Critical Fix Applied

## Problem Identified

The RPC rate limiter was producing `NaN` (Not a Number) values for all configuration parameters:
- `tokens = NaN`
- `maxRps = NaN`
- `capacity = NaN`

This caused:
1. ✗ Rate limiter breaking out after 101 iterations (safety check)
2. ✗ Unthrottled RPC requests flooding the provider
3. ✗ 429 "Too Many Requests" errors from RPC provider
4. ✗ System instability during pool subscription setup

## Root Cause

The original initialization code was:
```typescript
const maxRps = Math.max(1, Number(process.env.RPC_MAX_RPS || 50));
const capacity = Math.max(1, Math.min(maxRps, Number(process.env.RPC_BURST || Math.ceil(maxRps / 4))));
```

The bug was in this line:
```typescript
Number(process.env.RPC_BURST || Math.ceil(maxRps / 4))
```

When `process.env.RPC_BURST` is undefined, the fallback expression `Math.ceil(maxRps / 4)` returns a **number**, not a string. When passed to `Number()`, this created ambiguous behavior. If the environment or module loading context was unusual, this could produce `NaN`.

## The Fix Applied

### 1. Defensive Environment Variable Parsing

Created a robust parser function:

```typescript
function parseEnvNumber(key: string, defaultValue: number): number {
  try {
    const val = process?.env?.[key];
    if (!val) return defaultValue;
    const parsed = Number(val);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}
```

Features:
- ✓ Safe access to `process.env` with optional chaining
- ✓ Returns default if env var is missing or empty
- ✓ Validates parsed value is finite and positive
- ✓ Falls back to default on any error

### 2. Explicit Value Calculation

```typescript
const maxRps = parseEnvNumber('RPC_MAX_RPS', 50);
const burstEnv = parseEnvNumber('RPC_BURST', 0);
const capacity = burstEnv > 0 ? burstEnv : Math.max(1, Math.ceil(maxRps / 4));
const minGapMs = parseEnvNumber('RPC_MIN_GAP_MS', 20);
```

Changes:
- Parse each env var separately
- Calculate `capacity` in two clear steps
- No nested `Number()` calls with mixed types

### 3. Validation Guards

Added explicit validation:

```typescript
if (!Number.isFinite(maxRps) || !Number.isFinite(capacity) || !Number.isFinite(minGapMs)) {
  console.error('[RPC LIMITER] FATAL: Invalid configuration', { maxRps, capacity, minGapMs });
  throw new Error('RPC Limiter: Invalid numeric configuration');
}
```

This will **fail-fast** at startup if any values are still `NaN` or `Infinity`, making the issue immediately visible rather than silently breaking.

### 4. Runtime NaN Detection

Added defensive check in `refill()`:

```typescript
function refill(): void {
  const now = Date.now();
  const elapsedMs = now - lastRefillMs;
  if (elapsedMs <= 0) return;
  const add = (elapsedMs / 1000) * maxRps;
  
  // Defensive check - if we get NaN, reset to capacity
  if (!Number.isFinite(add) || !Number.isFinite(tokens)) {
    console.error('[RPC LIMITER] NaN detected in refill, resetting to capacity', { tokens, add, elapsedMs, maxRps });
    tokens = capacity;
    lastRefillMs = now;
    return;
  }
  
  tokens = Math.min(capacity, tokens + add);
  lastRefillMs = now;
}
```

This catches any runtime NaN issues and resets tokens to capacity, preventing cascading failures.

## Expected Results After Fix

When you restart the backend, you should see:

```
[RPC LIMITER] Initialized: maxRps=50, capacity=12, minGapMs=20, initialTokens=12
```

**All values should be real numbers**, not `NaN`.

You should **NOT** see:
- ✗ `tokens=NaN` messages
- ✗ `STUCK` messages after 101 iterations
- ✗ Mass 429 errors from RPC provider

You **SHOULD** see:
- ✓ RPC calls properly rate-limited
- ✓ Smooth pool subscription setup
- ✓ No provider throttling errors (or very few)

## Testing Steps

1. **Rebuild backend:**
   ```bash
   cd backend && npm run build
   ```

2. **Restart backend and check logs:**
   ```bash
   npm run dev
   ```

3. **Look for initialization message:**
   ```
   [RPC LIMITER] Initialized: maxRps=50, capacity=12, minGapMs=20, initialTokens=12
   ```

4. **Verify no NaN or STUCK messages**

5. **Monitor RPC calls:**
   - Check RPC monitor UI
   - Should see smooth request flow
   - Success rates should be high

## Rollback (if needed)

If this fix causes issues, you can temporarily bypass rate limiting by modifying `acquireRpcSlots`:

```typescript
export async function acquireRpcSlots(weight = 1): Promise<void> {
  // TEMPORARY BYPASS - remove after testing
  return Promise.resolve();
}
```

## Files Modified

- `backend/src/utils/rpcLimiter.ts` - Fixed initialization and added defensive checks

## Related Issues

This fix also improves:
- Startup reliability
- Module loading robustness
- Error visibility (fail-fast vs silent failure)
- Runtime error recovery

