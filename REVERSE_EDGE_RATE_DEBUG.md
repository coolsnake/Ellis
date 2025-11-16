# Reverse Edge Rate Calculation Debug

## Issue
Strange profit rates appearing with reverse edges, even after implementing direction-aware rate calculation.

## Current Implementation

### Backend (TypeScript)
1. **Pool canonicalization**: Price is A-per-1-B for canonical mint order
2. **Edge creation** (`edgesFromPoolIncremental`):
   - Forward edge: `price_a_per_b = fwd` (A-per-1-B, processed by `computePriceForward`)
   - Reverse edge: `price_a_per_b = rev` (B-per-1-A, processed by `computePriceReverse`)
   - Both edges have `direction` field set correctly

### Rust (arb-rs)
1. **Rate calculation** (`edge_rate_effective_local`):
   - Forward edge: `rate_effective = (1.0 / price_a_per_b) * (1 - fee)` = (B-per-1-A) * (1 - fee)
   - Reverse edge: `rate_effective = price_a_per_b * (1 - fee)` = (B-per-1-A) * (1 - fee)

## Expected Behavior

For a cycle A->B->A:
- Edge A->B: `rate_effective` = B-per-1-A (after fees)
- Edge B->A: `rate_effective` = A-per-1-B (after fees)
- Product = (B-per-1-A) * (A-per-1-B) ≈ 1 (accounting for fees)

## Potential Issues to Check

1. **Direction field not being sent**: Verify that `direction` field is actually in the JSON sent to Rust
2. **Direction field parsing**: Verify that Rust is correctly parsing the direction field
3. **Edge source/target mismatch**: Verify that reverse edges have correct source/target
4. **Price calculation in computePriceReverse**: Verify that `computePriceReverse` is returning B-per-1-A correctly
5. **Rate multiplication in cycles**: Verify that rates are being multiplied correctly in cycle detection

## Diagnostic Steps

1. Add logging to verify direction field is present in edges
2. Add logging to show price_a_per_b and calculated rate_effective for both forward and reverse edges
3. Verify that forward * reverse price product ≈ 1 in backend
4. Verify that rate_effective values are reasonable (not 7286, 139, etc.)

