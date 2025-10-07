## Leveraged Grid (Drift) - Operations & Safety

This backend adds a Drift-based leveraged grid strategy alongside spot strategies.

### Prerequisites
- Solana RPC URL set in `CONFIG.rpcUrl` or env `SOLANA_RPC_URL`.
- Wallet keypair at `backend/wallet/keypair.json` (or override `WALLET_PATH`).
- Optional: `CONFIG.drift` for cluster, DLOB URL, defaults.
- Node.js 20 LTS recommended. Known-good backend pins:
  - `@solana/web3.js`: 1.98.0
  - `rpc-websockets`: 9.1.3 (via `overrides`)

### Core Endpoints
- `GET /api/drift/status` — Drift cluster, markets, subaccounts, collateral snapshots.
- `GET /api/drift/l2?marketIndex=...` — L2 ladder with oracle when available.
- `GET /api/drift/funding?marketIndex=...` — Last and cumulative funding rate (perp).
- `POST /api/strategies/leveraged-grid/start` — Start (body: LeveragedGridConfig).
- `POST /api/strategies/leveraged-grid/stop` — Stop (body: { key }).
- `GET /api/strategies/leveraged-grid/status` — Runner statuses.

### Liquidator (Drift)

- Start (dry-run by default via config):
  - `POST /api/strategies/liquidator/start` body: `{ name?: string, pollMs?: number, maxConcurrentTargets?: number, dryRun?: boolean }`
- Update:
  - `POST /api/strategies/liquidator/update` body: same as start
- Stop:
  - `POST /api/strategies/liquidator/stop` body: `{ key: string }` where key is `liq#<name>` (default `liq#default`)
- Status:
  - `GET /api/strategies/liquidator/status`

Config defaults under `CONFIG.drift.liquidator`:
```json
{
  "enabled": false,
  "pollMs": 1500,
  "maxConcurrentTargets": 2,
  "dryRun": true
}
```

Notes:
- Liquidator runs best-effort with conservative caps and dry-run preflight to avoid failed transactions when SOL is low.
- Price-triggered ticks leverage the DLOB websocket/HTTP price service already in the backend.
- Extend `marketsAllowlist` to focus updates to specific perp markets.

### Risk Controls
- Effective leverage guard: blocks placements exceeding `config.leverage`.
- Liquidation buffer: `(collateral - maintenance)/maintenance >= config.liquidationBufferPct`.
- Funding guard (optional): display and consider funding in config; avoid negative carry.

### Devnet Testing
1) Start backend: `pnpm -C backend dev`.
2) Run integration scaffolding (skipped by default):
   - `API_BASE=http://localhost:3001/api pnpm -C backend test:unit -- drift.integration.test.ts`
3) Soak (non-blocking):
   - `API_BASE=http://localhost:3001/api tsx backend/src/tests/soak.drift.ts`

### Safety Guidelines
- Start with low `notionalPerLevel`, low `levels`, and higher `liquidationBufferPct`.
- Prefer maker-only and modest leverage (≤2-3x) to begin.
- Monitor `freeCollateral`, `maintenanceRequirement`, and effective leverage live.
- Pause and reduce when funding is sharply negative.

## Raydium Pools

The backend fetches Raydium pools either via SDK or on-chain scanning.

- Endpoint: `GET /api/arb/pools/raydium`
- Normalized shape:
  - AMM: `{ id, dex: 'Raydium', mint_a, mint_b, fee_bps, price_a_per_b, liquidity_base, updated_ms }`
  - CLMM: `{ id, dex: 'Raydium', mint_a, mint_b, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms }`

Environment/config:

- `RAYDIUM_ONCHAIN` (default false): enable direct RPC scanning
- `POOLS_REFRESH_MS` (default 60000): unified refresh cadence for Raydium/Orca timers
- `RAYDIUM_CACHE_TTL_MS` (default 60000): cache TTL for pools (timers use POOLS_REFRESH_MS)
- `RAYDIUM_SDK_CONCURRENCY` (default 8): parallelism for `fetchPoolByMints`
- `RAYDIUM_SDK_PROBE_MINTS_LIMIT` (default 50): max unique mints probed
- `RAYDIUM_SDK_CLMM_PAGE_SIZE` (default 5000): CLMM getPools page size

Notes:

- SDK mode uses `@raydium-io/raydium-sdk-v2` with your configured RPC.
- AMM discovery targets pairs against USDC and SOL using Orca/watchlist mints.
- CLMM `price_a_per_b` is derived from `sqrt_price_x64` when decimals are present.

