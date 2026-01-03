import { web3 } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { PoolInfoLayout as RaydiumClmmLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../execution/raydiumTickArrays.js';
import BN from 'bn.js';
import { toB58Any } from './pools.utils.js';

// Orca Whirlpool constants
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const ORCA_TICK_ARRAY_SIZE = 88;

type RaydiumClmmDerivedFields = {
    programId?: string;
    oracle?: string;
    observationState?: string;
    ammConfig?: string;
    vaultA?: string;
    vaultB?: string;
    tickSpacing?: number;
    tickCurrent?: number;
    tickArrays?: { 
        center?: string; 
        lower?: string | string[]; 
        upper?: string | string[] 
    };
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
        let tickArrays: { 
            center?: string; 
            lower?: string | string[]; 
            upper?: string | string[] 
        } | undefined;
        
        if (Number.isFinite(tickSpacing) && tickSpacing > 0 && Number.isFinite(tickCurrent)) {
            try {
                const { PublicKey } = await import('@solana/web3.js');
                const programPk = new PublicKey(programIdStr);
                const poolPk = new PublicKey(poolId);
                const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
                const delta = 60 * Math.max(1, tickSpacing);
                
                // Derive center tick array
                const centerPk = await deriveTickArrayPda(programPk, poolPk, centerStart);
                
                // Derive multiple lower tick arrays (for B→A swaps)
                const lowerArrays: string[] = [];
                for (let i = 1; i <= 5; i++) {
                    try {
                        const lowerPk = await deriveTickArrayPda(programPk, poolPk, centerStart - (delta * i));
                        if (lowerPk) lowerArrays.push(lowerPk.toBase58());
                    } catch (err) {
                        break;
                    }
                }
                
                // Derive multiple upper tick arrays (for A→B swaps)
                const upperArrays: string[] = [];
                for (let i = 1; i <= 5; i++) {
                    try {
                        const upperPk = await deriveTickArrayPda(programPk, poolPk, centerStart + (delta * i));
                        if (upperPk) upperArrays.push(upperPk.toBase58());
                    } catch (err) {
                        break;
                    }
                }
                
                tickArrays = {
                    center: centerPk?.toBase58(),
                    // Store arrays if we have multiple, otherwise single value
                    lower: lowerArrays.length > 1 ? lowerArrays : (lowerArrays[0] || undefined),
                    upper: upperArrays.length > 1 ? upperArrays : (upperArrays[0] || undefined),
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

/**
 * Derive Orca tick array PDA using the correct encoding
 * CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
 */
function deriveOrcaTickArrayPda(
  poolId: PublicKey,
  startTickIndex: number
): PublicKey {
  const programPk = new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
    programPk
  );
  return pda;
}

/**
 * Get Orca tick array start index for a given tick
 */
function getOrcaTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  // Use floor division to get the array index, then multiply back
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

type OrcaClmmDerivedFields = {
  programId?: string;
  oracle?: string;
  tickSpacing?: number;
  tickCurrent?: number;
  tickArrays?: {
    center?: string;
    lower?: string | string[];
    upper?: string | string[];
  };
};

/**
 * Derive Orca Whirlpool cache fields including tick arrays from tick position
 * This function derives tick array PDAs based on the current tick position.
 * NOTE: Derived PDAs may not exist on-chain - use cacheValidator for verification.
 */
export async function deriveOrcaClmmCacheFields(
  poolId: string,
  tickCurrent: number,
  tickSpacing: number,
  opts?: { programId?: string }
): Promise<OrcaClmmDerivedFields | null> {
  if (!Number.isFinite(tickCurrent) || !Number.isFinite(tickSpacing) || tickSpacing <= 0) {
    return null;
  }
  
  try {
    const programIdStr = opts?.programId || ORCA_WHIRLPOOL_PROGRAM_ID;
    const poolPk = new PublicKey(poolId);
    
    // Calculate tick array indices
    const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
    const centerStartTick = getOrcaTickArrayStartIndex(tickCurrent, tickSpacing);
    
    // Derive center tick array
    const centerPk = deriveOrcaTickArrayPda(poolPk, centerStartTick);
    
    // Derive lower tick arrays (for swaps that move price down)
    const lowerArrays: string[] = [];
    for (let i = 1; i <= 5; i++) {
      try {
        const lowerStartTick = centerStartTick - (ticksInArray * i);
        const lowerPk = deriveOrcaTickArrayPda(poolPk, lowerStartTick);
        if (lowerPk) lowerArrays.push(lowerPk.toBase58());
      } catch {
        break;
      }
    }
    
    // Derive upper tick arrays (for swaps that move price up)
    const upperArrays: string[] = [];
    for (let i = 1; i <= 5; i++) {
      try {
        const upperStartTick = centerStartTick + (ticksInArray * i);
        const upperPk = deriveOrcaTickArrayPda(poolPk, upperStartTick);
        if (upperPk) upperArrays.push(upperPk.toBase58());
      } catch {
        break;
      }
    }
    
    const tickArrays = {
      center: centerPk.toBase58(),
      lower: lowerArrays.length > 1 ? lowerArrays : (lowerArrays[0] || undefined),
      upper: upperArrays.length > 1 ? upperArrays : (upperArrays[0] || undefined),
    };
    
    logger.debug('orca.clmm.tickarray.derived', {
      pool: poolId.slice(0, 8) + '…',
      tickCurrent,
      tickSpacing,
      centerStartTick,
      tickArrays: {
        center: tickArrays.center?.slice(0, 8) + '…',
        lowerCount: lowerArrays.length,
        upperCount: upperArrays.length,
      },
      cat: 'pools'
    });
    
    return {
      programId: programIdStr,
      tickSpacing,
      tickCurrent,
      tickArrays,
    };
  } catch (err: any) {
    logger.debug('orca.clmm.tickarray.derive_failed', {
      pool: poolId.slice(0, 8) + '…',
      error: String(err?.message || err),
      cat: 'pools'
    });
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
): Promise<{ lower?: string; lower2?: string; upper?: string; upper2?: string; active?: string }> {
    if (!Number.isFinite(activeId as number)) return {};
    
    // Calculate bin array index directly from activeId
    // BIN_ARRAY_SIZE = 70 in Meteora DLMM
    const BIN_ARRAY_SIZE = 70;
    const activeArrayIdx = Math.floor(activeId! / BIN_ARRAY_SIZE);
    
    try {
        const { PublicKey } = await import('@solana/web3.js');
        const poolPk = pairPk instanceof PublicKey ? pairPk : new PublicKey(pairPk);
        const programPk = programId instanceof PublicKey ? programId : new PublicKey(programId);
        
        const deriveAddr = (idx: number): string => {
            const idxBn = new BN(idx);
            const seed = idxBn.isNeg()
                ? idxBn.toTwos(64).toArrayLike(Buffer, 'le', 8)
                : idxBn.toArrayLike(Buffer, 'le', 8);
            const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bin_array'), poolPk.toBuffer(), Buffer.from(seed)],
                programPk
            );
            return pda.toBase58();
        };
        
        // Derive active and ±2 adjacent bin arrays for directional swaps
        // CRITICAL: 'active' is the bin array containing the active bin
        // We need ±2 because if the active bin is near an array boundary,
        // a swap might need to traverse 2+ arrays in either direction.
        // Example: activeId=-420 (bottom of array -6), Y→X swap needs -6, -5, -4
        return {
            active: deriveAddr(activeArrayIdx),
            lower: deriveAddr(activeArrayIdx - 1),
            lower2: deriveAddr(activeArrayIdx - 2),
            upper: deriveAddr(activeArrayIdx + 1),
            upper2: deriveAddr(activeArrayIdx + 2),
        };
    } catch (err: any) {
        try { logger.debug('meteora.bin.addr_failed', { error: String(err?.message || err), cat: 'pools' }); } catch { }
        return {};
    }
}
