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

function parseChildLog(line: string): { raw: string; isFormatted: boolean; level: string } {
  const match = /^\[(INFO|WARN|ERROR|DEBUG)\]\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)\s+\[[\w.]+\]\s*(.*)$/i.exec(line);
  if (match) {
    return { raw: match[2] || line, isFormatted: true, level: match[1].toLowerCase() };
  }
  return { raw: line, isFormatted: false, level: 'info' };
}

type ServiceState = {
  child: ChildProcessWithoutNullStreams | null;
  restarting: boolean;
  backoffMs: number;
};

const infraState: ServiceState = { child: null, restarting: false, backoffMs: 1000 };
const managerState: ServiceState = { child: null, restarting: false, backoffMs: 1000 };

export function shutdownDriftBotsProcess(): void {
  try {
    if (infraState.child) {
      try { logger.warn('drift.infra.shutdown', { pid: infraState.child.pid }); } catch {}
      infraState.child.kill('SIGTERM');
      infraState.child = null;
    }
  } catch {}
  try {
    if (managerState.child) {
      try { logger.warn('drift.bots.shutdown', { pid: managerState.child.pid }); } catch {}
      managerState.child.kill('SIGTERM');
      managerState.child = null;
    }
  } catch {}
}

function resolveEntry(relDev: string, relProd: string, preferDev: boolean): { entry: string; useTsx: boolean; bin: string } | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const BACKEND_ROOT = resolve(__dirname, '..', '..');
  const devEntry = resolve(BACKEND_ROOT, relDev);
  const prodEntry = resolve(BACKEND_ROOT, relProd);
  const devExists = existsSync(devEntry);
  const prodExists = existsSync(prodEntry);
  const tsxBinCandidates = [
    resolve(BACKEND_ROOT, 'node_modules/.bin/tsx'),
    resolve(BACKEND_ROOT, 'node_modules/.bin/tsx.cmd'),
  ];
  const tsxBin = tsxBinCandidates.find((p) => existsSync(p)) || '';
  const canUseTsx = preferDev && devExists && !!tsxBin;
  if (preferDev && devExists && !tsxBin) {
    try { logger.warn('drift.bots.tsx_missing', { expected: tsxBinCandidates[0] }); } catch {}
  }
  const absEntry = canUseTsx ? devEntry : (prodExists ? prodEntry : '');
  if (!absEntry) return null;
  const useTsx = absEntry === devEntry && canUseTsx;
  const bin = useTsx ? tsxBin : 'node';
  if (absEntry === devEntry && !canUseTsx && prodExists) {
    try { logger.warn('drift.bots.fallback_node', { reason: 'tsx_missing', entry: prodEntry }); } catch {}
  }
  return { entry: absEntry, useTsx, bin };
}

