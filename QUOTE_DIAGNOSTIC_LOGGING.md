# Quote Diagnostic Logging Added

## Issue
The multi-hop swap tests were failing because quotes were returning 0, not because of amount propagation issues. The logs showed:
- First hop: `amountInRaw: "10000000"` (0.01 SOL)
- Quote result: `quotedOut: "0"`
- Second hop: `amountInRaw: "0"` (no output to propagate)

This indicated that the quoting functions were failing silently.

## Root Cause
The CLMM quote functions for Raydium and Meteora were using cached pool data and simple price-based calculations. When these failed (due to missing price data, incorrect decimals, or other issues), they simply returned `0n` without logging why.

## Solution
Added comprehensive diagnostic logging to the quote functions to track:

### Raydium CLMM Quote Logging
1. **quote.attempt** - Logs when quoting starts:
   - Pool ID
   - Amount in (raw)
   - Input/output mints and decimals
   - Whether Raydium pool data is available
   - CLMM pool count

2. **quote.pool_not_found** - When the pool isn't in cache:
   - Requested pool ID
   - Available pool IDs (first 5)
   - Whether it's a reversed pool

3. **quote.no_price_ratio** - When price data is missing:
   - Pool's price_a_per_b fields
   - What price data is available

4. **quote.invalid_decimal_scale** - When decimal conversion fails:
   - Input/output decimal candidates
   - Calculated scales

5. **quote.zero_denominator** - When calculation would divide by zero:
   - All components of the denominator

6. **quote.calculated** - Final calculation result:
   - Input amount
   - Output amount
   - Success status
   - All calculation components (price numerator/denominator, scales, fees, decimals)

### Meteora DLMM Quote Logging
1. **quote.attempt** - Logs when quoting starts:
   - Pool ID (original and stripped)
   - Amount in (raw)
   - Input/output mints and decimals
   - Whether pool was found
   - CLMM pool count

2. **quote.pool_data** - Pool data details:
   - Fee (bps and multiplier)
   - Decimals (in/out)
   - Price (price_a_per_b)
   - Full pool data object (mints, decimals, fee, price)

3. **quote.calculation** - Calculation details:
   - Input amount (raw and converted)
   - Output (whole and raw)
   - Formula used (based on direction)
   - Success status

4. **quote.invalid_amtIn** - When amount conversion fails:
   - Amount in raw
   - Decimal in
   - Converted amount
   - Whether it's finite

5. **quote.no_price** - When price is missing or zero:
   - Price value
   - Whether pool has price field

6. **quote.invalid_decimals** - When decimals are not finite:
   - Decimal in/out values
   - Whether each is finite

7. **quote.pool_not_found** - When pool isn't in cache:
   - Requested pool ID
   - Available pool IDs (first 5)

## How to Use

After restarting the backend, run your multi-hop tests again:

```bash
arb multihop sim meteora 0.01 50
arb multihop sim raydium-clmm 0.01 50
```

Check the logs for messages like:
- `meteora.dlmm.quote.attempt` - See if quoting starts
- `meteora.dlmm.quote.pool_data` - See what pool data we have
- `meteora.dlmm.quote.no_price` - See if price is missing
- `meteora.dlmm.quote.calculation` - See the calculation details
- `raydium.clmm.quote.pool_not_found` - See if pool isn't in cache
- `raydium.clmm.quote.no_price_ratio` - See if price ratio is missing

These logs will show exactly why the quotes are failing:
- Missing pool in cache
- Missing price data
- Invalid decimals
- Calculation errors

## Next Steps

Based on the diagnostic logs, you may need to:

1. **If pools are not found in cache:**
   - Check if pool data is being fetched properly
   - Verify pool IDs match between graph and pool cache

2. **If price data is missing:**
   - Check if price updates are working
   - Consider enabling SDK fallback quotes

3. **If you want to force SDK quotes instead of cached prices:**
   ```bash
   # Add to .env or config
   SYSTEM_QUOTES_ENABLE_MINIMAL_MATH=false
   ```
   This will bypass the fast cached quotes and use SDK quotes directly (slower but more reliable)

## Files Modified
- `backend/src/execution/resolver/quotes.ts` - Added diagnostic logging to quote functions

