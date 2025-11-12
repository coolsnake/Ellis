# Meteora Balanced V1 API Fetcher Fix

## Issue

The V1 fetcher was returning 0 pools due to incorrect API usage:
```
meteora.balanced.v1.fetch complete {"count":0,"hideLowTvl":false,"hideLowApr":false,"tokensVerified":false,"anchorTokens":2,"cat":"meteora"}
```

## Root Cause

Our V1 fetcher was using incorrect query parameters based on assumptions rather than the [official Meteora DAMM v1 API documentation](https://docs.meteora.ag/api-reference/pools/get_pools).

### Incorrect Implementation
```typescript
// ❌ Wrong: Pagination per anchor token
for (const addr of anchors) {
  for (let page = 0; page < maxPages; page++) {
    sp.append('address', addr);
    sp.append('limit', String(size));
    sp.append('page', String(page));
    sp.append('hide_low_tvl', 'true');  // Wrong: expects number
    sp.append('tokens_verified', 'true');  // Wrong: doesn't exist
  }
}
```

### API Specification (from official docs)

**Endpoint**: `GET https://damm-api.meteora.ag/pools`

**Query Parameters**:
- `address` (string[]) - Filter pools containing these token addresses
- `hide_low_tvl` (number | null) - Hide pools with TVL **below this value** (in USD)
- `hide_low_apr` (boolean | null) - Hide pools with low APR
- `unknown` (boolean | null) - Toggle unknown pools
- `pool_type` (enum) - Filter by pool type: dynamic, multitoken, lst, farms
- `is_monitoring` (boolean | null) - Toggle pools under monitoring
- `launchpad` (string[] | null) - Filter by launchpad

**Response**: Direct array of pool objects (no pagination)

```typescript
{
  pool_address: string;
  pool_token_mints: string[];
  pool_token_amounts: string[];
  pool_token_usd_amounts: string[];
  pool_tvl: string;
  total_fee_pct: string;
  // ... many more fields
}
```

## Fix Applied

### Corrected V1 Fetcher

```typescript
export async function fetchMeteoraBalancedV1Http(baseUrl?: string): Promise<any[]> {
  const cfg: any = (CONFIG as any)?.meteoraBalanced || {};
  const baseUnsafe = baseUrl || cfg.apiUrl || '';
  const base = validateHttpUrl(baseUnsafe) || '';
  if (!base) return [];
  
  const retries = Number(cfg.maxHttpRetries || 2);
  const backoffMs = Number(cfg.httpBackoffMs || 500);
  const hideLowApr = cfg.hideLowApr === true;
  const minLiqBase = Number(cfg.minLiqBase || 0);
  const anchorTokensOnly = cfg.anchorTokensOnly !== false;
  
  const fetchFn: any = (globalThis as any).fetch || fetch;
  
  // Build URL with correct query parameters
  const url = (() => {
    const sp = new URLSearchParams();
    
    // ✅ Correct: Multiple address params filter pools containing ANY of these tokens
    if (anchorTokensOnly) {
      sp.append('address', 'So11111111111111111111111111111111111111112'); // SOL
      sp.append('address', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
    }
    
    // ✅ Correct: hide_low_tvl expects a NUMBER (minimum TVL in USD)
    if (cfg.hideLowTvl === true && minLiqBase > 0) {
      sp.append('hide_low_tvl', String(minLiqBase));
    }
    
    // ✅ Correct: hide_low_apr is a boolean
    if (hideLowApr) {
      sp.append('hide_low_apr', 'true');
    }
    
    // Note: tokens_verified does NOT exist in V1 API (removed)
    
    const qs = sp.toString();
    return qs ? `${base}?${qs}` : base;
  })();
  
  // Single fetch (no pagination)
  const cid = httpLogStart({ source: 'meteora_balanced_v1', url });
  let res: any = null;
  let ok = false;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (res?.status === 429) {
        httpLog429({ source: 'meteora_balanced_v1', url, cid });
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      if (!res?.ok) {
        const txt = await res?.text?.();
        httpLogNonOk({ source: 'meteora_balanced_v1', url, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
      }
      ok = true;
      break;
    } catch (err: any) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
    }
  }
  
  if (!ok || !res?.ok) {
    httpLogResponse({ source: 'meteora_balanced_v1', url, cid, status: res?.status || 0, ms: 0, count: 0 });
    return [];
  }
  
  const json: any = await res.json().catch(() => null);
  const data = Array.isArray(json) ? json : [];
  
  httpLogResponse({ source: 'meteora_balanced_v1', url, cid, status: res.status, ms: 0, count: data.length });
  
  logger.info('meteora.balanced.v1.fetch complete', {
    count: data.length,
    anchorTokensOnly,
    hideLowTvl: cfg.hideLowTvl === true,
    hideLowApr,
    minLiqBase,
    cat: 'meteora'
  });
  
  return data;
}
```

## Key Changes

1. **No Pagination Loop** ❌ Removed
   - V1 API returns all pools in a single response
   - No `page` or `limit` parameters

2. **Single `address` Array** ✅ Fixed
   - Pass multiple `address` params to filter pools containing SOL OR USDC
   - Not per-anchor-token fetching

3. **`hide_low_tvl` Parameter** ✅ Fixed
   - Changed from boolean `'true'` to numeric threshold
   - Uses `minLiqBase` config value (default: 50 USD)

4. **`tokens_verified` Parameter** ❌ Removed
   - This parameter doesn't exist in V1 API
   - Removed from V1 fetcher completely

5. **Error Handling** ✅ Enhanced
   - Added try-catch around fetch attempts
   - Better error recovery

## Configuration Mapping

### UI/Config → API Parameters

| Config Field | V1 API Parameter | Type | Notes |
|-------------|-----------------|------|-------|
| `anchorTokensOnly` | `address` (array) | string[] | SOL + USDC mints |
| `hideLowTvl` | `hide_low_tvl` | number | Uses `minLiqBase` value |
| `hideLowApr` | `hide_low_apr` | boolean | Direct mapping |
| `tokensVerified` | ❌ N/A | - | Not available in V1 |
| `minLiqBase` | Used for `hide_low_tvl` | number | Default: 50 USD |

### Expected Behavior After Fix

With default config (`anchorTokensOnly: true`, `minLiqBase: 50`):

```
Request URL: https://damm-api.meteora.ag/pools?address=So11111111111111111111111111111111111111112&address=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

Expected Log:
meteora.balanced.v1.fetch complete {
  "count": 50-200,  // Should now return pools!
  "anchorTokensOnly": true,
  "hideLowTvl": false,
  "hideLowApr": false,
  "minLiqBase": 50,
  "cat": "meteora"
}
```

## Testing

1. **Restart backend** with the fix
2. **Check logs** for:
   - `meteora.balanced.v1.fetch complete` with `count > 0`
   - No HTTP error logs from V1 endpoint
3. **Verify in UI**:
   - Meteora Balanced pools appear in graph
   - Pool liquidity values are present
   - No "—" for `pool_liquidity_raw`

## API Documentation Reference

- **Official Docs**: [https://docs.meteora.ag/api-reference/pools/get_pools](https://docs.meteora.ag/api-reference/pools/get_pools)
- **Endpoint**: `GET https://damm-api.meteora.ag/pools`
- **Schema**: DAMM v1 API Schema → Pools → `get_pools`

## Files Modified

- `backend/src/server/pools/meteoraBalanced.ts`
  - Fixed `fetchMeteoraBalancedV1Http()` function
  - Corrected query parameter types and usage
  - Removed pagination logic
  - Enhanced error handling

## Related Issues

- ✅ V1 API returning 0 pools
- ✅ Incorrect query parameter types
- ✅ Non-existent `tokens_verified` parameter
- ✅ Pagination logic for non-paginated endpoint