function spawnService(state: ServiceState, opts: {
  name: string;
  entry: string;
  bin: string;
  port: number;
  env: Record<string, string>;
  respawn: boolean;
}): void {
  const start = () => {
    if (state.child) return;
    try { logger.info(`${opts.name}.spawn`, { bin: opts.bin, entry: opts.entry, port: opts.port }); } catch {}
    state.child = spawn(opts.bin, [opts.entry], { env: opts.env, stdio: 'pipe' });
    const child = state.child;
    child.stdout.on('data', (buf) => {
      for (const line of splitLines(buf)) {
        try {
          const parsed = parseChildLog(line);
          const ctx = { cat: opts.name, fromChild: parsed.isFormatted };
          if (parsed.isFormatted) {
            if (parsed.level === 'warn') logger.warn(parsed.raw, ctx);
            else if (parsed.level === 'error') logger.error(parsed.raw, ctx);
            else logger.info(parsed.raw, ctx);
          } else {
            logger.info(line, { cat: opts.name });
          }
        } catch {}
      }
    });
    child.stderr.on('data', (buf) => {
      for (const line of splitLines(buf)) {
        try {
          const parsed = parseChildLog(line);
          logger.warn(parsed.raw, { cat: opts.name, fromChild: parsed.isFormatted });
        } catch {}
      }
    });
    child.on('exit', (code, signal) => {
      try { logger.warn(`${opts.name}.exit`, { code, signal }); } catch {}
      state.child = null;
      if (opts.respawn) scheduleRestart();
    });
    child.on('error', (err) => {
      try { logger.error(`${opts.name}.error`, { error: String(err?.message || err) }); } catch {}
      state.child = null;
      if (opts.respawn) scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (state.restarting) return;
    state.restarting = true;
    const delay = Math.min(30000, state.backoffMs);
    setTimeout(() => {
      state.restarting = false;
      state.backoffMs = Math.min(30000, state.backoffMs * 2);
      start();
    }, delay);
  };

  start();
}

export function setupDriftBotsProcess(): void {
  try {
    const botsCfg: any = (CONFIG as any)?.driftBots || {};
    const infraCfg: any = (CONFIG as any)?.driftInfra || {};
    const botsEnabled = !!botsCfg.enabled;
    const infraEnabled = infraCfg.enabled !== false;
    if (!botsEnabled && !infraEnabled) return;

    if (infraEnabled && !infraState.child) {
      const resolved = resolveEntry('src/drift/infraServer.ts', 'dist/drift/infraServer.js', !!infraCfg.useTsx);
      if (resolved) {
        const port = Math.max(1, Number(process.env.DRIFT_INFRA_PORT || infraCfg.port || 3020));
        const callbackUrl = String(
          process.env.DRIFT_INFRA_CALLBACK_URL
          || infraCfg.callbackUrl
          || process.env.DRIFT_BOTS_CALLBACK_URL
          || `http://127.0.0.1:${Number(process.env.PORT || CONFIG.port || 3001)}/api/internal/drift-bots/events`
        );
        const env: Record<string, string> = {
          ...process.env,
          DRIFT_INFRA_PROCESS: '1',
          DRIFT_INFRA_PORT: String(port),
          DRIFT_INFRA_CALLBACK_URL: String(callbackUrl),
        };
        if (infraCfg.secret || process.env.DRIFT_INFRA_SECRET) {
          env.DRIFT_INFRA_SECRET = String(process.env.DRIFT_INFRA_SECRET || infraCfg.secret || '');
        }
        if (resolved.useTsx) env.DRIFT_INFRA_USE_TSX = 'true';
        spawnService(infraState, {
          name: 'drift.infra',
          entry: resolved.entry,
          bin: resolved.bin,
          port,
          env,
          respawn: infraCfg.respawn !== false,
        });
      }
    }

    if (botsEnabled && !managerState.child) {
      const resolved = resolveEntry('src/drift/botsManagerServer.ts', 'dist/drift/botsManagerServer.js', !!botsCfg.useTsx);
      if (resolved) {
        const port = Math.max(1, Number(process.env.DRIFT_BOTS_PORT || botsCfg.port || 3015));
        const callbackUrl = String(
          process.env.DRIFT_BOTS_CALLBACK_URL
          || botsCfg.callbackUrl
          || `http://127.0.0.1:${Number(process.env.PORT || CONFIG.port || 3001)}/api/internal/drift-bots/events`
        );
        const env: Record<string, string> = {
          ...process.env,
          DRIFT_BOTS_MANAGER: '1',
          DRIFT_BOTS_PORT: String(port),
          DRIFT_BOTS_CALLBACK_URL: String(callbackUrl),
          DRIFT_INFRA_URL: process.env.DRIFT_INFRA_URL || (infraCfg.baseUrl ? String(infraCfg.baseUrl) : `http://127.0.0.1:${Math.max(1, Number(process.env.DRIFT_INFRA_PORT || infraCfg.port || 3020))}`),
          DRIFT_WARMUP_ENABLED: 'false',
          DRIFT_PREFETCH_ENABLED: 'false',
        };
        if (botsCfg.secret || process.env.DRIFT_BOTS_SECRET) {
          env.DRIFT_BOTS_SECRET = String(process.env.DRIFT_BOTS_SECRET || botsCfg.secret || '');
        }
        if (infraCfg.secret || process.env.DRIFT_INFRA_SECRET) {
          env.DRIFT_INFRA_SECRET = String(process.env.DRIFT_INFRA_SECRET || infraCfg.secret || '');
        }
        if (resolved.useTsx) env.DRIFT_BOTS_USE_TSX = 'true';
        spawnService(managerState, {
          name: 'drift.bots.manager',
          entry: resolved.entry,
          bin: resolved.bin,
          port,
          env,
          respawn: botsCfg.respawn !== false,
        });
      }
    }
  } catch {}
}
