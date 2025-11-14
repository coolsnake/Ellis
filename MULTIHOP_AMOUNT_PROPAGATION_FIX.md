# Multi-Hop Amount Propagation Fix

## Issue
The second hop in multi-hop swaps was not using the exact output from the first hop. Instead, it was using an incorrect amount (often the original input amount or a stale value from the plan).

**Example Problem:**
- First hop: Swap 0.01 WSOL → 1.42412 USDC on Meteora DLMM
- Second hop: **Should swap 1.42412 USDC** → WSOL
- **Bug**: Second hop was swapping 10 USDC instead

This issue occurred on both Raydium CLMM and Meteora CLMM pools.

## Root Cause
In `backend/src/server/routes/arb.ts`, the `/arb/execute` endpoint had this logic:

```typescript
const plan = input?.plan && Array.isArray(input.plan?.hops) ? input.plan : await resolveDirectPlan(parsed as any, {} as any);
```

This meant:
- If a plan with hops was provided in the request body, it was used **directly**
- The amount propagation logic in `resolveDirectPlan` was **bypassed**
- Each hop retained whatever `amountInRaw` value was in the original request
- The second hop never received the exact output from the first hop

## Solution
Changed the `/arb/execute` endpoint to work like the `/arb/simulate` endpoint:

1. **Always call `resolveDirectPlan`** - even when a plan is provided
2. Build a `resolveInput` from the provided plan's path, poolIds, and dexes
3. Let `resolveDirectPlan` quote each hop and properly propagate amounts
4. Then apply any overrides from the original plan (except `amountInRaw`)

### The Fix
```typescript
// Build a resolve input from provided plan (if any), otherwise use parsed arrays
const basePlan = (input && (input as any).plan && Array.isArray((input as any).plan?.hops)) ? (input as any).plan : undefined;
const resolveInput = basePlan
  ? {
      path: basePlan.path,
      hopPoolIds: basePlan.hops.map((h: any) => String(h.poolId)),
      dexes: basePlan.hops.map((h: any) => String(h.dex)),
      size: (input as any).size,
      sizeUsd: (input as any).sizeUsd,
      slippageBps: (input as any).slippageBps,
    }
  : (parsed as any);
// Always resolve using the quote's path/pools/dexes -> fills mints, decimals, and amounts
const plan = await resolveDirectPlan(resolveInput as any, {} as any);
// Apply optional per-hop overrides from the provided quote/plan
if (basePlan) {
  for (let i = 0; i < plan.hops.length && i < basePlan.hops.length; i += 1) {
    const src = basePlan.hops[i] as any;
    if (src.inputMint)  plan.hops[i].inputMint  = String(src.inputMint);
    if (src.outputMint) plan.hops[i].outputMint = String(src.outputMint);
    // NOTE: Do NOT override amountInRaw here - it breaks amount propagation between hops.
    // The resolver already correctly sets amountInRaw based on previous hop's output.
    if (src.minOutRaw !== undefined && src.minOutRaw !== null) {
      try { plan.hops[i].minOutRaw = BigInt(String(src.minOutRaw)); } catch {}
    }
  }
}
```

## How Amount Propagation Works

The `resolveDirectPlan` function in `backend/src/execution/resolver/index.ts` ensures correct amount propagation:

```typescript
// For each hop after the first (i > 0):
if (i > 0) {
  const prevHop = hops[i - 1];
  if (prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
    // Use the exact quotedOutputRaw from previous hop
    curIn = prevHop.quotedOutputRaw;
  }
}
hops[i].amountInRaw = curIn;
```

This ensures that:
1. **First hop**: Uses the user-specified input amount
2. **Second hop**: Uses `hop1.quotedOutputRaw` as its `amountInRaw`
3. **Third hop**: Uses `hop2.quotedOutputRaw` as its `amountInRaw`
4. And so on...

The `quotedOutputRaw` is set after quoting each hop:

```typescript
const out = await quoteHopOut(hops[i], hops[i].amountInRaw);
if (out > 0n) {
  hops[i].quotedOutputRaw = out; // Store exact quoted output
  curIn = out; // Use for next hop
}
```

## Additional Safeguards

The transaction builder in `backend/src/execution/builder/tx.ts` has additional verification and correction logic:

```typescript
// For multi-hop swaps (i > 0), ensure exact amount propagation
if (i > 0 && prevHop?.quotedOutputRaw && prevHop.quotedOutputRaw > 0n) {
  const exactAmount = prevHop.quotedOutputRaw;
  if (hop.amountInRaw !== exactAmount) {
    // Log the discrepancy and fix it
    hop.amountInRaw = exactAmount;
  }
  hop.useExactAmount = true; // Flag to prevent re-quote adjustments
}
```

This acts as a final safety net to catch and correct any amount mismatches before building instructions.

## Files Modified
- `backend/src/server/routes/arb.ts` - Fixed execute endpoint to always resolve plans

## Testing
After this fix, multi-hop swaps should:
1. Quote the first hop with the user-specified amount
2. Use the exact output from hop 1 as the input for hop 2
3. Use the exact output from hop 2 as the input for hop 3 (if applicable)
4. And so on for any number of hops

The transaction simulation should show the correct amounts propagating through each hop without any discrepancies.

## Related Files
- `backend/src/execution/resolver/index.ts` - Contains the amount propagation logic
- `backend/src/execution/builder/tx.ts` - Contains additional verification and correction
- `backend/src/execution/types.ts` - Defines `quotedOutputRaw` and `useExactAmount` fields

