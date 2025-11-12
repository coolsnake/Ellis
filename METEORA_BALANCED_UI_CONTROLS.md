# Meteora Balanced UI Configuration Controls

## Overview

Added comprehensive UI controls to the **Data Fetchers & Normalizers** modal for managing Meteora Balanced pool quality filtering and fetching strategy.

## UI Location

**Main App** → **Arbitrage Section** → **"Fetchers & Normalizers"** button → **Meteora Balanced (mAMM)** section

## New UI Controls

### 🎯 Quality Filters (API-Level)

A highlighted section with 4 checkbox controls that apply filters during the API fetch:

1. **Anchor Tokens Only (SOL/USDC)** ✅ *Default: Enabled*
   - When enabled: Only fetches pools paired with SOL or USDC
   - Benefits: ~95% fewer API calls, highest quality pools, fastest refresh
   - Recommended for production use

2. **Hide Low TVL Pools** ⬜ *Default: Disabled*
   - Filters out pools below Meteora's internal TVL threshold
   - Uses API parameter: `hide_low_tvl=true`

3. **Hide Low APR Pools** ⬜ *Default: Disabled*
   - Filters out pools with low Annual Percentage Rates
   - Uses API parameter: `hide_low_apr=true`

4. **Verified Tokens Only** ⬜ *Default: Disabled*
   - Only includes pools with verified tokens
   - Uses API parameter: `tokens_verified=true`

**Visual Design:**
- Displayed in a bordered box with light gray background
- Blue header with 🎯 emoji
- Helpful tip below explaining the Anchor Tokens Only benefit

### API URLs

Two text inputs for dual API support:

- **API URL (V1)**: `https://damm-api.meteora.ag/pools`
- **API URL (V2)**: `https://dammv2-api.meteora.ag/pools`

### Post-Fetch Filtering & RPC Enrichment

3-column grid with:

1. **Min Liquidity (USD)**
   - Number input (default: 50)
   - Filters pools after fetching
   - Helps remove rugpulled/dust pools

2. **Enable RPC Enrichment**
   - Checkbox (default: enabled)
   - Fetches vault balances for precise reserve data
   - Provides accurate `pool_liquidity_raw` values

3. **RPC Batch Size**
   - Number input (default: 100)
   - Disabled when RPC enrichment is off
   - Controls how many pools to enrich per batch

### HTTP Configuration

Standard HTTP settings in a 3-column grid:

- Cache TTL (ms): 300000
- Max HTTP Retries: 2
- HTTP Backoff (ms): 500
- Page Size: 200
- Max Pages: 3

## State Management

### Initial State
```typescript
meteoraBalanced_apiUrl: 'https://damm-api.meteora.ag/pools'
meteoraBalanced_apiUrlV2: 'https://dammv2-api.meteora.ag/pools'
meteoraBalanced_hideLowTvl: false
meteoraBalanced_hideLowApr: false
meteoraBalanced_tokensVerified: false
meteoraBalanced_minLiqBase: 50
meteoraBalanced_anchorTokensOnly: true
meteoraBalanced_enableRpcEnrichment: true
meteoraBalanced_rpcBatchSize: 100
meteoraBalanced_cacheTtlMs: 300000
meteoraBalanced_maxHttpRetries: 2
meteoraBalanced_httpBackoffMs: 500
meteoraBalanced_pageSize: 200
meteoraBalanced_maxPages: 3
```

### Backend Sync

When saved, the UI sends a POST request to `/api/config` with:

```json
{
  "meteoraBalanced": {
    "apiUrl": "...",
    "apiUrlV2": "...",
    "hideLowTvl": true/false,
    "hideLowApr": true/false,
    "tokensVerified": true/false,
    "minLiqBase": 50,
    "anchorTokensOnly": true/false,
    "enableRpcEnrichment": true/false,
    "rpcBatchSize": 100,
    "cacheTtlMs": 300000,
    "maxHttpRetries": 2,
    "httpBackoffMs": 500,
    "pageSize": 200,
    "maxPages": 3
  }
}
```

