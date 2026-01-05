import { writeFile, mkdir, stat, rename, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { CONFIG } from './config.js';

const LOG_DIR_SAFE = (CONFIG as any)?.logDir || resolve('backend', 'logs');

// Cache for token symbol lookups
let jupTokenCache: Map<string, string> | null = null;

async function loadJupTokenSymbols(): Promise<Map<string, string>> {
  if (jupTokenCache) return jupTokenCache;
  
  jupTokenCache = new Map();
  try {
    const jupPath = (CONFIG as any)?.jupTokensPath || resolve('backend', 'config', 'jupTokens.json');
    const content = await readFile(jupPath, 'utf-8');
    const tokens = JSON.parse(content) as Array<{ address: string; symbol: string }>;
    for (const t of tokens) {
      if (t.address && t.symbol) {
        jupTokenCache.set(t.address, t.symbol);
      }
    }
  } catch {
    // Fallback to common tokens if file load fails
    jupTokenCache.set('So11111111111111111111111111111111111111112', 'SOL');
    jupTokenCache.set('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC');
    jupTokenCache.set('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT');
    jupTokenCache.set('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'JitoSOL');
    jupTokenCache.set('jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', 'JupSOL');
  }
  return jupTokenCache;
}

function getMintSymbol(mint: string, symbolMap: Map<string, string>): string {
  const symbol = symbolMap.get(mint);
  if (symbol) return symbol;
  // Fallback: truncate mint for unknown tokens
  return mint.slice(0, 6);
}

const FILES = {
  simulate: resolve(LOG_DIR_SAFE, 'tx-sims.jsonl'),
  preflight: resolve(LOG_DIR_SAFE, 'tx-preflights.jsonl'),
  send: resolve(LOG_DIR_SAFE, 'tx-sends.jsonl'),
} as const;

async function appendJsonl(path: string, entry: Record<string, any>): Promise<void> {
  // lightweight rotation by size
  try {
    const maxBytes = Number(process.env.TX_TRACE_MAX_BYTES || 50_000_000);
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      try {
        const s = await stat(path);
        if (s?.size && s.size > maxBytes) {
          const rotated = `${path}.${Date.now()}.bak`;
          await rename(path, rotated).catch(() => {});
        }
      } catch {}
    }
  } catch {}
  const line = JSON.stringify(entry, (key, value) => {
    // Handle BigInt serialization
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }) + '\n';
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, line, { encoding: 'utf8', flag: 'a' });
}

export type TraceKind = keyof typeof FILES;

export async function logTxTrace(kind: TraceKind, entry: Record<string, any>): Promise<void> {
  const file = FILES[kind];
  await appendJsonl(file, entry);
}

