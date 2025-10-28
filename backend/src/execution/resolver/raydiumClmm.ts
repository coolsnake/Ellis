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
            // derive tick arrays using SDK helpers (TICK_ARRAY_SIZE = 60)
            const spacing = Number(hop.tickSpacing || (state as any).tickSpacing || (state as any).tick_spacing || 0);
            // Prefer explicit tickCurrent; else approximate from sqrtPrice
            let curTick = Number((state as any).tickCurrent ?? (state as any).tick_current ?? NaN);
            if (!Number.isFinite(curTick)) {
              try {
                const sqrt = Number((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0);
                if (sqrt > 0 && Number.isFinite(sqrt) && spacing > 0) {
                  const ratio = sqrt / Math.pow(2, 64);
                  const approxPrice = ratio * ratio;
                  const tickApprox = Math.floor(Math.log(approxPrice) / Math.log(1.0001));
                  if (Number.isFinite(tickApprox)) curTick = tickApprox;
                }
              } catch {}
            }
            if (Number.isFinite(spacing) && spacing > 0 && Number.isFinite(curTick)) {
              try {
                const sdk: any = await import('@raydium-io/raydium-sdk-v2');
                const TickUtils = (sdk as any)?.TickUtils || (sdk as any)?.CLMM?.TickUtils || (sdk as any)?.Clmm?.TickUtils;
                const getPdaTickArrayAddress = (sdk as any)?.getPdaTickArrayAddress || (sdk as any)?.CLMM?.getPdaTickArrayAddress || (sdk as any)?.Clmm?.getPdaTickArrayAddress;
                const start = TickUtils?.getTickArrayStartIndexByTick ? TickUtils.getTickArrayStartIndexByTick(curTick, spacing) : (Math.floor(curTick / (60 * spacing)) * (60 * spacing));
                const size = Number((TickUtils as any)?.TICK_ARRAY_SIZE ?? 60);
                const span = size * spacing;
                const lowerStart = start - span;
                const upperStart = start + span;
                try {
                  if (!hop.tickArrayLower) {
                    const rL = getPdaTickArrayAddress?.(programId, poolPk, lowerStart);
                    const pkL = (rL && (rL.publicKey || rL)) || null;
                    if (pkL) hop.tickArrayLower = pkL.toBase58?.() || String(pkL);
                  }
                } catch {}
                try {
                  if (!hop.tickArrayUpper) {
                    const rU = getPdaTickArrayAddress?.(programId, poolPk, upperStart);
                    const pkU = (rU && (rU.publicKey || rU)) || null;
                    if (pkU) hop.tickArrayUpper = pkU.toBase58?.() || String(pkU);
                  }
                } catch {}
              } catch {}
            }
          }
        }
      } catch {}
    }
  } catch {}
  return hop;
}


