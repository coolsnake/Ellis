import { describe, it, expect } from 'vitest';

// End-to-end pipeline using limited real HTTP fetches from Raydium, Orca, and Meteora
// This test is SKIPPED by default. Enable by running with RUN_REAL_E2E=true

const RUN = String((globalThis as any)?.process?.env?.RUN_REAL_E2E || '') === 'true';

(RUN ? describe : describe.skip)('e2e: real fetch pipeline (limited pages)', () => {
  it('fetches, normalizes, builds graph, and validates reciprocity for all pools', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    // Disable scoping/filters to keep edges
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minDexOverlap = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    // Keep sanity checks on
    cfg.sanity.enabled = true;

    // Seed minimal USD prices to enable magnitude calibration during normalization/graph build
    try {
      const { setPrices } = await import('../../server/priceStore.js');
      const SOL = 'So11111111111111111111111111111111111111112';
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      setPrices({
        [USDC]: { usdc: 1, sol: null },
        [SOL]: { usdc: 225, sol: null },
      });
    } catch {}

    // Limit HTTP pagination for small, fast runs
    if (cfg.raydium) {
      cfg.raydium.pageSize = 100;
      cfg.raydium.maxPages = 1;
      (cfg.raydium as any).enableApiFetchByMints = false;
    }
    if (cfg.orca) {
      cfg.orca.pageSize = 100;
      cfg.orca.maxPages = 1;
      cfg.orca.includeBlocked = true;
    }
    if ((cfg as any).meteora) {
      (cfg as any).meteora.pageSize = 100;
      (cfg as any).meteora.maxPages = 1;
    }

    const poolsMod: any = await import('../pools.js');
    const graphMod: any = await import('../graph.js');

    // Fetch + normalize from sources (limited)
    const res = await poolsMod.refreshAllSources(true, false);
    expect(res).toBeTruthy();

    // Build graph from caches
    const snap = await graphMod.getGraphSnapshot(true);
    expect(Array.isArray(snap.edges)).toBe(true);
    // Graph health: ensure we didn't over-prune in limited mode
    expect((snap.nodes || []).length).toBeGreaterThanOrEqual(40);
    expect((snap.edges || []).length).toBeGreaterThanOrEqual(200);

    // Validate forward/reverse reciprocity for every pool id where both directions exist
    const byPool = new Map<string, any[]>();
    for (const e of (snap.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const key = pid.replace(/-rev$/, '');
      const arr = byPool.get(key) || [];
      arr.push(e);
      byPool.set(key, arr);
    }
    let checked = 0;
    for (const [, arr] of byPool) {
      const fwd = arr.find((e: any) => e.direction === 'forward');
      const rev = arr.find((e: any) => e.direction === 'reverse');
      if (!fwd || !rev) continue;
      const pf = Number((fwd as any).price_a_per_b || 0);
      const pr = Number((rev as any).price_a_per_b || 0);
      if (!(pf > 0 && pr > 0)) continue;
      const prod = pf * pr;
      expect(prod).toBeGreaterThan(1 / 1.05);
      expect(prod).toBeLessThan(1.05);
      checked++;
    }
    // Ensure we actually checked at least some edges
    expect(checked).toBeGreaterThan(0);

    // Multi-hop, multi-dex triangle simulation (prefer 3-hop cycles with >=2 distinct DEXes)
    const edges = snap.edges || [];
    const { getPriceByMint } = await import('../../server/priceStore.js');
    const bySrc = new Map<string, any[]>();
    for (const e of edges) {
      const arr = bySrc.get(e.source) || [];
      arr.push(e);
      bySrc.set(e.source, arr);
    }
    let triChecked = 0;
    outer: for (const aNode of snap.nodes) {
      const a = aNode.id;
      const abList = bySrc.get(a) || [];
      for (const ab of abList) {
        const b = ab.target;
        const bcList = bySrc.get(b) || [];
        for (const bc of bcList) {
          const c = bc.target;
          if (c === a || c === b) continue;
          const caList = bySrc.get(c) || [];
          const ca = caList.find((e) => e.target === a);
          if (!ca) continue;
          // Require USD quotes for all three mints to avoid unanchored cycles
          try {
            const pa = getPriceByMint(a)?.usdc ?? null;
            const pb = getPriceByMint(b)?.usdc ?? null;
            const pc = getPriceByMint(c)?.usdc ?? null;
            if (!(pa && pb && pc)) continue;
          } catch {}
          const pf = Number(ab.price_a_per_b || 0);
          const pg = Number(bc.price_a_per_b || 0);
          const ph = Number(ca.price_a_per_b || 0);
          if (!(pf > 0 && pg > 0 && ph > 0)) continue;
          const dexes = new Set<string>([String((ab as any).dex || ''), String((bc as any).dex || ''), String((ca as any).dex || '')]);
          // Require at least two distinct DEXes in the triangle
          if (dexes.size < 2) continue;
          const prod = pf * pg * ph;
          if (!(prod > 1 / 1.10 && prod < 1.10)) {
            try {
              // Log diagnostics for the first offending triangle
              // a -> b -> c -> a
              // Include mints, dexes, and per-edge prices
              // These logs help pinpoint mis-oriented or mis-scaled edges across DEXes
              // eslint-disable-next-line no-console
              console.warn('triangle.outOfRange', {
                a,
                b,
                c,
                prod,
                ab: { dex: (ab as any)?.dex, source: ab.source, target: ab.target, price: pf },
                bc: { dex: (bc as any)?.dex, source: bc.source, target: bc.target, price: pg },
                ca: { dex: (ca as any)?.dex, source: ca.source, target: ca.target, price: ph },
              });
            } catch {}
          }
          expect(prod).toBeGreaterThan(1 / 1.10); // allow 10% slack given real-world feeds
          expect(prod).toBeLessThan(1.10);
          triChecked += 1;
          if (triChecked >= 1) break outer;
        }
      }
    }
    if (triChecked === 0) {
      // Fallback: try 2-hop anchored cycle USDC <-> SOL across distinct DEXes
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const SOL = 'So11111111111111111111111111111111111111112';
      const usdcToSol = edges.filter((e: any) => e.source === USDC && e.target === SOL);
      const solToUsdc = edges.filter((e: any) => e.source === SOL && e.target === USDC);
      for (const ab of usdcToSol) {
        for (const ba of solToUsdc) {
          if (!ab || !ba) continue;
          if (String((ab as any).dex || '') === String((ba as any).dex || '')) continue;
          const pf = Number((ab as any).price_a_per_b || 0);
          const pr = Number((ba as any).price_a_per_b || 0);
          if (!(pf > 0 && pr > 0)) continue;
          const prod = pf * pr;
          expect(prod).toBeGreaterThan(1 / 1.10);
          expect(prod).toBeLessThan(1.10);
          triChecked += 1; break;
        }
        if (triChecked > 0) break;
      }
    }
    expect(triChecked).toBeGreaterThan(0);
  }, 60_000);
});


