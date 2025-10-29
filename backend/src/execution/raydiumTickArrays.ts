import { PublicKey } from '@solana/web3.js';

// Raydium CLMM tick arrays cover 60 * spacing ticks per PDA
export function getTickArrayStartIndexByTick(tick: number, spacing: number): number {
  const size = 60 * Math.max(1, spacing);
  // Use floor division to align to the start index
  return Math.floor(tick / size) * size;
}

// Prefer a light, vendored PDA helper. For now, we call SDK only here (not in builders).
export async function deriveTickArrayPda(programId: PublicKey, poolId: PublicKey, startIndex: number): Promise<PublicKey> {
  const mod: any = await import('@raydium-io/raydium-sdk-v2');
  const getPda = (mod as any)?.getPdaTickArrayAddress || (mod as any)?.CLMM?.getPdaTickArrayAddress || (mod as any)?.Clmm?.getPdaTickArrayAddress;
  if (!getPda) throw new Error('RAYDIUM_TICK_PDA_FN_MISSING');
  const res = await getPda(programId, poolId, startIndex);
  const pk = (res && (res.publicKey || res)) as PublicKey;
  return pk;
}


