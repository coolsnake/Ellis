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

  return api;
}


