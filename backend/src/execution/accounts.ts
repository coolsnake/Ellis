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

export function buildUnwrapSolIx(owner: PublicKey): any {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  return createCloseAccountInstruction(ata, owner, owner);
}


