# WebSocket Price Orientation Bug - Complete Fix

## Issue Summary
WebSocket decoders for Meteora and Raydium were recalculating prices without respecting canonicalization, leading to inverted prices and fake arbitrage opportunities (e.g., 1,362,938 BPS profit).

## Root Cause
Both Meteora and Raydium WebSocket handlers manually calculated prices from on-chain data, then applied canonicalization which swapped mints but **not prices**, resulting in orientation mismatches.

## Affected DEXes

### ✅ Meteora - FIXED
**Problem**: Manual price calculation (activeId/binStep) didn't respect canonicalization
**Fix Applied**: Lines 1763-2012 in `pools.websockets.ts`
- Replaced manual calculation with `processPriceThroughPipeline`
- Uses pipeline-processed mints and price (already canonicalized)
- Skipped redundant `canonicalizePools` call

### ✅ Raydium CLMM - FIXED  
**Problem**: Got decimals from **cached pool** (already canonicalized), causing decimal mismatch with native mint order
**Fix Applied**: Lines 956-1206 in `pools.websockets.ts`
- Replaced cached decimal lookup with fresh resolution for native mints
- Used `processPriceThroughPipeline` for consistent orientation handling
- Skipped redundant `canonicalizePools` call

### ✅ Orca - SAFE (No changes needed)
**Status**: No issue detected
**Why**: Uses `sqrtPriceX64ToPriceRatio` directly from on-chain data and merges updates (preserving existing price from HTTP normalization)

### ✅ Pumpswap - SAFE (No changes needed)
**Status**: No issue detected  
**Why**: Uses vault balance updates, not price recalculation

## The Fix Pattern

Both Meteora and Raydium now follow this pattern:

```typescript
// 1. Get decimals for NATIVE mint order (not cached canonical order)
const { resolveDecimals } = await import('./pools/decimals.js');
const decA = await resolveDecimals(mintA);  // mintA from on-chain state
const decB = await resolveDecimals(mintB);  // mintB from on-chain state

// 2. Use price pipeline for consistent orientation
const { processPriceThroughPipeline } = await import('./pools/pricePipeline.js');
const processedPrice = processPriceThroughPipeline({
  mintA,               // Native mint order
  mintB,
  decimalsA: decA,
  decimalsB: decB,
  poolId,
  dex,
  poolType: 'clmm',
  sqrtPriceX64,        // or activeId/binStep for Meteora
});

// 3. Use pipeline result directly (already canonicalized)
const item: ClmmPool = {
  id: poolId,
  dex,
  mint_a: processedPrice.mintA,      // Already canonical
  mint_b: processedPrice.mintB,      // Already canonical
  price_a_per_b: processedPrice.priceForward,  // Correct orientation
  was_swapped: processedPrice.wasSwapped,
  native_mint_a: mintA,               // Preserve native
  native_mint_b: mintB,
  _pipelineProcessed: true,
  ...
};

// 4. Skip manual canonicalization (pipeline already did it)
const finalItem = item;
```

## Benefits

1. **Consistency**: HTTP normalizer and WebSocket decoder use identical logic
2. **Correctness**: Canonicalization handles mint swapping and price inversion together
3. **Maintainability**: Single source of truth for price calculations
4. **Tracking**: `was_swapped` and `native_mint_*` fields preserve orientation state

## Expected Results

### Before Fix
```
Meteora TRUMP/SOL:
  mint_a: SOL, mint_b: TRUMP
  price_a_per_b: 48669.75  ❌ (means 48669 SOL per TRUMP - wrong!)

Raydium TRUMP/SOL:
  Similar inversion issue with cached decimals
```

### After Fix
```
Meteora TRUMP/SOL:
  mint_a: SOL, mint_b: TRUMP
  price_a_per_b: 0.0357  ✓ (means 0.0357 SOL per TRUMP - correct!)
  was_swapped: true
  native_mint_a: TRUMP, native_mint_b: SOL

Raydium TRUMP/SOL:
  mint_a: SOL, mint_b: TRUMP
  price_a_per_b: 0.0357  ✓ (correct!)
  was_swapped: true
  native_mint_a: TRUMP, native_mint_b: SOL
```

This eliminates all fake arbitrage opportunities caused by inverted prices.

## Files Changed
- `backend/src/server/pools.websockets.ts`:
  - Lines 1763-2012: Meteora WebSocket decoder
  - Lines 956-1206: Raydium CLMM WebSocket decoder

