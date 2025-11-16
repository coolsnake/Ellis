# Magnitude Calibration Bug Analysis

## Problem Statement

Seeing invalid arbitrage rates like:
```
USDC->JitoSOL: 5889572203.145 JitoSOL per 1 USDC
```

Should be approximately: `0.0058 JitoSOL per 1 USDC` (given JitoSOL ~$170, USDC $1)

## Root Cause

The magnitude calibration algorithm in `computePriceForward()` is being applied incorrectly to reverse edges, causing power-of-10 magnitude errors.

## Data Flow Analysis

### 1. Pool Fetching & Decimal Resolution

**Location**: `backend/src/server/pools/*.ts`

- Each DEX normalizer (Raydium, Orca, Meteora, etc.) fetches pool data
- Decimals are resolved using centralized `resolveManyDecimals()`:
  - Priority: Anchor decimals (SOL=9, USDC=6) → Cache → RPC → Jupiter
  - JitoSOL: 9 decimals (verified in `backend/config/tokens.json`)
  - USDC: 6 decimals (anchor)

**Status**: ✅ Decimals are resolved correctly

### 2. Pool Canonicalization

**Location**: `backend/src/server/pools/canonical.ts`

- Pools are canonicalized to ensure consistent mint ordering
- Orientation determined by quote priority list (USDC, SOL, etc.)
- When mints are swapped, `price_a_per_b` is inverted

```typescript:46:70:backend/src/server/pools/canonical.ts
export function canonicalOrientation(mintA: string, mintB: string): 'keep' | 'swap' {
  const quotePriority = getQuotePriorityMap();
  
  const rankA = quotePriority.get(mintA) ?? Number.POSITIVE_INFINITY;
  const rankB = quotePriority.get(mintB) ?? Number.POSITIVE_INFINITY;
  
  // Both in priority list → lower rank (higher priority) goes to B side
  // When rankA < rankB, A has higher priority, so swap to move A to B
  if (Number.isFinite(rankA) && Number.isFinite(rankB)) {
    return rankA < rankB ? 'swap' : 'keep';
  }
  
  // Only A in list → A should be quote (on B side)
  if (Number.isFinite(rankA)) {
    return 'swap';
  }
  
  // Only B in list → B should be quote (keep as is)
  if (Number.isFinite(rankB)) {
    return 'keep';
  }
  
  // Neither in list → lexicographic ordering for determinism
  return mintA <= mintB ? 'keep' : 'swap';
}
```

For USDC/JitoSOL:
- USDC has quote priority (rank 1)
- JitoSOL has no priority
- Result: JitoSOL→USDC (JitoSOL as mint_a, USDC as mint_b)
- `price_a_per_b` = JitoSOL-per-1-USDC ≈ 0.0058

**Status**: ✅ Canonicalization works correctly

### 3. Graph Edge Building

**Location**: `backend/src/server/graph.edges.ts`

Forward edge (JitoSOL→USDC):
```typescript:87:104:backend/src/server/graph.edges.ts
const forward: GraphEdge = {
  id: id || `${a}->${b}-${dex}`,
  source: a,
  target: b,
  dex,
  pool_id: id || undefined,
  source_account: (p as any)?.account_a,
  target_account: (p as any)?.account_b,
  fee_bps: fee,
  liquidity: liq,
  liquidity_display: liq,
  weight: w,
  price_a_per_b: fwd,
  tvl_usd: (p as any)?.tvl_usd,
  pool_kind: kind as any,
  direction: 'forward',
  pool_liquidity_raw: (p as any)?.pool_liquidity_raw,
};
```

Reverse edge (USDC→JitoSOL) calculation:
```typescript:74:84:backend/src/server/graph.edges.ts
// Calculate reverse edge with proper decimal rescaling
const rev = computePriceReverse(
  a,
  b,
  fwd,
  fRaw,
  (p as any)?.decimals_a,
  (p as any)?.decimals_b,
  undefined,
  undefined,
  getUsd,
);
```

**Status**: ⚠️ Correctly calls `computePriceReverse`, but the issue is in that function

### 4. Reverse Edge Price Calculation

**Location**: `backend/src/server/graph.pricing.ts:121-150`

