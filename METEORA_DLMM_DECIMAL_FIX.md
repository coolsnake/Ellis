# CRITICAL FIX: Meteora DLMM Decimal Conversion Bug

## The Bug

**Location**: `backend/src/server/pools/meteora.ts` line 294-295

**Old Code** (WRONG):
```typescript
const decimalScale = Math.pow(10, decA - decB);
const priceAperB_whole = priceAperB_native * decimalScale;  // ❌ MULTIPLY
```

**Problem**: The decimal conversion was **multiplying** when it should **divide**, causing 10^3 to 10^9 magnitude errors!

## The Math

When converting from native units (smallest units) to whole token units:

```
Native price: A_native per B_native (both in smallest units)
Whole price: A_whole per B_whole (both in whole tokens)

A_whole = A_native / 10^decA
B_whole = B_native / 10^decB

Therefore:
price_whole = A_whole / B_whole 
            = (A_native / 10^decA) / (B_native / 10^decB)
            = (A_native / B_native) * (10^decB / 10^decA)
            = price_native * 10^(decB - decA)
            = price_native / 10^(decA - decB)  ← DIVIDE, not multiply!
```

## Real-World Example

**JLP/SOL Pool**:
- JLP: 6 decimals (decA = 6)
- SOL: 9 decimals (decB = 9)
- Native price from DLMM: 70,000,000 (70 million in smallest units)
- decimalScale = 10^(6-9) = 10^(-3) = 0.001

**Old formula (WRONG)**:
```
price = 70,000,000 * 0.001 = 70,000 ❌
```

**New formula (CORRECT)**:
```
price = 70,000,000 / 0.001 = 70 ✅
```

Or equivalently (the actual math):
```
price = 70,000,000 * 10^(9-6) = 70,000,000 * 1000 = 70 billion... wait that's wrong
```

Actually, let me recalculate:

The native price is in smallest units:
- If JLP_native/SOL_native = 70,000,000 (70M smallest JLP units per smallest SOL unit)
- JLP_whole = JLP_native / 10^6
- SOL_whole = SOL_native / 10^9
- Price_whole = JLP_whole/SOL_whole = (JLP_native/10^6)/(SOL_native/10^9)
- Price_whole = (JLP_native/SOL_native) * (10^9/10^6) 
- Price_whole = 70,000,000 * 10^3 = 70 billion

Hmm, that gives 70 billion, not 70. Let me think about this differently...

Actually, the DLMM formula gives Y per X in native units. So if:
- priceYperX_native = 70 (70 smallest Y per smallest X)
- X = SOL (9 decimals), Y = JLP (6 decimals)
- Then 70 smallest JLP per smallest SOL
- Converting to whole: (70 / 10^6) JLP whole per (1 / 10^9) SOL whole
- = 70 * 10^9 / 10^6 = 70 * 10^3 = 70,000 whole JLP per whole SOL

So the old formula multiplying by 10^(6-9) = 10^(-3) = 0.001:
- 70 * 0.001 = 0.07 whole JLP per whole SOL (1000x too small!)

And the new formula dividing by 10^(6-9) = 10^(-3):
- 70 / 0.001 = 70,000 whole JLP per whole SOL (correct!)

Actually wait, if JLP is $2 and SOL is $140, then:
- SOL per JLP = $2 / $140 = 0.0143
- JLP per SOL = $140 / $2 = 70

So yes, we should get 70 JLP per SOL, and the new formula gives 70,000 which is still 1000x too high!

Let me re-examine the formula...

