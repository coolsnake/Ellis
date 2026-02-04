import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

function splitLines(buf: any): string[] {
  let s: string;
  try {
    if (typeof buf === 'string') s = buf;
    else if (buf && typeof (buf as any).toString === 'function') s = (buf as any).toString('utf8');
    else s = String(buf);
  } catch {
    s = String(buf);
  }
  return s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

let child: ChildProcessWithoutNullStreams | null = null;
let restarting = false;
let backoffMs = 1000;

export function shutdownDriftBotsProcess(): void {
  try {
    if (child) {
      try { logger.warn('drift.bots.shutdown', { pid: child.pid }); } catch {}
      child.kill('SIGTERM');
      child = null;
    }
  } catch {}
}

export function setupDriftBotsProcess(): void {
  try {
    const cfg: any = (CONFIG as any)?.driftBots || {};
    const enabled = !!cfg.enabled;
    if (!enabled) return;
    if (child) return;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const BACKEND_ROOT = resolve(__dirname, '..', '..');
    const devEntry = resolve(BACKEND_ROOT, 'src/drift/botServer.ts');
    const prodEntry = resolve(BACKEND_ROOT, 'dist/drift/botServer.js');
    const devExists = existsSync(devEntry);
    const prodExists = existsSync(prodEntry);
    const preferDev = !!cfg.useTsx;
    const tsxBinCandidates = [
      resolve(BACKEND_ROOT, 'node_modules/.bin/tsx'),
      resolve(BACKEND_ROOT, 'node_modules/.bin/tsx.cmd'),
    ];
    const tsxBin = tsxBinCandidates.find((p) => existsSync(p)) || '';
    const canUseTsx = preferDev && devExists && !!tsxBin;
    if (preferDev && devExists && !tsxBin) {
      try { logger.warn('drift.bots.tsx_missing', { expected: tsxBinCandidates[0] }); } catch {}
    }
    const absEntry = canUseTsx
      ? devEntry
      : (prodExists ? prodEntry : '');
    if (!absEntry) {
      try {
        logger.warn('drift.bots.entry_missing', { devEntry, prodEntry, preferDev });
        if (!preferDev && devExists) {
          logger.warn('drift.bots.build_required', { reason: 'DRIFT_BOTS_USE_TSX=false', prodEntry });
        }
      } catch {}
      return;
    }
    const useTsx = absEntry === devEntry && canUseTsx;
    const bin = useTsx ? tsxBin : 'node';
    if (absEntry === devEntry && !canUseTsx && prodExists) {
      try { logger.warn('drift.bots.fallback_node', { reason: 'tsx_missing', entry: prodEntry }); } catch {}
    }

    const port = Math.max(1, Number(process.env.DRIFT_BOTS_PORT || cfg.port || 3015));
    const callbackUrl = String(
      process.env.DRIFT_BOTS_CALLBACK_URL
      || cfg.callbackUrl
      || `http://127.0.0.1:${Number(process.env.PORT || CONFIG.port || 3001)}/api/internal/drift-bots/events`
    );

    const env: Record<string, string> = {
      ...process.env,
      DRIFT_BOTS_PROCESS: '1',
      DRIFT_BOTS_PORT: String(port),
      DRIFT_BOTS_CALLBACK_URL: String(callbackUrl),
    };
    if (cfg.secret || process.env.DRIFT_BOTS_SECRET) {
      env.DRIFT_BOTS_SECRET = String(process.env.DRIFT_BOTS_SECRET || cfg.secret || '');
    }
    if (useTsx) {
      env.DRIFT_BOTS_USE_TSX = 'true';
    }

    const start = () => {
      if (child) return;
      try { logger.info('drift.bots.spawn', { bin, entry: absEntry, port }); } catch {}
      child = spawn(bin, [absEntry], { env, stdio: 'pipe' });
      child.stdout.on('data', (buf) => {
        for (const line of splitLines(buf)) {
          try { logger.info(line, { cat: 'drift' }); } catch {}
        }
      });
      child.stderr.on('data', (buf) => {
        for (const line of splitLines(buf)) {
          try { logger.warn(line, { cat: 'drift' }); } catch {}
        }
      });
      child.on('exit', (code, signal) => {
        try { logger.warn('drift.bots.exit', { code, signal }); } catch {}
        child = null;
        if (cfg.respawn) scheduleRestart();
      });
      child.on('error', (err) => {
        try { logger.error('drift.bots.error', { error: String(err?.message || err) }); } catch {}
        child = null;
        if (cfg.respawn) scheduleRestart();
      });
    };

    const scheduleRestart = () => {
      if (restarting) return;
      restarting = true;
      const delay = Math.min(30000, backoffMs);
      setTimeout(() => {
        restarting = false;
        backoffMs = Math.min(30000, backoffMs * 2);
        start();
      }, delay);
    };

    start();
  } catch {}
}
