import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { validateHttpUrl, swapABFields } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals, resolveDecimalsGuaranteed } from './decimals.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './precision.js';
import { getPriceByMint } from '../../server/priceStore.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import type { OrcaPoolApiResponse, OrcaTokenInfo } from './api-types.js';
import { isValidOrcaPool } from './api-types.js';
import { logCatchError } from '../../utils/errorHandler.js';

const FEERATE_FIELDS = ['tradingFeeRate', 'tradeFeeRate', 'feeRate', 'tradeFee', 'fee', 'makerFee', 'takerFee'];
const FEEBPS_FIELDS = ['fee_bps', 'feeBps', 'fee_in_bps'];
const PROTOCOL_FEE_FIELDS = ['protocolFeeRate', 'protocolFee'];

const toNumber = (value: any): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
};

export function deriveOrcaFeeBps(raw: any): number {
  // 1. Explicit bps fields take precedence
  for (const field of FEEBPS_FIELDS) {
    const val = toNumber(raw?.[field]);
    if (Number.isFinite(val) && (val as number) > 0) {
      return Math.round(val as number);
    }
  }

  const protocolRateRaw = PROTOCOL_FEE_FIELDS.map((f) => toNumber(raw?.[f]))
    .find((v) => Number.isFinite(v) && (v as number) > 0);
  const feeRateRaw = FEERATE_FIELDS.map((f) => toNumber(raw?.[f]))
    .find((v) => Number.isFinite(v) && (v as number) > 0);

  const toBps = (rate: number | undefined): number => {
    if (!Number.isFinite(rate) || (rate as number) <= 0) return 0;
    const n = rate as number;
    // Whirlpool accounts encode feeRate as u16 in hundredths of bps (max 65535 = 655.35 bps)
    if (Number.isInteger(n) && n > 1 && n <= 65535) {
      // On-chain Whirlpool accounts encode feeRate in hundredths of a basis point
      return Math.round(n / 100);
    }
    if (n >= 100) return Math.round(n); // already in bps (100 = 1%)
    if (n >= 0.01) return Math.round(n * 100); // treat as percentage value
    return Math.round(n * 10_000); // decimal fraction (0.003 => 30 bps)
  };

  const protocolBps = toBps(protocolRateRaw);
  let feeBps = toBps(feeRateRaw);

  if (feeBps > 0) {
    // Note: protocolFeeRate is a percentage of the collected fee that goes to protocol,
    // NOT a separate fee rate. The user pays the full feeRate — protocol/LP split is internal.
    return feeBps;
  }

  return protocolBps > 0 ? protocolBps : 0;
}

