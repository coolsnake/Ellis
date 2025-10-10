import { describe, it, expect } from 'vitest';
import { buildRaydiumAmmSwapIxReal, buildRaydiumClmmSwapIxReal, buildMeteoraDlmmSwapIxReal } from '../execution/builder/ix.js';

describe('execution builders error paths', () => {
  it('meteora dlmm real builder throws when sdk unavailable', async () => {
    await expect(buildMeteoraDlmmSwapIxReal({
      dex: 'meteora', variant: 'dlmm', poolId: 'pool', programId: 'prog',
      inputMint: 'A', outputMint: 'B', inputDecimals: 9, outputDecimals: 9,
      inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
      userSourceAta: '', userDestAta: '', amountInRaw: 0n, minOutRaw: 0n,
    } as any)).rejects.toBeTruthy();
  });
});


