import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.LOCKSTONE_API_BASE || 'http://127.0.0.1:3001/api';
const RUN = process.env.RUN_LIVE_SINGLEHOP === 'true';
const DO_EXECUTE = process.env.RUN_LIVE_SINGLEHOP_EXECUTE === 'true';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN';

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
  // If mints are provided, filter by them; otherwise just use the array as-is
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

describe.skipIf(!RUN)('singlehop.newdex', () => {
  const sizeUsd = Number(process.env.SIZE_USD || 1);
  const slippageBps = Number(process.env.SLIPPAGE_BPS || 50);

  beforeAll(async () => {
    await postJson(`${BASE}/arb/pools/refresh`, { force: true, subscribe: false });
  });

  it('meteora-balanced-v1 simulate-send SOL->USDC', async () => {
    const pools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdByTvl(pools.json?.amm || [], SOL, USDC);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/meteora-balanced-v1`, {
      path: [SOL, USDC],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute/meteora-balanced-v1`, {
        path: [SOL, USDC],
        poolId: id,
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 120_000);

  it('meteora-balanced-v2 simulate-send SOL->USDC', async () => {
    const pools = await getJson(`${BASE}/arb/pools/meteora-balanced?minUsd=10000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdByTvl(pools.json?.amm || [], SOL, USDC);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/meteora-balanced-v2`, {
      path: [SOL, USDC],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute/meteora-balanced-v2`, {
        path: [SOL, USDC],
        poolId: id,
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 120_000);

  it('pumpswap simulate-send (first available pool)', async () => {
    const pools = await getJson(`${BASE}/arb/pools/pumpswap?minUsd=1000`);
    expect(pools.ok).toBe(true);
    // Try to find SOL/USDC pool first, but fallback to any pool
    let id = pickPoolIdByTvl(pools.json?.amm || [], SOL, USDC);
    if (!id) {
      // No SOL/USDC pool (pumpswap is for pump.fun tokens), use any available pool
      id = pickPoolIdByTvl(pools.json?.amm || []);
    }
    if (!id) {
      console.log('No pumpswap pool available for test, skipping');
      return;
    }
    // Get the pool to determine the actual path (use pool's mints, not hardcoded SOL/USDC)
    const pool = (pools.json?.amm || []).find((p: any) => p?.id === id);
    expect(!!pool).toBe(true);
    const path = [pool?.mint_a, pool?.mint_b];
    console.log(`Testing pumpswap with pool ${id} (${path[0].slice(0, 8)}.../${path[1].slice(0, 8)}...)`);
    const sim = await postJson(`${BASE}/arb/simulate-send/pumpswap`, {
      path,
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute/pumpswap`, {
        path,
        poolId: id,
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 120_000);
});

