import { TransactionInstruction, AccountMeta } from '@solana/web3.js';

/**
 * Optimizes account ordering in instructions:
 * 1. Writable accounts first
 * 2. Signers before non-signers within each group
 * 3. Deduplicates accounts (keeps first occurrence)
 */
export function optimizeAccountOrder(instruction: TransactionInstruction): TransactionInstruction {
  if (!instruction.keys || instruction.keys.length === 0) {
    return instruction;
  }

  // Deduplicate accounts while preserving order
  const seen = new Set<string>();
  const uniqueAccounts: AccountMeta[] = [];
  
  for (const account of instruction.keys) {
    const key = account.pubkey.toBase58();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueAccounts.push(account);
    }
  }

  // Sort: writable first, then signers before non-signers
  const sorted = uniqueAccounts.sort((a, b) => {
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