export async function fetchOrcaHttp(): Promise<any> {
  const ORCA_RAW_PATH = joinPath(CONFIG.cacheDir, 'orca-raw-sample.json');
  const baseUnsafe = CONFIG.orca?.apiUrl || 'https://api.orca.so/v2/solana/pools';
  const base = validateHttpUrl(baseUnsafe) || 'https://api.orca.so/v2/solana/pools';
  const retries = CONFIG.orca?.maxHttpRetries ?? 2;
  const backoffMs = CONFIG.orca?.httpBackoffMs ?? 500;
  const maxPages = CONFIG.orca?.maxPages ?? 5;
  const size = Number(CONFIG.orca?.pageSize ?? 500);
  const params: Record<string, string> = {};
  if (Number.isFinite(size as any) && size > 0) params.size = String(size);
  // Optional TVL/liquidity sorting & filters (only include if configured)
  try {
    const sortBy = (CONFIG.orca as any)?.sortBy;
    const sortDirection = (CONFIG.orca as any)?.sortDirection;
    const minTvl = (CONFIG.orca as any)?.minTvl;
    const minVolume = (CONFIG.orca as any)?.minVolume;
    const minLockedLiquidityPercent = (CONFIG.orca as any)?.minLockedLiquidityPercent;
    const hasRewards = (CONFIG.orca as any)?.hasRewards;
    const hasWarning = (CONFIG.orca as any)?.hasWarning;
    const hasAdaptiveFee = (CONFIG.orca as any)?.hasAdaptiveFee;
    const isWavebreak = (CONFIG.orca as any)?.isWavebreak;
    const token = (CONFIG.orca as any)?.token;
    const tokensBothOf = (CONFIG.orca as any)?.tokensBothOf;
    const addresses = (CONFIG.orca as any)?.addresses;
    const includeBlocked = (CONFIG.orca as any)?.includeBlocked;
    if (sortBy) params.sortBy = String(sortBy);
    if (sortDirection) params.sortDirection = String(sortDirection);
    if (minTvl != null) params.minTvl = String(minTvl);
    if (minVolume != null) params.minVolume = String(minVolume);
    if (minLockedLiquidityPercent != null) params.minLockedLiquidityPercent = String(minLockedLiquidityPercent);
    if (hasRewards != null) params.hasRewards = String(hasRewards);
    if (hasWarning != null) params.hasWarning = String(hasWarning);
    if (hasAdaptiveFee != null) params.hasAdaptiveFee = String(hasAdaptiveFee);
    if (isWavebreak != null) params.isWavebreak = String(isWavebreak);
    if (token) params.token = String(token);
    if (tokensBothOf) params.tokensBothOf = String(tokensBothOf);
    if (addresses) params.addresses = String(addresses);
    if (includeBlocked != null) params.includeBlocked = String(includeBlocked);
  } catch (e) { logCatchError('pools.orca', e); }
  const buildUrl = (cursor?: string) => {
    const sp = new URLSearchParams(params);
    if (cursor) sp.append('cursor', cursor);
    return `${base}?${sp.toString()}`;
  };
  let nextCursor: string | undefined;
  let ok = true; let pageCount = 0;
  const merged: any[] = [];
  const runPaged = async () => {
    while (ok && pageCount < maxPages) {
      const started = Date.now();
      const url = buildUrl(nextCursor);
      // eslint-disable-next-line no-undef
      const res = await ((globalThis as any).fetch || fetch)(url);
      const ms = Date.now() - started;
      if (res.status === 429) {
        try { emit('log', { level: 'warn', message: 'arb:429 source=orca kind=http', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch (e) { logCatchError('pools.orca', e); }
        try { httpLog429({ source: 'orca', url, cid: `http-${Date.now()}` }); } catch (e) { logCatchError('pools.orca', e); }
        ok = false; break;
      }
      if (!res.ok) {
        try {
          const txt = await res.text().catch(() => '');
          httpLogNonOk({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, bodySample: (txt || '').slice(0, 200) });
        } catch { logger.warn('orca.http non-ok', { status: res.status }); }
        ok = false; break;
      }
      const json = await res.json().catch(() => null);
      const data = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
      merged.push(...data);
      pageCount += 1;
      nextCursor = (json && typeof json === 'object') ? (json.cursor || json.nextCursor || json.next) : undefined;
      try { httpLogResponse({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, ms, count: data.length }); } catch (e) { logCatchError('pools.orca', e); }
      if (!nextCursor) break;
      if (pageCount >= maxPages) break;
    }
  };
  await runPaged();
  if (merged.length === 0) {
    const started = Date.now();
    const url = buildUrl();
    // eslint-disable-next-line no-undef
    const res = await ((globalThis as any).fetch || fetch)(url);
    const ms = Date.now() - started;
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json: any = await res.json();
    const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    try { httpLogResponse({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, ms, count: data.length }); } catch (e) { logCatchError('pools.orca', e); }
    try { await writeJson(ORCA_RAW_PATH, data); } catch (e: any) { try { logger.warn('orca.cache write failed', { file: ORCA_RAW_PATH, error: String(e?.message || e), cat: 'orca' }); } catch (e) { logCatchError('pools.orca', e); } }
    return data;
  }
  try { await writeJson(ORCA_RAW_PATH, merged); } catch (e: any) { try { logger.warn('orca.cache write failed', { file: ORCA_RAW_PATH, error: String(e?.message || e), cat: 'orca' }); } catch (e) { logCatchError('pools.orca', e); } }
  return merged;
}

export async function normalizeOrcaHttp(raw: OrcaPoolApiResponse[] | { data?: OrcaPoolApiResponse[]; pools?: OrcaPoolApiResponse[]; whirlpools?: OrcaPoolApiResponse[] } | unknown): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  let resolveMintFn: undefined | ((s: string) => Promise<{ mint: string; decimals: number }>);
  const symbolToMintCache = new Map<string, { mint?: string; decimals?: number; tried: boolean }>();
  let tokenModule: { resolveMint?: (s: string) => Promise<{ mint: string; decimals: number }> } | null = null;
  try {
    tokenModule = await import('../../utils/tokens.js');
    if (typeof tokenModule?.resolveMint === 'function') {
      resolveMintFn = tokenModule.resolveMint;
    }
  } catch (e) { logCatchError('pools.orca', e); }
  
  // Extract array from various response formats
  const rawArr: unknown[] = (() => {
    if (Array.isArray(raw)) return raw;
    const r = raw as { data?: unknown[]; pools?: unknown[]; whirlpools?: unknown[] };
    if (Array.isArray(r?.pools)) return r.pools;
    if (Array.isArray(r?.whirlpools)) return r.whirlpools;
    if (Array.isArray(r?.data)) return r.data;
    return [];
  })();
  
  // Filter to only valid Orca pools
  const arr = rawArr.filter(isValidOrcaPool);
  
  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    const tokenA = (it?.tokenA || it?.token_a || {}) as OrcaTokenInfo;
    const tokenB = (it?.tokenB || it?.token_b || {}) as OrcaTokenInfo;
    const mint_a = String(tokenA?.mint || it?.tokenMintA || it?.mintA || '');
    const mint_b = String(tokenB?.mint || it?.tokenMintB || it?.mintB || '');
    if (mint_a) allMints.add(mint_a);
    if (mint_b) allMints.add(mint_b);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true // RPC validation priority during normalization
  });
  
  for (const it of arr) {
    const pool = it as OrcaPoolApiResponse;
    const id = String(pool.address || pool.id || '');
    const tokenA = (pool.tokenA || pool.token_a || {}) as OrcaTokenInfo;
    const tokenB = (pool.tokenB || pool.token_b || {}) as OrcaTokenInfo;
    
    // Extract vault addresses early for validation
    const vaultA = String(pool.tokenVaultA ?? pool.token_vault_a ?? pool.vaultA ?? '');
    const vaultB = String(pool.tokenVaultB ?? pool.token_vault_b ?? pool.vaultB ?? '');
    
    // VALIDATION: Ensure pool ID is not a vault address
    if (id === vaultA || id === vaultB) {
      try {
        logger.warn('orca.http.pool_id_is_vault', {
          id: id.slice(0, 8) + '…',
          vaultA: vaultA.slice(0, 8) + '…',
          vaultB: vaultB.slice(0, 8) + '…',
          cat: 'orca'
        });
      } catch (e) { logCatchError('pools.orca', e); }
      continue; // Skip this pool
    }
    
    // FIXED: Orca API returns tokenMintA/tokenMintB (not mintA/mintB)
    let mint_a = String(tokenA?.mint || pool.tokenMintA || pool.mintA || '');
    let mint_b = String(tokenB?.mint || pool.tokenMintB || pool.mintB || '');
    
    // Try to resolve mints from symbols if needed
    if (!mint_a && resolveMintFn && typeof tokenA?.symbol === 'string' && tokenA.symbol.trim()) {
      const sym = tokenA.symbol.trim();
      const cached = symbolToMintCache.get(sym);
      if (!cached || !cached.tried) {
        try {
          const r = await resolveMintFn(sym);
          symbolToMintCache.set(sym, { mint: r?.mint, decimals: r?.decimals, tried: true });
        } catch {
          symbolToMintCache.set(sym, { tried: true });
        }
      }
      const got = symbolToMintCache.get(sym);
      if (got?.mint) mint_a = got.mint;
    }
    if (!mint_b && resolveMintFn && typeof tokenB?.symbol === 'string' && tokenB.symbol.trim()) {
      const sym = tokenB.symbol.trim();
      const cached = symbolToMintCache.get(sym);
      if (!cached || !cached.tried) {
        try {
          const r = await resolveMintFn(sym);
          symbolToMintCache.set(sym, { mint: r?.mint, decimals: r?.decimals, tried: true });
        } catch {
          symbolToMintCache.set(sym, { tried: true });
        }
      }
      const got = symbolToMintCache.get(sym);
      if (got?.mint) mint_b = got.mint;
    }
    
    // Get decimals from centralized resolver
    const apiDecA = Number((tokenA?.decimals ?? pool.decimalsA ?? pool.tokenDecimalsA));
    const apiDecB = Number((tokenB?.decimals ?? pool.decimalsB ?? pool.tokenDecimalsB));
    
    let decA = decimalsMap.get(mint_a) ?? apiDecA;
    let decB = decimalsMap.get(mint_b) ?? apiDecB;
    
    if (!Number.isFinite(decA)) {
      decA = symbolToMintCache.get(tokenA?.symbol?.trim())?.decimals;
    }
    if (!Number.isFinite(decB)) {
      decB = symbolToMintCache.get(tokenB?.symbol?.trim())?.decimals;
    }
    if (!Number.isFinite(decA) && mint_a) {
      const resolved = await resolveDecimalsGuaranteed(mint_a, id, 'Orca');
      decA = resolved.decimals;
      if (resolved.source === 'default' && !resolved.validated) {
        logger.warn('orca.decimals.fallback_default', {
          mint: mint_a.slice(0, 8) + '…',
          pool: id.slice(0, 8) + '…',
          defaultDecimals: decA,
          warning: 'Token decimals unknown - price may be incorrect',
          cat: 'orca'
        });
      }
    }
    if (!Number.isFinite(decB) && mint_b) {
      const resolved = await resolveDecimalsGuaranteed(mint_b, id, 'Orca');
      decB = resolved.decimals;
      if (resolved.source === 'default' && !resolved.validated) {
        logger.warn('orca.decimals.fallback_default', {
          mint: mint_b.slice(0, 8) + '…',
          pool: id.slice(0, 8) + '…',
          defaultDecimals: decB,
          warning: 'Token decimals unknown - price may be incorrect',
          cat: 'orca'
        });
      }
    }

    // Clamp to reasonable integer bounds
    decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
    decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    const fee_bps = deriveOrcaFeeBps(pool);
    const poolType = String(pool.type || pool.poolType || '').toLowerCase();
    const isWhirlpool = poolType.includes('whirlpool') || poolType.includes('concentrated') || typeof pool.tickSpacing === 'number' || typeof pool.state?.tickSpacing === 'number';
    const sqrtPriceStr = (pool.sqrtPrice ?? pool.sqrtPriceX64 ?? pool.state?.sqrtPriceX64 ?? pool.state?.sqrtPrice ?? 0);
    let sqrt_price_x64 = Number(typeof sqrtPriceStr === 'string' ? Number(sqrtPriceStr) : sqrtPriceStr || 0);
    const liquidityVal = (pool.liquidity ?? pool.state?.liquidity ?? 0);
    const liquidity = Number(typeof liquidityVal === 'string' ? Number(liquidityVal) : liquidityVal || 0);
    const liquidityRaw = anyToBigInt(liquidityVal);
    const tick_spacing = Number((pool.tickSpacing ?? pool.state?.tickSpacing) || 0);
    const amtAraw = (pool.tokenBalanceA ?? pool.tokenAAmount ?? pool.token_a_amount ?? pool.amountA ?? pool.baseAmount ?? 0);
    const amtBraw = (pool.tokenBalanceB ?? pool.tokenBAmount ?? pool.token_b_amount ?? pool.amountB ?? pool.quoteAmount ?? 0);
    let amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    let amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    let amount_a_atomic = anyToBigInt(amtAraw);
    let amount_b_atomic = anyToBigInt(amtBraw);
    
    if (isWhirlpool && id) {
      const processedPrice = processPriceThroughPipeline({
        mintA: mint_a,
        mintB: mint_b,
        decimalsA: decA,
        decimalsB: decB,
        poolId: id,
        dex: 'Orca',
        poolType: 'clmm',
        sqrtPriceX64: anyToBigInt(sqrtPriceStr),
        reserveA: amount_a > 0 ? amount_a : undefined,
        reserveB: amount_b > 0 ? amount_b : undefined,
      });

      if (!processedPrice) {
        continue;
      }

      const {
        mintA: finalMintA,
        mintB: finalMintB,
        priceForward,
        wasSwapped,
        decimalsA: finalDecA,
        decimalsB: finalDecB,
      } = processedPrice;

      if (wasSwapped) {
        [amount_a, amount_b] = [amount_b, amount_a];
        [amount_a_atomic, amount_b_atomic] = [amount_b_atomic, amount_a_atomic];
      }
      
      const wholeA = Number.isFinite(finalDecA) ? (amount_a / Math.pow(10, finalDecA as number)) : undefined;
      const wholeB = Number.isFinite(finalDecB) ? (amount_b / Math.pow(10, finalDecB as number)) : undefined;
      const tvlUsdcRaw = pool.tvlUsdc ?? pool.tvlUsd;
      const tvlUsdcNum = typeof tvlUsdcRaw === 'string' ? Number(tvlUsdcRaw) : (typeof tvlUsdcRaw === 'number' ? tvlUsdcRaw : 0);
      const tvl_usd = Number.isFinite(tvlUsdcNum) && tvlUsdcNum > 0 ? tvlUsdcNum : undefined;
      const pool_liquidity_raw = (tvl_usd != null)
        ? tvl_usd
        : (Number.isFinite(wholeA as any) && Number.isFinite(wholeB as any)) ? Math.min(wholeA as number, wholeB as number) : undefined;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : undefined;
      
      let oracle: string | undefined;
      let token_vault_a: string | undefined;
      let token_vault_b: string | undefined;
      let account_a: string | undefined;
      let account_b: string | undefined;
      try {
        // Extract oracle if present in API response
        const oracleFromApi = String(pool.oracle ?? '');
        if (oracleFromApi && oracleFromApi !== '11111111111111111111111111111111') {
          oracle = oracleFromApi;
        } else {
          // Derive oracle PDA: [b"oracle", whirlpool.key()]
          try {
            const { PublicKey } = await import('@solana/web3.js');
            const poolPk = new PublicKey(id);
            const programId = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
            const [oraclePda] = PublicKey.findProgramAddressSync(
              [Buffer.from('oracle'), poolPk.toBuffer()],
              programId
            );
            oracle = oraclePda.toBase58();
          } catch (e) { logCatchError('pools.orca', e); }
        }
        
        // Extract vault accounts from API response
        const vaultA = String((it as any)?.tokenVaultA ?? (it as any)?.token_vault_a ?? (it as any)?.vaultA ?? '');
        const vaultB = String((it as any)?.tokenVaultB ?? (it as any)?.token_vault_b ?? (it as any)?.vaultB ?? '');
        if (vaultA && vaultA !== '11111111111111111111111111111111') {
          token_vault_a = vaultA;
          account_a = vaultA;  // Use vault as account_a
        }
        if (vaultB && vaultB !== '11111111111111111111111111111111') {
          token_vault_b = vaultB;
          account_b = vaultB;  // Use vault as account_b
        }
      } catch (e: any) {
        try {
          logger.debug('orca.exec_accounts.extraction.failed', {
            cat: 'orca',
            ctx: { pool: id, error: String(e?.message || e) }
          });
        } catch (e) { logCatchError('pools.orca', e); }
      }

      const finalAccountA = wasSwapped ? account_b : account_a;
      const finalAccountB = wasSwapped ? account_a : account_b;
      const finalTokenVaultA = wasSwapped ? token_vault_b : token_vault_a;
      const finalTokenVaultB = wasSwapped ? token_vault_a : token_vault_b;

      clmm.push({
        id,
        dex: 'Orca',
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps,
        sqrt_price_x64,
        sqrt_price_x64_raw: anyToBigInt(sqrtPriceStr)?.toString(),
        liquidity,
        liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
        tick_spacing,
        updated_ms: now,
        price_a_per_b: priceForward,
        amount_a,
        amount_b,
        decimals_a: finalDecA,
        decimals_b: finalDecB,
        account_a: finalAccountA,
        account_b: finalAccountB,
        pool_kind: 'clmm',
        pool_liquidity_raw,
        tvl_usd,
        liquidity_display,
        oracle,
        token_vault_a: finalTokenVaultA,
        token_vault_b: finalTokenVaultB,
        was_swapped: wasSwapped,
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: account_a,
        native_account_b: account_b,
        native_reserve_a_raw: amount_a_atomic?.toString(),
        native_reserve_b_raw: amount_b_atomic?.toString(),
        _pipelineProcessed: true,
      } as any);
    }
  }

  // No need for manual canonicalization or verification, pipeline handles it.
  
  try {
    const canon = String(((CONFIG as any)?.system?.canonicalizePairs) || 'lex');
    logger.info('orca.http normalized', { clmm: clmm.length, cat: 'orca', canon });
  } catch (e) { logCatchError('pools.orca', e); }
  
  // OPTIMIZATION: Pre-cache Orca pool states to eliminate RPC calls during transaction building
  await populateOrcaPoolStates(clmm);
  
  return { amm: [], clmm: clmm, cpmm: [] };
}

