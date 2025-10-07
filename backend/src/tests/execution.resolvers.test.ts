import { describe, it, expect } from 'vitest';
import { resolveRaydiumAmm } from '../execution/resolver/raydiumAmm.js';
import { resolveOrca } from '../execution/resolver/orca.js';

describe('execution resolvers', () => {
  it('raydium amm returns hop with programId string (placeholder ok)', async () => {
    const hop = await resolveRaydiumAmm({
      dex: 'raydium', variant: 'amm', poolId: 'pool', programId: '',
      inputMint: 'A', outputMint: 'B', inputDecimals: 9, outputDecimals: 9,
      inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
      userSourceAta: '', userDestAta: '', amountInRaw: 0n, minOutRaw: 0n,
    } as any);
    expect(typeof hop.programId).toBe('string');
  });

  it('orca returns hop (placeholder ok)', async () => {
    const hop = await resolveOrca({
      dex: 'orca', variant: 'clmm', poolId: 'pool', programId: '',
      inputMint: 'A', outputMint: 'B', inputDecimals: 9, outputDecimals: 9,
      inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
      userSourceAta: '', userDestAta: '', amountInRaw: 0n, minOutRaw: 0n,
    } as any);
    expect(hop.variant).toBe('clmm');
  });
});


