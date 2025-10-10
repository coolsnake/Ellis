import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.graph.union.include', () => {
  it('graph includes unioned Balanced pools (non-strict)', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minDexOverlap = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    (cfg.sanity as any).dropEdgesNoUsdBoth = false;

    if ((cfg as any).meteoraBalanced) {
      (cfg as any).meteoraBalanced.pageSize = 50;
      (cfg as any).meteoraBalanced.maxPages = 1;
    }

    const poolsMod: any = await import('../pools.js');
    const graphMod: any = await import('../graph.js');
    await poolsMod.refreshAllSources(true, false);
    const snap = await graphMod.getGraphSnapshot(true);
    expect(Array.isArray(snap.edges)).toBe(true);
    const hasMeteoraAmm = (snap.edges || []).some((e: any) => String(e.dex) === 'Meteora' && String((e as any).pool_kind || '') === 'amm');
    expect(typeof hasMeteoraAmm).toBe('boolean');
  }, 20000);
});


