import { logger } from '../../utils/logger.js';

export type SwapDirection = 'AtoB' | 'BtoA';

export interface PoolInfo {
  mint_a: string;
  mint_b: string;
  account_a?: string;
  account_b?: string;
  decimals_a?: number;
  decimals_b?: number;
  [key: string]: any;
}

export interface HopInfo {
  inputMint: string;
  outputMint: string;
  userSourceAta: string;
  userDestAta: string;
  inputDecimals?: number;
  outputDecimals?: number;
  [key: string]: any;
}

export interface OrientedSwap {
  // Swap direction relative to pool's canonical orientation
  direction: SwapDirection;
  
  // Boolean flags for quick checks
  inputIsA: boolean;
  outputIsB: boolean;
  
  // Field mappings (pool fields → swap fields)
  poolVaultInput: string | undefined;
  poolVaultOutput: string | undefined;
  
  // User accounts
  userAccountInput: string;
  userAccountOutput: string;
  
  // Decimals
  decimalsInput: number;
  decimalsOutput: number;
  
  // Mints (for verification)
  mintInput: string;
  mintOutput: string;
}

/**
 * Determine swap orientation by comparing hop mints with pool's canonical mints
 */
export function determineSwapOrientation(
  pool: PoolInfo,
  hop: HopInfo
): OrientedSwap {
  // Determine direction based on which pool mint matches hop input
  const direction: SwapDirection = 
    hop.inputMint === pool.mint_a && hop.outputMint === pool.mint_b 
      ? 'AtoB' 
      : 'BtoA';
  
  const inputIsA = direction === 'AtoB';
  const outputIsB = direction === 'AtoB';
  
  // Map pool fields to swap context
  const poolVaultInput = inputIsA ? pool.account_a : pool.account_b;
  const poolVaultOutput = outputIsB ? pool.account_b : pool.account_a;
  
  // Decimals - FIX: fallback should always use hop.inputDecimals for input, hop.outputDecimals for output
  const decimalsInput = inputIsA 
    ? (pool.decimals_a ?? hop.inputDecimals ?? 6)
    : (pool.decimals_b ?? hop.inputDecimals ?? 6);  // FIX: was hop.outputDecimals
  const decimalsOutput = outputIsB
    ? (pool.decimals_b ?? hop.outputDecimals ?? 6)
    : (pool.decimals_a ?? hop.outputDecimals ?? 6);  // FIX: was hop.inputDecimals
  
  return {
    direction,
    inputIsA,
    outputIsB,
    poolVaultInput,
    poolVaultOutput,
    userAccountInput: hop.userSourceAta,
    userAccountOutput: hop.userDestAta,
    decimalsInput,
    decimalsOutput,
    mintInput: hop.inputMint,
    mintOutput: hop.outputMint,
  };
}

/**
 * Verify swap orientation consistency
 */
export function verifySwapOrientation(
  pool: PoolInfo,
  hop: HopInfo,
  oriented: OrientedSwap
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Verify mint matching
  if (oriented.inputIsA && hop.inputMint !== pool.mint_a) {
    errors.push(`Input mint mismatch: hop.inputMint=${hop.inputMint} but pool.mint_a=${pool.mint_a}`);
  }
  if (!oriented.inputIsA && hop.inputMint !== pool.mint_b) {
    errors.push(`Input mint mismatch: hop.inputMint=${hop.inputMint} but pool.mint_b=${pool.mint_b}`);
  }
  if (oriented.outputIsB && hop.outputMint !== pool.mint_b) {
    errors.push(`Output mint mismatch: hop.outputMint=${hop.outputMint} but pool.mint_b=${pool.mint_b}`);
  }
  if (!oriented.outputIsB && hop.outputMint !== pool.mint_a) {
    errors.push(`Output mint mismatch: hop.outputMint=${hop.outputMint} but pool.mint_a=${pool.mint_a}`);
  }
  
  // Verify direction consistency
  if (oriented.direction === 'AtoB' && (!oriented.inputIsA || !oriented.outputIsB)) {
    errors.push('Direction AtoB but flags inconsistent');
  }
  if (oriented.direction === 'BtoA' && (oriented.inputIsA || oriented.outputIsB)) {
    errors.push('Direction BtoA but flags inconsistent');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

