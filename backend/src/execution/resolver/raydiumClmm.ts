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
            // derive tick arrays using current tick and spacing
            const spacing = Number(hop.tickSpacing || (state as any).tickSpacing || (state as any).tick_spacing || 0);
            // Prefer explicit tickCurrent when present; otherwise approximate from sqrtPriceX64 if exposed
            let curTick = Number((state as any).tickCurrent ?? (state as any).tick_current ?? NaN);
            if (!Number.isFinite(curTick)) {
              try {
                const sqrt = Number((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0);
                if (sqrt > 0 && Number.isFinite(sqrt) && spacing > 0) {
                  const ratio = sqrt / Math.pow(2, 64);
                  // tick ≈ log_1.0001(price); price ~ ratio^2 adjusted by decimals; we only need bucket index
                  const approxPrice = ratio * ratio;
                  const tickApprox = Math.floor(Math.log(approxPrice) / Math.log(1.0001));
                  if (Number.isFinite(tickApprox)) curTick = tickApprox;
                }
              } catch {}
            }
            if (Number.isFinite(spacing) && spacing > 0 && Number.isFinite(curTick)) {
              const TICK_ARRAY_SIZE = 88; // Raydium CLMM standard
              const block = TICK_ARRAY_SIZE * spacing;
              const center = Math.floor(curTick / block) * block;
              // programId resolved above
              let lowerPk: any = null; let upperPk: any = null;
              const util = (rmod as any)?.Clmm || (rmod as any)?.CLMM;
              const getPda = util?.getTickArrayAddress || util?.tickArrayPda || util?.getPdaTickArray;
              const deriveAddrs = (startIdx: number): any[] => {
                const out: any[] = [];
                try {
                  if (typeof getPda === 'function') {
                    out.push(getPda({ programId, poolId: poolPk, startIndex: startIdx }));
                  }
                } catch {}
                try {
                  const i32le = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; };
                  const i32be = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
                  out.push(web3.PublicKey.findProgramAddressSync([
                    Buffer.from('tick_array'),
                    poolPk.toBuffer(),
                    i32le(startIdx),
                  ], programId)[0]);
                  out.push(web3.PublicKey.findProgramAddressSync([
                    Buffer.from('tickarray'),
                    poolPk.toBuffer(),
                    i32le(startIdx),
                  ], programId)[0]);
                  out.push(web3.PublicKey.findProgramAddressSync([
                    Buffer.from('tick_array'),
                    poolPk.toBuffer(),
                    i32be(startIdx),
                  ], programId)[0]);
                  out.push(web3.PublicKey.findProgramAddressSync([
                    Buffer.from('tickarray'),
                    poolPk.toBuffer(),
                    i32be(startIdx),
                  ], programId)[0]);
                } catch {}
                return out;
              };
              const coercePk = async (v: any): Promise<any | null> => {
                try {
                  const maybe = await Promise.resolve(v);
                  const pk = (maybe && (maybe.publicKey || maybe)) || null;
                  return pk || null;
                } catch { return null; }
              };
              const exists = async (pk: any): Promise<boolean> => {
                try { const info = await withRpcLimit(() => conn.getAccountInfo(pk)); return !!(info && info.data && info.data.length > 0); } catch { return false; }
              };
              // Find nearest lower and upper arrays that exist, scanning up to +/-3 blocks
              const candidates: number[] = [0, -1, 1, -2, 2, -3, 3].map(d => center + d * block);
              for (const s of candidates) {
                if (!lowerPk && s <= curTick) {
                  const list = deriveAddrs(s);
                  for (const cand of list) {
                    const pk = await coercePk(cand);
                    if (pk && await exists(pk)) { lowerPk = pk; break; }
                  }
                }
                if (!upperPk && s >= curTick) {
                  const list = deriveAddrs(s);
                  for (const cand of list) {
                    const pk = await coercePk(cand);
                    if (pk && await exists(pk)) { upperPk = pk; break; }
                  }
                }
                if (lowerPk && upperPk) break;
              }
              if (!hop.tickArrayLower && lowerPk) hop.tickArrayLower = lowerPk.toBase58?.() || String(lowerPk);
              if (!hop.tickArrayUpper && upperPk) hop.tickArrayUpper = upperPk.toBase58?.() || String(upperPk);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return hop;
}


