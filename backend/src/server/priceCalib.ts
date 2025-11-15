import { logger } from '../utils/logger.js';

// Calibrate magnitude only: keep orientation as A per 1 B.
// Use powers-of-ten scaling to align roughly with USD reference when available.
export function calibrateMagnitude(
  mintA: string,
  mintB: string,
  raw: number | undefined,
  getUsd: (mint: string) => number | undefined,
): number | undefined {
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  try {
    const pa = getUsd(mintA);
    const pb = getUsd(mintB);
    if (!(pa && pb) || !(pa > 0) || !(pb > 0)) return price;
    // For A per 1 B, the USD reference is price(B)/price(A)
    const ref = (pb as number) / (pa as number);
    const rawDev = Math.max(price / ref, ref / price);
    // Consider only powers-of-ten magnitude adjustments; DO NOT invert orientation here
    let best = price; let bestDev = rawDev;
    // Increased from 10 to 100 to handle more extreme decimal mismatches
    const MAX_APPLIED_DEV = 100;
    for (let k = -8; k <= 8; k++) {
      const cand = price * Math.pow(10, k);
      if (!(cand > 0) || !Number.isFinite(cand)) continue;
      const dev = Math.max(cand / ref, ref / cand);
      if (dev + 1e-12 < bestDev) { bestDev = dev; best = cand; }
    }
    if (!(bestDev + 1e-12 < rawDev)) return price;

    if (!Number.isFinite(bestDev) || bestDev > MAX_APPLIED_DEV) {
      try {
        logger.debug('calibrate.magnitude.skip', { mintA, mintB, raw: price, ref, rawDev, bestDev });
      } catch {}
      return price;
    }

    try {
      if (bestDev > 5) {
        logger.info('calibrate.magnitude.deviation', { mintA, mintB, raw: price, calibrated: best, ref, dev: bestDev, rawDev });
      }
    } catch {}

    return best;
  } catch {
    return price;
  }
}


