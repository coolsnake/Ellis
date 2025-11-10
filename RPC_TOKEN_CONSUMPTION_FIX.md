# RPC Limiter Token Consumption Bug - Fixed

## Problem Identified

The rate limiter was hitting the safety check (101 iterations) but then **allowing calls through without consuming tokens**, causing:
- Unthrottled RPC request flood
- 429 "Too Many Requests" errors
- Rate limiter appearing to work but not actually limiting

## The Bug

In the `acquireRpcSlots` function, when the safety check was triggered:

```typescript
for (;;) {
  iterations++;
  refill();
  
  if (iterations > 100 || (Date.now() - acquireStart) > 30000) {
    console.error(`[RPC LIMITER] STUCK: ...`);
    break;  // ❌ BROKE OUT OF LOOP
  }
  
  if (tokens >= need) {
    tokens -= need;  // Only this path consumed tokens
    return;
  }
  await sleep(...);
}
// ❌ Function exits here after break - NO TOKENS CONSUMED!
```

**What happened:**
1. Request needs 1 token, but only 0.95 tokens available
2. Loops 101 times trying to get enough tokens
3. Safety check triggers: "STUCK" message logged
4. `break` exits the loop
5. Function returns **without consuming any tokens**
6. RPC call proceeds anyway
7. Next request repeats the same pattern
8. Result: Every request bypasses the limiter → RPC flood → 429 errors

## The Fix

Changed the safety check to **consume tokens and return immediately**:

```typescript
for (;;) {
  iterations++;
  refill();
  
  // Safety check: if we've been waiting too long, force through
  if (iterations > 100 || (Date.now() - acquireStart) > 30000) {
    console.error(`[RPC LIMITER] STUCK: waited ${Date.now() - acquireStart}ms, ${iterations} iterations, need=${need}, tokens=${tokens}, maxRps=${maxRps}, capacity=${capacity}`);
    console.error('[RPC LIMITER] Force-allowing call to prevent deadlock');
    // ✅ CONSUME TOKENS (even if not enough)
    tokens = Math.max(0, tokens - need);
    return; // ✅ EXIT IMMEDIATELY
  }
  
  if (tokens >= need) {
    tokens -= need;
    // ... gap chain ...
    return;
  }
  await sleep(...);
}
```

**Key changes:**
1. ✅ Consume tokens before returning (even if going negative, we clamp to 0)
2. ✅ Return immediately instead of breaking
3. ✅ Log additional message to indicate force-allowing
4. ✅ Prevents calls from bypassing the limiter

## Why This Works Better

**Before (Broken):**
- Safety check → break → fall through → no tokens consumed → flood continues

**After (Fixed):**
- Safety check → consume tokens → return → call proceeds but tokens were consumed → next call has to wait for refill

Even when the safety check triggers, we're still:
- Consuming tokens (maintaining rate limit state)
- Allowing the call through (preventing deadlock)
- Forcing subsequent calls to wait for token refill

## Expected Results

After rebuilding and restarting:

1. **Fewer STUCK messages** - should only happen during extreme load bursts
2. **No 429 floods** - rate limiting actually works
3. **Smooth operation** - requests properly throttled
4. **If STUCK occurs** - subsequent calls will be properly rate-limited

You might still see occasional STUCK messages during high load, but:
- They won't cause 429 floods anymore
- The limiter will recover gracefully
- Each STUCK call still counts against the rate limit

## Testing

1. **Rebuild:**
   ```bash
   cd backend && npm run build
   ```

2. **Restart:**
   ```bash
   npm run dev
   ```

3. **Monitor logs:**
   - Should see far fewer STUCK messages
   - Should see NO 429 error floods
   - If STUCK appears, next line should say "Force-allowing call to prevent deadlock"

4. **Check RPC Monitor UI:**
   - Should show reasonable request rates
   - Success rates should be high
   - No massive error spikes

## Files Modified

- `backend/src/utils/rpcLimiter.ts` - Fixed acquireRpcSlots to consume tokens when safety check triggers

## Related Fixes

This complements the earlier NaN fix. Together they ensure:
1. Configuration is always valid (NaN fix)
2. Safety check doesn't bypass the limiter (this fix)
3. Rate limiting actually works under all conditions

