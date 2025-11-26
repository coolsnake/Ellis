import { writeFile, mkdir, stat, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { CONFIG } from './config.js';

const LOG_DIR_SAFE = (CONFIG as any)?.logDir || resolve('backend', 'logs');

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
  
  // Create unique filename: timestamp-traceId-signature-status.json
  const timestamp = Date.now();
  const idPart = String(traceId).slice(0, 16); // Truncate long IDs
  const sigPart = signature ? `-${String(signature).slice(0, 8)}` : '';
  const filename = `${timestamp}-${idPart}${sigPart}-${status}.json`;
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


