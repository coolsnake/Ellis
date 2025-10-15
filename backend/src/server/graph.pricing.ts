import { CONFIG } from '../utils/config.js';

type GetUsd = (mint: string) => number | undefined;
type GetEdgeRate = (a: string, b: string) => number | undefined;

function clamp(px?: number): number | undefined {
  const min = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMin)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMin) : 1e-12;
  const max = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMax)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMax) : 1e12;
  const v = Number(px);
  if (!Number.isFinite(v) || !(v > 0)) return undefined;
  if (v < min || v > max) return undefined;
  return v;
}

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

export function computePriceForward(
  mintA: string,
  mintB: string,
  rawPrice: number | undefined,
  poolDecA?: number,
  poolDecB?: number,
  globalDecA?: number,
  globalDecB?: number,
  getUsd?: GetUsd,
  getEdgeRate?: GetEdgeRate,
): number | undefined {
  const raw = Number(rawPrice);
  let oriented: number | undefined = (Number.isFinite(raw) && raw > 0) ? raw : undefined;

  // Direct USD reference orientation
  let directRef: number | undefined;
  if (typeof getUsd === 'function') {
    try {
      const pa = getUsd(mintA);
      const pb = getUsd(mintB);
      if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
        directRef = (pb as number) / (pa as number);
      }
    } catch {}
  }

  // Triangulation via edges (optional)
  let medianTri: number | undefined;
  if (typeof getEdgeRate === 'function') {
    try {
      const pivots: string[] = Array.from(new Set<string>([
        ...((((CONFIG as any)?.system as any)?.anchorMints || []) as string[]),
        ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
      ]));
      const getAPerB = (A: string, B: string): number | undefined => {
        const d = getEdgeRate(A, B); if (typeof d === 'number' && d > 0) return d;
        const r = getEdgeRate(B, A); if (typeof r === 'number' && r > 0) return 1 / r;
        return undefined;
      };
      const refs: number[] = [];
      for (const C of pivots) {
        if (C === mintA || C === mintB) continue;
        const aPerC = getAPerB(mintA, C);
        const bPerC = getAPerB(mintB, C);
        if (aPerC && bPerC && aPerC > 0 && bPerC > 0) refs.push(aPerC / bPerC);
      }
      const sorted = refs.filter(v => Number.isFinite(v) && v > 0).sort((a,b) => a-b);
      if (sorted.length) medianTri = sorted[Math.floor(sorted.length/2)];
    } catch {}
  }

  // Choose orientation: prefer raw or inverted closer to ref (direct first, then triangulation median)
  const tryRef = (ref?: number) => {
    if (!(ref && ref > 0) || !(oriented && oriented > 0)) return;
    const inv = 1 / oriented!;
    const dev  = Math.max((oriented as number) / ref,  ref / (oriented as number));
    const devI = Math.max(inv / ref, ref / inv);
    if (devI + 1e-12 < dev) oriented = inv;
  };
  tryRef(directRef);
  if (!directRef) tryRef(medianTri);

  // Rescale by decimals when available
  oriented = rescaleByDecimals(oriented, poolDecA, poolDecB, globalDecA, globalDecB);
  // Clamp
  return clamp(oriented);
}


