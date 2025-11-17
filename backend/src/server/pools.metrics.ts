
export const poolsMetrics: {
    raydium: {
        fetches: number; lastMs: number; lastAmm: number; lastClmm: number;
        filteredAmm: number; filteredClmm: number; universe: string; zeroOverlapSkips: number;
        scannedPoolAccs: number; updatedFromPoolAccs: number; scannedVaults: number; updatedFromVaults: number;
        ownerClmmCount: number; ownerAmmCount: number; http429: number; backoffMs: number; apiBatches: number; apiBatchSizeAvg: number;
    };
    orca: { fetches: number; lastMs: number; lastAmm: number; lastClmm: number };
    meteora: { fetches: number; lastMs: number; lastClmm: number };
    meteora_balanced: { fetches: number; lastMs: number; lastAmm: number };
    pumpswap: { fetches: number; lastMs: number; lastAmm: number; enrichmentSuccess: number; enrichmentFail: number; enrichmentMs: number };
} = {
    raydium: {
        fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0,
        filteredAmm: 0, filteredClmm: 0, universe: '', zeroOverlapSkips: 0,
        scannedPoolAccs: 0, updatedFromPoolAccs: 0, scannedVaults: 0, updatedFromVaults: 0,
        ownerClmmCount: 0, ownerAmmCount: 0, http429: 0, backoffMs: 0, apiBatches: 0, apiBatchSizeAvg: 0,
    },
    orca: { fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0 },
    meteora: { fetches: 0, lastMs: 0, lastClmm: 0 },
    meteora_balanced: { fetches: 0, lastMs: 0, lastAmm: 0 },
    pumpswap: { fetches: 0, lastMs: 0, lastAmm: 0, enrichmentSuccess: 0, enrichmentFail: 0, enrichmentMs: 0 },
};

export function getPoolsMetrics(): any {
    return poolsMetrics;
}

export const wsDeltaStats: Record<'raydium' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced', { decoded: number; applied: number; skipped: number; skipReasons?: Record<string, number> }> = {
    raydium: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
    orca: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
    meteora: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
    pumpswap: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
    meteora_balanced: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
};

export const wsDecodeStats: Record<'raydium' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced', { attempts: number; successes: number; failures: number }> = {
    raydium: { attempts: 0, successes: 0, failures: 0 },
    orca: { attempts: 0, successes: 0, failures: 0 },
    meteora: { attempts: 0, successes: 0, failures: 0 },
    pumpswap: { attempts: 0, successes: 0, failures: 0 },
    meteora_balanced: { attempts: 0, successes: 0, failures: 0 },
};

export function incrementSkipReason(dex: 'raydium' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced', reason: string): void {
    const stats = wsDeltaStats[dex];
    if (!stats.skipReasons) stats.skipReasons = {};
    stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
}

export const wsDebugCounters: Record<'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap', number> = { raydium: 0, orca: 0, meteora: 0, meteora_balanced: 0, pumpswap: 0 };
export const wsTargetDebugCounters: Record<'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap', number> = { raydium: 0, orca: 0, meteora: 0, meteora_balanced: 0, pumpswap: 0 };
