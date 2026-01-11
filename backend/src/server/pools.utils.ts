import { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';

export function toB58Any(v: any): string {
    if (!v) return '';
    if (typeof v === 'string') return v;
    try {
        if (v && typeof v.toBase58 === 'function') return String(v.toBase58());
    } catch {}
    try {
        const s = v?.toString?.();
        if (typeof s === 'string') {
            const m = /^PublicKey\(([^)]+)\)$/.exec(s);
            return m ? m[1] : s;
        }
    } catch {}
    return '';
}

export function applyTokenMintBlocklist<T extends { mint_a: string; mint_b: string }>(
    pools: { amm: T[]; clmm: T[]; cpmm?: T[] },
    blocklist: Set<string>
): { amm: T[]; clmm: T[]; cpmm: T[] } {
    if (!blocklist || blocklist.size === 0) return { ...pools, cpmm: pools.cpmm || [] };
    const allow = (p: T) => !blocklist.has(p.mint_a) && !blocklist.has(p.mint_b);
    return {
        amm: (pools.amm || []).filter(allow),
        clmm: (pools.clmm || []).filter(allow),
        cpmm: (pools.cpmm || []).filter(allow),
    };
}

export function diffNormalizedPools(prev: PoolsPayload | null | undefined, next: PoolsPayload): { amm: AmmPool[]; clmm: ClmmPool[]; addedAmm: number; removedAmm: number; addedClmm: number; removedClmm: number } {
    const byId = <T extends { id: string }>(arr: T[] | undefined | null) => {
        const m = new Map<string, T>();
        for (const it of (arr || [])) { if (it && it.id) m.set(String(it.id), it); }
        return m;
    };
    const pA = byId(prev?.amm); const pC = byId(prev?.clmm);
    const nA = byId(next.amm); const nC = byId(next.clmm);
    const updatedAmm: AmmPool[] = [];
    const updatedClmm: ClmmPool[] = [];
    const eps = 1e-9;
    const changedAmm = (a?: AmmPool, b?: AmmPool): boolean => {
        if (!a || !b) return true;
        const reserveChanged = ((a as any).reserve_a_raw && (b as any).reserve_a_raw && (a as any).reserve_b_raw && (b as any).reserve_b_raw)
            ? ((a as any).reserve_a_raw !== (b as any).reserve_a_raw || (a as any).reserve_b_raw !== (b as any).reserve_b_raw)
            : false;
        if (reserveChanged) return true;
        const ratioChanged = ((a as any).price_a_per_b_num && (a as any).price_a_per_b_den && (b as any).price_a_per_b_num && (b as any).price_a_per_b_den)
            ? ((a as any).price_a_per_b_num !== (b as any).price_a_per_b_num || (a as any).price_a_per_b_den !== (b as any).price_a_per_b_den)
            : false;
        if (ratioChanged) return true;
        if (((a as any).liquidity_base_raw && (b as any).liquidity_base_raw) && (a as any).liquidity_base_raw !== (b as any).liquidity_base_raw) return true;
        if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
        if (Math.abs((a.liquidity_base || 0) - (b.liquidity_base || 0)) > eps) return true;
        if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
        return false;
    };
    const changedClmm = (a?: ClmmPool, b?: ClmmPool): boolean => {
        if (!a || !b) return true;
        // Check sqrt_price_x64_raw for Raydium/Orca CLMM pools
        const rawChanged = ((a as any).sqrt_price_x64_raw && (b as any).sqrt_price_x64_raw)
            ? (a as any).sqrt_price_x64_raw !== (b as any).sqrt_price_x64_raw
            : false;
        if (rawChanged) return true;
        // Check active_id for Meteora DLMM pools (their primary price-determining field)
        const activeIdA = (a as any).active_id;
        const activeIdB = (b as any).active_id;
        if (Number.isFinite(activeIdA) && Number.isFinite(activeIdB) && activeIdA !== activeIdB) return true;
        const ratioChanged = ((a as any).price_a_per_b_num && (a as any).price_a_per_b_den && (b as any).price_a_per_b_num && (b as any).price_a_per_b_den)
            ? ((a as any).price_a_per_b_num !== (b as any).price_a_per_b_num || (a as any).price_a_per_b_den !== (b as any).price_a_per_b_den)
            : false;
        if (ratioChanged) return true;
        if (((a as any).liquidity_raw && (b as any).liquidity_raw) && (a as any).liquidity_raw !== (b as any).liquidity_raw) return true;
        if (Math.abs((a.liquidity || 0) - (b.liquidity || 0)) > 0) return true;
        if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
        if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
        if (Math.abs((a.amount_a || 0) - (b.amount_a || 0)) > 0) return true;
        if (Math.abs((a.amount_b || 0) - (b.amount_b || 0)) > 0) return true;
        if (((a as any).meteora_bin_hash || undefined) !== ((b as any).meteora_bin_hash || undefined)) return true;
        return false;
    };
    for (const [id, nx] of nA) { const pv = pA.get(id); if (!pv || changedAmm(pv, nx)) updatedAmm.push(nx); }
    for (const [id, nx] of nC) { const pv = pC.get(id); if (!pv || changedClmm(pv, nx)) updatedClmm.push(nx); }
    const addedAmm = Math.max(0, nA.size - pA.size);
    const addedClmm = Math.max(0, nC.size - pC.size);
    const removedAmm = Math.max(0, pA.size - nA.size);
    const removedClmm = Math.max(0, pC.size - nC.size);
    return { amm: updatedAmm, clmm: updatedClmm, addedAmm, removedAmm, addedClmm, removedClmm };
}

export function parseTokenAccountAmount(data: Buffer | Uint8Array): bigint | null {
    try {
        // SPL Token account layout: amount is at offset 64 (u64, 8 bytes, little-endian)
        if (data.length < 72) return null;

        // Read 8 bytes as little-endian u64
        const bytes = data.slice(64, 72);
        let value = 0n;
        for (let i = 0; i < 8; i++) {
            value |= BigInt(bytes[i]) << BigInt(i * 8);
        }
        return value;
    } catch {
        return null;
    }
}
