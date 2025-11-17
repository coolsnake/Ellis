# WebSocket Pools Refactoring

This directory contains the refactored WebSocket pool monitoring system, extracted from the monolithic `pools.websockets.ts` file.

## Directory Structure

```
websockets/
├── types.ts                    # Shared types and interfaces
├── connection.ts              # Connection lifecycle management
├── subscriptions.ts           # Subscription management with retry
├── validation.ts              # Pool validation utilities
├── metrics.ts                 # Metrics aggregation
├── batching.ts                # Account info batching
├── apply.ts                   # Debounced graph updates
├── preload.ts                 # Cache preloading
├── meteoraBins.ts             # Meteora bin tracking
├── targets.ts                 # Target management
├── REFACTORING_STATUS.md      # Implementation status
├── README.md                  # This file
└── decoders/
    ├── raydium.ts             # Raydium AMM/CLMM decoder
    ├── orca.ts                # Orca CLMM decoder
    ├── meteora.ts             # Meteora DLMM decoder
    ├── pumpswap.ts            # Pumpswap decoder
    └── meteoraBalanced.ts     # Meteora Balanced decoder
```

## Module Responsibilities

### Core Modules

#### `types.ts`
- Shared TypeScript interfaces and type definitions
- `RefreshAllSourcesHandler`, `DexSource`, `ValidationResult`, etc.
- Connection state, subscription state, and decoder interfaces

#### `connection.ts`
- WebSocket connection lifecycle (creation, teardown, health monitoring)
- Connection state management (`wsConn`, `wsClosePromise`, `wsHealthy`)
- Health timer and event tracking
- Connection protection utilities (`withWsProtection`)

#### `subscriptions.ts`
- Account and program subscription management
- Retry logic with exponential backoff
- Subscription state tracking per DEX
- Cleanup utilities

#### `validation.ts`
- Pool data validation (`validateDecodedPool`)
- Validation statistics tracking
- Debug logging helper (`debugLogTargeted`)

#### `metrics.ts`
- Re-exports metrics from `pools.metrics.js`
- WebSocket activity counts per DEX
- Decode success/failure tracking
- Delta statistics

#### `batching.ts`
- Batches `getAccountInfo` calls to reduce RPC load
- 50ms batch window for optimal performance
- Queue management and error handling

#### `apply.ts`
- Debounced graph update scheduler (`scheduleDexApply`)
- 100ms debounce window per DEX
- Baseline tracking for delta detection
- Timer management

#### `preload.ts`
- Vault cache preloading for Pumpswap and Meteora Balanced
- Prevents decode failures when pool events arrive before vault events
- Batch RPC calls for efficiency

#### `meteoraBins.ts`
- Meteora DLMM bin array tracking
- Bin subscription management
- Hash aggregation for change detection
- Bin account to pool mapping

#### `targets.ts`
- Computes WebSocket subscription targets from graph data
- Target reconciliation logic
- Retargeting coordination

### Decoder Modules

Each decoder module handles DEX-specific pool decoding:

- **`raydium.ts`**: Raydium AMM and CLMM pools (~800 lines of logic)
- **`orca.ts`**: Orca CLMM pools (~400 lines of logic)
- **`meteora.ts`**: Meteora DLMM pools (~600 lines of logic)
- **`pumpswap.ts`**: Pumpswap pools (~300 lines of logic)
- **`meteoraBalanced.ts`**: Meteora Balanced pools (~200 lines of logic)

Each decoder exports:
- `decodePool(accountData, poolId)`: Decode pool from account data
- `handleAccountUpdate(account, poolId)`: Handle WebSocket account updates

## Migration Status

### Phase 1: Infrastructure ✅
- [x] Create directory structure
- [x] Extract utility modules (validation, metrics, batching, apply, preload)
- [x] Extract connection management
- [x] Extract Meteora bin tracking
- [x] Create type definitions

### Phase 2: Decoders 🚧
- [ ] Extract Pumpswap decoder (smallest, ~300 lines)
- [ ] Extract Meteora Balanced decoder (~200 lines)
- [ ] Extract Orca decoder (~400 lines)
- [ ] Extract Meteora DLMM decoder (~600 lines)
- [ ] Extract Raydium decoder (largest, ~800 lines)

### Phase 3: Orchestration 📋
- [ ] Extract subscription logic
- [ ] Extract target management
- [ ] Refactor main orchestrator
- [ ] Wire modules together with dependency injection

### Phase 4: Testing & Rollout 📋
- [ ] Unit tests for decoders
- [ ] Integration tests for WebSocket flow
- [ ] Verify metrics and logging
- [ ] Monitor runtime behavior

## Design Principles

1. **Separation of Concerns**: Each module has a single, well-defined responsibility
2. **Dependency Injection**: Modules receive dependencies rather than importing globals
3. **Explicit State**: State is managed explicitly, not hidden in closures
4. **Type Safety**: Strong TypeScript types throughout
5. **Testability**: Modules can be tested independently
6. **Backward Compatibility**: Public API remains unchanged

## Usage

The refactored modules are designed to be imported by a new orchestrator that will replace the monolithic `pools.websockets.ts`. The public API will remain identical:

```typescript
// Public API (unchanged)
export function startPoolWebsocketsOnlyOnce(): void { ... }
export function getWsActivity(): { ... } { ... }
export async function getWsTargets(): Promise<{ ... }> { ... }
export async function retargetPoolWebsockets(): Promise<{ ... }> { ... }
export function stopPoolRefreshLoop(): void { ... }
export function enablePoolWebsocketRefreshes(): void { ... }
export function disablePoolWebsocketRefreshes(): void { ... }
export function getPoolWsStatus(): { ... } { ... }
export function isMeteoraBinArraySubscribed(address: string): boolean { ... }
```

## Benefits of Refactoring

1. **Maintainability**: 500-line modules instead of a 3,762-line monolith
2. **Testability**: Each decoder can be tested independently
3. **Parallel Development**: Multiple developers can work on different DEXes
4. **Code Reuse**: Utilities shared across DEXes
5. **Debugging**: Easier to trace issues in focused modules
6. **Performance**: No impact (same logic, better organization)

## Implementation Notes

The original `pools.websockets.ts` contained a massive `handle` function (~3000 lines) with embedded decoder logic for all DEXes. The refactoring extracts this logic into separate, focused decoder modules while preserving all functionality, metrics, logging, and side effects.

The migration is being done carefully to ensure:
- No breaking changes to the public API
- All metrics and logs preserved
- Performance characteristics maintained
- Error handling preserved
- All edge cases handled

## Next Steps

1. Complete decoder extractions (in progress)
2. Extract subscription management logic
3. Create the new orchestrator
4. Test and verify behavior
5. Deploy and monitor

## Questions or Issues

See `REFACTORING_STATUS.md` for detailed implementation status and notes.

