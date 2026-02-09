/**
 * Swap simulation for CLMM (tick-walk) and DLMM (bin-walk) pools.
 *
 * These functions simulate the actual on-chain swap math using tick/bin
 * liquidity distributions from rangeCache.  They produce accurate
 * input→output mappings that account for concentrated liquidity
 * boundaries, replacing the heuristic constant-product approximation.
 *
 * IMPORTANT unit conventions:
 *   - simulateClmmSwap: input/output in ATOMIC units (raw lamports)
 *   - simulateDlmmSwap: input/output in WHOLE tokens (human-readable)
 *
 * Used by graph.edges.ts to build high-confidence slippage curves,
 * and by execution/resolver/simulatedQuote.ts to provide accurate
 * quotes in the execution path.
 */

// ────────────────────── CLMM tick-walk ──────────────────────

export interface ClmmSwapParams {
  /** Input amount in ATOMIC units (raw lamports / smallest unit). NOT whole tokens. */
  inputAmount: number;
  /** Current sqrt price as a float: 1.0001^(tick/2) */
  currentSqrtPrice: number;
  /** Active liquidity (L) at the current tick range */
  currentLiquidity: number;
  /** All initialized ticks sorted ascending by index, with their liquidityNet */
  ticks: { index: number; liquidityNet: number }[];
  /** Current tick index */
  currentTick: number;
  /** Fee in basis points (e.g. 4 = 0.04%) */
  feeBps: number;
  /** true = selling token A for token B (price moves down) */
  aToB: boolean;
}

/**
 * Simulate a CLMM swap by walking through initialized ticks.
 *
 * Core math (Uniswap V3 / Orca Whirlpool / Raydium CLMM):
 *   Within a tick range [sqrtPa, sqrtPb] with liquidity L:
 *     A→B (price moves down):
 *       deltaA (input consumed)  = L * (1/sqrtPa_next - 1/sqrtPa_current)
 *       deltaB (output produced) = L * (sqrtPa_current - sqrtPa_next)
 *     B→A (price moves up):
 *       deltaB (input consumed)  = L * (sqrtPa_next - sqrtPa_current)
 *       deltaA (output produced) = L * (1/sqrtPa_current - 1/sqrtPa_next)
 *
 *   At each initialized tick boundary, L += liquidityNet * direction.
 *
 * @returns total output in ATOMIC units (same scale as input), or 0 if simulation fails.
 */
export function simulateClmmSwap(params: ClmmSwapParams): number {
  const { inputAmount, currentSqrtPrice, currentLiquidity, ticks, currentTick, feeBps, aToB } = params;

  if (inputAmount <= 0 || currentSqrtPrice <= 0 || currentLiquidity <= 0) return 0;
  if (ticks.length === 0) return 0;

  const feeRate = feeBps / 10000;
  // Apply fee to total input upfront (matches on-chain behavior for most CLMMs)
  let remainingInput = inputAmount * (1 - feeRate);
  let totalOutput = 0;
  let sqrtP = currentSqrtPrice;
  let L = currentLiquidity;

  if (aToB) {
    // Selling A for B — price moves DOWN — walk ticks in descending order
    // Find ticks below or at currentTick, sorted descending
    const ticksBelow = ticks.filter(t => t.index <= currentTick).reverse();

    for (let i = 0; i < ticksBelow.length && remainingInput > 1e-15; i++) {
      const tick = ticksBelow[i];
      const sqrtPTarget = tickToSqrtPriceF(tick.index);

      if (sqrtPTarget >= sqrtP) continue; // already past this tick
      if (L <= 0) break; // no liquidity

      // Max input consumable to reach this tick boundary
      // deltaA = L * (1/sqrtPTarget - 1/sqrtP)
      const maxInput = L * (1 / sqrtPTarget - 1 / sqrtP);
      if (maxInput <= 0) continue;

      if (remainingInput < maxInput) {
        // Partial fill within this range
        // Solve for new sqrtP: 1/sqrtP_new = 1/sqrtP + deltaA/L
        const invNew = 1 / sqrtP + remainingInput / L;
        const sqrtPNew = 1 / invNew;
        // deltaB = L * (sqrtP - sqrtPNew)
        const output = L * (sqrtP - sqrtPNew);
        totalOutput += Math.max(0, output);
        remainingInput = 0;
        sqrtP = sqrtPNew;
        break;
      } else {
        // Full range consumed — cross the tick
        const output = L * (sqrtP - sqrtPTarget);
        totalOutput += Math.max(0, output);
        remainingInput -= maxInput;
        sqrtP = sqrtPTarget;
        // Cross tick: update liquidity (subtract because going down)
        L -= tick.liquidityNet;
        if (L < 0) L = 0;
      }
    }

    // If there's remaining input after all ticks, do a partial fill with whatever L is left
    if (remainingInput > 1e-15 && L > 0 && sqrtP > 0) {
      const invNew = 1 / sqrtP + remainingInput / L;
      if (invNew > 0) {
        const sqrtPNew = 1 / invNew;
        const output = L * (sqrtP - sqrtPNew);
        totalOutput += Math.max(0, output);
      }
    }
  } else {
    // Selling B for A — price moves UP — walk ticks in ascending order
    const ticksAbove = ticks.filter(t => t.index > currentTick);

    for (let i = 0; i < ticksAbove.length && remainingInput > 1e-15; i++) {
      const tick = ticksAbove[i];
      const sqrtPTarget = tickToSqrtPriceF(tick.index);

      if (sqrtPTarget <= sqrtP) continue; // already past this tick
      if (L <= 0) break;

      // Max input consumable to reach this tick boundary
      // deltaB = L * (sqrtPTarget - sqrtP)
      const maxInput = L * (sqrtPTarget - sqrtP);
      if (maxInput <= 0) continue;

      if (remainingInput < maxInput) {
        // Partial fill
        const sqrtPNew = sqrtP + remainingInput / L;
        // deltaA = L * (1/sqrtP - 1/sqrtPNew)
        const output = L * (1 / sqrtP - 1 / sqrtPNew);
        totalOutput += Math.max(0, output);
        remainingInput = 0;
        sqrtP = sqrtPNew;
        break;
      } else {
        // Full range consumed
        const output = L * (1 / sqrtP - 1 / sqrtPTarget);
        totalOutput += Math.max(0, output);
        remainingInput -= maxInput;
        sqrtP = sqrtPTarget;
        // Cross tick: update liquidity (add because going up)
        L += tick.liquidityNet;
        if (L < 0) L = 0;
      }
    }

    // Remaining input after all ticks
    if (remainingInput > 1e-15 && L > 0 && sqrtP > 0) {
      const sqrtPNew = sqrtP + remainingInput / L;
      if (sqrtPNew > 0) {
        const output = L * (1 / sqrtP - 1 / sqrtPNew);
        totalOutput += Math.max(0, output);
      }
    }
  }

  return totalOutput;
}

