import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { emit } from './realtime.js';
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

export function shutdownRustProcess(): void {
  try {
    if (child) {
      try { emit('log', { level: 'warn', cat: 'rust', message: 'arb-rs shutting down', timestamp: new Date().toISOString() }); } catch {}
      child.kill('SIGTERM');
      child = null;
    }
  } catch {}
}

export function setupRustLogForwarding(): void {
  try {
    const enabled = String(process.env.ARB_SPAWN || '').trim() === '1';
    if (!enabled) return;
    const bin = String(process.env.ARB_BIN || '').trim();
    if (!bin) { try { logger.warn('arb.spawn missing ARB_BIN'); } catch {} return; }
    const absBin = resolve(bin);
    if (!existsSync(absBin)) { try { logger.warn('arb.spawn ARB_BIN not found', { bin: absBin }); } catch {} return; }
    const args = (String(process.env.ARB_ARGS || '').trim() || '').split(' ').filter(Boolean);
    const cwd = String(process.env.ARB_CWD || '').trim() || undefined;
    const respawn = String(process.env.ARB_RESPAWN || '').trim() === '1';

    const start = () => {
      if (child) return;
      try { logger.info('arb.spawn starting', { bin: absBin, args, cwd }); } catch {}
      child = spawn(absBin, args, { cwd, env: process.env });
      child.stdout.on('data', (buf) => {
        for (const line of splitLines(buf)) {
          emit('log', { level: 'info', cat: 'rust', message: line, timestamp: new Date().toISOString() });
        }
      });
      child.stderr.on('data', (buf) => {
        for (const line of splitLines(buf)) {
          emit('log', { level: 'error', cat: 'rust', message: line, timestamp: new Date().toISOString() });
        }
      });
      child.on('exit', (code, signal) => {
        try { logger.warn('arb.spawn exit', { code, signal }); } catch {}
        child = null;
        emit('log', { level: 'warn', cat: 'rust', message: `arb-rs exited code=${code} signal=${signal}`, timestamp: new Date().toISOString() });
        if (respawn) scheduleRestart();
      });
      child.on('error', (err) => {
        try { logger.error('arb.spawn error', { error: String(err?.message || err) }); } catch {}
        emit('log', { level: 'error', cat: 'rust', message: `arb-rs spawn error: ${String(err?.message || err)}`, timestamp: new Date().toISOString() });
        child = null;
        if (respawn) scheduleRestart();
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


