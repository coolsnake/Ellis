import type { DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { normalizePublicKey, isValidPublicKey, coerceToPublicKey, sanitizeKeyString } from './utils.js';
import { validateHopAmounts, validatePublicKey, validatePoolAccounts } from './validation.js';
import { createBuilderError, wrapBuilderError, logAndThrow } from './errors.js';

// Legacy helper for backward compatibility - use coerceToPublicKey from utils.js instead
function toPublicKey(value: any, fallback?: any): PublicKey {
  try {
    return coerceToPublicKey(value, fallback);
  } catch {
    throw new Error('Non-base58 character');
  }
}

// Utility function to inject bin array account metas into an instruction
async function injectBinArrayMetas(
  ix: any,
  DLMM: any,
  connection: any,
  poolPk: PublicKey,
  programId: PublicKey
): Promise<number> {
  try {
    let metas: any[] | undefined = undefined;
    
    // Try primary method: getBinArrayAccountMetasCoverage with bounds
    try {
      const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId;
      const getMetas = (DLMM as any)?.getBinArrayAccountMetasCoverage;
      if (getBounds && getMetas) {
        const bnjs = await import('bn.js').catch(() => null as any);
        const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
        const bounds = await getBounds(connection, poolPk).catch(() => null as any);
        const toNum = (v: any): number => {
          try {
            if (v && typeof v.toNumber === 'function') return v.toNumber();
            const s = (v && typeof v.toString === 'function') ? v.toString() : String(v);
            const n = Number(s);
            return Number.isFinite(n) ? n : NaN;
          } catch {
            return NaN;
          }
        };
        const loNum = toNum(bounds?.lowerBinId);
        const hiNum = toNum(bounds?.upperBinId);
        if (Number.isFinite(loNum) && Number.isFinite(hiNum) && BN) {
          metas = getMetas(new BN(String(loNum)), new BN(String(hiNum)), poolPk, programId) || [];
        }
      }
    } catch (e: any) {
      try { logger.debug('meteora.dlmm.inject.bounds.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
    }
    
    // Fallback: try generic coverage helper
    if (!metas || !metas.length) {
      try {
        const getCoverage = (DLMM as any)?.getBinArrayKeysCoverage || (DLMM as any)?.getBinArrayAccountMetasCoverage;
        if (getCoverage) {
          const cov = await getCoverage(programId, poolPk).catch(() => null as any) 
            || await getCoverage(connection, programId, poolPk).catch(() => null as any) 
            || await getCoverage({ programId, lbPair: poolPk }).catch(() => null as any);
          metas = (cov && ((cov as any).metas || (cov as any).accountMetas)) || (Array.isArray(cov) ? cov : []);
        }
      } catch (e: any) {
        try { logger.debug('meteora.dlmm.inject.coverage.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
      }
    }
    
    // Inject metas into instruction
    if (Array.isArray(metas) && metas.length && Array.isArray((ix as any).keys)) {
      const existing = new Set<string>();
      try {
        for (const k of (ix as any).keys as any[]) {
          const s = (k?.pubkey && typeof k.pubkey.toBase58 === 'function') ? k.pubkey.toBase58() : String(k?.pubkey);
          if (s) existing.add(s);
        }
      } catch (e: any) {
        try { logger.debug('meteora.dlmm.inject.existing.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
      }
      
      let injected = 0;
      for (const m of metas) {
        try {
          const pk = (m?.pubkey && typeof m.pubkey.toBase58 === 'function') 
            ? m.pubkey 
            : new PublicKey(String(m?.pubkey));
          const s = (pk && typeof pk.toBase58 === 'function') ? pk.toBase58() : undefined;
          if (s && !existing.has(s)) {
            (ix as any).keys.push({ pubkey: pk, isWritable: !!m?.isWritable, isSigner: !!m?.isSigner });
            existing.add(s);
            injected += 1;
          }
        } catch (e: any) {
          try { logger.debug('meteora.dlmm.inject.meta.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      if (injected > 0) {
        try { logger.info('meteora.dlmm.remaining.inject', { cat: 'tx', ctx: { added: injected } as any }); } catch {}
      }
      return injected;
    }
  } catch (e: any) {
    try { logger.warn('meteora.dlmm.inject.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
  }
  return 0;
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
    const poolAddr = String(hop.poolId);
    const inputMint = String(hop.inputMint);
    
    // Pre-build validation: amounts
    validateHopAmounts(hop, { dex: 'orca', variant: 'clmm', poolId: hop.poolId });
    
    // Precheck: ensure pool contains input mint to avoid zero-out quotes
    try {
      const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
      if (sdkAny && hop.poolId && hop.inputMint) {
        const { PublicKey } = await import('@solana/web3.js');
        const pk = new PublicKey(String(hop.poolId));
        const acc = await connection.getAccountInfo(pk);
        const ParsableWhirlpool = (sdkAny as any).ParsableWhirlpool;
        const parsed = acc ? (ParsableWhirlpool as any).parse(pk, acc) : null;
        if (parsed) {
          const mintA = parsed.tokenMintA?.toBase58?.();
          const mintB = parsed.tokenMintB?.toBase58?.();
          const inMint = String(hop.inputMint);
          try { logger.info('orca.whirlpool.pool.tokens', { cat: 'tx', ctx: { pool: String(hop.poolId), mintA, mintB, inputMint: inMint } }); } catch {}
          if (inMint !== mintA && inMint !== mintB) {
            try { logger.warn('orca.whirlpool.input_mint_mismatch', { cat: 'tx', ctx: { pool: String(hop.poolId), inputMint: inMint, mintA, mintB } }); } catch {}
            throw createBuilderError('ORCA', 'input mint does not match pool tokens', hop);
          }
        }
      }
    } catch (preErr) {
      if (preErr instanceof Error && preErr.message.includes('ORCA_BUILD_FAILED')) {
        throw preErr;
      }
      // Log but continue - pool validation is best-effort
      try { logger.warn('orca.whirlpool.pool.precheck.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String((preErr as any)?.message || preErr) } }); } catch {}
    }
    
    // Use context-based SDK approach instead of global state
    try {
      const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
      const { Percentage } = await import('@orca-so/common-sdk');
      const { PublicKey } = await import('@solana/web3.js');
      const BN = (await import('bn.js')).default as any;
      
      const programId = new PublicKey((CONFIG as any).orca.programId);
      
      // Create context per operation (no global state)
      const ctx = (WhirlpoolContext as any).from(connection, { publicKey: kp.publicKey }, programId);
      const client = (buildWhirlpoolClient as any)(ctx);
      const pool = await client.getPool(new PublicKey(poolAddr));
      
      // Calculate slippage from minOutRaw directly
      // If minOutRaw is provided, calculate slippage BPS from it
      // Otherwise use default 1% (100 bps)
      let slippageBps = 100; // Default 1%
      if (hop.minOutRaw && hop.minOutRaw > 0n && hop.amountInRaw && hop.amountInRaw > 0n) {
        const ratio = Number(hop.minOutRaw) / Number(hop.amountInRaw);
        slippageBps = Math.max(0, Math.min(9900, Math.round((1 - ratio) * 10000)));
      }
      
      const slippage = (Percentage as any).fromFraction(slippageBps, 10_000);
      const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
      
      try { logger.info('orca.whirlpool.quote', { cat: 'tx', ctx: { pool: poolAddr, inputMint, amountIn: String(hop.amountInRaw ?? 0n), slippageBps } }); } catch {}
      
      // Primary path: use swapQuoteByInputToken
      const quote = await (swapQuoteByInputToken as any)(
        pool,
        new PublicKey(inputMint),
        amountInBn,
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        true
      );
      
      if (!quote) {
        throw createBuilderError('ORCA', 'quote returned null', hop);
      }
      
      const estimatedOut = BigInt((quote as any)?.otherAmount ?? (quote as any)?.estimatedAmountOut ?? 0);
      
      // Guard: trade not enabled yet
      const tradeTs: any = (quote as any)?.tradeEnableTimestamp;
      if (typeof tradeTs === 'bigint') {
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        try { logger.info('orca.whirlpool.trade.ts', { cat: 'tx', ctx: { tradeEnableTimestamp: tradeTs.toString() } as any }); } catch {}
        if (tradeTs > nowSec) {
          throw createBuilderError('ORCA', `trade disabled until ${tradeTs.toString()}`, hop);
        }
      }
      
      // Guard: zero estimated out
      if (estimatedOut === 0n) {
        throw createBuilderError('ORCA', 'quote returned zero output amount', hop);
      }
      
      try { logger.info('orca.whirlpool.quote.ok', { cat: 'tx', ctx: { estimatedOutRaw: estimatedOut.toString() } as any }); } catch {}
      
      // Build swap instruction from quote
      // Try multiple SDK API patterns for building swap instruction
      let swapIx: any = null;
      
      // Pattern 1: pool.swap(quote) - newer SDK versions
      if (typeof (pool as any).swap === 'function') {
        try {
          swapIx = await (pool as any).swap(quote);
        } catch (e: any) {
          try { logger.warn('orca.whirlpool.swap.method.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      // Pattern 2: pool.swapIx(quote) - alternative pattern
      if (!swapIx && typeof (pool as any).swapIx === 'function') {
        try {
          swapIx = await (pool as any).swapIx(quote);
        } catch (e: any) {
          try { logger.warn('orca.whirlpool.swapIx.method.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      // Pattern 3: buildSwapInstruction from SDK - explicit builder
      if (!swapIx) {
        try {
          const { buildSwapInstruction } = await import('@orca-so/whirlpools-sdk');
          if (typeof buildSwapInstruction === 'function') {
            swapIx = await (buildSwapInstruction as any)(pool, quote, kp.publicKey);
          }
        } catch (e: any) {
          try { logger.warn('orca.whirlpool.buildSwapInstruction.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      // Pattern 4: Use quote to build instruction manually via pool methods
      if (!swapIx && typeof (pool as any).buildSwapInstruction === 'function') {
        try {
          swapIx = await (pool as any).buildSwapInstruction(quote);
        } catch (e: any) {
          try { logger.warn('orca.whirlpool.buildSwapInstruction.method.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      if (!swapIx) {
        throw createBuilderError('ORCA', 'unable to build swap instruction from quote - no compatible SDK method found', hop);
      }
      
      // Normalize instruction format
      const normalizeIx = (ix: any): any => {
        try {
          const programId = ix?.programId || ix?.programAddress || (ix?.program && (ix.program.address || ix.program)) || '';
          const accounts = Array.isArray(ix?.accounts) ? ix.accounts : (Array.isArray(ix?.keys) ? ix.keys : []);
          const keys = accounts.map((a: any) => ({
            pubkey: a?.address || a?.pubkey || a?.pubKey || a?.pubKeyAddress || a?.pubkeyAddress,
            isSigner: !!a?.isSigner,
            isWritable: !!a?.isWritable,
          }));
          const data = ix?.data || new Uint8Array();
          return { programId, keys, data };
        } catch {
          return ix;
        }
      };
      
      const out = Array.isArray(swapIx) ? swapIx.map(normalizeIx) : [normalizeIx(swapIx)];
      try { logger.info('orca.whirlpool.ix.ready', { cat: 'tx', ctx: { count: Array.isArray(out) ? out.length : 0 } as any }); } catch {}
      return out;
    } catch (inner) {
      // Wrap errors with context
      if (inner instanceof Error && inner.message.includes('ORCA_BUILD_FAILED')) {
        logAndThrow(inner);
      }
      wrapBuilderError(inner, 'ORCA', 'build failed', hop);
    }
  } catch (e) {
    // Wrap outer errors
    if (e instanceof Error && e.message.includes('ORCA_BUILD_FAILED')) {
      logAndThrow(e);
    }
    wrapBuilderError(e, 'ORCA', 'build failed', hop);
  }
}
export function buildMeteoraDlmmSwapIx(hop: DirectHop): any[] {
  try { logger.debug('ix.build meteora.dlmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'meteoraDLMM', type: 'meteora.dlmm.swap', keys: { poolId: hop.poolId, binArrayLower: hop.binArrayLower, binArrayUpper: hop.binArrayUpper, reserveX: hop.reserveX, reserveY: hop.reserveY, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}

export async function buildMeteoraDlmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build meteora.dlmm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  
  // Pre-build validation: amounts
  validateHopAmounts(hop, { dex: 'meteora', variant: 'dlmm', poolId: hop.poolId });
  
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const poolPk = toPublicKey(hop.poolId);
  const programId = toPublicKey(hop.programId as string, (CONFIG as any)?.meteora?.programId);
  try { logger.info('meteora.dlmm.build.start', { cat: 'tx', ctx: { pool: poolPk?.toBase58?.() || String(poolPk), programId: programId?.toBase58?.() || String(programId), amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n) } as any }); } catch {}

  // Standardized SDK import: prefer ESM dynamic import, cache module
  // Module-level cache to avoid repeated imports
  let mod: any = (buildMeteoraDlmmSwapIxReal as any).__dlmmMod || null;
  
  if (!mod) {
    // Primary: ESM dynamic import (recommended for modern Node.js)
    const specs = [
      '@meteora-ag/dlmm',
      '@meteora-ag/dlmm-sdk',
    ];
    
    for (const spec of specs) {
      try {
        mod = await import(spec);
        if (mod) {
          try { logger.info('meteora.dlmm.import.ok', { cat: 'tx', ctx: { spec, keys: Object.keys(mod || {}) } }); } catch {}
          // Cache the module
          (buildMeteoraDlmmSwapIxReal as any).__dlmmMod = mod;
          break;
        }
      } catch (e: any) {
        try { logger.warn('meteora.dlmm.import.fail', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { spec, error: String(e?.message || e) } }); } catch {}
      }
    }
    
    // Fallback: try ts-client specifically if main imports failed
    if (!mod) {
      try {
        // Dynamic import may fail if ts-client path doesn't exist - that's ok
        // @ts-expect-error - ts-client path may not exist, handled by catch
        mod = await import('@meteora-ag/dlmm/ts-client').catch(() => null);
        if (mod) {
          try { logger.info('meteora.dlmm.import.ok', { cat: 'tx', ctx: { spec: '@meteora-ag/dlmm/ts-client' } }); } catch {}
          (buildMeteoraDlmmSwapIxReal as any).__dlmmMod = mod;
        }
      } catch (e: any) {
        try { logger.warn('meteora.dlmm.import.fail', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { spec: '@meteora-ag/dlmm/ts-client', error: String(e?.message || e) } }); } catch {}
      }
    }
  }

  if (!mod) {
    try { logger.error('meteora.dlmm.import.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: 'ALL_IMPORTS_FAILED' } }); } catch {}
    throw createBuilderError('METEORA_DLMM', 'failed to load SDK module', hop);
  }

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
      if (ix) {
        // Safety net: attempt to attach remaining bin-array metas when using fast-path ix
        await injectBinArrayMetas(ix, DLMM, connection, poolPk, programId);
        try { logger.info('meteora.dlmm.swapIx.ok', { cat: 'tx' }); } catch {}
        return [ix];
      }
    }
  } catch (e: any) {
    try { logger.warn('meteora.dlmm.swapIx.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
    // Continue to fallback path
  }

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
        const toNum = (v: any): number => {
          try {
            if (v && typeof v.toNumber === 'function') return v.toNumber();
            if (typeof v === 'bigint') return Number(v);
            if (typeof v === 'number') return v;
            const s = (v && typeof v.toString === 'function') ? v.toString() : String(v);
            const n = Number(s);
            return Number.isFinite(n) ? n : NaN;
          } catch { return NaN; }
        };
        const loNum = toNum(bounds?.lowerBinId);
        const hiNum = toNum(bounds?.upperBinId);
        if (Number.isFinite(loNum)) { try { const lo = await deriveBinArray(programId, poolPk, loNum); binArrayLower = (lo as any)?.publicKey || lo || binArrayLower; } catch {} }
        if (Number.isFinite(hiNum)) { try { const hi = await deriveBinArray(programId, poolPk, hiNum); binArrayUpper = (hi as any)?.publicKey || hi || binArrayUpper; } catch {} }
      }
      try {
        // Derive bitmap extension PDA - reduced to essential attempts only
        const coercePk = (val: any): PublicKey | undefined => {
          try {
            if (!val) return undefined;
            if (val instanceof PublicKey) return val;
            if ((val as any)?.publicKey instanceof PublicKey) return (val as any).publicKey as PublicKey;
            if ((val as any)?.address instanceof PublicKey) return (val as any).address as PublicKey;
            if (typeof (val as any)?.toBase58 === 'function') return val as PublicKey;
            if (typeof val === 'string') return new PublicKey(val);
            if ((val as any)?.publicKey && typeof (val as any).publicKey === 'string') return new PublicKey((val as any).publicKey);
            if ((val as any)?.address && typeof (val as any).address === 'string') return new PublicKey((val as any).address);
          } catch (e: any) {
            try { logger.debug('meteora.dlmm.coercePk.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
          }
          return undefined;
        };
        
        // Essential attempts only (reduced from 10+ to 3)
        const attempts: Array<() => Promise<any>> = [];
        
        // Attempt 1: Most common pattern - deriveBinArrayBitmapExtension(programId, poolPk)
        if (deriveBinArrayBitmapExtension) {
          attempts.push(() => deriveBinArrayBitmapExtension(programId, poolPk));
        }
        
        // Attempt 2: Coverage helper - getBinArrayKeysCoverage
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
        }
        
        // Attempt 3: Last resort - compute PDA via common seed
        attempts.push(async () => {
          try {
            const seedCandidates = ['bin_array_bitmap_extension', 'binarray_bitmap_extension'];
            for (const seed of seedCandidates) {
              try {
                const [addr] = await (PublicKey as any).findProgramAddress([
                  Buffer.from(seed),
                  poolPk.toBuffer(),
                ], programId);
                if (addr) return addr;
              } catch (e: any) {
                try { logger.debug('meteora.dlmm.pda.failed', { cat: 'tx', ctx: { seed, error: String(e?.message || e) } }); } catch {}
              }
            }
          } catch {}
          return undefined;
        });
        
        for (const fn of attempts) {
          try {
            const val = await fn();
            const pk = coercePk(val);
            if (pk) {
              binArrayBitmapExtension = pk;
              try { logger.info('meteora.dlmm.derive.ext.ok', { cat: 'tx', ctx: { ext: binArrayBitmapExtension?.toBase58?.() } as any }); } catch {}
              break;
            }
          } catch (e: any) {
            try { logger.debug('meteora.dlmm.bitmap.attempt.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
          }
        }
      } catch (e: any) {
        try { logger.warn('meteora.dlmm.bitmap.derive.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
        // Continue without bitmap extension - it may be optional
      }
    } catch {}

    const BN = (await import('bn.js')).default as any;
    const amountIn = new BN(String(hop.amountInRaw ?? 0n));
    const minOut = new BN(String(hop.minOutRaw ?? 0n));
    const methods = (program as any)?.methods || {};
    const setupIxs: TransactionInstruction[] = [];
    let builder: any = null;

    const accounts: any = {
      lbPair: poolPk,
      user: kp.publicKey,
      userTokenIn: toPublicKey(hop.userSourceAta),
      userTokenOut: toPublicKey(hop.userDestAta),
    };
    if (binArrayLower) accounts.binArrayLower = binArrayLower;
    if (binArrayUpper) accounts.binArrayUpper = binArrayUpper;
    // Always include the bitmap extension PDA if derived; program can create/verify it
    try {
      if (binArrayBitmapExtension) {
        accounts.binArrayBitmapExtension = binArrayBitmapExtension;
        // Observability only; do not gate on presence/owner
        let needsBitmapExtensionInit = false;
        try {
          const acc = await connection.getAccountInfo(binArrayBitmapExtension);
          if (!acc) {
            needsBitmapExtensionInit = true;
            try { logger.warn('meteora.dlmm.ext.missing_on_chain', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { expected: programId?.toBase58?.() } }); } catch {}
          } else if (acc.owner && typeof acc.owner.equals === 'function' && !acc.owner.equals(programId)) {
            try { logger.warn('meteora.dlmm.ext.owner_mismatch', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { owner: acc.owner?.toBase58?.(), expected: programId?.toBase58?.() } }); } catch {}
          }
        } catch {}

        // Best-effort: if extension missing, try to prepend an updateBinArray ix to initialize it
        try {
          if (needsBitmapExtensionInit) {
            try { logger.info('meteora.dlmm.bitmap_ext.init.start', { cat: 'tx' }); } catch {}
            const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId || (DLMM as any)?.deriveBinArrayLowerUpperBinId;
            const getCoverage = (DLMM as any)?.getBinArrayAccountMetasCoverage || (DLMM as any)?.getBinArrayKeysCoverage;
            const bounds = getBounds ? await getBounds(connection, poolPk).catch(() => null as any) : null;
            const bnjs = await import('bn.js').catch(() => null as any);
            const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
            const toNum = (v: any): number => { try { if (v && typeof v.toNumber === 'function') return v.toNumber(); const s = (v && typeof v.toString === 'function') ? v.toString() : String(v); const n = Number(s); return Number.isFinite(n) ? n : NaN; } catch { return NaN; } };
            const loNum = toNum(bounds?.lowerBinId);
            const hiNum = toNum(bounds?.upperBinId);

            let updBuilder: any = null;
            // Try multiple signatures across SDK variants
            try { if (typeof (methods as any)?.updateBinArray === 'function') updBuilder = (methods as any).updateBinArray(); } catch {}
            try { if (!updBuilder && typeof (methods as any)?.updateBinArray === 'function' && Number.isFinite(loNum) && Number.isFinite(hiNum) && BN) updBuilder = (methods as any).updateBinArray(new BN(String(loNum)), new BN(String(hiNum))); } catch {}
            try { if (!updBuilder && typeof (methods as any)?.updateBinArray === 'function' && Number.isFinite(loNum) && Number.isFinite(hiNum)) updBuilder = (methods as any).updateBinArray(loNum, hiNum); } catch {}

            if (updBuilder) {
              // Supply accounts and metas if possible
              try { if (typeof updBuilder.accountsPartial === 'function') updBuilder = updBuilder.accountsPartial({ ...accounts }); else if (typeof updBuilder.accounts === 'function') updBuilder = updBuilder.accounts({ ...accounts }); } catch {}
              try {
                if (getCoverage && typeof updBuilder.remainingAccounts === 'function') {
                  const cov = await getCoverage(programId, poolPk).catch(() => null as any) || await getCoverage(connection, programId, poolPk).catch(() => null as any) || await getCoverage({ programId, lbPair: poolPk }).catch(() => null as any);
                  const metas = (cov && ((cov as any).metas || (cov as any).accountMetas)) || (Array.isArray(cov) ? cov : []);
                  if (Array.isArray(metas) && metas.length) updBuilder = updBuilder.remainingAccounts(metas);
                }
              } catch {}
              try {
                const updIx = (typeof updBuilder.instruction === 'function') ? await updBuilder.instruction() : null;
                if (updIx) { setupIxs.push(updIx as TransactionInstruction); try { logger.info('meteora.dlmm.bitmap_ext.init.ok', { cat: 'tx' }); } catch {} }
              } catch (e: any) { try { logger.warn('meteora.dlmm.bitmap_ext.init.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {} }
            } else {
              // Fallback: try top-level helper if present
              const updateFn = (DLMM as any)?.updateBinArray || (mod as any)?.updateBinArray;
              if (typeof updateFn === 'function') {
                const attempts: Array<() => Promise<any>> = [];
                attempts.push(() => updateFn(connection, programId, poolPk));
                attempts.push(() => updateFn(programId, poolPk));
                attempts.push(() => updateFn(program, poolPk));
                attempts.push(() => updateFn({ connection, programId, lbPair: poolPk }));
                for (const fn of attempts) {
                  try {
                    const maybeIx = await fn();
                    if (maybeIx) { setupIxs.push(maybeIx as TransactionInstruction); try { logger.info('meteora.dlmm.bitmap_ext.init.ok', { cat: 'tx' }); } catch {} break; }
                  } catch {}
                }
              } else {
                try { logger.warn('meteora.dlmm.bitmap_ext.init.unavailable', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
              }
            }
          }
        } catch {}
      }
    } catch {}

    // Extend with host/referral fee handling and reserves when available
    const acctBase: any = { ...accounts, hostFeeIn: null };
    try {
      if (hop.vaultA) acctBase.reserveX = toPublicKey(hop.vaultA as any);
      if (hop.vaultB) acctBase.reserveY = toPublicKey(hop.vaultB as any);
    } catch {}

    // Add token mints, programs and oracle if available/derivable
    // Detect correct token program IDs per mint (Token-2022 support)
    try {
      const getTokenProgramId = (DLMM as any)?.getTokenProgramId;
      const xMint = acctBase.tokenXMint ? (acctBase.tokenXMint.publicKey || acctBase.tokenXMint) : (hop.inputMint ? toPublicKey(hop.inputMint) : undefined);
      const yMint = acctBase.tokenYMint ? (acctBase.tokenYMint.publicKey || acctBase.tokenYMint) : (hop.outputMint ? toPublicKey(hop.outputMint) : undefined);
      const fallbackTokenProg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      if (getTokenProgramId && xMint) { acctBase.tokenXProgram = await getTokenProgramId(connection, xMint).catch(() => fallbackTokenProg); }
      if (getTokenProgramId && yMint) { acctBase.tokenYProgram = await getTokenProgramId(connection, yMint).catch(() => fallbackTokenProg); }
      if (!acctBase.tokenXProgram) acctBase.tokenXProgram = fallbackTokenProg;
      if (!acctBase.tokenYProgram) acctBase.tokenYProgram = fallbackTokenProg;
    } catch {}
    try { acctBase.memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'); } catch {}
    try {
      const getTokensMintFromPoolAddress = (DLMM as any)?.getTokensMintFromPoolAddress;
      if (getTokensMintFromPoolAddress) {
        const mints = await getTokensMintFromPoolAddress(connection, poolPk).catch(() => null as any);
        const x = (mints as any)?.tokenXMint || (mints as any)?.x || (mints as any)?.a;
        const y = (mints as any)?.tokenYMint || (mints as any)?.y || (mints as any)?.b;
        if (x) acctBase.tokenXMint = (x as any).publicKey || x;
        if (y) acctBase.tokenYMint = (y as any).publicKey || y;
      }
    } catch {}
    // Derive reserves if not already provided
    try {
      const deriveReserve = (DLMM as any)?.deriveReserve;
      if (typeof deriveReserve === 'function') {
        if (!acctBase.reserveX) {
          const rx = await deriveReserve(programId, poolPk, true).catch(() => null as any);
          if (rx) acctBase.reserveX = (rx as any).publicKey || rx;
        }
        if (!acctBase.reserveY) {
          const ry = await deriveReserve(programId, poolPk, false).catch(() => null as any);
          if (ry) acctBase.reserveY = (ry as any).publicKey || ry;
        }
      }
    } catch {}
    try {
      const deriveOracle = (DLMM as any)?.deriveOracle;
      if (deriveOracle) {
        const orc = await deriveOracle(programId, poolPk).catch(() => null as any);
        if (orc) acctBase.oracle = (orc as any).publicKey || orc;
      }
    } catch {}

    // Choose swap variant now that token program IDs are known
    try {
      const tokenKeg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const isToken2022 = (p: any) => { try { return p && typeof p.equals === 'function' && !p.equals(tokenKeg); } catch { return false; } };
      const needs2022 = isToken2022(acctBase.tokenXProgram) || isToken2022(acctBase.tokenYProgram);
      if (needs2022 && typeof (methods as any)?.swap2 === 'function') builder = methods.swap2(amountIn, minOut, { slices: [] });
      else if (typeof (methods as any)?.swap === 'function') builder = methods.swap(amountIn, minOut);
      else if (typeof (methods as any)?.swapExactIn === 'function') builder = methods.swapExactIn(amountIn, minOut);
      else throw new Error('DLMM_SWAP_METHOD_MISSING');
    } catch {}

    // Prefer accountsPartial so optional nulls are honored
    if (typeof (builder as any).accountsPartial === 'function') builder = (builder as any).accountsPartial(acctBase);
    else if (typeof (builder as any).accounts === 'function') builder = (builder as any).accounts(acctBase);

    // Log key accounts for DLMM swap for observability
    try {
      const to58 = (x: any) => (x && typeof x.toBase58 === 'function') ? x.toBase58() : (typeof x === 'string' ? x : undefined);
      logger.info('meteora.dlmm.accounts', { cat: 'tx', ctx: {
        pool: to58(poolPk),
        tokenXProgram: to58((acctBase as any)?.tokenXProgram),
        tokenYProgram: to58((acctBase as any)?.tokenYProgram),
        reserveX: to58((acctBase as any)?.reserveX),
        reserveY: to58((acctBase as any)?.reserveY),
        binArrayLower: to58(binArrayLower),
        binArrayUpper: to58(binArrayUpper),
        bitmapExt: to58((acctBase as any)?.binArrayBitmapExtension) || null
      }});
    } catch {}

    // Supply remaining accounts for bin arrays using documented helpers (applies to swap and swap2)
    try {
      const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId;
      const getMetas = (DLMM as any)?.getBinArrayAccountMetasCoverage;
      if (getBounds && getMetas && typeof (builder as any).remainingAccounts === 'function') {
        try {
          const bnjs = await import('bn.js').catch(() => null as any);
          const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
          const bounds = await getBounds(connection, poolPk).catch(() => null as any);
          const toNum = (v: any): number => {
            try {
              if (v && typeof v.toNumber === 'function') return v.toNumber();
              const s = (v && typeof v.toString === 'function') ? v.toString() : String(v);
              const n = Number(s);
              return Number.isFinite(n) ? n : NaN;
            } catch {
              return NaN;
            }
          };
          const loNum = toNum(bounds?.lowerBinId);
          const hiNum = toNum(bounds?.upperBinId);
          if (Number.isFinite(loNum) && Number.isFinite(hiNum) && BN) {
            const metas = getMetas(new BN(String(loNum)), new BN(String(hiNum)), poolPk, programId) || [];
            if (Array.isArray(metas) && metas.length) {
              builder = (builder as any).remainingAccounts(metas);
              try { logger.info('meteora.dlmm.remaining.ok', { cat: 'tx', ctx: { count: metas.length } }); } catch {}
            }
          }
        } catch (e: any) {
          try { logger.debug('meteora.dlmm.remaining.bounds.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
      
      // Fallback: try generic keys coverage without explicit bounds
      if (typeof (builder as any).remainingAccounts === 'function') {
        try {
          const getCoverage = (DLMM as any)?.getBinArrayKeysCoverage || (DLMM as any)?.getBinArrayAccountMetasCoverage;
          if (getCoverage) {
            const cov = await getCoverage(programId, poolPk).catch(() => null as any) 
              || await getCoverage(connection, programId, poolPk).catch(() => null as any) 
              || await getCoverage({ programId, lbPair: poolPk }).catch(() => null as any);
            const metas = (cov && ((cov as any).metas || (cov as any).accountMetas)) || (Array.isArray(cov) ? cov : []);
            if (Array.isArray(metas) && metas.length) {
              builder = (builder as any).remainingAccounts(metas);
              try { logger.info('meteora.dlmm.remaining.ok', { cat: 'tx', ctx: { count: metas.length } }); } catch {}
            }
          }
        } catch (e: any) {
          try { logger.debug('meteora.dlmm.remaining.coverage.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
        }
      }
    } catch (e: any) {
      try { logger.warn('meteora.dlmm.remaining.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
    }
    
    const ix = (typeof builder.instruction === 'function') ? await builder.instruction() : null;
    
    // Safety net: inject bin metas into instruction if builder.remainingAccounts did not attach them
    if (ix) {
      await injectBinArrayMetas(ix, DLMM, connection, poolPk, programId);
      try { logger.info('meteora.dlmm.swap.ok', { cat: 'tx' }); } catch {}
      return [...setupIxs, ix];
    }
    
    try { logger.warn('meteora.dlmm.tsclient.swap.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  } catch (e: any) {
    try { logger.warn('meteora.dlmm.tsclient.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
  }

  // Wrap final error with context
  wrapBuilderError(new Error('METEORA_DLMM_BUILD_FAILED'), 'METEORA_DLMM', 'build failed', hop);
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
    // Final validation - require cache-provided arrays/oracle
    try { logger.info('raydium.clmm.builder.arrays', { cat: 'tx', ctx: { pool: hop.poolId, lower: hop.tickArrayLower, upper: hop.tickArrayUpper } as any }); } catch {}
    const missing: string[] = [];
    if (!hop.tickArrayLower || !hop.tickArrayUpper || !hop.oracle) missing.push('tickArrayLower/Upper/oracle');
    if (missing.length) {
      // One-shot refresh: attempt to hydrate CLMM statics (oracle/tick arrays) from chain
      try {
        try { logger.warn('raydium.clmm.refresh.attempt', { cat: 'tx', ctx: { pool: hop.poolId, missing: missing.join('/') } as any }); } catch {}
        const poolBase = String(hop.poolId || '').replace(/-rev$/, '');
        try {
          const mod = await import('../../server/tasks/refreshClmm.js');
          if (typeof (mod as any)?.refreshRaydiumClmm === 'function') {
            await (mod as any).refreshRaydiumClmm(poolBase);
          }
        } catch (e: any) {
          try { logger.warn('raydium.clmm.refresh.err', { cat: 'tx', ctx: { pool: poolBase, error: String(e?.message || e) } as any }); } catch {}
        }
        try {
          const cacheMod: any = await import('../clmmCache.js');
          const cached = typeof cacheMod?.getClmmStatic === 'function' ? cacheMod.getClmmStatic(poolBase) : null;
          if (cached) {
            hop.programId = hop.programId || cached.programId;
            hop.tickSpacing = hop.tickSpacing ?? cached.tickSpacing;
            hop.oracle = hop.oracle || cached.oracle;
            hop.vaultA = hop.vaultA || cached.vaultA;
            hop.vaultB = hop.vaultB || cached.vaultB;
            hop.tickArrayLower = hop.tickArrayLower || cached.tickArrays.lower;
            hop.tickArrayCenter = hop.tickArrayCenter || cached.tickArrays.center;
            hop.tickArrayUpper = hop.tickArrayUpper || cached.tickArrays.upper;
          }
          try { logger.info('raydium.clmm.refresh.result', { cat: 'tx', ctx: { pool: poolBase, oracle: hop.oracle || '', lower: hop.tickArrayLower || '', upper: hop.tickArrayUpper || '' } as any }); } catch {}
        } catch {}
      } catch {}
      const stillMissing: string[] = [];
      if (!hop.tickArrayLower || !hop.tickArrayUpper || !hop.oracle) stillMissing.push('tickArrayLower/Upper/oracle');
      if (stillMissing.length) throw new Error(`RAYDIUM_CLMM_BUILD_FAILED: CACHE_MISS_AFTER_REFRESH: missing ${stillMissing.join(',')}`);
    }
    try {
      logger.info('raydium.clmm.accounts', { cat: 'tx', ctx: {
        pool: hop.poolId,
        programId: hop.programId,
        oracle: hop.oracle,
        lower: hop.tickArrayLower,
        upper: hop.tickArrayUpper,
        vaultA: hop.vaultA,
        vaultB: hop.vaultB,
      }});
    } catch {}

    const { ClmmInstrument } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const poolId = toPublicKey(hop.poolId);
    const programId = toPublicKey(hop.programId, (CONFIG.raydium?.clmmProgram as any));
    
    // Validate required config values - no unsafe fallbacks
    const observationIdConfig = (CONFIG.raydium as any)?.clmmObservationId;
    if (!observationIdConfig) {
      throw createBuilderError('RAYDIUM_CLMM', 'clmmObservationId required in CONFIG.raydium.clmmObservationId', hop);
    }
    const observationId = toPublicKey(observationIdConfig);

    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: toPublicKey(hop.userSourceAta),
      tokenAccountB: toPublicKey(hop.userDestAta),
    };

    // Minimal poolInfo/poolKeys for swapBaseIn; for real use, prefer full keys via SDK helper if available in version
    const poolInfo = { id: poolId, programId, mintA: toPublicKey(hop.inputMint), mintB: toPublicKey(hop.outputMint), config: {} } as any;
    
    // Validate authority config - no unsafe fallback
    const authorityConfig = (CONFIG.raydium as any)?.clmmAuthority;
    if (!authorityConfig) {
      throw createBuilderError('RAYDIUM_CLMM', 'clmmAuthority required in CONFIG.raydium.clmmAuthority', hop);
    }
    const authority = toPublicKey(authorityConfig);
    
    const poolKeys: any = {
      id: poolId,
      programId,
      mintA: toPublicKey(hop.inputMint),
      mintB: toPublicKey(hop.outputMint),
      vault: { A: toPublicKey(hop.vaultA as any), B: toPublicKey(hop.vaultB as any) },
      authority,
      observationId,
    };
    try { if (hop.tickArrayLower) (poolKeys as any).tickArrayLower = toPublicKey(hop.tickArrayLower); } catch {}
    try { if (hop.tickArrayUpper) (poolKeys as any).tickArrayUpper = toPublicKey(hop.tickArrayUpper); } catch {}

    const remaining: any[] = [];
    try { if (hop.oracle) remaining.push({ pubkey: toPublicKey(hop.oracle), isWritable: false, isSigner: false }); } catch {}
    const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
      poolInfo,
      poolKeys,
      observationId,
      ownerInfo,
      inputMint: toPublicKey(hop.inputMint),
      amountIn: hop.amountInRaw,
      amountOutMin: hop.minOutRaw,
      sqrtPriceLimitX64: hop.sqrtPriceLimitX64 ?? 0n,
      remainingAccounts: remaining,
    });
    const ixs = Array.isArray(res?.instructions) ? res.instructions : (res?.innerTransaction ? res.innerTransaction.instructions : []);
    if (ixs && ixs.length) return ixs as any[];
  } catch (e) {
    // If error is already a builder error, preserve it
    if (e instanceof Error && e.message.includes('RAYDIUM_CLMM_BUILD_FAILED')) {
      logAndThrow(e);
    }
    // Otherwise wrap it with context
    wrapBuilderError(e, 'RAYDIUM_CLMM', 'build failed', hop);
  }
}

export async function buildRaydiumAmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.info('ix.build raydium.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    // Pre-build validation: amounts
    validateHopAmounts(hop, { dex: 'raydium', variant: 'amm', poolId: hop.poolId });
    
    // Pre-build validation: critical PublicKeys
    try {
      validatePublicKey(hop.poolId, 'poolId', { dex: 'raydium', variant: 'amm' });
      validatePublicKey(hop.inputMint, 'inputMint', { dex: 'raydium', variant: 'amm' });
      validatePublicKey(hop.outputMint, 'outputMint', { dex: 'raydium', variant: 'amm' });
      validatePublicKey(hop.userSourceAta, 'userSourceAta', { dex: 'raydium', variant: 'amm' });
      validatePublicKey(hop.userDestAta, 'userDestAta', { dex: 'raydium', variant: 'amm' });
    } catch (validationErr) {
      throw createBuilderError('RAYDIUM_AMM', String((validationErr as any)?.message || validationErr), hop);
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
    // Optional: validate vault accounts exist (best-effort, don't block on RPC errors)
    if (hop.vaultA || hop.vaultB) {
      try {
        await validatePoolAccounts(hop.poolId, hop.vaultA, hop.vaultB, { dex: 'raydium', variant: 'amm' }).catch(() => {
          // Best-effort validation - don't fail if RPC is slow
        });
      } catch {}
    }
    const missing: string[] = [];
    if (!hop.market) missing.push('market');
    if (!hop.serumProgramId) missing.push('serumProgramId');
    if (!Number.isFinite(Number(hop.inputDecimals))) missing.push('inputDecimals');
    if (!Number.isFinite(Number(hop.outputDecimals))) missing.push('outputDecimals');
    if (missing.length) {
      const ver = resolveRaydiumAmmVersion(hop.programId);
      throw createBuilderError('RAYDIUM_AMM', `missing required fields: ${missing.join(', ')} (version=${ver})`, hop);
    }

    const { getAssociatedPoolKeys, makeSwapFixedInInstruction } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const ammProgramId = toPublicKey(hop.programId, (CONFIG.raydium?.ammV4Program as any));
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
      programId: ammProgramId,
      marketProgramId,
    });

    // Helper to detect invalid PublicKey-like values (including placeholder strings)
    const isBadPk = (x: any): boolean => {
      return !isValidPublicKey(x);
    };

    // Decode AMM state from chain (always) to override any placeholder keys returned by SDK
    try {
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
          const asPk = (v: any) => (v?.toBase58 ? v : (v ? normalizePublicKey(v) : undefined));
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
            programId: ammProgramId,
            authority: authority || (poolKeys as any)?.authority,
            openOrders: openOrders || (poolKeys as any)?.openOrders,
            targetOrders: targetOrders || (poolKeys as any)?.targetOrders,
            vault: {
              A: baseVault || ((poolKeys as any)?.vault ? (poolKeys as any).vault.A : undefined),
              B: quoteVault || ((poolKeys as any)?.vault ? (poolKeys as any).vault.B : undefined),
            },
            mintLp: lpMint || (poolKeys as any)?.mintLp,
            marketProgramId: marketProg || (poolKeys as any)?.marketProgramId,
            marketId: marketPk || (poolKeys as any)?.marketId,
            marketEventQueue: marketEventQueue || (poolKeys as any)?.marketEventQueue,
            marketBids: marketBids || (poolKeys as any)?.marketBids,
            marketAsks: marketAsks || (poolKeys as any)?.marketAsks,
            marketBaseVault: marketBaseVault || (poolKeys as any)?.marketBaseVault,
            marketQuoteVault: marketQuoteVault || (poolKeys as any)?.marketQuoteVault,
            marketAuthority: marketAuthority || (poolKeys as any)?.marketAuthority,
          } as any;
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
      const ensurePk = (v: any) => (v && typeof v === 'object' && typeof v.toBase58 === 'function') ? v : (v ? normalizePublicKey(v) : undefined);
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
      (poolKeys as any).programId = ensurePk(ammProgramId);
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

    // Fallback Serum/OpenBook program id if decode failed and placeholder/system id was present
    try {
      const sysPid = '11111111111111111111111111111111';
      const serumV3 = '9xQeWvG816bUx9EPfDdLVQH7QycGepbhujHWy8S9UvS';
      const got = (poolKeys as any)?.marketProgramId;
      const s = (got && typeof got.toBase58 === 'function') ? got.toBase58() : String(got || '');
      if (!s || s === sysPid) {
        (poolKeys as any).marketProgramId = new PublicKey(serumV3);
      }
    } catch {}

    // Final validation guard: abort build if critical keys are still invalid
    try {
      const stillBad = [
        (poolKeys as any)?.vault?.A,
        (poolKeys as any)?.vault?.B,
        (poolKeys as any)?.marketProgramId,
        (poolKeys as any)?.marketId,
        (poolKeys as any)?.authority,
      ].some(isBadPk);
      if (stillBad) {
        const toStr = (v: any) => (v && typeof v.toBase58 === 'function') ? v.toBase58() : String(v || '');
        try {
          logger.warn('raydium.amm.keys.invalid', { cat: 'tx', ctx: {
            id: toStr((poolKeys as any)?.id || hop.poolId),
            programId: toStr((poolKeys as any)?.programId || ammProgramId),
            vaultA: toStr((poolKeys as any)?.vault?.A),
            vaultB: toStr((poolKeys as any)?.vault?.B),
            marketId: toStr((poolKeys as any)?.marketId),
            marketProgramId: toStr((poolKeys as any)?.marketProgramId),
          } as any });
        } catch {}
        throw createBuilderError('RAYDIUM_AMM', 'invalid_pool_keys', hop, {
          vaultA: toStr((poolKeys as any)?.vault?.A),
          vaultB: toStr((poolKeys as any)?.vault?.B),
          marketId: toStr((poolKeys as any)?.marketId),
          marketProgramId: toStr((poolKeys as any)?.marketProgramId),
        });
      }
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

    let out = unwrapIxs(ixInfo);
    try { logger.info('ix.build raydium.amm.detail', { cat: 'tx', ctx: { got: Array.isArray(out) ? out.length : 0, shape: (ixInfo && typeof ixInfo === 'object' ? Object.keys(ixInfo) : String(typeof ixInfo)) } as any }); } catch {}
    // Report key material for observability when we have poolKeys
    try {
      const key = (v: any) => (v && typeof v.toBase58 === 'function') ? v.toBase58() : (v ? String(v) : '');
      logger.info('raydium.amm.keys', { cat: 'tx', ctx: {
        id: key((poolKeys as any)?.id),
        programId: key((poolKeys as any)?.programId),
        vaultA: key((poolKeys as any)?.vault?.A),
        vaultB: key((poolKeys as any)?.vault?.B),
        marketId: key((poolKeys as any)?.marketId),
        marketProgramId: key((poolKeys as any)?.marketProgramId)
      }});
    } catch {}
    // Fallback: coerce top-level ixInfo if unwrap produced no TIs
    if ((!out || out.length === 0) && ixInfo && typeof ixInfo === 'object' && (ixInfo as any).programId && (ixInfo as any).keys) {
      try {
        const normalizePkLoose = (v: any): PublicKey => normalizePublicKey(v);
        const coerceTop = (ixAny: any): TransactionInstruction => {
          const programId = ammProgramId;
          const keysLike = ixAny?.keys;
          let keyArr: any[] = [];
          try {
            if (Array.isArray(keysLike)) keyArr = keysLike;
            else if (keysLike && typeof (keysLike as any)[Symbol.iterator] === 'function') keyArr = Array.from(keysLike as any);
            else if (keysLike && typeof (keysLike as any).length === 'number') keyArr = Array.from({ length: Number((keysLike as any).length) }, (_, i) => (keysLike as any)[i]);
            else if (keysLike && typeof keysLike === 'object') {
              const vals = Object.values(keysLike as any);
              if (vals.length && (vals[0] as any) && ((vals[0] as any).pubkey || (vals[0] as any).pubKey || (vals[0] as any).address)) keyArr = vals as any[];
            }
          } catch {}
          const keys = keyArr.map((k: any) => ({
            pubkey: normalizePkLoose(k?.pubkey ?? k?.pubKey ?? k?.address),
            isSigner: !!k?.isSigner,
            isWritable: !!k?.isWritable,
          }));
          let data: Buffer = Buffer.alloc(0);
          const raw = ixAny?.data;
          try {
            if (Buffer.isBuffer(raw)) data = raw as Buffer;
            else if (raw instanceof Uint8Array) data = Buffer.from(raw);
            else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(Array.from(raw as any));
            else if (typeof raw === 'string') { try { data = Buffer.from(raw, 'base64'); } catch {} }
          } catch {}
          return new TransactionInstruction({ programId, keys, data });
        };
        out = [coerceTop(ixInfo)];
      } catch {}
    }
    // Coerce any foreign TI-shaped objects into our local TransactionInstruction to avoid cross-web3 issues
    try {
      const normalizePkLoose = (v: any): PublicKey => normalizePublicKey(v);

      const coerceOne = (ixAny: any): TransactionInstruction => {
        // Always build a fresh TI using our known program id to avoid foreign instances
        const programId = ammProgramId;
        const keysLike = ixAny?.keys;
        let keyArr: any[] = [];
        try {
          if (Array.isArray(keysLike)) keyArr = keysLike;
          else if (keysLike && typeof (keysLike as any)[Symbol.iterator] === 'function') keyArr = Array.from(keysLike as any);
          else if (keysLike && typeof (keysLike as any).length === 'number') keyArr = Array.from({ length: Number((keysLike as any).length) }, (_, i) => (keysLike as any)[i]);
          else if (keysLike && typeof keysLike === 'object') {
            const vals = Object.values(keysLike as any);
            if (vals.length && (vals[0] as any) && ((vals[0] as any).pubkey || (vals[0] as any).pubKey || (vals[0] as any).address)) keyArr = vals as any[];
          }
        } catch {}
        const keys = keyArr.map((k: any) => ({
          pubkey: normalizePkLoose(k?.pubkey ?? k?.pubKey ?? k?.address),
          isSigner: !!k?.isSigner,
          isWritable: !!k?.isWritable,
        }));
        let data: Buffer = Buffer.alloc(0);
        const raw = ixAny?.data;
        try {
          if (Buffer.isBuffer(raw)) data = raw as Buffer;
          else if (raw instanceof Uint8Array) data = Buffer.from(raw);
          else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(Array.from(raw as any));
          else if (typeof raw === 'string') { try { data = Buffer.from(raw, 'base64'); } catch {} }
        } catch {}
        return new TransactionInstruction({ programId, keys, data });
      };
      if (Array.isArray(out) && out.length) {
        out = out.map(coerceOne);
      }
    } catch {}
    if (out && out.length) return out;
    throw createBuilderError('RAYDIUM_AMM', 'bad_ix_shape: no instructions produced', hop);
  } catch (e) {
    // If error is already a builder error, log and rethrow
    if (e instanceof Error && e.message.includes('RAYDIUM_AMM_BUILD_FAILED')) {
      logAndThrow(e);
    }
    // Otherwise wrap it
    wrapBuilderError(e, 'RAYDIUM_AMM', 'build failed', hop);
  }
}


