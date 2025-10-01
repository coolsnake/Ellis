export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const levelOrder: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 } as const;

function readInitialLevel(): LogLevel {
  const fromEnv = (import.meta as any).env?.VITE_LOG_LEVEL as string | undefined;
  const fromStorage = (typeof window !== 'undefined') ? window.localStorage.getItem('logLevel') as LogLevel | null : null;
  const val = (fromStorage || fromEnv || 'info').toLowerCase();
  if (val === 'error' || val === 'warn' || val === 'info' || val === 'debug') return val;
  return 'info';
}

let currentLevel: LogLevel = readInitialLevel();

export const setLogLevel = (lvl: LogLevel) => {
  currentLevel = lvl;
  try { window.localStorage.setItem('logLevel', lvl); } catch {}
};

export const getLogLevel = (): LogLevel => currentLevel;

export const logger = {
  error(message: string, context?: unknown) {
    if (levelOrder[currentLevel] >= levelOrder.error) console.error(message, context ?? '');
  },
  warn(message: string, context?: unknown) {
    if (levelOrder[currentLevel] >= levelOrder.warn) console.warn(message, context ?? '');
  },
  info(message: string, context?: unknown) {
    if (levelOrder[currentLevel] >= levelOrder.info) console.info(message, context ?? '');
  },
  debug(message: string, context?: unknown) {
    if (levelOrder[currentLevel] >= levelOrder.debug) console.debug(message, context ?? '');
  },
};


