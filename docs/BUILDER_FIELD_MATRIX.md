# Builder Field Requirements & Cache Sources

This document enumerates the exact fields each transaction builder consumes *before* it would ever fall back to an RPC call. It also lists the modules that are supposed to populate those fields via HTTP fetchers, resolvers, or cache warmers, and flags any remaining gaps that still force the builders to hydrate data from the chain.

---

## Raydium AMM (`buildRaydiumAmmSwapIxReal`)

| Field / Group | Builder usage | Primary source(s) | Notes |
| --- | --- | --- | --- |
| `poolId`, `programId`, `inputMint`, `outputMint`, `userSourceAta`, `userDestAta`, amounts/decimals | Base swap params (`backend/src/execution/builder/ix.ts` ~L5144-L5314) | Planner + `resolveRaydiumAmm` (`execution/resolver/raydiumAmm.ts`) | Resolver pulls vaults/market hints from `peekRaydiumPools`, and fills `hop.programId` from `executionCache`. |
| `mint_a`, `mint_b`, `decimals_a`, `decimals_b`, `rawAccountData` | Enforce mint orientation & decode account if cache hit fails (same builder section) | `executionCache.setStatic` inside `server/pools.ts` (~L5100-L5150) and websocket decoder (~L2040-L2047) | HTTP normalization + WS updates drop raw account data and mint metadata into the execution cache. |
| `vaultA`, `vaultB`, `ammAuthority`, `amm_open_orders`, `amm_target_orders` | Build Raydium pool keys + Serum open orders (builder ~L5334-L5489) | `peekRaydiumPools` snapshot + `executionCache.setStatic` (~L5107-L5130) | Snapshot data keeps vault PDAs, while cache persists authorities for quick lookup. |
| Serum market accounts (`market_id`, `market_program_id`, `market_bids`, `market_asks`, `market_event_queue`, `market_base_vault`, `market_quote_vault`, `market_authority`) | Provide the full 17-account Raydium instruction (builder ~L5334-L5484) | `executionCache.setStatic` (~L5114-L5123) populated via `server/pools/raydium.ts` and websocket refreshes | Missing cache values trigger the (now gated) RPC decode path. |
| LP mint (`lp_mint`) | Used when normalizing pool keys for SDK (builder ~L5451-L5452) | Same cache block as above | — |

### Status
- All required Raydium AMM fields are persisted in `executionCache` from HTTP normalization (`server/pools/raydium.ts`) and websocket updates (`server/pools.ts`).
- Builders only touch RPC when cache entries are truly missing (now gated by `allowBuilderRpcFallback`).

---

## Raydium CLMM (`buildRaydiumClmmSwapIxReal`)

| Field / Group | Builder usage | Primary source(s) | Notes |
| --- | --- | --- | --- |
| `programId`, `poolId`, `input/output mints & decimals`, user ATAs | General swap metadata (builder ~L3820-L4005) | Planner + `resolveRaydiumClmm` (`execution/resolver/raydiumClmm.ts`) + `executionCache` statics | Resolver prefers `clmmCache` but falls back to `peekRaydiumPools`. |
| Tick arrays (`tickArrayLower`, `tickArrayCenter`, `tickArrayUpper`), `tickSpacing`, `oracle`, `vaultA/B`, `observationId`, `ammConfig` | Required before calling the SDK builder (builder ~L3862-L4084) | `clmmCache` (`execution/clmmCache.ts` populated via `server/tasks/refreshClmm.ts`) and websocket attach logic (`server/pools.ts` ~L3390-L3690) | `refreshClmm` decodes on-chain state and persists tick arrays, oracle, observation, config, vaults. WS attach keeps tick arrays warm. |
| `mint_a`, `mint_b`, `decimals`, `ex_bitmap`, `observation_state`, `account_a/b` | Build owner info & optional exBitmap accounts (builder ~L3964-L4200) | `executionCache.setStatic` for Raydium CLMM pools (`server/pools.ts` ~L5151-L5177) | `ex_bitmap` is kept in static cache for quick access. |
| `tickArrays` hot cache entries | Used to skip verification and preserve cached PDAs (builder ~L4193-L4245) | Stored when WS subscriptions derive tick-array PDAs (`server/pools.ts` ~L3430-L3520) | Data lives under `executionCache.hot(...).tickArrays`. |

### Status
- All CLMM-critical statics live either in `executionCache` or `clmmCache`.
- Tick-array PDAs are derived once per websocket attach and cached under `executionCache.hot`.

---

## Meteora DLMM (`buildMeteoraDlmmSwapIxReal`)