```typescript:121:150:backend/src/server/graph.pricing.ts
export function computePriceReverse(
  mintA: string,
  mintB: string,
  forwardPrice: number | undefined,
  rawPrice: number | undefined,
  poolDecA?: number,
  poolDecB?: number,
  globalDecA?: number,
  globalDecB?: number,
  getUsd?: GetUsd,
): number | undefined {
  // If we don't have raw price, fall back to simple inversion (less accurate but better than nothing)
  if (!rawPrice || rawPrice <= 0) {
    return forwardPrice && forwardPrice > 0 ? clamp(1 / forwardPrice) : undefined;
  }
  
  // Calculate reverse with swapped mints and decimals
  const revRaw = 1 / rawPrice;
  return computePriceForward(
    mintB, // Swapped: B is now source
    mintA, // Swapped: A is now target
    revRaw,
    poolDecB, // Swapped decimals
    poolDecA, // Swapped decimals
    globalDecB, // Swapped global decimals
    globalDecA, // Swapped global decimals
    getUsd,
    undefined,
  );
}
```

**Example**:
- `rawPrice` = 0.0058 (JitoSOL per USDC)
- `revRaw` = 1 / 0.0058 = 172.41 (USDC per JitoSOL)
- Calls `computePriceForward(USDC, JitoSOL, 172.41, 6, 9, undefined, undefined, getUsd)`

**Status**: ✅ Correctly inverts and swaps parameters

### 5. Magnitude Calibration (THE BUG)

**Location**: `backend/src/server/graph.pricing.ts:48-99`

```typescript:62:93:backend/src/server/graph.pricing.ts
// Magnitude calibration: fix power-of-10 errors using USD reference
// This does NOT flip orientation - it only adjusts magnitude
if (typeof getUsd === 'function' && price && price > 0) {
  try {
    const pa = getUsd(mintA);
    const pb = getUsd(mintB);
    if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
      const ref = (pb as number) / (pa as number);
      const rawDev = Math.max(price / ref, ref / price);
      
      // Try power-of-10 adjustments (magnitude only, no orientation flip)
      let best = price;
      let bestDev = rawDev;
      const MAX_APPLIED_DEV = 100;
      
      for (let k = -8; k <= 8; k++) {
        const cand = price * Math.pow(10, k);
        if (!(cand > 0) || !Number.isFinite(cand)) continue;
        const dev = Math.max(cand / ref, ref / cand);
        if (dev + 1e-12 < bestDev) {
          bestDev = dev;
          best = cand;
        }
      }
      
      // Only apply if significantly better and within reasonable bounds
      if (bestDev + 1e-12 < rawDev && bestDev <= MAX_APPLIED_DEV) {
        price = best;
      }
    }
  } catch {}
}
```

**The Bug Scenario**:

For USDC→JitoSOL reverse edge:
- `mintA` = USDC, `mintB` = JitoSOL
- `price` = 172.41 (USDC per JitoSOL) - **This is already inverted correctly!**
- `pa` = getUsd(USDC) = 1.0
- `pb` = getUsd(JitoSOL) = 170.0
- `ref` = pb / pa = 170.0 / 1.0 = 170.0
- `rawDev` = max(172.41 / 170.0, 170.0 / 172.41) = max(1.014, 0.986) = 1.014

**BUT WAIT**: The price represents "source per target" which for reverse edge USDC→JitoSOL should be:
- **JitoSOL per USDC**, not USDC per JitoSOL!

The bug is that after inversion in `computePriceReverse`, the semantic meaning changes:
- Forward edge JitoSOL→USDC: `price_a_per_b` = 0.0058 USDC per JitoSOL ✅
- Reverse edge USDC→JitoSOL: Should be ~172 JitoSOL per USDC... 

Wait, that's backwards too. Let me recalculate:

If 1 JitoSOL = $170 and 1 USDC = $1, then:
- 1 JitoSOL = 170 USDC → JitoSOL per USDC = 1/170 = 0.0058
- 1 USDC = 1/170 JitoSOL → USDC per JitoSOL = 170

