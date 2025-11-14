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
/**
 * Calculate required bin arrays based on swap amount, liquidity, and direction
 * Returns the bin range needed for the swap instead of using arbitrary limits
 */
async function calculateRequiredBinArrays(
  DLMM: any,
  program: any,
  poolPk: any,
  programId: any,
  activeBinId: any,
  hop: any,
  acctBase: any,
  binIdToBinArrayIndex: any,
  getBinArrayLowerUpperBinId: any
): Promise<{
  lowerBinId: any;
  upperBinId: any;
  binsTraversed: number;
  count: number;
  direction: 'up' | 'down' | 'both';
}> {
  const bnjs = await import('bn.js').catch(() => null);
  const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
  
  if (!BN) throw new Error('BN.js not available');
  
  const binArraySize = (DLMM as any)?.MAX_BIN_ARRAY_SIZE ?? new BN(70);
  
  // Determine swap direction
  const inputMintPk = toPublicKey(hop.inputMint);
  const outputMintPk = toPublicKey(hop.outputMint);
  const tokenXMintPk = acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint);
  const tokenYMintPk = acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint);
  
  const isXToY = inputMintPk.equals(tokenXMintPk) && outputMintPk.equals(tokenYMintPk);
  const isYToX = inputMintPk.equals(tokenYMintPk) && outputMintPk.equals(tokenXMintPk);
  
  // Get pool state to calculate liquidity and estimate price impact
  let poolState: any = null;
  try {
    poolState = await program.account.lbPair.fetch(poolPk);
  } catch (fetchErr) {
    try {
      logger.debug('meteora.dlmm.pool_state.fetch_failed', {
        cat: 'tx',
        ctx: { error: String((fetchErr as any)?.message || fetchErr) }
      });
    } catch {}
  }
  
  // Method 1: Try to use swapQuote if available (most accurate)
  try {
    const swapQuote = DLMM?.swapQuote || DLMM?.swapQuoteWithCap;
    if (swapQuote && poolState) {
      const amountIn = new BN(hop.amountInRaw.toString());
      const quote = await swapQuote(
        poolPk,
        amountIn,
        isXToY, // swapForY
        new BN(0), // slippage
        program
      );
      
      // Check if quote contains bin information
      if (quote?.minBinId && quote?.maxBinId) {
        const minBinIdx = binIdToBinArrayIndex(quote.minBinId);
        const maxBinIdx = binIdToBinArrayIndex(quote.maxBinId);
        
        const [minLower] = getBinArrayLowerUpperBinId(minBinIdx);
        const [, maxUpper] = getBinArrayLowerUpperBinId(maxBinIdx);
        
        const binsTraversed = Math.abs(quote.maxBinId.toNumber() - quote.minBinId.toNumber());
        const binArrayCount = Math.abs(maxBinIdx.toNumber() - minBinIdx.toNumber()) + 1;
        
        try {
          logger.info('meteora.dlmm.bin_range.from_quote', {
            cat: 'tx',
            ctx: {
              binsTraversed,
              binArrayCount,
              direction: isXToY ? 'X->Y (down)' : 'Y->X (up)',
              minBinId: quote.minBinId.toString(),
              maxBinId: quote.maxBinId.toString()
            }
          });
        } catch {}
        
        return {
          lowerBinId: minLower,
          upperBinId: maxUpper,
          binsTraversed,
          count: binArrayCount,
          direction: isXToY ? 'down' : 'up'
        };
      }
    }
  } catch (quoteErr) {
    // Quote failed, fall through to estimation
    try {
      logger.debug('meteora.dlmm.quote.failed', {
        cat: 'tx',
        ctx: { error: String((quoteErr as any)?.message || quoteErr) }
      });
    } catch {}
  }
  
  // Method 2: Estimate based on swap amount and average bin liquidity
  try {
    const activeBinIdx = binIdToBinArrayIndex(activeBinId);
    const [currentLower, currentUpper] = getBinArrayLowerUpperBinId(activeBinIdx);
    
    // Get liquidity from pool state if available
    let totalLiquidity = new BN(0);
    if (poolState?.reserveX && poolState?.reserveY) {
      totalLiquidity = poolState.reserveX.add(poolState.reserveY);
    }
    
    // Estimate how many bins we'll need based on amount vs liquidity
    // This is a conservative heuristic based on swap size:
    // Each bin array contains ~70 bins, so we need to be careful not to over-estimate
    // - Tiny swaps (< 0.5% of liquidity): 1 bin array (active bin only)
    // - Small swaps (0.5-2% of liquidity): 2 bin arrays
    // - Medium swaps (2-5% of liquidity): 3 bin arrays
    // - Large swaps (5-10% of liquidity): 4 bin arrays
    // - Very large swaps (> 10% of liquidity): 6 bin arrays
    const swapAmount = new BN(hop.amountInRaw.toString());
    const swapRatio = totalLiquidity.gt(new BN(0)) 
      ? swapAmount.mul(new BN(10000)).div(totalLiquidity).toNumber() / 10000
      : 0.05; // Default to 5% if can't calculate (conservative)
    
    let binArraysNeeded: number;
    if (swapRatio < 0.005) {
      binArraysNeeded = 1; // < 0.5% of liquidity - tiny swap
    } else if (swapRatio < 0.02) {
      binArraysNeeded = 2; // 0.5-2% of liquidity - small swap
    } else if (swapRatio < 0.05) {
      binArraysNeeded = 3; // 2-5% of liquidity - medium swap
    } else if (swapRatio < 0.10) {
      binArraysNeeded = 4; // 5-10% of liquidity - large swap
    } else {
      binArraysNeeded = 6; // > 10% of liquidity - very large swap
    }
    
    // Calculate range based on direction and estimated bins needed
    let lowerBinId: any;
    let upperBinId: any;
    let direction: 'up' | 'down' | 'both';
    
    if (isXToY) {
      // X→Y: Price moves DOWN, expand LOWER range only
      lowerBinId = currentLower.sub(binArraySize.mul(new BN(binArraysNeeded)));
      upperBinId = currentUpper.add(binArraySize); // Just include active + 1 above
      direction = 'down';
    } else if (isYToX) {
      // Y→X: Price moves UP, expand UPPER range only
      lowerBinId = currentLower.sub(binArraySize); // Just include active + 1 below
      upperBinId = currentUpper.add(binArraySize.mul(new BN(binArraysNeeded)));
      direction = 'up';
    } else {
      // Unknown direction: expand both (fallback to safe behavior)
      const safeFactor = Math.ceil(binArraysNeeded / 2);
      lowerBinId = currentLower.sub(binArraySize.mul(new BN(safeFactor)));
      upperBinId = currentUpper.add(binArraySize.mul(new BN(safeFactor)));
      direction = 'both';
    }
    
    try {
      logger.info('meteora.dlmm.bin_range.estimated', {
        cat: 'tx',
        ctx: {
          swapRatio: (swapRatio * 100).toFixed(2) + '%',
          estimatedBinArrays: binArraysNeeded,
          direction: isXToY ? 'X->Y (down)' : isYToX ? 'Y->X (up)' : 'unknown',
          totalLiquidity: totalLiquidity.toString(),
          swapAmount: swapAmount.toString()
        }
      });
    } catch {}
    
    return {
      lowerBinId,
      upperBinId,
      binsTraversed: binArraysNeeded * 70, // Approximate (70 bins per array)
      count: binArraysNeeded,
      direction
    };
  } catch (estimateErr) {
    // Final fallback: use direction-aware fixed range
    try {
      logger.debug('meteora.dlmm.bin_estimate.failed', {
        cat: 'tx',
        ctx: { error: String((estimateErr as any)?.message || estimateErr) }
      });
    } catch {}
    
    const activeBinIdx = binIdToBinArrayIndex(activeBinId);
    const [currentLower, currentUpper] = getBinArrayLowerUpperBinId(activeBinIdx);
    
    // Use direction-aware fixed expansion (conservative fallback)
    // Start with 3 bin arrays as a reasonable default
    const fixedExpansion = new BN(3);
    let lowerBinId: any;
    let upperBinId: any;
    let direction: 'up' | 'down' | 'both';
    
    if (isXToY) {
      lowerBinId = currentLower.sub(binArraySize.mul(fixedExpansion));
      upperBinId = currentUpper.add(binArraySize);
      direction = 'down';
    } else if (isYToX) {
      lowerBinId = currentLower.sub(binArraySize);
      upperBinId = currentUpper.add(binArraySize.mul(fixedExpansion));
      direction = 'up';
    } else {
      lowerBinId = currentLower.sub(binArraySize.mul(new BN(2)));
      upperBinId = currentUpper.add(binArraySize.mul(new BN(2)));
      direction = 'both';
    }
    
    try {
      logger.info('meteora.dlmm.bin_range.fallback', {
        cat: 'tx',
        ctx: {
          fixedExpansion: fixedExpansion.toString(),
          direction: isXToY ? 'X->Y (down)' : isYToX ? 'Y->X (up)' : 'unknown'
        }
      });
    } catch {}
    
    return {
      lowerBinId,
      upperBinId,
      binsTraversed: fixedExpansion.toNumber() * 70,
      count: fixedExpansion.toNumber(),
      direction
    };
  }
}

async function injectBinArrayMetas(
  ix: any,
  DLMM: any,
  connection: any,
  poolPk: PublicKey,
  programId: PublicKey,
  poolId?: string  // Add poolId parameter to check cache
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
    
    // OPTIMIZATION: First try to get bin arrays from cache (pre-computed during pool refresh)
    if (poolId) {
      try {
        const { executionCache } = await import('../cache.js');
        const hot = executionCache.getHot(poolId);
        
        if (hot?.binArrays) {
          // Use cached bin array addresses!
          const cachedMetas: any[] = [];
          
          if (hot.binArrays.lower) {
            try {
              cachedMetas.push({
                pubkey: new PublicKey(hot.binArrays.lower),
                isWritable: true,
                isSigner: false
              });
            } catch {}
          }
          
          if (hot.binArrays.upper) {
            try {
              cachedMetas.push({
                pubkey: new PublicKey(hot.binArrays.upper),
                isWritable: true,
                isSigner: false
              });
            } catch {}
          }
          
          if (cachedMetas.length > 0) {
            metas = cachedMetas;
            try {
              logger.debug('meteora.dlmm.binArrays.from_cache', {
                cat: 'tx',
                ctx: { 
                  pool: poolId.slice(0, 8) + '...', 
                  count: cachedMetas.length,
                  lower: hot.binArrays.lower?.slice(0, 8) + '...',
                  upper: hot.binArrays.upper?.slice(0, 8) + '...'
                }
              });
            } catch {}
          }
        }
      } catch (cacheErr) {
        try {
          logger.debug('meteora.dlmm.binArrays.cache_lookup_failed', {
            cat: 'tx',
            ctx: { error: String((cacheErr as any)?.message || cacheErr) }
          });
        } catch {}
      }
    }
    
    // Try primary method: getBinArrayAccountMetasCoverage with bounds (only if cache miss)
    // Note: Do NOT use large ranges - getBinArrayAccountMetasCoverage returns ALL arrays in range
    // For swaps, we only need a few bin arrays around the active bin
    if (!metas || metas.length === 0) {
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
                // OPTIMIZATION: Try to get active bin from cache first (saves 100-200ms RPC call)
                let activeId: any = undefined;
                
                // Try cache first
                if (poolId) {
                  try {
                    const { executionCache } = await import('../cache.js');
                    const hot = executionCache.getHot(poolId);
                    if (hot?.activeId !== undefined) {
                      activeId = hot.activeId;
                      try {
                        logger.debug('meteora.dlmm.activeId.from_cache', {
                          cat: 'tx',
                          ctx: { pool: poolId.slice(0, 8) + '...', activeId: String(activeId) }
                        });
                      } catch {}
                    }
                  } catch {}
                }
                
                // Fallback to RPC if not in cache
                if (activeId === undefined) {
                  try {
                    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
                    const poolState = await withRpcLimit(
                      () => connection.getAccountInfo(poolPk),
                      1,
                      { module: 'execution', method: 'getAccountInfo' }
                    ) as any;
                    if (poolState?.data?.length) {
                      const decode = (DLMM as any)?.decodeAccount;
                      if (decode) {
                        const state = decode({ coder: (DLMM as any)?.coder ?? {} }, 'lbPair', poolState.data);
                        activeId = state?.activeId;
                        try {
                          logger.debug('meteora.dlmm.activeId.from_rpc', {
                            cat: 'tx',
                            ctx: { pool: poolPk.toBase58().slice(0, 8) + '...', activeId: String(activeId) }
                          });
                        } catch {}
                      }
                    }
                  } catch {}
                }
                
                // Try to get active bin from pool state to use a small range
                try {
                  if (activeId !== undefined) {
                    const activeBn = activeId instanceof BN ? activeId : new BN(String(activeId));
                    const idx = binIdToBinArrayIndex(activeBn);
                    const arrIdx = idx instanceof BN ? idx : new BN(String(idx));
                    // Get bounds for just the active bin array
                    const [lower, upper] = getBounds(arrIdx);
                    // Use minimal range: just the active bin array bounds (typically 1-3 arrays)
                    // This is sufficient for most swaps and keeps transaction size minimal
                    const rangeLower = lower;
                    const rangeUpper = upper;
                    const rawMetas = getMetas(rangeLower, rangeUpper, poolPk, programId) || [];
                    // Limit to max 5 bin arrays - sufficient for active bin + adjacents
                    metas = rawMetas.slice(0, 5);
                  }
                } catch {}
                // Fallback removed - don't use huge default ranges that return hundreds
              }
            } catch {}
          } else {
            try {
              metas = getMetas(poolPk, programId) || [];
              // Limit results if it's an array
              if (Array.isArray(metas)) metas = metas.slice(0, 5);
            } catch {}
          }
        }
      } catch (e: any) {
        try { logger.debug('meteora.dlmm.inject.bounds.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
      }
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
          // Limit to max 5 bin arrays - getCoverage can return all bin arrays in pool
          metas = Array.isArray(raw) ? raw.slice(0, 5) : [];
        }
      } catch (e: any) {
        try { logger.debug('meteora.dlmm.inject.coverage.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
      }
    }
    
    // NOTE: Bitmap extension is handled automatically by the Meteora SDK
    // The SDK includes the correct bitmap extension PDA when building swap instructions
    // We don't need to derive or inject it ourselves - just provide the program ID
    // This aligns with best practices observed in other Meteora integrations
    
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
    // Extract only the first 32 bytes (the actual private key)
    const privateKeyBytes = kp.secretKey.slice(0, 32);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes, false);
    orcaSignerCache = { pubkey: pk, signer };
  }
  return orcaSignerCache.signer;
}

/**
 * Build Orca swap instruction locally without RPC calls
 * Uses cached pool state from executionCache
 */
