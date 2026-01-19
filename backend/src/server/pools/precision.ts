import type { ClmmPool } from './types.js';
import { logCatchError } from '../../utils/errorHandler.js';

const TWO_POW_64 = 2n ** 64n;
const TWO_POW_128 = TWO_POW_64 ** 2n;

const TEN = 10n;

function pow10BigInt(exp: number): bigint {
  let result = 1n;
  let base = TEN;
  let n = BigInt(exp);
  while (n > 0n) {
    if ((n & 1n) === 1n) {
      result *= base;
    }
    base *= base;
    n >>= 1n;
  }
  return result;
}

function pow10Fraction(exp: number): { numerator: bigint; denominator: bigint } {
  if (exp === 0) return { numerator: 1n, denominator: 1n };
  if (exp > 0) {
    return { numerator: pow10BigInt(exp), denominator: 1n };
  }
  const denom = pow10BigInt(-exp);
  return { numerator: 1n, denominator: denom };
}

export function anyToBigInt(value: any): bigint | null {
  try {
    if (value == null) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      if (!Number.isInteger(value)) return BigInt(Math.trunc(value));
      return BigInt(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^0x/i.test(trimmed)) {
        return BigInt(trimmed);
      }
      return BigInt(trimmed);
    }
    if (typeof value === 'object') {
      if (typeof (value as any).toBigInt === 'function') {
        const out = (value as any).toBigInt();
        if (typeof out === 'bigint') return out;
      }
      if (typeof (value as any).toString === 'function') {
        const s = (value as any).toString();
        if (typeof s === 'string' && s.length > 0) {
          return BigInt(s);
        }
      }
    }
  } catch (e) { logCatchError('pools.precision', e); }
  return null;
}

export type PriceRatio = {
  numerator: bigint;
  denominator: bigint;
  float?: number;
};

/**
 * Convert sqrtPriceX64 to price_a_per_b (how many B tokens for 1 A token)
 *
 * For Raydium/Orca CLMMs:
 * - sqrtPriceX64 = sqrt(tokenB_atomic / tokenA_atomic) * 2^64
 * - sqrtPrice^2 / 2^128 = tokenB_atomic / tokenA_atomic = price_a_per_b_atomic
 *
 * To convert to whole units:
 * - price_a_per_b_whole = price_a_per_b_atomic * 10^(decimalsA - decimalsB)
 * - price_a_per_b_whole = (sqrtPrice^2 / 2^128) * 10^(decA - decB)
 */
export function sqrtPriceX64ToPriceRatio(
  sqrtPrice: bigint,
  decimalsA?: number,
  decimalsB?: number,
): PriceRatio | null {
  if (!(sqrtPrice > 0n)) return null;
  if (!Number.isFinite(decimalsA) || !Number.isFinite(decimalsB)) return null;

  // Correct formula: price_a_per_b = (sqrtPrice^2 / 2^128) * 10^(decA - decB)
  const diff = Math.trunc((decimalsA as number) - (decimalsB as number));
  const { numerator: scaleNum, denominator: scaleDen } = pow10Fraction(diff);

  // priceNum / priceDen = (sqrtPrice^2 * scaleNum) / (2^128 * scaleDen)
  const sqrtSquared = sqrtPrice * sqrtPrice;
  const priceNum = sqrtSquared * scaleNum;
  const priceDen = TWO_POW_128 * scaleDen;

  if (!(priceDen > 0n)) return null;
  let float: number | undefined;
  try {
    float = Number(priceNum) / Number(priceDen);
    if (!Number.isFinite(float) || !(float > 0)) {
      float = undefined;
    }
  } catch {
    float = undefined;
  }
  return { numerator: priceNum, denominator: priceDen, float };
}

export function ratioToDecimalString(ratio: PriceRatio | null, precision = 18): string | undefined {
  if (!ratio) return undefined;
  try {
    const { numerator, denominator } = ratio;
    if (!(denominator > 0n)) return undefined;
    const scale = 10n ** BigInt(precision);
    const scaled = (numerator * scale) / denominator;
    const whole = scaled / scale;
    const frac = scaled % scale;
    const fracStr = frac.toString().padStart(precision, '0').replace(/0+$/, '');
    if (fracStr.length === 0) return whole.toString();
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return undefined;
  }
}

export function attachClmmPrecisionFields<T extends Partial<ClmmPool>>(
  pool: T,
  sqrtRaw: bigint | null,
  decimalsA?: number,
  decimalsB?: number,
): T {
  if (sqrtRaw && typeof pool === 'object') {
    (pool as any).sqrt_price_x64_raw = sqrtRaw.toString();
    if (Number.isFinite(Number(pool.sqrt_price_x64))) {
      (pool as any).sqrt_price_x64 = Number(pool.sqrt_price_x64);
    } else {
      // Keep approximate number for compatibility if not provided
      (pool as any).sqrt_price_x64 = Number(sqrtRaw);
    }
    const ratio = sqrtPriceX64ToPriceRatio(sqrtRaw, decimalsA, decimalsB);
    if (ratio) {
      (pool as any).price_a_per_b_num = ratio.numerator.toString();
      (pool as any).price_a_per_b_den = ratio.denominator.toString();
      if (ratio.float && Number.isFinite(ratio.float) && ratio.float > 0) {
        (pool as any).price_a_per_b = ratio.float;
      }
      const exact = ratioToDecimalString(ratio);
      if (exact) (pool as any).price_a_per_b_exact = exact;
    }
  }
  return pool;
}


