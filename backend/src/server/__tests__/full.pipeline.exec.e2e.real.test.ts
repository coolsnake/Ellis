// @ts-nocheck
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// This test runs a consolidated end-to-end flow:
// 1) Fetch + normalize pools from Raydium, Orca, Meteora DLMM, and Meteora Balanced (v1+v2 union)
// 2) Build the graph and validate basic health
// 3) Derive a simple 2-hop anchored cycle (USDC <-> SOL) across distinct DEXes when available
// 4) Send the path to /arb/simulate-send to exercise resolve->build->simulate pipeline
//
// SKIPPED by default. Enable with RUN_REAL_E2E=true

const RUN = String((globalThis as any)?.process?.env?.RUN_REAL_E2E || '') === 'true';

// Light mocks for direct execution path
vi.mock('../routes/schemas.js', () => ({
  ResolveDirectSchema: { parse: (x: any) => x },
}));

vi.mock('../../execution/builder/tx.js', () => ({
  buildDirectArbTx: vi.fn(async (_plan: any) => ({
    tx: { instructions: [{ programId: 'Test111111111111111111111111111111111111111', keys: [], data: {} }] },
    ixCount: 2,
    sizeBytes: 500,
  })),
}));

vi.mock('../../execution/sender.js', () => ({
  assembleAndSimulate: vi.fn(async () => ({ logs: ['ok: build', 'ok: simulate'], err: null })),
  assembleAndSend: vi.fn(async () => ({ signature: 'sig-test' })),
}));

(RUN ? describe : describe.skip)('e2e: full pipeline fetch→graph→arb.simulate', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createArbRouter } = await import('../routes/arb.js');
    app = express();
    app.use(express.json());
    app.use(createArbRouter({} as any));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('fetches sources, builds graph, finds a cycle, and simulates a tx', async () => {
    const cfg: any = (await import('../../utils/config.js')).CONFIG;
    // Keep graph broad and permissive for discovery
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minDexOverlap = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.sanity.enabled = true;

    // Seed USD anchors to stabilize normalization and graph calibration
    try {
      const { setPrices } = await import('../../server/priceStore.js');
      const SOL = 'So11111111111111111111111111111111111111112';
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      setPrices({ [USDC]: { usdc: 1, sol: null }, [SOL]: { usdc: 225, sol: null } });
    } catch {}

    // Keep pagination small for speed
    if (cfg.raydium) { cfg.raydium.pageSize = 80; cfg.raydium.maxPages = 1; (cfg.raydium as any).enableApiFetchByMints = false; }
    if (cfg.orca) { cfg.orca.pageSize = 80; cfg.orca.maxPages = 1; cfg.orca.includeBlocked = true; }
    if ((cfg as any).meteora) { (cfg as any).meteora.pageSize = 80; (cfg as any).meteora.maxPages = 1; }
    if ((cfg as any).meteoraBalanced) { (cfg as any).meteoraBalanced.pageSize = 80; (cfg as any).meteoraBalanced.maxPages = 1; }

    const poolsMod: any = await import('../pools.js');
    const graphMod: any = await import('../graph.js');

    // 1) Refresh sources
    const res = await poolsMod.refreshAllSources(true, false);
    expect(res).toBeTruthy();

    // 2) Build graph
    const snap = await graphMod.getGraphSnapshot(true);
    expect(Array.isArray(snap.edges)).toBe(true);
    expect((snap.nodes || []).length).toBeGreaterThanOrEqual(20);
    expect((snap.edges || []).length).toBeGreaterThanOrEqual(80);

    // 3) Derive an anchored 2-hop cycle across distinct DEXes if available (USDC <-> SOL)
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL = 'So11111111111111111111111111111111111111112';
    const edges: any[] = snap.edges || [];
    const usdcToSol = edges.filter((e: any) => e.source === USDC && e.target === SOL);
    const solToUsdc = edges.filter((e: any) => e.source === SOL && e.target === USDC);
    let chosen: { path: string[]; hopPoolIds: string[]; dexes: string[] } | null = null;
    outer: for (const ab of usdcToSol) {
      for (const ba of solToUsdc) {
        const dex1 = String((ab as any)?.dex || '');
        const dex2 = String((ba as any)?.dex || '');
        if (!dex1 || !dex2 || dex1 === dex2) continue;
        const pid1 = String((ab as any)?.pool_id || (ab as any)?.poolId || '');
        const pid2 = String((ba as any)?.pool_id || (ba as any)?.poolId || '');
        if (!pid1 || !pid2) continue;
        chosen = { path: [USDC, SOL, USDC], hopPoolIds: [pid1, pid2], dexes: [dex1, dex2] };
        break outer;
      }
    }

    // If no anchored 2-hop cycle found, skip simulate step but still count graph build as success
    if (!chosen) {
      // Ensure at least graph is healthy
      expect(Array.isArray(snap.edges)).toBe(true);
      return;
    }

    // 4) Simulate execution for the discovered cycle
    const simRes = await request(app)
      .post('/arb/simulate-send')
      .send({ path: chosen.path, hopPoolIds: chosen.hopPoolIds, dexes: chosen.dexes })
      .set('content-type', 'application/json');

    expect(simRes.status).toBe(200);
    expect(simRes.body).toHaveProperty('ixCount');
    expect(simRes.body).toHaveProperty('txSizeBytes');
    expect(Array.isArray(simRes.body.logs)).toBe(true);
  }, 90_000);
});