async function buildOrcaSwapIxLocal(hop: DirectHop, kp: { publicKey: PublicKey; secretKey: Uint8Array }): Promise<{ instructions: TransactionInstruction[]; quote: any }> {
  const startTime = performance.now();
  
  // Get cached pool data (NO RPC!)
  const { executionCache } = await import('../cache.js');
  const staticData = executionCache.getStatic(hop.poolId);
  const hot = executionCache.getHot(hop.poolId);
  
  if (!staticData || !hot) {
    throw createBuilderError('ORCA', 'Pool data not in execution cache - cannot build locally', hop);
  }
  
  // Get tick arrays from cache (NO RPC!)
  const tickArrayLower = hot.tickArrays?.lower;
  const tickArrayCenter = hot.tickArrays?.center;
  const tickArrayUpper = hot.tickArrays?.upper;
  
  if (!tickArrayLower || !tickArrayCenter || !tickArrayUpper) {
    throw createBuilderError('ORCA', 'Tick arrays not in cache - cannot build locally', hop);
  }
  
  try {
    logger.debug('orca.local.build.start', {
      cat: 'tx',
      ctx: {
        pool: hop.poolId,
        hasStatic: !!staticData,
        hasHot: !!hot,
        hasTickArrays: !!(tickArrayLower && tickArrayCenter && tickArrayUpper),
      } as any
    });
  } catch {}
  
  // Determine swap direction
  const inputMintStr = String(hop.inputMint);
  const mintA = staticData.mint_a;
  const mintB = staticData.mint_b;
  const aToB = inputMintStr === mintA;
  
  if (!aToB && inputMintStr !== mintB) {
    throw createBuilderError('ORCA', `Input mint ${inputMintStr} does not match pool mints (A: ${mintA}, B: ${mintB})`, hop);
  }
  
  // Get vault addresses
  const vaultA = staticData.vaults?.a;
  const vaultB = staticData.vaults?.b;
  const oracle = staticData.oracle;
  
  if (!vaultA || !vaultB) {
    throw createBuilderError('ORCA', 'Vault addresses not in cache', hop);
  }
  
  // Build instruction accounts (based on Orca Whirlpool swap account layout)
  const programId = toPublicKey(staticData.programId || (CONFIG as any).orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  
  const keys = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // #0 tokenProgram
    { pubkey: kp.publicKey, isSigner: true, isWritable: false }, // #1 tokenAuthority (signer)
    { pubkey: toPublicKey(hop.poolId), isSigner: false, isWritable: true }, // #2 whirlpool
    { pubkey: toPublicKey(hop.userSourceAta), isSigner: false, isWritable: true }, // #3 tokenOwnerAccountA or tokenOwnerAccountB (input)
    { pubkey: toPublicKey(vaultA), isSigner: false, isWritable: true }, // #4 tokenVaultA
    { pubkey: toPublicKey(vaultB), isSigner: false, isWritable: true }, // #5 tokenVaultB
    { pubkey: toPublicKey(tickArrayLower), isSigner: false, isWritable: true }, // #6 tickArray0
    { pubkey: toPublicKey(tickArrayCenter), isSigner: false, isWritable: true }, // #7 tickArray1
    { pubkey: toPublicKey(tickArrayUpper), isSigner: false, isWritable: true }, // #8 tickArray2
    { pubkey: toPublicKey(hop.userDestAta), isSigner: false, isWritable: true }, // #9 tokenOwnerAccountB or tokenOwnerAccountA (output)
  ];
  
  // Add oracle if available
  if (oracle) {
    keys.push({ pubkey: toPublicKey(oracle), isSigner: false, isWritable: false }); // #10 oracle (optional)
  }
  
  // Encode swap instruction data
  // Orca uses Anchor discriminator: sha256("global:swap")[0..8]
  // For Whirlpool swap, the discriminator is: 0xf8c69e91e17587c8
  // Followed by: amount (u64), otherAmountThreshold (u64), sqrtPriceLimit (u128), amountSpecifiedIsInput (bool), aToB (bool)
  
  const dataBuffer = Buffer.alloc(42); // 8 + 8 + 8 + 16 + 1 + 1
  let offset = 0;
  
  // Discriminator (8 bytes)
  dataBuffer.writeBigUInt64LE(0xf8c69e91e17587c8n, offset);
  offset += 8;
  
  // amount (u64) - input amount
  dataBuffer.writeBigUInt64LE(BigInt(hop.amountInRaw ?? 0n), offset);
  offset += 8;
  
  // otherAmountThreshold (u64) - minimum output amount
  dataBuffer.writeBigUInt64LE(BigInt(hop.minOutRaw ?? 0n), offset);
  offset += 8;
  
  // sqrtPriceLimit (u128) - 0 means no limit
  dataBuffer.writeBigUInt64LE(0n, offset); // low 64 bits
  offset += 8;
  dataBuffer.writeBigUInt64LE(0n, offset); // high 64 bits
  offset += 8;
  
  // amountSpecifiedIsInput (bool) - true for exact input swaps
  dataBuffer.writeUInt8(1, offset);
  offset += 1;
  
  // aToB (bool) - swap direction
  dataBuffer.writeUInt8(aToB ? 1 : 0, offset);
  offset += 1;
  
  const swapIx = new TransactionInstruction({
    keys,
    programId,
    data: dataBuffer,
  });
  
  const buildTime = performance.now() - startTime;
  
  try {
    logger.info('orca.local.build.success', {
      cat: 'tx',
      ctx: {
        pool: hop.poolId,
        aToB,
        amountIn: hop.amountInRaw?.toString(),
        minOut: hop.minOutRaw?.toString(),
        buildTimeMs: buildTime.toFixed(2),
        accountCount: keys.length,
      } as any
    });
  } catch {}
  
  // Create a minimal quote object for compatibility
  const quote = {
    tokenEstOut: hop.minOutRaw,
    tokenMinOut: hop.minOutRaw,
    estimatedAmountOut: hop.minOutRaw,
    inputAmount: hop.amountInRaw,
    tokenAmountIn: hop.amountInRaw,
  };
  
  return { instructions: [swapIx], quote };
}

