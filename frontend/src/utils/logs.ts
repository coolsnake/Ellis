// Shared log types, window configuration, and helpers for routing

export type LogEvent = {
  level: string;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  cat?: string;
  subcat?: string;
  code?: string;
  cid?: string;
  span?: 'start' | 'end';
  muted?: boolean;
};

export type WindowId =
  | 'user'
  | 'trade'
  | 'arbitrage'
  | 'graph'
  | 'pools'
  | 'rust'
  | 'drift'
  | 'strategy'
  | 'api'
  | 'system';

export type LogWindowConfig = {
  id: WindowId;
  title: string;
  cats: string[];
  storageKey: string;
};

export const LOG_WINDOWS: LogWindowConfig[] = [
  { id: 'user', title: 'User', cats: ['wallet', 'auth', 'terminal'], storageKey: 'logwin:user:collapsed' },
  { id: 'trade', title: 'Trade', cats: ['pretrade', 'trade', 'jupiter', 'price'], storageKey: 'logwin:trade:collapsed' },
  { id: 'arbitrage', title: 'Arbitrage', cats: ['arb', 'tx', 'opportunity'], storageKey: 'logwin:arbitrage:collapsed' },
  { id: 'graph', title: 'Graph', cats: ['graph'], storageKey: 'logwin:graph:collapsed' },
  { id: 'pools', title: 'Pools', cats: ['raydium', 'orca', 'meteora', 'pools'], storageKey: 'logwin:pools:collapsed' },
  { id: 'rust', title: 'Rust', cats: ['rust'], storageKey: 'logwin:rust:collapsed' },
  { id: 'drift', title: 'Drift', cats: ['drift'], storageKey: 'logwin:drift:collapsed' },
  { id: 'strategy', title: 'Strategy', cats: ['strategy'], storageKey: 'logwin:strategy:collapsed' },
  { id: 'api', title: 'API', cats: ['api'], storageKey: 'logwin:api:collapsed' },
  { id: 'system', title: 'System', cats: ['server', 'system', 'other'], storageKey: 'logwin:system:collapsed' },
];

export const WINDOW_ORDER: WindowId[] = [
  'user',
  'trade',
  'arbitrage',
  'graph',
  'pools',
  'rust',
  'drift',
  'strategy',
  'api',
  'system',
];

export const catToWindowId = new Map<string, WindowId>(
  LOG_WINDOWS.flatMap(w => w.cats.map(c => [c, w.id] as const))
);

export function getStorageKey(id: WindowId, key: 'paused' | 'autoscroll' | 'collapsed'): string {
  return `logwin:${id}:${key}`;
}


