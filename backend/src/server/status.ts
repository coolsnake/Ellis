export type SystemStatus = {
  startTimeMs: number;
  lastPriceUpdateMs: number | null;
  rateLimitActive?: boolean;
  cooldownUntilMs?: number | null;
  last429AtMs?: number | null;
  botName?: string;
  bot?: 'started' | 'stopped';
  requestsInWindow?: number;
  windowResetAtMs?: number | null;
  apiPaused?: boolean;
  targetTickTimeMs?: number;
};

export const systemStatus: SystemStatus = {
  startTimeMs: Date.now(),
  lastPriceUpdateMs: null,
  rateLimitActive: false,
  cooldownUntilMs: null,
  last429AtMs: null,
  botName: 'TLEbot1',
  bot: 'stopped',
  requestsInWindow: 0,
  windowResetAtMs: null,
  apiPaused: false,
  targetTickTimeMs: 2000,
};


