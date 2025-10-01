import type { Server as SocketIOServer } from 'socket.io';
import { readJson, writeJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';

export type WalletHistoryItem =
  | { type: 'swap'; time: string; fromToken: string; fromAmount: number; toToken: string; toAmount?: number; signature?: string }
  | { type: 'send'; time: string; token: string; amount: number; destination: string; signature?: string }
  | { type: 'receive'; time: string; token: string; amount: number; sender?: string };

let history: WalletHistoryItem[] = [];
let ioRef: SocketIOServer | null = null;
const HISTORY_PATH = (CONFIG as any).walletHistoryPath;

export function setWalletHistorySocket(io: SocketIOServer): void {
  ioRef = io;
}

export function addWalletHistory(item: WalletHistoryItem): void {
  history.push(item);
  if (history.length > 200) history.shift();
  // persist
  writeJson(HISTORY_PATH, history).catch(() => {});
  ioRef?.emit('wallet-history', history.slice(-10).reverse());
}

export function getWalletHistory(): WalletHistoryItem[] {
  return history.slice(-10).reverse();
}

export async function initWalletHistory(): Promise<void> {
  try {
    const stored = await readJson<WalletHistoryItem[]>(HISTORY_PATH, []);
    if (Array.isArray(stored)) history = stored.slice(-200);
  } catch {
    // ignore
  }
}