async function buildOrcaSwapViaSdk(hop: DirectHop, kp: { publicKey: PublicKey; secretKey: Uint8Array }, slippageBps: number): Promise<{ instructions: TransactionInstruction[]; quote: any }> {
  await ensureOrcaSdkConfig();
  const rpc = getOrcaRpc();
  const signer = await getOrcaSdkSigner(kp);
  // Strip -rev suffix before creating address (similar to Raydium/Meteora)
  const poolIdStripped = String(hop.poolId).replace(/-rev$/, '');
  const poolAddr = address(poolIdStripped);
  const inputMintAddr = address(String(hop.inputMint));
  const amountIn = BigInt(hop.amountInRaw ?? 0n);
  if (amountIn <= 0n) {
    throw createBuilderError('ORCA', 'input amount must be positive for swapInstructions', hop);
  }
  
  // Log RPC call warning - this SDK method makes internal RPC calls
  try {
    logger.warn('orca.sdk.swapInstructions.rpc_call', {
      cat: 'tx',
      code: LogCode.TX_BUILD_HOP,
      ctx: {
        pool: hop.poolId,
        warning: 'Orca swapInstructions SDK makes internal RPC calls - consider local implementation',
        amountIn: amountIn.toString(),
        slippageBps
      } as any
    });
  } catch {}
  
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

    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const infos = await withRpcLimit(
      () => ctx.connection.getMultipleAccountsInfo(requiredKeys),
      Math.max(1, Math.ceil(requiredKeys.length / 100)),
      { module: 'execution', method: 'getMultipleAccountsInfo' }
    );
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
    // Strip -rev suffix before using poolId (similar to Raydium/Meteora)
    const poolIdStripped = String(hop.poolId).replace(/-rev$/, '');
    const poolAddr = poolIdStripped;
    const inputMint = String(hop.inputMint);
    
    // Pre-build validation: amounts
    validateHopAmounts(hop, { dex: 'orca', variant: 'clmm', poolId: hop.poolId });
    
    // Precheck: ensure pool contains input mint to avoid zero-out quotes
    try {
      const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
      if (sdkAny && hop.poolId && hop.inputMint) {
        const { PublicKey } = await import('@solana/web3.js');
        // Use stripped poolId for PublicKey creation
        const pk = new PublicKey(poolIdStripped);
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
    
    // PRIMARY PATH: Try local builder first (NO RPC calls!)
    try {
      const localResult = await buildOrcaSwapIxLocal(hop, kp);
      const quoteAny = localResult.quote as any;
      const estOut = quoteAny?.tokenEstOut ?? quoteAny?.tokenMinOut ?? quoteAny?.estimatedAmountOut ?? null;
      
      // For multihop with exact amounts, verify the local builder used the exact input amount
      if (hop.useExactAmount && hop.amountInRaw > 0n) {
        const quoteInputAmount = BigInt((quoteAny?.inputAmount ?? quoteAny?.tokenAmountIn ?? 0));
        if (quoteInputAmount > 0n && quoteInputAmount !== hop.amountInRaw) {
          try {
            logger.warn('orca.local.exact_amount.mismatch', {
              cat: 'tx',
              code: LogCode.TX_BUILD_ERR,
              ctx: {
                pool: hop.poolId,
                expectedInput: hop.amountInRaw.toString(),
                quoteInput: quoteInputAmount.toString(),
                difference: (quoteInputAmount > hop.amountInRaw 
                  ? (quoteInputAmount - hop.amountInRaw).toString() 
                  : (hop.amountInRaw - quoteInputAmount).toString()),
                mode: 'local',
              }
            });
          } catch {}
        } else if (quoteInputAmount === hop.amountInRaw) {
          try {
            logger.debug('orca.local.exact_amount.verified', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                exactInput: hop.amountInRaw.toString(),
                mode: 'local',
              }
            });
          } catch {}
        }
      }
      
      if (estOut !== null && estOut !== undefined) {
        try { logger.debug('orca.local.quote.ok', { cat: 'tx', ctx: { estimatedOutRaw: String(estOut), mode: 'local' } as any }); } catch {}
      }
      try { logger.debug('orca.local.ix.ready', { cat: 'tx', ctx: { count: localResult.instructions.length, mode: 'local' } as any }); } catch {}
      return localResult.instructions;
    } catch (localErr) {
      const msg = String((localErr as any)?.message || localErr);
      if (msg.includes('ORCA_BUILD_FAILED')) {
        throw localErr;
      }
      // Log and fallback to SDK
      try { 
        logger.warn('orca.local.fallback_to_sdk', { 
          cat: 'tx', 
          ctx: { 
            pool: hop.poolId, 
            error: msg,
            reason: 'Local build failed, falling back to SDK (will make RPC calls)'
          } as any 
        }); 
      } catch {}
    }
    
    // FALLBACK PATH: Try SDK if local build failed
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
      // Log RPC call warning - this fallback also makes RPC calls
      try {
        logger.warn('orca.sdk.fallback.rpc_call', {
          cat: 'tx',
          code: LogCode.TX_BUILD_HOP,
          ctx: {
            pool: hop.poolId,
            warning: 'Orca fallback (client.getPool) makes RPC calls - implement local building',
          } as any
        });
      } catch {}
      
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
      const pool = await client.getPool(new PublicKey(poolAddr)); // RPC CALL HERE
      
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

export function buildPumpswapSwapIx(hop: DirectHop): any[] {
  try { logger.info('ix.build pumpswap.amm', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  return [{ programId: hop.programId || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', type: 'pumpswap.amm.swap', keys: { poolId: hop.poolId, userSourceAta: hop.userSourceAta, userDestAta: hop.userDestAta, vaultA: hop.vaultA, vaultB: hop.vaultB }, data: { amountIn: hop.amountInRaw, minOut: hop.minOutRaw } }];
}

export async function buildPumpswapSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.info('ix.build pumpswap.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    // Pre-build validation: amounts
    validateHopAmounts(hop, { dex: 'pumpswap', variant: 'amm', poolId: hop.poolId });
    
    // Pre-build validation: critical PublicKeys
    try {
      validatePublicKey(hop.poolId, 'poolId', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.inputMint, 'inputMint', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.outputMint, 'outputMint', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.userSourceAta, 'userSourceAta', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.userDestAta, 'userDestAta', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.vaultA, 'vaultA', { dex: 'pumpswap', variant: 'amm' });
      validatePublicKey(hop.vaultB, 'vaultB', { dex: 'pumpswap', variant: 'amm' });
    } catch (validationErr) {
      throw createBuilderError('PUMPSWAP', String((validationErr as any)?.message || validationErr), hop);
    }

    const kp = await ensureWallet(CONFIG.walletPath);
    const programId = toPublicKey(hop.programId || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    const poolId = toPublicKey(hop.poolId);
    const inputMint = toPublicKey(hop.inputMint);
    const outputMint = toPublicKey(hop.outputMint);
    const userSourceAta = toPublicKey(hop.userSourceAta);
    const userDestAta = toPublicKey(hop.userDestAta);
    const vaultA = toPublicKey(hop.vaultA);
    const vaultB = toPublicKey(hop.vaultB);
    
    const BN = (await import('bn.js')).default as any;
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    const minOutBn = new BN(String(hop.minOutRaw ?? 0n));

    // Import required modules
    const { TransactionInstruction, SystemProgram } = await import('@solana/web3.js');
    const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const crypto = await import('crypto');
    
    // Pumpswap Global Config account (constant across all pumpswap transactions)
    // Source: https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
    const GLOBAL_CONFIG = toPublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
    
    // Determine if we're swapping in the base→quote or quote→base direction
    // Fetch the original on-chain mint and vault order from cache (stored before canonicalization)
    const { peekPumpswapPools } = await import('../../server/pools.js');
    const pools = peekPumpswapPools();
    const poolData = (pools.amm || []).find((p: any) => String(p?.id || '') === hop.poolId.replace(/-rev$/, ''));
    
    if (!poolData) {
      throw createBuilderError('PUMPSWAP', 'Pool data not found in cache', hop);
    }
    
    // Get the original on-chain mint and vault order (before canonicalization)
    const poolBaseMint = String((poolData as any)?.onchain_base_mint || '');
    const poolQuoteMint = String((poolData as any)?.onchain_quote_mint || '');
    const onchainBaseVault = String((poolData as any)?.onchain_base_vault || '');
    const onchainQuoteVault = String((poolData as any)?.onchain_quote_vault || '');
    const creator = String((poolData as any)?.creator || '');
    let coinCreatorVaultAta = String((poolData as any)?.coin_creator_vault_ata || '');
    let coinCreatorVaultAuthority = String((poolData as any)?.coin_creator_vault_authority || '');
    
    // Get protocol_fee_recipient from pool data (extracted from pool account at offset 243)
    // If not available, fall back to a list of known recipients
    let protocolFeeRecipientAddress = String((poolData as any)?.protocol_fee_recipient || '');
    
    if (!protocolFeeRecipientAddress || protocolFeeRecipientAddress.length < 32) {
      // Fallback to known protocol fee recipients if not extracted from pool data
      // It's recommended to randomly choose a different one for each transaction to improve throughput
      const PROTOCOL_FEE_RECIPIENTS = [
        '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
        '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
        '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
        '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
        'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
        'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
        'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
        'JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU'
      ];
      protocolFeeRecipientAddress = PROTOCOL_FEE_RECIPIENTS[Math.floor(Math.random() * PROTOCOL_FEE_RECIPIENTS.length)];
      
      try {
        logger.info('pumpswap.protocol_recipient.fallback', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId.slice(0, 12),
            selected: protocolFeeRecipientAddress.slice(0, 12),
            reason: 'not_in_cache',
          }
        });
      } catch {}
    } else {
      try {
        logger.info('pumpswap.protocol_recipient.from_cache', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId.slice(0, 12),
            protocolRecipient: protocolFeeRecipientAddress.slice(0, 12),
          }
        });
      } catch {}
    }
    
    const protocolFeeRecipient = toPublicKey(protocolFeeRecipientAddress);
    
    // Validate creator is a proper base58 address
    try {
      logger.info('pumpswap.creator.from_cache', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId.slice(0, 12),
          creator: creator,
          creatorLength: creator.length,
          first12: creator.slice(0, 12),
          last12: creator.slice(-12),
        }
      });
    } catch {}
    
    if (!poolBaseMint || !poolQuoteMint || !onchainBaseVault || !onchainQuoteVault || !creator) {
      throw createBuilderError('PUMPSWAP', 'Pool missing on-chain mint/vault/creator data in cache', hop);
    }
    
    // If coin creator vault addresses aren't in cache (old pool data), derive them as fallback
    // This provides backward compatibility until pools are re-enriched
    if (!coinCreatorVaultAta || !coinCreatorVaultAuthority) {
      try {
        logger.info('pumpswap.fallback.derive_accounts', {
          cat: 'tx',
          ctx: { 
            poolId: hop.poolId.slice(0, 12), 
            reason: 'missing_from_cache',
            hasCoinCreatorVaultAta: !!coinCreatorVaultAta,
            hasCoinCreatorVaultAuthority: !!coinCreatorVaultAuthority,
            coinCreatorVaultAtaValue: coinCreatorVaultAta || 'null',
            coinCreatorVaultAuthorityValue: coinCreatorVaultAuthority || 'null',
            creator: creator.slice(0, 12),
          }
        });
      } catch {}
      
      const { PublicKey, SystemProgram } = await import('@solana/web3.js');
      
      // Check if coin_creator is the System Program (meaning no creator fees for this pool)
      const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
      
      try {
        logger.info('pumpswap.system_program_check', {
          cat: 'tx',
          ctx: { 
            poolId: hop.poolId.slice(0, 12),
            creator: creator,
            systemProgramId: SYSTEM_PROGRAM_ID,
            matches: creator === SYSTEM_PROGRAM_ID,
          }
        });
      } catch {}
      
      // CRITICAL FIX: Identify which mint is the pump.fun meme token
      // After canonicalization, poolBaseMint might be SOL/USDC instead of the meme token
      // The meme token is whichever mint is NOT SOL or USDC
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      
      let memeTokenMint: string | null = null;
      let isStablecoinPair = false;
      
      if (poolBaseMint !== SOL_MINT && poolBaseMint !== USDC_MINT) {
        memeTokenMint = poolBaseMint;
      } else if (poolQuoteMint !== SOL_MINT && poolQuoteMint !== USDC_MINT) {
        memeTokenMint = poolQuoteMint;
      } else {
        // Both are SOL/USDC - this is a stablecoin pair pool
        // For these pools, we can't derive creator from token metadata
        // We'll use the pool's creator field directly
        isStablecoinPair = true;
        
        try {
          logger.info('pumpswap.stablecoin_pair_detected', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId.slice(0, 12),
              poolBaseMint: poolBaseMint.slice(0, 12),
              poolQuoteMint: poolQuoteMint.slice(0, 12),
              note: 'will_use_pool_creator_directly',
            }
          });
        } catch {}
      }
      
      if (!isStablecoinPair && memeTokenMint) {
        // Meme token found - fetch its creator from metadata
        try {
          logger.info('pumpswap.identify_meme_token', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId.slice(0, 12),
              poolBaseMint: poolBaseMint.slice(0, 12),
              poolQuoteMint: poolQuoteMint.slice(0, 12),
              memeTokenMint: memeTokenMint.slice(0, 12),
              isBaseTheMeme: memeTokenMint === poolBaseMint,
            }
          });
        } catch {}
        
        // For Pumpswap pools, we need to fetch the creator from the meme token's Metaplex metadata
        const memeTokenMintPk = toPublicKey(memeTokenMint);
        const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
        
        // Derive metadata PDA for the meme token
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('metadata'),
            METADATA_PROGRAM_ID.toBuffer(),
            memeTokenMintPk.toBuffer(),
          ],
          METADATA_PROGRAM_ID
        );
        
        try {
          logger.info('pumpswap.fetching_mint_metadata', {
            cat: 'tx',
            ctx: { 
              poolId: hop.poolId.slice(0, 12),
              memeTokenMint: memeTokenMint.slice(0, 12),
              metadataPda: metadataPda.toBase58().slice(0, 12),
              poolCoinCreator: creator.slice(0, 12),
            }
          });
        } catch {}
        
        // Fetch metadata account to get the real creator
        const connection = await (async () => {
          const { getConnection } = await import('../../wallet/wallet.js');
          return getConnection();
        })();
        
        let actualCreator: string = creator;
        try {
          const metadataAccount = await connection.getAccountInfo(metadataPda);
          if (metadataAccount && metadataAccount.data.length > 0) {
            // Parse Metaplex metadata to extract creator
            // The update authority (bytes 1-33) is often the creator for pump.fun tokens
            if (metadataAccount.data.length >= 33) {
              const updateAuthority = new PublicKey(metadataAccount.data.subarray(1, 33));
              actualCreator = updateAuthority.toBase58();
              
              try {
                logger.info('pumpswap.metadata_creator_found', {
                  cat: 'tx',
                  ctx: {
                    poolId: hop.poolId.slice(0, 12),
                    actualCreator: actualCreator.slice(0, 12),
                    wasSystemProgram: creator === SYSTEM_PROGRAM_ID,
                  }
                });
              } catch {}
            }
          }
        } catch (metadataErr: any) {
          try {
            logger.warn('pumpswap.metadata_fetch_failed', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId.slice(0, 12),
                error: String(metadataErr?.message || metadataErr),
                willUseFallback: true,
              }
            });
          } catch {}
        }
        
        // Now derive the creator vault accounts using the actual creator
        if (actualCreator === SYSTEM_PROGRAM_ID) {
          // Still System Program after metadata check - use pump.fun bonding curve as fallback
          try {
            logger.warn('pumpswap.creator_still_system_program', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId.slice(0, 12),
                note: 'using_bonding_curve_authority_as_fallback',
              }
            });
          } catch {}
          
          // Use the bonding curve PDA as creator
          const [bondingCurvePda] = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), memeTokenMintPk.toBuffer()],
            PUMP_PROGRAM_ID
          );
          actualCreator = bondingCurvePda.toBase58();
        }
        
        // Derive creator vault authority and ATA using the actual creator
        const creatorPubkey = toPublicKey(actualCreator);
          
        // PDA derived from seeds: ["creator-vault-authority", coin_creator]
        // IMPORTANT: Uses Pump Program ID, not PumpSwap Program ID
        const [vaultAuthority] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('creator-vault-authority'),
            creatorPubkey.toBuffer(),
          ],
          PUMP_PROGRAM_ID
        );
        coinCreatorVaultAuthority = vaultAuthority.toBase58();
        
        // Derive coin creator vault ATA
        coinCreatorVaultAta = getAssociatedTokenAddressSync(
          toPublicKey(poolQuoteMint), // Quote mint (fees collected in quote token)
          vaultAuthority,
          true // allowOwnerOffCurve
        ).toBase58();
        
        try {
          logger.info('pumpswap.fallback.derived_accounts', {
            cat: 'tx',
            ctx: { 
              poolId: hop.poolId.slice(0, 12),
              poolCoinCreator: creator.slice(0, 12),
              actualCreator: actualCreator.slice(0, 12),
              derivedAuthority: coinCreatorVaultAuthority.slice(0, 12),
              derivedAta: coinCreatorVaultAta.slice(0, 12),
              quoteMint: poolQuoteMint.slice(0, 12),
            }
          });
        } catch {}
      } else {
        // Stablecoin pair (SOL/USDC) - use pool creator directly
        // For SOL/USDC pools, if creator is System Program, use System Program for creator vaults
        // This means no creator fees are configured for this pool
        const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        
        if (creator === SYSTEM_PROGRAM_ID) {
          // No creator configured - use System Program for creator vault accounts
          // This indicates no creator fees for this stablecoin pair pool
          coinCreatorVaultAuthority = SYSTEM_PROGRAM_ID;
          coinCreatorVaultAta = SYSTEM_PROGRAM_ID;
          
          try {
            logger.info('pumpswap.stablecoin.no_creator_fees', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId.slice(0, 12),
                note: 'using_system_program_for_creator_vaults',
                coinCreatorVaultAuthority: SYSTEM_PROGRAM_ID.slice(0, 12),
                coinCreatorVaultAta: SYSTEM_PROGRAM_ID.slice(0, 12),
              }
            });
          } catch {}
        } else {
          // Pool has a valid creator - derive creator vault accounts normally
          const creatorPubkey = toPublicKey(creator);
          const [vaultAuthority] = PublicKey.findProgramAddressSync(
            [
              Buffer.from('creator-vault-authority'),
              creatorPubkey.toBuffer(),
            ],
            PUMP_PROGRAM_ID
          );
          coinCreatorVaultAuthority = vaultAuthority.toBase58();
          
          coinCreatorVaultAta = getAssociatedTokenAddressSync(
            toPublicKey(poolQuoteMint),
            vaultAuthority,
            true
          ).toBase58();
          
          try {
            logger.info('pumpswap.stablecoin.with_creator', {
              cat: 'tx',
              ctx: { 
                poolId: hop.poolId.slice(0, 12),
                poolCreator: creator.slice(0, 12),
                derivedAuthority: coinCreatorVaultAuthority.slice(0, 12),
                derivedAta: coinCreatorVaultAta.slice(0, 12),
              }
            });
          } catch {}
        }
      }
    }
    
    // NOW convert the creator vault addresses to PublicKey (after fallback derivation)
    // Debug log the values before conversion
    try {
      logger.info('pumpswap.convert.creator_vaults', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId.slice(0, 12),
          coinCreatorVaultAta,
          coinCreatorVaultAuthority,
          ataType: typeof coinCreatorVaultAta,
          authType: typeof coinCreatorVaultAuthority,
          ataLen: coinCreatorVaultAta?.length,
          authLen: coinCreatorVaultAuthority?.length,
        }
      });
    } catch {}
    
    const creatorVaultAta = toPublicKey(coinCreatorVaultAta);
    const creatorVaultAuthority = toPublicKey(coinCreatorVaultAuthority);
    
    // Debug log vault addresses before validation
    try {
      logger.info('pumpswap.vaults.before_validation', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId.slice(0, 12),
          onchainBaseVault,
          onchainQuoteVault,
          baseVaultType: typeof onchainBaseVault,
          quoteVaultType: typeof onchainQuoteVault,
          baseVaultLen: onchainBaseVault?.length,
          quoteVaultLen: onchainQuoteVault?.length,
        }
      });
    } catch {}
    
    // Validate vault addresses before conversion
    if (!onchainBaseVault || onchainBaseVault.length < 32) {
      throw createBuilderError('PUMPSWAP', `Invalid onchainBaseVault: ${onchainBaseVault}`, hop);
    }
    if (!onchainQuoteVault || onchainQuoteVault.length < 32) {
      throw createBuilderError('PUMPSWAP', `Invalid onchainQuoteVault: ${onchainQuoteVault}`, hop);
    }
    
    // Use the stored on-chain vaults directly - no mapping needed!
    // These vault addresses are the ACTUAL on-chain addresses and won't be affected by canonicalization
    const poolBaseVault = toPublicKey(onchainBaseVault);
    const poolQuoteVault = toPublicKey(onchainQuoteVault);
    
    // Debug logging
    try {
      logger.info('pumpswap.swap.direction.check', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId.slice(0, 8) + '...',
          inputMint: hop.inputMint.slice(0, 8) + '...',
          outputMint: hop.outputMint.slice(0, 8) + '...',
          poolBaseMint: poolBaseMint.slice(0, 8) + '...',
          poolQuoteMint: poolQuoteMint.slice(0, 8) + '...',
          poolBaseVault: onchainBaseVault.slice(0, 8) + '...',
          poolQuoteVault: onchainQuoteVault.slice(0, 8) + '...',
        }
      });
    } catch {}
    
    // Validate that we have valid mint addresses
    if (!poolBaseMint || poolBaseMint.length < 32) {
      throw createBuilderError('PUMPSWAP', `Invalid poolBaseMint: ${poolBaseMint}`, hop);
    }
    if (!poolQuoteMint || poolQuoteMint.length < 32) {
      throw createBuilderError('PUMPSWAP', `Invalid poolQuoteMint: ${poolQuoteMint}`, hop);
    }
    
    try {
      logger.info('pumpswap.mints.validation', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId.slice(0, 12),
          poolBaseMint,
          poolQuoteMint,
          poolBaseMintLen: poolBaseMint.length,
          poolQuoteMintLen: poolQuoteMint.length,
        }
      });
    } catch {}
    
    // Determine swap direction and choose instruction
    const isSellingBase = hop.inputMint === poolBaseMint && hop.outputMint === poolQuoteMint;
    const isBuyingBase = hop.inputMint === poolQuoteMint && hop.outputMint === poolBaseMint;
    
    if (!isSellingBase && !isBuyingBase) {
      throw createBuilderError('PUMPSWAP', `Mint mismatch: input=${hop.inputMint}, output=${hop.outputMint}, poolBase=${poolBaseMint}, poolQuote=${poolQuoteMint}`, hop);
    }
    
    // Derive protocol fee recipient token account
    // Protocol fees are ALWAYS collected in the QUOTE token (not base)
    // This is because fees come from the quote side of swaps
    const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
      toPublicKey(poolQuoteMint), // Always use quote mint for fee collection
      protocolFeeRecipient,
      true // allowOwnerOffCurve
    );

    let instructionType: string;
    let instructionData: Buffer;
    
    if (isSellingBase) {
      // SELL instruction: sell exact base to receive at least min quote
      // Anchor discriminator: first 8 bytes of sha256("global:sell")
      instructionType = 'sell';
      const sellDiscriminatorBytes = crypto.createHash('sha256')
        .update('global:sell')
        .digest()
        .subarray(0, 8);
      const sellDiscriminator = Buffer.from(sellDiscriminatorBytes);
      
      // Encode instruction data: [discriminator (8 bytes), base_amount_in (u64), min_quote_amount_out (u64)]
      const buffer = Buffer.alloc(8 + 8 + 8);
      sellDiscriminator.copy(buffer, 0);
      buffer.writeBigUInt64LE(BigInt(amountInBn.toString()), 8);
      buffer.writeBigUInt64LE(BigInt(minOutBn.toString()), 16);
      instructionData = buffer;
    } else {
      // BUY instruction: buy exact base with at most max quote
      // Anchor discriminator: first 8 bytes of sha256("global:buy")
      instructionType = 'buy';
      const buyDiscriminatorBytes = crypto.createHash('sha256')
        .update('global:buy')
        .digest()
        .subarray(0, 8);
      const buyDiscriminator = Buffer.from(buyDiscriminatorBytes);
      
      // Encode instruction data: [discriminator (8 bytes), base_amount_out (u64), max_quote_amount_in (u64)]
      // For buy: we want to receive minOut (base), and we're willing to pay up to amountIn (quote)
      // But since we have exact quote input, we need to convert this to: buy as much base as possible with exact quote
      // This means: base_amount_out = minOut, max_quote_amount_in = amountIn
      const buffer = Buffer.alloc(8 + 8 + 8);
      buyDiscriminator.copy(buffer, 0);
      buffer.writeBigUInt64LE(BigInt(minOutBn.toString()), 8);   // base_amount_out (what we want to receive)
      buffer.writeBigUInt64LE(BigInt(amountInBn.toString()), 16); // max_quote_amount_in (max we'll pay)
      instructionData = buffer;
    }

    // Pumpswap constant addresses (from real transactions)
    const EVENT_AUTHORITY = toPublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
    const FEE_CONFIG = toPublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
    const FEE_PROGRAM = toPublicKey('Pump9x3FRC86zy4T1N3V99RG9ejwokxgvXBfRRgxUoZ'); // Pump Fees Program
    
    // Build accounts array (21 accounts total)
    // Account order per on-chain transaction analysis
    // Reference: https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
    // NOTE: Global Volume Accumulator and User Volume Accumulator are OPTIONAL and NOT included in standard swaps
    const keys = [
      { pubkey: poolId, isSigner: false, isWritable: true },                    // #1 Pool (writable)
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },              // #2 User (signer, writable)
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: true },            // #3 Global Config (writable)
      { pubkey: toPublicKey(poolBaseMint), isSigner: false, isWritable: false }, // #4 Base Mint
      { pubkey: toPublicKey(poolQuoteMint), isSigner: false, isWritable: false }, // #5 Quote Mint
      { pubkey: isSellingBase ? userSourceAta : userDestAta, isSigner: false, isWritable: true }, // #6 User Base Token Account
      { pubkey: isSellingBase ? userDestAta : userSourceAta, isSigner: false, isWritable: true }, // #7 User Quote Token Account
      { pubkey: poolBaseVault, isSigner: false, isWritable: true },            // #8 Pool Base Token Account
      { pubkey: poolQuoteVault, isSigner: false, isWritable: true },           // #9 Pool Quote Token Account
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },    // #10 Protocol Fee Recipient
      { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true }, // #11 Protocol Fee Recipient Token Account
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // #12 Base Token Program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // #13 Quote Token Program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // #14 System Program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // #15 Associated Token Program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },         // #16 Event Authority
      { pubkey: programId, isSigner: false, isWritable: false },               // #17 Program (pumpswap)
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },          // #18 Coin Creator Vault ATA
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },   // #19 Coin Creator Vault Authority
      { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },              // #20 Fee Config
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },             // #21 Fee Program
    ];
    
    // Debug logging for accounts
    try {
      logger.info('pumpswap.accounts.debug', {
        cat: 'tx',
        ctx: {
          pool: poolId.toBase58().slice(0, 8) + '...',
          user: kp.publicKey.toBase58().slice(0, 8) + '...',
          globalConfig: GLOBAL_CONFIG.toBase58(),
          baseMint: poolBaseMint.slice(0, 8) + '...',
          quoteMint: poolQuoteMint.slice(0, 8) + '...',
          userBaseAta: (isSellingBase ? userSourceAta : userDestAta).toBase58().slice(0, 8) + '...',
          userQuoteAta: (isSellingBase ? userDestAta : userSourceAta).toBase58().slice(0, 8) + '...',
          poolBaseVault: poolBaseVault.toBase58().slice(0, 8) + '...',
          poolQuoteVault: poolQuoteVault.toBase58().slice(0, 8) + '...',
          protocolFeeRecipient: protocolFeeRecipient.toBase58(),
          protocolFeeTokenAccount: protocolFeeRecipientTokenAccount.toBase58(),
          coinCreatorVaultAta: creatorVaultAta.toBase58().slice(0, 8) + '...',
          coinCreatorVaultAuthority: creatorVaultAuthority.toBase58().slice(0, 8) + '...',
          feeConfig: FEE_CONFIG.toBase58().slice(0, 8) + '...',
          feeProgram: FEE_PROGRAM.toBase58().slice(0, 8) + '...',
          fullAccountOrder: keys.map((k, i) => `${i+1}:${k.pubkey.toBase58().slice(0,8)}`).join(','),
        }
      });
    } catch {}

    const swapIx = new TransactionInstruction({
      programId,
      keys,
      data: instructionData,
    });

    try {
      logger.info('pumpswap.amm.swap.built', {
        cat: 'tx',
        code: LogCode.TX_BUILD_HOP,
        ctx: {
          pool: hop.poolId.slice(0, 8) + '...',
          amountIn: amountInBn.toString(),
          minOut: minOutBn.toString(),
          accounts: keys.length,
          instruction: instructionType,
          direction: isSellingBase ? 'base→quote' : 'quote→base',
        } as any,
      });
    } catch {}

    return [swapIx];
  } catch (e: any) {
    try {
      logger.error('pumpswap.amm.build.error', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: {
          pool: hop.poolId,
          error: String(e?.message || e),
          stack: String(e?.stack || '').slice(0, 200),
        } as any,
      });
    } catch {}
    wrapBuilderError(e, 'PUMPSWAP', 'build failed', hop);
    throw e;
  }
}

