# Config Files
## Meteora HTTP Endpoints

Environment variables and defaults that control Meteora fetchers:

- METEORA_API_URL
  - Description: DLMM (CLMM) pairs API endpoint
  - Default: `https://dlmm-api.meteora.ag/pair/all_with_pagination`

- METEORA_BALANCED_API_URL
  - Description: Balanced (mAMM) pools API endpoint (DAMM v1)
  - Default: `https://damm-api.meteora.ag/pools`

// METEORA_BALANCED_API_URL_V2
  - Description: Balanced (mAMM) v2 pools API endpoint
  - Default: `https://amm-v2.meteora.ag/pools`
  - Behavior: When both v1 and v2 are configured, results are unioned with v2 preferred on conflicts.

- METEORA_BALANCED_HIDE_LOW_TVL
  - Description: Optional USD TVL threshold to exclude low TVL pools in v1 fetch (`hide_low_tvl` query)
  - Default: `0` (disabled)

- METEORA_BALANCED_HTTP_PAGE_SIZE
  - Description: Page size for v1/v2 paginated requests
  - Default: `1000`

- METEORA_BALANCED_HTTP_MAX_PAGES
  - Description: Maximum number of pages to fetch from v1/v2 endpoints
  - Default: `10`

Related runtime config keys (exposed via /system/config and UI):

- meteora.apiUrl, meteora.cacheTtlMs, meteora.maxHttpRetries, meteora.httpBackoffMs, meteora.pageSize, meteora.maxPages, meteora.minClmmLiquidity, meteora.universePrefilter
- meteoraBalanced.apiUrl, meteoraBalanced.cacheTtlMs, meteoraBalanced.maxHttpRetries, meteoraBalanced.httpBackoffMs, meteoraBalanced.pageSize, meteoraBalanced.maxPages


## backend/config/tokens.json

Supported tokens and metadata.

Keys:
- symbol: Ticker symbol.
- mint: Token mint address.

Example:
```json
{
  "1": {
    "mint": "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
    "decimals": 6
  },
  "42": {
    "mint": "DDti34vnkrCehR8fih6dTGpPuc3w8tL4XQ4QLQhc3xPa",
    "decimals": 9
  },
  "67": {
    "mint": "HkGAPBptacbMn9nBz96TBPKs8gC9Kfv3D35nbUvKhXNk",
    "decimals": 6
  },
  "888": {
    "mint": "A1hkaMgjerEeNBtqYqkRfu54rwUXjApEUnc8e4yBvCq8",
    "decimals": 6
  },
  "SOL": {
    "mint": "So11111111111111111111111111111111111111112",
    "decimals": 9
  },
  "USDC": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "decimals": 6
  },
  "JITOSOL": {
    "mint": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "decimals": 9
  },
  "MSOL": {
```

## backend/config/jupTokens.json

Jupiter token list override and metadata.

Keys:
- symbol: Ticker symbol.
- address: Token address.

Example:
```json
[
  {
    "address": "So11111111111111111111111111111111111111112",
    "name": "Wrapped SOL",
    "symbol": "SOL",
    "decimals": 9
  },
  {
    "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "name": "USD Coin",
    "symbol": "USDC",
    "decimals": 6
  },
  {
    "address": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "name": "USDT",
    "symbol": "USDT",
    "decimals": 6
  },
  {
    "address": "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    "name": "Jupiter Perps",
    "symbol": "JLP",
    "decimals": 6
  },
  {
    "address": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "name": "Jito Staked SOL",
    "symbol": "JitoSOL",
    "decimals": 9
```

## backend/backend/config/strategies.json

Strategy-specific defaults and toggles.

Keys:
- threshold: Default params for threshold strategy.
- grid: Default params for grid strategy.

Example:
```json
[
  {
    "name": "wSOL Grid",
    "token": "SOL",
    "fromToken": "USDC",
    "toToken": "SOL",
    "testMode": false,
    "active": true,
    "slippageBps": 10,
    "cooldownMs": 1000,
    "feeBps": 30,
    "extraSlippageBps": 50,
    "minEdgeBps": 60,
    "gridType": "arithmetic",
    "gridSpacing": 0.002,
    "gridLevels": 5,
    "centerPrice": 0,
    "totalAmount": 25,
    "levelAmount": 5,
    "initialBuyRange": 0.002,
    "initialSellRange": 0.002,
    "maxPositions": 1,
    "stopLoss": 0,
    "takeProfit": 0,
    "rebalanceThreshold": 0.05,
    "adaptiveSpacing": false,
    "volatilityPeriod": 20,
    "minLevelSpacing": 0.005,
    "maxLevelSpacing": 0.02,
    "slidingCenter": true,
```

## Arb engine pruning (arb-rs/arb-config.json)

Keys:
- max_sol_stable_hops: Maximum allowed SOL↔stable hops per cycle (None for unlimited).
- drop_stable_stable_hops: If true, drop any cycle containing a stable↔stable hop.
- stable_mints: Optional override of stablecoin mints used for pruning.

Defaults:
```json
{
  "max_sol_stable_hops": 1,
  "drop_stable_stable_hops": true,
  "stable_mints": [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  ]
}
```

## Backend graph pruning (env via backend/src/utils/config.ts)

Environment variables and defaults:

- STABLE_MINTS
  - Description: Comma-separated list of stablecoin mints used for pruning.
  - Default: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

- DROP_STABLE_STABLE_EDGES
  - Description: Drop stable↔stable edges at graph build time.
  - Default: `true`
