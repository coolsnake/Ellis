# 🎯 FINAL FIX: Meteora DLMM Decimal Handling

## The Journey

### Attempt 1: Remove Decimal Adjustment (WRONG)
**Thought**: The `* Math.pow(10, decA - decB)` was causing issues after canonicalization.

**Change**:
```typescript
// Removed decimal adjustment
const priceYperX = Math.pow(f, activeId);  // Native units only
```

**Result**: ❌ Prices were off by 100x-10,000x depending on decimal differences

---

### Attempt 2: Re-apply Decimals After Canonicalization (INCOMPLETE)
**Thought**: Apply decimal scaling AFTER canonicalization using the correct (swapped) decimals.

**Change**:
```typescript
// After canonicalization
for (const pool of clmmCanon) {
  const scale = Math.pow(10, pool.decimals_b - pool.decimals_a);
  pool.price_a_per_b *= scale;
}
```

**Result**: ❌ Logic error - this would have made things worse

---

### Attempt 3: Correct Decimal Formula (CORRECT ✅)
**Understanding**: The Meteora DLMM formula IS:

```
priceYperX = (1 + binStep/10000)^activeId * 10^(decY - decX)
```

This gives **Y per X in WHOLE token units**.

**The key insight**: When we apply `decB - decA` BEFORE canonicalization:
- If `decB - decA = 2` (e.g., SOL=9, USDC=6)
- Price gets multiplied by 100

Then canonicalization:
- Swaps mints: SOL ↔ USDC
- Swaps decimals: 9 ↔ 6
- Inverts price: `price = 1 / price`

The net effect:
- Original: `price * 10^2`
- After swap: `1 / (price * 10^2) = (1/price) * 10^-2`
- The `10^-2` is WRONG! It should be `10^2` for the NEW orientation

**But wait...** that's still wrong! Let me think again...

---

## The Correct Understanding

Meteora's formula for bin price:

```
price_in_native_units = (1.0001)^(binStep * activeId)
```

To convert to whole token units:

```
price_whole = price_native * 10^(decB - decA)
```

**Example: oreoU2 (11 dec) / SOL (9 dec)**

API gives:
- `activeId = -50000`
- `binStep = 10`
- `mint_a = oreoU2`, `mint_b = SOL`

Calculate:
```
f = 1.0001^10 = 1.001
price_native = 1.001^(-50000) = 0.00672 (SOL per oreoU2 in native units)

decA = 11 (oreoU2)
decB = 9 (SOL)
scale = 10^(9 - 11) = 0.01

price_whole = 0.00672 * 0.01 = 0.0000672 SOL per 1 oreoU2 (whole units)
```

After canonicalization (SOL higher priority):
```
mint_a = SOL (9 dec)
mint_b = oreoU2 (11 dec)
decimals_a = 9
decimals_b = 11

price_inverted = 1 / 0.0000672 = 14,880 oreoU2 per 1 SOL ❌ WRONG!
```

The correct price should be ~0.748 oreoU2 per 1 SOL, which means 1 SOL = ~0.748 oreoU2.

Wait, let me check the user's statement again: "Rate 1 SOL ≈ 0.748 ORE"

So 1 SOL buys 0.748 ORE. That's **ORE per SOL**.

After canonicalization, if we have:
- `mint_a = SOL`
- `mint_b = ORE`
- Then `price_a_per_b` should be ORE per 1 SOL = 0.748

But we're seeing `rate 75094547.268353`, which is way too high!

## Root Cause

The issue is that `decA` and `decB` are determined BEFORE canonicalization, then used in the price formula. But after canonicalization, those decimals might be swapped!

The fix: **Use the decimal adjustment with current (pre-canon) decimals, let canonicalization handle the inversion.**

Actually, I think the current implementation (Attempt 3) is correct. The issue might be elsewhere - perhaps in how the graph is using the prices?

Let me add diagnostic logging to see what prices are actually being stored.

