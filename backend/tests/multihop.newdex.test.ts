import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.LOCKSTONE_API_BASE || 'http://127.0.0.1:3001/api';
const RUN = process.env.RUN_LIVE_MULTIHOP === 'true';
const DO_EXECUTE = process.env.RUN_LIVE_MULTIHOP_EXECUTE === 'true';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function postJson(url: string, body: any): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, json: j };
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { method: 'GET', headers: { 'accept': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, json: j };
}

function pickPoolIdByTvl(arr: any[], mintA?: string, mintB?: string): string | null {
  let list = arr || [];
  if (mintA && mintB) {
    list = list.filter((p: any) => 
      (p?.mint_a === mintA && p?.mint_b === mintB) || 
      (p?.mint_a === mintB && p?.mint_b === mintA)
    );
  }
  if (list.length === 0) return null;
  const sorted = [...list].sort((a: any, b: any) => {
    const getTvl = (p: any) => {
      const tvl = Number(p?.tvl_usd || 0);
      if (tvl > 0) return tvl;
      const disp = Number(p?.liquidity_display || 0);
      if (disp > 0) return disp;
      const liq = Number(p?.liquidity_base || p?.pool_liquidity_raw || 0);
      return liq > 0 ? liq : 0;
    };
    return getTvl(b) - getTvl(a);
  });
  return sorted[0]?.id || null;
}

describe.skipIf(!RUN)('multihop.newdex', () => {
  const sizeUsd = Number(process.env.SIZE_USD || 1);
  const slippageBps = Number(process.env.SLIPPAGE_BPS || 100);

  beforeAll(async () => {
    await postJson(`${BASE}/arb/pools/refresh`, { force: true, subscribe: false });
  });

  it('multihop: damm-v1 -> damm-v2 (2-hop, SOL->USDC->SOL)', async () => {
    const meteoraBalancedPools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    expect(meteoraBalancedPools.ok).toBe(true);
    
    // Pick pools for each hop
    const pool1 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], SOL, USDC);
    const pool2 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], USDC, SOL);
    
    expect(!!pool1).toBe(true);
    expect(!!pool2).toBe(true);
    
    const sim = await postJson(`${BASE}/arb/simulate-send`, {
      path: [SOL, USDC, SOL],
      hopPoolIds: [pool1, pool2],
      dexes: ['MeteoraBalanced_v1', 'MeteoraBalanced_v2'],
      sizeUsd,
      slippageBps,
    });
    
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute`, {
        path: [SOL, USDC, SOL],
        hopPoolIds: [pool1, pool2],
        dexes: ['MeteoraBalanced_v1', 'MeteoraBalanced_v2'],
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 180_000);

  it('multihop: ray-clmm -> damm-v1 (2-hop, SOL->USDC->SOL)', async () => {
    const raydiumPools = await getJson(`${BASE}/arb/pools/raydium?minUsd=100000`);
    const meteoraBalancedPools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    
    expect(raydiumPools.ok).toBe(true);
    expect(meteoraBalancedPools.ok).toBe(true);
    
    const pool1 = pickPoolIdByTvl(raydiumPools.json?.clmm || [], SOL, USDC);
    const pool2 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], USDC, SOL);
    
    expect(!!pool1).toBe(true);
    expect(!!pool2).toBe(true);
    
    const sim = await postJson(`${BASE}/arb/simulate-send`, {
      path: [SOL, USDC, SOL],
      hopPoolIds: [pool1, pool2],
      dexes: ['raydium.clmm', 'MeteoraBalanced_v1'],
      sizeUsd,
      slippageBps,
    });
    
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute`, {
        path: [SOL, USDC, SOL],
        hopPoolIds: [pool1, pool2],
        dexes: ['raydium.clmm', 'MeteoraBalanced_v1'],
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 180_000);

  it('multihop: orca -> damm-v2 (2-hop, SOL->USDC->SOL)', async () => {
    const orcaPools = await getJson(`${BASE}/arb/pools/orca?minUsd=100000`);
    const meteoraBalancedPools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    
    expect(orcaPools.ok).toBe(true);
    expect(meteoraBalancedPools.ok).toBe(true);
    
    const pool1 = pickPoolIdByTvl(orcaPools.json?.clmm || [], SOL, USDC);
    const pool2 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], USDC, SOL);
    
    expect(!!pool1).toBe(true);
    expect(!!pool2).toBe(true);
    
    const sim = await postJson(`${BASE}/arb/simulate-send`, {
      path: [SOL, USDC, SOL],
      hopPoolIds: [pool1, pool2],
      dexes: ['orca.clmm', 'MeteoraBalanced_v2'],
      sizeUsd,
      slippageBps,
    });
    
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute`, {
        path: [SOL, USDC, SOL],
        hopPoolIds: [pool1, pool2],
        dexes: ['orca.clmm', 'MeteoraBalanced_v2'],
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 180_000);

  it('multihop: meteora-dlmm -> damm-v1 (2-hop, SOL->USDC->SOL)', async () => {
    const meteoraPools = await getJson(`${BASE}/arb/pools/meteora?minUsd=100000`);
    const meteoraBalancedPools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    
    expect(meteoraPools.ok).toBe(true);
    expect(meteoraBalancedPools.ok).toBe(true);
    
    const pool1 = pickPoolIdByTvl(meteoraPools.json?.clmm || [], SOL, USDC);
    const pool2 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], USDC, SOL);
    
    expect(!!pool1).toBe(true);
    expect(!!pool2).toBe(true);
    
    const sim = await postJson(`${BASE}/arb/simulate-send`, {
      path: [SOL, USDC, SOL],
      hopPoolIds: [pool1, pool2],
      dexes: ['meteora', 'MeteoraBalanced_v1'],
      sizeUsd,
      slippageBps,
    });
    
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute`, {
        path: [SOL, USDC, SOL],
        hopPoolIds: [pool1, pool2],
        dexes: ['meteora', 'MeteoraBalanced_v1'],
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 180_000);

  it('multihop: 3-hop ray-clmm -> damm-v1 -> orca (SOL->USDC->SOL->USDC)', async () => {
    const raydiumPools = await getJson(`${BASE}/arb/pools/raydium?minUsd=100000`);
    const meteoraBalancedPools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    const orcaPools = await getJson(`${BASE}/arb/pools/orca?minUsd=100000`);
    
    expect(raydiumPools.ok).toBe(true);
    expect(meteoraBalancedPools.ok).toBe(true);
    expect(orcaPools.ok).toBe(true);
    
    const pool1 = pickPoolIdByTvl(raydiumPools.json?.clmm || [], SOL, USDC);
    const pool2 = pickPoolIdByTvl(meteoraBalancedPools.json?.amm || [], USDC, SOL);
    const pool3 = pickPoolIdByTvl(orcaPools.json?.clmm || [], SOL, USDC);
    
    expect(!!pool1).toBe(true);
    expect(!!pool2).toBe(true);
    expect(!!pool3).toBe(true);
    
    const sim = await postJson(`${BASE}/arb/simulate-send`, {
      path: [SOL, USDC, SOL, USDC],
      hopPoolIds: [pool1, pool2, pool3],
      dexes: ['raydium.clmm', 'MeteoraBalanced_v1', 'orca.clmm'],
      sizeUsd,
      slippageBps,
    });
    
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute`, {
        path: [SOL, USDC, SOL, USDC],
        hopPoolIds: [pool1, pool2, pool3],
        dexes: ['raydium.clmm', 'MeteoraBalanced_v1', 'orca.clmm'],
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 180_000);
});

