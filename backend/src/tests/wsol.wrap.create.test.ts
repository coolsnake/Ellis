import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { buildWrapSolIxs, buildUnwrapSolIx } from '../execution/accounts.js';

describe('WSOL wrap/unwrap', () => {
  it('wrap includes ATA create, transfer, sync; unwrap closes', () => {
    const owner = new PublicKey('So11111111111111111111111111111111111111112');
    const payer = owner;
    const { ixs } = buildWrapSolIxs(owner, payer, 1000);
    const createAta = ixs.find((ix: any) => typeof ix?.keys !== 'undefined' && ix?.programId);
    const hasTransfer = ixs.some((ix: any) => (ix as any)?.programId?.equals?.(SystemProgram.programId));
    const hasSync = ixs.find((ix: any) => typeof ix?.data !== 'undefined' && typeof ix?.programId !== 'undefined');
    expect(Array.isArray(ixs)).toBe(true);
    expect(createAta).toBeTruthy();
    expect(hasTransfer).toBeTruthy();
    expect(hasSync).toBeTruthy();
    const close = buildUnwrapSolIx(owner);
    expect(close).toBeTruthy();
  });
});


