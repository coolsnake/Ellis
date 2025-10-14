import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { readJson, writeJson } from '../../utils/fs.js';
import { CONFIG } from '../../utils/config.js';

export function createWatchlistRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/watchlist', async (_req, res) => {
    const watchlist = await readJson<any[]>(CONFIG.watchlistPath, []);
    res.json({ watchlist });
  });

  api.post('/watchlist', async (req, res) => {
    try {
      const { idOrSymbol } = req.body as { idOrSymbol: string };
      const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
      if (!wl.find((x) => (typeof x === 'string' ? x : x?.id) === idOrSymbol)) {
        wl.push(idOrSymbol);
        await writeJson(CONFIG.watchlistPath, wl);
      }
      res.json({ watchlist: wl });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.delete('/watchlist', async (req, res) => {
    const { idOrSymbol } = req.body as { idOrSymbol: string };
    const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
    const next = wl.filter((x) => (typeof x === 'string' ? x : x?.id) !== idOrSymbol);
    await writeJson(CONFIG.watchlistPath, next);
    res.json({ watchlist: next });
  });

  // Manual: fetch Jupiter verified tokens and seed priceStore
  api.post('/watchlist/fetch-verified', async (_req, res) => {
    try {
      const tokMod: any = await import('../../utils/tokens.js');
      const { bootstrapPricesForMints } = await import('../priceBootstrap.js');
      const priceMod: any = await import('../priceStore.js');
      const arr = await tokMod.fetchAndCacheJupiterTokens().catch(() => [] as any[]);
      const missing: string[] = [];
      for (const t of arr) {
        const addr = String((t as any)?.address || '');
        const p = (t as any)?.usdPrice;
        if (addr && !(typeof p === 'number')) missing.push(addr);
      }
      if (missing.length) {
        await bootstrapPricesForMints(missing, { chunkSize: 100, maxRequests: Number.MAX_SAFE_INTEGER, cat: 'jup.verified.manual' });
      }
      // Seed map
      const pricesAll = priceMod.getAllPrices?.() || {};
      const SOL = 'So11111111111111111111111111111111111111112';
      const solUsd = Number(pricesAll[SOL]?.usdc ?? NaN);
      const map: Record<string, { usdc: number | null; sol: number | null }> = {};
      for (const t of arr) {
        const addr = String((t as any)?.address || '');
        if (!addr) continue;
        const fromVerified = typeof (t as any)?.usdPrice === 'number' ? (t as any).usdPrice : undefined;
        const fromStore = pricesAll[addr]?.usdc;
        const usdc = (typeof fromStore === 'number') ? fromStore : (typeof fromVerified === 'number' ? fromVerified : null);
        map[addr] = { usdc, sol: (typeof solUsd === 'number' && typeof usdc === 'number') ? (usdc / solUsd) : null };
      }
      priceMod.setPrices?.(map);
      res.json({ ok: true, tokens: arr.length, seeded: Object.values(map).filter(v => typeof v.usdc === 'number').length });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Manual: bootstrap pools' price coverage for current universe
  api.post('/watchlist/bootstrap-pools', async (_req, res) => {
    try {
      const { bootstrapPricesForUniverse } = await import('../priceBootstrap.js');
      const cov = await bootstrapPricesForUniverse({ chunkSize: 100, maxRequests: Number.MAX_SAFE_INTEGER, cat: 'pools.bootstrap.manual' });
      res.json({ ok: true, coverage: cov });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


