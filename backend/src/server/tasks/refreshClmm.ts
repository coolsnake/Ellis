import { Connection, PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { logger } from '../../utils/logger.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../../execution/raydiumTickArrays.js';
import { getClmmStatic, setClmmStatic, saveClmmCacheToDisk } from '../../execution/clmmCache.js';

async function decodeClmmState(connection: Connection, poolPk: PublicKey): Promise<{ programId: PublicKey; oracle: PublicKey | null; vaultA: PublicKey | null; vaultB: PublicKey | null; tickCurrent: number; tickSpacing: number } | null> {
  const acc = await connection.getAccountInfo(poolPk);
  if (!acc?.data?.length) { try { logger.warn('clmm.decode.no_account', { pool: poolPk.toBase58?.() || String(poolPk) }); } catch {}; return null; }
  const programId = acc.owner;
  try {
    let sdk: any = await import('@raydium-io/raydium-sdk-v2').catch((e: any) => { try { logger.warn('clmm.decode.sdk_import_fail', { pool: poolPk.toBase58?.(), error: String(e?.message || e) }); } catch {}; return null; });
    if (!sdk) {
      // Fallback: attempt CommonJS require
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m: any = await import('node:module');
        const createRequire: any = (m && (m as any).createRequire) || ((m as any)?.default && (m as any).default.createRequire);
        const req: any = createRequire ? createRequire(import.meta.url) : null;
        if (req) {
          try { sdk = req('@raydium-io/raydium-sdk-v2'); try { logger.info('clmm.decode.require.ok', { pool: poolPk.toBase58?.() }); } catch {} } catch (re: any) { try { logger.warn('clmm.decode.require_fail', { pool: poolPk.toBase58?.(), error: String(re?.message || re) }); } catch {} }
        }
      } catch {}
    }
    if (!sdk) return null;
    const layout = (sdk as any)?.Clmm?.PoolStateLayout || (sdk as any)?.CLMM?.POOL_STATE_LAYOUT || (sdk as any)?.PoolStateLayout || (sdk as any)?.CLMM?.PoolStateLayout || (sdk as any)?.Clmm?.POOL_STATE_LAYOUT;
    if (!layout?.decode) { try { logger.warn('clmm.decode.layout_missing', { pool: poolPk.toBase58?.(), keys: Object.keys(sdk || {}) }); } catch {}; return null; }
    let state: any = null;
    try { state = layout.decode(acc.data); } catch (e: any) { try { logger.warn('clmm.decode.fail', { pool: poolPk.toBase58?.(), error: String(e?.message || e) }); } catch {}; return null; }
    const asPk = (v: any): PublicKey | null => {
      try {
        if (!v) return null;
        if (v instanceof PublicKey) return v;
        if (typeof v?.toBase58 === 'function') return v as PublicKey;
        return new PublicKey(v);
      } catch {
        return null;
      }
    };
    const oracle = asPk((state as any).oracle);
    const vaultA = asPk((state as any).vaultA || (state as any).tokenVaultA || (state as any).baseVault);
    const vaultB = asPk((state as any).vaultB || (state as any).tokenVaultB || (state as any).quoteVault);
    const tickCurrent = Number((state as any).tickCurrent ?? (state as any).tick_current ?? 0);
    const tickSpacing = Number((state as any).tickSpacing ?? (state as any).tick_spacing ?? 1);
    try { logger.info('clmm.decode.ok', { pool: poolPk.toBase58?.(), owner: programId?.toBase58?.(), tickCurrent, tickSpacing, oracle: oracle?.toBase58?.(), vA: vaultA?.toBase58?.(), vB: vaultB?.toBase58?.() }); } catch {}
    return { programId, oracle, vaultA, vaultB, tickCurrent, tickSpacing };
  } catch {
    return null;
  }
}

async function accountExists(connection: Connection, owner: PublicKey, addr: PublicKey | null): Promise<boolean> {
  if (!addr) return false;
  try {
    const info = await connection.getAccountInfo(addr);
    return !!(info && info.owner && info.owner.equals(owner));
  } catch {
    return false;
  }
}

export async function refreshRaydiumClmm(poolIdStr: string): Promise<void> {
  const connection = getConnection();
  const poolPk = new PublicKey(poolIdStr);
  try { logger.info('clmm.refresh.start', { pool: poolIdStr }); } catch {}
  const decoded = await decodeClmmState(connection, poolPk);
  if (!decoded) { try { logger.warn('clmm.refresh.decode_nil', { pool: poolIdStr }); } catch {}; return; }

  const { programId, oracle, vaultA, vaultB, tickCurrent, tickSpacing } = decoded;

  const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
  const delta = 60 * Math.max(1, tickSpacing);
  const lowerStart = centerStart - delta;
  const upperStart = centerStart + delta;

  let lowerPk: PublicKey | null = null;
  let centerPk: PublicKey | null = null;
  let upperPk: PublicKey | null = null;
  try { lowerPk = await deriveTickArrayPda(programId, poolPk, lowerStart); } catch {}
  try { centerPk = await deriveTickArrayPda(programId, poolPk, centerStart); } catch {}
  try { upperPk = await deriveTickArrayPda(programId, poolPk, upperStart); } catch {}
  try { logger.info('clmm.refresh.bounds', { pool: poolIdStr, centerStart, lowerStart, upperStart, owner: programId.toBase58?.() }); } catch {}

  // Validate existence; step outward once if missing
  if (!(await accountExists(connection, programId, lowerPk))) {
    try {
      const alt = await deriveTickArrayPda(programId, poolPk, lowerStart - delta);
      if (await accountExists(connection, programId, alt)) lowerPk = alt;
    } catch {}
  }
  if (!(await accountExists(connection, programId, upperPk))) {
    try {
      const alt = await deriveTickArrayPda(programId, poolPk, upperStart + delta);
      if (await accountExists(connection, programId, alt)) upperPk = alt;
    } catch {}
  }
  try { logger.info('clmm.refresh.arrays', { pool: poolIdStr, lower: lowerPk?.toBase58?.(), center: centerPk?.toBase58?.(), upper: upperPk?.toBase58?.() }); } catch {}

  const staticInfo = {
    programId: programId.toBase58(),
    tickSpacing,
    oracle: oracle ? oracle.toBase58() : '',
    vaultA: vaultA ? vaultA.toBase58() : '',
    vaultB: vaultB ? vaultB.toBase58() : '',
    tickArrays: {
      lower: lowerPk ? lowerPk.toBase58() : '',
      center: centerPk ? centerPk.toBase58() : '',
      upper: upperPk ? upperPk.toBase58() : '',
    },
    lastUpdateMs: Date.now(),
  };
  setClmmStatic(poolIdStr, staticInfo);
  try { await saveClmmCacheToDisk(); } catch {}
  try { logger.info('clmm.cache.update', { pool: poolIdStr }); } catch {}
}

export function startClmmRefreshLoop(getTargetPools: () => string[], intervalMs = 10000): NodeJS.Timeout {
  return setInterval(async () => {
    const pools = getTargetPools();
    await Promise.allSettled(pools.map((p) => refreshRaydiumClmm(p)));
  }, intervalMs);
}


