import type { DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';

function sanitizeKeyString(v: any): string {
  try {
    return String(v || '').trim().replace(/-rev$/, '');
  } catch {
    return '';
  }
}

function toPublicKey(value: any, fallback?: any): PublicKey {
  const primary = sanitizeKeyString(value);
  try { if (primary) return new PublicKey(primary); } catch {}
  const fb = sanitizeKeyString(fallback);
  if (fb) {
    try { return new PublicKey(fb); } catch {}
  }
  // Preserve original error semantics to aid upstream handling/logging
  throw new Error('Non-base58 character');
}

function resolveRaydiumAmmVersion(programIdStr?: string): 4 | 5 {
  try {
    const pid = sanitizeKeyString(programIdStr);
    const v4 = sanitizeKeyString((CONFIG as any)?.raydium?.ammV4Program);
    const v5 = sanitizeKeyString((CONFIG as any)?.raydium?.ammV5Program);
    if (pid && v5 && pid === v5) return 5;
    if (pid && v4 && pid === v4) return 4;
  } catch {}
  return 4;
}

export function computeSlippageBps(amountInRaw?: bigint, minOutRaw?: bigint): number {
  try {
    if ((amountInRaw ?? 0n) > 0n && (minOutRaw ?? 0n) > 0n) {
      const ratio = Number(minOutRaw) / Math.max(1, Number(amountInRaw));
      const bps = Math.max(0, Math.min(9900, Math.round((1 - ratio) * 10000)));
      return bps;
    }
  } catch {}
  return 100; // default 1%
}

// Placeholders to satisfy wiring; concrete implementations will target specific programs
export function buildRaydiumAmmSwapIx(hop: DirectHop): any[] {
  try { logger.info('ix.build raydium.amm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'RaydiumAmmV4', type: 'raydium.amm.swap', keys: { poolId: hop.poolId, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, vaultA: hop.vaultA, vaultB: hop.vaultB }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}
export function buildRaydiumClmmSwapIx(hop: DirectHop): any[] {
  try { logger.info('ix.build raydium.clmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'RaydiumClmm', type: 'raydium.clmm.swap', keys: { poolId: hop.poolId, tickArrayLower: hop.tickArrayLower, tickArrayCenter: hop.tickArrayCenter, tickArrayUpper: hop.tickArrayUpper, oracle: hop.oracle, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, vaultA: hop.vaultA, vaultB: hop.vaultB }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw, sqrtPriceLimitX64: hop.sqrtPriceLimitX64 || 0n } }];
}
export async function buildOrcaSwapIx(hop: DirectHop): Promise<any[]> {
  try { logger.info('ix.build orca.clmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    const connection = getConnection();
    const kp = await ensureWallet(CONFIG.walletPath);
    const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, SwapUtils, toTx } = await import('@orca-so/whirlpools-sdk');
    try { logger.info('orca.whirlpool.import.ok', { cat: 'tx', ctx: { haveContext: !!WhirlpoolContext, haveClient: !!buildWhirlpoolClient, haveQuoteFn: !!swapQuoteByInputToken, haveSwapUtils: !!SwapUtils, haveToTx: !!toTx } as any }); } catch {}
    const BN = (await import('bn.js')).default as any;
    const { Percentage } = await import('@orca-so/common-sdk');
    const dummyWallet: any = { publicKey: kp.publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any[]) => txs };
    const programId = toPublicKey(hop.programId, (CONFIG.orca?.programId as any));
    try { logger.info('orca.whirlpool.program', { cat: 'tx', ctx: { programId: programId?.toBase58?.() || String(programId) } as any }); } catch {}
    const ctx = (WhirlpoolContext as any).from(connection as any, dummyWallet, programId);
    try { logger.info('orca.whirlpool.ctx.ok', { cat: 'tx' }); } catch {}
    const client = (buildWhirlpoolClient as any)(ctx);
    try { logger.info('orca.whirlpool.client.ok', { cat: 'tx' }); } catch {}
    const poolPk = toPublicKey(hop.poolId);
    try { logger.info('orca.whirlpool.pool.prepare', { cat: 'tx', ctx: { pool: poolPk?.toBase58?.() || String(poolPk) } as any }); } catch {}
    const pool = await client.getPool(poolPk);
    try { logger.info('orca.whirlpool.pool.ok', { cat: 'tx' }); } catch {}
    const inputMint = toPublicKey(hop.inputMint);
    const bps = computeSlippageBps(hop.amountInRaw, hop.minOutRaw);
    const slippage = (Percentage as any).fromFraction(bps, 10000);
    try { logger.info('orca.whirlpool.slippage', { cat: 'tx', ctx: { amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n), bps } as any }); } catch {}
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    try { logger.info('orca.whirlpool.input', { cat: 'tx', ctx: { inputMint: inputMint?.toBase58?.() || String(inputMint), amountIn: amountInBn?.toString?.() } as any }); } catch {}
    const quote = await (swapQuoteByInputToken as any)(pool, inputMint, amountInBn, slippage, ctx.program.programId, ctx.fetcher, true);
    try {
      const est = (quote as any)?.otherAmount ?? (quote as any)?.estimatedAmountOut ?? 0;
      logger.info('orca.whirlpool.quote.ok', { cat: 'tx', ctx: { estimatedOutRaw: String(est) } as any });
    } catch {}
    const params = (SwapUtils as any).getSwapParamsFromQuote(
      quote,
      ctx,
      pool,
      toPublicKey(hop.userSourceAta),
      toPublicKey(hop.userDestAta),
      kp.publicKey,
    );
    try { if (hop.sqrtPriceLimitX64 && params && ('sqrtPriceLimit' in (params as any))) { (params as any).sqrtPriceLimit = hop.sqrtPriceLimitX64; } } catch {}
    try {
      const lim = (params as any)?.sqrtPriceLimit ?? 0;
      logger.info('orca.whirlpool.params.ok', { cat: 'tx', ctx: { hasLimit: !!lim, sqrtPriceLimitX64: String(lim) } as any });
    } catch {}
    const txb = await pool.swap(params);
    try { logger.info('orca.whirlpool.swap.builder.ok', { cat: 'tx' }); } catch {}
    const tx = (toTx as any)(ctx, txb);
    const built = await tx.build();
    try {
      const count = Array.isArray((built as any)?.instructions) ? (built as any).instructions.length : 0;
      logger.info('orca.whirlpool.tx.build.ok', { cat: 'tx', ctx: { instructionCount: count } as any });
    } catch {}
    // Robustly unwrap various SDK return shapes into raw TransactionInstructions
    const unwrapIxs = (val: any): any[] => {
      try {
        if (!val) return [];
        // Direct TransactionInstruction
        if (val instanceof TransactionInstruction) return [val];
        // Plain TI-shaped object
        if (val && typeof val === 'object' && (val as any).programId && ((Array.isArray((val as any).keys)) || (typeof (val as any).keys?.length === 'number'))) {
          return [val];
        }
        // Common shapes
        if (Array.isArray((val as any).instructions)) return (val as any).instructions;
        if ((val as any).innerTransaction && Array.isArray((val as any).innerTransaction.instructions)) return (val as any).innerTransaction.instructions;
        if (Array.isArray((val as any).innerTransactions) && (val as any).innerTransactions.length) {
          const flat: any[] = [];
          for (const it of (val as any).innerTransactions) if (it && Array.isArray(it.instructions)) flat.push(...it.instructions);
          return flat;
        }
      } catch {}
      return [];
    };
    const raw = unwrapIxs(built);
    const out = (raw && raw.length) ? raw : (built && (built as any).instructions ? (built as any).instructions : []);
    try { logger.info('orca.whirlpool.ix.ready', { cat: 'tx', ctx: { count: Array.isArray(out) ? out.length : 0 } as any }); } catch {}
    return out || [];
  } catch (e) {
    try { logger.warn('ix.build orca.clmm fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    // Shape a minimal, coercible instruction to aid diagnostics in preflight
    return [{
      programId: (hop.programId || (CONFIG as any)?.orca?.programId || 'whirlpool') as any,
      keys: [
        { pubkey: hop.poolId, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    }];
  }
}
export function buildMeteoraDlmmSwapIx(hop: DirectHop): any[] {
  try { logger.debug('ix.build meteora.dlmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'meteoraDLMM', type: 'meteora.dlmm.swap', keys: { poolId: hop.poolId, binArrayLower: hop.binArrayLower, binArrayUpper: hop.binArrayUpper, reserveX: hop.reserveX, reserveY: hop.reserveY, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}

export async function buildMeteoraDlmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build meteora.dlmm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const poolPk = toPublicKey(hop.poolId);
  const programId = toPublicKey(hop.programId as string, (CONFIG as any)?.meteora?.programId);
  try { logger.info('meteora.dlmm.build.start', { cat: 'tx', ctx: { pool: poolPk?.toBase58?.() || String(poolPk), programId: programId?.toBase58?.() || String(programId), amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n) } as any }); } catch {}

  // 1) Prefer CJS require to load Meteora modules (many ship as CJS)
  let mod: any = null;
  try {
    const m: any = await import('node:module');
    const createRequire: any = (m && m.createRequire) || (m?.default && m.default.createRequire);
    const req: any = createRequire ? createRequire(import.meta.url) : undefined;
    if (req) {
      const specs = [
        '@meteora-ag/dlmm',
        '@meteora-ag/dlmm/ts-client',
        '@meteora-ag/dlmm-sdk',
        '@meteora-ag/dlmm-sdk-public',
        '@meteora-ag/dlmm/dist/index.js',
        '@meteora-ag/dlmm-sdk/dist/index.js',
      ];
      for (const spec of specs) {
        try { const m2 = req(spec); if (m2) { mod = m2; try { logger.info('meteora.dlmm.require.ok', { cat: 'tx', ctx: { spec, keys: Object.keys(m2 || {}) } }); } catch {}; break; } } catch (e: any) { try { logger.warn('meteora.dlmm.require.fail', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { spec, error: String(e?.message || e) } }); } catch {} }
      }
    }
  } catch {}

  // 2) Fallback: dynamic import
  if (!mod) {
    const dyn = (Function('return import')()) as any;
    const specs = [
      '@meteora-ag/dlmm',
      '@meteora-ag/dlmm/ts-client',
      '@meteora-ag/dlmm-sdk',
      '@meteora-ag/dlmm-sdk-public',
      '@meteora-ag/dlmm/dist/index.js',
      '@meteora-ag/dlmm-sdk/dist/index.js',
    ];
    for (const spec of specs) {
      try { const m2 = await dyn(spec); if (m2) { mod = m2; try { logger.info('meteora.dlmm.import.ok', { cat: 'tx', ctx: { spec, keys: Object.keys(m2 || {}) } }); } catch {}; break; } } catch (e: any) { try { logger.warn('meteora.dlmm.import.fail', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { spec, error: String(e?.message || e) } }); } catch {} }
    }
  }

  if (!mod) { try { logger.warn('meteora.dlmm.import.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: 'ALL_IMPORTS_FAILED' } }); } catch {}; throw new Error('METEORA_DLMM_BUILD_FAILED'); }

  // Resolve default export / namespace
  const DLMM: any = (mod && (mod as any).default) ? (mod as any).default : (((mod as any).DLMM) || mod);

  // 3) Fast path: if swapIx exists, use it
  try {
    if (typeof (DLMM as any)?.swapIx === 'function') {
      const params = {
        pool: poolPk,
        programId,
        userSourceAta: toPublicKey(hop.userSourceAta),
        userDestAta: toPublicKey(hop.userDestAta),
        amountIn: hop.amountInRaw,
        minOut: hop.minOutRaw,
        binArrayLower: hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined,
        binArrayUpper: hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined,
      } as any;
      try { logger.info('meteora.dlmm.swapIx.call', { cat: 'tx' }); } catch {}
      const ix = await (DLMM as any).swapIx(connection, kp.publicKey, params);
      if (ix) { try { logger.info('meteora.dlmm.swapIx.ok', { cat: 'tx' }); } catch {}; return [ix]; }
    }
  } catch (e: any) { try { logger.warn('meteora.dlmm.swapIx.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {} }

  // 4) ts-client fallback: Anchor program path
  try {
    const createProgram = (DLMM as any)?.createProgram || (mod as any)?.createProgram;
    if (!createProgram) throw new Error('DLMM_CREATE_PROGRAM_MISSING');
    const program = createProgram(connection, programId);
    try { logger.info('meteora.dlmm.program.ok', { cat: 'tx' }); } catch {}

    // Derive optional accounts
    let binArrayLower: PublicKey | undefined = hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined;
    let binArrayUpper: PublicKey | undefined = hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined;
    let binArrayBitmapExtension: PublicKey | undefined = undefined;
    try {
      const getBinBounds = (DLMM as any)?.getBinArrayLowerUpperBinId || (DLMM as any)?.deriveBinArrayLowerUpperBinId;
      const deriveBinArray = (DLMM as any)?.deriveBinArray;
      const deriveBinArrayBitmapExtension = (DLMM as any)?.deriveBinArrayBitmapExtension;
      if ((!binArrayLower || !binArrayUpper) && getBinBounds && deriveBinArray) {
        const bounds = await getBinBounds(connection, poolPk).catch(() => null as any);
        if (bounds && typeof bounds.lowerBinId === 'number' && typeof bounds.upperBinId === 'number') {
          try { const lo = await deriveBinArray(programId, poolPk, bounds.lowerBinId); binArrayLower = (lo as any)?.publicKey || lo || binArrayLower; } catch {}
          try { const hi = await deriveBinArray(programId, poolPk, bounds.upperBinId); binArrayUpper = (hi as any)?.publicKey || hi || binArrayUpper; } catch {}
        }
      }
      try {
        // Robustly attempt to derive the bitmap extension PDA across SDK variants
        const coercePk = (val: any): PublicKey | undefined => {
          try {
            if (!val) return undefined;
            if (val instanceof PublicKey) return val;
            if ((val as any)?.publicKey instanceof PublicKey) return (val as any).publicKey as PublicKey;
            if ((val as any)?.address instanceof PublicKey) return (val as any).address as PublicKey;
            if (typeof (val as any)?.toBase58 === 'function') return val as PublicKey;
            if (typeof val === 'string') return new PublicKey(val);
            if (Array.isArray(val) && val.length && (val[0] instanceof PublicKey)) return val[0] as PublicKey;
            if ((val as any)?.publicKey && typeof (val as any).publicKey === 'string') return new PublicKey((val as any).publicKey);
            if ((val as any)?.address && typeof (val as any).address === 'string') return new PublicKey((val as any).address);
          } catch {}
          return undefined;
        };
        const attempts: Array<() => Promise<any>> = [];
        if (deriveBinArrayBitmapExtension) {
          attempts.push(() => deriveBinArrayBitmapExtension(programId, poolPk));
          attempts.push(() => deriveBinArrayBitmapExtension(poolPk, programId));
          attempts.push(() => deriveBinArrayBitmapExtension(programId.toBase58?.() || String(programId), poolPk));
          attempts.push(() => deriveBinArrayBitmapExtension(poolPk, programId.toBase58?.() || String(programId)));
          attempts.push(() => deriveBinArrayBitmapExtension(program, poolPk));
          attempts.push(() => deriveBinArrayBitmapExtension(connection, programId, poolPk));
          attempts.push(() => deriveBinArrayBitmapExtension(connection, poolPk, programId));
          attempts.push(() => deriveBinArrayBitmapExtension({ programId, lbPair: poolPk }));
          attempts.push(() => deriveBinArrayBitmapExtension({ program, lbPair: poolPk }));
          attempts.push(() => deriveBinArrayBitmapExtension({ connection, programId, lbPair: poolPk }));
        }
        // Fallbacks via coverage helpers, if available
        const getKeysCoverage = (DLMM as any)?.getBinArrayKeysCoverage || (DLMM as any)?.getBinArrayAccountMetasCoverage;
        if (getKeysCoverage) {
          attempts.push(async () => {
            const res = await getKeysCoverage(programId, poolPk);
            if (!res) return undefined;
            if ((res as any)?.binArrayBitmapExtension) return (res as any).binArrayBitmapExtension;
            if ((res as any)?.accounts?.binArrayBitmapExtension) return (res as any).accounts.binArrayBitmapExtension;
            const metas: any[] = (res as any)?.metas || (res as any)?.accountMetas || [];
            const found = metas.find((m: any) => (m?.name === 'binArrayBitmapExtension') && (m?.pubkey || m?.publicKey || m?.address));
            return found?.pubkey || found?.publicKey || found?.address;
          });
          attempts.push(async () => {
            const res = await getKeysCoverage(connection, programId, poolPk);
            if (!res) return undefined;
            if ((res as any)?.binArrayBitmapExtension) return (res as any).binArrayBitmapExtension;
            if ((res as any)?.accounts?.binArrayBitmapExtension) return (res as any).accounts.binArrayBitmapExtension;
            const metas: any[] = (res as any)?.metas || (res as any)?.accountMetas || [];
            const found = metas.find((m: any) => (m?.name === 'binArrayBitmapExtension') && (m?.pubkey || m?.publicKey || m?.address));
            return found?.pubkey || found?.publicKey || found?.address;
          });
          attempts.push(async () => {
            const res = await getKeysCoverage({ programId, lbPair: poolPk });
            if (!res) return undefined;
            return (res as any)?.binArrayBitmapExtension || (res as any)?.accounts?.binArrayBitmapExtension;
          });
          attempts.push(async () => {
            const res = await getKeysCoverage({ connection, programId, lbPair: poolPk });
            if (!res) return undefined;
            return (res as any)?.binArrayBitmapExtension || (res as any)?.accounts?.binArrayBitmapExtension;
          });
        }
        const chunkFetch = (DLMM as any)?.chunkedFetchMultipleBinArrayBitmapExtensionAccount;
        if (chunkFetch) {
          attempts.push(async () => {
            const arr = await chunkFetch(connection, programId, [poolPk]);
            const first = Array.isArray(arr) ? arr[0] : undefined;
            return first?.publicKey || first?.address || first;
          });
          attempts.push(async () => {
            const arr = await chunkFetch(programId, [poolPk]);
            const first = Array.isArray(arr) ? arr[0] : undefined;
            return first?.publicKey || first?.address || first;
          });
          attempts.push(async () => {
            const arr = await chunkFetch({ connection, programId, lbPairs: [poolPk] });
            const first = Array.isArray(arr) ? arr[0] : undefined;
            return first?.publicKey || first?.address || first;
          });
        }
        for (const fn of attempts) {
          try {
            const val = await fn();
            const pk = coercePk(val);
            if (pk) { binArrayBitmapExtension = pk; break; }
          } catch {}
        }
        // Last resort: compute PDA via common seed candidates
        if (!binArrayBitmapExtension) {
          try {
            const seedCandidates = [
              'bin_array_bitmap_extension',
              'binarray_bitmap_extension',
              'bin_array_bitmap_ext',
              'binarray_bitmap_ext',
            ];
            for (const s of seedCandidates) {
              try {
                const [addr] = await (PublicKey as any).findProgramAddress([
                  Buffer.from(s),
                  poolPk.toBuffer(),
                ], programId);
                if (addr) { binArrayBitmapExtension = addr; break; }
              } catch {}
            }
          } catch {}
        }
        if (binArrayBitmapExtension) { try { logger.info('meteora.dlmm.derive.ext.ok', { cat: 'tx', ctx: { ext: binArrayBitmapExtension?.toBase58?.() } as any }); } catch {} }
      } catch {}
    } catch {}

    const BN = (await import('bn.js')).default as any;
    const amountIn = new BN(String(hop.amountInRaw ?? 0n));
    const minOut = new BN(String(hop.minOutRaw ?? 0n));
    const methods = (program as any)?.methods || {};
    let builder: any = null;
    if (typeof methods.swapExactIn === 'function') builder = methods.swapExactIn(amountIn, minOut);
    else if (typeof methods.swap === 'function') builder = methods.swap(amountIn, minOut);
    if (!builder) throw new Error('DLMM_SWAP_METHOD_MISSING');

    const accounts: any = {
      lbPair: poolPk,
      user: kp.publicKey,
      userTokenIn: toPublicKey(hop.userSourceAta),
      userTokenOut: toPublicKey(hop.userDestAta),
    };
    if (binArrayLower) accounts.binArrayLower = binArrayLower;
    if (binArrayUpper) accounts.binArrayUpper = binArrayUpper;
    // As of newer DLMM IDLs, this account is required. Fail early if not derivable.
    if (!binArrayBitmapExtension) throw new Error('BIN_ARRAY_BITMAP_EXTENSION_DERIVE_FAILED');
    accounts.binArrayBitmapExtension = binArrayBitmapExtension;

    // Extend with host/referral fee handling and reserves when available
    const acctBase: any = { ...accounts, hostFeeIn: null };
    try {
      if (hop.vaultA) acctBase.reserveX = toPublicKey(hop.vaultA as any);
      if (hop.vaultB) acctBase.reserveY = toPublicKey(hop.vaultB as any);
    } catch {}

    // Prefer accountsPartial so optional nulls are honored
    if (typeof (builder as any).accountsPartial === 'function') builder = (builder as any).accountsPartial(acctBase);
    else if (typeof (builder as any).accounts === 'function') builder = (builder as any).accounts(acctBase);
    const ix = (typeof builder.instruction === 'function') ? await builder.instruction() : null;
    if (ix) { try { logger.info('meteora.dlmm.swap.ok', { cat: 'tx' }); } catch {}; return [ix]; }
    try { logger.warn('meteora.dlmm.tsclient.swap.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  } catch (e: any) {
    try { logger.warn('meteora.dlmm.tsclient.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
  }

  throw new Error('METEORA_DLMM_BUILD_FAILED');
}

export function maybeCreateAtas(hop: DirectHop, create: boolean): any[] {
  if (!create) return [];
  const out: any[] = [];
  if (!hop.userSourceAta) out.push({ programId: 'spl-associated-token-account', type: 'createAta', mint: hop.inputMint });
  if (!hop.userDestAta) out.push({ programId: 'spl-associated-token-account', type: 'createAta', mint: hop.outputMint });
  return out;
}

// Real Raydium builders (best-effort via SDK; fallback to placeholders on error)
export async function buildRaydiumClmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build raydium.clmm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    // Ensure required CLMM fields; derive oracle/tick arrays on the fly if missing
    const preMissing: string[] = [];
    if (!hop.inputMint) preMissing.push('inputMint');
    if (!hop.outputMint) preMissing.push('outputMint');
    if (!hop.userSourceAta) preMissing.push('userSourceAta');
    if (!hop.userDestAta) preMissing.push('userDestAta');
    if (preMissing.length) throw new Error(`RAYDIUM_CLMM_BUILD_FAILED: missing ${preMissing.join(',')}`);

    if (!hop.tickArrayLower || !hop.tickArrayUpper || !hop.oracle) {
      try {
        const web3: any = await import('@solana/web3.js');
        const { getConnection } = await import('../../wallet/wallet.js');
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
        const poolPk = toPublicKey(hop.poolId);
        const conn = getConnection();
        const acc = await withRpcLimit(() => conn.getAccountInfo(poolPk));
        if (acc?.data?.length) {
          const layout = (rmod as any)?.Clmm?.PoolStateLayout || (rmod as any)?.CLMM?.POOL_STATE_LAYOUT || (rmod as any)?.PoolStateLayout;
          const state = layout && typeof layout.decode === 'function' ? layout.decode(acc.data) : null;
          if (state) {
            try {
              const o = (state as any).oracle?.toBase58?.() || String((state as any).oracle || '');
              if (o && !hop.oracle) hop.oracle = o;
            } catch {}
            const spacing = Number(hop.tickSpacing || (state as any).tickSpacing || (state as any).tick_spacing || 0);
            const curTick = Number((state as any).tickCurrent ?? (state as any).tick_current ?? 0);
            if (Number.isFinite(spacing) && spacing > 0 && Number.isFinite(curTick)) {
              const TICK_ARRAY_SIZE = 88;
              const block = TICK_ARRAY_SIZE * spacing;
              const startLower = Math.floor((curTick - spacing) / block) * block;
              const startUpper = Math.floor((curTick + spacing) / block) * block;
              let programId: any;
              try { programId = new web3.PublicKey(hop.programId); } catch { programId = new web3.PublicKey((CONFIG.raydium as any)?.clmmProgram || 'CAMMCzo5nKXjotvLkGQ6r1N1C8QXr8iY6pYwWf3V8mGk'); }
              let lowerPk: any = null; let upperPk: any = null;
              try {
                const util = (rmod as any)?.Clmm || (rmod as any)?.CLMM;
                const getPda = util?.getTickArrayAddress || util?.tickArrayPda || util?.getPdaTickArray;
                if (typeof getPda === 'function') {
                  const resL = await getPda({ programId, poolId: poolPk, startIndex: startLower });
                  const resU = await getPda({ programId, poolId: poolPk, startIndex: startUpper });
                  lowerPk = (resL && (resL.publicKey || resL)) || null;
                  upperPk = (resU && (resU.publicKey || resU)) || null;
                }
              } catch {}
              if (!lowerPk || !upperPk) {
                const i32le = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; };
                try {
                  const [l] = web3.PublicKey.findProgramAddressSync([Buffer.from('tick_array'), poolPk.toBuffer(), i32le(startLower)], programId);
                  const [u] = web3.PublicKey.findProgramAddressSync([Buffer.from('tick_array'), poolPk.toBuffer(), i32le(startUpper)], programId);
                  lowerPk = lowerPk || l; upperPk = upperPk || u;
                } catch {}
              }
              if (!hop.tickArrayLower && lowerPk) hop.tickArrayLower = lowerPk.toBase58?.() || String(lowerPk);
              if (!hop.tickArrayUpper && upperPk) hop.tickArrayUpper = upperPk.toBase58?.() || String(upperPk);
            }
          }
        }
      } catch {}
    }
    // Final validation after derivation attempt
    const missing: string[] = [];
    if (!hop.tickArrayLower || !hop.tickArrayUpper) missing.push('tickArrayLower/Upper');
    if (!hop.oracle) missing.push('oracle');
    if (missing.length) throw new Error(`RAYDIUM_CLMM_BUILD_FAILED: missing ${missing.join(',')}`);

    const { ClmmInstrument } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const poolId = toPublicKey(hop.poolId);
    const programId = toPublicKey(hop.programId, (CONFIG.raydium?.clmmProgram as any));
    const observationId = toPublicKey((CONFIG.raydium as any)?.clmmObservationId || PublicKey.default.toBase58());

    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: toPublicKey(hop.userSourceAta),
      tokenAccountB: toPublicKey(hop.userDestAta),
    };

    // Minimal poolInfo/poolKeys for swapBaseIn; for real use, prefer full keys via SDK helper if available in version
    const poolInfo = { id: poolId, programId, mintA: toPublicKey(hop.inputMint), mintB: toPublicKey(hop.outputMint), config: {} } as any;
    const poolKeys = {
      id: poolId,
      programId,
      mintA: toPublicKey(hop.inputMint),
      mintB: toPublicKey(hop.outputMint),
      vault: { A: toPublicKey(hop.vaultA as any), B: toPublicKey(hop.vaultB as any) },
      authority: toPublicKey((CONFIG.raydium as any)?.clmmAuthority || PublicKey.default.toBase58()),
      observationId,
      tickArrayLower: toPublicKey(hop.tickArrayLower as any),
      tickArrayUpper: toPublicKey(hop.tickArrayUpper as any),
    } as any;

    const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
      poolInfo,
      poolKeys,
      observationId,
      ownerInfo,
      inputMint: toPublicKey(hop.inputMint),
      amountIn: hop.amountInRaw,
      amountOutMin: hop.minOutRaw,
      sqrtPriceLimitX64: hop.sqrtPriceLimitX64 ?? 0n,
      remainingAccounts: [],
    });
    const ixs = Array.isArray(res?.instructions) ? res.instructions : (res?.innerTransaction ? res.innerTransaction.instructions : []);
    if (ixs && ixs.length) return ixs as any[];
  } catch (e) {
    try { logger.warn('ix.build raydium.clmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_CLMM_BUILD_FAILED');
}

export async function buildRaydiumAmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.info('ix.build raydium.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    if ((hop.amountInRaw || 0n) <= 0n) {
      throw new Error('RAYDIUM_AMM_BUILD_FAILED: amount=0');
    }
    // Best-effort: derive missing market/program from on-chain pool state
    try {
      if (!hop.market || !hop.serumProgramId) {
        const connection = getConnection();
        const poolPk = toPublicKey(hop.poolId);
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const acc = await withRpcLimit(() => connection.getAccountInfo(poolPk));
        if (acc?.data?.length) {
          const rmod: any = await import('@raydium-io/raydium-sdk-v2');
          const layouts = [
            (rmod as any)?.LiquidityStateLayoutV4,
            (rmod as any)?.liquidityStateV4Layout,
            (rmod as any)?.LiquidityStateLayoutV5,
            (rmod as any)?.liquidityStateV5Layout,
          ].filter(Boolean);
          for (const layout of layouts) {
            try {
              const state = layout.decode(acc.data);
              const mk = state.marketId?.toBase58?.() || state.marketId?.toString?.() || '';
              const mp = state.marketProgramId?.toBase58?.() || state.marketProgramId?.toString?.() || '';
              if (mk && mp) {
                hop.market = hop.market || mk;
                hop.serumProgramId = hop.serumProgramId || mp;
                break;
              }
            } catch {}
          }
        }
      }
    } catch {}
    // Validate required fields for Raydium AMM build
    const missing: string[] = [];
    if (!hop.market) missing.push('market');
    if (!hop.serumProgramId) missing.push('serumProgramId');
    if (!hop.inputMint) missing.push('inputMint');
    if (!hop.outputMint) missing.push('outputMint');
    if (!Number.isFinite(Number(hop.inputDecimals))) missing.push('inputDecimals');
    if (!Number.isFinite(Number(hop.outputDecimals))) missing.push('outputDecimals');
    if (!hop.userSourceAta) missing.push('userSourceAta');
    if (!hop.userDestAta) missing.push('userDestAta');
    if (missing.length) {
      const ver = resolveRaydiumAmmVersion(hop.programId);
      throw new Error(`RAYDIUM_AMM_BUILD_FAILED: missing ${missing.join(',')} (version=${ver})`);
    }

    const { getAssociatedPoolKeys, makeSwapFixedInInstruction } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const programId = toPublicKey(hop.programId, (CONFIG.raydium?.ammV4Program as any));
    const marketId = toPublicKey(hop.market);
    const marketProgramId = toPublicKey(hop.serumProgramId);

    // Choose Raydium AMM version; default to 4
    const version = resolveRaydiumAmmVersion(hop.programId);

    // Build pool keys (requires correct base/quote mints & decimals per market)
    let poolKeys = (getAssociatedPoolKeys as any)({
      version,
      marketVersion: 3,
      marketId,
      baseMint: toPublicKey(hop.inputMint),
      quoteMint: toPublicKey(hop.outputMint),
      baseDecimals: Number(hop.inputDecimals),
      quoteDecimals: Number(hop.outputDecimals),
      programId,
      marketProgramId,
    });

    // If SDK helper didn't populate vaults/auth/market keys (mint order or decimals mismatch),
    // derive them from on-chain AMM state (V4/V5).
    try {
      const needVaults = !poolKeys?.vault?.A || !poolKeys?.vault?.B;
      const needMarket = !poolKeys?.marketProgramId || !poolKeys?.marketId;
      const needAuth = !poolKeys?.authority;
      if (needVaults || needMarket || needAuth) {
        const connection = getConnection();
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const acc = await withRpcLimit(() => connection.getAccountInfo(toPublicKey(hop.poolId)));
        if (acc?.data?.length) {
          const sdkLayouts: any = await import('@raydium-io/raydium-sdk-v2');
          const layouts = [
            (sdkLayouts as any)?.LiquidityStateLayoutV4,
            (sdkLayouts as any)?.liquidityStateV4Layout,
            (sdkLayouts as any)?.LiquidityStateLayoutV5,
            (sdkLayouts as any)?.liquidityStateV5Layout,
          ].filter(Boolean);
          let state: any = null;
          for (const layout of layouts) {
            try { state = layout.decode(acc.data); break; } catch {}
          }
          if (state) {
            // Normalize fields across versions
            const asPk = (v: any) => (v?.toBase58 ? v : (v ? toPublicKey(v) : undefined));
            const baseVault = asPk(state.baseVault || state.coinVault || state.vaultA);
            const quoteVault = asPk(state.quoteVault || state.pcVault || state.vaultB);
            const authority = asPk(state.owner || state.ammAuthority || state.authority);
            const openOrders = asPk(state.openOrders);
            const targetOrders = asPk(state.targetOrders);
            const lpMint = asPk(state.lpMint);
            const marketPk = asPk(state.marketId);
            const marketProg = asPk(state.marketProgramId);
            const marketEventQueue = asPk(state.marketEventQueue);
            const marketBids = asPk(state.marketBids);
            const marketAsks = asPk(state.marketAsks);
            const marketBaseVault = asPk(state.marketBaseVault || state.baseVault);
            const marketQuoteVault = asPk(state.marketQuoteVault || state.quoteVault);
            const marketAuthority = asPk(state.marketAuthority);
            poolKeys = {
              ...poolKeys,
              id: toPublicKey(hop.poolId),
              programId,
              authority: authority || poolKeys?.authority,
              openOrders: openOrders || poolKeys?.openOrders,
              targetOrders: targetOrders || poolKeys?.targetOrders,
              vault: {
                A: baseVault || (poolKeys?.vault ? poolKeys.vault.A : undefined),
                B: quoteVault || (poolKeys?.vault ? poolKeys.vault.B : undefined),
              },
              mintLp: lpMint || poolKeys?.mintLp,
              marketProgramId: marketProg || poolKeys?.marketProgramId,
              marketId: marketPk || poolKeys?.marketId,
              marketEventQueue: marketEventQueue || poolKeys?.marketEventQueue,
              marketBids: marketBids || poolKeys?.marketBids,
              marketAsks: marketAsks || poolKeys?.marketAsks,
              marketBaseVault: marketBaseVault || poolKeys?.marketBaseVault,
              marketQuoteVault: marketQuoteVault || poolKeys?.marketQuoteVault,
              marketAuthority: marketAuthority || poolKeys?.marketAuthority,
            } as any;
          }
        }
      }
    } catch {}

    const userKeys = {
      tokenAccountIn: toPublicKey(hop.userSourceAta),
      tokenAccountOut: toPublicKey(hop.userDestAta),
      owner: kp.publicKey,
    };

    // Normalize poolKeys shape to match Raydium SDK expectations (PublicKey fields only)
    try {
      const ensurePk = (v: any) => (v && typeof v === 'object' && typeof v.toBase58 === 'function') ? v : (v ? toPublicKey(v) : undefined);
      // Ensure mintLp is a PublicKey (not an object)
      const mintLpPk = ensurePk((poolKeys as any)?.mintLp?.address || (poolKeys as any)?.mintLp);
      (poolKeys as any).mintLp = mintLpPk;
      // Vaults must be { A: PublicKey, B: PublicKey }
      (poolKeys as any).vault = {
        A: ensurePk((poolKeys as any)?.vault?.A || (poolKeys as any)?.baseVault),
        B: ensurePk((poolKeys as any)?.vault?.B || (poolKeys as any)?.quoteVault),
      };
      // Coerce remaining PublicKey fields
      (poolKeys as any).id = ensurePk((poolKeys as any).id);
      (poolKeys as any).programId = ensurePk((poolKeys as any).programId);
      (poolKeys as any).authority = ensurePk((poolKeys as any).authority);
      (poolKeys as any).openOrders = ensurePk((poolKeys as any).openOrders);
      (poolKeys as any).targetOrders = ensurePk((poolKeys as any).targetOrders);
      (poolKeys as any).marketProgramId = ensurePk((poolKeys as any).marketProgramId);
      (poolKeys as any).marketId = ensurePk((poolKeys as any).marketId);
      (poolKeys as any).marketEventQueue = ensurePk((poolKeys as any).marketEventQueue);
      (poolKeys as any).marketBids = ensurePk((poolKeys as any).marketBids);
      (poolKeys as any).marketAsks = ensurePk((poolKeys as any).marketAsks);
      (poolKeys as any).marketBaseVault = ensurePk((poolKeys as any).marketBaseVault);
      (poolKeys as any).marketQuoteVault = ensurePk((poolKeys as any).marketQuoteVault);
      (poolKeys as any).marketAuthority = ensurePk((poolKeys as any).marketAuthority);
    } catch {}

    const BN = (await import('bn.js')).default as any;
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    const minOutBn = new BN(String(hop.minOutRaw ?? 0n));

    const ixInfo = (makeSwapFixedInInstruction as any)({
      poolKeys,
      userKeys,
      amountIn: amountInBn,
      minAmountOut: minOutBn,
    }, version);
    // Unwrap various Raydium SDK return shapes to actual TransactionInstructions
    const unwrapIxs = (val: any): TransactionInstruction[] => {
      try {
        if (!val) return [];
        // Direct TransactionInstruction
        if (val instanceof TransactionInstruction) return [val];
        // Common shapes: { instructions: TransactionInstruction[] }
        if (Array.isArray(val.instructions) && val.instructions.length) {
          return val.instructions.filter((x: any) => x instanceof TransactionInstruction);
        }
        // { innerTransaction: { instructions: TransactionInstruction[] } }
        if (val.innerTransaction && Array.isArray(val.innerTransaction.instructions)) {
          return val.innerTransaction.instructions.filter((x: any) => x instanceof TransactionInstruction);
        }
        // { innerTransactions: Array<{ instructions: TransactionInstruction[] }> }
        if (Array.isArray(val.innerTransactions) && val.innerTransactions.length) {
          const flat: any[] = [];
          for (const it of val.innerTransactions) {
            if (it && Array.isArray(it.instructions)) {
              flat.push(...it.instructions);
            }
          }
          return flat.filter((x: any) => x instanceof TransactionInstruction);
        }
      } catch {}
      return [];
    };

    const out = unwrapIxs(ixInfo);
    try { logger.info('ix.build raydium.amm.detail', { cat: 'tx', ctx: { got: Array.isArray(out) ? out.length : 0, shape: (ixInfo && typeof ixInfo === 'object' ? Object.keys(ixInfo) : String(typeof ixInfo)) } as any }); } catch {}
    if (out && out.length) return out;
    try { logger.warn('ix.build raydium.amm.real unexpected shape', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    throw new Error('RAYDIUM_AMM_BUILD_FAILED: bad_ix_shape');
  } catch (e) {
    try { logger.warn('ix.build raydium.amm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_AMM_BUILD_FAILED');
}


