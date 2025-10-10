import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { CONFIG } from './config.js';
import { emit } from '../server/realtime.js';

type TradeSummary = {
  time: string;
  strategy: string;
  side: 'long' | 'short';
  pair: string;
  entryPair?: number | null;
  exitPair?: number | null;
  baseAmount?: number | null;
  pnlUSDC?: number | null;
  pairFrom?: string;
  pairTo?: string;
  pairOrientation?: string; // e.g., "from->to"
  solPriceOpenUsd?: number | null;
  solPriceCloseUsd?: number | null;
};

const LOG_DIR_SAFE = (CONFIG as any)?.logDir || resolve('backend', 'logs');
const FILE_PATH = resolve(LOG_DIR_SAFE, 'trade_summaries.jsonl');

export async function writeTradeSummary(s: TradeSummary): Promise<void> {
  const line = JSON.stringify(s) + '\n';
  const dir = dirname(FILE_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(FILE_PATH, line, { encoding: 'utf8', flag: 'a' });
}

// Additional structured logs: quotes, intents, trades (opens/closes/scales)
const QUOTES_PATH = resolve(LOG_DIR_SAFE, 'quotes.jsonl');
const INTENTS_PATH = resolve(LOG_DIR_SAFE, 'intents.jsonl');
const TRADES_PATH = resolve(LOG_DIR_SAFE, 'trades.jsonl');

export async function logQuote(entry: Record<string, any>): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  const dir = dirname(QUOTES_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(QUOTES_PATH, line, { encoding: 'utf8', flag: 'a' });
  try {
    const rate = typeof entry.rate === 'number' ? entry.rate.toFixed(6) : String(entry.rate);
    const routes = entry.routes ?? '';
    emit('log', { level: 'info', message: `pretrade:quote ${entry.side || ''} ${entry.pair || ''} in=${entry.amountIn} out=${entry.amountOut} rate=${rate} routes=${routes}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
  } catch {}
}

export async function logIntent(entry: Record<string, any>): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  const dir = dirname(INTENTS_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(INTENTS_PATH, line, { encoding: 'utf8', flag: 'a' });
  try {
    emit('log', { level: 'info', message: `pretrade:intent ${entry.intent || ''} ${entry.pair || ''} amt=${entry.amountFrom ?? entry.amountIn ?? ''}` , timestamp: new Date().toLocaleTimeString(), context: { cat: 'pretrade' } });
  } catch {}
}

export async function logTrade(entry: Record<string, any>): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  const dir = dirname(TRADES_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(TRADES_PATH, line, { encoding: 'utf8', flag: 'a' });
  try {
    const event = (entry.event || '').toString();
    const sig = entry.sig ? ` sig=${entry.sig}` : '';
    emit('log', { level: 'info', message: `trade:${event} ${entry.pair || ''}${sig}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'trade' } });
  } catch {}
}


