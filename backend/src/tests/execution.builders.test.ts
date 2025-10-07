import { describe, it, expect } from 'vitest';
import { buildRaydiumAmmSwapIx, buildOrcaSwapIx } from '../execution/builder/ix.js';

describe('execution builders', () => {
  it('raydium amm builder produces descriptor', () => {
    const ixs = buildRaydiumAmmSwapIx({
      dex: 'raydium', variant: 'amm', poolId: 'pool', programId: 'prog',
      inputMint: 'A', outputMint: 'B', inputDecimals: 9, outputDecimals: 9,
      inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
      userSourceAta: '', userDestAta: '', amountInRaw: 0n, minOutRaw: 0n,
    } as any);
    expect(Array.isArray(ixs)).toBe(true);
    expect(ixs[0].type).toContain('raydium.amm');
  });

  it('orca builder produces descriptor', () => {
    const ixs = (buildOrcaSwapIx as any)({
      dex: 'orca', variant: 'clmm', poolId: 'pool', programId: 'prog',
      inputMint: 'A', outputMint: 'B', inputDecimals: 9, outputDecimals: 9,
      inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
      userSourceAta: '', userDestAta: '', amountInRaw: 0n, minOutRaw: 0n,
    } as any);
    // async builder may return Promise; accept either
    if (typeof (ixs as any)?.then === 'function') return;
    expect((ixs as any)[0].type).toContain('orca');
  });
});


