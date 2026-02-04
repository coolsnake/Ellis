export function computeOracleTwapDeviationPct(price: number, twap: number): number | null {
  const p = Number(price || 0);
  const t = Number(twap || 0);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t === 0) return null;
  return Math.abs(p - t) / Math.abs(t);
}

export function isOracleTwapOutlier(price: number, twap: number, guardPct: number): boolean {
  const dev = computeOracleTwapDeviationPct(price, twap);
  if (dev === null) return false;
  const g = Math.max(0, Number(guardPct || 0));
  return dev >= g;
}