/**
 * Pre-populate execution cache with Orca Whirlpool CLMM states
 * This eliminates 100-300ms RPC calls per Orca swap during transaction building
 * Similar to populateMeteoraActiveIds but for Orca pools
 */
async function populateOrcaPoolStates(pools: ClmmPool[]): Promise<void> {
  if (!pools || pools.length === 0) return;
  
  try {
    const { executionCache } = await import('../../execution/cache.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const { PublicKey } = await import('@solana/web3.js');
    
    // Load new client decoder (v4.0)
    let newClientDecoder: any = null;
    try {
      const newClient = await import('@orca-so/whirlpools-client').catch(() => null);
      if (newClient && typeof (newClient as any).getWhirlpoolDecoder === 'function') {
        newClientDecoder = (newClient as any).getWhirlpoolDecoder();
      }
    } catch {}
    
    // Load legacy SDK as fallback
    const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
    const ParsableWhirlpool = sdkAny?.ParsableWhirlpool;
    const PriceMath = sdkAny?.PriceMath;
    let BN = sdkAny?.BN;
    if (!BN) {
      try { BN = (await import('bn.js')).default; } catch (e) { logCatchError('pools.orca', e); }
    }
    const connection = getConnection();
    
    const startTime = Date.now();
    let cached = 0;
    let failed = 0;
    
    const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    
    // Batch fetch pool states (100 at a time to respect RPC limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < pools.length; i += BATCH_SIZE) {
      const batch = pools.slice(i, i + BATCH_SIZE);
      const pubkeys = batch.map(p => {
        try {
          const id = p.id.replace(/[#-]rev$/, ''); // Strip -rev or #rev suffix
          return new PublicKey(id);
        } catch {
          return null;
        }
      }).filter((pk): pk is InstanceType<typeof PublicKey> => pk !== null);
      
      if (pubkeys.length === 0) continue;
      
      try {
        // Fetch multiple pool accounts in one RPC call
        const accounts = await withRpcLimit(() => connection.getMultipleAccountsInfo(pubkeys));
        
        if (accounts.length !== pubkeys.length) {
          try {
            logger.warn('orca.poolState.batch_length_mismatch', {
              cat: 'orca',
              ctx: {
                batchStart: i,
                batchSize: batch.length,
                pubkeysLength: pubkeys.length,
                accountsLength: accounts.length,
                expected: pubkeys.length
              }
            });
          } catch (e) { logCatchError('pools.orca', e); }
        }
        
        for (let j = 0; j < Math.min(accounts.length, batch.length); j++) {
          const pool = batch[j];
          const acc = accounts[j];
          
          if (!acc) {
            failed++;
            try {
              logger.info('orca.poolState.account_not_found', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  poolId: pool.id,
                  strippedId: pool.id.replace(/[#-]rev$/, ''),
                  hint: 'pool missing on-chain'
                }
              });
            } catch (e) { logCatchError('pools.orca', e); }
            continue;
          }
          
          if (!acc.data) {
            failed++;
            try {
              logger.info('orca.poolState.account_no_data', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  poolId: pool.id,
                  accountOwner: acc.owner?.toBase58?.() || 'unknown',
                  accountLamports: acc.lamports || 0
                }
              });
            } catch (e) { logCatchError('pools.orca', e); }
            continue;
          }
          
          try {
            const poolPk = pubkeys[j];
            const buffer = Buffer.from(acc.data);
            const SQRT_PRICE_OFFSET = 65;
            const TICK_OFFSET = 101;
            const LIQUIDITY_OFFSET = 181;
            const FEE_RATE_OFFSET = 205;
            
            let sqrtPriceX64: bigint | undefined;
            let tickIndex: number | undefined;
            let liquidity: bigint | undefined;
            let feeRateBps: number | undefined;
            
            let parsed: any = null;
            
            // PRIORITY 1: New @orca-so/whirlpools-client (v4.0)
            if (newClientDecoder) {
              try {
                const dataBuffer = buffer instanceof Buffer ? new Uint8Array(buffer) : buffer;
                const decoded = newClientDecoder.decode(dataBuffer);
                if (decoded && decoded.sqrtPrice !== undefined) {
                  parsed = decoded;
                }
              } catch {}
            }
            
            // PRIORITY 2: Legacy @orca-so/whirlpools-sdk (v0.16)
            if (!parsed && ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
              try { parsed = ParsableWhirlpool.parse(poolPk, acc); } catch (e) { logCatchError('pools.orca', e); }
            }
            
            if (parsed) {
              sqrtPriceX64 = BigInt(parsed.sqrtPrice?.toString?.() || '0');
              tickIndex = Number(parsed.tickCurrentIndex);
              liquidity = BigInt(parsed.liquidity?.toString?.() || '0');
            } else {
              const sqrtLow = buffer.readBigUInt64LE(SQRT_PRICE_OFFSET);
              const sqrtHigh = buffer.readBigUInt64LE(SQRT_PRICE_OFFSET + 8);
              sqrtPriceX64 = sqrtLow + (sqrtHigh << 64n);
              tickIndex = buffer.readInt32LE(TICK_OFFSET);
              const liqLow = buffer.readBigUInt64LE(LIQUIDITY_OFFSET);
              const liqHigh = buffer.readBigUInt64LE(LIQUIDITY_OFFSET + 8);
              liquidity = liqLow + (liqHigh << 64n);
            }
            
            const feeRateRaw = buffer.length >= FEE_RATE_OFFSET + 2 ? buffer.readUInt16LE(FEE_RATE_OFFSET) : undefined;
            if (feeRateRaw != null) {
              feeRateBps = Math.round(feeRateRaw / 100);
            }
            
            // Derive and validate tick arrays
            const tickSpacing = (pool as any).tick_spacing;
            let validatedTickArrays: { center?: string; lower?: string[]; upper?: string[] } | undefined;
            
            if (tickIndex !== undefined && tickSpacing && tickSpacing > 0) {
              try {
                const TICK_ARRAY_SIZE = 88;
                const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
                const centerIdx = Math.floor(tickIndex / ticksInArray);
                const RANGE = 3; // Check ±3 tick arrays
                
                // Derive tick array PDAs
                const tickArrayPdas: Array<{ offset: number; pda: InstanceType<typeof PublicKey>; startTick: number }> = [];
                for (let offset = -RANGE; offset <= RANGE; offset++) {
                  const startTick = (centerIdx + offset) * ticksInArray;
                  // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
                  const [pda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('tick_array'), poolPk.toBuffer(), Buffer.from(startTick.toString())],
                    WHIRLPOOL_PROGRAM_ID
                  );
                  tickArrayPdas.push({ offset, pda, startTick });
                }
                
                // Batch check existence
                const pdaKeys = tickArrayPdas.map(p => p.pda);
                const tickArrayInfos = await withRpcLimit(() => connection.getMultipleAccountsInfo(pdaKeys));
                
                const lower: string[] = [];
                let center: string | undefined;
                const upper: string[] = [];
                
                for (let k = 0; k < tickArrayPdas.length; k++) {
                  const info = tickArrayInfos[k];
                  if (info && info.owner.equals(WHIRLPOOL_PROGRAM_ID) && info.data.length > 0) {
                    const { offset, pda } = tickArrayPdas[k];
                    const addr = pda.toBase58();
                    if (offset === 0) {
                      center = addr;
                    } else if (offset < 0) {
                      lower.push(addr);
                    } else {
                      upper.push(addr);
                    }
                  }
                }
                
                if (center) {
                  validatedTickArrays = { center, lower, upper };
                }
              } catch (e) {
                logCatchError('pools.orca.tickArrayValidation', e);
              }
            }
            
            // Include tickSpacing and dex for boundary crossing detection in cache
            executionCache.setHot(pool.id, {
              dex: 'orca',
              sqrtPriceX64,
              currentTickIndex: tickIndex,
              tickSpacing,
              liquidity,
              feeRate: feeRateBps,
              // Store validated tick arrays
              tickArrays: validatedTickArrays ? {
                center: validatedTickArrays.center,
                lower: validatedTickArrays.lower,
                upper: validatedTickArrays.upper,
              } : undefined
            });
            
            // CRITICAL: Also populate static cache for local quotes to work
            // Local quote needs mint_a, mint_b to determine swap direction
            executionCache.setStatic(pool.id, {
              programId: WHIRLPOOL_PROGRAM_ID.toBase58(),
              mint_a: (pool as any).mint_a,
              mint_b: (pool as any).mint_b,
              decimals_a: (pool as any).decimals_a,
              decimals_b: (pool as any).decimals_b,
              native_mint_a: (pool as any).native_mint_a,
              native_mint_b: (pool as any).native_mint_b,
              tickSpacing: (pool as any).tick_spacing,
              dex: 'orca',
              pool_kind: 'clmm',
            });
            
            cached++;
            
            // Enrich normalized pool in-place so downstream graph/builders have prices
            if (sqrtPriceX64) {
              (pool as any).sqrt_price_x64_raw = sqrtPriceX64.toString();
            }
            if (Number.isFinite(tickIndex)) {
              // CRITICAL FIX: Negate tick index if pool was swapped during canonicalization
              // The on-chain tick index is always in native orientation (tokenMintA/tokenMintB)
              // When mints are swapped, the tick index must be negated to match the canonical orientation
              const wasSwapped = (pool as any).was_swapped === true;
              (pool as any).tick_current_index = wasSwapped ? -tickIndex : tickIndex;
            }
            if (liquidity) {
              (pool as any).liquidity_raw = liquidity.toString();
              (pool as any).liquidity = Number(liquidity.toString());
            }
            
            // Calculate derived price from sqrt using CURRENT mint decimals (post-canonicalization)
            // CRITICAL: Use resolveDecimals based on current mints, not pool.decimals_a/b
            // The pool might have been canonicalized, swapping mints but the decimals in cache might be stale
            
            // BUGFIX: Don't recalculate price if it was already set during normalization + canonicalization
            // The on-chain sqrtPriceX64 is orientation-specific and doesn't automatically adjust
            // when mints are swapped by canonicalization. Recalculating with swapped mints but
            // original sqrt produces wrong prices (magnitude errors of 10^(2*decimal_diff))
            const hasExistingPrice = (pool as any).price_a_per_b && (pool as any).price_a_per_b > 0;
            
            let derivedPrice: number | undefined;
            if (!hasExistingPrice) {
              // Only calculate price if not already set (shouldn't happen in normal flow)
              const mintA = String((pool as any).mint_a);
              const mintB = String((pool as any).mint_b);
              
              // Fetch decimals for CURRENT mints (respects canonicalization)
              const { resolveDecimals } = await import('./decimals.js');
              const decA = await resolveDecimals(mintA) ?? Number((pool as any).decimals_a);
              const decB = await resolveDecimals(mintB) ?? Number((pool as any).decimals_b);

              // FIX: If pool was swapped during canonicalization, decA is actually Token1's decimals
              // and decB is Token0's decimals. PriceMath expects (sqrt, dec0, dec1).
              // We must swap them back to match the raw sqrtPriceX64 orientation.
              const [dec0, dec1] = (pool as any).was_swapped ? [decB, decA] : [decA, decB];

              if (
                PriceMath &&
                BN &&
                sqrtPriceX64 &&
                Number.isFinite(decA) &&
                Number.isFinite(decB)
              ) {
                try {
                  const sqrtForSdk =
                    parsed?.sqrtPrice && BN.isBN(parsed.sqrtPrice)
                      ? parsed.sqrtPrice
                      : new BN(sqrtPriceX64.toString());
                  const priceDec = PriceMath.sqrtPriceX64ToPrice(sqrtForSdk, dec0, dec1);
                  const priceNum =
                    typeof priceDec?.toNumber === 'function'
                      ? priceDec.toNumber()
                      : Number(priceDec?.toString?.() ?? priceDec);
                  if (Number.isFinite(priceNum) && priceNum > 0) {
                    derivedPrice = priceNum;
                  }
                } catch (e) { logCatchError('pools.orca', e); }
              }
              
              if (!derivedPrice && PriceMath && BN && Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(tickIndex)) {
                try {
                  const priceDec = PriceMath.priceFromTick(Number(tickIndex), dec0, dec1);
                  const priceNum =
                    typeof priceDec?.toNumber === 'function'
                      ? priceDec.toNumber()
                      : Number(priceDec?.toString?.() ?? priceDec);
                  if (Number.isFinite(priceNum) && priceNum > 0) {
                    derivedPrice = priceNum;
                  }
                } catch (e) { logCatchError('pools.orca', e); }
              }
              
              if (derivedPrice && derivedPrice > 0) {
                (pool as any).price_a_per_b = derivedPrice;
                (pool as any).price_a_per_b_exact = derivedPrice.toString();
              }
            } else {
              // Preserve existing price from canonicalization
              derivedPrice = (pool as any).price_a_per_b;
            }
            
            try {
              logger.info('orca.poolState.cached', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  sqrtPriceX64: sqrtPriceX64?.toString(),
                  currentTickIndex: tickIndex,
                  liquidity: liquidity?.toString(),
                  feeRate: feeRateBps,
                  price: derivedPrice,
                  price_source: hasExistingPrice ? 'preserved_from_normalization' : 'recalculated_from_onchain',
                  tickArrays: validatedTickArrays ? {
                    hasCenter: !!validatedTickArrays.center,
                    lowerCount: validatedTickArrays.lower?.length || 0,
                    upperCount: validatedTickArrays.upper?.length || 0
                  } : 'none'
                }
              });
            } catch (e) { logCatchError('pools.orca', e); }
          } catch (readErr) {
            failed++;
            try {
              logger.warn('orca.poolState.read_failed', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  error: String((readErr as any)?.message || readErr)
                }
              });
            } catch (e) { logCatchError('pools.orca', e); }
          }
        }
      } catch (batchErr) {
        failed += batch.length;
        try {
          logger.error('orca.poolState.batch_failed', {
            cat: 'orca',
            ctx: {
              batchStart: i,
              batchSize: batch.length,
              error: String((batchErr as any)?.message || batchErr)
            }
          });
        } catch (e) { logCatchError('pools.orca', e); }
      }
    }
    
    const durationMs = Date.now() - startTime;
    const avgMs = pools.length > 0 ? Math.round(durationMs / pools.length) : 0;
    
    try {
      logger.info('orca.poolState.cache_populated', {
        cat: 'orca',
        ctx: {
          total: pools.length,
          cached,
          failed,
          durationMs,
          avgMs
        }
      });
    } catch (e) { logCatchError('pools.orca', e); }
  } catch (err) {
    try {
      logger.error('orca.poolState.cache_error', {
        cat: 'orca',
        ctx: {
          error: String((err as any)?.message || err),
          stack: (err as any)?.stack
        }
      });
    } catch (e) { logCatchError('pools.orca', e); }
  }
}