So:
- Forward JitoSOL→USDC: rate = 170 USDC per 1 JitoSOL ✅
- Reverse USDC→JitoSOL: rate = 0.0058 JitoSOL per 1 USDC ✅

But the log shows:
```
USDC->JitoSOL: 5889572203.145 JitoSOL per 1 USDC
```

That's 10^10 times too large! (5889572203 / 0.0058 ≈ 10^12)

## The Real Bug

Looking at arb-rs code:

```rust:3491:3509:arb-rs/src/main.rs
// Centralized price conversion: A-per-1-B (backend) -> B-per-1-A (detector), apply fee once
// 
// IMPORTANT: price_a_per_b always represents "source-per-1-target" regardless of direction
// - Forward edge A->B: price_a_per_b = A-per-1-B, rate_effective = B-per-1-A (invert)
// - Reverse edge B->A: price_a_per_b = B-per-1-A, rate_effective = A-per-1-B (invert)
//
// So we ALWAYS invert price_a_per_b to get rate_effective, regardless of direction
#[inline]
fn edge_rate_effective_local(px_opt: Option<f64>, fee_bps_opt: Option<i64>, _direction: Option<&str>) -> (f64, f64) {
    let fee_bps: f64 = (fee_bps_opt.unwrap_or(0)) as f64;
    let px: f64 = px_opt.unwrap_or(0.0);
    if !(px.is_finite() && px > 0.0) {
        return (0.0, 0.0);
    }
    // price_a_per_b is always "source-per-1-target", so we always invert to get rate_effective
    // rate_effective = "target-per-1-source" (what we get when traversing the edge)
    let base: f64 = 1.0 / px;
    if !(base.is_finite() && base > 0.0) {
        return (0.0, 0.0);
```

**AH HA!** arb-rs **inverts** the `price_a_per_b` to get `rate_effective`. 

So if backend sends:
- Reverse edge USDC→JitoSOL with `price_a_per_b` = 5889572203.145

Then arb-rs calculates:
- `rate_effective` = 1 / 5889572203.145 = 0.00000000017 (essentially 0)

And the log shows the ORIGINAL `price_a_per_b` value (not the inverted rate_effective).

## Finding The Actual Bug

Let me trace backwards from the bad value. The reverse edge has:
- source: USDC
- target: JitoSOL  
- price_a_per_b: 5889572203.145

According to the naming convention, `price_a_per_b` should mean "source per target" = "USDC per JitoSOL".

But USDC per JitoSOL should be ~170, not 5 billion!

The issue is that magnitude calibration is being applied AFTER the semantics have been changed by reversing.

## Solution

The magnitude calibration should NOT be applied to reverse edges, OR it needs to understand the correct USD reference orientation.

For a reverse edge where:
- Forward: JitoSOL→USDC, price = 170 USDC per JitoSOL
- Reverse: USDC→JitoSOL, inverted = 1/170 = 0.0058 JitoSOL per USDC

When magnitude calibration runs on the reverse:
- mintA = USDC ($1)
- mintB = JitoSOL ($170)
- price = 0.0058
- ref = $170 / $1 = 170
- rawDev = max(0.0058 / 170, 170 / 0.0058) = max(0.000034, 29310) = 29310

The calibration then tries multiplying by powers of 10:
- k=10: price * 10^10 = 0.0058 * 10^10 = 58,000,000
- ref = 170
- dev = max(58000000 / 170, 170 / 58000000) = 341,176

Wait, that would make it WORSE. Let me check if the USD reference is inverted...

Actually, I think the bug is that the USD reference should also be inverted for reverse edges!

For reverse edge USDC→JitoSOL:
- We want: JitoSOL per USDC
- USD reference should be: $JitoSOL / $USDC = $170 / $1 = 170

But magnitude calibration calculates:
- pa = getUsd(USDC) = $1
- pb = getUsd(JitoSOL) = $170
- ref = pb / pa = $170 / $1 = 170

So ref is correct... but the price being tested (0.0058) is inverted relative to ref (170).

The price 0.0058 means "JitoSOL per USDC", but ref 170 means "USDC per JitoSOL".

**THAT'S THE BUG**: The magnitude calibration reference is calculated in the wrong direction for reverse edges!

## The Fix

