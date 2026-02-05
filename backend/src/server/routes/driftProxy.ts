import { Router, type Request, type Response } from 'express';
import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

/**
 * Proxy for /drift/* routes when bots are isolated to child process.
 * Forwards all drift API requests to the bot server so that DriftService
 * initialization and heavy infrastructure only happens in the child process.
 */

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
  // Longer timeout for drift routes that may do heavy initialization
  const t = setTimeout(() => ac.abort('timeout'), 30000);
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
    logger.warn('drift.proxy_failed', { url, error: String(e?.message || e), cat: 'drift' });
    res.status(502).json({ error: 'drift-bots unavailable' });
  }
}

export function createDriftProxyRouter(): Router {
  const api = Router();
  // Proxy all /drift/* routes to the bot server
  api.use('/drift', (req, res) => { proxy(req, res).catch(() => {}); });
  return api;
}
