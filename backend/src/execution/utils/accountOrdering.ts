import { TransactionInstruction, AccountMeta } from '@solana/web3.js';

/**
 * Optimizes account ordering in instructions:
 * 1. Writable accounts first
 * 2. Signers before non-signers within each group
 * 
 * NOTE: Does NOT deduplicate accounts - Solana instructions can reference
 * the same account multiple times with different flags (e.g., writable and non-writable).
 * Deduplication happens at the transaction level by compileToV0Message.
 */
export function optimizeAccountOrder(instruction: TransactionInstruction): TransactionInstruction {
  if (!instruction.keys || instruction.keys.length === 0) {
    return instruction;
  }

  // Sort: writable first, then signers before non-signers
  // IMPORTANT: Do NOT deduplicate - same account can appear with different flags
  const sorted = [...instruction.keys].sort((a, b) => {
    // Writable accounts first
    if (a.isWritable && !b.isWritable) return -1;
    if (!a.isWritable && b.isWritable) return 1;
    
    // Within writable/non-writable groups, signers first
    if (a.isSigner && !b.isSigner) return -1;
    if (!a.isSigner && b.isSigner) return 1;
    
    return 0;
  });

  return new TransactionInstruction({
    programId: instruction.programId,
    keys: sorted,
    data: instruction.data,
  });
}

/**
 * Optimize account ordering for multiple instructions
 */
export function optimizeInstructionsAccountOrder(instructions: TransactionInstruction[]): TransactionInstruction[] {
  return instructions.map(optimizeAccountOrder);
}

