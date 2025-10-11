// Simple scheduler for priority (critical) vs frame-coalesced work
// - Critical: run immediately or in a microtask to avoid deep reentrancy
// - Frame: batch multiple callbacks and flush once per animation frame

type VoidFn = () => void;

const getFlag = (key: string, def = true): boolean => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (raw === null) return def;
    return String(raw).toLowerCase() === 'true';
  } catch {
    return def;
  }
};

const PERF_FLAG_KEY = 'perf.priorityLane';

let frameScheduled = false;
const frameQueue: VoidFn[] = [];

const raf: typeof requestAnimationFrame =
  typeof window !== 'undefined' && window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 16) as unknown as number;

const qMicro: (cb: () => void) => void =
  typeof queueMicrotask === 'function' ? queueMicrotask : (cb) => Promise.resolve().then(cb).catch(() => {});

export function enqueueCritical(fn: VoidFn): void {
  try {
    if (!getFlag(PERF_FLAG_KEY, true)) {
      fn();
      return;
    }
    // Run in a microtask to minimize reentrancy but stay ahead of next frame
    qMicro(() => {
      try { fn(); } catch {}
    });
  } catch {
    try { fn(); } catch {}
  }
}

export function enqueueFrame(fn: VoidFn): void {
  try {
    // If feature disabled, run synchronously
    if (!getFlag(PERF_FLAG_KEY, true)) {
      fn();
      return;
    }
    frameQueue.push(fn);
    if (frameScheduled) return;
    frameScheduled = true;
    raf(() => {
      try {
        frameScheduled = false;
        // Snapshot to guard against reentrancy adding more work
        const batch = frameQueue.splice(0, frameQueue.length);
        for (let i = 0; i < batch.length; i++) {
          try { batch[i](); } catch {}
        }
      } catch {
        frameScheduled = false;
      }
    });
  } catch {
    try { fn(); } catch {}
  }
}

// Utility to throttle a function to at most once per given ms
export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let pending: any[] | null = null;
  const wrapped = ((...args: any[]) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
      return;
    }
    pending = args;
    setTimeout(() => {
      if (pending) {
        last = Date.now();
        const p = pending; pending = null;
        fn(...p);
      }
    }, ms - (now - last));
  }) as T;
  return wrapped;
}