export async function buildMeteoraDammSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { 
    logger.info('ix.build meteora.damm.real', { 
      pool: hop.poolId, 
      variant: hop.variant,
      cat: 'tx', 
      code: LogCode.TX_BUILD_HOP 
    }); 
  } catch {}
  
  try {
    // Pre-build validation: amounts
    validateHopAmounts(hop, { dex: 'meteora_balanced', variant: hop.variant, poolId: hop.poolId });
    
    // Pre-build validation: critical PublicKeys
    try {
      validatePublicKey(hop.poolId, 'poolId', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.inputMint, 'inputMint', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.outputMint, 'outputMint', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.userSourceAta, 'userSourceAta', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.userDestAta, 'userDestAta', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.vaultA, 'vaultA', { dex: 'meteora_balanced', variant: hop.variant });
      validatePublicKey(hop.vaultB, 'vaultB', { dex: 'meteora_balanced', variant: hop.variant });
    } catch (validationErr) {
      throw createBuilderError('METEORA_BALANCED', String((validationErr as any)?.message || validationErr), hop);
    }

    const connection = getConnection();
    const kp = await ensureWallet(CONFIG.walletPath);
    const programId = toPublicKey(hop.programId);
    const poolAddress = toPublicKey((hop as any).poolAddress || hop.poolId.replace(/-rev$/, ''));
    
    const BN = (await import('bn.js')).default as any;
    const amountIn = new BN(String(hop.amountInRaw ?? 0n));
    const minOut = new BN(String(hop.minOutRaw ?? 0n));

    // Try SDK-based approach first (disabled until SDK packages are installed)
    // TODO: Enable once @meteora-ag/dynamic-amm-sdk and @meteora-ag/cp-amm-sdk are installed
    // and their API signatures are verified
    /*
    try {
      // DAMM v1 SDK
      if (hop.variant === 'damm_v1') {
        try {
          const AmmImpl = await import('@meteora-ag/dynamic-amm-sdk').then(m => m.default || m);
          if (AmmImpl && typeof (AmmImpl as any).create === 'function') {
            const pool = await (AmmImpl as any).create(connection, poolAddress);
            
            if (pool && typeof pool.swap === 'function') {
              const swapResult = await (pool.swap as any)(
                kp.publicKey,
                toPublicKey(hop.inputMint),
                amountIn,
                minOut
              );
              
              if (swapResult?.transaction?.instructions) {
                try {
                  logger.info('meteora.damm.v1.sdk.success', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_HOP,
                    ctx: {
                      pool: hop.poolId.slice(0, 8) + '...',
                      ixCount: swapResult.transaction.instructions.length,
                    } as any,
                  });
                } catch {}
                return swapResult.transaction.instructions;
              }
            }
          }
        } catch (e: any) {
          try {
            logger.warn('meteora.damm.v1.sdk.fallback', {
              cat: 'tx',
              ctx: { error: String(e?.message || e), pool: hop.poolId } as any,
            });
          } catch {}
        }
      }
      
      // DAMM v2 SDK
      if (hop.variant === 'damm_v2') {
        try {
          const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
          if (CpAmm) {
            const cpAmm = new CpAmm(connection);
            
            if (typeof cpAmm.swap === 'function') {
              const swapResult = await (cpAmm.swap as any)(
                poolAddress,
                kp.publicKey,
                toPublicKey(hop.inputMint),
                amountIn,
                minOut
              );
              
              if (swapResult?.instructions) {
                try {
                  logger.info('meteora.damm.v2.sdk.success', {
                    cat: 'tx',
                    code: LogCode.TX_BUILD_HOP,
                    ctx: {
                      pool: hop.poolId.slice(0, 8) + '...',
                      ixCount: swapResult.instructions.length,
                    } as any,
                  });
                } catch {}
                return swapResult.instructions;
              }
            }
          }
        } catch (e: any) {
          try {
            logger.warn('meteora.damm.v2.sdk.fallback', {
              cat: 'tx',
              ctx: { error: String(e?.message || e), pool: hop.poolId } as any,
            });
          } catch {}
        }
      }
    } catch (sdkErr: any) {
      try {
        logger.warn('meteora.damm.sdk.import.failed', {
          cat: 'tx',
          ctx: { error: String(sdkErr?.message || sdkErr) } as any,
        });
      } catch {}
    }
    */

    // Fallback: Manual instruction building
    try {
      logger.info('meteora.damm.manual.fallback', {
        cat: 'tx',
        ctx: {
          message: 'SDK unavailable, using manual instruction builder',
          variant: hop.variant,
          pool: hop.poolId,
        } as any,
      });
    } catch {}

    const { TransactionInstruction } = await import('@solana/web3.js');
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    
    const inputTokenProgram = hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const outputTokenProgram = hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    
    // Manual instruction building based on typical AMM patterns
    const keys = [
      { pubkey: poolAddress, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      { pubkey: toPublicKey(hop.userSourceAta), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(hop.userDestAta), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(hop.vaultA), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(hop.vaultB), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(hop.inputMint), isSigner: false, isWritable: false },
      { pubkey: toPublicKey(hop.outputMint), isSigner: false, isWritable: false },
      { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
    ];

    // Anchor discriminator for swap instruction (8 bytes)
    // This needs to be determined from the actual IDL
    const dataBuffer = Buffer.alloc(24);
    dataBuffer.writeBigUInt64LE(0xf8c69e91e17587c8n, 0); // Placeholder
    dataBuffer.writeBigUInt64LE(BigInt(amountIn.toString()), 8);
    dataBuffer.writeBigUInt64LE(BigInt(minOut.toString()), 16);

    const swapIx = new TransactionInstruction({
      programId,
      keys,
      data: dataBuffer,
    });

    try {
      logger.warn('meteora.damm.manual.warning', {
        cat: 'tx',
        ctx: {
          message: 'Using manual instruction builder with placeholder discriminator',
          variant: hop.variant,
          pool: hop.poolId,
          note: 'This may fail - install SDK for production use',
        } as any,
      });
    } catch {}

    return [swapIx];
  } catch (e: any) {
    try {
      logger.error('meteora.damm.build.error', {
        cat: 'tx',
        code: LogCode.TX_BUILD_ERR,
        ctx: {
          pool: hop.poolId,
          variant: hop.variant,
          error: String(e?.message || e),
          stack: String(e?.stack || '').slice(0, 200),
        } as any,
      });
    } catch {}
    wrapBuilderError(e, 'METEORA_BALANCED', 'build failed', hop);
    throw e;
  }
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

    // Determine swap direction early for use in fast path
    const inputMintPk = toPublicKey(hop.inputMint);
    const outputMintPk = toPublicKey(hop.outputMint);
    let swapForY = true;  // Default: X->Y
    
    // Try to get mints from execution cache first (NO RPC!)
    let tokenXMintPk: PublicKey | null = null;
    let tokenYMintPk: PublicKey | null = null;
    
    try {
      const { executionCache } = await import('../cache.js');
      const staticData = executionCache.getStatic(hop.poolId);
      
      if (staticData?.mint_a && staticData?.mint_b) {
        tokenXMintPk = toPublicKey(staticData.mint_a);
        tokenYMintPk = toPublicKey(staticData.mint_b);
        
        try {
          logger.debug('meteora.dlmm.mints_from_cache', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId.slice(0, 8) + '…',
              mintX: staticData.mint_a,
              mintY: staticData.mint_b,
              source: 'execution_cache'
            }
          });
        } catch {}
      }
    } catch {}
    
    // Fallback: Get pool mints via SDK RPC call if not in cache
    if (!tokenXMintPk || !tokenYMintPk) {
      try {
        const DLMM: any = await import('@meteora-ag/dlmm').catch(() => null);
        if (DLMM && typeof DLMM.DLMM?.getTokensMintFromPoolAddress === 'function') {
          try {
            logger.info('meteora.dlmm.mints_from_rpc', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId.slice(0, 8) + '…',
                reason: 'Mints not in cache, making RPC call',
                warning: 'This will slow down transaction building'
              }
            });
          } catch {}
          
          const mints = await DLMM.DLMM.getTokensMintFromPoolAddress(connection, poolPk);
          tokenXMintPk = mints?.tokenXMint ? toPublicKey(mints.tokenXMint) : null;
          tokenYMintPk = mints?.tokenYMint ? toPublicKey(mints.tokenYMint) : null;
        }
      } catch (e: any) {
        try {
          logger.warn('meteora.dlmm.mints_fetch_failed', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId.slice(0, 8) + '…',
              error: String(e?.message || e)
            }
          });
        } catch {}
      }
    }
    
    // Determine swap direction
    if (tokenXMintPk && tokenYMintPk) {
      const isXToY = inputMintPk.equals(tokenXMintPk) && outputMintPk.equals(tokenYMintPk);
      const isYToX = inputMintPk.equals(tokenYMintPk) && outputMintPk.equals(tokenXMintPk);
      swapForY = isXToY;  // X->Y means swapForY=true, Y->X means swapForY=false
      
      try {
        logger.info('meteora.dlmm.swap_direction', {
          cat: 'tx',
          ctx: {
            direction: isXToY ? 'X->Y' : (isYToX ? 'Y->X' : 'UNKNOWN'),
            inputMint: hop.inputMint,
            outputMint: hop.outputMint,
            tokenXMint: tokenXMintPk.toBase58(),
            tokenYMint: tokenYMintPk.toBase58(),
            poolId: hop.poolId
          }
        });
      } catch {}
    }

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
          swapForY: swapForY,  // CRITICAL: Tell SDK which direction to swap (X->Y vs Y->X)
          binArrayLower: hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined,
          binArrayUpper: hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined,
        } as any;
        try { logger.info('meteora.dlmm.swapIx.call', { cat: 'tx', ctx: { swapForY: swapForY } }); } catch {}
        const ixResult = await (DLMM as any).swapIx(connection, kp.publicKey, params);
        if (ixResult) {
          // Safety net: attempt to attach remaining bin-array metas when using fast-path ix
          const injected = await injectBinArrayMetas(ixResult, DLMM, connection, poolPk, programId, hop.poolId);
          
          // CRITICAL: Verify bin arrays were added - fail fast if they weren't
          const totalAccounts = Array.isArray(ixResult.keys) ? ixResult.keys.length : 0;
          if (totalAccounts < 16) {
            const errorMsg = `Meteora swap missing bin arrays: only ${totalAccounts} accounts (need 16+)`;
            try {
              logger.error('meteora.dlmm.no_bin_arrays', {
                cat: 'tx',
                code: LogCode.TX_BUILD_ERR,
                ctx: {
                  pool: hop.poolId,
                  totalAccounts,
                  injected,
                  msg: errorMsg
                }
              });
            } catch {}
            throw createBuilderError('METEORA', errorMsg, hop);
          }
          
          try { 
            logger.info('meteora.dlmm.swapIx.ok', { 
              cat: 'tx', 
              ctx: { 
                totalAccounts, 
                injected,
                binArraysPresent: totalAccounts >= 16
              } 
            }); 
          } catch {}
          return [ixResult];
        }
      }
    } catch (e: any) {
      try { logger.warn('meteora.dlmm.swapIx.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
      // Continue to fallback path
    }

    // Declare variables at outer scope so they're accessible after try-catch
    const setupIxs: TransactionInstruction[] = [];
    let builder: any = null;
    let ix: any = null;

    // 4) ts-client fallback: Anchor program path
    try {
      const createProgram = (DLMM as any)?.createProgram || (mod as any)?.createProgram;
      if (!createProgram) throw new Error('DLMM_CREATE_PROGRAM_MISSING');
      const program = createProgram(connection, programId);
      try { logger.debug('meteora.dlmm.program.ok', { cat: 'tx' }); } catch {}

      // Derive optional accounts
      let binArrayLower: PublicKey | undefined = hop.binArrayLower ? toPublicKey(hop.binArrayLower) : undefined;
      let binArrayUpper: PublicKey | undefined = hop.binArrayUpper ? toPublicKey(hop.binArrayUpper) : undefined;
      let binArrayMetas: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> | null = null;
      
      // NOTE: Bitmap extension is NOT needed - the Meteora SDK handles it automatically
      // We previously derived bin_array_bitmap_extension ourselves, but this is unnecessary.
      // The SDK includes the correct bitmap extension PDA when building swap instructions.
      // Just providing the program ID is sufficient, which aligns with best practices
      // observed in other Meteora integrations.
      
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
                      const accInfo = await withRpcLimit(
                        () => connection.getAccountInfo(finalPk),
                        1,
                        { module: 'execution', method: 'getAccountInfo' }
                      );
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
      
      // NOTE: Bitmap extension is NOT included in coverageMetas - the SDK handles it automatically
      // We previously added bitmap extension to metas, but this is unnecessary and can cause issues.
      // The SDK includes the correct bitmap extension PDA when building swap instructions.

      binArrayMetas = coverageMetas.length ? coverageMetas : null;
      } catch {}

      const BN = (await import('bn.js')).default as any;
      const amountIn = new BN(String(hop.amountInRaw ?? 0n));
      const minOut = new BN(String(hop.minOutRaw ?? 0n));
      const methods = (program as any)?.methods || {};

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
        weight,
        { module: 'execution', method: 'getMultipleAccountsInfo' }
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
      
      // Use cached bitmap extension from pool data (checked during pool normalization)
      // Some pools require an actual bitmap extension PDA, others can use program ID
      // Falls back to program ID if not set in pool data
      accounts.binArrayBitmapExtension = hop.bitmapExtension 
        ? toPublicKey(hop.bitmapExtension) 
        : programId;
      
      try {
        logger.info('meteora.dlmm.bitmap_ext.from_pool_cache', {
          cat: 'tx',
          ctx: { 
            pool: hop.poolId, 
            bitmapExt: accounts.binArrayBitmapExtension.toBase58(),
            fromCache: !!hop.bitmapExtension,
            usingProgramIdFallback: !hop.bitmapExtension
          }
        });
      } catch {}

      // Extend with host/referral fee handling and reserves when available
      // hostFeeIn must be a valid token account for the input token
      // Use the user's own input token account (userTokenIn) as the host fee recipient
      // This satisfies the SDK requirement while keeping any fees in the user's wallet
      const acctBase: any = { ...accounts };
      
      // Set hostFeeIn to userTokenIn (user's input token account)
      // This prevents both error 3007 (wrong owner) and "hostFeeIn not provided" errors
      try {
      if (accounts.userTokenIn) {
        acctBase.hostFeeIn = accounts.userTokenIn;
      }
      } catch {}
      
      // Map vaultA/vaultB to reserveX/reserveY based on pool's token order
      // vaultA/vaultB represent the pool's natural mint_a/mint_b order
      // We need to determine if the pool's tokenX is mint_a or mint_b, then map accordingly
      try {
      if (hop.vaultA && hop.vaultB) {
        // We'll determine the correct mapping after we know tokenX/tokenY mints
        // Store them temporarily - will be corrected below after fetching pool mints
        acctBase.reserveX = toPublicKey(hop.vaultA as any);
        acctBase.reserveY = toPublicKey(hop.vaultB as any);
      }
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
        
        // CRITICAL FIX: Correct reserve mapping based on pool token order
        // vaultA/vaultB represent pool's mint_a/mint_b order (from pool data)
        // reserveX/reserveY must represent pool's tokenX/tokenY order (for SDK)
        // We need to map vaultA/vaultB to reserveX/reserveY by comparing mints
        try {
          if (hop.vaultA && hop.vaultB) {
            // Fetch pool's mint_a and mint_b to determine mapping
            const { peekMeteoraPools } = await import('../../server/pools.js');
            const pools = peekMeteoraPools();
            const poolId = hop.poolId.replace(/-rev$/, '');
            const poolData = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
            
            if (poolData) {
              const poolMintA = String((poolData as any)?.mint_a || '');
              const poolMintB = String((poolData as any)?.mint_b || '');
              
              if (poolMintA && poolMintB) {
                // Determine if tokenX corresponds to mint_a or mint_b
                const tokenXIsMintA = tokenXMintPk.toBase58() === poolMintA;
                const tokenXIsMintB = tokenXMintPk.toBase58() === poolMintB;
                
                if (tokenXIsMintA) {
                  // tokenX=mint_a, tokenY=mint_b => reserveX=vaultA, reserveY=vaultB
                  acctBase.reserveX = toPublicKey(hop.vaultA);
                  acctBase.reserveY = toPublicKey(hop.vaultB);
                } else if (tokenXIsMintB) {
                  // tokenX=mint_b, tokenY=mint_a => reserveX=vaultB, reserveY=vaultA (swapped!)
                  acctBase.reserveX = toPublicKey(hop.vaultB);
                  acctBase.reserveY = toPublicKey(hop.vaultA);
                }
              }
            }
          }
        } catch (e: any) {
          try {
            logger.debug('meteora.dlmm.reserve_mapping.failed', {
              cat: 'tx',
              ctx: { error: String(e?.message || e) }
            });
          } catch {}
        }
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

      // CRITICAL FIX: Correct reserve mapping for all pools (SDK-independent)
      // This runs even if getTokensMintFromPoolAddress wasn't available
      // vaultA/vaultB represent pool's mint_a/mint_b, must map to reserveX/reserveY (tokenX/tokenY)
      try {
      if (hop.vaultA && hop.vaultB) {
        // Fetch pool data to get mint_a/mint_b
        const { peekMeteoraPools } = await import('../../server/pools.js');
        const pools = peekMeteoraPools();
        const poolId = hop.poolId.replace(/-rev$/, '');
        const poolData = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
        
        if (poolData) {
          const poolMintA = String((poolData as any)?.mint_a || '');
          const poolMintB = String((poolData as any)?.mint_b || '');
          
          // Try to get tokenX/tokenY from acctBase or derive from pool state
          let tokenXMint: string | null = null;
          let tokenYMint: string | null = null;
          
          if (acctBase.tokenXMint && acctBase.tokenYMint) {
            tokenXMint = (acctBase.tokenXMint instanceof PublicKey ? acctBase.tokenXMint : toPublicKey(acctBase.tokenXMint)).toBase58();
            tokenYMint = (acctBase.tokenYMint instanceof PublicKey ? acctBase.tokenYMint : toPublicKey(acctBase.tokenYMint)).toBase58();
          } else {
            // Fallback: try to fetch from pool state directly
            try {
              const poolState = await program.account.lbPair.fetch(poolPk);
              if (poolState) {
                const tkX = (poolState as any)?.tokenXMint || (poolState as any)?.token_x_mint;
                const tkY = (poolState as any)?.tokenYMint || (poolState as any)?.token_y_mint;
                if (tkX) {
                  tokenXMint = (tkX.publicKey || tkX).toBase58?.() || String(tkX);
                  // Also set in acctBase for consistency
                  acctBase.tokenXMint = (tkX.publicKey || tkX);
                }
                if (tkY) {
                  tokenYMint = (tkY.publicKey || tkY).toBase58?.() || String(tkY);
                  // Also set in acctBase for consistency
                  acctBase.tokenYMint = (tkY.publicKey || tkY);
                }
              }
            } catch {}
          }
          
          if (poolMintA && poolMintB && tokenXMint && tokenYMint) {
            // Determine if tokenX corresponds to mint_a or mint_b
            const tokenXIsMintA = tokenXMint === poolMintA;
            const tokenXIsMintB = tokenXMint === poolMintB;
            
            if (tokenXIsMintA) {
              // tokenX=mint_a, tokenY=mint_b => reserveX=vaultA, reserveY=vaultB
              acctBase.reserveX = toPublicKey(hop.vaultA);
              acctBase.reserveY = toPublicKey(hop.vaultB);
              try {
                logger.debug('meteora.dlmm.reserve_mapped', {
                  cat: 'tx',
                  ctx: { poolId: hop.poolId, mapping: 'natural', tokenX: 'mint_a' }
                });
              } catch {}
            } else if (tokenXIsMintB) {
              // tokenX=mint_b, tokenY=mint_a => reserveX=vaultB, reserveY=vaultA (swapped!)
              acctBase.reserveX = toPublicKey(hop.vaultB);
              acctBase.reserveY = toPublicKey(hop.vaultA);
              try {
                logger.debug('meteora.dlmm.reserve_mapped', {
                  cat: 'tx',
                  ctx: { poolId: hop.poolId, mapping: 'swapped', tokenX: 'mint_b' }
                });
              } catch {}
            }
          } else {
            // Fallback: if we can't determine token order, use natural mapping
            if (!acctBase.reserveX) acctBase.reserveX = toPublicKey(hop.vaultA);
            if (!acctBase.reserveY) acctBase.reserveY = toPublicKey(hop.vaultB);
            try {
              logger.debug('meteora.dlmm.reserve_mapped_fallback', {
                cat: 'tx',
                ctx: { poolId: hop.poolId, mapping: 'fallback_natural', reason: 'missing_token_info' }
              });
            } catch {}
          }
        }
      }
      } catch (e: any) {
      try {
        logger.debug('meteora.dlmm.reserve_mapping_fallback.failed', {
          cat: 'tx',
          ctx: { poolId: hop.poolId, error: String(e?.message || e) }
        });
      } catch {}
      }

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

      // Fetch token program IDs AFTER token mints are confirmed
      // Detect correct token program IDs per mint (Token-2022 support)
      try {
      logger.info('meteora.dlmm.token_programs.fetch_start', { cat: 'tx', ctx: { poolId: hop.poolId } });
      const getTokenProgramId = (DLMM as any)?.getTokenProgramId;
      logger.info('meteora.dlmm.token_programs.sdk_function', { cat: 'tx', ctx: { poolId: hop.poolId, exists: !!getTokenProgramId } });
      
      const xMint = acctBase.tokenXMint ? (acctBase.tokenXMint.publicKey || acctBase.tokenXMint) : undefined;
      const yMint = acctBase.tokenYMint ? (acctBase.tokenYMint.publicKey || acctBase.tokenYMint) : undefined;
      logger.info('meteora.dlmm.token_programs.mints_extracted', { cat: 'tx', ctx: { poolId: hop.poolId, hasXMint: !!xMint, hasYMint: !!yMint } });
      
      const fallbackTokenProg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      
      // Helper to ensure we have a proper PublicKey instance
      const ensurePublicKey = (value: any, fallback: PublicKey): PublicKey => {
        if (!value) return fallback;
        // Already a PublicKey
        if (value instanceof PublicKey) return value;
        // Has toBase58 method - extract and create new PublicKey
        if (typeof value.toBase58 === 'function') {
          try {
            return new PublicKey(value.toBase58());
          } catch {
            return fallback;
          }
        }
        // String representation
        if (typeof value === 'string') {
          try {
            return new PublicKey(value);
          } catch {
            return fallback;
          }
        }
        // Buffer/Uint8Array
        if (value.length === 32 || (value.buffer && value.buffer.byteLength === 32)) {
          try {
            return new PublicKey(value);
          } catch {
            return fallback;
          }
        }
        return fallback;
      };
      
      // Handle synchronous or asynchronous return
      if (getTokenProgramId && xMint) {
        try {
          const resultX = getTokenProgramId(connection, xMint);
          // Check if it's a Promise
          if (resultX && typeof resultX.then === 'function') {
            const resolved = await resultX.catch(() => fallbackTokenProg);
            acctBase.tokenXProgram = ensurePublicKey(resolved, fallbackTokenProg);
          } else {
            // Synchronous return - ensure it's a proper PublicKey
            acctBase.tokenXProgram = ensurePublicKey(resultX, fallbackTokenProg);
          }
          logger.info('meteora.dlmm.token_programs.x_set', { cat: 'tx', ctx: { poolId: hop.poolId, tokenXProgram: acctBase.tokenXProgram?.toBase58?.() || String(acctBase.tokenXProgram) } });
        } catch (e) {
          acctBase.tokenXProgram = fallbackTokenProg;
          logger.warn('meteora.dlmm.token_programs.x_error', { cat: 'tx', ctx: { poolId: hop.poolId, error: String(e) } });
        }
      }
      
      if (getTokenProgramId && yMint) {
        try {
          const resultY = getTokenProgramId(connection, yMint);
          // Check if it's a Promise
          if (resultY && typeof resultY.then === 'function') {
            const resolved = await resultY.catch(() => fallbackTokenProg);
            acctBase.tokenYProgram = ensurePublicKey(resolved, fallbackTokenProg);
          } else {
            // Synchronous return - ensure it's a proper PublicKey
            acctBase.tokenYProgram = ensurePublicKey(resultY, fallbackTokenProg);
          }
          logger.info('meteora.dlmm.token_programs.y_set', { cat: 'tx', ctx: { poolId: hop.poolId, tokenYProgram: acctBase.tokenYProgram?.toBase58?.() || String(acctBase.tokenYProgram) } });
        } catch (e) {
          acctBase.tokenYProgram = fallbackTokenProg;
          logger.warn('meteora.dlmm.token_programs.y_error', { cat: 'tx', ctx: { poolId: hop.poolId, error: String(e) } });
        }
      }
      
      if (!acctBase.tokenXProgram) {
        acctBase.tokenXProgram = fallbackTokenProg;
        logger.info('meteora.dlmm.token_programs.x_fallback', { cat: 'tx', ctx: { poolId: hop.poolId } });
      }
      if (!acctBase.tokenYProgram) {
        acctBase.tokenYProgram = fallbackTokenProg;
        logger.info('meteora.dlmm.token_programs.y_fallback', { cat: 'tx', ctx: { poolId: hop.poolId } });
      }
      logger.info('meteora.dlmm.token_programs.fetch_complete', { cat: 'tx', ctx: { poolId: hop.poolId, hasX: !!acctBase.tokenXProgram, hasY: !!acctBase.tokenYProgram } });
      } catch (err) {
      logger.error('meteora.dlmm.token_programs.fetch_error', { cat: 'tx', ctx: { poolId: hop.poolId, error: String(err) } });
      }

      // Choose swap variant now that token program IDs are known
      try {
      const tokenKeg = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const isToken2022 = (p: any) => { try { return p && typeof p.equals === 'function' && !p.equals(tokenKeg); } catch { return false; } };
      const needs2022 = isToken2022(acctBase.tokenXProgram) || isToken2022(acctBase.tokenYProgram);
      
      // Log method availability for debugging
      try {
        logger.info('meteora.dlmm.method_selection', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            needs2022,
            hasSwap2: typeof (methods as any)?.swap2 === 'function',
            hasSwap: typeof (methods as any)?.swap === 'function',
            hasSwapExactIn: typeof (methods as any)?.swapExactIn === 'function',
            tokenXProgram: acctBase.tokenXProgram?.toBase58?.() || String(acctBase.tokenXProgram),
            tokenYProgram: acctBase.tokenYProgram?.toBase58?.() || String(acctBase.tokenYProgram)
          }
        });
      } catch {}
      
      // NOTE: Anchor methods don't take swapForY - direction is inferred from accounts (reserveX/reserveY)
      // PREFER swap2 if available (newer, more robust) regardless of Token-2022
      // swap2 handles bitmap extension edge cases better than the older swap method
      if (typeof (methods as any)?.swap2 === 'function') {
        builder = methods.swap2(amountIn, minOut, { slices: [] });
        try { logger.info('meteora.dlmm.using_swap2', { cat: 'tx', ctx: { poolId: hop.poolId } }); } catch {}
      } else if (typeof (methods as any)?.swap === 'function') {
        builder = methods.swap(amountIn, minOut);
        try { logger.info('meteora.dlmm.using_swap', { cat: 'tx', ctx: { poolId: hop.poolId } }); } catch {}
      } else if (typeof (methods as any)?.swapExactIn === 'function') {
        builder = methods.swapExactIn(amountIn, minOut);
        try { logger.info('meteora.dlmm.using_swapExactIn', { cat: 'tx', ctx: { poolId: hop.poolId } }); } catch {}
      } else {
        const error = new Error('DLMM_SWAP_METHOD_MISSING');
        try {
          logger.error('meteora.dlmm.method_missing', {
            cat: 'tx',
            code: LogCode.TX_BUILD_ERR,
            ctx: {
              poolId: hop.poolId,
              needs2022,
              hasSwap2: typeof (methods as any)?.swap2 === 'function',
              hasSwap: typeof (methods as any)?.swap === 'function',
              hasSwapExactIn: typeof (methods as any)?.swapExactIn === 'function'
            }
          });
        } catch {}
        throw error;
      }
      
      // Validate builder was created
      if (!builder) {
        throw new Error('DLMM_BUILDER_NULL');
      }
      } catch (e: any) {
      try {
        logger.error('meteora.dlmm.method_selection_error', {
          cat: 'tx',
          code: LogCode.TX_BUILD_ERR,
          ctx: {
            poolId: hop.poolId,
            error: String(e?.message || e),
            stack: e?.stack
          }
        });
      } catch {}
      // Re-throw to prevent continuing with invalid builder
      throw wrapBuilderError(e, 'METEORA_DLMM', 'method selection failed', hop);
      }

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
          tokenXProgram: acctBase.tokenXProgram ? (acctBase.tokenXProgram instanceof PublicKey ? acctBase.tokenXProgram.toBase58() : String(acctBase.tokenXProgram)) : 'missing',
          tokenYProgram: acctBase.tokenYProgram ? (acctBase.tokenYProgram instanceof PublicKey ? acctBase.tokenYProgram.toBase58() : String(acctBase.tokenYProgram)) : 'missing',
          userTokenIn: acctBase.userTokenIn ? (acctBase.userTokenIn instanceof PublicKey ? acctBase.userTokenIn.toBase58() : String(acctBase.userTokenIn)) : 'missing',
          userTokenOut: acctBase.userTokenOut ? (acctBase.userTokenOut instanceof PublicKey ? acctBase.userTokenOut.toBase58() : String(acctBase.userTokenOut)) : 'missing'
        }
      });
      } catch {}
      
      // Debug: Log ALL fields in acctBase to identify missing accounts
      try {
      const acctFields = Object.keys(acctBase);
      const acctDebug: any = {};
      for (const key of acctFields) {
        const val = (acctBase as any)[key];
        if (val && typeof val.toBase58 === 'function') {
          acctDebug[key] = val.toBase58();
        } else if (val) {
          acctDebug[key] = String(val);
        } else {
          acctDebug[key] = null;
        }
      }
      logger.info('meteora.dlmm.acctBase.all_fields', { cat: 'tx', ctx: { poolId: hop.poolId, fields: acctDebug } });
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
        note: 'bitmap_extension handled automatically by SDK'
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
                // ENHANCED: Calculate required bin arrays dynamically based on swap size and direction
                // This replaces the old fixed expansion factor approach with intelligent estimation
                const binRangeCalc = await calculateRequiredBinArrays(
                  DLMM,
                  program,
                  poolPk,
                  programId,
                  activeBinId,
                  hop,
                  acctBase,
                  binIdToBinArrayIndex,
                  getBinArrayLowerUpperBinId
                );
                
                const rangeLower = binRangeCalc.lowerBinId;
                const rangeUpper = binRangeCalc.upperBinId;
                
                try {
                  logger.info('meteora.dlmm.bin_range.calculated', {
                    cat: 'tx',
                    ctx: {
                      poolId: hop.poolId,
                      binsTraversed: binRangeCalc.binsTraversed,
                      binArrayCount: binRangeCalc.count,
                      direction: binRangeCalc.direction,
                      swapAmount: hop.amountInRaw.toString(),
                      range: `${rangeLower.toString()}..${rangeUpper.toString()}`
                    }
                  });
                } catch {}
                
                const metas = getBinArrayAccountMetasCoverage(rangeLower, rangeUpper, poolPk, programId) || [];
                // Validate bin arrays using local cache (zero RPC calls)
                const validatedMetas: any[] = [];
                if (Array.isArray(metas) && metas.length > 0) {
                  try {
                    // Import the validation function
                    const { isMeteoraBinArraySubscribed } = await import('../../server/pools.js');
                    
                    for (const meta of metas) {
                      try {
                        const pk = meta?.pubkey || meta?.publicKey || meta?.address;
                        const accountAddress = pk instanceof PublicKey ? pk.toBase58() : 
                                             (typeof pk?.toBase58 === 'function' ? pk.toBase58() : String(pk));
                        
                        // Check if this bin array is in our local cache (means it exists and we're subscribed)
                        if (accountAddress && isMeteoraBinArraySubscribed(accountAddress)) {
                          validatedMetas.push(meta);
                        } else {
                          // Not in cache - might not exist, skip it to avoid error 3007
                          try { 
                            logger.debug('meteora.dlmm.bin_array.not_in_cache', { 
                              cat: 'tx', 
                              ctx: { account: accountAddress?.slice(0, 8) + '...' } 
                            }); 
                          } catch {}
                        }
                      } catch (e: any) {
                        // Skip invalid meta entries
                        try { logger.debug('meteora.dlmm.validate_meta.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
                      }
                    }
                  } catch (e: any) {
                    try { logger.debug('meteora.dlmm.validate_metas.failed', { cat: 'tx', ctx: { error: String(e?.message || e) } }); } catch {}
                    // If validation fails, don't use any metas to be safe
                  }
                }
                
                // Use the calculated bin array count as our limit
                // We calculated exactly how many we need, so only include that many
                // Add a small buffer (+2) for edge cases where price moves slightly
                const calculatedLimit = Math.min(binRangeCalc.count + 2, validatedMetas.length);
                const limitedMetas = validatedMetas.slice(0, calculatedLimit);
                
                if (limitedMetas.length) {
                  builder = (builder as any).remainingAccounts(limitedMetas);
                  try { 
                    logger.info('meteora.dlmm.remaining.ok', { 
                      cat: 'tx', 
                      ctx: { 
                        count: limitedMetas.length, 
                        total: metas.length, 
                        validated: validatedMetas.length,
                        calculatedNeeded: binRangeCalc.count,
                        usedLimit: calculatedLimit,
                        range: `${rangeLower.toString()}..${rangeUpper.toString()}` 
                      } 
                    }); 
                  } catch {}
                } else {
                  try {
                    logger.warn('meteora.dlmm.no_valid_bin_arrays', {
                      cat: 'tx',
                      ctx: {
                        poolId: hop.poolId,
                        totalMetas: metas.length,
                        validatedMetas: validatedMetas.length,
                        calculatedNeeded: binRangeCalc.count
                      }
                    });
                  } catch {}
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
      
      // Add pre-computed bin array metas as remaining accounts (already limited to ~5 max)
      // Only add if SDK helper didn't already set remaining accounts
      if (binArrayMetas && binArrayMetas.length && typeof (builder as any).remainingAccounts === 'function') {
      try {
        // Safety limit - should already be limited but cap at 5 just in case
        const limited = binArrayMetas.slice(0, 5);
        if (limited.length) {
          builder = (builder as any).remainingAccounts(limited);
          try { logger.debug('meteora.dlmm.remaining.from_metas', { cat: 'tx', ctx: { count: limited.length } }); } catch {}
        }
      } catch {}
      }
      
      ix = (typeof builder.instruction === 'function') ? await builder.instruction() : null;
      
      // Apply safety cap to bin arrays to prevent excessively large transactions
      // This is a safety measure only - the bin array calculation should already be optimal
      // Core instruction accounts (first 15) must preserve SDK ordering
      if (ix && Array.isArray(ix.keys) && ix.keys.length > 15) {
      try {
        const coreAccountCount = 15; // Preserve core instruction accounts
        
        // Safety cap: Maximum bin arrays allowed per swap
        // This prevents transaction size overflow while still allowing enough bins for large swaps
        // With our directional bin array selection and conservative estimation, this should rarely be hit
        const MAX_BIN_ARRAYS = 15; // Reasonable maximum - more than this is likely a bug
        
        const originalCount = ix.keys.length;
        const remainingAccountCount = originalCount - coreAccountCount;
        
        if (remainingAccountCount > MAX_BIN_ARRAYS) {
          // Only limit if we exceed the safety cap
          ix.keys = [...ix.keys.slice(0, coreAccountCount + MAX_BIN_ARRAYS)];
          
          const removedCount = originalCount - ix.keys.length;
          try {
            logger.warn('meteora.dlmm.bin_arrays.safety_capped', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                originalCount,
                newCount: ix.keys.length,
                removedCount,
                coreAccountCount,
                maxBinArrays: MAX_BIN_ARRAYS,
                warning: 'Bin array count exceeded safety cap - this may indicate a bug in calculation'
              }
            });
          } catch {}
        } else {
          // Within safety limits - log success
          try {
            logger.info('meteora.dlmm.bin_arrays.within_limits', {
              cat: 'tx',
              ctx: {
                poolId: hop.poolId,
                totalAccounts: originalCount,
                binArrays: remainingAccountCount,
                maxBinArrays: MAX_BIN_ARRAYS
              }
            });
          } catch {}
        }
      } catch {}
      }
    } catch (e: any) {
      // Catch errors from ts-client fallback path
      try { logger.warn('meteora.dlmm.tsclient.fallback.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
      // Don't throw here - let execution continue to final error handling below
    }
    
    if (ix) {
      try { logger.info('meteora.dlmm.swap.ok', { cat: 'tx' }); } catch {}
      return [...setupIxs, ix];
    }
    
    try { logger.warn('meteora.dlmm.tsclient.swap.empty', { cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
    
    // Wrap final error with context (only reached if no successful return)
    throw wrapBuilderError(new Error('METEORA_DLMM_BUILD_FAILED'), 'METEORA_DLMM', 'build failed', hop);
  } catch (e: any) {
    // Catch any errors thrown from the entire function body
    // This ensures all errors (including early validation/connection errors) get Meteora-specific logging
    try { logger.warn('meteora.dlmm.tsclient.err', { cat: 'tx', code: LogCode.TX_BUILD_ERR, ctx: { error: String(e?.message || e) } }); } catch {}
    throw wrapBuilderError(e, 'METEORA_DLMM', 'build failed', hop);
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

    // CRITICAL: Get pool's actual mint orientation from cache
    // The pool's mintA/mintB orientation is FIXED in the pool state
    // We must use the pool's actual mintA/mintB, not swap them based on swap direction
    // This prevents constraint violations when swapping in reverse direction
    let poolMintA: string | undefined;
    let poolMintB: string | undefined;
    let poolDecA: number | undefined;
    let poolDecB: number | undefined;
    try {
      const { executionCache } = await import('../cache.js');
      const cached = executionCache.getStatic(hop.poolId);
      if (cached) {
        poolMintA = cached.mint_a;
        poolMintB = cached.mint_b;
        poolDecA = cached.decimals_a;
        poolDecB = cached.decimals_b;
      }
    } catch {}
    
    // If pool mints not in cache, try to get from poolKeysFromApi
    if ((!poolMintA || !poolMintB) && poolKeysFromApi) {
      const apiMintA = poolKeysFromApi.mintA?.address || poolKeysFromApi.mintA;
      const apiMintB = poolKeysFromApi.mintB?.address || poolKeysFromApi.mintB;
      if (apiMintA) poolMintA = poolMintA || apiMintA;
      if (apiMintB) poolMintB = poolMintB || apiMintB;
    }
    
    // Fallback to hop mints if still not available (shouldn't happen in normal operation)
    if (!poolMintA || !poolMintB) {
      try {
        logger.warn('raydium.clmm.pool_mints.missing', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            note: 'Using hop.inputMint/outputMint as fallback - this may cause constraint violations on reverse swaps'
          } as any
        });
      } catch {}
      poolMintA = poolMintA || hop.inputMint;
      poolMintB = poolMintB || hop.outputMint;
    }

    // Use pool's ACTUAL mintA/mintB orientation (not swapped based on swap direction)
    const mintAAddress = toPublicKey(poolMintA).toBase58();
    const mintBAddress = toPublicKey(poolMintB).toBase58();
    
    // Determine which mint is input/output for token program IDs
    const isSwappingAtoB = hop.inputMint === poolMintA && hop.outputMint === poolMintB;
    
    // Log mint orientation for debugging constraint violations
    try {
      logger.info('raydium.clmm.mint_orientation', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          poolMintA,
          poolMintB,
          hopInputMint: hop.inputMint,
          hopOutputMint: hop.outputMint,
          isSwappingAtoB,
          note: 'Using pool\'s actual mint orientation to prevent constraint violations'
        } as any
      });
    } catch {}
    
    // CRITICAL: ownerInfo.tokenAccountA/B must match pool's mintA/mintB orientation
    // Not the swap direction (source/dest)
    // When swapping A→B: tokenAccountA = source (mintA), tokenAccountB = dest (mintB)
    // When swapping B→A: tokenAccountA = dest (mintA), tokenAccountB = source (mintB)
    const ownerInfo = {
      wallet: kp.publicKey,
      tokenAccountA: isSwappingAtoB ? toPublicKey(hop.userSourceAta) : toPublicKey(hop.userDestAta),
      tokenAccountB: isSwappingAtoB ? toPublicKey(hop.userDestAta) : toPublicKey(hop.userSourceAta),
    };
    
    const mintATokenProgram = isSwappingAtoB 
      ? (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58())
      : (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58());
    const mintBTokenProgram = isSwappingAtoB
      ? (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58())
      : (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58());
    
    const mintAInfo = {
      address: mintAAddress,
      decimals: poolDecA ?? Number(hop.inputDecimals ?? 0),
      programId: mintATokenProgram,
    } as any;
    const mintBInfo = {
      address: mintBAddress,
      decimals: poolDecB ?? Number(hop.outputDecimals ?? 0),
      programId: mintBTokenProgram,
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
    // NOTE: vaultA corresponds to mintA (pool's mint_a) and vaultB corresponds to mintB (pool's mint_b)
    // The hop.vaultA/vaultB should already be correctly mapped from cache/resolver
    const poolKeys: any = poolKeysFromApi || {
      id: poolId,
      programId,
      mintA: mintAInfo,
      mintB: mintBInfo,
      vault: {
        A: toPublicKey(hop.vaultA as any).toBase58(),  // vaultA maps to mintA (pool's mint_a)
        B: toPublicKey(hop.vaultB as any).toBase58(),  // vaultB maps to mintB (pool's mint_b)
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
    
    // OPTIMIZATION: Trust tick arrays from cache without RPC verification
    // The cached tick arrays come from WebSocket subscriptions that monitor these accounts
    // If they're in our cache, they exist and are valid - let the chain reject if not
    if (tickArrayCandidates.length > 0) {
      for (const addr of tickArrayCandidates) {
        try {
          const pk = toPublicKey(addr);
          tickArrayKeys.push(pk);
          try { 
            logger.debug('raydium.clmm.tickarray.from_cache', { 
              cat: 'tx', 
              ctx: { 
                pool: hop.poolId, 
                tickArray: pk.toBase58(),
              } as any 
            }); 
          } catch {}
        } catch (e: any) {
          try { 
            logger.debug('raydium.clmm.tickarray.invalid_address', { 
              cat: 'tx', 
              ctx: { 
                pool: hop.poolId, 
                tickArray: String(addr),
                error: String(e?.message || e) 
              } as any 
            }); 
          } catch {}
        }
      }
    }
    
    if (!tickArrayKeys.length) {
      throw createBuilderError('RAYDIUM_CLMM', 'no valid tick arrays found for swap (all accounts missing or invalid)', hop);
    }
    
    try {
      logger.info('raydium.clmm.tickarrays.using_cached', {
        cat: 'tx',
        code: LogCode.TX_BUILD_HOP,
        ctx: {
          pool: hop.poolId,
          count: tickArrayKeys.length,
          center: hop.tickArrayCenter?.slice(0, 8) + '…',
          lower: hop.tickArrayLower?.slice(0, 8) + '…',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…'
        } as any
      });
    } catch {}
    
    // Sort tick arrays: center first (most likely needed), then others
    const centerPk = hop.tickArrayCenter ? toPublicKey(hop.tickArrayCenter) : null;
    if (centerPk && tickArrayKeys.find(pk => pk.equals(centerPk))) {
      const centerIdx = tickArrayKeys.findIndex(pk => pk.equals(centerPk));
      if (centerIdx > 0) {
        tickArrayKeys.unshift(tickArrayKeys.splice(centerIdx, 1)[0]);
      }
    }


    // Derive exBitmap (tick array bitmap extension) PDA
    // The SDK may conditionally include this in swap instructions based on pool state.
    // exBitmap is used for tracking which tick arrays are initialized in pools with
    // large tick ranges. It's a PDA: [b"exaccount", pool.toBytes()].
    // 
    // IMPORTANT: We check if it exists on-chain for logging purposes, but we do NOT
    // remove it from instructions if it doesn't exist. The SDK's instruction data
    // encodes account indices, and removing accounts post-generation breaks those indices.
    let exBitmapPk: PublicKey | null = null;
    let exBitmapExists = false;
    
    // Try to get exBitmap from cache first (avoids repeated PDA derivation)
    try {
      const { executionCache } = await import('../../execution/cache.js');
      const cached = executionCache.getStatic(hop.poolId);
      if (cached?.ex_bitmap) {
        exBitmapPk = new PublicKey(cached.ex_bitmap);
        try {
          logger.debug('raydium.clmm.exbitmap.from_cache', {
            cat: 'tx',
            ctx: { pool: hop.poolId, address: exBitmapPk.toBase58() }
          });
        } catch {}
      }
    } catch {}
    
    // If not cached, derive it using SDK
    if (!exBitmapPk) {
      try {
        const { getPdaExBitmapAccount } = await import('@raydium-io/raydium-sdk-v2').catch(() => ({ getPdaExBitmapAccount: null }));
        if (getPdaExBitmapAccount) {
          exBitmapPk = getPdaExBitmapAccount(programIdPk, poolIdPk).publicKey;
          // We'll check existence later in batch with observation account to reduce RPC calls
          try {
            logger.debug('raydium.clmm.exbitmap.derived', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId,
                exBitmap: exBitmapPk.toBase58(),
                note: 'Will check existence later - SDK determines if needed in instruction',
              } as any,
            });
          } catch {}
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
    }

    const BN = (await import('bn.js')).default as any;
    const amountInBn = new BN(String(hop.amountInRaw ?? 0n));
    const minOutBn = new BN(String(hop.minOutRaw ?? 0n));
    const sqrtLimitBn = new BN(String(hop.sqrtPriceLimitX64 ?? 0n));

    // CRITICAL: Log exact amount being used for multihop debugging
    // This helps identify if amountInRaw is correct before building the instruction
    try {
      logger.info('raydium.clmm.build.amount', {
        cat: 'tx',
        code: LogCode.TX_BUILD_HOP,
        ctx: {
          pool: hop.poolId,
          amountInRaw: hop.amountInRaw?.toString() || '0',
          amountInBn: amountInBn.toString(),
          minOutRaw: hop.minOutRaw?.toString() || '0',
          quotedOutputRaw: hop.quotedOutputRaw?.toString() || 'N/A',
          useExactAmount: hop.useExactAmount || false,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
        } as any,
      });
    } catch {}

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
    
    // Note: We don't decode instruction data here because:
    // 1. The SDK correctly encodes the amount we pass to it
    // 2. Instruction data format can vary and is complex to decode correctly
    // 3. The actual transaction execution will use the correct amount
    // Instead, we rely on the amount propagation logic to ensure correct amounts are used
    
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
          const accountInfos = await withRpcLimit(
            () => connection.getMultipleAccountsInfo(keys),
            weight,
            { module: 'execution', method: 'getMultipleAccountsInfo' }
          ).catch(() => null);
          
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
    
    // IMPORTANT: Do NOT remove exBitmap from SDK-generated instructions!
    // The SDK encodes account indices in the instruction data. Removing accounts after
    // instruction generation shifts all subsequent account indices, causing the program
    // to read from wrong accounts (e.g. tick arrays) and fail with Custom error 6028.
    // 
    // If the SDK includes exBitmap, it means the pool needs it. Even if it doesn't exist
    // on-chain yet, Solana will handle non-existent accounts appropriately if they're
    // read-only. Let the SDK manage account inclusion logic - it knows what's needed.
    //
    // For reference: Raydium CLMM instruction data format encodes account indices for:
    // - Tick arrays (3 accounts, indices typically 14-16 in a 17-account instruction)
    // - exBitmap (typically index 13)
    // Removing exBitmap (index 13) shifts tick arrays to indices 13-15, but the
    // instruction data still references 14-16, causing out-of-bounds access.
    
    if (exBitmapPk) {
      try {
        logger.info('raydium.clmm.exbitmap.info', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            exBitmap: exBitmapPk.toBase58(),
            exists: exBitmapExists,
            note: 'exBitmap included in SDK instruction - do not remove (instruction data has encoded indices)',
          } as any,
        });
      } catch {}
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
          weight,
          { module: 'execution', method: 'getMultipleAccountsInfo' }
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
      // OPTIMIZATION: Skip verification by default (trust cached data from WebSocket subscriptions)
      // Set CONFIG.execution.skipAccountVerification=false to enable verification (for debugging)
      const skipVerification = (CONFIG as any)?.execution?.skipAccountVerification !== false; // Default: true (skip verification)
      if (skipVerification) {
        try {
          logger.debug('raydium.clmm.verification.skipped', {
            cat: 'tx',
            ctx: { pool: hop.poolId, reason: 'trusting_cached_data (CONFIG.execution.skipAccountVerification!=false)' } as any,
          });
        } catch {}
      }
      
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
          
          // Skip verification if configured (trust cached data)
          if (skipVerification) {
            verifiedIxs.push(ix);
            continue;
          }
          
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
              
              // Skip exBitmap account - it's optional and may not exist on-chain
              // The SDK includes it when needed, and Solana handles non-existent accounts
              if (exBitmapPk && pkStr === exBitmapPk.toBase58()) {
                skippedAccounts.push({ address: pkStr, index: keyIdx, reason: 'exbitmap_optional_account' });
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
              const accountInfos = await withRpcLimit(
                () => connection.getMultipleAccountsInfo(keys),
                weight,
                { module: 'execution', method: 'getMultipleAccountsInfo' }
              ).catch(() => null);
              
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
    // Best-effort: Use cached market accounts from pool data
    try {
      if (!hop.market || !hop.serumProgramId) {
        const { executionCache } = await import('../cache.js');
        const poolData = executionCache.getStatic(hop.poolId);
        if (poolData) {
          hop.market = hop.market || (poolData as any).market_id;
          hop.serumProgramId = hop.serumProgramId || (poolData as any).market_program_id;
          try {
            logger.debug('raydium.amm.use_cached_market', {
              cat: 'tx',
              ctx: {
                pool: hop.poolId.slice(0, 8) + '...',
                hasMarket: !!(poolData as any).market_id,
                hasProgram: !!(poolData as any).market_program_id
              }
            });
          } catch {}
        }
      }
    } catch {}
    
    // Fallback: If not in cache, try fetching from chain (backward compatibility)
    try {
      if (!hop.market || !hop.serumProgramId) {
        const connection = getConnection();
        const poolPk = toPublicKey(hop.poolId);
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const tempPoolAccountInfo = await withRpcLimit(
          () => connection.getAccountInfo(poolPk),
          1,
          { module: 'execution', method: 'getAccountInfo' }
        );
        if (tempPoolAccountInfo?.data?.length) {
          const rmod: any = await import('@raydium-io/raydium-sdk-v2');
          const layouts = [
            (rmod as any)?.LiquidityStateLayoutV4,
            (rmod as any)?.liquidityStateV4Layout,
            (rmod as any)?.LiquidityStateLayoutV5,
            (rmod as any)?.liquidityStateV5Layout,
          ].filter(Boolean);
          for (const layout of layouts) {
            try {
              const state = layout.decode(tempPoolAccountInfo.data);
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

    // CRITICAL: Get pool's actual mint orientation from cache to match Serum market
    // The Serum market has a fixed base/quote orientation that we must match
    // Using hop.inputMint/outputMint would be wrong if swapping in the reverse direction
    let poolMintA: string | undefined;
    let poolMintB: string | undefined;
    let poolDecA: number | undefined;
    let poolDecB: number | undefined;
    try {
      const { executionCache } = await import('../cache.js');
      const cached = executionCache.getStatic(hop.poolId);
      if (cached) {
        poolMintA = cached.mint_a;
        poolMintB = cached.mint_b;
        poolDecA = cached.decimals_a;
        poolDecB = cached.decimals_b;
      }
    } catch {}
    
    // Determine base/quote mints based on swap direction
    // If swapping mint_a -> mint_b, then base=mint_a, quote=mint_b
    // If swapping mint_b -> mint_a, then base=mint_b, quote=mint_a
    let baseMint: any;
    let quoteMint: any;
    let baseDecimals: number;
    let quoteDecimals: number;
    
    if (poolMintA && poolMintB) {
      // Use pool's actual mints and determine which is base vs quote based on swap direction
      const swappingAtoB = (hop.inputMint === poolMintA && hop.outputMint === poolMintB);
      const swappingBtoA = (hop.inputMint === poolMintB && hop.outputMint === poolMintA);
      
      if (swappingAtoB) {
        // Swapping A->B: base=A, quote=B
        baseMint = toPublicKey(poolMintA);
        quoteMint = toPublicKey(poolMintB);
        baseDecimals = poolDecA ?? Number(hop.inputDecimals);
        quoteDecimals = poolDecB ?? Number(hop.outputDecimals);
      } else if (swappingBtoA) {
        // Swapping B->A: base=B, quote=A
        baseMint = toPublicKey(poolMintB);
        quoteMint = toPublicKey(poolMintA);
        baseDecimals = poolDecB ?? Number(hop.inputDecimals);
        quoteDecimals = poolDecA ?? Number(hop.outputDecimals);
      } else {
        // Fallback: mismatch, use hop mints (shouldn't happen)
        try {
          logger.warn('raydium.amm.mint_mismatch', {
            cat: 'tx',
            ctx: {
              poolId: hop.poolId,
              hopInput: hop.inputMint,
              hopOutput: hop.outputMint,
              poolMintA,
              poolMintB
            }
          });
        } catch {}
        baseMint = toPublicKey(hop.inputMint);
        quoteMint = toPublicKey(hop.outputMint);
        baseDecimals = Number(hop.inputDecimals);
        quoteDecimals = Number(hop.outputDecimals);
      }
    } else {
      // Fallback if mints not in cache: use hop mints
      baseMint = toPublicKey(hop.inputMint);
      quoteMint = toPublicKey(hop.outputMint);
      baseDecimals = Number(hop.inputDecimals);
      quoteDecimals = Number(hop.outputDecimals);
    }

    // Build pool keys (requires correct base/quote mints & decimals per market)
    let poolKeys = (getAssociatedPoolKeys as any)({
      version,
      marketVersion: 3,
      marketId,
      baseMint,
      quoteMint,
      baseDecimals,
      quoteDecimals,
      programId: ammProgramId,
      marketProgramId,
    });

    // Helper to detect invalid PublicKey-like values (including placeholder strings)
    const isBadPk = (x: any): boolean => {
      return !isValidPublicKey(x);
    };

    // Decode AMM state from chain to override any placeholder keys returned by SDK
    // OPTIMIZATION: Try cached raw account data first (saves 50-150ms RPC call)
    let poolAccountInfo: any = null;
    try {
      const { executionCache } = await import('../cache.js');
      const cached = executionCache.getStatic(hop.poolId);
      if (cached?.rawAccountData) {
        poolAccountInfo = {
          data: cached.rawAccountData,
          owner: new PublicKey(hop.programId || CONFIG.raydium?.ammV4Program || ''),
        };
        try {
          logger.debug('raydium.amm.account.from_cache', {
            cat: 'tx',
            ctx: { pool: hop.poolId.slice(0, 8) + '...', age: Date.now() - (cached.rawAccountDataUpdatedMs || 0) }
          });
        } catch {}
      }
    } catch {}
    
    // Fallback to RPC if not in cache
    if (!poolAccountInfo) {
      try {
        // Use account cache instead of direct RPC call
        const { accountCache } = await import('../utils/accountCache.js');
        poolAccountInfo = await accountCache.getAccountInfo(toPublicKey(hop.poolId));
        try {
          logger.debug('raydium.amm.account.from_rpc', {
            cat: 'tx',
            ctx: { pool: hop.poolId.slice(0, 8) + '...' }
          });
        } catch {}
      } catch {}
    }
    
    if (poolAccountInfo?.data?.length) {
      const sdkLayouts: any = await import('@raydium-io/raydium-sdk-v2');
      const layouts = [
        (sdkLayouts as any)?.LiquidityStateLayoutV4,
        (sdkLayouts as any)?.liquidityStateV4Layout,
        (sdkLayouts as any)?.LiquidityStateLayoutV5,
        (sdkLayouts as any)?.liquidityStateV5Layout,
      ].filter(Boolean);
      let state: any = null;
      for (const layout of layouts) {
        try { state = layout.decode(poolAccountInfo.data); break; } catch {}
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
        // CRITICAL: Do NOT fall back to AMM vaults - Serum market vaults are separate accounts
        // The execution cache will provide the correct market vaults from on-chain data
        const marketBaseVault = asPk(state.marketBaseVault);
        const marketQuoteVault = asPk(state.marketQuoteVault);
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

    // CRITICAL: Use cached market accounts from pool data to fill in missing accounts
    // This is the preferred path for production as it avoids RPC calls during execution
    try {
      const { executionCache } = await import('../cache.js');
      const poolData = executionCache.getStatic(hop.poolId);
      if (poolData) {
        const cached = poolData as any;
        // Fill in any missing OR INVALID market accounts from cache
        // The SDK sometimes returns placeholder keys, so we need to replace those too
        if (cached.market_bids && (!(poolKeys as any)?.marketBids || isBadPk((poolKeys as any)?.marketBids))) {
          (poolKeys as any).marketBids = toPublicKey(cached.market_bids);
        }
        if (cached.market_asks && (!(poolKeys as any)?.marketAsks || isBadPk((poolKeys as any)?.marketAsks))) {
          (poolKeys as any).marketAsks = toPublicKey(cached.market_asks);
        }
        if (cached.market_event_queue && (!(poolKeys as any)?.marketEventQueue || isBadPk((poolKeys as any)?.marketEventQueue))) {
          (poolKeys as any).marketEventQueue = toPublicKey(cached.market_event_queue);
        }
        if (cached.market_base_vault && (!(poolKeys as any)?.marketBaseVault || isBadPk((poolKeys as any)?.marketBaseVault))) {
          (poolKeys as any).marketBaseVault = toPublicKey(cached.market_base_vault);
        }
        if (cached.market_quote_vault && (!(poolKeys as any)?.marketQuoteVault || isBadPk((poolKeys as any)?.marketQuoteVault))) {
          (poolKeys as any).marketQuoteVault = toPublicKey(cached.market_quote_vault);
        }
        if (cached.market_authority && (!(poolKeys as any)?.marketAuthority || isBadPk((poolKeys as any)?.marketAuthority))) {
          (poolKeys as any).marketAuthority = toPublicKey(cached.market_authority);
        }
        if (cached.amm_authority && (!(poolKeys as any)?.authority || isBadPk((poolKeys as any)?.authority))) {
          (poolKeys as any).authority = toPublicKey(cached.amm_authority);
        }
        if (cached.amm_open_orders && (!(poolKeys as any)?.openOrders || isBadPk((poolKeys as any)?.openOrders))) {
          (poolKeys as any).openOrders = toPublicKey(cached.amm_open_orders);
        }
        if (cached.amm_target_orders && (!(poolKeys as any)?.targetOrders || isBadPk((poolKeys as any)?.targetOrders))) {
          (poolKeys as any).targetOrders = toPublicKey(cached.amm_target_orders);
        }
        if (cached.lp_mint && (!(poolKeys as any)?.mintLp || isBadPk((poolKeys as any)?.mintLp))) {
          (poolKeys as any).mintLp = toPublicKey(cached.lp_mint);
        }
        
        try {
          logger.info('raydium.amm.poolkeys_from_cache', {
            cat: 'tx',
            ctx: {
              pool: hop.poolId.slice(0, 8) + '...',
              hasBids: !!cached.market_bids,
              hasAsks: !!cached.market_asks,
              hasEventQueue: !!cached.market_event_queue,
              hasAuthority: !!cached.amm_authority,
              hasOpenOrders: !!cached.amm_open_orders,
              replacedBids: !!(cached.market_bids && (!(poolKeys as any)?.marketBids || isBadPk((poolKeys as any)?.marketBids))),
              replacedAsks: !!(cached.market_asks && (!(poolKeys as any)?.marketAsks || isBadPk((poolKeys as any)?.marketAsks))),
              marketBidsValue: (poolKeys as any)?.marketBids?.toBase58?.() || 'missing'
            }
          });
        } catch {}
      }
    } catch {}

    const userKeys = {
      tokenAccountIn: toPublicKey(hop.userSourceAta),
      tokenAccountOut: toPublicKey(hop.userDestAta),
      owner: kp.publicKey,
    };

    // Normalize poolKeys shape to match Raydium SDK expectations (PublicKey fields only)
    // CRITICAL: Always normalize PublicKeys to fix broken BN structures from SDK
    try {
      const ensurePk = (v: any) => {
        if (!v) return undefined;
        
        // Always try to normalize, even if it looks like a valid PublicKey
        // Some PublicKeys from the SDK have broken BN internals that need reconstruction
        try {
          return normalizePublicKey(v);
        } catch {
          // If normalization fails but it has toBase58, try to use it
          if (v && typeof v === 'object' && typeof v.toBase58 === 'function') {
            try {
              // Attempt to reconstruct from base58 string
              return new PublicKey(v.toBase58());
            } catch {
              // Last resort: return original value
              return v;
            }
          }
          // Normalization failed - return original value as last resort
          return v;
        }
      };
      // Ensure mintLp is a PublicKey (not an object)
      const mintLpPk = ensurePk((poolKeys as any)?.mintLp?.address || (poolKeys as any)?.mintLp);
      if (mintLpPk) (poolKeys as any).mintLp = mintLpPk;
      // Vaults must be { A: PublicKey, B: PublicKey }
      const vaultA = ensurePk((poolKeys as any)?.vault?.A || (poolKeys as any)?.baseVault);
      const vaultB = ensurePk((poolKeys as any)?.vault?.B || (poolKeys as any)?.quoteVault);
      if (vaultA || vaultB) {
        (poolKeys as any).vault = {
          A: vaultA || (poolKeys as any)?.vault?.A,
          B: vaultB || (poolKeys as any)?.vault?.B,
        };
      }
      // Coerce remaining PublicKey fields (only if ensurePk succeeds)
      const ensureAndSet = (field: string, value: any) => {
        const normalized = ensurePk(value);
        if (normalized) (poolKeys as any)[field] = normalized;
      };
      ensureAndSet('id', (poolKeys as any).id);
      ensureAndSet('programId', ammProgramId);
      ensureAndSet('authority', (poolKeys as any).authority);
      ensureAndSet('openOrders', (poolKeys as any).openOrders);
      ensureAndSet('targetOrders', (poolKeys as any).targetOrders);
      ensureAndSet('marketProgramId', (poolKeys as any).marketProgramId);
      ensureAndSet('marketId', (poolKeys as any).marketId);
      ensureAndSet('marketEventQueue', (poolKeys as any).marketEventQueue);
      ensureAndSet('marketBids', (poolKeys as any).marketBids);
      ensureAndSet('marketAsks', (poolKeys as any).marketAsks);
      ensureAndSet('marketBaseVault', (poolKeys as any).marketBaseVault);
      ensureAndSet('marketQuoteVault', (poolKeys as any).marketQuoteVault);
      ensureAndSet('marketAuthority', (poolKeys as any).marketAuthority);
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
    
    // CRITICAL DEBUG: Log poolKeys state before SDK call to verify market accounts
    try {
      const toStr = (v: any) => {
        if (!v) return 'missing';
        if (typeof v === 'object' && typeof v.toBase58 === 'function') {
          try {
            return v.toBase58();
          } catch {
            return '[invalid-pk]';
          }
        }
        return String(v);
      };
      logger.info('raydium.amm.poolkeys_before_sdk', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId.slice(0, 8) + '...',
          marketId: toStr((poolKeys as any)?.marketId),
          marketProgramId: toStr((poolKeys as any)?.marketProgramId),
          marketBids: toStr((poolKeys as any)?.marketBids),
          marketAsks: toStr((poolKeys as any)?.marketAsks),
          marketEventQueue: toStr((poolKeys as any)?.marketEventQueue),
          marketBaseVault: toStr((poolKeys as any)?.marketBaseVault),
          marketQuoteVault: toStr((poolKeys as any)?.marketQuoteVault),
          marketAuthority: toStr((poolKeys as any)?.marketAuthority),
          authority: toStr((poolKeys as any)?.authority),
          openOrders: toStr((poolKeys as any)?.openOrders),
          targetOrders: toStr((poolKeys as any)?.targetOrders),
        }
      });
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
    } catch (coerceErr) {
      // Log coercion failure for debugging
      try {
        logger.error('raydium.amm.coerce.err', {
          cat: 'tx',
          ctx: {
            pool: hop.poolId,
            error: String((coerceErr as any)?.message || coerceErr),
            outLength: Array.isArray(out) ? out.length : 0
          }
        });
      } catch {}
    }
    
    // CRITICAL FIX: Validate that all instructions have proper PublicKey instances
    // If any instruction has malformed keys, rebuild it with proper normalization
    if (Array.isArray(out) && out.length > 0) {
      for (let i = 0; i < out.length; i++) {
        const ix = out[i];
        try {
          // Verify programId can be converted to base58
          const pidTest = ix.programId?.toBase58?.();
          if (!pidTest || pidTest === '[object Object]') {
            throw new Error('Invalid programId');
          }
          // Verify all account keys can be converted
          for (const k of ix.keys || []) {
            const pkTest = k.pubkey?.toBase58?.();
            if (!pkTest || pkTest === '[object Object]') {
              throw new Error('Invalid account key');
            }
          }
        } catch (validateErr) {
          // Rebuild this instruction with proper normalization
          try {
            logger.warn('raydium.amm.ix.rebuild', {
              cat: 'tx',
              ctx: { pool: hop.poolId, ixIndex: i, error: String((validateErr as any)?.message || validateErr) }
            });
            
            // Helper to check if an address is a placeholder
            const isPlaceholderAddress = (pk: PublicKey): boolean => {
              try {
                const b58 = pk.toBase58();
                return /^11111/.test(b58);
              } catch {
                return false;
              }
            };
            
            // Force rebuild with ammProgramId - use cached poolKeys as source of truth
            // The SDK provides the structure but with invalid keys - use our cached values instead
            const kp = await ensureWallet(CONFIG.walletPath);
            const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
            
            const buildKeyFromPoolKeys = (keyIdx: number): PublicKey | null => {
              try {
                // Map key indices to poolKeys fields based on Raydium AMM instruction layout
                // Standard Raydium AMM swap instruction has 18 accounts in this order:
                // 0: Token program, 1: AMM ID, 2: AMM authority, 3: AMM open orders, 4: AMM target orders
                // 5: AMM coin vault, 6: AMM pc vault, 7: Serum program, 8: Serum market
                // 9-11: Serum bids/asks/event queue, 12-13: Serum coin/pc vaults, 14: Serum vault signer
                // 15: User source token, 16: User dest token, 17: User owner
                
                switch (keyIdx) {
                  case 0: return TOKEN_PROGRAM_ID;
                  case 1: return (poolKeys as any)?.id;
                  case 2: return (poolKeys as any)?.authority;
                  case 3: return (poolKeys as any)?.openOrders;
                  case 4: return (poolKeys as any)?.targetOrders;
                  case 5: return (poolKeys as any)?.vault?.A || (poolKeys as any)?.baseVault;
                  case 6: return (poolKeys as any)?.vault?.B || (poolKeys as any)?.quoteVault;
                  case 7: return (poolKeys as any)?.marketProgramId || (poolKeys as any)?.market_program_id;
                  case 8: return (poolKeys as any)?.marketId || (poolKeys as any)?.market_id;
                  case 9: return (poolKeys as any)?.marketBids || (poolKeys as any)?.market_bids;
                  case 10: return (poolKeys as any)?.marketAsks || (poolKeys as any)?.market_asks;
                  case 11: return (poolKeys as any)?.marketEventQueue || (poolKeys as any)?.market_event_queue;
                  case 12: return (poolKeys as any)?.marketBaseVault || (poolKeys as any)?.market_base_vault;
                  case 13: return (poolKeys as any)?.marketQuoteVault || (poolKeys as any)?.market_quote_vault;
                  case 14: return (poolKeys as any)?.marketAuthority || (poolKeys as any)?.market_authority;
                  case 15: return toPublicKey(hop.userSourceAta);
                  case 16: return toPublicKey(hop.userDestAta);
                  case 17: return kp.publicKey;
                  default: return null;
                }
              } catch {
                return null;
              }
            };
            
            const newKeys = (ix.keys || []).map((k: any, keyIdx: number) => {
              let pubkey: PublicKey;
              try {
                // CRITICAL: Try to extract raw bytes or base58 from deeply nested foreign PublicKey
                const rawKey = k.pubkey || k.pubKey || k.address;
                
                // Handle undefined/null keys - use cached poolKeys instead
                if (!rawKey || rawKey === undefined || rawKey === null) {
                  const fallback = buildKeyFromPoolKeys(keyIdx);
                  if (fallback) {
                    return { pubkey: fallback, isSigner: !!k?.isSigner, isWritable: !!k?.isWritable };
                  }
                  
                  try {
                    logger.warn('raydium.amm.key.undefined.no_fallback', {
                      cat: 'tx',
                      ctx: {
                        keyIdx,
                        keyExists: !!k,
                        isSigner: !!k?.isSigner,
                        isWritable: !!k?.isWritable,
                      }
                    });
                  } catch {}
                  
                  // Skip this key entirely - return null to filter it out later
                  return null;
                }
                
                // Method 1: Try toBase58() - but check result is valid AND not a placeholder
                if (rawKey && typeof rawKey.toBase58 === 'function') {
                  try {
                    const b58 = rawKey.toBase58();
                    // Reject placeholders - addresses starting with "11111" are SDK-generated placeholders
                    // This includes: 11111111111111111111111111111111 (system program)
                    // and derived placeholders like: 1111135PXthLq2K1NqFisntc8WW162VfQtY1r3mLez
                    const isPlaceholder = /^11111/.test(b58);
                    if (b58 && typeof b58 === 'string' && b58.length > 20 && !b58.includes('object') && !isPlaceholder) {
                      pubkey = new PublicKey(b58);
                      return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                    }
                  } catch {}
                }
                
                // Method 2: Try toBytes()
                if (rawKey && typeof rawKey.toBytes === 'function') {
                  try {
                    const bytes = rawKey.toBytes();
                    if (bytes && bytes.length === 32) {
                      pubkey = new PublicKey(bytes);
                      // Check if the resulting PublicKey is a placeholder
                      if (isPlaceholderAddress(pubkey)) {
                        // Reject placeholder, fall through to next method
                      } else {
                        return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                      }
                    }
                  } catch {}
                }
                
                // Method 3: Try toBuffer()
                if (rawKey && typeof rawKey.toBuffer === 'function') {
                  try {
                    const buffer = rawKey.toBuffer();
                    if (buffer && buffer.length === 32) {
                      pubkey = new PublicKey(buffer);
                      // Check if the resulting PublicKey is a placeholder
                      if (isPlaceholderAddress(pubkey)) {
                        // Reject placeholder, fall through to next method
                      } else {
                        return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                      }
                    }
                  } catch {}
                }
                
                // Method 4: Check for internal _bn property (BN-based PublicKey) - ENHANCED
                if (rawKey && typeof rawKey === 'object') {
                  try {
                    const bn = rawKey._bn || rawKey.bn || rawKey.value;
                    if (bn && typeof bn === 'object') {
                      // Try multiple BN extraction methods
                      
                      // 4a: toArrayLike (most common)
                      if (typeof bn.toArrayLike === 'function') {
                        try {
                          const bytes = bn.toArrayLike(Uint8Array, 'be', 32);
                          pubkey = new PublicKey(bytes);
                          // Check if the resulting PublicKey is a placeholder
                          if (isPlaceholderAddress(pubkey)) {
                            // Reject placeholder, fall through to next method
                          } else {
                            return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                          }
                        } catch (bnErr) {
                          try { logger.debug('bn.toArrayLike.failed', { cat: 'tx', ctx: { keyIdx, error: String(bnErr) } }); } catch {}
                        }
                      }
                      
                      // 4b: toArray
                      if (typeof bn.toArray === 'function') {
                        try {
                          const arr = bn.toArray('be', 32);
                          pubkey = new PublicKey(Uint8Array.from(arr));
                          // Check if the resulting PublicKey is a placeholder
                          if (isPlaceholderAddress(pubkey)) {
                            // Reject placeholder, fall through to next method
                          } else {
                            return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                          }
                        } catch (bnErr) {
                          try { logger.debug('bn.toArray.failed', { cat: 'tx', ctx: { keyIdx, error: String(bnErr) } }); } catch {}
                        }
                      }
                      
                      // 4c: Direct buffer access from BN.js words array
                      if (bn.words && Array.isArray(bn.words)) {
                        try {
                          // BN.js stores data in 'words' array (26-bit limbs in little-endian)
                          const buffer = Buffer.alloc(32);
                          let offset = 0;
                          for (let i = bn.words.length - 1; i >= 0; i--) {
                            const word = bn.words[i];
                            buffer.writeUInt32BE(word >>> 0, offset);
                            offset += 4;
                            if (offset >= 32) break;
                          }
                          pubkey = new PublicKey(buffer);
                          // Check if the resulting PublicKey is a placeholder
                          if (isPlaceholderAddress(pubkey)) {
                            // Reject placeholder, fall through to next method
                          } else {
                            return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                          }
                        } catch (bnErr) {
                          try { logger.debug('bn.words.failed', { cat: 'tx', ctx: { keyIdx, error: String(bnErr) } }); } catch {}
                        }
                      }
                      
                      // 4d: toString(16) and parse as hex
                      if (typeof bn.toString === 'function') {
                        try {
                          const hex = bn.toString(16).padStart(64, '0');
                          const bytes = Buffer.from(hex, 'hex');
                          if (bytes.length === 32) {
                            pubkey = new PublicKey(bytes);
                            // Check if the resulting PublicKey is a placeholder
                            if (isPlaceholderAddress(pubkey)) {
                              // Reject placeholder, fall through to next method
                            } else {
                              return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                            }
                          }
                        } catch (bnErr) {
                          try { logger.debug('bn.toString.failed', { cat: 'tx', ctx: { keyIdx, error: String(bnErr) } }); } catch {}
                        }
                      }
                      
                      // 4e: Log BN structure for further debugging
                      try {
                        logger.error('raydium.amm.bn.structure', {
                          cat: 'tx',
                          ctx: {
                            keyIdx,
                            bnType: typeof bn,
                            bnConstructor: bn?.constructor?.name,
                            bnKeys: Object.keys(bn).slice(0, 15),
                            hasToArrayLike: typeof bn.toArrayLike,
                            hasToArray: typeof bn.toArray,
                            hasWords: Array.isArray(bn.words),
                            hasToString: typeof bn.toString,
                          }
                        });
                      } catch {}
                    }
                  } catch (bnExtractErr) {
                    try { logger.debug('bn.extraction.failed', { cat: 'tx', ctx: { keyIdx, error: String(bnExtractErr) } }); } catch {}
                  }
                }
                
                // Method 5: If it's already a string (but not a placeholder)
                if (typeof rawKey === 'string' && rawKey.length > 20 && !rawKey.includes('object')) {
                  // Reject placeholders - addresses starting with "11111" are SDK-generated placeholders
                  const isPlaceholder = /^11111/.test(rawKey);
                  if (!isPlaceholder) {
                    pubkey = new PublicKey(rawKey);
                    return { pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable };
                  }
                }
                
                // Method 6: Try logging the object structure to understand what we're dealing with
                try {
                  logger.error('raydium.amm.key.extraction.failed', {
                    cat: 'tx',
                    ctx: {
                      keyIdx,
                      hasToBase58: !!(rawKey && typeof rawKey.toBase58 === 'function'),
                      hasToBytes: !!(rawKey && typeof rawKey.toBytes === 'function'),
                      hasToBuffer: !!(rawKey && typeof rawKey.toBuffer === 'function'),
                      hasBN: !!(rawKey && rawKey._bn),
                      typeof: typeof rawKey,
                      keys: rawKey && typeof rawKey === 'object' ? Object.keys(rawKey).slice(0, 10) : [],
                    }
                  });
                } catch {}
                
                throw new Error(`Failed to extract PublicKey from foreign object at index ${keyIdx}`);
              } catch (keyErr) {
                // Final fallback: use poolKeys mapping
                try {
                  const fallback = buildKeyFromPoolKeys(keyIdx);
                  if (fallback) {
                    try {
                      logger.info('raydium.amm.key.fallback_used', {
                        cat: 'tx',
                        ctx: {
                          keyIdx,
                          fallbackAddress: fallback.toBase58().slice(0, 8) + '...',
                          originalError: String((keyErr as any)?.message || keyErr)
                        }
                      });
                    } catch {}
                    return { pubkey: fallback, isSigner: !!k?.isSigner, isWritable: !!k?.isWritable };
                  }
                } catch {}
                
                throw new Error(`Failed to normalize key at index ${keyIdx}: ${(keyErr as any)?.message}`);
              }
            });
            
            const filteredKeys = newKeys.filter((k): k is { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } => k !== null);
            
            out[i] = new TransactionInstruction({
              programId: ammProgramId,
              keys: filteredKeys,
              data: Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data || [])
            });
            
            try {
              logger.info('raydium.amm.ix.rebuild.ok', {
                cat: 'tx',
                ctx: { pool: hop.poolId, ixIndex: i, keyCount: filteredKeys.length }
              });
            } catch {}
          } catch (rebuildErr) {
            throw createBuilderError('RAYDIUM_AMM', `Failed to rebuild instruction: ${(rebuildErr as any)?.message}`, hop);
          }
        }
      }
    }
    
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


