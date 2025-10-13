import { describe, it, expect } from 'vitest';
// Provide ambient declarations for vi/beforeEach to satisfy type checker in this test file
declare const vi: any;
declare function beforeEach(cb: (...args: any[]) => any): void;

describe('multi-hop multi-dex tx building (SPL and Token2022)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('builds multi-hop (raydium amm -> orca clmm -> meteora dlmm) for SPL tokens', async () => {
    // Stub derive/create ATA to be observable and program-aware
    vi.mock('../execution/accounts.js', () => ({
      deriveAta: vi.fn((_owner: any, mint: any, programKind: any) => `ATA_${programKind}_${String(mint)}`),
      buildCreateAtaIx: vi.fn((_owner: any, _payer: any, mint: any, programKind: any) =>
        ({ programId: 'spl-associated-token-account', type: 'createAta', programKind, mint: String(mint) })),
      isSolMint: vi.fn(() => false),
      buildWrapSolIxs: vi.fn(() => ({ ixs: [], wsolAta: 'WSOL' })),
      buildUnwrapSolIx: vi.fn(() => ({ programId: 'spl-token', type: 'unwrap' })),
    }));

    // Stub DEX builders to avoid SDK/network. Return sentinel ixs.
    vi.mock('../execution/builder/ix.js', () => ({
      buildRaydiumAmmSwapIxReal: vi.fn(async () => [{ programId: 'raydium-amm', type: 'swap' }]),
      buildRaydiumClmmSwapIxReal: vi.fn(async () => [{ programId: 'raydium-clmm', type: 'swap' }]),
      buildOrcaSwapIx: vi.fn(async () => [{ programId: 'orca-clmm', type: 'swap' }]),
      buildMeteoraDlmmSwapIxReal: vi.fn(async () => [{ programId: 'meteora-dlmm', type: 'swap' }]),
      // Fallbacks used only when simulate + amount=0
      buildRaydiumAmmSwapIx: vi.fn(() => [{ programId: 'raydium-amm-fallback', type: 'swap' }]),
      buildRaydiumClmmSwapIx: vi.fn(() => [{ programId: 'raydium-clmm-fallback', type: 'swap' }]),
      buildMeteoraDlmmSwapIx: vi.fn(() => [{ programId: 'meteora-dlmm-fallback', type: 'swap' }]),
    }));

    // Load real builder after mocks
    const { buildDirectArbTx } = await import('../execution/builder/tx.js');

    const plan = {
      path: ['MintA', 'MintB', 'MintC', 'MintD'],
      hops: [
        {
          dex: 'raydium', variant: 'amm', poolId: 'R1', programId: 'RayAMM',
          inputMint: 'MintA', outputMint: 'MintB',
          inputDecimals: 6, outputDecimals: 6,
          inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
          userSourceAta: '', userDestAta: '',
          amountInRaw: 10n, minOutRaw: 8n,
        },
        {
          dex: 'orca', variant: 'clmm', poolId: 'O1', programId: 'Whirlpool',
          inputMint: 'MintB', outputMint: 'MintC',
          inputDecimals: 6, outputDecimals: 6,
          inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
          userSourceAta: '', userDestAta: '',
          amountInRaw: 8n, minOutRaw: 6n,
        },
        {
          dex: 'meteora', variant: 'dlmm', poolId: 'M1', programId: 'DLMM',
          inputMint: 'MintC', outputMint: 'MintD',
          inputDecimals: 6, outputDecimals: 6,
          inputTokenProgram: 'spl-token', outputTokenProgram: 'spl-token',
          userSourceAta: '', userDestAta: '',
          amountInRaw: 6n, minOutRaw: 5n,
        },
      ],
      computeUnitPriceMicroLamports: 0,
    } as any;

    const res = await buildDirectArbTx(plan, [], { computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 0 });
    expect(res.ixCount).toBeGreaterThan(0);
    const pids = res.tx.instructions.map((ix: any) => ix.programId);
    // Confirm each hop contributed its sentinel ixs
    expect(pids.some((id: string) => id === 'raydium-amm')).toBe(true);
    expect(pids.some((id: string) => id === 'orca-clmm')).toBe(true);
    expect(pids.some((id: string) => id === 'meteora-dlmm')).toBe(true);
    // Confirm ATAs are created (we mock buildCreateAtaIx to this program id)
    expect(pids.some((id: string) => id === 'spl-associated-token-account')).toBe(true);
  });

  it('builds multi-hop for Token-2022 route (with correct ATA program)', async () => {
    vi.mock('../execution/accounts.js', () => ({
      deriveAta: vi.fn((_owner: any, mint: any, programKind: any) => `ATA_${programKind}_${String(mint)}`),
      buildCreateAtaIx: vi.fn((_owner: any, _payer: any, mint: any, programKind: any) =>
        ({ programId: 'spl-associated-token-account', type: 'createAta', programKind, mint: String(mint) })),
      isSolMint: vi.fn(() => false),
      buildWrapSolIxs: vi.fn(() => ({ ixs: [], wsolAta: 'WSOL' })),
      buildUnwrapSolIx: vi.fn(() => ({ programId: 'spl-token', type: 'unwrap' })),
    }));

    vi.mock('../execution/builder/ix.js', () => ({
      buildRaydiumAmmSwapIxReal: vi.fn(async () => [{ programId: 'raydium-amm', type: 'swap' }]),
      buildOrcaSwapIx: vi.fn(async () => [{ programId: 'orca-clmm', type: 'swap' }]),
      buildMeteoraDlmmSwapIxReal: vi.fn(async () => [{ programId: 'meteora-dlmm', type: 'swap' }]),
      buildRaydiumAmmSwapIx: vi.fn(() => [{ programId: 'raydium-amm-fallback', type: 'swap' }]),
      buildMeteoraDlmmSwapIx: vi.fn(() => [{ programId: 'meteora-dlmm-fallback', type: 'swap' }]),
      buildRaydiumClmmSwapIxReal: vi.fn(async () => [{ programId: 'raydium-clmm', type: 'swap' }]),
      buildRaydiumClmmSwapIx: vi.fn(() => [{ programId: 'raydium-clmm-fallback', type: 'swap' }]),
    }));

    const { buildDirectArbTx } = await import('../execution/builder/tx.js');

    // Mix SPL and Token-2022 through hops
    const plan = {
      path: ['MintX', 'MintY', 'MintZ'],
      hops: [
        {
          dex: 'raydium', variant: 'amm', poolId: 'R2', programId: 'RayAMM',
          inputMint: 'MintX', outputMint: 'MintY',
          inputDecimals: 6, outputDecimals: 6,
          inputTokenProgram: 'spl-token', outputTokenProgram: 'token-2022',
          userSourceAta: '', userDestAta: '',
          amountInRaw: 15n, minOutRaw: 12n,
        },
        {
          dex: 'meteora', variant: 'dlmm', poolId: 'M2', programId: 'DLMM',
          inputMint: 'MintY', outputMint: 'MintZ',
          inputDecimals: 6, outputDecimals: 6,
          inputTokenProgram: 'token-2022', outputTokenProgram: 'spl-token',
          userSourceAta: '', userDestAta: '',
          amountInRaw: 12n, minOutRaw: 10n,
        },
      ],
      computeUnitPriceMicroLamports: 0,
    } as any;

    const res = await buildDirectArbTx(plan, [], { computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 0 });
    const createAtas = res.tx.instructions.filter((ix: any) => ix.programId === 'spl-associated-token-account');
    expect(createAtas.length).toBeGreaterThan(0);
    // Ensure one of the created ATAs is for Token-2022 (our mock includes programKind)
    expect(createAtas.some((ix: any) => ix.programKind === 'token-2022')).toBe(true);
    // Ensure per-hop ixs exist
    const pids = res.tx.instructions.map((ix: any) => ix.programId);
    expect(pids.some((id: string) => id === 'raydium-amm')).toBe(true);
    expect(pids.some((id: string) => id === 'meteora-dlmm')).toBe(true);
  });
});


