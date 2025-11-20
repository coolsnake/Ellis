# Meteora Price Explosion Fix - Double Inversion Bug

## Issue
Arbiter was reporting fake arbitrage opportunities with product explosions (e.g., 1,362,938 instead of 1.0) for Meteora pools using reverse edges.

Example from logs:
```
path=6p6x...->So11... profit_bps=13629378529 rates=[48185.723843, 28.285117]
edges=[6p6x...->So11...:71HuF...#rev, So11...->6p6x...:4CTU...]
```

The first hop (TRUMP→SOL) using a reverse edge had a rate of 48,185 when it should have been ~0.00002.

## Root Cause
**Double inversion bug in the Rust arbiter's `edge_rate_effective_local` function.**

### The Flow:
1. **Backend (Node.js)** sends edges with:
   - `source`, `target` (canonicalized mints)
   - `price_a_per_b` = amount of A per 1 B (where A=mint_a, B=mint_b after canonicalization)
   
2. **For TRUMP/SOL pool:**
   - On-chain: `tokenX=TRUMP, tokenY=SOL`
   - After canonicalization: `mint_a=SOL, mint_b=TRUMP` (swapped because SOL < TRUMP lexicographically)
   - Backend sends: `source=SOL, target=TRUMP, price_a_per_b=48000` (48000 SOL per 1 TRUMP)

3. **Arbiter creates bidirectional edges:**
   - Forward: `source=SOL, target=TRUMP, price=48000` ✓
   - Reverse: `source=TRUMP, target=SOL, price=1/48000=0.00002` ✓ (inverted once)

4. **BUG: `edge_rate_effective_local` inverted AGAIN:**
   ```rust
   // OLD CODE (WRONG):
   let base: f64 = 1.0 / px;  // Inverted: 1/0.00002 = 48000
   ```
   This caused the reverse edge to have `rate_effective=48000` instead of `0.00002`.

### Why the Double Inversion Happened:
The function had an incorrect assumption in its comment:
> "price_a_per_b always represents 'source-per-1-target'"

This was **wrong**. The `price_a_per_b` from the backend represents "A per 1 B" where A and B are the **canonicalized mints**, not the edge's source/target. For reverse edges, `insert_bidirectional_edges` already inverts the price, so it arrives at `edge_rate_effective_local` **already correctly oriented** as "target per source".

## The Fix

### In `arb-rs/src/main.rs`:
Changed `edge_rate_effective_local` to **not invert** the price:

```rust
// BEFORE (line 3571):
let base: f64 = 1.0 / px;  // Double inversion!

// AFTER:
let base: f64 = px;  // No inversion - already correct orientation
```

### Updated comment to explain:
```rust
// CRITICAL: price_a_per_b from backend represents "A per 1 B" where A/B are canonicalized mints.
// For forward edges: source=A, target=B, price_a_per_b = A/B
// For reverse edges: insert_bidirectional_edges already inverts to get B/A before calling this.
// So price here is ALREADY "target per 1 source" - NO NEED TO INVERT AGAIN!
```

### Why Meteora Was Affected:
The bug affected **all pools**, but was most visible with Meteora because:
1. Meteora pools with exotic tokens (like TRUMP/SOL) often get canonicalized (swapped)
2. The arbiter's pathfinding algorithm frequently uses reverse edges for these pairs
3. The magnitude difference (48,000x) made the fake opportunities obvious

## Verification
After the fix:
- TRUMP→SOL reverse edge rate: ~0.00002 ✓ (correct)
- SOL→TRUMP forward edge rate: ~48,000 ✓ (correct)
- Product for round-trip: 0.00002 × 48,000 ≈ 1.0 ✓ (no arbitrage)

## Files Changed
- `arb-rs/src/main.rs`: Fixed `edge_rate_effective_local` (line 3560-3577)
- `backend/src/server/pools/priceFormulas.ts`: Reverted experimental changes (formula was already correct)

