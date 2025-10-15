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
    const BN = (await import('bn.js')).default as any;
    const { Percentage } = await import('@orca-so/common-sdk');
    const dummyWallet: any = { publicKey: kp.publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any[]) => txs };
    const programId = toPublicKey(hop.programId, (CONFIG.orca?.programId as any));
    const ctx = (WhirlpoolContext as any).from(connection as any, dummyWallet, programId);
    const client = (buildWhirlpoolClient as any)(ctx);
    const poolPk = toPublicKey(hop.poolId);
    const pool = await client.getPool(poolPk);
    const inputMint = toPublicKey(hop.inputMint);
    const bps = computeSlippageBps(hop.amountInRaw, hop.minOutRaw);
    const slippage = (Percentage as any).fromFraction(bps, 10000);
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    const quote = await (swapQuoteByInputToken as any)(pool, inputMint, amountInBn, slippage, ctx.program.programId, ctx.fetcher, true);
    const params = (SwapUtils as any).getSwapParamsFromQuote(quote);
    try { if (hop.sqrtPriceLimitX64 && params && ('sqrtPriceLimit' in (params as any))) { (params as any).sqrtPriceLimit = hop.sqrtPriceLimitX64; } } catch {}
    const txb = await pool.swap(params);
    const tx = (toTx as any)(ctx, txb);
    const built = await tx.build();
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
  try { logger.info('meteora.dlmm.build.start', { cat: 'tx', ctx: { poolId: hop.poolId, inputMint: hop.inputMint, outputMint: hop.outputMint, amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n) } }); } catch {}
  try {
    try { logger.info('meteora.dlmm.import.try', { cat: 'tx' }); } catch {}
    const dynamicImport = async (spec: string): Promise<any | null> => {
      try { return await (Function('return import')())(spec); } catch { return null; }
    };
    let mod: any = null;
    if (!mod) mod = await dynamicImport('@meteora-ag/dlmm-sdk');
    if (!mod) mod = await dynamicImport('@meteora-ag/dlmm');
    if (!mod) mod = await dynamicImport('@meteora-ag/dlmm-sdk/dist/index.js');
    if (!mod) {
      try {
        const makeReq = async (): Promise<any | undefined> => {
          const nodeModule = await dynamicImport('node:module');
          const base = nodeModule || await dynamicImport('module');
          const cr = (base && (base as any).createRequire) || (base && (base as any).default && (base as any).default.createRequire);
          return cr ? cr(import.meta.url) : undefined;
        };
        const req = await makeReq();
        if (req) {
          try { mod = req('@meteora-ag/dlmm-sdk'); } catch {}
          if (!mod) { try { mod = req('@meteora-ag/dlmm'); } catch {} }
          if (!mod) { try { mod = req('@meteora-ag/dlmm-sdk/dist/index.js'); } catch {} }
        }
      } catch {}
    }
    if (!mod) {
      try { logger.warn('meteora.dlmm.import.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: 'ALL_IMPORTS_FAILED' } }); } catch {}
    } else {
      try { logger.info('meteora.dlmm.import.ok', { cat: 'tx', ctx: { keys: Object.keys(mod || {}) } }); } catch {}
      const DLMMns: any = (mod && (mod as any).DLMM) ? (mod as any).DLMM : mod;
      const swapIxFn: any = (DLMMns && (DLMMns as any).swapIx) ? (DLMMns as any).swapIx : ((mod as any)?.swapIx);
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
        if (ix) { try { logger.info('meteora.dlmm.swapIx.ok', { cat: 'tx' }); } catch {}; return [ix]; }
        try { logger.warn('meteora.dlmm.swapIx.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
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
    if (norm.length) return norm as any[];
  } catch (e) {
    try { logger.warn('ix.build raydium.clmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_CLMM_BUILD_FAILED');
}

export async function buildRaydiumAmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build raydium.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    if ((hop.amountInRaw || 0n) <= 0n) {
      throw new Error('RAYDIUM_AMM_BUILD_FAILED: amount=0');
    }
    // Best-effort: derive missing market/program from on-chain pool state
    try {
      if (!hop.market || !hop.serumProgramId) {
        const connection = getConnection();
        const poolPk = toPublicKey(hop.poolId);
        const acc = await connection.getAccountInfo(poolPk);
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
    // Force programId to configured AMM program when not provided or ambiguous
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
      tokenAccountIn: toPublicKey(hop.userSourceAta),
      tokenAccountOut: toPublicKey(hop.userDestAta),
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

    const ixInfo = (makeSwapFixedInInstruction as any)({
      poolKeys,
      userKeys,
      amountIn: amountInBn,
      minAmountOut: minOutBn,
    }, version);
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
    if (norm.length) return norm;
    try { logger.warn('ix.build raydium.amm.real unexpected shape', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    throw new Error('RAYDIUM_AMM_BUILD_FAILED: bad_ix_shape');
  } catch (e) {
    try { logger.warn('ix.build raydium.amm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_AMM_BUILD_FAILED');
}


