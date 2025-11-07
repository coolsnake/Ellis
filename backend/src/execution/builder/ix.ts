import type { DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { address } from '@solana/kit';
import * as OrcaWhirlpools from '@orca-so/whirlpools';
import { rpcFromUrl } from '@orca-so/tx-sender';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/signers';
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

let orcaWhirlpoolConfigPromise: Promise<void> | null = null;
let orcaRpcInstance: ReturnType<typeof rpcFromUrl> | null = null;
let orcaSignerCache: { pubkey: string; signer: any } | null = null;

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
    
    const coercePk = (val: any): PublicKey | undefined => {
      try {
        if (!val) return undefined;
        if (val instanceof PublicKey) return val;
        if (typeof val?.toBase58 === 'function') return new PublicKey(val.toBase58());
        if (Array.isArray(val)) return coercePk(val[0]);
        if (typeof val === 'string') return new PublicKey(val);
        if (typeof val?.publicKey === 'string') return new PublicKey(val.publicKey);
        if (val?.publicKey instanceof PublicKey) return val.publicKey;
        if (typeof val?.address === 'string') return new PublicKey(val.address);
        if (val?.address instanceof PublicKey) return val.address;
      } catch {}
      return undefined;
    };
    
    // Try primary method: getBinArrayAccountMetasCoverage with bounds
    // Note: Do NOT use large ranges - getBinArrayAccountMetasCoverage returns ALL arrays in range
    // For swaps, we only need a few bin arrays around the active bin
    try {
      const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId;
      const getMetas = (DLMM as any)?.getBinArrayAccountMetasCoverage;
      const binIdToBinArrayIndex = (DLMM as any)?.binIdToBinArrayIndex;
      
      if (getBounds && getMetas && binIdToBinArrayIndex) {
        const coverageFnArgCount = getMetas.length;
        if (coverageFnArgCount >= 4) {
          try {
        const bnjs = await import('bn.js').catch(() => null as any);
        const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
            if (BN) {
              // Try to get active bin from pool state to use a small range
              try {
                const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
                const poolState = await withRpcLimit(() => connection.getAccountInfo(poolPk)) as any;
                if (poolState?.data?.length) {
                  const decode = (DLMM as any)?.decodeAccount;
                  if (decode) {
                    const state = decode({ coder: (DLMM as any)?.coder ?? {} }, 'lbPair', poolState.data);
                    const activeId = state?.activeId;
                    if (activeId !== undefined) {
                      const activeBn = activeId instanceof BN ? activeId : new BN(String(activeId));
                      const idx = binIdToBinArrayIndex(activeBn);
                      const arrIdx = idx instanceof BN ? idx : new BN(String(idx));
                      // Get bounds for just the active bin array and adjacent ones
                      const [lower, upper] = getBounds(arrIdx);
                      // Use small range: active bin array +/- 1 bin array worth of bins
                      const binArraySize = (DLMM as any)?.MAX_BIN_ARRAY_SIZE ?? new BN(70);
                      const rangeLower = lower.sub(binArraySize);
                      const rangeUpper = upper.add(binArraySize);
                      const rawMetas = getMetas(rangeLower, rangeUpper, poolPk, programId) || [];
                      // Limit to max 10 bin arrays for swap safety
                      metas = rawMetas.slice(0, 10);
                    }
                  }
                }
              } catch {}
              // Fallback removed - don't use huge default ranges that return hundreds
            }
          } catch {}
        } else {
          try {
            metas = getMetas(poolPk, programId) || [];
            // Limit results if it's an array
            if (Array.isArray(metas)) metas = metas.slice(0, 10);
          } catch {}
        }
      }
    } catch (e: any) {
      try { logger.debug('meteora.dlmm.inject.bounds.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
    }
    
    // Fallback: try generic coverage helper (but limit results - can return hundreds)
    if (!metas || !metas.length) {
      try {
        const getCoverage = (DLMM as any)?.getBinArrayKeysCoverage || (DLMM as any)?.getBinArrayAccountMetasCoverage;
        if (getCoverage) {
          const cov = await getCoverage(programId, poolPk).catch(() => null as any) 
            || await getCoverage(connection, programId, poolPk).catch(() => null as any) 
            || await getCoverage({ programId, lbPair: poolPk }).catch(() => null as any);
          const raw = (cov && ((cov as any).metas || (cov as any).accountMetas)) || (Array.isArray(cov) ? cov : []);
          // Limit to max 10 bin arrays - getCoverage can return all bin arrays in pool
          metas = Array.isArray(raw) ? raw.slice(0, 10) : [];
        }
      } catch (e: any) {
        try { logger.debug('meteora.dlmm.inject.coverage.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
      }
    }
    
    // Ensure bitmap extension PDA meta is included
    try {
      let extPk = coercePk((DLMM as any)?.deriveBinArrayBitmapExtension?.(poolPk, programId));
      if (!extPk) {
        try {
          const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), poolPk.toBuffer()], programId);
          extPk = pda;
        } catch {}
      }
      if (extPk) {
        metas = metas || [];
        const hasExt = metas.some((m: any) => {
          try {
            const pk = coercePk(m?.pubkey || m?.publicKey || m?.address);
            return pk ? pk.equals(extPk) : false;
          } catch {
            return false;
          }
        });
        if (!hasExt) {
          metas.push({ pubkey: extPk, isWritable: true, isSigner: false });
        }
      }
    } catch {}
    
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
      
      // Safety limit - should already be limited but cap at 12 total (10 arrays + bitmap + overhead)
      const maxInjected = 12;
      const limitedMetas = metas.slice(0, maxInjected);
      
      let injected = 0;
      for (const m of limitedMetas) {
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
        try { logger.debug('meteora.dlmm.remaining.inject', { cat: 'tx', ctx: { added: injected } as any }); } catch {}
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

function safeCoercePublicKey(value: any): PublicKey | undefined {
  try {
    if (!value) return undefined;
    if (value instanceof PublicKey) return value;
    if (typeof value === 'object') {
      if (value instanceof Uint8Array) return coerceToPublicKey(value);
      if (value && typeof value.address === 'string') return coerceToPublicKey(value.address);
      if (Array.isArray(value) && value.length > 0) {
        try { return coerceToPublicKey(value[0]); } catch {}
      }
    }
    if (typeof value?.toBase58 === 'function') {
      const base58 = value.toBase58();
      return coerceToPublicKey(base58);
    }
    return coerceToPublicKey(value);
  } catch {
    return undefined;
  }
}

function toFlag(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'false':
      case '0':
      case 'no':
      case 'off':
      case '':
        return false;
      case 'true':
      case '1':
      case 'yes':
      case 'on':
        return true;
      default:
        return !!value;
    }
  }
  return !!value;
}

function toBuffer(data: any): Buffer {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return Buffer.alloc(0);
    const hexCandidate = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
    const isHex = /^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length % 2 === 0;
    try {
      return Buffer.from(trimmed, isHex ? 'hex' : 'base64');
    } catch {
      try {
        return Buffer.from(trimmed, 'base64');
      } catch {
        return Buffer.alloc(0);
      }
    }
  }
  if (typeof data === 'object' && data !== null) {
    if (Buffer.isBuffer((data as any).data) || (data as any).data instanceof Uint8Array || Array.isArray((data as any).data) || typeof (data as any).data === 'string') {
      return toBuffer((data as any).data);
    }
  }
  return Buffer.alloc(0);
}

function flattenToTransactionInstructions(value: any, hop: DirectHop): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];

  const visit = (item: any) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const inner of item) visit(inner);
      return;
    }
    if (item instanceof TransactionInstruction) {
      out.push(item);
      return;
    }
    if (typeof item?.compressIx === 'function') {
      try {
        const compressed = item.compressIx(true);
        if (compressed) {
          visit(compressed.instructions);
          visit(compressed.cleanupInstructions);
        }
        return;
      } catch (e: any) {
        try { logger.warn('orca.whirlpool.compressIx.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { pool: hop.poolId, error: String(e?.message || e) } }); } catch {}
        return;
      }
    }
    if (Array.isArray(item?.instructions)) {
      if (Array.isArray(item?.signers) && item.signers.length) {
        throw createBuilderError('ORCA', `whirlpool swap requires additional signers (count=${item.signers.length}); ensure all tick arrays/accounts exist on-chain`, hop);
      }
      visit(item.instructions);
      if (Array.isArray(item?.cleanupInstructions)) visit(item.cleanupInstructions);
      return;
    }
    if (typeof item?.instruction === 'object') {
      visit(item.instruction);
      return;
    }
    if (item.instructions instanceof Map) {
      visit(Array.from(item.instructions.values()));
      return;
    }

    if (typeof item === 'object') {
      try {
        const programIdRaw = item.programId
          || item.programAddress
          || (item.program && (item.program.programId || item.program.address || item.program))
          || item.address;
        const programId = safeCoercePublicKey(programIdRaw);
        if (!programId) {
          try { logger.warn('orca.whirlpool.ix.missing_program', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { pool: hop.poolId, kind: typeof programIdRaw } }); } catch {}
          return;
        }
    const rawKeys = Array.isArray(item.keys)
          ? item.keys
          : (Array.isArray(item.accounts) ? item.accounts : []);
        const keys = rawKeys
          .map((k: any) => {
            const pk = safeCoercePublicKey(
              k?.pubkey
                ?? k?.pubKey
                ?? k?.address
                ?? k?.publicKey
                ?? k?.pubkeyAddress
                ?? k?.pubKeyAddress
                ?? (k?.signer && (k.signer as any).address)
            );
            if (!pk) return undefined;
            const role = (typeof k?.role === 'number') ? Number(k.role) : undefined;
            const hasWritableFlag = Object.prototype.hasOwnProperty.call(k ?? {}, 'isWritable') || Object.prototype.hasOwnProperty.call(k ?? {}, 'writable');
            let isWritable: boolean | undefined = hasWritableFlag ? toFlag(k?.isWritable ?? k?.writable) : undefined;
            if (isWritable === undefined && role !== undefined) {
              isWritable = role === 1 || role === 3;
            }
            if (isWritable === undefined) isWritable = false;
            const hasSignerFlag = Object.prototype.hasOwnProperty.call(k ?? {}, 'isSigner');
            let isSigner: boolean | undefined = hasSignerFlag ? toFlag(k?.isSigner) : undefined;
            if (isSigner === undefined && k?.signer) isSigner = true;
            if (isSigner === undefined && role !== undefined) {
              isSigner = role === 2 || role === 3;
            }
            if (isSigner === undefined) isSigner = false;
            return {
              pubkey: pk,
              isSigner,
              isWritable,
            };
          })
          .filter((meta): meta is { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } => !!meta);
        const data = toBuffer(item.data ?? item.ixData ?? item.bytes ?? item.bytecode);
        out.push(new TransactionInstruction({ programId, keys, data }));
        return;
      } catch (coerceErr: any) {
        try { logger.warn('orca.whirlpool.coerce_ix.failed', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { pool: hop.poolId, error: String(coerceErr?.message || coerceErr) } }); } catch {}
        return;
      }
    }
  };

  visit(value);
  return out;
}

async function ensureOrcaSdkConfig(): Promise<void> {
  if (!orcaWhirlpoolConfigPromise) {
    orcaWhirlpoolConfigPromise = (async () => {
      try {
        const cfg = String((CONFIG.orca as any)?.configPubkey || '').trim();
        if (cfg && typeof OrcaWhirlpools.setWhirlpoolsConfig === 'function') {
          await OrcaWhirlpools.setWhirlpoolsConfig(address(cfg));
        }
      } catch (e: any) {
        try { logger.warn('orca.whirlpool.config.set.failed', { cat: 'tx', ctx: { error: String((e as any)?.message || e) } }); } catch {}
      }
      try { if (typeof OrcaWhirlpools.setNativeMintWrappingStrategy === 'function') OrcaWhirlpools.setNativeMintWrappingStrategy('ata'); } catch {}
    })();
  }
  await orcaWhirlpoolConfigPromise;
}

function getOrcaRpc() {
  if (!orcaRpcInstance) {
    const url = String(CONFIG.readRpcUrl || CONFIG.rpcUrl || '').trim();
    orcaRpcInstance = rpcFromUrl(url);
  }
  return orcaRpcInstance;
}

async function getOrcaSdkSigner(kp: { publicKey: PublicKey; secretKey: Uint8Array }) {
  const pk = kp.publicKey.toBase58();
  if (!orcaSignerCache || orcaSignerCache.pubkey !== pk) {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(kp.secretKey, false);
    orcaSignerCache = { pubkey: pk, signer };
  }
  return orcaSignerCache.signer;
}

async function buildOrcaSwapViaSdk(hop: DirectHop, kp: { publicKey: PublicKey; secretKey: Uint8Array }, slippageBps: number): Promise<{ instructions: TransactionInstruction[]; quote: any }> {
  await ensureOrcaSdkConfig();
  const rpc = getOrcaRpc();
  const signer = await getOrcaSdkSigner(kp);
  const poolAddr = address(String(hop.poolId));
  const inputMintAddr = address(String(hop.inputMint));
  const amountIn = BigInt(hop.amountInRaw ?? 0n);
  if (amountIn <= 0n) {
    throw createBuilderError('ORCA', 'input amount must be positive for swapInstructions', hop);
  }
  const params: any = { inputAmount: amountIn, mint: inputMintAddr };
  if (typeof OrcaWhirlpools.swapInstructions !== 'function') {
    throw createBuilderError('ORCA', 'swapInstructions not available in @orca-so/whirlpools', hop);
  }
  const result = await OrcaWhirlpools.swapInstructions(rpc, params, poolAddr, Math.max(0, Math.floor(slippageBps)), signer);
  const tradeEnableTs = result.tradeEnableTimestamp ?? 0n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (tradeEnableTs && tradeEnableTs > nowSec) {
    throw createBuilderError('ORCA', `trade disabled until ${tradeEnableTs.toString()}`, hop);
  }
  const sdkInstructions = Array.isArray(result.instructions) ? result.instructions : [];
  const converted: TransactionInstruction[] = [];
  for (const inst of sdkInstructions) {
    converted.push(...flattenToTransactionInstructions(inst, hop));
  }
  if (!converted.length) {
    throw createBuilderError('ORCA', 'swapInstructions produced no executable instructions', hop);
  }
  return { instructions: converted, quote: result.quote };
}