| Field / Group | Builder usage | Primary source(s) | Notes |
| --- | --- | --- | --- |
| `programId`, `poolId`, base swap params | General swap metadata (builder ~L2280-L2400) | Planner + `resolveMeteoraDlmm` (`execution/resolver/meteora.ts`) + `executionCache.getStatic` | Resolver pulls vaults, bin step, bitmap extension, active ID from pool snapshot. |
| Pool mints (`mint_a/mint_b`), decimals, `vaultA/B` (`account_a/b`) | Map reserves/host fee accounts (builder ~L2904-L3148) | `executionCache.setStatic` for Meteora pools (`server/pools.ts` ~L5593-L5622) + HTTP normalization (`server/pools/meteora.ts` ~L2553-L2567) | Vaults/reserves are persisted in the static cache. |
| `bin_array_bitmap_extension`, `binStep`, `activeId` | Provide swap bounds & bitmap account (builder ~L2310-L2870) | HTTP fetch + `executionCache.setStatic` and `setHot` in `server/pools.ts` (~L2553-L2576) | Bitmap extension is stored statically; `activeId` is currently stored as part of the hot cache. |
| Derived bin-array PDAs (`binArrays.lower/upper`) | Reduce RPC when selecting remaining accounts (builder ~L2407-L2500 & ~L3600-L3770) | `populateMeteoraActiveIds` (`server/pools/meteora.ts` ~L413-L505) stores `binArrays` inside `executionCache.setHot(pool.id, { binArrays: ... })` | **Gap:** later `executionCache.setHot` overwrites these because it does not merge existing hot entries. We preserve them by merging hot cache entries in the pools updater (see TODO below). |
| `tokenXMint`, `tokenYMint` | Determines swap direction and reserve mapping (builder ~L2330-L3185) | `executionCache.getStatic` mints + resolver fallback | Already cached. |
| `tokenXProgram`, `tokenYProgram` | Needed to pick Token-2022 program IDs (builder ~L3156-L3244) | **Currently fetched via `DLMM.getTokenProgramId(connection, mint)` inside the builder** | **Gap:** we do not persist token program IDs in the execution cache yet. TODO added below. |

### Status / Gaps
- Static cache contains mints, vaults, bitmap extension.
- Hot cache now merges existing entries so `binArrays` seeded by `populateMeteoraActiveIds` survive subsequent updates.
- **Outstanding:** we still need to persist token program IDs (`tokenXProgram`/`tokenYProgram`) so the builder can avoid the SDK+RPC lookup.

---

## Meteora Balanced / DAMM (`buildMeteoraDammSwapIxReal`)

| Field / Group | Builder usage | Primary source(s) | Notes |
| --- | --- | --- | --- |
| `poolId`, `programId`, `variant`, swap params | Base metadata (builder ~L2072-L2248) | Planner + `resolveMeteoraDamm` (`execution/resolver/meteoraDamm.ts`) | Resolver looks up the balanced pool snapshot. |
| Vault/reserve accounts (`account_a/b`, `reserveA/B`) | Provide LP vaults and reserve balances for manual instruction building (builder ~L2072-L2233) | `peekMeteoraBalancedPools` (`server/pools.ts`) + resolver | Balanced pools expose reserves (`amount_a_whole`, `amount_b_whole`) directly; resolver copies them into the hop. |
| Token programs (`token_program_a/b`) | Needed when building manual swap instruction (builder ~L2218-L2255) | Same resolver | Snapshot already exposes these fields; no additional caching needed. |

### Status
- All required fields come from the balanced pool snapshot; no additional cache work needed for this builder.

---

## Orca CLMM (`buildOrcaSwapIxLocal`)

| Field / Group | Builder usage | Primary source(s) | Notes |
| --- | --- | --- | --- |
| `programId`, `poolId`, mints/decimals, vaults, oracle | Assemble swap instruction accounts (builder ~L748-L858) | `executionCache.setStatic` via HTTP normalization (`server/pools/orca.ts` ~L200-L360, `server/pools.ts` ~L5480+) | Static cache stores `token_vault_a/b`, `oracle`, `mint_a/b`, `decimals`. |
| Tick arrays (`tickArrays.lower/center/upper`) | Provide the three PDAs for Whirlpool swap (builder ~L800-L815, ~L4193-L4245) | Websocket attach logic (`server/pools.ts` ~L3610-L3685) stores them under `executionCache.hot(poolId).tickArrays` | Hot cache entries are merged so new derivations augment existing fields. |
| Hot price/liquidity metrics (`sqrtPriceX64`, `liquidity`, `feeRate`) | Used for quoting/logging; optionally exported to metrics (builder ~L770-L883) | `executionCache.setHot` in `server/pools.ts` ~L2269-L2287 and WS updates | Already available. |
| Token programs | Not required; Whirlpools only uses SPL token program (config). | — | — |

### Status
- Local Orca builder already has all required fields via execution cache + websocket tick-array derivations.
- RPC fallbacks (`buildOrcaSwapViaSdk`, context-based SDK quote) are now gated by `allowBuilderRpcFallback`.

---

## Summary of Known Gaps

1. **Meteora DLMM token program IDs**  
   - Builder still calls `DLMM.getTokenProgramId(connection, mint)` because `executionCache` + resolvers do not persist `token_program_x` / `token_program_y`.  
   - **TODO added:** extend the Meteora `executionCache.setStatic` path to capture these once the HTTP payloads expose them, so the builder can stay fully local.

2. **Meteora hot cache overwriting `binArrays`**  
   - `populateMeteoraActiveIds()` seeds `executionCache.hot(pool, { binArrays })`, but the general pool updater overwrote the hot entry, erasing cached bin arrays.  
   - **Fixed + documented:** `server/pools.ts` now merges the previous hot entry when updating Meteora clmm pools, keeping the derived bin arrays alive for the builder.

These are the only data sets still forcing RPC assistance after the latest builder gating work. All other Raydium and Orca requirements are satisfied by the existing HTTP/WS ingestion + execution cache layers.


