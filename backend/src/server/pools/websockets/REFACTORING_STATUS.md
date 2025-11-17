# WebSocket Pools Refactoring Implementation Status

## Completed Modules

### 1. Core Infrastructure
- ✅ `backend/src/server/pools/websockets/types.ts` - Shared types and interfaces
- ✅ `backend/src/server/pools/websockets/connection.ts` - Connection lifecycle management
- ✅ `backend/src/server/pools/websockets/subscriptions.ts` - Subscription management with retry
- ✅ `backend/src/server/pools/websockets/validation.ts` - Pool validation utilities
- ✅ `backend/src/server/pools/websockets/metrics.ts` - Metrics aggregation
- ✅ `backend/src/server/pools/websockets/batching.ts` - Account info batching
- ✅ `backend/src/server/pools/websockets/apply.ts` - Debounced graph updates
- ✅ `backend/src/server/pools/websockets/preload.ts` - Cache preloading
- ✅ `backend/src/server/pools/websockets/meteoraBins.ts` - Meteora bin tracking
- ✅ `backend/src/server/pools/websockets/targets.ts` - Target management (placeholder)

### 2. Decoder Stubs
- ✅ `backend/src/server/pools/websockets/decoders/raydium.ts` - Placeholder
- ✅ `backend/src/server/pools/websockets/decoders/orca.ts` - Placeholder
- ✅ `backend/src/server/pools/websockets/decoders/meteora.ts` - Placeholder
- ✅ `backend/src/server/pools/websockets/decoders/pumpswap.ts` - Placeholder
- ✅ `backend/src/server/pools/websockets/decoders/meteoraBalanced.ts` - Placeholder

## Key Challenge

The original `pools.websockets.ts` file (3762 lines) contains:
1. A massive `handle` async function (lines ~749-3700+) that processes ALL DEX updates
2. Embedded decoder logic for each DEX within conditional branches
3. Tightly coupled state management and side effects
4. Complex dependencies on caches, metrics, and graph updates

## Refactoring Strategy

### Phase 1: Extract Decoder Logic (IN PROGRESS)
The decoder logic is embedded in the `handle` function within conditional blocks like:
- Raydium AMM/CLMM handling
- Orca CLMM handling
- Meteora DLMM handling (with bin arrays)
- Pumpswap handling
- Meteora Balanced handling

Each decoder needs to:
1. Parse account data using DEX-specific layouts
2. Extract pool state (mints, liquidity, price, fees)
3. Validate decoded data
4. Update the appropriate cache (raydiumCache, orcaCache, etc.)
5. Schedule graph updates via scheduleDexApply

### Phase 2: Extract Subscription Logic
The subscription setup is intertwined with the main setup function and includes:
- Account subscriptions for specific pools
- Program subscriptions for entire DEXes
- Derived account subscriptions (vaults, tick arrays, oracles)
- Meteora bin array subscriptions
- Retry logic and error handling

### Phase 3: Refactor Main Orchestrator
Create a clean orchestrator that:
1. Initializes state from extracted modules
2. Coordinates between modules via dependency injection
3. Exposes the same public API
4. Maintains backward compatibility

## Next Steps

1. Extract decoder functions from the handle function into separate modules
2. Create a unified subscription manager that uses the extracted decoders
3. Refactor the main orchestrator to wire everything together
4. Test and verify behavior matches the original

## Notes

- The original file's complexity makes line-by-line extraction impractical
- A pragmatic approach: Create working modules that replicate behavior
- Focus on maintaining the public API contract
- Preserve all metrics, logging, and side effects