async function ensureWhirlpoolTickArrays(
  ctx: any,
  whirlpool: any,
  quote: any,
  payer: PublicKey,
  hop: DirectHop,
): Promise<TransactionInstruction[]> {
  try {
    if (!ctx || !whirlpool || !quote) return [];
    const requiredKeys: PublicKey[] = [];
    const requiredSet = new Set<string>();
    const addRequired = (val: any) => {
      if (!val) return;
      try {
        const pk = val instanceof PublicKey ? val : new PublicKey(val);
        const key = pk.toBase58();
        if (!requiredSet.has(key)) {
          requiredSet.add(key);
          requiredKeys.push(pk);
        }
      } catch {}
    };
    addRequired((quote as any)?.tickArray0);
    addRequired((quote as any)?.tickArray1);
    addRequired((quote as any)?.tickArray2);
    if (Array.isArray((quote as any)?.supplementalTickArrays)) {
      for (const extra of (quote as any).supplementalTickArrays) addRequired(extra);
    }
    if (!requiredKeys.length) return [];

    const { PDAUtil, WhirlpoolIx } = await import('@orca-so/whirlpools-sdk');
    const swapUtilsMod: any = await import('@orca-so/whirlpools-sdk/dist/utils/swap-utils.js').catch(() => null);
    const publicUtilsMod: any = await import('@orca-so/whirlpools-sdk/dist/utils/public/tick-utils.js').catch(() => null);
    const whirlpoolPk: PublicKey = whirlpool.getAddress ? whirlpool.getAddress() : new PublicKey(String((whirlpool as any)?.address || (whirlpool as any)?.publicKey));
    const data = whirlpool.getData ? whirlpool.getData() : undefined;
    if (!data) return [];
    const getter = swapUtilsMod?.getTickArrayPublicKeysWithStartTickIndex;
    let pathEntries: Array<{ pubkey: PublicKey; startTickIndex: number }> = [];
    if (typeof getter === 'function') {
      try {
        pathEntries = getter(
          Number(data.tickCurrentIndex),
          Number(data.tickSpacing),
          !!(quote as any)?.aToB,
          ctx.program.programId,
          whirlpoolPk,
        ) || [];
      } catch {}
    }
    const startIndexByAddress = new Map<string, number>();
    const registerEntry = (entry: { pubkey: PublicKey; startTickIndex: number }) => {
      if (!entry) return;
      try {
        startIndexByAddress.set(entry.pubkey.toBase58(), Number(entry.startTickIndex));
      } catch {}
    };
    if (Array.isArray(pathEntries) && pathEntries.length) {
      for (const entry of pathEntries) registerEntry(entry);
    } else {
      const tickUtil = publicUtilsMod?.TickUtil;
      if (tickUtil && typeof tickUtil.getStartTickIndex === 'function') {
        const tickSpacing = Number(data.tickSpacing);
        const current = Number(data.tickCurrentIndex);
        const aToB = !!(quote as any)?.aToB;
        const shift = aToB ? 0 : tickSpacing;
        let offset = 0;
        for (let i = 0; i < 12; i += 1) {
          try {
            const start = tickUtil.getStartTickIndex(current + shift, tickSpacing, offset);
            const pda = PDAUtil.getTickArray(ctx.program.programId, whirlpoolPk, start);
            if (pda?.publicKey) registerEntry({ pubkey: pda.publicKey, startTickIndex: start });
          } catch {}
          offset = aToB ? offset - 1 : offset + 1;
        }
      }
    }

    const infos = await ctx.connection.getMultipleAccountsInfo(requiredKeys);
    const missing: Array<{ pubkey: PublicKey; startTick: number }> = [];
    for (let i = 0; i < requiredKeys.length; i += 1) {
      if (infos[i]) continue;
      const pk = requiredKeys[i];
      const startTick = startIndexByAddress.get(pk.toBase58());
      if (startTick === undefined) {
        throw createBuilderError('ORCA', `missing tick array ${pk.toBase58()} but unable to derive start tick`, hop);
      }
      missing.push({ pubkey: pk, startTick });
    }
    if (!missing.length) return [];

    const instructions: TransactionInstruction[] = [];
    for (const item of missing) {
      try {
        const tickArrayPda = PDAUtil.getTickArray(ctx.program.programId, whirlpoolPk, item.startTick);
        const ix = WhirlpoolIx.initTickArrayIx(ctx.program, {
          whirlpool: whirlpoolPk,
          tickArrayPda,
          startTick: item.startTick,
          funder: payer,
        });
        instructions.push(...flattenToTransactionInstructions(ix, hop));
        try {
          logger.debug('orca.whirlpool.tickarray.init', {
            cat: 'tx',
            ctx: { pool: whirlpoolPk.toBase58(), tickArray: item.pubkey.toBase58(), startTick: item.startTick },
          });
        } catch {}
      } catch (e: any) {
        throw createBuilderError('ORCA', `failed to build tick array init for ${item.pubkey.toBase58()}: ${String((e as any)?.message || e)}`, hop);
      }
    }
    return instructions;
  } catch (e) {
    if (e instanceof Error && e.message.includes('ORCA_BUILD_FAILED')) throw e;
    throw createBuilderError('ORCA', `tick array preparation failed: ${String((e as any)?.message || e)}`, hop);
  }
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
  try { logger.debug('ix.build orca.clmm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
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
        // Use account cache instead of direct RPC call
        const { accountCache } = await import('../utils/accountCache.js');
        const acc = await accountCache.getAccountInfo(pk);
        const ParsableWhirlpool = (sdkAny as any).ParsableWhirlpool;
        const parsed = acc ? (ParsableWhirlpool as any).parse(pk, acc) : null;
        if (parsed) {
          const mintA = parsed.tokenMintA?.toBase58?.();
          const mintB = parsed.tokenMintB?.toBase58?.();
          const inMint = String(hop.inputMint);
          try { logger.debug('orca.whirlpool.pool.tokens', { cat: 'tx', ctx: { pool: String(hop.poolId), mintA, mintB, inputMint: inMint } }); } catch {}
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
    
    // Calculate slippage from the configured value, not by comparing minOutRaw to amountInRaw
    // (which are in different tokens with different decimals and can't be directly compared)
    // Use the configured slippage from CONFIG or default to 100 bps (1%)
    // This ensures consistency with the slippage used during resolution
    const configuredSlippageBps = typeof (CONFIG as any)?.fees?.slippageBps === 'number' 
      ? (CONFIG as any).fees.slippageBps 
      : (typeof (CONFIG as any)?.system?.slippageBpsDefault === 'number'
          ? (CONFIG as any).system.slippageBpsDefault
          : 100);
    
    // Ensure slippage is within reasonable bounds (1-500 bps = 0.01% to 5%)
    // Too small slippage causes the threshold to be too high and swaps fail
    // Too large slippage is unsafe
    let slippageBps = Math.max(1, Math.min(500, configuredSlippageBps));
    
    try {
      logger.debug('orca.whirlpool.slippage', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          configuredSlippageBps,
          finalSlippageBps: slippageBps,
          amountInRaw: String(hop.amountInRaw ?? 0n),
          minOutRaw: String(hop.minOutRaw ?? 0n),
        }
      });
    } catch {}
    
    try {
      const sdkResult = await buildOrcaSwapViaSdk(hop, kp, slippageBps);
      const quoteAny = sdkResult.quote as any;
      const estOut = quoteAny?.tokenEstOut ?? quoteAny?.tokenMinOut ?? quoteAny?.estimatedAmountOut ?? null;
      
      // For multihop with exact amounts, verify the SDK used the exact input amount
      if (hop.useExactAmount && hop.amountInRaw > 0n) {
        const quoteInputAmount = BigInt((quoteAny?.inputAmount ?? quoteAny?.tokenAmountIn ?? 0));
        if (quoteInputAmount > 0n && quoteInputAmount !== hop.amountInRaw) {
          try {
            logger.warn('orca.whirlpool.exact_amount.mismatch', {
              cat: 'tx',
              code: LogCode.TX_BUILD_ERR,
              ctx: {
                pool: hop.poolId,
                expectedInput: hop.amountInRaw.toString(),
                quoteInput: quoteInputAmount.toString(),
                difference: (quoteInputAmount > hop.amountInRaw 
                  ? (quoteInputAmount - hop.amountInRaw).toString() 
                  : (hop.amountInRaw - quoteInputAmount).toString()),
                mode: 'swapInstructions',
              }
            });
          } catch {}
        } else if (quoteInputAmount === hop.amountInRaw) {
          try {
            logger.debug('orca.whirlpool.exact_amount.verified', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                exactInput: hop.amountInRaw.toString(),
                mode: 'swapInstructions',
              }
            });
          } catch {}
        }
      }
      
      if (estOut !== null && estOut !== undefined) {
        try { logger.debug('orca.whirlpool.quote.ok', { cat: 'tx', ctx: { estimatedOutRaw: String(estOut), mode: 'swapInstructions' } as any }); } catch {}
      }
      try { logger.debug('orca.whirlpool.ix.ready', { cat: 'tx', ctx: { count: sdkResult.instructions.length, mode: 'swapInstructions' } as any }); } catch {}
      return sdkResult.instructions;
    } catch (sdkErr) {
      const msg = String((sdkErr as any)?.message || sdkErr);
      if (msg.includes('ORCA_BUILD_FAILED')) {
        throw sdkErr;
      }
      try { logger.warn('orca.whirlpool.swapInstructions.fallback', { cat: 'tx', ctx: { pool: hop.poolId, error: msg } as any }); } catch {}
    }
    
    // Use context-based SDK approach instead of global state
    try {
      const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = await import('@orca-so/whirlpools-sdk');
      const { Percentage } = await import('@orca-so/common-sdk');
      const { PublicKey } = await import('@solana/web3.js');
      const BN = (await import('bn.js')).default as any;
      
      const programId = new PublicKey((CONFIG as any).orca.programId);
      
      // Create context per operation (no global state)
      const ctx = (WhirlpoolContext as any).from(
        connection,
        { publicKey: kp.publicKey },
        programId,
        undefined,
        undefined,
        {
          accountResolverOptions: {
            createWrappedSolAccountMethod: 'ata',
            allowPDAOwnerAddress: true,
          },
        },
      );
      const client = (buildWhirlpoolClient as any)(ctx);
      const pool = await client.getPool(new PublicKey(poolAddr));
      
      const slippage = (Percentage as any).fromFraction(slippageBps, 10_000);
      const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
      
      // Log exact amount usage for multihop debugging
      const isExactAmount = hop.useExactAmount || false;
      try { 
        logger.debug('orca.whirlpool.quote', { 
          cat: 'tx', 
          ctx: { 
            pool: poolAddr, 
            inputMint, 
            amountIn: String(hop.amountInRaw ?? 0n), 
            slippageBps,
            useExactAmount: isExactAmount,
            quotedOutputRaw: hop.quotedOutputRaw?.toString() || 'N/A',
          } 
        }); 
      } catch {}
      
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
      
      // For exact amount multihop, verify the quote used the exact input
      if (isExactAmount && hop.amountInRaw > 0n) {
        const quoteInputAmount = BigInt((quote as any)?.inputAmount ?? (quote as any)?.tokenAmountIn ?? 0);
        if (quoteInputAmount > 0n && quoteInputAmount !== hop.amountInRaw) {
          try {
            logger.warn('orca.whirlpool.exact_amount.quote_mismatch', {
              cat: 'tx',
              code: LogCode.TX_BUILD_ERR,
              ctx: {
                pool: poolAddr,
                expectedInput: hop.amountInRaw.toString(),
                quoteInput: quoteInputAmount.toString(),
                difference: (quoteInputAmount > hop.amountInRaw 
                  ? (quoteInputAmount - hop.amountInRaw).toString() 
                  : (hop.amountInRaw - quoteInputAmount).toString()),
                mode: 'swapQuoteByInputToken',
              }
            });
          } catch {}
        }
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
      
      const preIx = await ensureWhirlpoolTickArrays(ctx, pool, quote, kp.publicKey, hop);
      
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
      
      const instructions = [...preIx, ...flattenToTransactionInstructions(swapIx, hop)];
      if (!instructions.length) {
        throw createBuilderError('ORCA', 'swap builder returned no executable instructions', hop);
      }

      try { logger.debug('orca.whirlpool.ix.ready', { cat: 'tx', ctx: { count: instructions.length } }); } catch {}
      return instructions;
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
  try {
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
          try { logger.debug('meteora.dlmm.import.ok', { cat: 'tx', ctx: { spec, keys: Object.keys(mod || {}) } }); } catch {}
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
          try { logger.debug('meteora.dlmm.import.ok', { cat: 'tx', ctx: { spec: '@meteora-ag/dlmm/ts-client' } }); } catch {}
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
      try { logger.debug('meteora.dlmm.swapIx.call', { cat: 'tx' }); } catch {}
      const ix = await (DLMM as any).swapIx(connection, kp.publicKey, params);
      if (ix) {
        // Safety net: attempt to attach remaining bin-array metas when using fast-path ix
        await injectBinArrayMetas(ix, DLMM, connection, poolPk, programId);
        try { logger.debug('meteora.dlmm.swapIx.ok', { cat: 'tx' }); } catch {}
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
    try { logger.debug('meteora.dlmm.program.ok', { cat: 'tx' }); } catch {}

    // Derive optional accounts
    let binArrayLower: PublicKey | undefined = hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined;
    let binArrayUpper: PublicKey | undefined = hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined;
    let binArrayBitmapExtension: PublicKey | undefined = undefined;
    let binArrayMetas: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> | null = null;
    
    // Always derive bitmap extension first (required account)
    try {
      const deriveBinArrayBitmapExtension = (DLMM as any)?.deriveBinArrayBitmapExtension || (mod as any)?.deriveBinArrayBitmapExtension;
      if (deriveBinArrayBitmapExtension) {
        try {
          const derivedExt = deriveBinArrayBitmapExtension(poolPk, programId);
          const extPk = Array.isArray(derivedExt) ? derivedExt[0] : derivedExt;
          binArrayBitmapExtension = extPk instanceof PublicKey ? extPk : new PublicKey(String(extPk));
        } catch {}
      }
      if (!binArrayBitmapExtension) {
        // Fallback: deterministic PDA derivation
        const [extPda] = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), poolPk.toBuffer()], programId);
        binArrayBitmapExtension = extPda;
      }
    } catch {
      // Last resort: derive PDA directly
      try {
        const [extPda] = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), poolPk.toBuffer()], programId);
        binArrayBitmapExtension = extPda;
      } catch {}
    }
    
    try {
      const deriveBinArray = (DLMM as any)?.deriveBinArray || (mod as any)?.deriveBinArray;
      const binIdToBinArrayIndex = (DLMM as any)?.binIdToBinArrayIndex || (mod as any)?.binIdToBinArrayIndex;
      
      // Derive bin arrays using active bin ID if lower/upper not provided
      // IMPORTANT: Only set these if we can verify the accounts exist on-chain
      // Deriving PDAs without verification causes AccountDiscriminatorMismatch errors
      if ((!binArrayLower || !binArrayUpper) && deriveBinArray && binIdToBinArrayIndex) {
        const bnjs = await import('bn.js').catch(() => null as any);
        const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
        if (BN) {
          let activeBinId: any = null;
          if (typeof hop.activeId === 'number') {
            activeBinId = new BN(String(hop.activeId));
          }
          
          // Fetch pool state to get active bin if not in hop
          if (!activeBinId) {
            try {
              const poolState = await program.account.lbPair.fetch(poolPk);
              const stateActive = poolState?.activeId;
              if (stateActive) {
                if (stateActive instanceof BN) activeBinId = stateActive;
                else if (typeof stateActive === 'object' && typeof stateActive.toString === 'function') {
                  activeBinId = new BN(stateActive.toString());
                } else if (typeof stateActive === 'number') {
                  activeBinId = new BN(String(stateActive));
                }
              }
            } catch {}
          }
          
          if (activeBinId) {
            try {
              const binArrayIdx = binIdToBinArrayIndex(activeBinId);
              if (binArrayIdx instanceof BN || (binArrayIdx && typeof binArrayIdx === 'object')) {
                const idx = binArrayIdx instanceof BN ? binArrayIdx : new BN(String(binArrayIdx));
                // Derive bin arrays around active bin and verify they exist
                const indices = [idx, idx.add(new BN(1)), idx.sub(new BN(1))];
                for (const arrIdx of indices) {
                  try {
                    const derived = deriveBinArray(poolPk, arrIdx, programId);
                    const pk = Array.isArray(derived) ? derived[0] : derived;
                    const finalPk = pk instanceof PublicKey ? pk : new PublicKey(String(pk));
        
                    // Verify account exists on-chain before including it
          try {
                      const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
                      const accInfo = await withRpcLimit(() => connection.getAccountInfo(finalPk));
                      if (accInfo && accInfo.data && accInfo.data.length > 0) {
                        // Account exists, safe to include
                        if (!binArrayLower) binArrayLower = finalPk;
                        if (!binArrayUpper && !finalPk.equals(binArrayLower)) binArrayUpper = finalPk;
                        if (binArrayLower && binArrayUpper) break;
                      }
                    } catch {
                      // Account doesn't exist or error fetching - skip it
            }
          } catch {}
                }
              }
            } catch {}
          }
        }
      }

      const coverageMetas: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> = [];
      const coverageSet = new Set<string>();
      const pushMeta = (val: any, writable = true) => {
          try {
          if (!val) return;
          let pk: PublicKey | null = null;
          if (val instanceof PublicKey) pk = val;
          else if (typeof val === 'string') pk = new PublicKey(val);
          else if (typeof val?.toBase58 === 'function') pk = new PublicKey(val.toBase58());
          else if (val?.publicKey instanceof PublicKey) pk = val.publicKey;
          else if (typeof val?.publicKey === 'string') pk = new PublicKey(val.publicKey);
          else if (val?.address instanceof PublicKey) pk = val.address;
          else if (typeof val?.address === 'string') pk = new PublicKey(val.address);
          if (!pk) return;
          const key = pk.toBase58();
          if (coverageSet.has(key)) return;
          coverageSet.add(key);
          coverageMetas.push({ pubkey: pk, isWritable: writable, isSigner: false });
        } catch {}
      };

      try { if (binArrayLower) pushMeta(binArrayLower); } catch {}
      try { if (binArrayUpper) pushMeta(binArrayUpper); } catch {}

      let lbPairState: any = null;
      try { lbPairState = await program.account.lbPair.fetch(poolPk); } catch {}

      // Note: Do NOT manually derive bin arrays here - we need to verify they exist on-chain
      // The SDK's getBinArrayAccountMetasCoverage will return only the bin arrays that are
      // needed for the swap path. Manual derivation can include non-existent PDAs which
      // causes AccountDiscriminatorMismatch errors.
      // Let the SDK determine required bin arrays via remainingAccounts (below).

      // Always include bitmap extension in coverage metas - but verify it first
      if (binArrayBitmapExtension) {
        // CRITICAL FIX: Verify account exists and is owned by correct program before including
        try {
          const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
          const acc = await withRpcLimit(() => connection.getAccountInfo(binArrayBitmapExtension)).catch(() => null);
          if (acc && acc.owner && typeof acc.owner.equals === 'function' && acc.owner.equals(programId)) {
            // Account exists and is owned by correct program - include it
            pushMeta(binArrayBitmapExtension);
          } else {
            // Account doesn't exist or has wrong owner - exclude it
            try { 
              logger.warn('meteora.dlmm.inject.ext.excluding', { 
                cat: 'tx', 
                ctx: { 
                  address: binArrayBitmapExtension.toBase58(),
                  exists: !!acc,
                  owner: acc?.owner?.toBase58?.() || 'none',
                  expected: programId.toBase58()
                } 
              }); 
            } catch {}
          }
        } catch {
          // If verification fails, exclude it to be safe
          try { logger.warn('meteora.dlmm.inject.ext.verification_failed', { cat: 'tx' }); } catch {}
        }
      }

      binArrayMetas = coverageMetas.length ? coverageMetas : null;
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
    
    // Log token account details for debugging
    try {
      logger.debug('meteora.dlmm.accounts.detail', { 
        cat: 'tx', 
        ctx: {
          userTokenIn: accounts.userTokenIn.toBase58(),
          userTokenOut: accounts.userTokenOut.toBase58(),
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          poolId: hop.poolId
        } 
      });
    } catch {}
    
    // Validate token accounts - batch fetch both at once to reduce RPC calls
    let tokenInfos: any[] | null = null;
    try {
      const userTokenInPk = toPublicKey(hop.userSourceAta);
      const expectedInputMint = toPublicKey(hop.inputMint);
      const userTokenOutPk = toPublicKey(hop.userDestAta);
      const expectedMint = toPublicKey(hop.outputMint);
      
      // Always derive the correct ATAs to verify, even if accounts don't exist yet
      const { deriveAta } = await import('../accounts.js');
      const correctAtaIn = deriveAta(kp.publicKey, expectedInputMint, hop.inputTokenProgram);
      const correctAtaOut = deriveAta(kp.publicKey, expectedMint, hop.outputTokenProgram);
      
      // Check if the ATA addresses match what we expect
      if (!userTokenInPk.equals(correctAtaIn)) {
        try { 
          logger.warn('meteora.dlmm.userTokenIn.address_mismatch', { 
            cat: 'tx', 
            ctx: { 
              userTokenIn: userTokenInPk.toBase58(),
              correctAta: correctAtaIn.toBase58(),
              expectedMint: expectedInputMint.toBase58(),
              inputMint: hop.inputMint,
              inputTokenProgram: hop.inputTokenProgram
            } 
          }); 
        } catch {}
        accounts.userTokenIn = correctAtaIn;
        try { 
          logger.debug('meteora.dlmm.userTokenIn.corrected', { 
            cat: 'tx', 
            ctx: { 
              old: userTokenInPk.toBase58(),
              new: correctAtaIn.toBase58(),
              mint: expectedInputMint.toBase58()
            } 
          }); 
        } catch {}
      }
      
      if (!userTokenOutPk.equals(correctAtaOut)) {
        try { 
          logger.warn('meteora.dlmm.userTokenOut.address_mismatch', { 
            cat: 'tx', 
            ctx: { 
              userTokenOut: userTokenOutPk.toBase58(),
              correctAta: correctAtaOut.toBase58(),
              expectedMint: expectedMint.toBase58(),
              outputMint: hop.outputMint,
              outputTokenProgram: hop.outputTokenProgram
            } 
          }); 
        } catch {}
        accounts.userTokenOut = correctAtaOut;
        try { 
          logger.debug('meteora.dlmm.userTokenOut.corrected', { 
            cat: 'tx', 
            ctx: { 
              old: userTokenOutPk.toBase58(),
              new: correctAtaOut.toBase58(),
              mint: expectedMint.toBase58()
            } 
          }); 
        } catch {}
      }
      
      // Batch fetch both token accounts at once to reduce RPC calls
      const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
      const tokenAccountsToCheck: PublicKey[] = [userTokenInPk, userTokenOutPk];
      const weight = Math.max(1, Math.ceil(tokenAccountsToCheck.length / 5));
      tokenInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(tokenAccountsToCheck),
        weight
      ).catch(() => null);
      
      // Process input token account result
      if (tokenInfos && tokenInfos.length >= 1) {
        const tokenInInfo = tokenInfos[0];
        if (tokenInInfo?.data && tokenInInfo.data.length >= 32) {
          const mintBytes = tokenInInfo.data.slice(0, 32);
          try {
            const accountMint = new PublicKey(mintBytes);
            if (!accountMint.equals(expectedInputMint)) {
              try { 
                logger.warn('meteora.dlmm.userTokenIn.mint_mismatch', { 
                  cat: 'tx', 
                  ctx: { 
                    userTokenIn: userTokenInPk.toBase58(),
                    accountMint: accountMint.toBase58(),
                    expectedMint: expectedInputMint.toBase58(),
                    inputMint: hop.inputMint
                  } 
                }); 
              } catch {}
              accounts.userTokenIn = correctAtaIn;
              try { 
                logger.debug('meteora.dlmm.userTokenIn.mint_corrected', { 
                  cat: 'tx', 
                  ctx: { 
                    old: userTokenInPk.toBase58(),
                    new: correctAtaIn.toBase58(),
                    mint: expectedInputMint.toBase58()
                  } 
                }); 
              } catch {}
            }
          } catch (parseErr) {
            accounts.userTokenIn = correctAtaIn;
          }
        }
      }
      
      // Process output token account result
      if (tokenInfos && tokenInfos.length >= 2) {
        const tokenOutInfo = tokenInfos[1];
        if (tokenOutInfo?.data && tokenOutInfo.data.length >= 32) {
          const mintBytes = tokenOutInfo.data.slice(0, 32);
          try {
            const accountMint = new PublicKey(mintBytes);
            if (!accountMint.equals(expectedMint)) {
              try { 
                logger.warn('meteora.dlmm.userTokenOut.mint_mismatch', { 
                  cat: 'tx', 
                  ctx: { 
                    userTokenOut: userTokenOutPk.toBase58(),
                    accountMint: accountMint.toBase58(),
                    expectedMint: expectedMint.toBase58(),
                    outputMint: hop.outputMint
                  } 
                }); 
              } catch {}
              accounts.userTokenOut = correctAtaOut;
              try { 
                logger.debug('meteora.dlmm.userTokenOut.mint_corrected', { 
                  cat: 'tx', 
                  ctx: { 
                    old: userTokenOutPk.toBase58(),
                    new: correctAtaOut.toBase58(),
                    mint: expectedMint.toBase58()
                  } 
                }); 
              } catch {}
            }
          } catch (parseErr) {
            accounts.userTokenOut = correctAtaOut;
          }
        }
      }
    } catch (validateErr) {
      // Non-fatal: log but continue
      try { 
        logger.debug('meteora.dlmm.token.validation.failed', { 
          cat: 'tx', 
          ctx: { error: String((validateErr as any)?.message || validateErr) } 
        }); 
      } catch {}
    }
    
    if (binArrayLower) accounts.binArrayLower = binArrayLower;
    if (binArrayUpper) accounts.binArrayUpper = binArrayUpper;
    // Always include the bitmap extension PDA (required account)
    if (!binArrayBitmapExtension) {
      // Last resort: ensure it's always set
      const [extPda] = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), poolPk.toBuffer()], programId);
      binArrayBitmapExtension = extPda;
    }
    
    // CRITICAL FIX: Verify bitmap extension account exists and is owned by correct program
    // before including it in accounts. If it doesn't exist or has wrong owner, exclude it.
    let shouldIncludeBitmapExtension = false;
    try {
      if (binArrayBitmapExtension) {
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const acc = await withRpcLimit(() => connection.getAccountInfo(binArrayBitmapExtension));
        if (acc && acc.owner && typeof acc.owner.equals === 'function') {
          if (acc.owner.equals(programId)) {
            shouldIncludeBitmapExtension = true;
            try { logger.info('meteora.dlmm.ext.verified', { cat: 'tx', ctx: { address: binArrayBitmapExtension.toBase58(), owner: acc.owner.toBase58() } }); } catch {}
          } else {
            // Account exists but owned by wrong program - exclude it
            try { 
              logger.warn('meteora.dlmm.ext.owner_mismatch.excluding', { 
                cat: 'tx', 
                code: LogCode.TX_BUILD_ERR, 
                ctx: { 
                  address: binArrayBitmapExtension.toBase58(),
                  owner: acc.owner?.toBase58?.(), 
                  expected: programId?.toBase58?.() 
                } 
              }); 
            } catch {}
            binArrayBitmapExtension = undefined;
          }
        } else if (!acc) {
          // Account doesn't exist - might need initialization, but don't include in swap instruction
          try { 
            logger.warn('meteora.dlmm.ext.missing_on_chain.excluding', { 
              cat: 'tx', 
              code: LogCode.TX_BUILD_ERR, 
              ctx: { expected: programId?.toBase58?.() } 
            }); 
          } catch {}
          binArrayBitmapExtension = undefined;
        }
      }
    } catch (e: any) {
      // If we can't verify, err on the side of caution and exclude it
      try { 
        logger.warn('meteora.dlmm.ext.verification_failed.excluding', { 
          cat: 'tx', 
          code: LogCode.TX_BUILD_ERR, 
          ctx: { error: String(e?.message || e) } 
        }); 
      } catch {}
      binArrayBitmapExtension = undefined;
    }
    
    // Only include bitmap extension if verified
    if (binArrayBitmapExtension && shouldIncludeBitmapExtension) {
      accounts.binArrayBitmapExtension = binArrayBitmapExtension;
    } else {
      // Remove from accounts if it was set
      delete accounts.binArrayBitmapExtension;
    }
    
    // Also remove from coverageMetas if it was added there
    try {
      if (binArrayMetas && Array.isArray(binArrayMetas)) {
        const extPkStr = binArrayBitmapExtension?.toBase58();
        if (extPkStr) {
          binArrayMetas = binArrayMetas.filter((m: any) => {
            try {
              const pk = m?.pubkey || m?.publicKey || m?.address;
              const pkStr = pk instanceof PublicKey ? pk.toBase58() : (typeof pk === 'string' ? pk : String(pk));
              return pkStr !== extPkStr;
            } catch {
              return true;
            }
          });
        }
      }
    } catch {}
    
    // Note: Initialization logic removed - if account doesn't exist or has wrong owner,
    // it's already excluded above. Initialization should be handled in a separate transaction.
    // The account is only included if it exists and is owned by the correct program.

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
        const mints = await getTokensMintFromPoolAddress(connection, poolPk).catch((e: any) => {
          // Log fetch failure
          try {
            logger.error('meteora.dlmm.pool_mint_fetch.failed', {
              cat: 'tx',
              code: LogCode.TX_BUILD_ERR,
              ctx: {
                poolId: hop.poolId,
                error: String(e?.message || e)
              }
            });
          } catch {}
          return null;
        });
        
        if (!mints) {
          // Pool fetch failed - this is critical, fail fast
          throw createBuilderError('METEORA_DLMM', `Failed to fetch token mints for pool ${hop.poolId}`, hop);
        }
        
        const x = (mints as any)?.tokenXMint || (mints as any)?.x || (mints as any)?.a;
        const y = (mints as any)?.tokenYMint || (mints as any)?.y || (mints as any)?.b;
        
        if (!x || !y) {
          // Mints not found in response
          throw createBuilderError('METEORA_DLMM', `Pool ${hop.poolId} response missing token mints`, hop);
        }
        
        acctBase.tokenXMint = (x as any).publicKey || x;
        acctBase.tokenYMint = (y as any).publicKey || y;
        
        // CRITICAL: Validate swap direction - fail fast if mismatch
        const inputMintPk = toPublicKey(hop.inputMint);
        const outputMintPk = toPublicKey(hop.outputMint);
        const tokenXMintPk = acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint);
        const tokenYMintPk = acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint);
        
        const isXToY = inputMintPk.equals(tokenXMintPk) && outputMintPk.equals(tokenYMintPk);
        const isYToX = inputMintPk.equals(tokenYMintPk) && outputMintPk.equals(tokenXMintPk);
        
        if (!isXToY && !isYToX) {
          // POOL MISMATCH - this is the root cause
          logger.error('meteora.dlmm.pool_mismatch', {
            cat: 'tx',
            code: LogCode.TX_BUILD_ERR,
            ctx: {
              poolId: hop.poolId,
              inputMint: hop.inputMint,
              outputMint: hop.outputMint,
              poolTokenXMint: tokenXMintPk.toBase58(),
              poolTokenYMint: tokenYMintPk.toBase58(),
              message: `Pool ${hop.poolId} contains ${tokenXMintPk.toBase58()}/${tokenYMintPk.toBase58()} but swap requires ${hop.inputMint}/${hop.outputMint}`
            }
          });
          throw createBuilderError('METEORA_DLMM', `Pool ${hop.poolId} token mints (${tokenXMintPk.toBase58()}/${tokenYMintPk.toBase58()}) do not match swap direction (${hop.inputMint}/${hop.outputMint})`, hop);
        }
        
        // Log success
        logger.info('meteora.dlmm.swap_direction', {
          cat: 'tx',
          ctx: {
            direction: isXToY ? 'X->Y' : 'Y->X',
            inputMint: hop.inputMint,
            outputMint: hop.outputMint,
            tokenXMint: tokenXMintPk.toBase58(),
            tokenYMint: tokenYMintPk.toBase58(),
            poolId: hop.poolId
          }
        });
      } else {
        // SDK doesn't have getTokensMintFromPoolAddress - this is a problem
        logger.warn('meteora.dlmm.sdk_missing_getTokensMintFromPoolAddress', {
          cat: 'tx',
          ctx: { poolId: hop.poolId }
        });
      }
    } catch (e: any) {
      // Re-throw validation/configuration errors
      if (e?.code === 'METEORA_DLMM' || (typeof e?.message === 'string' && (
        e.message.includes('Swap direction') || 
        e.message.includes('token mints') ||
        e.message.includes('Failed to fetch')
      ))) {
        throw e;
      }
      // Log other errors but don't fail (might be network issues)
      try { 
        logger.debug('meteora.dlmm.token_mint_fetch.failed', { 
          cat: 'tx', 
          ctx: { error: String(e?.message || e) } 
        }); 
      } catch {}
    }
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

    // CRITICAL FIX: Ensure token mints are explicitly set before building instruction
    // This prevents the SDK from using incorrect/cached mints from previous swaps
    try {
      if (!acctBase.tokenXMint || !acctBase.tokenYMint) {
        const inputMintPk = toPublicKey(hop.inputMint);
        const outputMintPk = toPublicKey(hop.outputMint);
        const tokenXMintPk = acctBase.tokenXMint ? (acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint)) : null;
        const tokenYMintPk = acctBase.tokenYMint ? (acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint)) : null;
        
        // If pool mints are available, verify direction and use them
        if (tokenXMintPk && tokenYMintPk) {
          const isXToY = inputMintPk.equals(tokenXMintPk) && outputMintPk.equals(tokenYMintPk);
          const isYToX = inputMintPk.equals(tokenYMintPk) && outputMintPk.equals(tokenXMintPk);
          
          if (isXToY || isYToX) {
            // Pool mints match swap direction - use them
            acctBase.tokenXMint = tokenXMintPk;
            acctBase.tokenYMint = tokenYMintPk;
          } else {
            // Mismatch - log warning but use pool mints anyway (swap direction validation will catch this)
            try {
              logger.warn('meteora.dlmm.token_mint_mismatch_fallback', {
                cat: 'tx',
                ctx: {
                  inputMint: hop.inputMint,
                  outputMint: hop.outputMint,
                  tokenXMint: tokenXMintPk.toBase58(),
                  tokenYMint: tokenYMintPk.toBase58()
                }
              });
            } catch {}
            acctBase.tokenXMint = tokenXMintPk;
            acctBase.tokenYMint = tokenYMintPk;
          }
        } else {
          // Fallback: use hop mints directly (shouldn't happen if pool fetch worked)
          try {
            logger.warn('meteora.dlmm.token_mint_fallback', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                inputMint: hop.inputMint,
                outputMint: hop.outputMint
              }
            });
          } catch {}
          // Don't set tokenXMint/tokenYMint from hop mints - let the SDK derive from pool
          // Setting them incorrectly could cause the "Invalid token mint" error
        }
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
    // Ensure tokenXMint and tokenYMint are explicitly included in acctBase
    // CRITICAL: Log acctBase before passing to SDK to debug token mint issues
    try {
      logger.info('meteora.dlmm.acctBase.before_sdk', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          tokenXMint: acctBase.tokenXMint ? (acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint.toBase58() : String(acctBase.tokenXMint)) : 'missing',
          tokenYMint: acctBase.tokenYMint ? (acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint.toBase58() : String(acctBase.tokenYMint)) : 'missing',
          userTokenIn: acctBase.userTokenIn ? (acctBase.userTokenIn instanceof PublicKey ? acctBase.userTokenIn.toBase58() : String(acctBase.userTokenIn)) : 'missing',
          userTokenOut: acctBase.userTokenOut ? (acctBase.userTokenOut instanceof PublicKey ? acctBase.userTokenOut.toBase58() : String(acctBase.userTokenOut)) : 'missing'
        }
      });
    } catch {}
    
    if (typeof (builder as any).accountsPartial === 'function') builder = (builder as any).accountsPartial(acctBase);
    else if (typeof (builder as any).accounts === 'function') builder = (builder as any).accounts(acctBase);

    // Final validation: ensure userTokenIn and userTokenOut are correct before building instruction
    // This catches cases where the SDK might have modified accounts
    let accountsWereCorrected = false;
    try {
      const { deriveAta } = await import('../accounts.js');
      
      // Validate userTokenIn
      const finalUserTokenIn = acctBase.userTokenIn || accounts.userTokenIn;
      if (finalUserTokenIn) {
        const expectedInputMint = toPublicKey(hop.inputMint);
        const correctInputAta = deriveAta(kp.publicKey, expectedInputMint, hop.inputTokenProgram);
        const finalInPk = finalUserTokenIn instanceof PublicKey ? finalUserTokenIn : toPublicKey(finalUserTokenIn);
        
        if (!finalInPk.equals(correctInputAta)) {
          try { 
            logger.warn('meteora.dlmm.userTokenIn.final_mismatch', { 
              cat: 'tx', 
              ctx: { 
                finalUserTokenIn: finalInPk.toBase58(),
                correctAta: correctInputAta.toBase58(),
                expectedMint: expectedInputMint.toBase58(),
                inputMint: hop.inputMint
              } 
            }); 
          } catch {}
          
          acctBase.userTokenIn = correctInputAta;
          accounts.userTokenIn = correctInputAta;
          accountsWereCorrected = true;
        }
      }
      
      // Validate userTokenOut
      const finalUserTokenOut = acctBase.userTokenOut || accounts.userTokenOut;
      if (finalUserTokenOut) {
        const expectedMint = toPublicKey(hop.outputMint);
        const correctAta = deriveAta(kp.publicKey, expectedMint, hop.outputTokenProgram);
        const finalOutPk = finalUserTokenOut instanceof PublicKey ? finalUserTokenOut : toPublicKey(finalUserTokenOut);
        
        if (!finalOutPk.equals(correctAta)) {
          try { 
            logger.warn('meteora.dlmm.userTokenOut.final_mismatch', { 
              cat: 'tx', 
              ctx: { 
                finalUserTokenOut: finalOutPk.toBase58(),
                correctAta: correctAta.toBase58(),
                expectedMint: expectedMint.toBase58(),
                outputMint: hop.outputMint
              } 
            }); 
          } catch {}
          
          // Force correct ATA in accounts
          acctBase.userTokenOut = correctAta;
          accounts.userTokenOut = correctAta;
          accountsWereCorrected = true;
          
          try { 
            logger.info('meteora.dlmm.userTokenOut.final_corrected', { 
              cat: 'tx', 
              ctx: { 
                old: finalOutPk.toBase58(),
                new: correctAta.toBase58(),
                mint: expectedMint.toBase58()
              } 
            }); 
          } catch {}
        }
      }
      
      // Re-apply accounts if any corrections were made
      if (accountsWereCorrected) {
        try {
          if (typeof (builder as any).accountsPartial === 'function') {
            builder = (builder as any).accountsPartial(acctBase);
          } else if (typeof (builder as any).accounts === 'function') {
            builder = (builder as any).accounts(acctBase);
          }
        } catch {}
      }
    } catch (finalValErr) {
      try { 
        logger.debug('meteora.dlmm.final_validation.failed', { 
          cat: 'tx', 
          ctx: { error: String((finalValErr as any)?.message || finalValErr) } 
        }); 
      } catch {}
    }

    // Enhanced validation: ensure userTokenOut matches pool's tokenX/tokenY based on swap direction
    try {
      const tokenXMint = acctBase.tokenXMint ? (acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint)) : null;
      const tokenYMint = acctBase.tokenYMint ? (acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint)) : null;
      const inputMintPk = toPublicKey(hop.inputMint);
      const outputMintPk = toPublicKey(hop.outputMint);
      
      if (tokenXMint && tokenYMint) {
        // Determine swap direction: X->Y or Y->X
        const isXToY = inputMintPk.equals(tokenXMint) && outputMintPk.equals(tokenYMint);
        const isYToX = inputMintPk.equals(tokenYMint) && outputMintPk.equals(tokenXMint);
        
        if (isXToY || isYToX) {
          // Swap direction is valid, ensure userTokenOut matches the output token
          const expectedOutputToken = isXToY ? tokenYMint : tokenXMint;
          const { deriveAta } = await import('../accounts.js');
          const outputTokenProgram = isXToY ? acctBase.tokenYProgram : acctBase.tokenXProgram;
          const fallbackTokenProg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
          const tokenProg = outputTokenProgram instanceof PublicKey ? outputTokenProgram : (outputTokenProgram ? toPublicKey(outputTokenProgram) : fallbackTokenProg);
          const correctOutputAta = deriveAta(kp.publicKey, expectedOutputToken, tokenProg.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl-token');
          
          const currentUserTokenOut = acctBase.userTokenOut || accounts.userTokenOut;
          if (currentUserTokenOut) {
            const currentOutPk = currentUserTokenOut instanceof PublicKey ? currentUserTokenOut : toPublicKey(currentUserTokenOut);
            
            if (!currentOutPk.equals(correctOutputAta)) {
              try { 
                logger.warn('meteora.dlmm.userTokenOut.pool_token_mismatch', { 
                  cat: 'tx', 
                  ctx: { 
                    currentUserTokenOut: currentOutPk.toBase58(),
                    correctOutputAta: correctOutputAta.toBase58(),
                    expectedOutputToken: expectedOutputToken.toBase58(),
                    tokenXMint: tokenXMint.toBase58(),
                    tokenYMint: tokenYMint.toBase58(),
                    swapDirection: isXToY ? 'X->Y' : 'Y->X',
                    inputMint: hop.inputMint,
                    outputMint: hop.outputMint
                  } 
                }); 
              } catch {}
              
              acctBase.userTokenOut = correctOutputAta;
              accounts.userTokenOut = correctOutputAta;
              
              // Re-apply accounts
              try {
                if (typeof (builder as any).accountsPartial === 'function') {
                  builder = (builder as any).accountsPartial(acctBase);
                } else if (typeof (builder as any).accounts === 'function') {
                  builder = (builder as any).accounts(acctBase);
                }
              } catch {}
              
              try { 
                logger.info('meteora.dlmm.userTokenOut.pool_token_corrected', { 
                  cat: 'tx', 
                  ctx: { 
                    old: currentOutPk.toBase58(),
                    new: correctOutputAta.toBase58(),
                    token: expectedOutputToken.toBase58()
                  } 
                }); 
              } catch {}
            }
          }
        } else {
          // Swap direction doesn't match pool tokens - this might be the issue
          try { 
            logger.warn('meteora.dlmm.swap_direction_mismatch', { 
              cat: 'tx', 
              ctx: { 
                inputMint: hop.inputMint,
                outputMint: hop.outputMint,
                tokenXMint: tokenXMint.toBase58(),
                tokenYMint: tokenYMint.toBase58()
              } 
            }); 
          } catch {}
        }
      }
    } catch (poolValErr) {
      try { 
        logger.debug('meteora.dlmm.pool_token_validation.failed', { 
          cat: 'tx', 
          ctx: { error: String((poolValErr as any)?.message || poolValErr) } 
        }); 
      } catch {}
    }

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
      const getBinArrayLowerUpperBinId = (DLMM as any)?.getBinArrayLowerUpperBinId || (mod as any)?.getBinArrayLowerUpperBinId;
      const getBinArrayAccountMetasCoverage = (DLMM as any)?.getBinArrayAccountMetasCoverage || (mod as any)?.getBinArrayAccountMetasCoverage;
      const binIdToBinArrayIndex = (DLMM as any)?.binIdToBinArrayIndex || (mod as any)?.binIdToBinArrayIndex;
      
      if (getBinArrayLowerUpperBinId && getBinArrayAccountMetasCoverage && binIdToBinArrayIndex && typeof (builder as any).remainingAccounts === 'function') {
        try {
          const bnjs = await import('bn.js').catch(() => null as any);
          const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
          if (BN) {
            // Get active bin ID and convert to bin array index
            let activeBinId: any = null;
            if (typeof hop.activeId === 'number') {
              activeBinId = new BN(String(hop.activeId));
            } else {
              try {
                const poolState = await program.account.lbPair.fetch(poolPk);
                const stateActive = poolState?.activeId;
                if (stateActive) {
                  if (stateActive instanceof BN) activeBinId = stateActive;
                  else if (typeof stateActive === 'object' && typeof stateActive.toString === 'function') {
                    activeBinId = new BN(stateActive.toString());
                  } else if (typeof stateActive === 'number') {
                    activeBinId = new BN(String(stateActive));
                  }
                }
              } catch {}
            }
            
            if (activeBinId) {
              try {
                // Convert bin ID to bin array index
                const binArrayIdx = binIdToBinArrayIndex(activeBinId);
                const idx = binArrayIdx instanceof BN ? binArrayIdx : new BN(String(binArrayIdx));
                // getBinArrayLowerUpperBinId takes binArrayIndex, returns [lowerBinId, upperBinId]
                const [lowerBinId, upperBinId] = getBinArrayLowerUpperBinId(idx);
                
                // Expand range to cover potential swap path: active bin array +/- 2-3 bin arrays
                // Swaps can traverse multiple bins, so we need a wider range
                const binArraySize = (DLMM as any)?.MAX_BIN_ARRAY_SIZE ?? new BN(70);
                const expansionFactor = new BN(3); // Cover 3 bin arrays on each side
                const rangeLower = lowerBinId.sub(binArraySize.mul(expansionFactor));
                const rangeUpper = upperBinId.add(binArraySize.mul(expansionFactor));
                
                const metas = getBinArrayAccountMetasCoverage(rangeLower, rangeUpper, poolPk, programId) || [];
                // Don't limit aggressively - SDK should only return arrays that exist and are needed
                // But cap at 20 as a safety measure against edge cases
                const maxMetas = 20;
                const limitedMetas = Array.isArray(metas) ? metas.slice(0, maxMetas) : [];
                if (limitedMetas.length) {
                  builder = (builder as any).remainingAccounts(limitedMetas);
                  try { logger.info('meteora.dlmm.remaining.ok', { cat: 'tx', ctx: { count: limitedMetas.length, total: metas.length, range: `${rangeLower.toString()}..${rangeUpper.toString()}` } }); } catch {}
          }
        } catch (e: any) {
          try { logger.debug('meteora.dlmm.remaining.bounds.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
              }
            }
          }
        } catch (e: any) {
          try { logger.debug('meteora.dlmm.remaining.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
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
    
    // Add pre-computed bin array metas as remaining accounts (already limited to ~6-7 max)
    // Only add if SDK helper didn't already set remaining accounts
    if (binArrayMetas && binArrayMetas.length && typeof (builder as any).remainingAccounts === 'function') {
      try {
        // Safety limit - should already be limited but cap at 10 just in case
        const limited = binArrayMetas.slice(0, 10);
        if (limited.length) {
          builder = (builder as any).remainingAccounts(limited);
          try { logger.debug('meteora.dlmm.remaining.from_metas', { cat: 'tx', ctx: { count: limited.length } }); } catch {}
        }
      } catch {}
    }
    
    const ix = (typeof builder.instruction === 'function') ? await builder.instruction() : null;
    
    // CRITICAL FIX: Remove duplicate accounts from instruction
    // The same account should not appear multiple times with different flags
    if (ix && Array.isArray(ix.keys)) {
      const seen = new Map<string, { index: number; key: any }>();
      const duplicates: number[] = [];
      
      for (let i = 0; i < ix.keys.length; i++) {
        const key = ix.keys[i];
        try {
          const pk = key?.pubkey instanceof PublicKey ? key.pubkey : (typeof key?.pubkey === 'string' ? new PublicKey(key.pubkey) : null);
          if (pk) {
            const pkStr = pk.toBase58();
            if (seen.has(pkStr)) {
              // Duplicate found - keep the one with isWritable=true if either has it
              const existing = seen.get(pkStr)!;
              const existingWritable = existing.key?.isWritable || false;
              const currentWritable = key?.isWritable || false;
              
              if (currentWritable && !existingWritable) {
                // Current is writable, existing is not - replace existing
                duplicates.push(existing.index);
                seen.set(pkStr, { index: i, key });
              } else {
                // Keep existing, mark current as duplicate
                duplicates.push(i);
              }
            } else {
              seen.set(pkStr, { index: i, key });
            }
          }
        } catch {}
      }
      
      // Remove duplicates in reverse order to maintain indices
      if (duplicates.length > 0) {
        duplicates.sort((a, b) => b - a);
        for (const idx of duplicates) {
          ix.keys.splice(idx, 1);
        }
        try { 
          logger.warn('meteora.dlmm.duplicate_accounts.removed', { 
            cat: 'tx', 
            ctx: { removedCount: duplicates.length, newAccountCount: ix.keys.length } 
          }); 
        } catch {}
      }
    }
    
    // CRITICAL FIX: Validate and correct token program accounts in instruction
    // The SDK sometimes places wrong accounts (like reward vaults) in token program slots
    // BUT we must NOT replace event_authority or other PDAs that are correctly placed
    // Note: We only replace accounts at token program positions - we don't add/remove accounts
    // to preserve the SDK's account order and instruction data integrity
    if (ix && Array.isArray(ix.keys)) {
      try {
        const TOKEN_PROGRAM_ID_STR = TOKEN_PROGRAM_ID.toBase58();
        const TOKEN_2022_PROGRAM_ID_STR = TOKEN_2022_PROGRAM_ID.toBase58();
        const validTokenPrograms = new Set([TOKEN_PROGRAM_ID_STR, TOKEN_2022_PROGRAM_ID_STR]);
        
        // Find expected token program IDs based on what we set in acctBase
        const expectedTokenXProgram = acctBase.tokenXProgram instanceof PublicKey 
          ? acctBase.tokenXProgram.toBase58() 
          : (acctBase.tokenXProgram ? String(acctBase.tokenXProgram) : TOKEN_PROGRAM_ID_STR);
        const expectedTokenYProgram = acctBase.tokenYProgram instanceof PublicKey 
          ? acctBase.tokenYProgram.toBase58() 
          : (acctBase.tokenYProgram ? String(acctBase.tokenYProgram) : TOKEN_PROGRAM_ID_STR);
        
        // Derive event_authority PDA to check if accounts are event_authority
        // Meteora DLMM event_authority is derived with seeds: ["__event_authority"]
        let eventAuthorityPda: PublicKey | null = null;
        try {
          const [eventAuthPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            programId
          );
          eventAuthorityPda = eventAuthPda;
        } catch {}
        
        // Token program accounts are typically at positions 11-12 (tokenXProgram, tokenYProgram)
        // Check these positions first
        const positionsToCheck = [11, 12];
        let correctedCount = 0;
        const replacedAccounts = new Map<number, string>(); // Track replaced accounts for logging
        
        for (const pos of positionsToCheck) {
          if (pos < ix.keys.length) {
            const key = ix.keys[pos];
            if (key && typeof key === 'object' && (key as any).pubkey) {
              const pk = (key as any).pubkey;
              const pkStr = pk instanceof PublicKey ? pk.toBase58() : String(pk);
              
              // Debug logging to track what we're checking
              try {
                logger.info('meteora.dlmm.token_program.checking_position', {
                  cat: 'tx',
                  ctx: {
                    position: pos,
                    account: pkStr,
                    isTokenProgram: validTokenPrograms.has(pkStr),
                    expectedProgram: pos === 11 ? expectedTokenXProgram : expectedTokenYProgram,
                    role: pos === 11 ? 'tokenXProgram' : 'tokenYProgram'
                  }
                });
              } catch {}
              
              // CRITICAL: Don't replace event_authority specifically
              // Positions 11-12 MUST be token programs, so we replace anything that's not a token program
              // UNLESS it's event_authority (which should never be at positions 11-12, but check anyway)
              if (eventAuthorityPda && pkStr === eventAuthorityPda.toBase58()) {
                try {
                  logger.info('meteora.dlmm.token_program.skip_event_authority', {
                    cat: 'tx',
                    ctx: {
                      position: pos,
                      account: pkStr,
                      note: 'Skipping replacement - this is event_authority PDA (unexpected at token program position)'
                    }
                  });
                } catch {}
                continue; // Don't replace event_authority
              }
              
              // Determine which token program should be here
              // Position 11 is typically tokenXProgram, position 12 is tokenYProgram
              const expectedProgram = pos === 11 ? expectedTokenXProgram : expectedTokenYProgram;
              
              // If this position should be a token program but isn't, OR if it's the wrong token program, fix it
              // We replace it UNLESS it's event_authority (which we already checked above)
              // Note: Even if the account is a PDA, if it's at a token program position and not event_authority,
              // we must replace it because the instruction requires a token program here
              if (!validTokenPrograms.has(pkStr) || pkStr !== expectedProgram) {
                try {
                  logger.info('meteora.dlmm.token_program.will_replace', {
                    cat: 'tx',
                    ctx: {
                      position: pos,
                      oldAccount: pkStr,
                      newAccount: expectedProgram,
                      reason: !validTokenPrograms.has(pkStr) ? 'not_a_token_program' : 'wrong_token_program',
                      role: pos === 11 ? 'tokenXProgram' : 'tokenYProgram'
                    }
                  });
                } catch {}
                
                const expectedProgramPk = new PublicKey(expectedProgram);
                
                // Store the replaced account for logging (only if it's not already a valid token program)
                if (!validTokenPrograms.has(pkStr)) {
                  replacedAccounts.set(pos, pkStr);
                }
                
                // Replace with correct token program
                ix.keys[pos] = {
                  pubkey: expectedProgramPk,
                  isSigner: false,
                  isWritable: false
                };
                correctedCount++;
                
                try {
                  logger.warn('meteora.dlmm.token_program.corrected', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_ERR,
                    ctx: {
                      position: pos,
                      oldAccount: pkStr,
                      newAccount: expectedProgram,
                      role: pos === 11 ? 'tokenXProgram' : 'tokenYProgram',
                      poolId: hop.poolId,
                      wasValidTokenProgram: validTokenPrograms.has(pkStr) && pkStr !== expectedProgram
                    }
                  });
                } catch {}
              } else {
                try {
                  logger.info('meteora.dlmm.token_program.position_correct', {
                    cat: 'tx',
                    ctx: {
                      position: pos,
                      account: pkStr,
                      expectedProgram,
                      role: pos === 11 ? 'tokenXProgram' : 'tokenYProgram'
                    }
                  });
                } catch {}
              }
            }
          }
        }
        
        // Verify that replaced accounts aren't needed elsewhere in the instruction
        // If a replaced account appears elsewhere, it means it was correctly placed there
        // and we only fixed the token program position
        if (correctedCount > 0 && replacedAccounts.size > 0) {
          for (const [pos, replacedAccount] of replacedAccounts.entries()) {
            let foundElsewhere = false;
            for (let i = 0; i < ix.keys.length; i++) {
              if (i !== pos) {
                const key = ix.keys[i];
                if (key && typeof key === 'object' && (key as any).pubkey) {
                  const pk = (key as any).pubkey;
                  const pkStr = pk instanceof PublicKey ? pk.toBase58() : String(pk);
                  if (pkStr === replacedAccount) {
                    foundElsewhere = true;
                    break;
                  }
                }
              }
            }
            
            if (!foundElsewhere) {
              try {
                logger.debug('meteora.dlmm.token_program.replaced_account_not_found_elsewhere', {
                  cat: 'tx',
                  ctx: {
                    position: pos,
                    replacedAccount,
                    note: 'Account was only at token program position - replacement should be safe'
                  }
                });
              } catch {}
            }
          }
        }
        
        if (correctedCount > 0) {
          try {
            logger.debug('meteora.dlmm.token_program.corrections_applied', {
              cat: 'tx',
              ctx: {
                correctedCount,
                tokenXProgram: expectedTokenXProgram,
                tokenYProgram: expectedTokenYProgram,
                poolId: hop.poolId
              }
            });
          } catch {}
        }
      } catch (e: any) {
        try {
          logger.debug('meteora.dlmm.token_program.validation.failed', {
            cat: 'tx',
            ctx: { error: String(e?.message || e) }
          });
        } catch {}
      }
    }
    
    // Final safety check: validate and correct userTokenOut in the actual instruction
    if (ix && Array.isArray(ix.keys)) {
      try {
        // Log all instruction accounts for debugging
        try {
          const accountDetails = ix.keys.map((key: any, idx: number) => {
            try {
              const pk = key?.pubkey instanceof PublicKey ? key.pubkey : (typeof key?.pubkey === 'string' ? new PublicKey(key.pubkey) : null);
              return {
                index: idx,
                pubkey: pk?.toBase58() || 'unknown',
                isWritable: key?.isWritable || false,
                isSigner: key?.isSigner || false
              };
            } catch {
              return { index: idx, pubkey: 'invalid', isWritable: false, isSigner: false };
            }
          });
          logger.debug('meteora.dlmm.instruction.accounts', {
            cat: 'tx',
            ctx: {
              accountCount: ix.keys.length,
              accounts: accountDetails,
              inputMint: hop.inputMint,
              outputMint: hop.outputMint,
              poolId: hop.poolId
            }
          });
          
          // Check account mints for writable token accounts - batch fetch to reduce RPC calls
          const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
          
          // Collect accounts for batch fetch
          const accountsToCheck: Array<{ pkObj: PublicKey; index: number }> = [];
          for (let i = 0; i < Math.min(ix.keys.length, 15); i++) {
            const key = ix.keys[i];
            if (key && typeof key === 'object' && (key as any).pubkey && (key as any).isWritable && !(key as any).isSigner && i > 3) {
              try {
                const pk = (key as any).pubkey;
                const pkObj = pk instanceof PublicKey ? pk : new PublicKey(pk);
                accountsToCheck.push({ pkObj, index: i });
              } catch {}
            }
          }
          
          // Batch fetch all accounts at once
          const mintChecks: any[] = [];
          if (accountsToCheck.length > 0) {
            try {
              const keys = accountsToCheck.map(a => a.pkObj);
              const weight = Math.max(1, Math.ceil(keys.length / 5));
              const accountInfos = await withRpcLimit(() => connection.getMultipleAccountsInfo(keys), weight).catch(() => null);
              
              if (accountInfos && accountInfos.length === accountsToCheck.length) {
                for (let i = 0; i < accountsToCheck.length; i++) {
                  const { pkObj, index } = accountsToCheck[i];
                  const accInfo = accountInfos[i];
                  
                  if (accInfo?.data && accInfo.data.length >= 32) {
                    const mintBytes = accInfo.data.slice(0, 32);
                    const accountMint = new PublicKey(mintBytes);
                    mintChecks.push({
                      index,
                      pubkey: pkObj.toBase58(),
                      mint: accountMint.toBase58(),
                      isTokenAccount: true
                    });
                  }
                }
              }
            } catch {}
          }
          
          if (mintChecks.length > 0) {
            logger.debug('meteora.dlmm.instruction.account_mints', {
              cat: 'tx',
              ctx: {
                mintChecks,
                expectedInputMint: hop.inputMint,
                expectedOutputMint: hop.outputMint
              }
            });
          }
        } catch {}
        
        const tokenXMint = acctBase.tokenXMint ? (acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint)) : null;
        const tokenYMint = acctBase.tokenYMint ? (acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint)) : null;
        const inputMintPk = toPublicKey(hop.inputMint);
        const outputMintPk = toPublicKey(hop.outputMint);
        
        // CRITICAL FIX: Validate token mints in instruction accounts match expected swap direction
        // The SDK typically puts token mints at positions 6-7 (tokenXMint, tokenYMint)
        // We need to verify these match the swap direction
        if (tokenXMint && tokenYMint) {
          // Determine swap direction and expected output token
          const isXToY = inputMintPk.equals(tokenXMint) && outputMintPk.equals(tokenYMint);
          const isYToX = inputMintPk.equals(tokenYMint) && outputMintPk.equals(tokenXMint);
          
          // Verify the instruction has the correct token mints
          // Check positions 6-7 where token mints typically appear in Meteora DLMM swap instructions
          if (ix.keys.length >= 8) {
            const pos6 = ix.keys[6];
            const pos7 = ix.keys[7];
            const mint6 = pos6?.pubkey instanceof PublicKey ? pos6.pubkey : (typeof pos6?.pubkey === 'string' ? new PublicKey(pos6.pubkey) : null);
            const mint7 = pos7?.pubkey instanceof PublicKey ? pos7.pubkey : (typeof pos7?.pubkey === 'string' ? new PublicKey(pos7.pubkey) : null);
            
            if (mint6 && mint7) {
              const mint6Matches = mint6.equals(tokenXMint) || mint6.equals(tokenYMint);
              const mint7Matches = mint7.equals(tokenXMint) || mint7.equals(tokenYMint);
              
              if (!mint6Matches || !mint7Matches) {
                try {
                  logger.error('meteora.dlmm.instruction_token_mint_mismatch', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_ERR,
                    ctx: {
                      pos6Mint: mint6.toBase58(),
                      pos7Mint: mint7.toBase58(),
                      expectedTokenXMint: tokenXMint.toBase58(),
                      expectedTokenYMint: tokenYMint.toBase58(),
                      inputMint: hop.inputMint,
                      outputMint: hop.outputMint,
                      poolId: hop.poolId
                    }
                  });
                } catch {}
                // CRITICAL: This is a fatal error - the instruction has wrong token mints
                throw createBuilderError('METEORA_DLMM', `Instruction has incorrect token mints: pos6=${mint6.toBase58()}, pos7=${mint7.toBase58()}, expected X=${tokenXMint.toBase58()}, Y=${tokenYMint.toBase58()}`, hop);
              }
              
              // Additional validation: Ensure the mints match the swap direction
              // Position 6 should be input mint (or tokenXMint if X->Y, tokenYMint if Y->X)
              // Position 7 should be output mint (or tokenYMint if X->Y, tokenXMint if Y->X)
              const expectedPos6 = isXToY ? tokenXMint : tokenYMint;
              const expectedPos7 = isXToY ? tokenYMint : tokenXMint;
              
              if (!mint6.equals(expectedPos6) || !mint7.equals(expectedPos7)) {
                try {
                  logger.error('meteora.dlmm.instruction_token_mint_direction_mismatch', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_ERR,
                    ctx: {
                      pos6Mint: mint6.toBase58(),
                      pos7Mint: mint7.toBase58(),
                      expectedPos6: expectedPos6.toBase58(),
                      expectedPos7: expectedPos7.toBase58(),
                      swapDirection: isXToY ? 'X->Y' : 'Y->X',
                      inputMint: hop.inputMint,
                      outputMint: hop.outputMint,
                      poolId: hop.poolId
                    }
                  });
                } catch {}
                // CRITICAL: This is a fatal error - token mints don't match swap direction
                throw createBuilderError('METEORA_DLMM', `Instruction token mints don't match swap direction: pos6=${mint6.toBase58()}, pos7=${mint7.toBase58()}, expected pos6=${expectedPos6.toBase58()}, pos7=${expectedPos7.toBase58()}`, hop);
              }
            }
          }
          
          if (!isXToY && !isYToX) {
            try {
              logger.error('meteora.dlmm.swap_direction_invalid', {
                cat: 'tx',
                code: LogCode.TX_BUILD_ERR,
                ctx: {
                  inputMint: hop.inputMint,
                  outputMint: hop.outputMint,
                  tokenXMint: tokenXMint.toBase58(),
                  tokenYMint: tokenYMint.toBase58(),
                  poolId: hop.poolId
                }
              });
            } catch {}
          }
          
          if (isXToY || isYToX) {
            const expectedOutputToken = isXToY ? tokenYMint : tokenXMint;
            const { deriveAta } = await import('../accounts.js');
            const outputTokenProgram = isXToY ? acctBase.tokenYProgram : acctBase.tokenXProgram;
            const fallbackTokenProg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
            const tokenProg = outputTokenProgram instanceof PublicKey ? outputTokenProgram : (outputTokenProgram ? toPublicKey(outputTokenProgram) : fallbackTokenProg);
            const correctOutputAta = deriveAta(kp.publicKey, expectedOutputToken, tokenProg.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl-token');
            
            // Find and correct userTokenOut in instruction keys
            // Strategy: Find any account that matches our expected correct ATA, or find accounts that don't match
            // and need to be corrected. We'll check known positions and also validate by checking if
            // the account exists and has the wrong mint.
            
            // First, check if correctOutputAta is already in the instruction
            let foundCorrect = false;
            for (const key of ix.keys) {
              if (key && typeof key === 'object' && (key as any).pubkey) {
                const pk = (key as any).pubkey;
                if (pk instanceof PublicKey && pk.equals(correctOutputAta)) {
                  foundCorrect = true;
                  break;
                }
              }
            }
            
            // If correct ATA is not found, find userTokenOut and replace it
            if (!foundCorrect) {
              // Find userTokenIn first to identify where userTokenOut should be
              const { deriveAta: deriveAtaFn } = await import('../accounts.js');
              const inputTokenProgram = isXToY ? acctBase.tokenXProgram : acctBase.tokenYProgram;
              const fallbackTokenProg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
              const inputTokenProg = inputTokenProgram instanceof PublicKey ? inputTokenProgram : (inputTokenProgram ? toPublicKey(inputTokenProgram) : fallbackTokenProg);
              const correctInputAta = deriveAtaFn(kp.publicKey, inputMintPk, inputTokenProg.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl-token');
              
              let userTokenInIdx = -1;
              for (let i = 0; i < ix.keys.length; i++) {
                const key = ix.keys[i];
                if (key && typeof key === 'object' && (key as any).pubkey) {
                  const pk = (key as any).pubkey;
                  if (pk instanceof PublicKey && pk.equals(correctInputAta)) {
                    userTokenInIdx = i;
                    break;
                  }
                }
              }
              
              // Find userTokenOut - it's typically right after userTokenIn
              let foundUserTokenOut = false;
              if (userTokenInIdx >= 0) {
                // Find the next writable account after userTokenIn
                for (let i = userTokenInIdx + 1; i < ix.keys.length && !foundUserTokenOut; i++) {
                  const key = ix.keys[i];
                  if (key && typeof key === 'object' && (key as any).pubkey && (key as any).isWritable && !(key as any).isSigner) {
                    const pk = (key as any).pubkey;
                    if (pk instanceof PublicKey && !pk.equals(correctOutputAta)) {
                      // This is likely userTokenOut - replace it
                      (key as any).pubkey = correctOutputAta;
                      foundUserTokenOut = true;
                      try { 
                        logger.warn('meteora.dlmm.instruction.userTokenOut.adjacent_corrected', { 
                          cat: 'tx', 
                          ctx: { 
                            index: i,
                            userTokenInIdx: userTokenInIdx,
                            old: pk.toBase58(),
                            new: correctOutputAta.toBase58(),
                            expectedToken: expectedOutputToken.toBase58()
                          } 
                        }); 
                      } catch {}
                      break;
                    }
                  }
                }
              }
              
              // If we didn't find it by position, try to find by checking account mints - batch fetch to reduce RPC calls
              if (!foundUserTokenOut) {
                // Collect accounts for batch fetch
                const accountsToCheck: Array<{ pk: PublicKey; key: any; index: number }> = [];
                for (let i = 0; i < ix.keys.length; i++) {
                  const key = ix.keys[i];
                  if (key && typeof key === 'object' && (key as any).pubkey && (key as any).isWritable && !(key as any).isSigner && i > 3) {
                    const pk = (key as any).pubkey;
                    if (pk instanceof PublicKey && !pk.equals(correctOutputAta)) {
                      accountsToCheck.push({ pk, key, index: i });
                    }
                  }
                }
                
                // Batch fetch all accounts at once
                if (accountsToCheck.length > 0) {
                  try {
                    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
                    const keys = accountsToCheck.map(a => a.pk);
                    const weight = Math.max(1, Math.ceil(keys.length / 5));
                    const accountInfos = await withRpcLimit(() => connection.getMultipleAccountsInfo(keys), weight).catch(() => null);
                    
                    if (accountInfos && accountInfos.length === accountsToCheck.length) {
                      for (let i = 0; i < accountsToCheck.length && !foundUserTokenOut; i++) {
                        const { pk, key, index } = accountsToCheck[i];
                        const accInfo = accountInfos[i];
                        
                        if (accInfo?.data && accInfo.data.length >= 32) {
                          const mintBytes = accInfo.data.slice(0, 32);
                          const accountMint = new PublicKey(mintBytes);
                          
                          // If this account has the output mint but is not the correct ATA, it's likely userTokenOut
                          if (accountMint.equals(expectedOutputToken)) {
                            (key as any).pubkey = correctOutputAta;
                            foundUserTokenOut = true;
                            try { 
                              logger.warn('meteora.dlmm.instruction.userTokenOut.mint_corrected', { 
                                cat: 'tx', 
                                ctx: { 
                                  index,
                                  old: pk.toBase58(),
                                  new: correctOutputAta.toBase58(),
                                  expectedToken: expectedOutputToken.toBase58(),
                                  accountMint: accountMint.toBase58()
                                } 
                              }); 
                            } catch {}
                            break;
                          }
                        }
                      }
                    }
                  } catch {}
                }
              }
            }
          }
        }
      } catch (instrValErr) {
        try { 
          logger.debug('meteora.dlmm.instruction.validation.failed', { 
            cat: 'tx', 
            ctx: { error: String((instrValErr as any)?.message || instrValErr) } 
          }); 
        } catch {}
      }
    }
    
    // Safety net: inject bin metas into instruction if builder.remainingAccounts did not attach them
    if (ix) {
      await injectBinArrayMetas(ix, DLMM, connection, poolPk, programId);
      try { logger.debug('meteora.dlmm.swap.ok', { cat: 'tx' }); } catch {}
      return [...setupIxs, ix];
    }
    
    try { logger.warn('meteora.dlmm.tsclient.swap.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  } catch (e: any) {
    try { logger.warn('meteora.dlmm.tsclient.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
  }

    // Wrap final error with context (only reached if no successful return)
    wrapBuilderError(new Error('METEORA_DLMM_BUILD_FAILED'), 'METEORA_DLMM', 'build failed', hop);
  } catch (e: any) {
    // Catch any errors thrown from the entire function body
    // This ensures all errors (including early validation/connection errors) get Meteora-specific logging
    wrapBuilderError(e, 'METEORA_DLMM', 'build failed', hop);
  }
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
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];
    if (!hop.tickArrayLower) missingRequired.push('tickArrayLower');
    if (!hop.tickArrayUpper) missingRequired.push('tickArrayUpper');
    if (!hop.oracle) missingOptional.push('oracle');
    if (missingRequired.length || missingOptional.length) {
      // One-shot refresh: attempt to hydrate CLMM statics (oracle/tick arrays) from chain
      try {
        try { logger.warn('raydium.clmm.refresh.attempt', { cat: 'tx', ctx: { pool: hop.poolId, missingRequired: missingRequired.join('/'), missingOptional: missingOptional.join('/') } as any }); } catch {}
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
            hop.observationId = hop.observationId || cached.observationId;
            hop.ammConfig = hop.ammConfig || cached.ammConfig;
          }
          try { logger.info('raydium.clmm.refresh.result', { cat: 'tx', ctx: { pool: poolBase, oracle: hop.oracle || '', lower: hop.tickArrayLower || '', upper: hop.tickArrayUpper || '' } as any }); } catch {}
        } catch {}
      } catch {}
      const stillMissingRequired: string[] = [];
      if (!hop.tickArrayLower) stillMissingRequired.push('tickArrayLower');
      if (!hop.tickArrayUpper) stillMissingRequired.push('tickArrayUpper');
      if (stillMissingRequired.length) throw new Error(`RAYDIUM_CLMM_BUILD_FAILED: CACHE_MISS_AFTER_REFRESH: missing ${stillMissingRequired.join(',')}`);
      if (!hop.oracle) {
        try { logger.warn('raydium.clmm.oracle.missing', { cat: 'tx', ctx: { pool: hop.poolId } as any }); } catch {}
      }
    }
    try {
      logger.info('raydium.clmm.accounts', { cat: 'tx', ctx: {
        pool: hop.poolId,
        programId: hop.programId,
        oracle: hop.oracle,
        observation: hop.observationId,
        ammConfig: hop.ammConfig,
        lower: hop.tickArrayLower,
        upper: hop.tickArrayUpper,
        vaultA: hop.vaultA,
        vaultB: hop.vaultB,
      }});
    } catch {}

    const { ClmmInstrument } = await import('@raydium-io/raydium-sdk-v2');
    const kp = await ensureWallet(CONFIG.walletPath);
    const poolIdPk = toPublicKey(hop.poolId);
    const programIdPk = toPublicKey(hop.programId, (CONFIG.raydium?.clmmProgram as any));
    const poolId = poolIdPk.toBase58();
    const programId = programIdPk.toBase58();
    
    // Validate required config values - no unsafe fallbacks
    let observationId: PublicKey | null = null;
    if (hop.observationId) {
      try { observationId = toPublicKey(hop.observationId); } catch (e) {
        throw createBuilderError('RAYDIUM_CLMM', `invalid observationId: ${String(e instanceof Error ? e.message : e)}`, hop);
      }
    }
    if (!observationId) {
    const observationIdConfig = (CONFIG.raydium as any)?.clmmObservationId;
      if (observationIdConfig) {
        try { observationId = toPublicKey(observationIdConfig); } catch (e) {
          throw createBuilderError('RAYDIUM_CLMM', `invalid CONFIG.raydium.clmmObservationId: ${String(e instanceof Error ? e.message : e)}`, hop);
    }
      }
    }
    if (!observationId) {
      throw createBuilderError('RAYDIUM_CLMM', 'observationId missing (cache/config)', hop);
    }

    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: toPublicKey(hop.userSourceAta),
      tokenAccountB: toPublicKey(hop.userDestAta),
    };

    // Verify ammConfig account exists on-chain before using it
    const configIdPk = hop.ammConfig ? toPublicKey(hop.ammConfig) : null;
    if (!configIdPk) {
      throw createBuilderError('RAYDIUM_CLMM', 'ammConfig missing (cache)', hop);
    }
    
    try {
      logger.info('raydium.clmm.config.verify.start', { cat: 'tx', ctx: { pool: hop.poolId, ammConfig: configIdPk.toBase58() } as any });
    } catch {}
    
    // Verify critical accounts exist before building instruction
    // Use account cache to avoid per-transaction RPC calls
    const { accountCache } = await import('../utils/accountCache.js');
    let configAcc: any = null;
    try {
      configAcc = await accountCache.getAccountInfo(configIdPk);
      if (!configAcc) {
        throw createBuilderError('RAYDIUM_CLMM', `ammConfig account does not exist: ${configIdPk.toBase58()}`, hop);
      }
      // Note: ammConfig account may be owned by a different program (config program, not pool program)
      // We just verify it exists - the SDK will validate program ownership during instruction execution
      try {
        logger.debug('raydium.clmm.config.verified', { cat: 'tx', ctx: { pool: hop.poolId, config: configIdPk.toBase58(), owner: configAcc.owner.toBase58() } as any });
      } catch {}
    } catch (e: any) {
      if (e instanceof Error && e.message.includes('RAYDIUM_CLMM_BUILD_FAILED')) throw e;
      try { logger.warn('raydium.clmm.config.verify.failed', { cat: 'tx', ctx: { pool: hop.poolId, error: String(e?.message || e) } as any }); } catch {}
    }

    // Try to use SDK's getClmmPoolKeys for proper structure (if API available)
    let poolKeysFromApi: any = null;
    try {
      const connection = getConnection();
      const { Clmm } = await import('@raydium-io/raydium-sdk-v2');
      const clmm = new (Clmm as any)({
        connection,
        owner: kp.publicKey,
      });
      if (typeof clmm.getClmmPoolKeys === 'function') {
        poolKeysFromApi = await clmm.getClmmPoolKeys(poolId).catch(() => null);
    }
    } catch {}

    const mintAAddress = toPublicKey(hop.inputMint).toBase58();
    const mintBAddress = toPublicKey(hop.outputMint).toBase58();
    const mintAInfo = {
      address: mintAAddress,
      decimals: Number(hop.inputDecimals ?? 0),
      programId: hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58(),
    } as any;
    const mintBInfo = {
      address: mintBAddress,
      decimals: Number(hop.outputDecimals ?? 0),
      programId: hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58(),
    } as any;

    // Use config from API if available, otherwise use cached/decoded values
    const configInfo = poolKeysFromApi?.config || {
      id: configIdPk.toBase58(),
      index: 0,
      protocolFeeRate: 0,
      tradeFeeRate: 0,
      tickSpacing: Number(hop.tickSpacing ?? 1),
      fundFeeRate: 0,
      defaultRange: 0,
      defaultRangePoint: [],
    } as any;

    const poolInfo = {
      id: poolId,
      programId,
      mintA: mintAInfo,
      mintB: mintBInfo,
      config: configInfo,
    } as any;
    
    // Prefer API-fetched poolKeys, fallback to constructed
    const poolKeys: any = poolKeysFromApi || {
      id: poolId,
      programId,
      mintA: mintAInfo,
      mintB: mintBInfo,
      vault: {
        A: toPublicKey(hop.vaultA as any).toBase58(),
        B: toPublicKey(hop.vaultB as any).toBase58(),
      },
      observationId: observationId.toBase58(),
      config: configInfo,
      rewardInfos: [],
    };
    
    // Verify tick array accounts exist and filter out any that don't
    // Note: We only verify account existence with data - don't check owner (chain/SDK will validate)
    // Some tick arrays might be PDAs owned by related programs or the validation might fail due to RPC timing
    const tickArrayKeys: PublicKey[] = [];
    const tickArrayCandidates = [
      hop.tickArrayCenter,  // Start with center (current tick)
      hop.tickArrayLower,
      hop.tickArrayUpper,
    ].filter(Boolean);
    
    // Batch fetch all tick arrays at once to reduce RPC calls
    if (tickArrayCandidates.length > 0) {
      try {
        const connection = getConnection();
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const tickArrayPks = tickArrayCandidates.map(addr => toPublicKey(addr));
        const weight = Math.max(1, Math.ceil(tickArrayPks.length / 5));
        const tickArrayInfos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(tickArrayPks),
          weight
        ).catch(() => null);
        
        if (tickArrayInfos && tickArrayInfos.length === tickArrayPks.length) {
          for (let i = 0; i < tickArrayPks.length; i++) {
            const tickPk = tickArrayPks[i];
            const tickAcc = tickArrayInfos[i];
            // Just verify account exists with data - don't check owner (chain will validate program ownership)
            if (tickAcc && tickAcc.data && tickAcc.data.length > 0) {
              tickArrayKeys.push(tickPk);
              try { 
                logger.debug('raydium.clmm.tickarray.verified', { 
                  cat: 'tx', 
                  ctx: { 
                    pool: hop.poolId, 
                    tickArray: tickPk.toBase58(),
                    owner: tickAcc.owner.toBase58(),
                    dataLen: tickAcc.data.length 
                  } as any 
                }); 
              } catch {}
            } else {
              try { 
                logger.debug('raydium.clmm.tickarray.missing', { 
                  cat: 'tx', 
                  ctx: { 
                    pool: hop.poolId, 
                    tickArray: tickPk.toBase58(),
                    exists: !!tickAcc,
                    hasData: !!(tickAcc && tickAcc.data?.length) 
                  } as any 
                }); 
              } catch {}
            }
          }
        }
      } catch (e: any) {
        try { 
          logger.debug('raydium.clmm.tickarray.verify.error', { 
            cat: 'tx', 
            ctx: { 
              pool: hop.poolId, 
              error: String(e?.message || e) 
            } as any 
          }); 
        } catch {}
      }
    }
    
    if (!tickArrayKeys.length) {
      throw createBuilderError('RAYDIUM_CLMM', 'no valid tick arrays found for swap (all accounts missing or invalid)', hop);
    }
    
    // Sort tick arrays: center first (most likely needed), then others
    const centerPk = hop.tickArrayCenter ? toPublicKey(hop.tickArrayCenter) : null;
    if (centerPk && tickArrayKeys.find(pk => pk.equals(centerPk))) {
      const centerIdx = tickArrayKeys.findIndex(pk => pk.equals(centerPk));
      if (centerIdx > 0) {
        tickArrayKeys.unshift(tickArrayKeys.splice(centerIdx, 1)[0]);
      }
    }

    // Check exBitmap BEFORE calling SDK to prevent it from being added if it doesn't exist
    // Note: This will be batched with observation account check later to reduce RPC calls
    let exBitmapPk: PublicKey | null = null;
    let exBitmapExists = false;
    try {
      const { getPdaExBitmapAccount } = await import('@raydium-io/raydium-sdk-v2').catch(() => ({ getPdaExBitmapAccount: null }));
      if (getPdaExBitmapAccount) {
        exBitmapPk = getPdaExBitmapAccount(programIdPk, poolIdPk).publicKey;
        // We'll batch this check with observation account below
      }
    } catch (e: any) {
      try {
        logger.debug('raydium.clmm.exbitmap.derive.failed', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            error: String(e?.message || e),
          } as any,
        });
      } catch {}
    }

    const BN = (await import('bn.js')).default as any;
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    const minOutBn = new BN(String(hop.minOutRaw ?? 0n));
    const sqrtLimitBn = new BN(String(hop.sqrtPriceLimitX64 ?? 0n));

    const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
      poolInfo,
      poolKeys,
      observationId,
      ownerInfo,
      inputMint: toPublicKey(hop.inputMint),
      amountIn: amountInBn,
      amountOutMin: minOutBn,
      sqrtPriceLimitX64: sqrtLimitBn,
      remainingAccounts: tickArrayKeys,
    });
    let ixs = Array.isArray(res?.instructions) ? res.instructions : (res?.innerTransaction ? res.innerTransaction.instructions : []);
    
    // Log SDK-generated instructions for debugging
    try {
      logger.info('raydium.clmm.sdk.instructions.raw', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          instructionCount: ixs?.length || 0,
          instructions: ixs?.map((ix: any, idx: number) => ({
            index: idx,
            programId: (ix?.programId?.toBase58?.() || String(ix?.programId || '')),
            accountCount: (ix?.keys?.length || 0),
            accounts: (ix?.keys || []).map((k: any, accIdx: number) => ({
              index: accIdx,
              address: (k?.pubkey?.toBase58?.() || String(k?.pubkey || '')),
              isSigner: !!k?.isSigner,
              isWritable: !!k?.isWritable,
            })),
          })) || [],
        } as any,
      });
    } catch {}
    
    // CRITICAL: Immediately verify all accounts in SDK-generated instructions to catch missing accounts
    // This catches issues before any processing that might mask the error
    if (ixs && ixs.length) {
      try {
        logger.info('raydium.clmm.sdk.verification.start', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            instructionCount: ixs.length,
          } as any,
        });
      } catch {}
      const connection = getConnection();
      const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
      const missingAccounts: Array<{ instructionIndex: number; accountIndex: number; address: string; programId: string }> = [];
      
      // Collect all accounts to verify first, then batch fetch to reduce RPC calls
      // Also identify account roles for better debugging
      const accountsToVerify: Array<{ 
        pkObj: PublicKey; 
        pkStr: string; 
        ixIdx: number; 
        accIdx: number; 
        keyMeta: any; 
        ixProgramId: string;
        role?: string; // Account role for debugging
        expectedOwner?: string; // Expected program owner
      }> = [];
      
      // Helper to identify account role
      const identifyAccountRole = (pkStr: string, accIdx: number): { role: string; expectedOwner?: string } => {
        // Account at index 1 is typically the observation account
        if (accIdx === 1 && observationId && pkStr === observationId.toBase58()) {
          return { role: 'observation', expectedOwner: programId };
        }
        // Account at index 2 is typically the pool account
        if (accIdx === 2 && pkStr === toPublicKey(hop.poolId).toBase58()) {
          return { role: 'pool', expectedOwner: programId };
        }
        // Check if it's ammConfig
        if (configIdPk && pkStr === configIdPk.toBase58()) {
          return { role: 'ammConfig', expectedOwner: 'config_program' }; // May be owned by different program
        }
        // Check if it's observation
        if (observationId && pkStr === observationId.toBase58()) {
          return { role: 'observation', expectedOwner: programId };
        }
        // Check if it's a vault
        if (hop.vaultA && pkStr === toPublicKey(hop.vaultA as any).toBase58()) {
          return { role: 'vaultA', expectedOwner: programId };
        }
        if (hop.vaultB && pkStr === toPublicKey(hop.vaultB as any).toBase58()) {
          return { role: 'vaultB', expectedOwner: programId };
        }
        // Check if it's a tick array
        const tickArrayMatch = tickArrayKeys.findIndex(ta => ta.toBase58() === pkStr);
        if (tickArrayMatch >= 0) {
          return { role: `tickArray_${tickArrayMatch === 0 ? 'center' : tickArrayMatch === 1 ? 'lower' : 'upper'}`, expectedOwner: programId };
        }
        // Check if it's user token accounts
        if (hop.userSourceAta && pkStr === toPublicKey(hop.userSourceAta).toBase58()) {
          return { role: 'userSourceAta', expectedOwner: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' };
        }
        if (hop.userDestAta && pkStr === toPublicKey(hop.userDestAta).toBase58()) {
          return { role: 'userDestAta', expectedOwner: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' };
        }
        // Check if it's a mint
        if (hop.inputMint && pkStr === toPublicKey(hop.inputMint).toBase58()) {
          return { role: 'inputMint', expectedOwner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
        }
        if (hop.outputMint && pkStr === toPublicKey(hop.outputMint).toBase58()) {
          return { role: 'outputMint', expectedOwner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
        }
        return { role: 'unknown' };
      };
      
      for (let ixIdx = 0; ixIdx < ixs.length; ixIdx++) {
        const ix = ixs[ixIdx];
        if (ix instanceof TransactionInstruction && Array.isArray(ix.keys)) {
          const ixProgramId = ix.programId.toBase58();
          
          // Skip non-CLMM instructions (they're handled elsewhere)
          if (ixProgramId !== programIdPk.toBase58()) continue;
          
          // Collect accounts to verify (instead of fetching immediately)
          for (let accIdx = 0; accIdx < ix.keys.length; accIdx++) {
            const keyMeta = ix.keys[accIdx];
            const pk = keyMeta?.pubkey;
            if (!pk) continue;
            
            const pkObj = pk instanceof PublicKey ? pk : new PublicKey(pk);
            const pkStr = pkObj.toBase58();
            
            // Identify account role
            const { role, expectedOwner } = identifyAccountRole(pkStr, accIdx);
            
            // Skip signer accounts (wallet addresses)
            if (keyMeta.isSigner) {
              try {
                logger.debug('raydium.clmm.sdk.account.skipped', {
                  cat: 'tx',
                  ctx: {
                    pool: hop.poolId,
                    instructionIndex: ixIdx,
                    accountIndex: accIdx,
                    address: pkStr,
                    role: 'signer',
                    reason: 'signer_account',
                  } as any,
                });
              } catch {}
              continue;
            }
            
            // Skip well-known system programs
            const wellKnown = [
              '11111111111111111111111111111111',
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
              'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
              'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
              'ComputeBudget111111111111111111111111111111',
            ];
            if (wellKnown.includes(pkStr)) {
              try {
                logger.debug('raydium.clmm.sdk.account.skipped', {
                  cat: 'tx',
                  ctx: {
                    pool: hop.poolId,
                    instructionIndex: ixIdx,
                    accountIndex: accIdx,
                    address: pkStr,
                    role: 'system_program',
                    reason: 'well_known_system_account',
                  } as any,
                });
              } catch {}
              continue;
            }
            
            // Skip writable accounts that might be created (user token accounts)
            // But verify writable pool accounts (vaults, pool account) that MUST exist
            if (keyMeta.isWritable) {
              const isUserTokenAccount = pkStr === toPublicKey(hop.userSourceAta).toBase58() 
                || pkStr === toPublicKey(hop.userDestAta).toBase58();
              if (isUserTokenAccount) {
                try {
                  logger.debug('raydium.clmm.sdk.account.skipped', {
                    cat: 'tx',
                    ctx: {
                      pool: hop.poolId,
                      instructionIndex: ixIdx,
                      accountIndex: accIdx,
                      address: pkStr,
                      role,
                      reason: 'user_token_account_may_be_created',
                    } as any,
                  });
                } catch {}
                continue;
              }
              
              // Verify pool-related writable accounts (vaults, pool account, tick arrays)
              const isPoolRelated = pkStr === toPublicKey(hop.poolId).toBase58()
                || pkStr === toPublicKey(hop.vaultA as any).toBase58()
                || pkStr === toPublicKey(hop.vaultB as any).toBase58()
                || tickArrayKeys.some(ta => ta.toBase58() === pkStr);
              // If it's pool-related, we'll verify it below (don't skip)
              // If it's not pool-related and writable, might be created, so skip
              if (!isPoolRelated) {
                try {
                  logger.debug('raydium.clmm.sdk.account.skipped', {
                    cat: 'tx',
                    ctx: {
                      pool: hop.poolId,
                      instructionIndex: ixIdx,
                      accountIndex: accIdx,
                      address: pkStr,
                      role,
                      reason: 'writable_non_pool_account_may_be_created',
                    } as any,
                  });
                } catch {}
                continue;
              }
            }
            
            // Collect for batch fetch instead of fetching immediately
            accountsToVerify.push({ pkObj, pkStr, ixIdx, accIdx, keyMeta, ixProgramId, role, expectedOwner });
          }
        }
      }
      
      // Batch fetch all accounts at once to reduce RPC rate limit issues
      if (accountsToVerify.length > 0) {
        try {
          const keys = accountsToVerify.map(a => a.pkObj);
          // Use weight scaling for batch requests (similar to drift client)
          const weight = Math.max(1, Math.ceil(keys.length / 5));
          const accountInfos = await withRpcLimit(() => connection.getMultipleAccountsInfo(keys), weight).catch(() => null);
          
          // Process results
          if (accountInfos && accountInfos.length === accountsToVerify.length) {
            for (let i = 0; i < accountsToVerify.length; i++) {
              const { pkObj, pkStr, ixIdx, accIdx, keyMeta, ixProgramId, role, expectedOwner } = accountsToVerify[i];
              const acc = accountInfos[i];
              
              if (!acc || !acc.data || acc.data.length === 0) {
                missingAccounts.push({
                  instructionIndex: ixIdx,
                  accountIndex: accIdx,
                  address: pkStr,
                  programId: ixProgramId,
                });
                try {
                  logger.error('raydium.clmm.sdk.account.missing', {
                    cat: 'tx',
                    ctx: {
                      pool: hop.poolId,
                      instructionIndex: ixIdx,
                      accountIndex: accIdx,
                      address: pkStr,
                      role: role || 'unknown',
                      expectedOwner: expectedOwner || 'unknown',
                      isSigner: !!keyMeta.isSigner,
                      isWritable: !!keyMeta.isWritable,
                      owner: acc?.owner?.toBase58?.() || 'none',
                      // Critical: This account is missing and will cause ProgramAccountNotFound
                    } as any,
                  });
                } catch {}
              } else {
                // Verify account owner matches expected program
                const actualOwner = acc.owner.toBase58();
                const ownerMatches = expectedOwner ? actualOwner === expectedOwner : true;
                
                try {
                  logger.info('raydium.clmm.sdk.account.verified', {
                    cat: 'tx',
                    ctx: {
                      pool: hop.poolId,
                      instructionIndex: ixIdx,
                      accountIndex: accIdx,
                      address: pkStr,
                      role: role || 'unknown',
                      expectedOwner: expectedOwner || 'any',
                      actualOwner: actualOwner,
                      ownerMatches,
                      dataLen: acc.data.length,
                      isSigner: !!keyMeta.isSigner,
                      isWritable: !!keyMeta.isWritable,
                    } as any,
                  });
                  
                  // Warn if owner doesn't match expected
                  if (!ownerMatches && expectedOwner) {
                    logger.warn('raydium.clmm.sdk.account.owner_mismatch', {
                      cat: 'tx',
                      ctx: {
                        pool: hop.poolId,
                        instructionIndex: ixIdx,
                        accountIndex: accIdx,
                        address: pkStr,
                        role: role || 'unknown',
                        expectedOwner,
                        actualOwner,
                        warning: 'Account owner does not match expected program - may cause ProgramAccountNotFound',
                      } as any,
                    });
                  }
                } catch {}
              }
            }
          } else {
            // Fallback: if batch fetch failed or returned unexpected results, log warning
            try {
              logger.warn('raydium.clmm.sdk.account.batch_fetch.failed', {
                cat: 'tx',
                ctx: {
                  pool: hop.poolId,
                  expectedCount: accountsToVerify.length,
                  actualCount: accountInfos?.length || 0,
                } as any,
              });
            } catch {}
            // Still add all accounts as missing since we couldn't verify them
            for (const { pkStr, ixIdx, accIdx, ixProgramId } of accountsToVerify) {
              missingAccounts.push({
                instructionIndex: ixIdx,
                accountIndex: accIdx,
                address: pkStr,
                programId: ixProgramId,
              });
            }
          }
        } catch (e: any) {
          // If batch verification fails, log but don't fail yet (might be network issue)
          try {
            logger.warn('raydium.clmm.sdk.account.batch_verify.error', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                accountCount: accountsToVerify.length,
                error: String(e?.message || e),
              } as any,
            });
          } catch {}
          // Still add all accounts as missing since we couldn't verify them
          for (const { pkStr, ixIdx, accIdx, ixProgramId } of accountsToVerify) {
            missingAccounts.push({
              instructionIndex: ixIdx,
              accountIndex: accIdx,
              address: pkStr,
              programId: ixProgramId,
            });
          }
        }
      }
      
      if (missingAccounts.length > 0) {
        // Enrich missing accounts with role information
        const missingAccountsWithRoles = missingAccounts.map(a => {
          const accountInfo = accountsToVerify.find(av => av.ixIdx === a.instructionIndex && av.accIdx === a.accountIndex);
          return {
            ...a,
            role: accountInfo?.role || 'unknown',
            expectedOwner: accountInfo?.expectedOwner || 'unknown',
          };
        });
        
        const missingList = missingAccountsWithRoles.map(a => 
          `${a.address} (ix=${a.instructionIndex}, acc=${a.accountIndex}, role=${a.role})`
        ).join(', ');
        
        // CRITICAL: Log summary BEFORE throwing to ensure it's captured
        try {
          logger.error('raydium.clmm.sdk.accounts.missing', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId,
              missingCount: missingAccounts.length,
              missingAccounts: missingAccountsWithRoles,
              missingList: missingList,
              // Critical: These accounts are missing and will cause ProgramAccountNotFound during simulation
            } as any,
          });
          // Small delay to ensure log is written before throwing
          await new Promise(resolve => setTimeout(resolve, 10));
        } catch {}
        throw createBuilderError('RAYDIUM_CLMM', `SDK-generated instruction contains missing accounts: ${missingList}`, hop);
      } else {
        // Log success summary with account details
        try {
          const verifiedAccountsSummary = accountsToVerify.map(a => ({
            address: a.pkStr,
            role: a.role || 'unknown',
            index: a.accIdx,
            expectedOwner: a.expectedOwner || 'any',
          }));
          
          logger.info('raydium.clmm.sdk.verification.complete', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId,
              verifiedAllAccounts: true,
              verifiedCount: accountsToVerify.length,
              verifiedAccounts: verifiedAccountsSummary,
            } as any,
          });
        } catch {}
      }
    }
    
    // If exBitmap doesn't exist, we need to remove it from the instruction
    // BUT we need to be careful - the SDK might have encoded account indices in the instruction data
    // So we need to remove it in a way that doesn't break the instruction
    if (ixs && ixs.length && exBitmapPk && !exBitmapExists) {
      try {
        logger.warn('raydium.clmm.exbitmap.removing_from_instruction', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            exBitmap: exBitmapPk.toBase58(),
            instructionCount: ixs.length,
            warning: 'SDK instruction data may reference account indices - removing exBitmap may break the instruction',
          } as any,
        });
        
        // Find the instruction that contains the exBitmap (should be the CLMM swap instruction)
        const filteredIxs: TransactionInstruction[] = [];
        for (let ixIdx = 0; ixIdx < ixs.length; ixIdx++) {
          const ix = ixs[ixIdx];
          if (ix instanceof TransactionInstruction && Array.isArray(ix.keys)) {
            // Check if this instruction targets the CLMM program
            if (ix.programId.equals(programIdPk)) {
              // This is the CLMM swap instruction - find and remove exBitmap
              const exBitmapIdx = ix.keys.findIndex((k: any) => {
                const pk = k?.pubkey;
                return pk && (pk.equals ? pk.equals(exBitmapPk) : pk.toBase58() === exBitmapPk.toBase58());
              });
              
              if (exBitmapIdx >= 0) {
                // Remove exBitmap from keys
                // NOTE: This may break the instruction if the SDK encoded account indices in the data
                // The instruction data might reference account positions, so removing an account shifts all indices
                const filteredKeys = ix.keys.filter((_, idx) => idx !== exBitmapIdx);
                filteredIxs.push(new TransactionInstruction({
                  programId: ix.programId,
                  keys: filteredKeys,
                  data: ix.data, // This data might still reference old account indices
                }));
                
                try {
                  logger.warn('raydium.clmm.exbitmap.removed_from_instruction', {
                    cat: 'tx',
                    ctx: {
                      pool: hop.poolId,
                      instructionIndex: ixIdx,
                      exBitmapIndex: exBitmapIdx,
                      originalAccountCount: ix.keys.length,
                      newAccountCount: filteredKeys.length,
                      warning: 'Instruction data may still reference old account indices',
                    } as any,
                  });
                } catch {}
              } else {
                filteredIxs.push(ix);
              }
            } else {
              filteredIxs.push(ix);
            }
          } else {
            filteredIxs.push(ix as TransactionInstruction);
          }
        }
        
        if (filteredIxs.length > 0) {
          ixs = filteredIxs;
        }
      } catch (e: any) {
        try {
          logger.warn('raydium.clmm.exbitmap.removal.failed', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId,
              error: String(e?.message || e),
            } as any,
          });
        } catch {}
      }
    }
    
    // Verify all critical accounts exist before proceeding
    if (ixs && ixs.length) {
      // Batch fetch observation and exBitmap accounts together to reduce RPC calls
      try {
        const connection = getConnection();
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const accountsToCheck: PublicKey[] = [observationId];
        if (exBitmapPk) {
          accountsToCheck.push(exBitmapPk);
        }
        
        const weight = Math.max(1, Math.ceil(accountsToCheck.length / 5));
        const accountInfos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(accountsToCheck),
          weight
        ).catch(() => null);
        
        // Verify observation account exists
        if (!accountInfos || accountInfos.length < 1 || !accountInfos[0] || !accountInfos[0].data || accountInfos[0].data.length === 0) {
          throw createBuilderError('RAYDIUM_CLMM', `observation account does not exist: ${observationId.toBase58()}`, hop);
        }
        try {
          logger.debug('raydium.clmm.observation.verified', { cat: 'tx', ctx: { pool: hop.poolId, observation: observationId.toBase58() } as any });
        } catch {}
        
        // Check exBitmap if it was included
        if (exBitmapPk && accountInfos.length >= 2) {
          const exBitmapAcc = accountInfos[1];
          exBitmapExists = !!exBitmapAcc && !!exBitmapAcc.data && exBitmapAcc.data.length > 0;
          try {
            if (exBitmapExists) {
              logger.debug('raydium.clmm.exbitmap.precheck.exists', {
                cat: 'tx',
                ctx: {
                  pool: hop.poolId,
                  exBitmap: exBitmapPk.toBase58(),
                  owner: exBitmapAcc.owner.toBase58(),
                  dataLen: exBitmapAcc.data.length,
                } as any,
              });
            } else {
              logger.warn('raydium.clmm.exbitmap.precheck.missing', {
                cat: 'tx',
                ctx: {
                  pool: hop.poolId,
                  exBitmap: exBitmapPk.toBase58(),
                } as any,
              });
            }
          } catch {}
        }
      } catch (e: any) {
        if (e instanceof Error && e.message.includes('RAYDIUM_CLMM_BUILD_FAILED')) throw e;
        try { logger.warn('raydium.clmm.observation.verify.failed', { cat: 'tx', ctx: { pool: hop.poolId, error: String(e?.message || e) } as any }); } catch {}
      }
      
      // Verify all accounts in each instruction to catch missing accounts early
      // But skip accounts that don't need to exist yet (signers, writable accounts that can be created)
      const verifiedIxs: TransactionInstruction[] = [];
      for (let ixIdx = 0; ixIdx < ixs.length; ixIdx++) {
        const ix = ixs[ixIdx];
        if (ix instanceof TransactionInstruction && Array.isArray(ix.keys)) {
          // Log all accounts in the instruction for debugging
          try {
            logger.info('raydium.clmm.ix.verification.start', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                instructionIndex: ixIdx,
                programId: ix.programId.toBase58(),
                totalAccounts: ix.keys.length,
                accounts: ix.keys.map((k: any, idx: number) => ({
                  index: idx,
                  address: (k?.pubkey?.toBase58?.() || String(k?.pubkey || '')),
                  isSigner: !!k?.isSigner,
                  isWritable: !!k?.isWritable,
                })),
              } as any,
            });
          } catch {}
          
          const missingAccounts: Array<{ address: string; index: number; isSigner: boolean; isWritable: boolean }> = [];
          const verifiedAccounts: Array<{ address: string; index: number; reason: string }> = [];
          const skippedAccounts: Array<{ address: string; index: number; reason: string }> = [];
          
          // Collect accounts to verify first, then batch fetch to reduce RPC calls
          const accountsToVerify: Array<{ pkObj: PublicKey; pkStr: string; keyIdx: number; keyMeta: any }> = [];
          
          // First pass: collect accounts that need verification
          for (let keyIdx = 0; keyIdx < ix.keys.length; keyIdx++) {
            const keyMeta = ix.keys[keyIdx];
            const pk = keyMeta?.pubkey;
            if (!pk) continue; // Skip if no pubkey (shouldn't happen but be safe)
            
            const pkObj = pk instanceof PublicKey ? pk : new PublicKey(pk);
            const pkStr = pkObj.toBase58();
            
            // Skip signer accounts - they're wallet addresses, always valid
            if (keyMeta.isSigner) {
              skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'signer' });
              continue;
            }
            
            // Skip writable accounts that might be created by the transaction
            // (ATAs, new accounts, etc.) - the transaction will create them if needed
            if (keyMeta.isWritable) {
              // Double-check: some writable accounts like vaults MUST exist
              // But user token accounts (ATAs) might not exist yet
              // Skip user token accounts (input/output ATAs) - they can be created
              const isUserTokenAccount = pkStr === toPublicKey(hop.userSourceAta).toBase58() 
                || pkStr === toPublicKey(hop.userDestAta).toBase58();
              if (isUserTokenAccount) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'user_token_account' });
                continue;
              }
              
              // Skip tick arrays - we've already verified them exist
              const isTickArray = tickArrayKeys.some(ta => ta.toBase58() === pkStr);
              if (isTickArray) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'tick_array_already_verified' });
                continue;
              }
              
              // Skip exBitmap account - we handle it separately (remove if doesn't exist)
              if (exBitmapPk && pkStr === exBitmapPk.toBase58()) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'exbitmap_handled_separately' });
                continue;
              }
              
              // For other writable accounts, check if they're pool-related (must exist)
              const isPoolRelated = pkStr === toPublicKey(hop.poolId).toBase58()
                || pkStr === toPublicKey(hop.vaultA as any).toBase58()
                || pkStr === toPublicKey(hop.vaultB as any).toBase58()
                || pkStr === observationId.toBase58();
              if (!isPoolRelated) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'writable_non_pool_account' });
                continue; // Skip other writable accounts (might be created)
              }
            }
            
            try {
              // Skip well-known system accounts that always exist
              const wellKnown = [
                '11111111111111111111111111111111', // System Program
                'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
                'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 Program
                'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
                'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo Program
                'ComputeBudget111111111111111111111111111111', // Compute Budget Program
              ];
              if (wellKnown.includes(pkStr)) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'well_known_system_account' });
                continue;
              }
              
              // Collect for batch fetch - only verify read-only accounts that MUST exist
              // Or writable pool-related accounts (vaults, pool account, observation)
              accountsToVerify.push({ pkObj, pkStr, keyIdx, keyMeta });
            } catch {}
          }
          
          // Batch fetch all accounts at once
          if (accountsToVerify.length > 0) {
            try {
              const connection = getConnection();
              const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
              const keys = accountsToVerify.map(a => a.pkObj);
              const weight = Math.max(1, Math.ceil(keys.length / 5));
              const accountInfos = await withRpcLimit(() => connection.getMultipleAccountsInfo(keys), weight).catch(() => null);
              
              if (accountInfos && Array.isArray(accountInfos) && accountInfos.length === accountsToVerify.length) {
                for (let i = 0; i < accountsToVerify.length; i++) {
                  const { pkStr, keyIdx, keyMeta } = accountsToVerify[i];
                  const acc = accountInfos[i];
                  
                  if (!acc || !acc.data || acc.data.length === 0) {
                    missingAccounts.push({
                      address: pkStr,
                      index: keyIdx,
                      isSigner: !!keyMeta?.isSigner,
                      isWritable: !!keyMeta?.isWritable,
                    });
                    try {
                      logger.warn('raydium.clmm.ix.account.missing', {
                        cat: 'tx',
                        ctx: {
                          pool: hop.poolId,
                          instructionIndex: ixIdx,
                          accountIndex: keyIdx,
                          address: pkStr,
                          isSigner: !!keyMeta?.isSigner,
                          isWritable: !!keyMeta?.isWritable,
                          owner: acc?.owner?.toBase58?.() || 'unknown',
                        } as any,
                      });
                    } catch {}
                  } else {
                    verifiedAccounts.push({ address: pkStr, index: keyIdx, reason: 'exists_on_chain' });
                    try {
                      logger.debug('raydium.clmm.ix.account.verified', {
                        cat: 'tx',
                        ctx: {
                          pool: hop.poolId,
                          instructionIndex: ixIdx,
                          accountIndex: keyIdx,
                          address: pkStr,
                          owner: acc.owner.toBase58(),
                          dataLen: acc.data.length,
                        } as any,
                      });
                    } catch {}
                  }
                }
              } else {
                // Fallback: if batch fetch failed, mark all as missing
                for (const { pkStr, keyIdx, keyMeta } of accountsToVerify) {
                  missingAccounts.push({
                    address: pkStr,
                    index: keyIdx,
                    isSigner: !!keyMeta?.isSigner,
                    isWritable: !!keyMeta?.isWritable,
                  });
                }
              }
            } catch (e: any) {
              // If batch verification fails, mark all as missing
              try {
                logger.warn('raydium.clmm.ix.account.batch_verify.error', {
                  cat: 'tx',
                  ctx: {
                    pool: hop.poolId,
                    instructionIndex: ixIdx,
                    accountCount: accountsToVerify.length,
                    error: String(e?.message || e),
                  } as any,
                });
              } catch {}
              for (const { pkStr, keyIdx, keyMeta } of accountsToVerify) {
                missingAccounts.push({
                  address: pkStr,
                  index: keyIdx,
                  isSigner: !!keyMeta?.isSigner,
                  isWritable: !!keyMeta?.isWritable,
                });
              }
            }
          }
          
          // Log verification summary
          try {
            logger.info('raydium.clmm.ix.verification.summary', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                instructionIndex: ixIdx,
                totalAccounts: ix.keys.length,
                verified: verifiedAccounts.length,
                skipped: skippedAccounts.length,
                missing: missingAccounts.length,
                verifiedAccounts: verifiedAccounts.map(a => `${a.address} (idx=${a.index}, reason=${a.reason})`),
                skippedAccounts: skippedAccounts.map(a => `${a.address} (idx=${a.index}, reason=${a.reason})`),
                missingAccounts: missingAccounts.map(a => `${a.address} (idx=${a.index}, signer=${a.isSigner}, writable=${a.isWritable})`),
              } as any,
            });
          } catch {}
          
          if (missingAccounts.length > 0) {
            try {
              logger.error('raydium.clmm.ix.accounts.missing', { 
                cat: 'tx', 
                ctx: { 
                  pool: hop.poolId,
                  instructionIndex: ixIdx,
                  missingAccounts: missingAccounts.map(a => `${a.address} (idx=${a.index}, signer=${a.isSigner}, writable=${a.isWritable})`),
                  totalKeys: ix.keys.length,
                  programId: ix.programId.toBase58(),
                } as any 
              });
            } catch {}
            throw createBuilderError('RAYDIUM_CLMM', `instruction ${ixIdx} contains missing read-only accounts: ${missingAccounts.map(a => a.address).join(', ')}`, hop);
          }
          
          verifiedIxs.push(ix);
        } else {
          verifiedIxs.push(ix as TransactionInstruction);
        }
      }
      
      if (verifiedIxs.length > 0) {
        ixs = verifiedIxs;
      }
    }
    
    // Log final instructions after all processing
    try {
      logger.info('raydium.clmm.instructions.final', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          instructionCount: ixs?.length || 0,
          instructions: ixs?.map((ix: any, idx: number) => ({
            index: idx,
            programId: (ix?.programId?.toBase58?.() || String(ix?.programId || '')),
            accountCount: (ix?.keys?.length || 0),
            accounts: (ix?.keys || []).map((k: any, accIdx: number) => ({
              index: accIdx,
              address: (k?.pubkey?.toBase58?.() || String(k?.pubkey || '')),
              isSigner: !!k?.isSigner,
              isWritable: !!k?.isWritable,
            })),
          })) || [],
        } as any,
      });
    } catch {}
    
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
    // Cache the pool account info to avoid duplicate RPC calls
    let poolAccountInfo: any = null;
    try {
      if (!hop.market || !hop.serumProgramId) {
        const connection = getConnection();
        const poolPk = toPublicKey(hop.poolId);
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        poolAccountInfo = await withRpcLimit(() => connection.getAccountInfo(poolPk));
        if (poolAccountInfo?.data?.length) {
          const rmod: any = await import('@raydium-io/raydium-sdk-v2');
          const layouts = [
            (rmod as any)?.LiquidityStateLayoutV4,
            (rmod as any)?.liquidityStateV4Layout,
            (rmod as any)?.LiquidityStateLayoutV5,
            (rmod as any)?.liquidityStateV5Layout,
          ].filter(Boolean);
          for (const layout of layouts) {
            try {
              const state = layout.decode(poolAccountInfo.data);
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
    // Reuse cached pool account info if available to avoid duplicate RPC call
    try {
      let acc = poolAccountInfo;
      if (!acc) {
        // Use account cache instead of direct RPC call
        const { accountCache } = await import('../utils/accountCache.js');
        acc = await accountCache.getAccountInfo(toPublicKey(hop.poolId));
      }
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
        // Extract programId properly - handle both our TI instances and foreign ones
        let programId: PublicKey;
        if (ixAny instanceof TransactionInstruction) {
          // If it's already a TI, extract and normalize the programId from it
          programId = normalizePkLoose((ixAny as any).programId);
        } else if (ixAny?.programId) {
          // If it has a programId field, normalize it
          programId = normalizePkLoose(ixAny.programId);
        } else {
          // Fallback to ammProgramId if we can't extract it
          programId = ammProgramId;
        }
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
      // ALWAYS coerce all instructions, even if they're already TransactionInstruction instances
      // This ensures programId and keys are normalized to our web3.js instance
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