// Consolidated transaction dump (single file per attempt, not split by DEX)
// Now includes complete trace from opportunity detection through transaction send
export async function writeTxFullDump(
  phase: 'preflight' | 'execute', 
  payload: Record<string, any>
): Promise<void> {
  const dir = resolve(LOG_DIR_SAFE, `${phase}-attempts`);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  
  // Extract traceId - this is the unified ID that correlates all logs
  const traceId = payload.traceId || payload.id || payload.txId || payload.txLogs?.[0]?.txId || 'unknown';
  const id = payload.id || payload.txId || traceId;
  const signature = payload.signature || payload.send?.signature || null;
  const hasError = !!(payload.err || payload.sim?.value?.err || payload.send?.err || payload.sim?.err);
  const status = hasError ? 'failed' : 'success';
  
  // Extract all DEXes involved in this transaction
  const dexes = payload.dexes || 
    (payload.plan?.hops ? Array.from(new Set(payload.plan.hops.map((h: any) => h.dex).filter(Boolean))) : []) ||
    (payload.hops ? Array.from(new Set(payload.hops.map((h: any) => h.dex).filter(Boolean))) : []) ||
    [];
  
  // Extract token path for readable filename
  // Priority: opportunity.path > plan.path > hops mints > payload.path
  const tokenPath: string[] = payload.opportunity?.path 
    || payload.plan?.path 
    || payload.path 
    || [];
  
  // Build token symbols string for filename (e.g., "SOL-USDC-JitoSOL")
  let tokenPathStr = '';
  if (tokenPath.length > 0) {
    try {
      const symbolMap = await loadJupTokenSymbols();
      const symbols = tokenPath.map(mint => getMintSymbol(mint, symbolMap));
      // Limit to 5 tokens to avoid overly long filenames
      const displaySymbols = symbols.slice(0, 5);
      if (symbols.length > 5) displaySymbols.push('...');
      tokenPathStr = displaySymbols.join('-');
      // Sanitize: remove any characters that might be problematic in filenames
      tokenPathStr = tokenPathStr.replace(/[^a-zA-Z0-9\-_.]/g, '');
    } catch {
      // Fallback if symbol lookup fails
      tokenPathStr = `${tokenPath.length}hops`;
    }
  }
  
  // Create unique filename: timestamp-tokenPath-traceId-status.json
  // Format: 1704412800000-SOL-USDC-JitoSOL-abc123def-success.json
  const timestamp = Date.now();
  const idPart = String(traceId).slice(0, 12); // Truncate long IDs
  const pathPart = tokenPathStr ? `-${tokenPathStr}` : '';
  const filename = `${timestamp}${pathPart}-${idPart}-${status}.json`;
  const file = resolve(dir, filename);
  
  // Enrich payload with metadata and ensure all opportunity data is included
  const enrichedPayload = {
    // Core transaction data
    ...payload,
    
    // Metadata - traceId is the unified ID for correlating all logs
    _metadata: {
      timestamp,
      phase,
      status,
      traceId, // Unified trace ID for correlating all logs across the execution lifecycle
      id,
      signature: signature || null,
      hasError,
      dexes, // All DEXes involved in this transaction
    },
    
    // Opportunity data (if available from executor or routes)
    opportunity: payload.opportunity || {
      // Extract from payload if opportunity object wasn't passed directly
      path: payload.path || payload.plan?.path,
      dexes: dexes.length > 0 ? dexes : (payload.dexes || payload.plan?.hops?.map((h: any) => h.dex)),
      hop_dexes: payload.hop_dexes || payload.plan?.hops?.map((h: any) => h.dex),
      hop_pool_ids: payload.hop_pool_ids || payload.plan?.hops?.map((h: any) => h.poolId),
      profit_bps: payload.profit_bps,
      net_bps: payload.net_bps,
      est_profit_usd: payload.est_profit_usd,
      hop_rates: payload.hop_rates,
      hop_outs: payload.hop_outs,
      hop_fee_bps: payload.hop_fee_bps,
      hop_liquidity_display: payload.hop_liquidity_display,
      hop_count: payload.hop_count || payload.plan?.hops?.length,
      rate_product: payload.rate_product,
      link_edges_used: payload.link_edges_used,
      link_penalty_bps_total: payload.link_penalty_bps_total,
      min_edge_liquidity: payload.min_edge_liquidity,
      est_capacity: payload.est_capacity,
      bottleneck: payload.bottleneck,
      detected_ms: payload.detected_ms,
      first_seen_ms: payload.first_seen_ms,
      last_verified_ms: payload.last_verified_ms,
      detections: payload.detections,
    },
    
    // Execution plan details (hops with full details)
    plan: payload.plan || {
      path: payload.path,
      hops: payload.hops || payload.plan?.hops,
    },
    
    // Expected outputs for sanity checking (from arb-rs calculations)
    expectedOutputs: payload.expectedOutputs || null,
    
    // Executor logs (session logs related to this transaction)
    executorLogs: payload.executorLogs || payload.txLogs || [],
    
    // Execution configuration
    execConfig: payload.exec || payload.execConfig || payload.execCfg,
    
    // Built transaction details
    built: payload.built || {
      ixCount: payload.ixCount,
      sizeBytes: payload.txSizeBytes || payload.sizeBytes,
      lookupTableAddresses: payload.lookupTableAddresses,
    },
    
    // Simulation/send results
    simulation: payload.sim || payload.simulation || null,
    sendResult: payload.send || payload.sendResult || null,
  };
  
  const data = JSON.stringify(enrichedPayload, (key, value) => {
    // Handle BigInt serialization
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, 2);
  await writeFile(file, data, { encoding: 'utf8' });
}


