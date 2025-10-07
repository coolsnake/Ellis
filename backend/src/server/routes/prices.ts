import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { getPriceByMint } from '../priceStore.js';

export function createPricesRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/prices', async (_req, res) => {
    try {
      const SOL = 'So11111111111111111111111111111111111111112';
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const sol = await getPriceByMint(SOL);
      const usdc = await getPriceByMint(USDC);
      res.json({ SOL: sol, USDC: usdc });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


