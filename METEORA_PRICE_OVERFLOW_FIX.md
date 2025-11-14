# Meteora DLMM Price Calculation Overflow Fix

## Problem Summary

Meteora DLMM pools were experiencing cascading edge/node losses over time due to price calculation failures during WebSocket updates. The issue was particularly problematic because it would fail silently, causing edges to be dropped, which then caused nodes to become orphans and get cleaned up, leading to WebSocket unsubscriptions and a downward spiral.

## Root Causes

### 1. Exponent Overflow (Critical)
The original code used:
```typescript
const f = Math.pow(1.0001, Number(binStep));
const bPerA = Math.pow(f, Number(activeId)) * Math.pow(10, (decA - decB));
```

When `activeId` was very large (e.g., ±200,000), `Math.pow(f, activeId)` would:
- Return `Infinity` for very positive activeId
- Return `0` for very negative activeId  
- Both cases made the price calculation fail

### 2. Wrong Candidate Selection
The code always picked `candidates[0]` which was `1/bPerA`, causing systematic price orientation errors.

### 3. Silent Failure
When calculations failed, the code silently continued without setting a price, causing validation to drop the edge later for `no_price`.

## Solution

Replaced the calculation with a **log-space approach** that:

1. **Prevents overflow**: Uses logarithms to work in a stable numeric range
   ```typescript
   const logPrice = clampedActiveId * Math.log(f) + (decA - decB) * Math.log(10);
   const bPerA = Math.exp(logPrice);
   ```

2. **Clamps extreme values**: Limits activeId to ±100,000 to prevent extreme computations
   ```typescript
   const clampedActiveId = Math.max(-100000, Math.min(100000, Number(activeId)));
   ```

3. **Guards against overflow**: Checks if log price is within safe limits before exponentiating
   ```typescript
   if (Math.abs(logPrice) < 700) { // e^700 ≈ 1e304, safe limit
   ```

4. **Proper error logging**: Logs specific failure reasons for debugging
   - `meteora.ws.price.overflow` - When computed price is outside reasonable range
   - `meteora.ws.price.extreme` - When activeId/binStep would cause overflow
   - `meteora.ws.price.calc_failed` - When calculation throws an exception

5. **Correct orientation**: Explicitly computes `1/bPerA` with clear documentation

6. **Range validation**: Ensures final price is reasonable (`> 0` and `< 1e15`)

## Impact

This fix should:
- ✅ Prevent Meteora DLMM edges from being silently dropped
- ✅ Stop the cascading loss of nodes and edges over time
- ✅ Maintain stable WebSocket subscriptions to Meteora pools
- ✅ Provide clear diagnostic logs when price calculations fail
- ✅ Handle extreme price ratios gracefully without corrupting the graph

## Files Modified

- `backend/src/server/pools.ts` (lines 2439-2503)

## Testing Recommendations

1. Monitor logs for new warning messages:
   - `meteora.ws.price.overflow`
   - `meteora.ws.price.extreme`
   - `meteora.ws.price.calc_failed`

2. Watch graph stats for stable edge/node counts over time

3. Check that Meteora pools maintain WebSocket subscriptions

4. Verify price accuracy for Meteora DLMM pools with extreme price ratios

