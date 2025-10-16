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
  try { logger.debug('ix.build raydium.amm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'RaydiumAmmV4', type: 'raydium.amm.swap', keys: { poolId: hop.poolId, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, vaultA: hop.vaultA, vaultB: hop.vaultB }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}
export function buildRaydiumClmmSwapIx(hop: DirectHop): any[] {
  try { logger.debug('ix.build raydium.clmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'RaydiumClmm', type: 'raydium.clmm.swap', keys: { poolId: hop.poolId, tickArrayLower: hop.tickArrayLower, tickArrayCenter: hop.tickArrayCenter, tickArrayUpper: hop.tickArrayUpper, oracle: hop.oracle, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, vaultA: hop.vaultA, vaultB: hop.vaultB }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw, sqrtPriceLimitX64: hop.sqrtPriceLimitX64 || 0n } }];
}
export async function buildOrcaSwapIx(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build orca.clmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
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
    const params = (SwapUtils as any).getSwapParamsFromQuote(quote);
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
    return [{ programId: hop.programId || 'whirlpool', type: 'orca.clmm.swap', keys: { poolId: hop.poolId }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
  }
}
export function buildMeteoraDlmmSwapIx(hop: DirectHop): any[] {
  try { logger.debug('ix.build meteora.dlmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'meteoraDLMM', type: 'meteora.dlmm.swap', keys: { poolId: hop.poolId, binArrayLower: hop.binArrayLower, binArrayUpper: hop.binArrayUpper, reserveX: hop.reserveX, reserveY: hop.reserveY, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}

export async function buildMeteoraDlmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build meteora.dlmm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try { const dump = { kind: 'meteora.dlmm.build.start', hop }; (await import('../../utils/txTrace.js')).writeDexFullDump('meteora','preflight', dump).catch(()=>{}); } catch {}
  try { logger.info('meteora.dlmm.build.start', { cat: 'tx', ctx: { poolId: hop.poolId, inputMint: hop.inputMint, outputMint: hop.outputMint, amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n) } }); } catch {}
  try {
    try { logger.info('meteora.dlmm.import.try', { cat: 'tx' }); } catch {}
    let mod: any = null;
    try {
      const nodeModule: any = await import('node:module');
      const createRequire: any = (nodeModule && nodeModule.createRequire) || (nodeModule?.default && nodeModule.default.createRequire);
      const req: any = createRequire ? createRequire(import.meta.url) : undefined;
      if (req) {
        const specs: string[] = [
          '@meteora-ag/dlmm',
          '@meteora-ag/dlmm/ts-client',
          '@meteora-ag/dlmm-sdk',
          '@meteora-ag/dlmm-sdk-public',
          '@meteora-ag/dlmm/dist/index.js',
          '@meteora-ag/dlmm-sdk/dist/index.js',
        ];
        for (const spec of specs) {
          try {
            const m = req(spec);
            if (m) { mod = m; try { logger.info('meteora.dlmm.require.ok', { cat: 'tx', ctx: { spec, keys: Object.keys(m || {}) } }); } catch {}; break; }
          } catch (e: any) {
            try { logger.warn('meteora.dlmm.require.fail', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { spec, error: String(e?.message || e) } }); } catch {}
          }
        }
      }
    } catch {}
    if (!mod) {
      try { logger.warn('meteora.dlmm.import.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: 'ALL_IMPORTS_FAILED' } }); } catch {}
    } else {
      const dlmm: any = (mod && (mod as any).default) ? (mod as any).default : ((mod as any).DLMM || mod);
      const swapIxFn: any = (dlmm && typeof (dlmm as any).swapIx === 'function') ? (dlmm as any).swapIx : ((mod as any)?.swapIx);
      if (typeof swapIxFn === 'function') {
      const connection = getConnection();
      const kp = await ensureWallet(CONFIG.walletPath);
      const poolPk = toPublicKey(hop.poolId);
        const programId = toPublicKey(hop.programId as string, (CONFIG as any)?.meteora?.programId);
        try { logger.info('meteora.dlmm.params.prepare', { cat: 'tx', ctx: { pool: poolPk?.toBase58?.() || String(poolPk), programId: programId?.toBase58?.() || String(programId), userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, hasBinLower: !!hop.binArrayLower, hasBinUpper: !!hop.binArrayUpper } }); } catch {}
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
        const ix = await swapIxFn(connection, kp.publicKey, params);
        if (ix) { try { logger.info('meteora.dlmm.swapIx.ok', { cat: 'tx' }); } catch {}; try { (await import('../../utils/txTrace.js')).writeDexFullDump('meteora','preflight', { kind: 'meteora.dlmm.ix.ok', hop, params, ix }).catch(()=>{}); } catch {}; return [ix]; }
        try { logger.warn('meteora.dlmm.swapIx.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
      } else {
        // Fallback to ts-client pattern: create Anchor program and build swap ix
        try {
          const connection = getConnection();
          const kp = await ensureWallet(CONFIG.walletPath);
          const poolPk = toPublicKey(hop.poolId);
          const programId = toPublicKey(hop.programId as string, (CONFIG as any)?.meteora?.programId);
          const BN = (await import('bn.js')).default as any;
          const createProgram = (dlmm as any)?.createProgram || (mod as any)?.createProgram;
          if (!createProgram) throw new Error('DLMM_CREATE_PROGRAM_MISSING');
          const program = createProgram(connection, programId);
          try { logger.info('meteora.dlmm.program.ok', { cat: 'tx' }); } catch {}
          // Derive or use provided bin arrays/reserves when missing
          let binArrayLower = hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined;
          let binArrayUpper = hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined;
          let binArrayBitmapExtension: PublicKey | undefined = undefined;
          try {
            const helper = (dlmm as any)?.getBinArrayLowerUpperBinId || (dlmm as any)?.deriveBinArrayLowerUpperBinId;
            const deriveBinArray = (dlmm as any)?.deriveBinArray;
            const getTokensMintFromPoolAddress = (dlmm as any)?.getTokensMintFromPoolAddress;
            const deriveReserve = (dlmm as any)?.deriveReserve;
            const getTokenProgramId = (dlmm as any)?.getTokenProgramId;
            const deriveBinArrayBitmapExtension = (dlmm as any)?.deriveBinArrayBitmapExtension;
            // Optional enrichment: resolve token programs and reserves for accounts list
            try {
              const mints = getTokensMintFromPoolAddress ? await getTokensMintFromPoolAddress(connection, poolPk) : undefined;
              if (mints && getTokenProgramId) {
                await getTokenProgramId(connection, (mints as any).mintX || (mints as any).tokenXMint || hop.inputMint);
                await getTokenProgramId(connection, (mints as any).mintY || (mints as any).tokenYMint || hop.outputMint);
              }
            } catch {}
            if ((!binArrayLower || !binArrayUpper) && helper && deriveBinArray) {
              const res = await helper(connection, poolPk).catch(() => null as any);
              if (res && typeof res.lowerBinId === 'number' && typeof res.upperBinId === 'number') {
                try { const lowerPda = await deriveBinArray(programId, poolPk, res.lowerBinId); binArrayLower = lowerPda?.publicKey || lowerPda || binArrayLower; } catch {}
                try { const upperPda = await deriveBinArray(programId, poolPk, res.upperBinId); binArrayUpper = upperPda?.publicKey || upperPda || binArrayUpper; } catch {}
              }
            }
            // Derive reserves (optional, best-effort)
            try { if (deriveReserve) { await deriveReserve(programId, poolPk, true); await deriveReserve(programId, poolPk, false); } } catch {}
            // Derive bitmap extension
            try {
              if (deriveBinArrayBitmapExtension) {
                const ext = await deriveBinArrayBitmapExtension(programId, poolPk);
                binArrayBitmapExtension = (ext && (ext as any).publicKey) ? (ext as any).publicKey : ext;
              }
            } catch {}
            // Stash extension for later account mapping
            // (will attach to accounts.binArrayBitmapExtension if defined)
          } catch {}
          const amountIn = new BN(String(hop.amountInRaw ?? 0n));
          const minOut = new BN(String(hop.minOutRaw ?? 0n));
          // Attempt common Anchor method names
          const methods = (program as any)?.methods || {};
          let builder: any = null;
          if (typeof methods.swapExactIn === 'function') builder = methods.swapExactIn(amountIn, minOut);
          else if (typeof methods.swap === 'function') builder = methods.swap(amountIn, minOut);
          if (!builder) throw new Error('DLMM_SWAP_METHOD_MISSING');
          // Accounts: rely on program-side PDA derivations; include user accounts and pool
          const accounts: any = {
            lbPair: poolPk,
            user: kp.publicKey,
            userTokenIn: toPublicKey(hop.userSourceAta),
            userTokenOut: toPublicKey(hop.userDestAta),
          };
          if (binArrayLower) accounts.binArrayLower = binArrayLower;
          if (binArrayUpper) accounts.binArrayUpper = binArrayUpper;
          if (binArrayBitmapExtension) accounts.binArrayBitmapExtension = binArrayBitmapExtension;
          if (typeof builder.accounts === 'function') builder = builder.accounts(accounts);
          const ix = (typeof builder.instruction === 'function') ? await builder.instruction() : null;
          if (ix) { try { logger.info('meteora.dlmm.swap.ok', { cat: 'tx' }); } catch {}; return [ix]; }
        } catch (e: any) {
          try { logger.warn('meteora.dlmm.tsclient.fallback.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
    }
  } catch (e) {
    try { logger.warn('ix.build meteora.dlmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
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
    try { (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.clmm.build.start', hop }).catch(()=>{}); } catch {}
    const missing: string[] = [];
    if (!hop.inputMint) missing.push('inputMint');
    if (!hop.outputMint) missing.push('outputMint');
    if (!hop.userSourceAta) missing.push('userSourceAta');
    if (!hop.userDestAta) missing.push('userDestAta');
    if (!hop.tickArrayLower || !hop.tickArrayUpper) missing.push('tickArrayLower/Upper');
    if (!hop.oracle) missing.push('oracle');
    if (missing.length) throw new Error(`RAYDIUM_CLMM_BUILD_FAILED: missing ${missing.join(',')}`);

    const { ClmmInstrument } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const poolIdPk = toPublicKey(hop.poolId);
    const programIdPk = toPublicKey(hop.programId, (CONFIG.raydium?.clmmProgram as any));
    const observationIdPk = toPublicKey((CONFIG.raydium as any)?.clmmObservationId || PublicKey.default.toBase58());

    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: toPublicKey(hop.userSourceAta),
      tokenAccountB: toPublicKey(hop.userDestAta),
    };

    const poolInfo = { id: poolIdPk, programId: programIdPk, mintA: toPublicKey(hop.inputMint), mintB: toPublicKey(hop.outputMint), config: {} } as any;
    const poolKeys = {
      id: poolIdPk,
      programId: programIdPk,
      mintA: toPublicKey(hop.inputMint),
      mintB: toPublicKey(hop.outputMint),
      vault: { A: toPublicKey(hop.vaultA as any), B: toPublicKey(hop.vaultB as any) },
      authority: toPublicKey((CONFIG.raydium as any)?.clmmAuthority || PublicKey.default.toBase58()),
      observationId: observationIdPk,
      tickArrayLower: toPublicKey(hop.tickArrayLower as any),
      tickArrayUpper: toPublicKey(hop.tickArrayUpper as any),
    } as any;

    const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
      poolInfo,
      poolKeys,
      observationId: observationIdPk,
      ownerInfo,
      inputMint: toPublicKey(hop.inputMint),
      amountIn: hop.amountInRaw,
      amountOutMin: hop.minOutRaw,
      sqrtPriceLimitX64: hop.sqrtPriceLimitX64 ?? 0n,
      remainingAccounts: [],
    });
    try { (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.clmm.build.built', hop, poolKeys, ownerInfo, res }).catch(()=>{}); } catch {}

    const unwrap = (val: any): any[] => {
      try {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (Array.isArray(val.instructions)) return val.instructions;
        if (val.innerTransaction && Array.isArray(val.innerTransaction.instructions)) return val.innerTransaction.instructions;
        if (Array.isArray(val.innerTransactions)) {
          const flat: any[] = [];
          for (const it of val.innerTransactions) if (it && Array.isArray(it.instructions)) flat.push(...it.instructions);
          return flat;
        }
      } catch {}
      return [];
    };

    const toPk = (v: any): PublicKey => {
      try {
        if (v instanceof PublicKey) return v;
        const inner = (v && (v.address || v.pubkey || v.pubKey)) || v;
        if (inner instanceof PublicKey) return inner;
        if (inner && typeof inner.toBase58 === 'function') return new PublicKey(inner.toBase58());
        if (typeof inner === 'string') return new PublicKey(inner);
        return new PublicKey(String(inner));
      } catch {
        return new PublicKey(PublicKey.default.toBase58());
      }
    };

    const out = unwrap(res);
    const norm: TransactionInstruction[] = [];
    for (const it of out) {
      try {
        const pid = programIdPk;
        const keysLike: any = (it as any)?.keys;
        const keyArr: any[] = Array.isArray(keysLike) ? keysLike : (keysLike && typeof keysLike.length === 'number' ? Array.from(keysLike) : []);
        const keys = keyArr.map((k: any) => ({ pubkey: toPk(k?.pubkey ?? k?.pubKey ?? k?.address), isSigner: !!k?.isSigner, isWritable: !!k?.isWritable }));
        let data: Buffer = Buffer.alloc(0);
        const raw = (it as any)?.data;
        if (Buffer.isBuffer(raw)) data = raw as Buffer;
        else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(raw as any);
        else if (typeof raw === 'string') { try { data = Buffer.from(raw, 'base64'); } catch { data = Buffer.from([]); } }
        norm.push(new TransactionInstruction({ programId: pid, keys, data }));
      } catch {}
    }
    if (norm.length) { try { (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.clmm.build.norm', hop, count: norm.length }).catch(()=>{}); } catch {}; return norm as any[]; }
  } catch (e) {
    try { logger.warn('ix.build raydium.clmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_CLMM_BUILD_FAILED');
}

export async function buildRaydiumAmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build raydium.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    try { (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.amm.build.start', hop }).catch(()=>{}); } catch {}
    if ((hop.amountInRaw || 0n) <= 0n) {
      throw new Error('RAYDIUM_AMM_BUILD_FAILED: amount=0');
    }
    // Step 1: detect AMM version early (v4 vs v5 CPMM)
    const { getAssociatedPoolKeys, makeSwapFixedInInstruction } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    // Force programId to configured AMM program when not provided or ambiguous
    let programId = toPublicKey(hop.programId, (CONFIG.raydium?.ammV4Program as any));
    let version: 4 | 5 = resolveRaydiumAmmVersion(hop.programId);
    try {
      const conn = getConnection();
      const accInfo = await conn.getAccountInfo(toPublicKey(hop.poolId));
      if (accInfo?.data?.length) {
        const sdk: any = await import('@raydium-io/raydium-sdk-v2');
        const v5Layout = (sdk as any)?.LiquidityStateLayoutV5 || (sdk as any)?.liquidityStateV5Layout;
        const v4Layout = (sdk as any)?.LiquidityStateLayoutV4 || (sdk as any)?.liquidityStateV4Layout;
        try { if (v5Layout) { v5Layout.decode(accInfo.data); version = 5; } }
        catch { try { if (v4Layout) { v4Layout.decode(accInfo.data); version = 4; } } catch {} }
        if (version === 5) {
          try {
            const v5Pid = (CONFIG as any)?.raydium?.ammV5Program;
            if (v5Pid) programId = toPublicKey(v5Pid);
          } catch {}
        }
      }
    } catch {}

    // Step 2: derive market/program for v4 only (best-effort)
    try {
      if (version === 4 && (!hop.market || !hop.serumProgramId)) {
        const connection = getConnection();
        const poolPk = toPublicKey(hop.poolId);
        const acc = await connection.getAccountInfo(poolPk);
        if (acc?.data?.length) {
          const rmod: any = await import('@raydium-io/raydium-sdk-v2');
          const layouts = [
            (rmod as any)?.LiquidityStateLayoutV4,
            (rmod as any)?.liquidityStateV4Layout,
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

    // Step 3: validate required fields (version-aware)
    const missing: string[] = [];
    if (!hop.inputMint) missing.push('inputMint');
    if (!hop.outputMint) missing.push('outputMint');
    if (!hop.userSourceAta) missing.push('userSourceAta');
    if (!hop.userDestAta) missing.push('userDestAta');
    if (version === 4) {
      if (!hop.market) missing.push('market');
      if (!hop.serumProgramId) missing.push('serumProgramId');
      if (!Number.isFinite(Number(hop.inputDecimals))) missing.push('inputDecimals');
      if (!Number.isFinite(Number(hop.outputDecimals))) missing.push('outputDecimals');
    }
    if (missing.length) {
      throw new Error(`RAYDIUM_AMM_BUILD_FAILED: missing ${missing.join(',')} (version=${version})`);
    }

    const marketId = version === 4 ? toPublicKey(hop.market) : undefined as any;
    const marketProgramId = version === 4 ? toPublicKey(hop.serumProgramId) : undefined as any;

    // Determine true base/quote from pool state when possible
    let baseMintPk: PublicKey | undefined;
    let quoteMintPk: PublicKey | undefined;
    try {
      const acc = await getConnection().getAccountInfo(toPublicKey(hop.poolId));
      if (acc?.data?.length) {
        const sdk: any = await import('@raydium-io/raydium-sdk-v2');
        const layout = version === 5
          ? ((sdk as any)?.LiquidityStateLayoutV5 || (sdk as any)?.liquidityStateV5Layout)
          : ((sdk as any)?.LiquidityStateLayoutV4 || (sdk as any)?.liquidityStateV4Layout);
        try {
          const st = layout.decode(acc.data);
          const asPk = (v: any) => (v?.toBase58 ? v : (v ? toPublicKey(v) : undefined));
          baseMintPk = asPk(st.baseMint || st.coinMint || st.mintA);
          quoteMintPk = asPk(st.quoteMint || st.pcMint || st.mintB);
        } catch {}
      }
    } catch {}

    const inputMintPk = toPublicKey(hop.inputMint);
    const outputMintPk = toPublicKey(hop.outputMint);
    const baseMint = baseMintPk || inputMintPk;
    const quoteMint = quoteMintPk || outputMintPk;
    const inputIsBase = inputMintPk.toBase58() === baseMint.toBase58();
    const baseDecimals = inputIsBase ? Number(hop.inputDecimals) : Number(hop.outputDecimals);
    const quoteDecimals = inputIsBase ? Number(hop.outputDecimals) : Number(hop.inputDecimals);

    // Build pool keys
    let poolKeys: any;
    if (version === 4) {
      poolKeys = (getAssociatedPoolKeys as any)({
        version,
        marketVersion: 3,
        marketId,
        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,
        programId,
        marketProgramId,
      });
    } else {
      // Minimal skeleton for CPMM; we'll enrich from on-chain state next
      poolKeys = {
        id: toPublicKey(hop.poolId),
        programId,
        mintA: baseMint,
        mintB: quoteMint,
      } as any;
    }

    // If SDK helper didn't populate vaults/auth/market keys (mint order or decimals mismatch),
    // derive them from on-chain AMM state (V4/V5).
    try {
      const needVaults = !poolKeys?.vault?.A || !poolKeys?.vault?.B;
      const needMarket = !poolKeys?.marketProgramId || !poolKeys?.marketId;
      const needAuth = !poolKeys?.authority;
      if (needVaults || needMarket || needAuth) {
        const connection = getConnection();
        const acc = await connection.getAccountInfo(toPublicKey(hop.poolId));
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
      tokenAccountIn: inputIsBase ? toPublicKey(hop.userSourceAta) : toPublicKey(hop.userDestAta),
      tokenAccountOut: inputIsBase ? toPublicKey(hop.userDestAta) : toPublicKey(hop.userSourceAta),
      owner: kp.publicKey,
    };

    // Normalize poolKeys shape to match Raydium SDK expectations (PublicKey fields only) and enforce programId
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
      (poolKeys as any).programId = programId; // enforce configured program id
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

    let ixInfo: any = null;
    if (version === 5) {
      // Try CPMM-specific builders in raydium-sdk-v2 (robust multi-name resolution)
      try {
        const sdkMod: any = await import('@raydium-io/raydium-sdk-v2');
        const sdkAny: any = (sdkMod && (sdkMod as any).default) ? (sdkMod as any).default : sdkMod;
        try {
          const keys = Object.keys(sdkAny || {});
          const present = { Cpmm: !!(sdkAny as any)?.Cpmm, LiquidityV5: !!(sdkAny as any)?.LiquidityV5, Liquidity: !!(sdkAny as any)?.Liquidity } as any;
          const pk = (v: any) => { try { return v && typeof v.toBase58 === 'function' ? v.toBase58() : (typeof v === 'string' ? v : undefined); } catch { return undefined; } };
          const diagPool = { id: pk((poolKeys as any)?.id), programId: pk((poolKeys as any)?.programId), hasVaultA: !!((poolKeys as any)?.vault?.A), hasVaultB: !!((poolKeys as any)?.vault?.B), hasAuthority: !!((poolKeys as any)?.authority) } as any;
          const diagUser = { in: pk((userKeys as any)?.tokenAccountIn), out: pk((userKeys as any)?.tokenAccountOut) } as any;
          logger.info('raydium.amm.cpmm.sdk.keys', { cat: 'tx', ctx: { keys: keys.slice(0, 60), present, pool: diagPool, user: diagUser } as any });
        } catch {}
        const candidates: Array<{ name: string; fn: any }> = [
          { name: 'Cpmm.makeSwapFixedInInstruction', fn: (sdkAny as any)?.Cpmm?.makeSwapFixedInInstruction },
          { name: 'Cpmm.makeSwapBaseInInstructions', fn: (sdkAny as any)?.Cpmm?.makeSwapBaseInInstructions },
          { name: 'LiquidityV5.makeSwapFixedInInstruction', fn: (sdkAny as any)?.LiquidityV5?.makeSwapFixedInInstruction },
          { name: 'Liquidity.makeSwapFixedInInstructionV5', fn: ((sdkAny as any)?.Liquidity as any)?.makeSwapFixedInInstructionV5 },
        ].filter((c) => typeof c.fn === 'function');
        try { logger.info('raydium.amm.cpmm.builder.candidates', { cat: 'tx', ctx: { count: candidates.length, names: candidates.map(c => c.name) } as any }); } catch {}
        let firstErr: string | null = null;
        for (const cand of candidates) {
          try {
            try { logger.info('raydium.amm.cpmm.builder.try', { cat: 'tx', ctx: { fn: cand.name } as any }); } catch {}
            ixInfo = cand.fn({ poolKeys, userKeys, amountIn: amountInBn, minAmountOut: minOutBn });
            if (ixInfo) { try { logger.info('raydium.amm.cpmm.builder.ok', { cat: 'tx', ctx: { fn: cand.name } as any }); } catch {}; break; }
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!firstErr) firstErr = msg;
            try { logger.warn('raydium.amm.cpmm.builder.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { fn: cand.name, error: msg } as any }); } catch {}
          }
        }
        // Fallback: use generic Liquidity builder with version=5 if Cpmm-specific ones are missing
        if (!ixInfo) {
          try {
            try { logger.info('raydium.amm.cpmm.builder.fallback.genericV5', { cat: 'tx' }); } catch {}
            const genericRes = (makeSwapFixedInInstruction as any)({
              poolKeys,
              userKeys,
              amountIn: amountInBn,
              minAmountOut: minOutBn,
            }, 5);
            if (genericRes) ixInfo = genericRes;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!firstErr) firstErr = msg;
            try { logger.warn('raydium.amm.cpmm.builder.fallback.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: msg } as any }); } catch {}
          }
        }
        if (!ixInfo) throw new Error(`CPMM_SWAP_BUILDER_MISSING${firstErr ? ':' + firstErr : ''}`);
      } catch {}
    } else {
      ixInfo = (makeSwapFixedInInstruction as any)({
      poolKeys,
      userKeys,
      amountIn: amountInBn,
      minAmountOut: minOutBn,
    }, version);
    }
    // Unwrap and normalize various Raydium SDK return shapes to actual TransactionInstructions
    const unwrapIxs = (val: any): any[] => {
      try {
        if (!val) return [];
        // Direct TransactionInstruction
        if (val instanceof TransactionInstruction) return [val];
        // Treat plain TI-shaped objects as a single instruction
        if (val && typeof val === 'object' && (val as any).programId && ((Array.isArray((val as any).keys)) || (typeof (val as any).keys?.length === 'number'))) {
          return [val];
        }
        // Common shapes: { instructions: TransactionInstruction[] }
        if (Array.isArray(val.instructions) && val.instructions.length) {
          return val.instructions;
        }
        // { innerTransaction: { instructions: TransactionInstruction[] } }
        if (val.innerTransaction && Array.isArray(val.innerTransaction.instructions)) {
          return val.innerTransaction.instructions;
        }
        // { innerTransactions: Array<{ instructions: TransactionInstruction[] }> }
        if (Array.isArray(val.innerTransactions) && val.innerTransactions.length) {
          const flat: any[] = [];
          for (const it of val.innerTransactions) {
            if (it && Array.isArray(it.instructions)) {
              flat.push(...it.instructions);
            }
          }
          return flat;
        }
      } catch {}
      return [];
    };

    const rawOut = unwrapIxs(ixInfo);
    try { logger.info('ix.build raydium.amm.detail', { cat: 'tx', ctx: { got: Array.isArray(rawOut) ? rawOut.length : 0, shape: (ixInfo && typeof ixInfo === 'object' ? Object.keys(ixInfo) : String(typeof ixInfo)) } as any }); } catch {}
    try { (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.amm.build.ixInfo', hop, poolKeys, userKeys, ixInfo }).catch(()=>{}); } catch {}
    const toPk = (v: any): PublicKey => {
      try {
        if (v instanceof PublicKey) return v;
        const inner = (v && (v.address || v.pubkey || v.pubKey)) || v;
        if (inner instanceof PublicKey) return inner;
        if (inner && typeof inner.toBase58 === 'function') return new PublicKey(inner.toBase58());
        if (typeof inner === 'string') return new PublicKey(inner);
        return new PublicKey(String(inner));
      } catch {
        // Fallback to invalid key to surface error clearly later
        return new PublicKey(PublicKey.default.toBase58());
      }
    };
    const norm: TransactionInstruction[] = [];
    for (const it of (rawOut || [])) {
      try {
        const pid = programId;
        const keysLike: any = (it as any)?.keys;
        const keyArr: any[] = Array.isArray(keysLike) ? keysLike : (keysLike && typeof keysLike.length === 'number' ? Array.from(keysLike) : []);
        const keys = keyArr.map((k: any) => ({ pubkey: toPk(k?.pubkey ?? k?.pubKey ?? k?.address), isSigner: !!k?.isSigner, isWritable: !!k?.isWritable }));
        let data: Buffer = Buffer.alloc(0);
        const raw = (it as any)?.data;
        if (Buffer.isBuffer(raw)) data = raw as Buffer;
        else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(raw as any);
        else if (typeof raw === 'string') { try { data = Buffer.from(raw, 'base64'); } catch { data = Buffer.from([]); } }
        norm.push(new TransactionInstruction({ programId: pid, keys, data }));
      } catch {}
    }
    if (norm.length) {
      try {
       const ixDataPrefix = norm.map(ix => ((ix as any)?.data && Buffer.isBuffer((ix as any).data)) ? ((ix as any).data as Buffer).subarray(0,8).toString() : '');
        (await import('../../utils/txTrace.js')).writeDexFullDump('raydium','preflight', { kind: 'raydium.amm.build.norm', hop, version, programId: (programId as any)?.toBase58?.() || String(programId), count: norm.length, ixDataPrefix, poolKeys, userKeys }).catch(()=>{});
      } catch {}
      return norm;
    }
    try { logger.warn('ix.build raydium.amm.real unexpected shape', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    throw new Error('RAYDIUM_AMM_BUILD_FAILED: bad_ix_shape');
  } catch (e) {
    try { logger.warn('ix.build raydium.amm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_AMM_BUILD_FAILED');
}


