import { systemStatus } from '../server/status.js';

type QueueItem = { resolve: () => void };

class RateLimiterLite {
  private maxRequests: number;
  private windowMs: number;
  private requests: number = 0;
  private windowResetAt: number = Date.now() + 60000;
  private queueHi: QueueItem[] = [];
  private queueLo: QueueItem[] = [];
  private timer?: NodeJS.Timeout;
  private paused = false;
  private minGapMs = Number(process.env.API_MIN_GAP_MS_BASE || 700);
  private lastDispatchedAt = 0;
  private dispatchTimestamps: number[] = [];
  private recentStatuses: number[] = [];
  private recentLatencies: number[] = [];

  constructor(maxPerWindow = 60, windowMs = 60000) {
    this.maxRequests = maxPerWindow;
    this.windowMs = windowMs;
    this.resetIfNeeded();
  }

  private resetIfNeeded() {
    const now = Date.now();
    if (now >= this.windowResetAt) {
      this.requests = 0;
      this.windowResetAt = now + this.windowMs;
    }
    systemStatus.requestsInWindow = this.requests;
    systemStatus.windowResetAtMs = this.windowResetAt;
  }

  private schedule() {
    if (this.timer) return;
    const delay = Math.max(0, this.windowResetAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.resetIfNeeded();
      this.drain();
    }, delay);
  }

  private drain() {
    while ((this.queueHi.length > 0 || this.queueLo.length > 0) && this.requests < this.maxRequests) {
      const now = Date.now();
      // enforce inter-request gap
      const nextAt = Math.max(this.lastDispatchedAt + this.minGapMs, now);
      if (nextAt > now) {
        setTimeout(() => this.drain(), nextAt - now);
        return;
      }
      this.requests += 1;
      this.lastDispatchedAt = now;
      this.dispatchTimestamps.push(now);
      // trim timestamps older than window
      const cutoff = now - this.windowMs;
      this.dispatchTimestamps = this.dispatchTimestamps.filter((t) => t >= cutoff);
      systemStatus.requestsInWindow = this.requests;
      const item = (this.queueHi.length > 0 ? this.queueHi.shift()! : this.queueLo.shift()!);
      item.resolve();
    }
    if (this.queueHi.length > 0 || this.queueLo.length > 0) this.schedule();
  }

  async acquire(priority = false): Promise<void> {
    if (this.paused) {
      throw new Error('API paused');
    }
    this.resetIfNeeded();
    return new Promise<void>((resolve) => {
      if (priority) this.queueHi.push({ resolve }); else this.queueLo.push({ resolve });
      // Centralized drain enforces both window and inter-request minGapMs
      this.drain();
    });
  }

  pause(): void {
    this.paused = true;
    systemStatus.apiPaused = true;
  }

  resume(): void {
    this.paused = false;
    this.drain();
    systemStatus.apiPaused = false;
  }

  reset(): void {
    this.requests = 0;
    this.windowResetAt = Date.now() + this.windowMs;
    systemStatus.requestsInWindow = this.requests;
    systemStatus.windowResetAtMs = this.windowResetAt;
  }
}

export const jupiterLimiter = new RateLimiterLite(60, 60000);

export function apiStop(): void {
  jupiterLimiter.pause();
  systemStatus.rateLimitActive = true;
}

export function apiStart(): void {
  jupiterLimiter.resume();
  systemStatus.rateLimitActive = false;
}

export function apiReset(): void {
  jupiterLimiter.reset();
}

export function isApiPaused(): boolean {
  try {
    return (jupiterLimiter as any).paused === true;
  } catch {
    return false;
  }
}

// Configure limiter pacing based on Target Tick Time (TTT)
export function setTargetTickTimeMs(ms: number): void {
  const value = Math.max(50, Math.floor(Number(ms) || 0));
  const rl: any = jupiterLimiter as any;
  rl.minGapMs = value;
  systemStatus.targetTickTimeMs = Math.max(100, value);
}

// Adaptive feedback API
export function onApiResult(status: number, latencyMs: number): void {
  try {
    const rl: any = jupiterLimiter as any;
    rl.recentStatuses.push(status);
    rl.recentLatencies.push(latencyMs);
    if (rl.recentStatuses.length > 10) rl.recentStatuses.shift();
    if (rl.recentLatencies.length > 10) rl.recentLatencies.shift();
    // Simple adaptation: reduce gap on healthy fast responses, increase on 429/5xx
    const has429 = rl.recentStatuses.includes(429);
    const has5xx = rl.recentStatuses.some((s: number) => s >= 500);
    const avgLatency = rl.recentLatencies.length ? rl.recentLatencies.reduce((a: number, b: number) => a + b, 0) / rl.recentLatencies.length : 0;
    const minBase = Number(process.env.API_MIN_GAP_MS_MIN || 400);
    const maxBase = Number(process.env.API_MIN_GAP_MS_MAX || 1500);
    if (has429 || has5xx) {
      rl.minGapMs = Math.min(maxBase, rl.minGapMs + 150);
      systemStatus.rateLimitActive = has429;
      if (has429) systemStatus.last429AtMs = Date.now();
    } else if (avgLatency > 600) {
      rl.minGapMs = Math.min(maxBase, rl.minGapMs + 100);
    } else if (avgLatency > 0 && avgLatency < 300) {
      rl.minGapMs = Math.max(minBase, rl.minGapMs - 50);
    }
  } catch {
    // ignore
  }
}


