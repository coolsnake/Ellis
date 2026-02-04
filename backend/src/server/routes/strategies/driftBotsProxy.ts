import { Router, type Request, type Response } from 'express';
import { CONFIG } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

function driftBotsBaseUrl(): string {
  const cfg: any = (CONFIG as any)?.driftBots || {};
  if (cfg.baseUrl) return String(cfg.baseUrl);
  const port = Math.max(1, Number(process.env.DRIFT_BOTS_PORT || cfg.port || 3015));
  return `http://127.0.0.1:${port}`;
}

function getSecretHeader(): Record<string, string> {
  const cfg: any = (CONFIG as any)?.driftBots || {};
  const secret = String(process.env.DRIFT_BOTS_SECRET || cfg.secret || '');
  return secret ? { 'x-drift-bots-secret': secret } : {};
}

async function proxy(req: Request, res: Response): Promise<void> {
  const base = driftBotsBaseUrl();
  const url = `${base}${req.originalUrl}`;
  const method = String(req.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...getSecretHeader(),
  };
  const body = (method === 'GET' || method === 'HEAD') ? undefined : JSON.stringify(req.body || {});
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('timeout'), 5000);
  try {
    const r = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = await r.text();
    const ct = String(r.headers.get('content-type') || '');
    clearTimeout(t);
    if (ct.includes('application/json')) {
      try { res.status(r.status).json(JSON.parse(text || '{}')); return; } catch {}
    }
    res.status(r.status).send(text);
  } catch (e: any) {
    clearTimeout(t);
    logger.warn('drift.bots.proxy_failed', { url, error: String(e?.message || e), cat: 'drift' });
    res.status(502).json({ error: 'drift-bots unavailable' });
  }
}

export function createDriftBotsProxyRouter(): Router {
  const api = Router();
  api.use('/strategies/trigger', (req, res) => { proxy(req, res).catch(() => {}); });
  api.use('/strategies/filler', (req, res) => { proxy(req, res).catch(() => {}); });
  api.use('/strategies/liquidator', (req, res) => { proxy(req, res).catch(() => {}); });
  return api;
}
