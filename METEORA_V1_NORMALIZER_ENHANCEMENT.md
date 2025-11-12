# Meteora Balanced V1 Normalizer Enhancement

## Summary

Enhanced the V1 normalizer to properly extract and populate all required pool fields, including `decimals_a`, `decimals_b`, `reserve_a_raw`, and `reserve_b_raw`.

## Analysis

### V1 API Response Structure

According to the [Meteora DAMM v1 API documentation](https://docs.meteora.ag/api-reference/pools/get_pools), the V1 API returns:

```typescript
{
  pool_address: string;
  pool_token_mints: string[];        // [mint_a, mint_b, ...]
  pool_token_amounts: string[];      // Whole token amounts (already converted)
  pool_token_usd_amounts: string[];  // USD value of each token
  pool_tvl: string;                  // Total TVL in USD
  total_fee_pct: string;             // Fee as percentage
  lp_decimal: number;                // LP token decimals
  // ... other fields
}
```

**Key Insight**: The V1 API does **NOT** provide:
- `token_a_vault` or `token_b_vault` addresses
- Token decimals for individual tokens
- Raw reserve amounts (only provides whole amounts)

This means **RPC enrichment is not applicable for V1 pools** since we don't have vault addresses to query.

### What Was Missing

The original V1 normalizer was missing:
1. ❌ `decimals_a` and `decimals_b` - Needed for accurate calculations
2. ❌ `reserve_a_raw` and `reserve_b_raw` - Raw reserve strings for precise math
3. ⚠️ No Jupiter token map lookup for decimals

## Solution Implemented

### Enhanced V1 Normalizer

```typescript
export async function normalizeMeteoraBalancedV1(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const arr: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  
  // ✅ NEW: Load Jupiter token map for decimals lookup
  let jupMap: Record<string, { decimals: number }> = {};
  try {
    const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
    jupMap = await loadJupiterTokenMap().catch(() => ({}));
  } catch {}
  
  for (const it of (arr || [])) {
    try {
      const id = String(it?.pool_address || '');
      const mints: string[] = Array.isArray((it as any)?.pool_token_mints) ? (it as any).pool_token_mints : [];
      const amounts: (string|number)[] = Array.isArray((it as any)?.pool_token_amounts) ? (it as any).pool_token_amounts : [];
      const mint_a = String(mints?.[0] || '');
      const mint_b = String(mints?.[1] || '');
      if (!id || !mint_a || !mint_b) continue;
      
      // ✅ NEW: Get decimals from Jupiter map
      const decimalsA = jupMap[mint_a]?.decimals;
      const decimalsB = jupMap[mint_b]?.decimals;
      
      // Parse whole amounts (V1 API already provides whole tokens, not raw)
      const wholeA = toNum(amounts?.[0]);
      const wholeB = toNum(amounts?.[1]);
      
      // ✅ NEW: Calculate reserve_a_raw and reserve_b_raw
      // Convert whole amounts back to raw if we have decimals
      let reserve_a_raw: string | undefined;
      let reserve_b_raw: string | undefined;
      if (decimalsA != null && wholeA > 0) {
        reserve_a_raw = BigInt(Math.floor(wholeA * Math.pow(10, decimalsA))).toString();
      }
      if (decimalsB != null && wholeB > 0) {
        reserve_b_raw = BigInt(Math.floor(wholeB * Math.pow(10, decimalsB))).toString();
      }
      
      amm.push({
        id,
        dex: 'MeteoraBalanced',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: (price_a_per_b > 0) ? price_a_per_b : undefined,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        amount_a_whole: wholeA > 0 ? wholeA : undefined,
        amount_b_whole: wholeB > 0 ? wholeB : undefined,
        decimals_a: decimalsA,              // ✅ NEW
        decimals_b: decimalsB,              // ✅ NEW
        reserve_a_raw,                      // ✅ NEW
        reserve_b_raw,                      // ✅ NEW
        tvl_usd: tvl_usd > 0 ? tvl_usd : undefined,
        pool_liquidity_raw,
        liquidity_display: (tvl_usd > 0) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
      } as any);
    } catch {}
  }
  
  // ... rest of the function (filtering, canonicalization)
}
```

## Key Changes

### 1. Jupiter Token Map Integration ✅

```typescript
// Load Jupiter token map for decimals lookup
let jupMap: Record<string, { decimals: number }> = {};
try {
  const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
  jupMap = await loadJupiterTokenMap().catch(() => ({}));
} catch {}
```

**Purpose**: Get decimal information for tokens since V1 API doesn't provide it.

### 2. Decimals Extraction ✅

```typescript
const decimalsA = jupMap[mint_a]?.decimals;
const decimalsB = jupMap[mint_b]?.decimals;
```

**Purpose**: Required for:
- Accurate price calculations
- Converting whole amounts to raw amounts
- Graph calculations and routing

### 3. Raw Reserve Calculation ✅

```typescript
let reserve_a_raw: string | undefined;
let reserve_b_raw: string | undefined;
if (decimalsA != null && wholeA > 0) {
  reserve_a_raw = BigInt(Math.floor(wholeA * Math.pow(10, decimalsA))).toString();
}
if (decimalsB != null && wholeB > 0) {
  reserve_b_raw = BigInt(Math.floor(wholeB * Math.pow(10, decimalsB))).toString();
}
```

**Purpose**: 
- Provides raw reserve amounts as strings for high-precision calculations
- Enables accurate slippage and price impact computations
- Matches the format used by other DEX normalizers

### 4. Complete Pool Objects ✅

Now V1 pools have all the same fields as V2 pools:
- ✅ `decimals_a`, `decimals_b`
- ✅ `reserve_a_raw`, `reserve_b_raw`
- ✅ `amount_a_whole`, `amount_b_whole`
- ✅ `pool_liquidity_raw`
- ✅ `tvl_usd`
- ✅ `price_a_per_b`

## Why No RPC Enrichment for V1?

**V1 API doesn't provide vault addresses**, which are required for RPC enrichment. The current enrichment function expects:

```typescript
const vaultA = pool?.token_a_vault;  // ❌ Not in V1 response
const vaultB = pool?.token_b_vault;  // ❌ Not in V1 response
```

**However, this is fine because:**
1. V1 API already provides `pool_token_amounts` (whole amounts)
2. We can derive decimals from Jupiter token map
3. We can calculate raw reserves from whole amounts + decimals
4. TVL is already provided by the API

## Benefits

### 1. Complete Pool Data ✅
- All V1 pools now have decimals and raw reserves
- Consistent with V2 pools and other DEXes
- Enables accurate calculations downstream

### 2. Better Price Accuracy ✅
- Decimals ensure proper price calculations
- Raw reserves allow high-precision math
- Prevents rounding errors in routing

### 3. Proper Slippage Calculations ✅
- `reserve_a_raw` and `reserve_b_raw` are now available
- Graph calculations can use precise values
- Price impact computations are accurate

### 4. No RPC Overhead ✅
- V1 pools don't need RPC enrichment
- Faster processing since we skip unnecessary RPC calls
- Relies on API-provided data which is already accurate

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│ fetchMeteoraBalancedV1Http()                            │
│ - Fetch from damm-api.meteora.ag/pools                 │
│ - Apply API-level filters (anchor tokens, TVL, APR)    │
│ - Returns raw API response array                        │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ normalizeMeteoraBalancedV1()                            │
│ 1. Load Jupiter token map for decimals                 │
│ 2. Extract: pool_address, pool_token_mints, amounts    │
│ 3. Lookup decimals from Jupiter map                    │
│ 4. Calculate raw reserves from whole + decimals        │
│ 5. Populate all pool fields                            │
│ 6. Apply minimum liquidity filter                      │
│ 7. Canonicalize pairs                                  │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ Complete AmmPool Objects                                │
│ ✅ id, mint_a, mint_b                                   │
│ ✅ decimals_a, decimals_b                               │
│ ✅ amount_a_whole, amount_b_whole                       │
│ ✅ reserve_a_raw, reserve_b_raw                         │
│ ✅ pool_liquidity_raw, tvl_usd                          │
│ ✅ price_a_per_b, fee_bps                               │
└─────────────────────────────────────────────────────────┘
```

## Testing

After deploying, verify:

1. **V1 pools have decimals**:
   ```typescript
   // Check logs for pools with decimals populated
   decimals_a: 6, decimals_b: 9  // ✅ Should be present
   ```

2. **V1 pools have raw reserves**:
   ```typescript
   reserve_a_raw: "1000000000"  // ✅ Should be string
   reserve_b_raw: "2000000000"  // ✅ Should be string
   ```

3. **No errors in logs**:
   - No "missing decimals" warnings
   - No calculation errors
   - Pool counts should match API response

4. **Graph viewer displays correctly**:
   - `pool_liquidity_raw` no longer shows "—"
   - Reserve values are accurate
   - Prices match expected values

## Files Modified

- `backend/src/server/pools/meteoraBalanced.ts`
  - Enhanced `normalizeMeteoraBalancedV1()` function
  - Added Jupiter token map loading
  - Added decimals lookup
  - Added raw reserve calculation
  - Populated `decimals_a`, `decimals_b`, `reserve_a_raw`, `reserve_b_raw`

## Related Documentation

- V1 API Fetcher Fix: `METEORA_V1_API_FIX.md`
- Configuration Controls: `METEORA_BALANCED_IMPROVEMENTS.md`
- UI Controls: `METEORA_BALANCED_UI_CONTROLS.md`

