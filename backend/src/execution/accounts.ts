import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';

export type TokenProgramKind = 'spl-token' | 'token-2022';

export function resolveTokenProgram(kind: TokenProgramKind): PublicKey {
  return kind === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export function deriveAta(owner: PublicKey, mint: PublicKey, programKind: TokenProgramKind): PublicKey {
  const program = resolveTokenProgram(programKind);
  return getAssociatedTokenAddressSync(mint, owner, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function buildCreateAtaIx(owner: PublicKey, payer: PublicKey, mint: PublicKey, programKind: TokenProgramKind) {
  const program = resolveTokenProgram(programKind);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);
  return createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, program, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function isSolMint(mint: string): boolean {
  try { return new PublicKey(mint).equals(NATIVE_MINT); } catch { return false; }
}

export function buildWrapSolIxs(owner: PublicKey, payer: PublicKey, lamports: number): { ixs: any[]; wsolAta: PublicKey } {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  const ixs = [
    // Ensure WSOL ATA exists
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, NATIVE_MINT),
    // Fund WSOL account
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports }),
    // Sync native balance into token amount
    createSyncNativeInstruction(ata),
  ];
  return { ixs, wsolAta: ata };
}

/**
 * Build minimal instructions to top-up an existing WSOL ATA.
 * Use this when the WSOL ATA already exists but needs more balance.
 * Saves 1 instruction compared to buildWrapSolIxs (no ATA create).
 * 
 * @param owner Owner of the WSOL ATA
 * @param payer Payer for the transfer
 * @param lamports Amount to transfer and sync
 * @returns Instructions and WSOL ATA address
 */
export function buildTopUpWsolIxs(owner: PublicKey, payer: PublicKey, lamports: number): { ixs: any[]; wsolAta: PublicKey } {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  const ixs = [
    // Fund WSOL account (ATA already exists)
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports }),
    // Sync native balance into token amount
    createSyncNativeInstruction(ata),
  ];
  return { ixs, wsolAta: ata };
}

/**
 * Get the WSOL ATA address for an owner
 */
export function getWsolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
}

export function buildScheduleCloseAtaIx(
  owner: PublicKey,
  mint: PublicKey,
  programKind: TokenProgramKind
): { instruction: null; scheduleClose: { address: PublicKey; mint: PublicKey } } {
  const program = resolveTokenProgram(programKind);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);
  // Return metadata instead of actual close instruction
  return {
    instruction: null,
    scheduleClose: { address: ata, mint },
  };
}

export function buildUnwrapSolIx(
  owner: PublicKey,
  scheduleClose: boolean = true
): any {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  
  if (scheduleClose) {
    // Return metadata for delayed closing instead of immediate close
    return {
      programId: 'spl-token',
      type: 'schedule_close_ata',
      address: ata.toBase58(),
      mint: NATIVE_MINT.toBase58(),
    };
  }
  
  // Immediate close (legacy behavior)
  return createCloseAccountInstruction(ata, owner, owner);
}