In `computePriceReverse`, when calling `computePriceForward` with swapped mints, the USD price reference will be automatically correct because the mints are swapped. But there's a subtle issue:

The price coming in is already inverted (`revRaw = 1 / rawPrice`), which is correct.
But the magnitude calibration then compares it against the wrong reference.

For USDC→JitoSOL reverse:
- revRaw = 1 / 0.0058 = 172.41 USDC per JitoSOL
- This is passed to computePriceForward(USDC, JitoSOL, 172.41)
- ref = getUsd(JitoSOL) / getUsd(USDC) = 170 / 1 = 170
- That's almost correct! (172 vs 170)

So why does it become 5 billion?

Let me re-read the code...

OH! I see it now. The issue is that the **semantics of `price_a_per_b` are inconsistent**.

Looking at the edge creation:
```typescript
price_a_per_b: rev,  // For reverse edge
```

The `rev` value should represent what? Let's check the arb-rs interpretation:

```rust
// price_a_per_b always represents "source-per-1-target" regardless of direction
```

So for reverse edge with source=USDC, target=JitoSOL:
- `price_a_per_b` should be USDC per JitoSOL = 170

But `computePriceReverse` calculates:
- revRaw = 1 / rawPrice = 1 / 0.0058 = 172.41
- Passes to computePriceForward(USDC, JitoSOL, 172.41)

That looks right! So where does 5 billion come from?

Let me check if there's a decimal rescaling issue...

```typescript:15:24:backend/src/server/graph.pricing.ts
function rescaleByDecimals(px: number | undefined, poolDecA?: number, poolDecB?: number, globalDecA?: number, globalDecB?: number): number | undefined {
  const p = Number(px);
  if (!Number.isFinite(p) || !(p > 0)) return px;
  const da = Number(poolDecA); const db = Number(poolDecB);
  const ga = Number(globalDecA); const gb = Number(globalDecB);
  if (![da, db, ga, gb].every((x) => Number.isFinite(x))) return px;
  const scalePow = (ga - da) - (gb - db);
  const scaled = p * Math.pow(10, scalePow);
  return (Number.isFinite(scaled) && scaled > 0) ? scaled : px;
}
```

If globalDecA and globalDecB are undefined (which they are in the call), then rescaling returns the original price.

So the 5 billion must come from magnitude calibration.

Let me calculate:
- 172.41 * 10^7 = 1,724,100,000 (1.7 billion)
- 172.41 * 10^8 = 17,241,000,000 (17 billion)

Hmm, doesn't match 5889572203.

Let me check if the original pool price is wrong...

Actually, wait. Let me re-read the arb log format:

```
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v->J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 5889572203.145083427 J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn per 1 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

The format is:
```
"{}->{}: {:.9} {} per 1 {}",
a, b, r, b, a
```

So it's printing: `r` which is the rate in the detector's graph, which equals:
- JitoSOL per 1 USDC

And that value is 5889572203, which is about 10^10 times what it should be (0.0058).

So somewhere, a 10^10 multiplier is being applied.

10^10 = 10^(something related to decimals)
- JitoSOL decimals: 9
- USDC decimals: 6
- Difference: 3

Nope, doesn't match.

Unless... the decimals are being applied incorrectly TWICE, or in the wrong direction.

Let me check if the pool's `price_a_per_b` is already wrong before graph building...

Actually, I should add diagnostic logging to trace this through.

## Recommendation

Add detailed logging at each step to trace the price transformation:
1. Pool normalization: Log the `price_a_per_b` after canonicalization
2. Edge building: Log both forward and reverse `price_a_per_b` values
3. Magnitude calibration: Log when a price is adjusted and by what factor
4. Decimal rescaling: Log when decimals are applied

Then reproduce the issue and trace where the 10^10 multiplier gets introduced.

## Immediate Workaround

Disable magnitude calibration for reverse edges, or at least add stricter bounds:
- Current MAX_APPLIED_DEV = 100 (allows 100x deviation)
- Reduce to MAX_APPLIED_DEV = 2 (only allow 2x deviation) for reverse edges

Or better: Skip magnitude calibration entirely for reverse edges since they're derived from forward edges that have already been calibrated.


