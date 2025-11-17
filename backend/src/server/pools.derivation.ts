import { web3 } from '@project-serum/anchor';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { PoolInfoLayout as RaydiumClmmLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../execution/raydiumTickArrays.js';
import BN from 'bn.js';
import { toB58Any } from './pools.utils.js';

type RaydiumClmmDerivedFields = {
    programId?: string;
    oracle?: string;
    observationState?: string;
    ammConfig?: string;
    vaultA?: string;
    vaultB?: string;
    tickSpacing?: number;
    tickCurrent?: number;
    tickArrays?: { lower?: string; center?: string; upper?: string };
};

export async function deriveRaydiumClmmCacheFields(
    poolId: string,
    rawAccountData: Buffer,
    opts?: { programId?: string }
): Promise<RaydiumClmmDerivedFields | null> {
    if (!rawAccountData?.length) return null;
    if (!RaydiumClmmLayout || typeof RaydiumClmmLayout.decode !== 'function') return null;
    try {
        const state: any = RaydiumClmmLayout.decode(rawAccountData);
        const tickSpacing = Number(state?.tickSpacing ?? state?.tick_spacing ?? 0);
        const tickCurrent = Number(state?.tickCurrent ?? state?.tick_current ?? 0);
        const oracle = toB58Any(state?.oracle);
        const observationState = toB58Any(state?.observationId || state?.observation_id || state?.observationAccount || state?.observation_account);
        const ammConfig = toB58Any(state?.ammConfig || state?.amm_config || state?.config);
        const vaultA = toB58Any(state?.vaultA || state?.tokenVault0 || state?.tokenVaultA || state?.baseVault);
        const vaultB = toB58Any(state?.vaultB || state?.tokenVault1 || state?.tokenVaultB || state?.quoteVault);
        const programIdStr = opts?.programId
            || toB58Any(state?.owner)
            || String((CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
        let tickArrays: { lower?: string; center?: string; upper?: string } | undefined;
        if (Number.isFinite(tickSpacing) && tickSpacing > 0 && Number.isFinite(tickCurrent)) {
            try {
                const { PublicKey } = await import('@solana/web3.js');
                const programPk = new PublicKey(programIdStr);
                const poolPk = new PublicKey(poolId);
                const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
                const delta = 60 * Math.max(1, tickSpacing);
                const [lowerPk, centerPk, upperPk] = await Promise.all([
                    deriveTickArrayPda(programPk, poolPk, centerStart - delta),
                    deriveTickArrayPda(programPk, poolPk, centerStart),
                    deriveTickArrayPda(programPk, poolPk, centerStart + delta),
                ]);
                tickArrays = {
                    lower: lowerPk?.toBase58(),
                    center: centerPk?.toBase58(),
                    upper: upperPk?.toBase58(),
                };
            } catch (err: any) {
                try { logger.debug('raydium.clmm.tickarray.derive_failed', { pool: poolId.slice(0, 8) + '…', error: String(err?.message || err) }); } catch { }
            }
        }
        return {
            programId: programIdStr,
            oracle,
            observationState,
            ammConfig,
            vaultA,
            vaultB,
            tickSpacing: Number.isFinite(tickSpacing) && tickSpacing > 0 ? tickSpacing : undefined,
            tickCurrent: Number.isFinite(tickCurrent) ? tickCurrent : undefined,
            tickArrays,
        };
    } catch (err: any) {
        try { logger.debug('raydium.clmm.raw.decode_failed', { pool: poolId.slice(0, 8) + '…', error: String(err?.message || err) }); } catch { }
        return null;
    }
}

type MeteoraBinHelpers = {
    getBounds?: (activeBin: BN) => [BN, BN];
    binIdToBinArrayIndex?: (binId: BN) => BN | number;
};

let meteoraBinHelpersPromise: Promise<MeteoraBinHelpers> | null = null;

export async function getMeteoraBinHelpers(): Promise<MeteoraBinHelpers> {
    if (!meteoraBinHelpersPromise) {
        meteoraBinHelpersPromise = (async () => {
            try {
                const mod: any = await import('@meteora-ag/dlmm');
                const root = (mod && (mod as any).default) ? (mod as any).default : mod;
                const getBounds = root?.getBinArrayLowerUpperBinId || root?.DLMM?.getBinArrayLowerUpperBinId || mod?.getBinArrayLowerUpperBinId;
                const binIdToBinArrayIndex = root?.binIdToBinArrayIndex || root?.DLMM?.binIdToBinArrayIndex || mod?.binIdToBinArrayIndex;
                return { getBounds, binIdToBinArrayIndex };
            } catch (err: any) {
                try { logger.warn('meteora.bin.helpers.import_failed', { error: String(err?.message || err), cat: 'pools' }); } catch { }
                return { getBounds: undefined, binIdToBinArrayIndex: undefined };
            }
        })();
    }
    return meteoraBinHelpersPromise;
}

export async function deriveMeteoraBinArrayAddresses(
    pairPk: any,
    programId: any,
    activeId?: number
): Promise<{ lower?: string; upper?: string }> {
    if (!Number.isFinite(activeId as number)) return {};
    const helpers = await getMeteoraBinHelpers();
    if (!helpers.getBounds || !helpers.binIdToBinArrayIndex) return {};
    const activeBn = new BN(String(activeId));
    let lowerIdx: number | undefined;
    let upperIdx: number | undefined;
    try {
        const [lowerBin, upperBin] = helpers.getBounds(activeBn) || [];
        if (!lowerBin && !upperBin) return {};
        const toInt = (val: BN | number | undefined): number | undefined => {
            if (val == null) return undefined;
            if (typeof val === 'number') return val;
            try { return Number(val.toString()); } catch { return undefined; }
        };
        const lowerIdxBn = lowerBin ? helpers.binIdToBinArrayIndex!(lowerBin) : undefined;
        const upperIdxBn = upperBin ? helpers.binIdToBinArrayIndex!(upperBin) : undefined;
        lowerIdx = toInt(lowerIdxBn as any);
        upperIdx = toInt(upperIdxBn as any);
    } catch (err: any) {
        try { logger.debug('meteora.bin.bounds_failed', { error: String(err?.message || err), cat: 'pools' }); } catch { }
        return {};
    }
    if (lowerIdx == null && upperIdx == null) return {};
    try {
        const { PublicKey } = await import('@solana/web3.js');
        const poolPk = pairPk instanceof PublicKey ? pairPk : new PublicKey(pairPk);
        const programPk = programId instanceof PublicKey ? programId : new PublicKey(programId);
        const deriveAddr = (idx?: number): string | undefined => {
            if (idx == null) return undefined;
            const idxBn = new BN(idx);
            const seed = idxBn.isNeg()
                ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
                : idxBn.toArrayLike(Buffer, 'le', 8);
            const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bin_array'), poolPk.toBuffer(), Buffer.from(seed)],
                programPk
            );
            return pda?.toBase58();
        };
        return {
            lower: deriveAddr(lowerIdx),
            upper: deriveAddr(upperIdx),
        };
    } catch (err: any) {
        try { logger.debug('meteora.bin.addr_failed', { error: String(err?.message || err), cat: 'pools' }); } catch { }
        return {};
    }
}
