import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { searchTokens } from '../../jupiter/tokenApi.js';

export function createTokensRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/tokens/map', async (_req, res) => {
    try {
      const tokensMod: any = await import('../../utils/tokens.js');
      const loadTokenMap = (tokensMod as any).loadTokenMap as () => Promise<Record<string, { mint: string; decimals: number }>>;
      const loadJupiterTokenMap = (tokensMod as any).loadJupiterTokenMap as () => Promise<Record<string, { symbol: string; decimals: number }>>;
      const local = await loadTokenMap();
      const jmap = await loadJupiterTokenMap();
      const out: Record<string, string> = {};
      for (const [mint, meta] of Object.entries(jmap || {})) {
        if (!mint) continue;
        const sym = (meta?.symbol || '').toString().trim();
        if (sym) out[mint] = sym.toUpperCase();
      }
      for (const [sym, info] of Object.entries(local || {})) {
        const upperSym = (sym || '').toString().trim().toUpperCase();
        const mint = (info as any)?.mint;
        if (!mint) continue;
        if (!out[mint]) out[mint] = upperSym;
      }
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      out[SOL_MINT] = 'SOL';
      out[USDC_MINT] = 'USDC';
      res.json({ map: out });
    } catch (e: any) {
      res.status(500).json({ map: {} });
    }
  });

  api.get('/tokens/search', async (req, res) => {
    try {
      const { query } = req.query as { query: string };
      const results = await searchTokens(query || '', true);
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ results: [] });
    }
  });

  return api;
}


