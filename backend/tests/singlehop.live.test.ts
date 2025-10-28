import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.LOCKSTONE_API_BASE || 'http://127.0.0.1:3001/api';
const RUN = process.env.RUN_LIVE_SINGLEHOP === 'true';
const DO_EXECUTE = process.env.RUN_LIVE_SINGLEHOP_EXECUTE === 'true';

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

function pickPoolIdRaydium(arr: any[]): string | null {
  // prefer USDC/USDT by tvl
  const list = (arr || []).filter((p: any) => (p?.mint_a === USDC && p?.mint_b === USDT) || (p?.mint_a === USDT && p?.mint_b === USDC));
  if (list.length === 0) return null;
  const sorted = [...list].sort((a: any, b: any) => (Number(b?.tvl_usd || 0) - Number(a?.tvl_usd || 0)));
  return sorted[0]?.id || null;
}

function pickPoolIdOrca(arr: any[]): string | null {
  const list = (arr || []).filter((p: any) => (p?.mint_a === USDC && p?.mint_b === USDT) || (p?.mint_a === USDT && p?.mint_b === USDC));
  if (list.length === 0) return null;
  const sorted = [...list].sort((a: any, b: any) => (Number(b?.tvl_usd || 0) - Number(a?.tvl_usd || 0)));
  return sorted[0]?.id || null;
}

describe.skipIf(!RUN)('singlehop.live', () => {
  const sizeUsd = Number(process.env.SIZE_USD || 1);
  const slippageBps = Number(process.env.SLIPPAGE_BPS || 50);

  beforeAll(async () => {
    await postJson(`${BASE}/arb/pools/refresh`, { force: true, subscribe: false });
  });

  it('raydium amm simulate-send USDC->USDT', async () => {
    const pools = await getJson(`${BASE}/arb/pools/raydium?minUsd=100000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdRaydium(pools.json?.amm || []);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/raydium-amm`, {
      path: [USDC, USDT],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
    if (DO_EXECUTE) {
      const ex = await postJson(`${BASE}/arb/execute/raydium-amm`, {
        path: [USDC, USDT],
        poolId: id,
        sizeUsd,
        slippageBps,
        forceDirect: true,
      });
      expect(ex.ok).toBe(true);
      expect(typeof ex.json?.signature === 'string').toBe(true);
    }
  }, 120_000);

  it('raydium clmm simulate-send USDC->USDT', async () => {
    const pools = await getJson(`${BASE}/arb/pools/raydium?minUsd=100000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdRaydium(pools.json?.clmm || []);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/raydium-clmm`, {
      path: [USDC, USDT],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
  }, 120_000);

  it('orca simulate-send USDC->USDT', async () => {
    const pools = await getJson(`${BASE}/arb/pools/orca?minUsd=100000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdOrca(pools.json?.clmm || []);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/orca`, {
      path: [USDC, USDT],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
  }, 120_000);

  it('meteora simulate-send USDC->USDT', async () => {
    const pools = await getJson(`${BASE}/arb/pools/meteora?minUsd=100000`);
    expect(pools.ok).toBe(true);
    const id = pickPoolIdOrca(pools.json?.clmm || []);
    expect(!!id).toBe(true);
    const sim = await postJson(`${BASE}/arb/simulate-send/meteora`, {
      path: [USDC, USDT],
      poolId: id,
      sizeUsd,
      slippageBps,
    });
    expect(sim.ok).toBe(true);
    expect(sim.json?.err).toBeFalsy();
  }, 120_000);
});


