import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { deriveAta, resolveTokenProgram } from '../execution/accounts.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';

describe('execution accounts helpers', () => {
  it('derives SPL and Token-2022 ATAs deterministically', () => {
    const owner = new PublicKey('11111111111111111111111111111111');
    const splMint = new PublicKey('So11111111111111111111111111111111111111112');
    const t22Mint = new PublicKey('Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN');
    const ata1 = deriveAta(owner, splMint, 'spl-token');
    const ata2 = deriveAta(owner, t22Mint, 'token-2022');
    expect(ata1).toBeInstanceOf(PublicKey);
    expect(ata2).toBeInstanceOf(PublicKey);
    expect(resolveTokenProgram('spl-token').equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(resolveTokenProgram('token-2022').equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});


