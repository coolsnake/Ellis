# Pools WebSocket Refactoring - Implementation Summary

## Overview

This refactoring extracts the monolithic `pools.websockets.ts` file (3,762 lines) into focused, maintainable modules as per the refactoring plan.

## What Has Been Completed ✅

### 1. Directory Structure Created
```
backend/src/server/pools/websockets/
├── types.ts                 # Shared types and interfaces
├── connection.ts           # Connection lifecycle management  
├── subscriptions.ts        # Subscription management with retry
├── validation.ts           # Pool validation utilities
├── metrics.ts              # Metrics aggregation
├── batching.ts             # Account info batching
├── apply.ts                # Debounced graph updates
├── preload.ts              # Cache preloading
├── meteoraBins.ts          # Meteora bin tracking
├── targets.ts              # Target management (placeholder)
├── README.md               # Documentation
├── REFACTORING_STATUS.md   # Status tracking
└── decoders/
    ├── raydium.ts          # Raydium decoder (placeholder)
    ├── orca.ts             # Orca decoder (placeholder)
    ├── meteora.ts          # Meteora decoder (placeholder)
    ├── pumpswap.ts         # Pumpswap decoder (placeholder)
    └── meteoraBalanced.ts  # Meteora Balanced decoder (placeholder)
```

### 2. Utility Modules Implemented

#### `types.ts` (120 lines)
- `RefreshAllSourcesHandler` type
- `RefreshSourcesOptions` interface
- `DexSource`, `PoolDecoder`, `ValidationResult` types
- `WsConnectionState`, `MeteoraBinTracker` interfaces
- All shared type definitions

#### `connection.ts` (170 lines)
- Connection state management
- Health monitoring with timers
- `markWsEvent()`, `isWsHealthy()`, `setWsHealthy()`
- `setWsConnection()`, `getWsConnection()`, `clearWsConnection()`
- `withWsProtection()` for safe connection access
- Start/stop health monitoring

#### `subscriptions.ts` (160 lines)
- Subscription state tracking per DEX
- `subscribeAccountWithRetry()` with exponential backoff
- `subscribeProgramWithRetry()` with retry logic
- `getSubscriptionCount()`, `setSubscriptionCount()`
- Cleanup utilities

#### `validation.ts` (160 lines)
- `validateDecodedPool()` with comprehensive validation
- Validation statistics tracking per DEX
- `debugLogTargeted()` helper
- Mint, price, liquidity, fee, tick validation
- Detailed failure reason tracking

#### `metrics.ts` (80 lines)
- Re-exports from `pools.metrics.js`
- WebSocket counts per DEX
- `recordDecodeSuccess()`, `recordDecodeFailure()`, `recordDelta()`
- Count management utilities

#### `batching.ts` (90 lines)
- `batchGetAccountInfo()` with 50ms batch window
- Queue management for multiple concurrent requests
- RPC limiter integration
- Error handling and promise resolution

#### `apply.ts` (110 lines)
- `scheduleDexApply()` with 100ms debounce per DEX
- Baseline tracking for delta detection
- Timer management
- Graph update coordination
- `clearAllApplyTimers()`, `getApplyState()`

#### `preload.ts` (150 lines)
- `preloadPumpswapVaultCache()` implementation
- `preloadMeteoraBalancedVaultCache()` implementation
- Batch RPC calls for vault balances
- Prevents decode failures from race conditions

#### `meteoraBins.ts` (160 lines)
- `isMeteoraBinArraySubscribed()` implementation
- `getMeteoraTracker()`, `getAllMeteoraBinTrackers()`
- `registerBinAccount()`, `unregisterBinAccount()`
- `computeAggregateBinHash()` for change detection
- Bin hash management

#### `targets.ts` (50 lines)
- Placeholder implementations for `getWsTargets()`, `retargetPoolWebsockets()`
- Will be populated with actual logic during orchestrator phase

### 3. Decoder Stubs Created
All decoder modules have placeholder implementations ready to receive extracted logic:
- `pumpswap.ts` (~300 lines to extract)
- `meteoraBalanced.ts` (~200 lines to extract)
- `orca.ts` (~400 lines to extract)
- `meteora.ts` (~600 lines to extract)
- `raydium.ts` (~800 lines to extract)

## What Remains 🚧

### Phase 2: Extract Decoder Logic (Current Phase)
The original file contains a massive `handle` function (lines ~749-3700+) with embedded decoder logic for all DEXes. This needs to be extracted into the decoder modules:

1. **Pumpswap Decoder** (~300 lines)
   - Pool state parsing
   - Vault balance integration
   - Cache updates

2. **Meteora Balanced Decoder** (~200 lines)
   - AMM pool handling
   - Vault tracking
   - Price calculations

3. **Orca Decoder** (~400 lines)
   - CLMM pool parsing
   - Sqrt price handling
   - Tick and liquidity tracking

4. **Meteora DLMM Decoder** (~600 lines)
   - Bin-based pool logic
   - Bin array management
   - Active bin tracking

5. **Raydium Decoder** (~800 lines)
   - AMM pool handling
   - CLMM pool handling
   - Dual-mode support

