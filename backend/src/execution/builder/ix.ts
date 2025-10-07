import type { DirectHop } from '../types.js';

// Placeholders to satisfy wiring; concrete implementations will target specific programs
export function buildRaydiumAmmSwapIx(hop: DirectHop): any[] {
  // TODO: implement actual instruction encoding; placeholder returns structured descriptor
  return [{ programId: hop.programId, type: 'raydium.amm.swap', keys: { poolId: hop.poolId } }];
}
export function buildRaydiumClmmSwapIx(hop: DirectHop): any[] {
  return [{ programId: hop.programId, type: 'raydium.clmm.swap', keys: { poolId: hop.poolId } }];
}
export function buildOrcaSwapIx(hop: DirectHop): any[] {
  return [{ programId: hop.programId, type: 'orca.clmm.swap', keys: { poolId: hop.poolId } }];
}
export function buildMeteoraDlmmSwapIx(hop: DirectHop): any[] {
  return [{ programId: hop.programId, type: 'meteora.dlmm.swap', keys: { poolId: hop.poolId } }];
}


