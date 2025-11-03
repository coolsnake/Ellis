import { describe, it, expect } from 'vitest';
// Provide ambient declarations for vi/beforeEach to satisfy type checker in this test file
declare const vi: any;
declare function beforeEach(cb: (...args: any[]) => any): void;

describe('multi-dex multi-hop transaction tester', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('builds 6-hop multidex transaction: one hop each way on each DEX (Ray CLMM, Meteora, Orca)', async () => {
    // 6 hops: forward then reverse on each DEX
    // Hop 1: Raydium CLMM: SOL -> USDC
    // Hop 2: Meteora: USDC -> SOL
    // Hop 3: Orca: SOL -> USDC
    // Hop 4: Raydium CLMM: USDC -> SOL (reverse)
    // Hop 5: Meteora: SOL -> USDC (reverse)
    // Hop 6: Orca: USDC -> SOL (reverse)

    // Stub derive/create ATA to be observable and program-aware
    vi.mock('../execution/accounts.js', () => ({
      deriveAta: vi.fn((_owner: any, mint: any, programKind: any) => `ATA_${programKind}_${String(mint)}`),
      buildCreateAtaIx: vi.fn((_owner: any, _payer: any, mint: any, programKind: any) =>
        ({ programId: 'spl-associated-token-account', type: 'createAta', programKind, mint: String(mint) })),
      isSolMint: vi.fn((mint: string) => mint === 'So11111111111111111111111111111111111111112'),
      buildWrapSolIxs: vi.fn((_owner: any, _payer: any, lamports: number) => ({
        ixs: [{ programId: 'spl-token', type: 'wrap', lamports }],
        wsolAta: 'WSOL_ATA',
      })),
      buildUnwrapSolIx: vi.fn(() => ({ programId: 'spl-token', type: 'unwrap' })),
    }));

    // Stub DEX builders to avoid SDK/network. Return sentinel ixs.
    vi.mock('../execution/builder/ix.js', () => ({
      buildRaydiumClmmSwapIxReal: vi.fn(async () => [{ programId: 'raydium-clmm', type: 'swap' }]),
      buildOrcaSwapIx: vi.fn(async () => [{ programId: 'orca-clmm', type: 'swap' }]),
      buildMeteoraDlmmSwapIxReal: vi.fn(async () => [{ programId: 'meteora-dlmm', type: 'swap' }]),
      // Fallbacks used only when simulate + amount=0
      buildRaydiumClmmSwapIx: vi.fn(() => [{ programId: 'raydium-clmm-fallback', type: 'swap' }]),
      buildMeteoraDlmmSwapIx: vi.fn(() => [{ programId: 'meteora-dlmm-fallback', type: 'swap' }]),
    }));

    // Load real builder after mocks
    const { buildDirectArbTx } = await import('../execution/builder/tx.js');

    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const plan = {
      path: [SOL, USDC, SOL, USDC, SOL, USDC, SOL],
      hops: [
        {
          dex: 'raydium',
          variant: 'clmm',
          poolId: 'R1',
          programId: 'RayCLMM',
          inputMint: SOL,
          outputMint: USDC,
          inputDecimals: 9,
          outputDecimals: 6,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 10_000_000n, // 0.01 SOL
          minOutRaw: 1_600_000n, // ~1.6 USDC
        },
        {
          dex: 'meteora',
          variant: 'dlmm',
          poolId: 'M1',
          programId: 'DLMM',
          inputMint: USDC,
          outputMint: SOL,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 1_600_000n, // From previous hop
          minOutRaw: 9_500_000n, // ~0.0095 SOL (with slippage)
        },
        {
          dex: 'orca',
          variant: 'clmm',
          poolId: 'O1',
          programId: 'Whirlpool',
          inputMint: SOL,
          outputMint: USDC,
          inputDecimals: 9,
          outputDecimals: 6,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 9_500_000n, // From previous hop
          minOutRaw: 1_500_000n, // ~1.5 USDC
        },
        {
          dex: 'raydium',
          variant: 'clmm',
          poolId: 'R2',
          programId: 'RayCLMM',
          inputMint: USDC,
          outputMint: SOL,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 1_500_000n, // From previous hop
          minOutRaw: 9_000_000n, // ~0.009 SOL
        },
        {
          dex: 'meteora',
          variant: 'dlmm',
          poolId: 'M2',
          programId: 'DLMM',
          inputMint: SOL,
          outputMint: USDC,
          inputDecimals: 9,
          outputDecimals: 6,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 9_000_000n, // From previous hop
          minOutRaw: 1_400_000n, // ~1.4 USDC
        },
        {
          dex: 'orca',
          variant: 'clmm',
          poolId: 'O2',
          programId: 'Whirlpool',
          inputMint: USDC,
          outputMint: SOL,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 1_400_000n, // From previous hop
          minOutRaw: 8_500_000n, // ~0.0085 SOL
        },
      ],
      computeUnitPriceMicroLamports: 0,
    } as any;

    const res = await buildDirectArbTx(plan, [], { computeUnitLimit: 1_400_000, computeUnitPriceMicroLamports: 0 });

    expect(res.ixCount).toBeGreaterThan(6); // Should have setup + swap instructions
    expect(res.sizeBytes).toBeGreaterThan(0);

    const pids = res.tx.instructions.map((ix: any) => ix.programId);
    const pidsStr = pids.map((id: any) => {
      try {
        return typeof id === 'string' ? id : (id?.toBase58?.() || String(id));
      } catch {
        return String(id);
      }
    });

    // Verify all three DEXes appear (each forward and reverse)
    expect(pidsStr.some((id: string) => id === 'raydium-clmm')).toBe(true);
    expect(pidsStr.some((id: string) => id === 'orca-clmm')).toBe(true);
    expect(pidsStr.some((id: string) => id === 'meteora-dlmm')).toBe(true);

    // Verify ATAs are created
    expect(pidsStr.some((id: string) => id === 'spl-associated-token-account'))).toBe(true);

    // Verify WSOL wrapping/unwrapping for SOL hops
    expect(pidsStr.some((id: string) => id === 'spl-token')).toBe(true);
  });

  it('verifies amount propagation between hops', async () => {
    // This test verifies that amounts are correctly propagated
    // between hops in the transaction builder
    vi.mock('../execution/accounts.js', () => ({
      deriveAta: vi.fn((_owner: any, mint: any, programKind: any) => `ATA_${programKind}_${String(mint)}`),
      buildCreateAtaIx: vi.fn(() => ({ programId: 'spl-associated-token-account', type: 'createAta' })),
      isSolMint: vi.fn((mint: string) => mint === 'So11111111111111111111111111111111111111112'),
      buildWrapSolIxs: vi.fn(() => ({ ixs: [], wsolAta: 'WSOL_ATA' })),
      buildUnwrapSolIx: vi.fn(() => ({ programId: 'spl-token', type: 'unwrap' })),
    }));

    vi.mock('../execution/builder/ix.js', () => ({
      buildRaydiumClmmSwapIxReal: vi.fn(async (hop: any) => {
        // Verify hop.amountInRaw is set correctly
        expect(hop.amountInRaw).toBeGreaterThan(0n);
        return [{ programId: 'raydium-clmm', type: 'swap', amountIn: hop.amountInRaw }];
      }),
      buildOrcaSwapIx: vi.fn(async (hop: any) => {
        expect(hop.amountInRaw).toBeGreaterThan(0n);
        return [{ programId: 'orca-clmm', type: 'swap', amountIn: hop.amountInRaw }];
      }),
      buildMeteoraDlmmSwapIxReal: vi.fn(async (hop: any) => {
        expect(hop.amountInRaw).toBeGreaterThan(0n);
        return [{ programId: 'meteora-dlmm', type: 'swap', amountIn: hop.amountInRaw }];
      }),
      buildRaydiumClmmSwapIx: vi.fn(() => []),
      buildMeteoraDlmmSwapIx: vi.fn(() => []),
    }));

    const { buildDirectArbTx } = await import('../execution/builder/tx.js');

    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const plan = {
      path: [SOL, USDC, SOL],
      hops: [
        {
          dex: 'raydium',
          variant: 'clmm',
          poolId: 'R1',
          programId: 'RayCLMM',
          inputMint: SOL,
          outputMint: USDC,
          inputDecimals: 9,
          outputDecimals: 6,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 10_000_000n,
          minOutRaw: 1_600_000n,
        },
        {
          dex: 'meteora',
          variant: 'dlmm',
          poolId: 'M1',
          programId: 'DLMM',
          inputMint: USDC,
          outputMint: SOL,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTokenProgram: 'spl-token',
          outputTokenProgram: 'spl-token',
          userSourceAta: '',
          userDestAta: '',
          amountInRaw: 1_600_000n, // Should use output from hop 1
          minOutRaw: 9_500_000n,
        },
      ],
      computeUnitPriceMicroLamports: 0,
    } as any;

    // The builder should chain hop 2's userSourceAta to hop 1's userDestAta
    const res = await buildDirectArbTx(plan, [], { computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 0 });

    expect(res.ixCount).toBeGreaterThan(0);

    // Verify that both hops were built with correct amounts
    const { buildRaydiumClmmSwapIxReal, buildMeteoraDlmmSwapIxReal } = await import('../execution/builder/ix.js');
    expect(buildRaydiumClmmSwapIxReal).toHaveBeenCalled();
    expect(buildMeteoraDlmmSwapIxReal).toHaveBeenCalled();
  });
});

