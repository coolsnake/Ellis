# Raydium AMM Market Accounts Debugging

## Date
November 10, 2025

## Problem
After implementing market account fetching for Raydium AMM pools, swaps are still failing with missing account errors. Pool cache shows NO market account fields.

## Investigation

### Pool Type Confirmed
Pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2` is a **Standard AMM pool** (type: "Standard", programId: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`).

According to research:
- **Legacy AMM pools** (Standard type) **DO require** all Serum/OpenBook market accounts
- **CPMM pools** (newer) do NOT require Serum accounts
- This pool uses the legacy AMM model that integrates with Serum order books

### Required Accounts
For legacy Raydium AMM swaps to work, these accounts are required:
1. `market_id` - Serum market address
2. `market_program_id` - Serum/OpenBook program ID
3. `market_bids` - Order book bids
4. `market_asks` - Order book asks
5. `market_event_queue` - Event queue for order matching
6. `market_base_vault` - Market base token vault
7. `market_quote_vault` - Market quote token vault
8. `market_authority` - PDA that signs for market operations
9. `amm_authority` - Pool authority
10. `amm_open_orders` - AMM's open orders on Serum
11. `amm_target_orders` - AMM's target orders

### Root Cause Analysis

The implementation in `raydium.ts` (lines 742-857) **looks correct**:
1. ✅ Checks if enabled via config (default: true)
2. ✅ Fetches pool account from chain
3. ✅ Decodes AMM state to get market ID
4. ✅ Fetches Serum market accounts
5. ✅ Updates pool objects with all fields

**Potential Issues Identified:**

1. **No logging evidence**: User confirmed a full refresh was done, but we haven't seen logs showing whether:
   - `raydium.amm.market_accounts.fetch.start` was logged
   - `raydium.amm.market_accounts.fetch.complete` was logged
   - Any errors for this specific pool

2. **Possible silent failures**: The fetch logic has try-catch that silently increments `skipCount` on errors

3. **Canonicalization concern**: Market accounts are correctly preserved during `swapABFields` since they don't match the `_a`/`_b` pattern (verified)

## Changes Made

### 1. Enhanced Logging in `raydium.ts`

**Added comprehensive debug logging:**

- **Before canonicalization**: Log sample pool to verify market accounts are present after fetch
- **After canonicalization**: Log same pool to verify fields survived canonicalization
- **Per-pool warnings**: Log when pool accounts or market accounts fetch fails
- **Target pool tracking**: Special logging for our specific problem pool

### 2. Updated `swapABFields` in `common.ts`

Added documentation clarifying that market account fields are orientation-independent and correctly preserved during canonicalization.

## Next Steps

### Immediate Action Required

**Trigger a fresh pool fetch with the new logging:**

1. Restart backend service
2. Monitor logs for:
   ```
   raydium.amm.market_accounts.fetch.start
   raydium.amm.market_accounts.no_market_id (warnings)
   raydium.amm.market_accounts.no_market_accounts (warnings)
   raydium.amm.market_accounts.fetch.pool.err (warnings)
   raydium.amm.market_accounts.target_pool_enriched (for our specific pool)
   raydium.amm.before_canon.sample
   raydium.amm.after_canon.sample
   raydium.amm.market_accounts.fetch.complete
   ```

### Expected Outcomes

**Success case:**
- Logs show `raydium.amm.market_accounts.fetch.start` with pool count
- Logs show `raydium.amm.market_accounts.target_pool_enriched` for our pool with `hasMarketBids: true`
- Logs show `before_canon.sample` and `after_canon.sample` both have market fields
- Pool cache file is updated with all market account fields
- Subsequent swaps succeed

**Failure cases and diagnosis:**

1. **No fetch logs at all**:
   - Check: `CONFIG.raydium.fetchMarketAccounts` might be `false`
   - Check: Are there any AMM pools after normalization?

2. **Fetch logs but skipCount high**:
   - Check for `raydium.amm.market_accounts.no_market_id` warnings
   - Issue: Pool account fetch or decode failing
   - Solution: Check RPC connectivity, rate limits

3. **Pool enriched but fields lost**:
   - Check `before_canon` vs `after_canon` logs
   - Issue: Canonicalization bug (unlikely now)

4. **Market accounts fetch returns null**:
   - Check for `raydium.amm.market_accounts.no_market_accounts` warnings
   - Issue: Serum market account decode failing
   - Check: Market ID validity, program ID correct

## Configuration Check

Ensure in your config:
```json
{
  "raydium": {
    "fetchMarketAccounts": true,  // Must NOT be false
    "marketAccountConcurrency": 3, // Default
    "marketAccountBatchSize": 10,  // Default
    "marketAccountBatchDelayMs": 100  // Default
  }
}
```

## Files Modified

1. **backend/src/server/pools/raydium.ts**
   - Lines 769-850: Enhanced error logging and debug tracking
   - Lines 859-902: Added before/after canonicalization logging

2. **backend/src/server/pools/common.ts**
   - Lines 45-50: Added documentation about market account preservation

## References

- Official Raydium docs: Legacy AMM pools require Serum integration
- Serum market layout: Fixed offsets at bytes 101, 133, 165, 197, 229, 357
- Custom Error 24: "Missing required account" error from Raydium program

## Success Criteria

✅ Backend restart triggers market account fetch  
✅ Logs show successful enrichment for target pool  
✅ Pool cache contains all 11 market account fields  
✅ Swap instruction builds with all required accounts  
✅ Transaction executes on-chain successfully  


