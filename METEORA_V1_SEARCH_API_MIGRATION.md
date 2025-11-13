# Meteora V1 Search API Migration

## Summary

Successfully migrated the Meteora V1 balanced pool fetcher to use the new `/pools/search` endpoint with improved filtering and pagination capabilities.

## Changes Made

### 1. New Endpoint Usage

**Before:**
- Endpoint: `https://damm-api.meteora.ag/pools`
- Query params: `?address=<token_mint>`
- Required **2 separate requests** (one for SOL, one for USDC) with manual deduplication

**After:**
- Endpoint: `https://damm-api.meteora.ag/pools/search`
- Query params: Multiple advanced filters including `include_token_mints[]`
- **Single request** returns all pools containing SOL or USDC
- Built-in pagination support

### 2. Updated Function: `fetchMeteoraBalancedV1Http`

Location: `backend/src/server/pools/meteoraBalanced.ts` (lines 521-721)

**Key Improvements:**

#### a) URL Construction
```typescript
// Converts base URL from /pools to /pools/search
const searchBase = base.replace(/\/pools\/?$/, '/pools/search');
```

#### b) Token Filtering
```typescript
// Single request with multiple token mints
const tokenMints = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
];

for (const mint of tokenMints) {
  sp.append('include_token_mints', mint);
}
```

#### c) Pagination Support
```typescript
const maxPages = Number(cfg.maxPages || 10);
const pageSize = Number(cfg.pageSize || 100);

while (hasMore && page < maxPages) {
  sp.append('page', String(page));
  sp.append('size', String(pageSize));
  // ... fetch and accumulate results
}
```

#### d) Quality Filters
```typescript
// Pool type filter (V1 = dynamic pools)
sp.append('pool_type', 'dynamic');

// Sorting by TVL for quality
sp.append('sort_key', 'tvl');
sp.append('order_by', 'desc');

// Existing filters still supported
if (minLiqBase > 0) sp.append('hide_low_tvl', String(minLiqBase));
if (hideLowApr) sp.append('hide_low_apr', 'true');
```

### 3. New Helper Function: `fetchV1SearchWithRetry`

Location: `backend/src/server/pools/meteoraBalanced.ts` (lines 723-825)

**Purpose:** Handles both new search API and legacy response formats

**Response Handling:**
```typescript
// Supports two response formats:
// 1. New: { data: [...], page: number, total_count: number }
// 2. Legacy: [...] (direct array)

let pools: any[] = [];
if (Array.isArray(poolsData)) {
  pools = poolsData;
} else if (poolsData?.data) {
  pools = Array.isArray(poolsData.data) ? poolsData.data : [poolsData.data];
}
```

## Benefits

### 1. Performance
- **Reduced API calls:** 2 requests → 1 request (50% reduction)
- **Better pagination:** Can fetch large result sets efficiently
- **Automatic deduplication:** API handles this internally

### 2. Functionality
- **More accurate filtering:** Native token filtering in the API
- **Quality sorting:** TVL-based sorting ensures best pools first
- **Pool type filtering:** Ensures only V1 (dynamic) pools are fetched

### 3. Maintainability
- **Official API endpoint:** Uses documented `/pools/search` endpoint
- **Future-proof:** Supports pagination for scaling
- **Better logging:** Enhanced logging for both response formats

## Configuration

The implementation uses existing configuration options from the UI:

```typescript
{
  meteoraBalanced: {
    apiUrl: "https://damm-api.meteora.ag/pools",  // Auto-converted to /pools/search
    maxPages: 10,                                  // Pagination limit
    pageSize: 100,                                 // Results per page
    anchorTokensOnly: true,                        // Filter for SOL/USDC
    hideLowApr: true,                              // Quality filter
    minLiqBase: 1000,                              // Minimum TVL filter
    maxHttpRetries: 2,
    httpBackoffMs: 500
  }
}
```

## API Documentation Reference

Official Meteora API docs: https://docs.meteora.ag/api-reference/pools/filter_and_get_pool_info

**Endpoint:** `GET /pools/search`

**Query Parameters:**
- `page` (integer, required): Page number (≥ 0)
- `size` (integer, required): Page size (≥ 0)
- `include_token_mints` (string[]): Filter pools by token mints
- `pool_type` (enum): `dynamic`, `multitoken`, `lst`, `farms`
- `sort_key` (enum): `tvl`, `volume`, `fee_tvl_ratio`, `l_m`
- `order_by` (enum): `asc`, `desc`
- `hide_low_tvl` (number): Minimum TVL threshold
- `hide_low_apr` (boolean): Hide low APR pools

**Response:**
```json
{
  "data": {...},
  "page": 1,
  "total_count": 1
}
```

## Backwards Compatibility

The implementation maintains backwards compatibility:

1. **Legacy response format:** Still handles direct array responses
2. **Existing config options:** All existing settings work as before
3. **Fallback behavior:** Returns empty array on errors
4. **Logging:** Enhanced logging shows which format is used

## Testing Recommendations

1. **Verify pool counts:** Compare results before/after migration
2. **Check deduplication:** Ensure no duplicate pools
3. **Validate pagination:** Test with different `maxPages` and `pageSize` values
4. **Monitor API rate limits:** 200ms delay between requests
5. **Test both modes:**
   - `anchorTokensOnly: true` (SOL/USDC filter)
   - `anchorTokensOnly: false` (all pools)

## Next Steps

1. ✅ **Implementation complete**
2. 🔲 **Test in development environment**
3. 🔲 **Monitor API response times and success rates**
4. 🔲 **Adjust pagination parameters based on performance**
5. 🔲 **Update related tests if needed**

## Related Files

- `backend/src/server/pools/meteoraBalanced.ts` - Main implementation
- `backend/src/server/pools/httpLog.ts` - HTTP logging utilities
- Config controls via UI modal (already implemented)

## Migration Date

November 13, 2025