// ────────────────────── DLMM bin-walk ──────────────────────

export interface DlmmSwapParams {
  /** Input amount in whole (human-readable) input tokens */
  inputAmount: number;
  /** Current active bin ID */
  activeBinId: number;
  /** All non-empty bins sorted ascending by ID */
  bins: { id: number; reserveX: number; reserveY: number }[];
  /** Bin step in basis points (e.g. 10 = 0.10%) */
  binStep: number;
  /** Fee in basis points */
  feeBps: number;
  /** true = selling token X for token Y (price moves to lower bins) */
  xToY: boolean;
}

/**
 * Simulate a DLMM swap by walking through bins.
 *
 * Each bin has a fixed price: price = (1 + binStep/10000)^(binId)
 * where binId is the signed bin index (0 = price 1.0).
 *
 * For X→Y (selling X):
 *   The bin's Y reserve is available as output. Input capacity at this bin:
 *     capacity_X = reserveY / price  (how much X we need to drain the bin's Y)
 *
 * For Y→X (selling Y):
 *   The bin's X reserve is available as output. Input capacity:
 *     capacity_Y = reserveX * price
 *
 * Fee model: Fees are applied per-bin (matching on-chain DLMM swapExactInQuoteAtBin).
 * At each bin, the gross input consumed includes the fee portion; the net amount
 * after fee is used to compute the output. This correctly handles per-bin variable
 * fees if the fee snapshot varies across bins.
 *
 * @returns total output in whole output tokens, or 0 if simulation fails.
 */
export function simulateDlmmSwap(params: DlmmSwapParams): number {
  const { inputAmount, activeBinId, bins, binStep, feeBps, xToY } = params;

  if (inputAmount <= 0 || bins.length === 0 || binStep <= 0) return 0;

  const feeRate = feeBps / 10000;
  // Per-bin fee: remainingInput is the full gross amount (fee deducted at each bin)
  let remainingInput = inputAmount;
  let totalOutput = 0;
  const stepMult = 1 + binStep / 10000;

  if (xToY) {
    // Selling X for Y — consuming Y reserves — walk bins downward from active
    const binsDesc = bins.filter(b => b.id <= activeBinId).reverse();

    for (const bin of binsDesc) {
      if (remainingInput <= 1e-15) break;
      if (bin.reserveY <= 0) continue;

      // Price at this bin: price_Y_per_X = stepMult^(binId - REF_OFFSET)
      const price = Math.pow(stepMult, bin.id);
      if (price <= 0 || !Number.isFinite(price)) continue;

      // Net capacity (how much net X drains this bin's Y)
      const netCapacityX = bin.reserveY / price;
      // Gross capacity includes the fee portion: gross = net / (1 - feeRate)
      const grossCapacityX = netCapacityX / (1 - feeRate);
      const grossConsumed = Math.min(remainingInput, grossCapacityX);
      // Fee extracted per-bin (matches on-chain DLMM model)
      const fee = grossConsumed * feeRate;
      const netConsumed = grossConsumed - fee;
      const output = netConsumed * price;

      totalOutput += output;
      remainingInput -= grossConsumed;
    }
  } else {
    // Selling Y for X — consuming X reserves — walk bins upward from active
    const binsAsc = bins.filter(b => b.id >= activeBinId);

    for (const bin of binsAsc) {
      if (remainingInput <= 1e-15) break;
      if (bin.reserveX <= 0) continue;

      const price = Math.pow(stepMult, bin.id);
      if (price <= 0 || !Number.isFinite(price)) continue;

      // Net capacity (how much net Y drains this bin's X)
      const netCapacityY = bin.reserveX * price;
      // Gross capacity includes the fee portion
      const grossCapacityY = netCapacityY / (1 - feeRate);
      const grossConsumed = Math.min(remainingInput, grossCapacityY);
      const fee = grossConsumed * feeRate;
      const netConsumed = grossConsumed - fee;
      const output = netConsumed / price;

      totalOutput += output;
      remainingInput -= grossConsumed;
    }
  }

  return totalOutput;
}

// ─────────────── Helpers ───────────────

/** Convert tick index to float sqrt price: 1.0001^(tick/2) */
function tickToSqrtPriceF(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}
