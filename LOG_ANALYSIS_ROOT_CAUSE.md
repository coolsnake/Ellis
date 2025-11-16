# Log Analysis: Rate Issue Root Cause Identified

## Executive Summary

**✅ Good News**: Canonicalization is working perfectly (0.0000% deviation)
**🔴 Bad News**: Meteora/MeteoraBalanced normalizers are producing wrong prices BEFORE canonicalization

## Log Analysis

### 1. Canonicalization Logs - Working Correctly ✅

```
canonical.swap.price_check
orig_price: 124986867.46282637
new_price: 8.000840570689719e-9
expected_inverse: 8.000840570689719e-9
deviation_pct: "0.0000"  ← Perfect!
```

**Finding**: Price inversion during canonicalization is mathematically perfect. The problem is the **input price** (125 million) is already wrong.

### 2. Cross-DEX Validation - Meteora Has Issues 🔴

```
"by_dex": {
  "raydium": 1 anomaly,
  "meteora_balanced": 3 anomalies,
  "orca": 5 anomalies,
  "meteora": 8 anomalies  ← MOST PROBLEMS
}

"by_root_cause": {
  "minor_deviation_or_stale_data": 11,
  "orientation_or_formula_error": 5,  ← Price calculation wrong
  "power_of_10_error_-1x": 1
}
```

**Finding**: Meteora has 8 anomalies, with 5 classified as "orientation_or_formula_error". This means the Meteora price formula itself is producing incorrect results.

### 3. Specific Problem Examples

#### Example A: 125 Million Price
```
Pool: 121gBYp2EURZ (MeteoraBalanced_v2)
orig_price: 124,986,867.46282637
decimals: 6→9
```

This pool has a price of **125 million** before canonicalization. After inversion: `8.0e-9`.

**Analysis**: If this is a raw unit price (not whole token price), it might be correct:
- Token with 6 decimals / SOL with 9 decimals
- Decimal difference: 10^(9-6) = 10^3 = 1000x
- But 125 million is 10^8, suggesting raw amounts aren't being converted properly

#### Example B: 36 Billion Price
```
Pool: 121qcmoihBDa (MeteoraBalanced_v2)
orig_price: 2.7753e-11
new_price: 36,031,840,753.54 (after swap)
decimals: 9→6
```

**Analysis**: 36 billion is 10^10. With decimal difference of 10^3, this is 10^7 times too large, suggesting the amounts are in **smallest units** not **whole tokens**.

#### Example C: JLP/SOL Cross-DEX Mismatch
```
Pool: 6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd
Orca: 29.24 JLP per SOL
Meteora: 4.52 JLP per SOL
Deviation: 547%
```

**Expected**: ~70 JLP per SOL (if JLP=$2, SOL=$140)

Both DEXes are giving wrong prices, but Meteora is 15x off from expected.

## Root Cause Analysis

### Hypothesis 1: Raw vs Whole Token Confusion

The Meteora Balanced normalizer code (lines 188-192):
```typescript
const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
wholeA = (Number.isFinite(amtAraw) && Number.isFinite(decA)) ? (amtAraw / Math.pow(10, decA as number)) : NaN;
wholeB = (Number.isFinite(amtBraw) && Number.isFinite(decB)) ? (amtBraw / Math.pow(10, decB as number)) : NaN;
```

**The Issue**: The code assumes `reserveA` and `reserveB` are **raw amounts** (smallest units) and divides by decimals. But what if the API is returning **whole token amounts** already?

If the API returns whole amounts and we divide by decimals again:
- Actual: 1000 tokens
- Code thinks: 1000 raw units / 10^6 = 0.001 tokens
- Price calculation: 0.001 / other_token = **very wrong**

Or vice versa:
- API returns raw units but field name suggests whole units
- We don't divide by decimals
- Result: 10^6-10^9 times too large

### Hypothesis 2: Mint Orientation from API

The API might return mints in a different order than we expect:
- API says: `tokenA=SOL, tokenB=Token`
- We calculate: `price = amountA / amountB = SOL/Token`
- But we label it as `Token/SOL` in our database
- Result: Price is inverted

### Hypothesis 3: Different API Versions

The code handles both V1 and V2 APIs:
```typescript
const poolVersion = Number(it?.pool_version ?? 2); // Default to v2
const dex = poolVersion === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2';
```

V1 and V2 might return data in different formats:
- V1: Raw amounts
- V2: Whole amounts
- Or vice versa

## Action Items

### 1. Add Diagnostic Logging to Meteora Normalizer

Add logging before price calculation to see:
- What are the actual reserve values?
- Are they raw or whole?
- What decimals are being used?
- What's the calculated price?

### 2. Check API Response Format

Log a sample raw API response from Meteora to see:
- Field names for reserves
- Whether they're raw or whole
- Actual values vs our calculations

### 3. Cross-Reference with Working DEXes

Orca and Raydium seem more accurate. Check:
- How do they calculate prices?
- Do they have the same decimal conversion logic?
- Are their APIs more consistent?

### 4. Fix Based on Findings

Once we know if it's:
- **Raw vs whole confusion**: Fix the decimal conversion
- **Mint orientation**: Swap the price calculation
- **API version differences**: Handle V1 and V2 differently

## Immediate Next Step

Add detailed logging to `meteoraBalanced.ts` right before price calculation (line 240) to capture:
```typescript
logger.info('meteora.balanced.price_calc', {
  pool_id: id.slice(0, 12),
  mint_a: mint_a.slice(0, 8),
  mint_b: mint_b.slice(0, 8),
  amtAraw,  // What we got from API
  amtBraw,
  decA,
  decB,
  wholeA,   // After dividing by decimals
  wholeB,
  price_a_per_b,  // Final calculated price
  source: it?.reserveA ? 'reserveA' : (it?.amountA ? 'amountA' : 'other'),
});
```

This will show us exactly what's happening in the price calculation for these problematic pools.

## Why Magnitude Calibration Didn't Fix This

Our magnitude calibration fix (MAX_APPLIED_DEV=3 for reverse edges) helps prevent **reverse edge** explosions, but doesn't fix **forward edge** prices that are already wrong coming from the normalizer.

We need to fix the root cause in the Meteora normalizer itself.

