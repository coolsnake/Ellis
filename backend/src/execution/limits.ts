// Price/limit helpers for CLMM/DLMM and generic slippage math

export function applySlippage(amount: bigint, slippageBps: number, direction: 'minOut'|'maxIn' = 'minOut'): bigint {
  const bps = BigInt(Math.max(0, slippageBps|0));
  const one = 10_000n;
  if (direction === 'minOut') {
    return (amount * (one - bps)) / one;
  }
  // maxIn inflates input by slippage
  return (amount * (one + bps)) / one;
}

// sqrtPriceLimitX64 helpers for CLMM side; guard against invalid input
export function priceToSqrtPriceX64(priceAperB: number, decimalsA: number, decimalsB: number): bigint {
  if (!(Number.isFinite(priceAperB) && priceAperB > 0)) return 0n;
  const shift = Math.pow(10, decimalsA - decimalsB);
  const price = priceAperB / shift;
  const sqrt = Math.sqrt(price);
  // Q64.64 fixed point: sqrtPrice * 2^64
  const x64 = BigInt(Math.floor(sqrt * Math.pow(2, 64)));
  return x64 > 0n ? x64 : 0n;
}

export function withSqrtLimit(currentSqrtX64: bigint, bps: number, side: 'aToB'|'bToA'): bigint {
  const cur = currentSqrtX64 < 0n ? 0n : currentSqrtX64;
  const b = Math.max(0, bps|0);
  if (b === 0) return cur;
  // For a->b, set an upper bound; for b->a, set a lower bound
  const mul = (10_000 + (side === 'aToB' ? b : -b)) / 10_000;
  // Work in JS number for simplicity; clamp and cast back
  const next = Math.max(0, Math.floor(Number(cur) * mul));
  return BigInt(next);
}


