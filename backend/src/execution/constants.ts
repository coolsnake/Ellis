export const METEORA_BIN_ARRAY_SIZE = 70;

/**
 * Maximum valid tick spacing for CLMM pools.
 * Orca Whirlpool: max 32768 (theoretical), observed up to 256.
 * Raydium CLMM: typically 1, 10, 60, 120.
 * Values above this threshold (e.g. 32896 = 0x8080) indicate parsing corruption.
 */
export const MAX_VALID_TICK_SPACING = 512;

/** Returns true if the tick spacing is a sane, usable value. */
export function isValidTickSpacing(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_VALID_TICK_SPACING;
}
