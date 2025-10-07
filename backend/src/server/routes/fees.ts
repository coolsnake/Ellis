import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';

export function createFeesRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/fees/config', async (_req, res) => {
    try {
      res.json({ fees: CONFIG.fees });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/fees/config', async (req, res) => {
    try {
      const { fees } = req.body as { fees: any };
      CONFIG.fees = { ...CONFIG.fees, ...(fees || {}) } as any;
      res.json({ ok: true, fees: CONFIG.fees });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/fees/calculate', async (req, res) => {
    try {
      const { transactionType } = req.query as { transactionType?: 'swap' | 'send' | 'strategy' };
      const base = Number(CONFIG.fees?.jupiterSlippageBps || 0);
      const priority = Number(CONFIG.fees?.jupiterPriorityFee || 0);
      const extra = transactionType === 'strategy' ? 5 : transactionType === 'send' ? 2 : 0;
      res.json({ totalFeeBps: base + extra, priorityFeeLamports: priority });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


