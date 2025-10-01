export type PriceMap = Record<string, { usdc: number | null; sol: number | null }>;

let latestPrices: PriceMap = {};

export function setPrices(map: PriceMap): void {
  latestPrices = { ...latestPrices, ...map };
}

export function getPriceByMint(mint: string): { usdc: number | null; sol: number | null } | undefined {
  return latestPrices[mint];
}

export function getAllPrices(): PriceMap {
  return latestPrices;
}


