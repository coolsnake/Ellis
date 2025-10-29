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
    const { createSolanaRpc } = await import('@solana/kit');
    const { swapInstructions, setWhirlpoolsConfig, setNativeMintWrappingStrategy, setPayerFromBytes } = await import('@orca-so/whirlpools');
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
            throw new Error('ORCA_WRONG_INPUT_MINT_FOR_POOL');
          }
        }
      }
    } catch (preErr) {
      throw preErr;
    }
    try {
      const rpc = createSolanaRpc(CONFIG.rpcUrl);
      await setPayerFromBytes(kp.secretKey);
      await setWhirlpoolsConfig('solanaMainnet');
      setNativeMintWrappingStrategy('ata');
      const poolAddr = String(hop.poolId);
      const inputMint = String(hop.inputMint);
      const bps = computeSlippageBps(hop.amountInRaw, hop.minOutRaw);
      try { logger.info('orca.whirlpool.program', { cat: 'tx', ctx: { programId: 'whirlpool(high-level)' } as any }); } catch {}
      try { logger.info('orca.whirlpool.ctx.ok', { cat: 'tx' }); } catch {}
      try { logger.info('orca.whirlpool.client.ok', { cat: 'tx' }); } catch {}
      try { logger.info('orca.whirlpool.pool.prepare', { cat: 'tx', ctx: { pool: poolAddr } as any }); } catch {}
      try { logger.info('orca.whirlpool.slippage', { cat: 'tx', ctx: { amountInRaw: String(hop.amountInRaw ?? 0n), minOutRaw: String(hop.minOutRaw ?? 0n), bps } as any }); } catch {}
      try { logger.info('orca.whirlpool.input', { cat: 'tx', ctx: { inputMint, amountIn: String(hop.amountInRaw ?? 0n) } as any }); } catch {}
      const res: any = await swapInstructions(
        rpc as any,
        { inputAmount: BigInt(String(hop.amountInRaw ?? 0n)), mint: inputMint } as any,
        poolAddr,
        bps
      );
      try { logger.info('orca.whirlpool.quote.ok', { cat: 'tx', ctx: { estimatedOutRaw: String((res as any)?.quote?.estimatedAmountOut ?? 0) } as any }); } catch {}
      // Guard: trade not enabled yet
      try {
        const tradeTs: any = (res as any)?.tradeEnableTimestamp;
        if (typeof tradeTs === 'bigint') {
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          try { logger.info('orca.whirlpool.trade.ts', { cat: 'tx', ctx: { tradeEnableTimestamp: tradeTs.toString() } as any }); } catch {}
          if (tradeTs > nowSec) throw new Error(`ORCA_TRADE_DISABLED: enabled_at=${tradeTs.toString()}`);
        }
      } catch (guardErr) { throw guardErr; }
      // Guard: zero estimated out
      try {
        const estOut = BigInt(String((res as any)?.quote?.estimatedAmountOut ?? 0));
        if (estOut === 0n) {
          // Fallback: reuse our resolver's quote to confirm zero vs SDK-wrapper quirk
          try {
            const { quoteHopOut } = await import('../resolver/quotes.js');
            const fallbackOut = await quoteHopOut(hop as any, BigInt(String(hop.amountInRaw ?? 0n)));
            try { logger.info('orca.whirlpool.quote.fallback', { cat: 'tx', ctx: { fallbackOutRaw: String(fallbackOut) } as any }); } catch {}
            if (fallbackOut === 0n) throw new Error('ORCA_QUOTE_ZERO: no tradable amount');
            // If fallbackOut > 0, continue; we'll trust the instructions from swapInstructions
          } catch (fallbackErr) {
            // Do not surface fallback-specific errors; retain original zero-quote semantics
            try { logger.warn('orca.whirlpool.quote.fallback.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String((fallbackErr as any)?.message || fallbackErr) } }); } catch {}
            throw new Error('ORCA_QUOTE_ZERO: no tradable amount');
          }
        }
      } catch (guardErr) { throw guardErr; }
      const rawIxs = Array.isArray((res as any)?.instructions) ? (res as any).instructions : [];
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
      const out = rawIxs.map(normalizeIx);
      try { logger.info('orca.whirlpool.ix.ready', { cat: 'tx', ctx: { count: Array.isArray(out) ? out.length : 0 } as any }); } catch {}
      return out;
    } catch (inner) {
      throw inner;
    }
  } catch (e) {
    try { logger.warn('ix.build orca.clmm err', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    // Propagate error so caller can abort rather than sending a broken placeholder
    throw e;
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

    const accounts: any = {
      lbPair: poolPk,
      user: kp.publicKey,
      userTokenIn: toPublicKey(hop.userSourceAta),
      userTokenOut: toPublicKey(hop.userDestAta),
    };
    if (binArrayLower) accounts.binArrayLower = binArrayLower;
    if (binArrayUpper) accounts.binArrayUpper = binArrayUpper;
    // Only include bitmap extension if it exists and is owned by program; IDL marks it optional
    let bitmapOwnerOk = false;
    try {
      if (binArrayBitmapExtension) {
        const acc = await connection.getAccountInfo(binArrayBitmapExtension);
        bitmapOwnerOk = !!acc && acc.owner && acc.owner.equals && acc.owner.equals(programId);
        if (bitmapOwnerOk) {
    accounts.binArrayBitmapExtension = binArrayBitmapExtension;
        } else {
          try { logger.warn('meteora.dlmm.ext.skip_wrong_owner', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { owner: acc?.owner?.toBase58?.(), expected: programId?.toBase58?.() } }); } catch {}
        }
      }
    } catch {}

    // Extend with host/referral fee handling and reserves when available
    const acctBase: any = { ...accounts, hostFeeIn: null };
    // Explicitly set optional extension account to null when not owned
    if (!bitmapOwnerOk && !acctBase.binArrayBitmapExtension) acctBase.binArrayBitmapExtension = null;
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
      let added = false;
      try {
        const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId;
        const getMetas = (DLMM as any)?.getBinArrayAccountMetasCoverage;
        if (getBounds && getMetas) {
          const bnjs = await import('bn.js').catch(() => null as any);
          const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
          const bounds = await getBounds(connection, poolPk).catch(() => null as any);
          const toNum = (v: any): number => {
            try { if (v && typeof v.toNumber === 'function') return v.toNumber(); const s = (v && typeof v.toString === 'function') ? v.toString() : String(v); const n = Number(s); return Number.isFinite(n) ? n : NaN; } catch { return NaN; }
          };
          const loNum = toNum(bounds?.lowerBinId);
          const hiNum = toNum(bounds?.upperBinId);
          if (Number.isFinite(loNum) && Number.isFinite(hiNum) && BN && typeof (builder as any).remainingAccounts === 'function') {
            const metas = getMetas(new BN(String(loNum)), new BN(String(hiNum)), poolPk, programId) || [];
            if (Array.isArray(metas) && metas.length) { builder = (builder as any).remainingAccounts(metas); added = true; }
          }
        }
      } catch {}
      // Fallback: try generic keys coverage without explicit bounds
      if (!added) {
        try {
          const getCoverage = (DLMM as any)?.getBinArrayKeysCoverage || (DLMM as any)?.getBinArrayAccountMetasCoverage;
          if (getCoverage && typeof (builder as any).remainingAccounts === 'function') {
            const cov = await getCoverage(programId, poolPk).catch(() => null as any) || await getCoverage(connection, programId, poolPk).catch(() => null as any) || await getCoverage({ programId, lbPair: poolPk }).catch(() => null as any);
            const metas = (cov && ((cov as any).metas || (cov as any).accountMetas)) || (Array.isArray(cov) ? cov : []);
            if (Array.isArray(metas) && metas.length) { builder = (builder as any).remainingAccounts(metas); added = true; }
          }
        } catch {}
      }
      try { if (added) { logger.info('meteora.dlmm.remaining.ok', { cat: 'tx' }); } } catch {}
    } catch {}
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
    const observationId = toPublicKey((CONFIG.raydium as any)?.clmmObservationId || PublicKey.default.toBase58());

    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: toPublicKey(hop.userSourceAta),
      tokenAccountB: toPublicKey(hop.userDestAta),
    };

    // Minimal poolInfo/poolKeys for swapBaseIn; for real use, prefer full keys via SDK helper if available in version
    const poolInfo = { id: poolId, programId, mintA: toPublicKey(hop.inputMint), mintB: toPublicKey(hop.outputMint), config: {} } as any;
    const poolKeys: any = {
      id: poolId,
      programId,
      mintA: toPublicKey(hop.inputMint),
      mintB: toPublicKey(hop.outputMint),
      vault: { A: toPublicKey(hop.vaultA as any), B: toPublicKey(hop.vaultB as any) },
      authority: toPublicKey((CONFIG.raydium as any)?.clmmAuthority || PublicKey.default.toBase58()),
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
      try {
        if (!x) return true;
        if (typeof x?.toBase58 === 'function') return false;
        const s = typeof x === 'string'
          ? x
          : (x?.address || x?.pubkey || x?.pubKey || x?.publicKey || x?.toBase58?.());
        // eslint-disable-next-line no-new
        new PublicKey(String(s));
        return false;
      } catch { return true; }
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
        try {
          const toStr = (v: any) => (v && typeof v.toBase58 === 'function') ? v.toBase58() : String(v || '');
          logger.warn('raydium.amm.keys.invalid', { cat: 'tx', ctx: {
            id: toStr((poolKeys as any)?.id || hop.poolId),
            programId: toStr((poolKeys as any)?.programId || ammProgramId),
            vaultA: toStr((poolKeys as any)?.vault?.A),
            vaultB: toStr((poolKeys as any)?.vault?.B),
            marketId: toStr((poolKeys as any)?.marketId),
            marketProgramId: toStr((poolKeys as any)?.marketProgramId),
          } as any });
        } catch {}
        throw new Error('RAYDIUM_AMM_BUILD_FAILED: invalid_pool_keys');
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
        const normalizePkLoose = (v: any): PublicKey => {
          try {
            if (v instanceof PublicKey) return v;
            const inner = (v && (v.address || v.pubkey || v.pubKey || v.publicKey)) || v;
            if (inner instanceof PublicKey) return inner;
            try { if (inner && typeof inner.toBytes === 'function') return new PublicKey(inner.toBytes()); } catch {}
            try { if (inner && typeof inner.toBuffer === 'function') return new PublicKey(inner.toBuffer()); } catch {}
            try {
              const bn = (inner && (inner._bn || inner.bn || inner.value)) as any;
              if (bn && typeof bn === 'object') {
                if (typeof bn.toArrayLike === 'function') return new PublicKey(bn.toArrayLike(Uint8Array, 'be', 32));
                if (typeof bn.toArray === 'function') return new PublicKey(Uint8Array.from(bn.toArray('be', 32)));
              }
            } catch {}
            try { if (Array.isArray(inner) && inner.length >= 32) return new PublicKey(Uint8Array.from(inner)); } catch {}
            if (typeof inner === 'string') return new PublicKey(inner);
            return new PublicKey(String(inner));
          } catch (e) {
            return toPublicKey(v);
          }
        };
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
      const normalizePkLoose = (v: any): PublicKey => {
        try {
          if (v instanceof PublicKey) return v;
          const inner = (v && (v.address || v.pubkey || v.pubKey || v.publicKey)) || v;
          if (inner instanceof PublicKey) return inner;
          // Prefer byte-based paths to avoid foreign toBase58
          try { if (inner && typeof inner.toBytes === 'function') return new PublicKey(inner.toBytes()); } catch {}
          try { if (inner && typeof inner.toBuffer === 'function') return new PublicKey(inner.toBuffer()); } catch {}
          // BN-like internals
          try {
            const bn = (inner && (inner._bn || inner.bn || inner.value)) as any;
            if (bn && typeof bn === 'object') {
              if (typeof bn.toArrayLike === 'function') return new PublicKey(bn.toArrayLike(Uint8Array, 'be', 32));
              if (typeof bn.toArray === 'function') return new PublicKey(Uint8Array.from(bn.toArray('be', 32)));
            }
          } catch {}
          // Direct byte array
          try { if (Array.isArray(inner) && inner.length >= 32) return new PublicKey(Uint8Array.from(inner)); } catch {}
          // String fallback
          if (typeof inner === 'string') return new PublicKey(inner);
          return new PublicKey(String(inner));
        } catch (e) {
          // Final fallback to existing helper
          return toPublicKey(v);
        }
      };

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
    try { logger.warn('ix.build raydium.amm.real unexpected shape', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    throw new Error('RAYDIUM_AMM_BUILD_FAILED: bad_ix_shape');
  } catch (e) {
    try { logger.warn('ix.build raydium.amm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  throw new Error('RAYDIUM_AMM_BUILD_FAILED');
}