### Phase 3: Extract Subscription & Target Logic
- Account subscription setup
- Program subscription setup
- Derived account subscriptions (vaults, tick arrays, etc.)
- Target computation from graph
- Retargeting coordination

### Phase 4: Refactor Main Orchestrator
- Create new orchestrator that wires modules together
- Maintain public API compatibility
- Dependency injection for all modules
- State initialization and coordination

### Phase 5: Testing & Verification
- Unit tests for decoders
- Integration tests for WebSocket flow
- Verify metrics and logging
- Monitor runtime behavior

## Key Challenge

The decoder logic is deeply embedded within the `handle` function in the original file. It's not cleanly separated—each DEX's decoder logic is mixed with:
- WebSocket event handling
- Cache updates
- Metrics tracking
- Graph update scheduling
- Error handling
- Logging

This makes extraction complex and requires careful preservation of:
- All side effects (metrics, logs)
- Error handling behavior
- Cache update semantics
- Graph update coordination

## Migration Strategy

Rather than attempting a single massive refactoring, we're using an incremental approach:

1. ✅ **Infrastructure First**: Extract utilities that don't contain business logic
2. 🚧 **Decoders Next**: Extract DEX-specific logic one at a time
3. 📋 **Orchestration Last**: Wire everything together with new orchestrator
4. 📋 **Testing**: Verify behavior matches original

This ensures:
- Original file remains working during migration
- Each step can be tested independently
- Rollback is possible at any stage
- Risk is minimized

## Files Modified/Created

### New Files (16)
- `backend/src/server/pools/websockets/types.ts`
- `backend/src/server/pools/websockets/connection.ts`
- `backend/src/server/pools/websockets/subscriptions.ts`
- `backend/src/server/pools/websockets/validation.ts`
- `backend/src/server/pools/websockets/metrics.ts`
- `backend/src/server/pools/websockets/batching.ts`
- `backend/src/server/pools/websockets/apply.ts`
- `backend/src/server/pools/websockets/preload.ts`
- `backend/src/server/pools/websockets/meteoraBins.ts`
- `backend/src/server/pools/websockets/targets.ts`
- `backend/src/server/pools/websockets/README.md`
- `backend/src/server/pools/websockets/REFACTORING_STATUS.md`
- `backend/src/server/pools/websockets/decoders/raydium.ts`
- `backend/src/server/pools/websockets/decoders/orca.ts`
- `backend/src/server/pools/websockets/decoders/meteora.ts`
- `backend/src/server/pools/websockets/decoders/pumpswap.ts`
- `backend/src/server/pools/websockets/decoders/meteoraBalanced.ts`

### Original File (Unchanged)
- `backend/src/server/pools.websockets.ts` (remains working, will be replaced in final phase)

## Next Steps to Complete Refactoring

1. **Extract Smallest Decoder First** (Meteora Balanced or Pumpswap)
   - Read the relevant sections from the handle function
   - Extract to the decoder module
   - Preserve all side effects
   - Test independently

2. **Extract Remaining Decoders** (One at a time)
   - Follow same pattern for each DEX
   - Maintain consistent interface
   - Document any quirks or special cases

3. **Extract Subscription Logic**
   - Move subscription setup from the massive setup function
   - Use the subscriptions module's retry logic
   - Integrate with decoder modules

4. **Extract Target Logic**
   - Move `getWsTargets` implementation from original file
   - Move `retargetPoolWebsockets` implementation
   - Wire with subscriptions module

5. **Create New Orchestrator**
   - Wire all modules together
   - Expose same public API
   - Initialize state correctly
   - Handle lifecycle events

6. **Test & Verify**
   - Run existing tests
   - Add new module tests
   - Verify metrics match
   - Monitor runtime behavior

7. **Deploy & Monitor**
   - Deploy refactored version
   - Monitor for regressions
   - Compare metrics before/after
   - Verify performance

## Benefits Already Achieved

Even with just the infrastructure modules created:
- ✅ Clear module boundaries defined
- ✅ Type safety improved
- ✅ Dependencies made explicit
- ✅ Testing surface identified
- ✅ Documentation created
- ✅ Development roadmap established

## Estimated Remaining Work

- **Decoder Extraction**: ~8-12 hours (complex, requires careful extraction)
- **Subscription Logic**: ~3-4 hours
- **Target Logic**: ~2-3 hours
- **Orchestrator**: ~4-6 hours
- **Testing**: ~4-6 hours
- **Total**: ~21-31 hours of focused development

## Conclusion

Phase 1 (Infrastructure) is **complete**. We've created a solid foundation of utility modules that are ready to be used by the decoders and orchestrator.

The next phase (Decoder Extraction) is the most complex because the logic is deeply embedded in the original file. However, with the infrastructure in place, each decoder can be extracted incrementally and tested independently.

The refactoring follows best practices:
- Separation of concerns
- Dependency injection
- Type safety
- Testability
- Incremental migration
- Backward compatibility

Once complete, the codebase will be significantly more maintainable, with focused 100-800 line modules instead of a single 3,762-line monolith.

