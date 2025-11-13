# Meteora sqrt_price_x64 Validation Fix

## Issue

Meteora DLMM pools were repeatedly failing WebSocket validation with `invalid_sqrt_price` errors:

```
[WARN] meteora.ws.validation.failed {
  "poolId":"FMhuUk4E…",
  "reasons":["invalid_sqrt_price"],
  "mint_a":"So111111…",
  "mint_b":"oreoU2P8…",
  "price_a_per_b":1.1798557334199604,
  "liquidity":0,
  "fee_bps":0,
  "tick_spacing":80
}
```

This was causing:
- Validation failures for legitimate Meteora pools
- Rejected WebSocket updates
- Incomplete pool data in the graph

## Root Cause

**Meteora DLMM uses a different pricing mechanism than Orca/Raydium CLMM:**

| Protocol | Pricing Mechanism | Field |
|----------|-------------------|-------|
| Orca Whirlpool | Square root price | `sqrt_price_x64` ✅ |
| Raydium CLMM | Square root price | `sqrt_price_x64` ✅ |
| **Meteora DLMM** | **Bin-based pricing** | `activeId` + `binStep` ✅ |

**Meteora's pricing formula:**
```typescript
price = (1.0001 ^ binStep) ^ activeId
```

The pool state **does not contain `sqrt_price_x64`** - it's not part of Meteora's on-chain data structure.

## Previous Behavior

The validation function (`validateDecodedPool`) checked ALL CLMM pools for valid `sqrt_price_x64`:

```typescript
// This failed for Meteora pools
if (pool.sqrt_price_x64 != null) {
  if (!Number.isFinite(pool.sqrt_price_x64) || pool.sqrt_price_x64 <= 0) {
    reasons.push('invalid_sqrt_price'); // ❌ Meteora pools rejected here
  }
}
```

## Solution

**Exclude Meteora from `sqrt_price_x64` validation** since it uses a different pricing model:

```typescript
// Validate sqrt_price_x64 for CLMM (except Meteora which uses bin-based pricing)
// Meteora DLMM doesn't store sqrt_price_x64; it calculates price from activeId/binStep
if (pool.sqrt_price_x64 != null && dex !== 'meteora') {
  if (!Number.isFinite(pool.sqrt_price_x64) || pool.sqrt_price_x64 <= 0) {
    reasons.push('invalid_sqrt_price');
    try { wsValidationStats[dex].invalidPrice += 1; } catch {}
  }
}
```

**File:** `backend/src/server/pools.ts` (lines 410-417)

## Why This Is Safe

1. **Meteora has alternative validation:** The `price_a_per_b` field (calculated from `activeId/binStep`) is still validated via the price check at lines 373-383:
   ```typescript
   if (pool.price_a_per_b != null) {
     if (!Number.isFinite(pool.price_a_per_b) || pool.price_a_per_b <= 0) {
       reasons.push('invalid_price');
     }
   }
   ```

2. **Other DEXes unaffected:** Orca and Raydium CLMM pools properly store `sqrt_price_x64` and continue to be validated

3. **No silent failures:** Meteora pools without valid `price_a_per_b` will still fail validation

## Expected Behavior After Fix

### Before
```
❌ meteora.ws.validation.failed {"reasons":["invalid_sqrt_price"]} (repeated 50+ times/second)
❌ Meteora pool updates rejected
❌ Stale Meteora pool data in graph
```

### After
```
✅ meteora.ws validation passed
✅ Meteora pool updates applied successfully
✅ Real-time Meteora price updates in graph
```

## Related Context

### Meteora Pool Decoding (lines 2184-2192)

The WebSocket handler correctly decodes Meteora pools:
```typescript
const sqrtPriceRaw = anyToBigInt(
  (state as any)?.sqrtPriceX64 ?? 
  (state as any)?.sqrt_price_x64 ?? 
  0  // Not found in Meteora state
);

// Price is calculated from activeId/binStep (lines 2166-2178)
if (Number.isFinite(activeId) && Number.isFinite(binStep) && decA != null && decB != null) {
  const f = Math.pow(1.0001, Number(binStep));
  const bPerA = Math.pow(f, Number(activeId)) * Math.pow(10, decA - decB);
  price_a_per_b = 1 / bPerA;  // ✅ This works correctly
}
```

### Meteora Bin Arrays

Meteora DLMM stores liquidity in **bin arrays** (not tick arrays like Orca/Raydium), further confirming it's a different CLMM model that doesn't use `sqrt_price_x64`.

## Verification

After deploying this fix, monitor logs for:

1. **Reduction in warnings:**
   ```bash
   # Should see near-zero of these
   grep "meteora.ws.validation.failed.*invalid_sqrt_price" logs
   ```

2. **Successful Meteora updates:**
   ```bash
   # Should see these instead
   grep "meteora.ws validation passed" logs
   grep "meteora pool update applied" logs
   ```

3. **Price updates in graph:**
   - Meteora pools should show real-time price updates
   - Check `/api/graph` for recent `updated_ms` timestamps on Meteora edges

## Testing

Test pools mentioned in the logs:
- `FMhuUk4EDLBykp5S6gw14fMbvKsFoFVg5YuuSvMn3fWh` (SOL/OREO)
- `3Mt1bpU3fnSXyPEm66HKKXyQTpLWrwYziPLqwTqK4ZT7` (SOL/OREO)
- `BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y` (SOL/USDC)
- `9ToMYnmEeYKc1AWYAFo8yjPKM1bt3vPhgw1U6qh9RxBd` (PONKE/USDC)

All should now validate successfully and receive WebSocket updates.

