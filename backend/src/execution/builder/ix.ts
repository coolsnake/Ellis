import type { DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';

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
    const { Percentage } = await import('@orca-so/common-sdk');
    const dummyWallet: any = { publicKey: kp.publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any[]) => txs };
    const programId = new PublicKey(hop.programId || (CONFIG.orca?.programId as any));
    const ctx = (WhirlpoolContext as any).from(connection as any, dummyWallet, programId);
    const client = (buildWhirlpoolClient as any)(ctx);
    const poolPk = new PublicKey(hop.poolId);
    const pool = await client.getPool(poolPk);
    const inputMint = new PublicKey(hop.inputMint);
    const slippage = (() => {
      try {
        if (hop.amountInRaw > 0n && hop.minOutRaw > 0n) {
          const bps = Math.max(0, Math.min(9900, Math.round((1 - (Number(hop.minOutRaw) / Math.max(1, Number(hop.amountInRaw)) )) * 10000)));
          return (Percentage as any).fromFraction(bps, 10000);
        }
      } catch {}
      return (Percentage as any).fromFraction(1, 100); // 1%
    })();
    const quote = await (swapQuoteByInputToken as any)(pool, inputMint, hop.amountInRaw, slippage, ctx.program.programId, ctx.fetcher, true);
    const params = (SwapUtils as any).getSwapParamsFromQuote(quote);
    const txb = await pool.swap(params);
    const tx = (toTx as any)(ctx, txb);
    const built = await tx.build();
    return built.instructions || [];
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
  try {
    // Attempt dynamic import of a DLMM SDK if available; otherwise construct minimal raw ix descriptor
    const maybe: any = await (async () => { try { return await (Function('return import')())('@meteora-ag/dlmm-sdk'); } catch { return null; } })();
    if (maybe && maybe?.DLMM && maybe?.DLMM?.swapIx) {
      const connection = getConnection();
      const kp = await ensureWallet(CONFIG.walletPath);
      const poolPk = new PublicKey(hop.poolId);
      const programId = new PublicKey(hop.programId as string);
      const params = {
        pool: poolPk,
        programId,
        userSourceAta: new PublicKey(hop.userSourceAta),
        userDestAta: new PublicKey(hop.userDestAta),
        amountIn: hop.amountInRaw,
        minOut: hop.minOutRaw,
        // Optional: bin arrays if required
        binArrayLower: hop.binArrayLower ? new PublicKey(hop.binArrayLower) : undefined,
        binArrayUpper: hop.binArrayUpper ? new PublicKey(hop.binArrayUpper) : undefined,
      } as any;
      const ix = await maybe.DLMM.swapIx(connection, kp.publicKey, params);
      if (ix) return [ix];
    }
  } catch (e) {
    try { logger.warn('ix.build meteora.dlmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  return buildMeteoraDlmmSwapIx(hop);
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
    // Dynamic import to avoid hard crashes on API mismatch
    const sdk: any = await import('@raydium-io/raydium-sdk-v2');
    // Expected helpers may differ by version; attempt common paths
    const connection = getConnection();
    const kp = await ensureWallet(CONFIG.walletPath);
    const wallet = { publicKey: kp.publicKey } as any;
    const poolId = new PublicKey(hop.poolId);
    const programId = new PublicKey(hop.programId || (CONFIG.raydium?.clmmProgram as any));
    // Heuristic slippage from minOut
    const bps = (() => {
      try { if (hop.amountInRaw > 0n && hop.minOutRaw > 0n) { const r = Number(hop.minOutRaw) / Math.max(1, Number(hop.amountInRaw)); return Math.max(0, Math.min(9900, Math.round((1 - r) * 10000))); } } catch {}
      return 100; // 1%
    })();
    if (sdk?.Clmm && sdk?.Clmm?.makeSwapInstructionSimple) {
      const res = await sdk.Clmm.makeSwapInstructionSimple({
        connection,
        poolInfo: { id: poolId } as any,
        owner: wallet,
        inputMint: new PublicKey(hop.inputMint),
        amountIn: hop.amountInRaw,
        amountOutMin: hop.minOutRaw,
        slippage: bps,
        programId,
      });
      const ixs = Array.isArray(res?.instructions) ? res.instructions : (res?.innerTransaction ? res.innerTransaction.instructions : []);
      if (ixs && ixs.length) return ixs as any[];
    }
  } catch (e) {
    try { logger.warn('ix.build raydium.clmm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  return buildRaydiumClmmSwapIx(hop);
}

export async function buildRaydiumAmmSwapIxReal(hop: DirectHop): Promise<any[]> {
  try { logger.debug('ix.build raydium.amm.real', { pool: hop.poolId, cat: 'tx', code: LogCode.TX_BUILD_HOP }); } catch {}
  try {
    const sdk: any = await import('@raydium-io/raydium-sdk-v2');
    const connection = getConnection();
    const kp = await ensureWallet(CONFIG.walletPath);
    const wallet = { publicKey: kp.publicKey } as any;
    const poolId = new PublicKey(hop.poolId);
    const programId = new PublicKey(hop.programId || (CONFIG.raydium?.ammV4Program as any));
    const bps = (() => {
      try { if (hop.amountInRaw > 0n && hop.minOutRaw > 0n) { const r = Number(hop.minOutRaw) / Math.max(1, Number(hop.amountInRaw)); return Math.max(0, Math.min(9900, Math.round((1 - r) * 10000))); } } catch {}
      return 100;
    })();
    if (sdk?.AmmV4 && sdk?.AmmV4?.makeSwapInstructionSimple) {
      const res = await sdk.AmmV4.makeSwapInstructionSimple({
        connection,
        poolInfo: { id: poolId } as any,
        owner: wallet,
        inputMint: new PublicKey(hop.inputMint),
        amountIn: hop.amountInRaw,
        amountOutMin: hop.minOutRaw,
        slippage: bps,
        programId,
      });
      const ixs = Array.isArray(res?.instructions) ? res.instructions : (res?.innerTransaction ? res.innerTransaction.instructions : []);
      if (ixs && ixs.length) return ixs as any[];
    }
  } catch (e) {
    try { logger.warn('ix.build raydium.amm.real fallback', { error: String((e as any)?.message || e), cat: 'tx', code: LogCode.TX_BUILD_ERR }); } catch {}
  }
  return buildRaydiumAmmSwapIx(hop);
}