## User Experience Improvements

### Visual Hierarchy
1. **Quality Filters** section at top with distinctive styling
2. Grouped related controls (API URLs, filtering, HTTP settings)
3. Clear labels with contextual hints

### Smart Defaults
- Anchor Tokens Only: **Enabled** (best quality/performance)
- RPC Enrichment: **Enabled** (accurate liquidity data)
- Min Liquidity: **$50** (filters dust/rugpulls)
- Other quality filters: **Disabled** (optional, can be enabled for stricter filtering)

### User Guidance
- Inline help text explaining the Anchor Tokens Only benefit
- Contextual hints for each section
- Disabled state for dependent controls (RPC batch size when enrichment is off)

## Recommended Configurations

### Production (Default)
```
✅ Anchor Tokens Only
⬜ Hide Low TVL
⬜ Hide Low APR
⬜ Verified Tokens Only
Min Liquidity: $50
✅ RPC Enrichment
```
**Result:** High-quality SOL/USDC pools, fast fetching, accurate liquidity data

### Maximum Quality
```
✅ Anchor Tokens Only
✅ Hide Low TVL
✅ Hide Low APR
✅ Verified Tokens Only
Min Liquidity: $100-200
✅ RPC Enrichment
```
**Result:** Only the highest-quality, verified pools

### Development/Testing
```
⬜ Anchor Tokens Only
✅ Hide Low TVL
✅ Hide Low APR
⬜ Verified Tokens Only
Min Liquidity: $50
✅ RPC Enrichment
```
**Result:** More comprehensive pool coverage with quality filtering

## Implementation Notes

1. **Backward Compatibility**: All new checkboxes default to `false` except `anchorTokensOnly` and `enableRpcEnrichment`
2. **Responsive Layout**: Uses CSS Grid for proper layout on desktop and mobile
3. **Type Safety**: All inputs properly typed (number/checkbox/text)
4. **State Persistence**: Settings saved to backend config and persist across restarts

## Files Modified

- `frontend/src/components/DataFetchConfig.tsx`
  - Added 10 new state fields
  - Updated load logic to parse new fields from backend
  - Updated save logic to serialize new fields
  - Redesigned Meteora Balanced UI section with quality filters

## Testing Checklist

- [ ] Open Fetchers & Normalizers modal
- [ ] Navigate to Meteora Balanced section
- [ ] Verify all checkboxes are interactive
- [ ] Toggle Anchor Tokens Only and verify tip message
- [ ] Disable RPC Enrichment and verify batch size input becomes disabled
- [ ] Change numeric values and verify they accept input
- [ ] Click Save and verify no errors
- [ ] Reload page and verify settings persist
- [ ] Check backend logs for applied filters after next pool refresh

## Visual Preview

```
┌─────────────────────────────────────────────────────┐
│ Meteora Balanced (mAMM)                             │
├─────────────────────────────────────────────────────┤
│                                                      │
│ ┌─── 🎯 Quality Filters (API-Level) ─────────────┐ │
│ │                                                 │ │
│ │  ☑ Anchor Tokens Only    ☐ Hide Low TVL       │ │
│ │  ☐ Hide Low APR          ☐ Verified Tokens    │ │
│ │                                                 │ │
│ │  💡 Anchor Tokens Only fetches SOL/USDC only   │ │
│ └─────────────────────────────────────────────────┘ │
│                                                      │
│  API URL (V1)              API URL (V2)             │
│  [https://damm-api...]     [https://dammv2-api...] │
│                                                      │
│  Min Liquidity  RPC Enrichment    RPC Batch Size   │
│  [50]           ☑ Enable          [100]            │
│                                                      │
│  Cache TTL    Retries    Backoff   PageSize  Pages │
│  [300000]     [2]        [500]     [200]     [3]   │
└─────────────────────────────────────────────────────┘
```

