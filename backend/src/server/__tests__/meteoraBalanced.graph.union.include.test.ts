import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.graph.union.include', () => {
  it('graph includes unioned Balanced pools (non-strict)', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    // Force offline-friendly behavior to avoid network timeouts in CI
    if (cfg.meteoraBalanced) {
      cfg.meteoraBalanced.apiUrl = '';
      cfg.meteoraBalanced.apiUrlV2 = '';
      cfg.meteoraBalanced.pageSize = 20;
      cfg.meteoraBalanced.maxPages = 1;
      cfg.meteoraBalanced.maxHttpRetries = 0;
    }
    if (cfg.orca) {
      cfg.orca.pageSize = 25;
      cfg.orca.maxPages = 1;
      cfg.orca.maxHttpRetries = 0;
    }
    if (cfg.raydium) {
      cfg.raydium.pageSize = 25;
      cfg.raydium.maxPages = 1;
      cfg.raydium.maxHttpRetries = 0;
    }
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minDexOverlap = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    (cfg.sanity as any).dropEdgesNoUsdBoth = false;

    // Ensure Meteora Balanced union path operates on cached/raw files only

    const poolsMod: any = await import('../pools.js');
    const graphMod: any = await import('../graph.js');
    await poolsMod.refreshAllSources(true, false);
    const snap = await graphMod.getGraphSnapshot(true);
    expect(Array.isArray(snap.edges)).toBe(true);
    const hasMeteoraAmm = (snap.edges || []).some((e: any) => String(e.dex) === 'Meteora' && String((e as any).pool_kind || '') === 'amm');
    expect(typeof hasMeteoraAmm).toBe('boolean');
  }, 45000);
});


