import type { PriceFeed } from './priceFeed.js';

let priceFeedRef: PriceFeed | null = null;

export function setPriceFeedRef(ref: PriceFeed) {
  priceFeedRef = ref;
}

export function enablePriceFeed(enabled: boolean) {
  priceFeedRef?.setEnabled(enabled);
}

export function isPriceFeedEnabled(): boolean {
  try {
    return (priceFeedRef as any)?.getEnabled?.() === true;
  } catch {
    return false;
  }
}

export function setPriceFeedInterval(ms: number) {
  try {
    (priceFeedRef as any)?.setPollInterval?.(ms);
  } catch {}
}

export async function pollPriceFeedNow(): Promise<void> {
  if (priceFeedRef && (priceFeedRef as any).pollNow) {
    try { await (priceFeedRef as any).pollNow(); } catch {}
  }
}


