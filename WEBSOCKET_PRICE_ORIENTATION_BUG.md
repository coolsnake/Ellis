# Meteora WebSocket Price Orientation Bug - FIXED

## The Problem

Meteora WebSocket updates showed inverted prices:
- **Meteora pool (71HuF...)**: `price_a_per_b = 48669.75` (SOL per TRUMP) - **WRONG**
- **Orca pool (AbTXf...)**: `price_a_per_b = 0.0488` (SOL per TRUMP) - **CORRECT**

Real market: 1 SOL ≈ 28 TRUMP, so 1 TRUMP ≈ 0.0357 SOL

This caused fake arbitrage opportunities with profit explosions (e.g., 1,362,938 BPS instead of 0).

## Root Cause

The WebSocket decoder calculated price manually and didn't respect canonicalization:

### Before Fix (pools.websockets.ts line ~1770)
```typescript
const bPerA = Math.exp(logPrice);  // Y/X (SOL/TRUMP) = 0.0357
price_a_per_b = 1 / bPerA;         // Inverted to X/Y = 28

// Creates pool
mint_a: tokenX,   // TRUMP
mint_b: tokenY,   // SOL
price_a_per_b: 28 // TRUMP per SOL

// Canonicalization swaps mints but NOT price
mint_a: SOL       // Swapped
mint_b: TRUMP     // Swapped
price_a_per_b: 28 // NOT INVERTED - now means 28 SOL per TRUMP! ❌
```

## The Fix

Replaced manual price calculation with `processPriceThroughPipeline` for consistent handling:

```typescript
// Use the price pipeline for consistent orientation handling
const { processPriceThroughPipeline } = await import('./pools/pricePipeline.js');
const processedPrice = processPriceThroughPipeline({
  mintA: tokenX,
  mintB: tokenY,
  decimalsA: decA,
  decimalsB: decB,
  poolId,
  dex: 'Meteora',
  poolType: 'clmm',
  activeId: Number(activeId),
  binStep: Number(binStep),
  tokenXMint: tokenX,
  tokenYMint: tokenY,
});

// Use pipeline-processed result (already canonicalized)
const item: ClmmPool = {
  id: poolId,
  dex: 'Meteora',
  mint_a: processedPrice.mintA,      // Already canonicalized
  mint_b: processedPrice.mintB,      // Already canonicalized
  price_a_per_b: processedPrice.priceForward,  // Correct orientation
  was_swapped: processedPrice.wasSwapped,
  native_mint_a: tokenX,             // Preserve native orientation
  native_mint_b: tokenY,
  _pipelineProcessed: true,
  ...
};

// Skip manual canonicalizePools call - pipeline already did it
const finalItem = item;
```

## Why This Works

1. **Consistent Logic**: Both HTTP normalizer and WebSocket decoder use the same pipeline
2. **Proper Canonicalization**: Pipeline handles mint swapping AND price inversion together
3. **Orientation Tracking**: `was_swapped` and `native_mint_a/b` fields preserve native state

## Expected Result After Fix

For TRUMP/SOL pool:
```
mint_a: SOL
mint_b: TRUMP  
price_a_per_b: 0.0357 (SOL per TRUMP) ✓
was_swapped: true
native_mint_a: TRUMP
native_mint_b: SOL
```

This matches Orca pools and eliminates fake arbitrage opportunities.

## Files Changed
- `backend/src/server/pools.websockets.ts`: Lines 1763-1870, 1929-1930, 2005-2012
  - Replaced manual price calculation with `processPriceThroughPipeline`
  - Used pipeline-processed mints and price directly
  - Skipped redundant `canonicalizePools` call


