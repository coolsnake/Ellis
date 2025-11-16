# RPC-Priority Decimal Resolution Implementation

## Summary

Implemented RPC-first decimal resolution across all DEX normalizers to ensure on-chain validation is the priority source of truth for token decimals during pool normalization.

## Problem Statement

Previously, the system had two separate decimal resolution approaches:
1. **Performance Mode**: Cache → Jupiter Map → RPC (last resort)
2. **Validation Mode**: RPC → Jupiter Map (validation priority)

The normalizers were using "performance mode" by default, which meant they were relying on cached or Jupiter data first, with RPC as a fallback. This could lead to stale or incorrect decimals being used during price calculations.

## User Requirement

> "We want RPC enrichment to be the priority to establish the truth, and then its results that its saved to the tokenmint cache or whatever to be used from then. but we should always have the RPC enrichment run when we fetch and normalize the pools etc so that we get total coverage and accurate values for all mints in the pools we target."

## Solution

### Architecture

The system already had the infrastructure in place:

1. **`backend/src/server/pools/decimals.ts`**: 
   - `resolveManyDecimals()` function with `normalizeMode` option
   - When `normalizeMode: true`, priority order is:
     - Anchors (hardcoded SOL, USDC, USDT, USD1)
     - **RPC validation (FIRST for all other tokens)**
     - Jupiter map (fallback for RPC failures)
     - Cache for RPC-validated results

2. **`backend/src/utils/tokens.ts`**:
   - `enrichPoolTokenDecimals()` already delegates to `resolveManyDecimals` with `normalizeMode: true`
   - Extracts all mints from pool data and validates them on-chain

### Changes Made

Updated all normalizers to pass `normalizeMode: true` when calling `resolveManyDecimals`:

#### 1. Orca (`backend/src/server/pools/orca.ts`)

```typescript
// BEFORE
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { logger });

// AFTER
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  normalizeMode: true // RPC validation priority during normalization
});
```

#### 2. Meteora DLMM (`backend/src/server/pools/meteora.ts`)

```typescript
// BEFORE
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  batchSize: 100 
});

// AFTER
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  batchSize: 100,
  normalizeMode: true // RPC validation priority during normalization
});
```

#### 3. Raydium (`backend/src/server/pools/raydium.ts`)

```typescript
// BEFORE
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { logger });

// AFTER
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  normalizeMode: true // RPC validation priority during normalization
});
```

#### 4. Meteora Balanced (`backend/src/server/pools/meteoraBalanced.ts`)

Updated both normalizer functions (HTTP and V2):

```typescript
// BEFORE (2 occurrences)
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { logger });

// AFTER (2 occurrences)
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  normalizeMode: true // RPC validation priority during normalization
});
```

#### 5. PumpSwap (`backend/src/server/pools/pumpswap.ts`)

```typescript
// BEFORE
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { logger });

// AFTER
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
  logger, 
  normalizeMode: true // RPC validation priority during normalization
});
```

## How It Works

### Normalization Flow (with `normalizeMode: true`)

1. **Extract Mints**: All unique mints are collected from the raw pool data
2. **Check Anchors**: Hardcoded decimals for SOL, USDC, USDT, USD1 (always trusted)
3. **RPC Validation** (PRIORITY):
   - Batch fetch account info for all non-anchor mints
   - Verify accounts are owned by Token Program or Token-2022 Program
   - Parse decimals directly from on-chain mint account data (offset 44)
   - Cache validated decimals in memory for future use
   - Log validation progress with `decimals.normalize.rpc_validate.*` events
4. **Jupiter Fallback**: For any RPC failures, fall back to Jupiter token map
5. **Cache Results**: All RPC-validated decimals are saved to `resolveCache` for subsequent lookups

### Performance Considerations

- **Batch Processing**: Uses `getMultipleAccountsInfo` for efficient RPC calls
- **Configurable Batch Size**: Default 100 accounts per RPC call
- **Smart Caching**: RPC-validated results are cached and reused
- **Anchor Short-Circuit**: Well-known tokens skip RPC entirely
- **Graceful Fallbacks**: Network issues or program errors fall back to Jupiter

### Logging

The system provides comprehensive logging for monitoring and debugging:

```typescript
// Start of validation
logger.info('decimals.normalize.rpc_validate.start', {
  total: mints.length,
  needsValidation: needsLookup.size,
  mode: 'validation',
  cat: 'decimals'
});

// Completion summary
logger.info('decimals.normalize.rpc_validate.complete', {
  total: mints.length,
  validated: rpcValidated,
  failed: rpcFailed,
  needsJupiterFallback: needsJupiter.size,
  cat: 'decimals'
});

// Overall resolution summary
logger.info('decimals.resolution.summary', {
  total: mints.length,
  resolved: result.size,
  mode: 'normalize',
  sources: {
    anchors: fromAnchors,
    cache: fromCache,
    validated: result.size - fromAnchors - fromCache,
  },
  cat: 'decimals'
});
```

## Benefits

1. **Accuracy**: On-chain data is the authoritative source of truth
2. **Coverage**: All mints in targeted pools are validated on-chain
3. **Consistency**: Same decimal resolution logic across all normalizers
4. **Caching**: RPC-validated decimals are cached for performance
5. **Observability**: Comprehensive logging for monitoring and debugging
6. **Reliability**: Graceful fallbacks to Jupiter if RPC fails

## Impact on Price Calculation

With RPC-first validation:
- Pool decimals are always accurate at normalization time
- Price calculations use correct decimal scaling factors
- Cross-DEX price validation becomes more reliable
- False arbitrage opportunities from decimal mismatches are reduced

## Files Modified

1. `backend/src/server/pools/orca.ts`
2. `backend/src/server/pools/meteora.ts`
3. `backend/src/server/pools/raydium.ts`
4. `backend/src/server/pools/meteoraBalanced.ts`
5. `backend/src/server/pools/pumpswap.ts`
6. `backend/src/server/pools.ts` (minor TypeScript fix)

## Testing

All changes compile successfully:

```bash
cd backend
npx tsc -p tsconfig.json
# ✅ No errors
```

## Future Considerations

1. **Rate Limiting**: Monitor RPC usage and adjust batch sizes if needed
2. **Retry Logic**: Consider adding exponential backoff for transient RPC failures
3. **Metrics**: Track RPC validation success/failure rates
4. **Cache Persistence**: Consider persisting RPC-validated decimals to disk for faster startup

## Related Documents

- `COMPLETE_DECIMAL_FIX_SUMMARY.md` - Prior decimal orientation fixes
- `DECIMAL_ORIENTATION_CRITICAL_FIX.md` - Critical bug fixes for Orca/Raydium
- `METEORA_DECIMAL_JOURNEY.md` - Meteora DLMM price calculation fixes
- `FINAL_DECIMAL_FIX_COMPLETE.md` - Cross-DEX validation and filtering system

---

**Status**: ✅ Complete  
**Date**: 2025-11-16  
**Impact**: All normalizers now use RPC-first decimal validation

