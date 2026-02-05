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

// Detect if line is already a formatted log entry (e.g., "[INFO] 10:02:20 AM [drift.trigger] ...")
// and extract the raw message to avoid double-wrapping
function parseChildLog(line: string): { raw: string; isFormatted: boolean; level: string } {
  // Match pattern: [LEVEL] HH:MM:SS AM/PM [category] message
  const match = /^\[(INFO|WARN|ERROR|DEBUG)\]\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)\s+\[[\w.]+\]\s*(.*)$/i.exec(line);
  if (match) {
    return { raw: match[2] || line, isFormatted: true, level: match[1].toLowerCase() };
  }
  return { raw: line, isFormatted: false, level: 'info' };
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
      // Disable warmup in child process - main backend already warms up
      // This prevents duplicate GPA queries and reduces RPC load
      DRIFT_WARMUP_ENABLED: 'false',
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
          try {
            const parsed = parseChildLog(line);
            if (parsed.isFormatted) {
              // Already formatted - log at appropriate level without re-wrapping
              // Use special 'drift.bot' category to distinguish from main process
              if (parsed.level === 'warn') {
                logger.warn(parsed.raw, { cat: 'drift.bot', fromChild: true });
              } else if (parsed.level === 'error') {
                logger.error(parsed.raw, { cat: 'drift.bot', fromChild: true });
              } else {
                logger.info(parsed.raw, { cat: 'drift.bot', fromChild: true });
              }
            } else {
              // Unformatted line - log as-is
              logger.info(line, { cat: 'drift.bot' });
            }
          } catch {}
        }
      });
      child.stderr.on('data', (buf) => {
        for (const line of splitLines(buf)) {
          try {
            const parsed = parseChildLog(line);
            // stderr is typically warnings/errors
            logger.warn(parsed.raw, { cat: 'drift.bot', fromChild: parsed.isFormatted });
          } catch {}
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
