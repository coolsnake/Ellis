import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';

export async function resolveRaydiumClmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  try {
    const id = hop.poolId.replace(/-rev$/, '');
    const pools = peekRaydiumPools();
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
      hop.oracle = String((p as any)?.oracle || '');
      // Placeholder: actual tick array PDAs should be derived; we use pool id hints for now
      hop.tickArrayLower = String((p as any)?.tick_array_lower || '');
      hop.tickArrayCenter = String((p as any)?.tick_array_center || '');
      hop.tickArrayUpper = String((p as any)?.tick_array_upper || '');
      hop.vaultA = String((p as any)?.account_a || '');
      hop.vaultB = String((p as any)?.account_b || '');
    }
    // Best-effort on-chain derivation of missing CLMM accounts (oracle, tick arrays)
    // Only attempt when any of these are missing to avoid unnecessary RPC
    if (!hop.oracle || !hop.tickArrayLower || !hop.tickArrayUpper) {
      try {
        const web3: any = await import('@solana/web3.js');
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const { getConnection } = await import('../../wallet/wallet.js');
        const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
        const conn = getConnection();
        const poolPk = new web3.PublicKey(id);
        const acc = await withRpcLimit(() => conn.getAccountInfo(poolPk));
        try {
          // Prefer on-chain account owner as authoritative program id
          if (acc?.owner && typeof (acc.owner as any).toBase58 === 'function') {
            const ownerPid = (acc.owner as any).toBase58();
            if (ownerPid && (!hop.programId || hop.programId !== ownerPid)) hop.programId = ownerPid;
          }
        } catch {}
        if (acc?.data?.length) {
          const layout = (rmod as any)?.Clmm?.PoolStateLayout || (rmod as any)?.CLMM?.POOL_STATE_LAYOUT || (rmod as any)?.PoolStateLayout;
          const state = layout && typeof layout.decode === 'function' ? layout.decode(acc.data) : null;
          if (state) {
            // resolve program id once for PDA derivations
            let programId: any;
            try { programId = new web3.PublicKey(hop.programId); } catch {
              try { const { CONFIG } = await import('../../utils/config.js'); programId = new web3.PublicKey(String((CONFIG as any)?.raydium?.clmmProgram || '')); } catch {}
            }
            if (!programId) { try { programId = new web3.PublicKey('CAMMCzo5nKXjotvLkGQ6r1N1C8QXr8iY6pYwWf3V8mGk'); } catch {} }
            // populate oracle if present in state; else derive via SDK/PDA
            try {
              const o = (state as any).oracle?.toBase58?.() || String((state as any).oracle || '');
              if (o && !hop.oracle) hop.oracle = o;
            } catch {}
            if (!hop.oracle) {
              try {
                const util = (rmod as any)?.Clmm || (rmod as any)?.CLMM;
                const getOracle = util?.getOracleAddress || util?.oraclePda || util?.getPdaOracle;
                if (typeof getOracle === 'function') {
                  const res = await getOracle({ programId, poolId: poolPk });
                  const pk = (res && (res.publicKey || res)) || null;
                  if (pk) hop.oracle = pk.toBase58?.() || String(pk);
                }
              } catch {}
            }
            if (!hop.oracle) {
              try {
                const [oPk] = (web3.PublicKey as any).findProgramAddressSync([
                  Buffer.from('oracle'),
                  poolPk.toBuffer(),
                ], programId);
                if (oPk) hop.oracle = oPk.toBase58?.() || String(oPk);
              } catch {}
            }
            // Derive tick arrays using Raydium SDK compute info and bitmaps (TICK_ARRAY_SIZE = 60)
            try {
              const sdk: any = await import('@raydium-io/raydium-sdk-v2');
              const { Raydium, PoolUtils } = sdk as any;
              const TickUtils = (sdk as any)?.TickUtils || (sdk as any)?.CLMM?.TickUtils || (sdk as any)?.Clmm?.TickUtils;
              const getPdaTickArrayAddress = (sdk as any)?.getPdaTickArrayAddress || (sdk as any)?.CLMM?.getPdaTickArrayAddress || (sdk as any)?.Clmm?.getPdaTickArrayAddress;
              const { getConnection } = await import('../../wallet/wallet.js');
              const rconn = getConnection();
              const ray = await Raydium.load({ connection: rconn, disableFeatureCheck: true, disableLoadToken: true });
              const apiRes = await (ray as any).api.fetchPoolById({ ids: id }).catch(() => null as any);
              const poolInfo = Array.isArray(apiRes?.data) ? apiRes.data.find((x: any) => String(x?.id || '') === id) : (Array.isArray(apiRes) ? apiRes[0] : null);
              if (poolInfo) {
                const comp = await (PoolUtils as any).fetchComputeClmmInfo({ connection: ray.connection, poolInfo });
                const tickCurrent = Number(comp.tickCurrent ?? comp.tick_current);
                const spacing = Number(comp.tickSpacing ?? comp.tick_spacing);
                const start = TickUtils?.getTickArrayStartIndexByTick ? TickUtils.getTickArrayStartIndexByTick(tickCurrent, spacing) : (Math.floor(tickCurrent / (60 * spacing)) * (60 * spacing));
                const initArr: number[] = (TickUtils as any).getInitializedTickArrayInRange(
                  comp.tickArrayBitmapArray ?? comp.tickArrayBitmap ?? [],
                  comp.exTickArrayBitmap ?? comp.exTickarrayBitmap ?? [],
                  spacing,
                  start,
                  7,
                ) || [start];
                const lowers = initArr.filter((s: number) => s <= start).sort((a: number, b: number) => b - a);
                const uppers = initArr.filter((s: number) => s >= start).sort((a: number, b: number) => a - b);
                const lowerStart = lowers[0] ?? start;
                const upperStart = uppers[0] ?? start;
                const pid = comp.programId || programId;
                const ppk = comp.id || poolPk;
                if (!hop.tickArrayLower) {
                  const lr = getPdaTickArrayAddress?.(pid, ppk, lowerStart);
                  const lpk = (lr && (lr.publicKey || lr)) || null;
                  if (lpk) hop.tickArrayLower = lpk.toBase58?.() || String(lpk);
                }
                if (!hop.tickArrayUpper) {
                  const ur = getPdaTickArrayAddress?.(pid, ppk, upperStart);
                  const upk = (ur && (ur.publicKey || ur)) || null;
                  if (upk) hop.tickArrayUpper = upk.toBase58?.() || String(upk);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return hop;
}


