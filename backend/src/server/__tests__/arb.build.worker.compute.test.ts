import { describe, expect, it } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

const { vi, afterEach } = globalThis as unknown as { vi?: any; afterEach?: (fn: () => void) => void };

if (!vi || !afterEach) {
  throw new Error('Vitest globals not available');
}

const buildDirectArbTx = vi.fn(async (_plan: any, extras: TransactionInstruction[]) => ({
  tx: {
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey('7R4yHPxhxL3S5Gucs5cjox96D65gis6pZeRAgvKz8Aj3'),
        keys: [
          { pubkey: new PublicKey('4Nd1mMdG1wf1V9zj2YkdEYY5EYXPLkZX31kT7xGTFeoR'), isSigner: true, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3]),
      }),
    ],
  },
  ixCount: 1 + extras.length,
  sizeBytes: 512,
}));

vi.mock('../../execution/builder/tx.js', () => ({
  buildDirectArbTx,
}));

import { buildTransactionSummary } from '../arb.build.worker.compute.js';

afterEach(() => {
  buildDirectArbTx.mockClear();
});

describe('buildTransactionSummary', () => {
  it('coerces extra instructions and serializes result output', async () => {
    const plan = { id: 'plan-123', hops: [] };
    const extraProgram = new PublicKey('11111111111111111111111111111111');
    const extra = {
      programId: extraProgram.toBase58(),
      keys: [
        { pubkey: new PublicKey('Fp6jXabRdfzTh6iYZ7R6puj949iFDUFxuDrGRq3NbSba').toBase58(), isSigner: false, isWritable: true },
      ],
      data: Buffer.from([9, 9, 9]).toString('base64'),
    };
    const computeBudget = { computeUnitLimit: 500_000, computeUnitPriceMicroLamports: 1_000 };

    const result = await buildTransactionSummary(plan as any, [extra], computeBudget);

    expect(buildDirectArbTx).toHaveBeenCalledTimes(1);
    const call = buildDirectArbTx.mock.calls[0];
    expect(call[0]).toBe(plan);
    expect(call[2]).toEqual(computeBudget);

    const forwardedExtras: TransactionInstruction[] = call[1];
    expect(forwardedExtras).toHaveLength(1);
    expect(forwardedExtras[0].programId.toBase58()).toBe(extraProgram.toBase58());
    expect(forwardedExtras[0].keys[0].pubkey.toBase58()).toBe(extra.keys[0].pubkey);

    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(result.ixCount).toBeGreaterThan(0);
    expect(result.sizeBytes).toBe(512);
  });
});