### TVL/Liquidity Filtering

To reduce noisy pools with near-zero liquidity, the backend supports TVL-like filtering using raw liquidity proxies:

- `RAYDIUM_MIN_AMM_LIQ_BASE` (default 0): minimum AMM `liquidity_base` required to include a pool.
- `RAYDIUM_MIN_CLMM_LIQUIDITY` (default 0): minimum CLMM `liquidity` required to include a pool.

System-wide thresholds (applied to both Raydium and Orca) can be set too:

- `MIN_AMM_LIQ_BASE` (default unset): minimum AMM liquidity proxy across all sources
- `MIN_CLMM_LIQUIDITY` (default unset): minimum CLMM liquidity proxy across all sources

These thresholds are applied during pool normalization. You can also temporarily override thresholds per-request:

### Scoping and Canonicalization

- `SCOPE_POOLS_MODE`: 'none' | 'watchlist' | 'jupiter' | 'intersection' | 'union'
- `TOKEN_UNIVERSE_MODE`: same choices; used inside source fetchers for early scoping
- `ROUTE_LEVEL_SCOPING` (default false): if true, apply scoping again in routes
- `ENABLE_ANCHOR_BRIDGING` (default false): when scoping, include pools where either side is an anchor (SOL/USDC by default)
- `CANONICALIZE_PAIRS` (default 'none'): set to 'lex' to store pools with lexicographic mint order and adjusted price orientation

```
GET /api/arb/pools/raydium?minAmm=500&minClmm=1000
```

If provided, the overrides apply only to that request.


### Graph Module Layout

The graph builder was partially modularized to improve maintainability without breaking the public API used by routes and the websocket layer.

- Files:
  - `server/graph.ts`: orchestrator (snapshot build, scheduling, streaming) and public API exports
  - `server/graph.types.ts`: shared types (`GraphNode`, `GraphEdge`, `GraphSnapshot`, `GraphDiff`)
  - `server/graph.diff.ts`: pure `diffSnapshots(prev, next)`
  - `server/graph.path.ts`: pathfinding core (`findPathInSnapshot`); `graph.ts` wraps it as `findPath`

- Public API (unchanged import path `./graph.js`):
  - `getGraphSnapshot(force?: boolean)`
  - `startGraphStream(io)`
  - `scheduleGraphRebuild(io?, debounceMs?)`
  - `rebuildGraphNow(io?)`
  - `diffSnapshots(prev, next)`
  - `findPath(fromMint, toMint)`

- Interaction with pools: `graph.ts` reads from non-fetching peek helpers (`peekRaydiumPools`, `peekOrcaPools`, `peekMeteoraPools`), which remain available after the pools refactor. Refresh/subscription continues to be handled by `pools.ts` (`enablePoolWebsocketRefreshes`, timers) and is triggered when the graph stream starts.

## Meteora Pools (DLMM)

- Endpoint: `GET /api/arb/pools/meteora`
- Normalized as CLMM entries with `dex: 'Meteora'` and `price_a_per_b` from API.

Configuration (env overrides):

- `METEORA_MODE` (default `http`)
- `METEORA_API_URL` (default `https://dlmm-api.meteora.ag/v1/pairs`)
- `METEORA_HTTP_PAGE_SIZE`, `METEORA_HTTP_MAX_PAGES`, `METEORA_HTTP_MAX_RETRIES`, `METEORA_HTTP_BACKOFF_MS`
- `METEORA_CACHE_TTL_MS`
- `METEORA_MIN_CLMM_LIQUIDITY`
- `METEORA_UNIVERSE_PREFILTER`

Refresh:

- `POST /api/arb/pools/refresh` now accepts `{ source: 'meteora' }`


## Direct Execution (Multi-hop)

Endpoints:

- `GET /api/arb/config` → ExecConfig
- `PUT /api/arb/config` → update ExecConfig
- `POST /api/arb/resolve-direct` → `{ path, hopPoolIds, dexes, size?, sizeUsd?, slippageBps? }` → `{ plan }`
- `POST /api/arb/execute-direct` → `{ plan }` or `{ path, hopPoolIds, dexes, size?, sizeUsd? }` → `{ signature?, ixCount, txSizeBytes, legsSummary }`
- `GET /api/arb/tx-history?limit=50` → recent submissions

Websocket events (Socket.IO): `tx:start`, `tx:resolved`, `tx:sim.ok`, `tx:sim.err`, `tx:send.ok`, `tx:send.err`.
